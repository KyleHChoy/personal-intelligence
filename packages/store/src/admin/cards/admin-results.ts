import type { Timestamp } from "@intelligence/contracts";
import type {
  CardLine,
  ClientName,
  JudgeResultBody,
  MoveId,
  OpportunityId,
  OpportunityKind,
  OwnerPageArgs,
  OwnerResult,
  OwnerResults,
  RulingId,
  ShelfLine,
} from "@intelligence/contracts/personal";
import { MoveStatus, resultHeadline, resultOutcome, SHELF_MOST, ULID_PATTERN } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { latestRow, moveStatus } from "../../core/statements.ts";
import { reportOf } from "../../work/dispatch-cards.ts";
import { FINISHED_TASK_REPORT, OPPORTUNITY_VETO } from "../../work/dispatch-read.ts";
import { repeatedDecision } from "../admin-base.ts";
import { cursorOf, ownerPage, ownerWho, ownerWithheld } from "../admin-owner.ts";
import { writeView } from "./admin-learning.ts";
import { PLACE_TIME } from "./admin-queue.ts";
import { resultLines } from "./card-kinds-outcome.ts";

// A finished task's report raises no card; it is here, newest first, presented as its outcome card
// was (card-kinds-outcome.ts), its sources named through the owner's reads. Each is a task's last
// report (dispatch-read.ts FINISHED_TASK_REPORT) on an opportunity, a move and a report none of
// which a deletion tainted, on work no veto of the owner's covers, and none of whose cited agent
// records was removed (`erasedOf`). The owner's Keep or Not useful is one `result_eval` decision on
// the move, under the label its outcome card took (dispatch-cards.ts reportOf), superseding their
// last; it changes no status of the task and releases nothing.

// The place: the report's time to the microsecond, in the form the read issues it, and the move.
const MOVE = new RegExp(`^mov_${ULID_PATTERN}$`);

// A result the feed shows, on a move aliased `m` of an opportunity aliased `o`, with the move's
// latest report aliased `r`: a finished task's last report, none of the three tainted, and no veto of
// the owner's covering the work (OPPORTUNITY_VETO; invariant 11), as no outcome card was raised on
// vetoed work. Work an agent approved with a bet is read-only as a task is, and its result is here as
// a task's is, with no card: the owner's Keep is what settles the bet.
const LATEST_REPORT = `join lateral (${latestRow("e.at, e.tainted_at", "move", "m.id", { alias: "e", and: "e.event = 'reported' and e.code is distinct from 'progress'" })}) r on true`;
// The move's status, for how it ended: done or failed, as SHOWN keeps.
const MOVE_STATUS = `(${moveStatus("m.id", "ms")}) as move_status`;
// How a result ended and its one line, from its lines and its move's status (owner-results.ts): served
// only beside lines the read already serves, so under the same label.
const ended = (status: string | null, lines: readonly CardLine[]): Pick<OwnerResult, "outcome" | "headline"> => {
  const headline = resultHeadline(lines);
  const parsed = MoveStatus.safeParse(status);
  return {
    outcome: resultOutcome(parsed.success ? parsed.data : null, lines),
    headline: headline === null ? null : { untrusted: headline },
  };
};
const SHOWN = `(o.tier = 'task' or o.bet_at is not null) and o.tainted_at is null and m.tainted_at is null and r.tainted_at is null and ${FINISHED_TASK_REPORT} and ${OPPORTUNITY_VETO} is null`;

// The sources a report cites live in its sealed body, not in the move's basis, so removing a cited
// agent record leaves the move untainted. A result whose report cites a removed agent record is not
// shown (invariant 10): its lines name each such source by a `source` line whose part is the record's id
// (card-kinds-outcome.ts), and `report_move` checked each such id existed. A message or meeting a
// report cites is not checked so (an id no read resolves is no proof of an erasure): one gone is
// said as not named. One statement for every result asked about.
async function erasedOf(query: Query, lines: ReadonlyMap<string, readonly CardLine[]>): Promise<Set<string>> {
  const cites = [...lines].flatMap(([move, shown]) =>
    shown.flatMap((line) => {
      const [cited] = line.from === "code" && line.key === "source" ? (line.value ?? []) : [];
      return cited?.kind === "id" && cited.of === "agent_record" ? [{ move, id: cited.id }] : [];
    }),
  );
  if (cites.length === 0) return new Set();
  const kept = new Set(
    (
      await query<{ id: string }>(
        "select id from ledger.agent_writes where id = any ($1::text[]) and tainted_at is null",
        [[...new Set(cites.map((one) => one.id))]],
      )
    ).map((one) => one.id),
  );
  return new Set(cites.filter((one) => !kept.has(one.id)).map((one) => one.move));
}

// One transaction: the page, each result's judgment in one statement, each result's lines (its
// outcome card's reads), then the removed records they cite in one statement.
// How many a week the owner is asked to judge, and how far back they are drawn from: a small sample that
// validates `used`, never a queue. Drawn by a hash of the week and the move, so it stands all week
// and favours nothing, and each one judged this week takes a place.
const WEEKLY_SAMPLE = 3;
const WEEK_START = "(date_trunc('week', $1::timestamptz at time zone 'UTC') at time zone 'UTC')";
const IN_FORCE = `(select d.answer from knowledge.owner_decisions d where d.kind = 'result_eval' and d.target_kind = 'move' and d.target_id = m.id and d.tainted_at is null
    order by d.decided_at desc, d.id collate "C" desc limit 1)`;
// Reported in the two weeks before this one, so no new report displaces one already drawn.
const THIS_WEEK = `
  select m.id as move, r.at, ${MOVE_STATUS} from ledger.moves m
  join ledger.opportunities o on o.id = m.opportunity_id
  ${LATEST_REPORT}
  where ${SHOWN} and r.at >= ${WEEK_START} - interval '14 days' and r.at < ${WEEK_START}
    and coalesce(${IN_FORCE}, 'none') = 'none'
  order by md5(to_char(date_trunc('week', $1::timestamptz at time zone 'UTC'), 'YYYY-MM-DD') || m.id), m.id
  limit $2`;
// Judged this week and still in force: an Undo gives the place back.
const JUDGED_THIS_WEEK = `
  select count(*)::int as n from ledger.moves m
  where m.id in (select d.target_id from knowledge.owner_decisions d
                 where d.kind = 'result_eval' and d.target_kind = 'move' and d.tainted_at is null and d.decided_at >= ${WEEK_START})
    and coalesce(${IN_FORCE}, 'none') <> 'none'`;

async function thisWeek(query: Query, admin: AdminContext): Promise<OwnerResults["results"]> {
  const now = stamp(admin.now());
  const [judged] = await query<{ n: number }>(JUDGED_THIS_WEEK, [now]);
  const room = WEEKLY_SAMPLE - (judged?.n ?? 0);
  if (room <= 0) return [];
  const rows = await query<{ move: MoveId; at: Date; move_status: string | null }>(THIS_WEEK, [now, room * 2]);
  const lines = new Map<string, CardLine[]>();
  for (const row of rows) lines.set(row.move, await resultLines({ query, keys: admin.keys }, row.move));
  const erased = await erasedOf(query, lines);
  return rows
    .filter((row) => !erased.has(row.move))
    .slice(0, room)
    .map((row) => ({
      move: row.move,
      reportedAt: stamp(row.at) as OwnerResults["results"][number]["reportedAt"],
      lines: lines.get(row.move) ?? [],
      judged: null,
      ...ended(row.move_status, lines.get(row.move) ?? []),
    }));
}

export async function results(admin: AdminContext, args: OwnerPageArgs = {}): Promise<OwnerResults> {
  const page = ownerPage(
    args,
    (place) =>
      place.length === 2 &&
      typeof place[0] === "string" &&
      PLACE_TIME.test(place[0]) &&
      !Number.isNaN(Date.parse(place[0])) &&
      typeof place[1] === "string" &&
      MOVE.test(place[1]),
  );
  return admin.transaction(async (query) => {
    const rows = await query<{ move: MoveId; at: Date; place_at: string; move_status: string | null }>(
      `select m.id as move, r.at, ${MOVE_STATUS}, to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as place_at
       from ledger.moves m
       join ledger.opportunities o on o.id = m.opportunity_id
       ${LATEST_REPORT}
       where ${SHOWN}
         and ($1::timestamptz is null or (r.at, m.id) < ($1::timestamptz, $2::text))
       order by r.at desc, m.id desc
       limit $3`,
      [page.after?.[0] ?? null, page.after?.[1] ?? null, page.limit + 1],
    );
    const kept = rows.slice(0, page.limit);
    const judged = new Map(
      (
        await query<{ move: string; answer: string }>(
          `select distinct on (d.target_id) d.target_id as move, d.answer from knowledge.owner_decisions d
           where d.kind = 'result_eval' and d.target_kind = 'move' and d.target_id = any ($1::text[]) and d.tainted_at is null
           order by d.target_id, d.decided_at desc, d.id collate "C" desc`,
          [kept.map((row) => row.move)],
        )
      ).map((row) => [row.move, row.answer]),
    );
    const lines = new Map<string, CardLine[]>();
    for (const row of kept) lines.set(row.move, await resultLines({ query, keys: admin.keys }, row.move));
    const erased = await erasedOf(query, lines);
    const results: OwnerResults["results"] = kept
      .filter((row) => !erased.has(row.move))
      .map((row) => {
        const answer = judged.get(row.move);
        return {
          move: row.move,
          reportedAt: stamp(row.at) as OwnerResults["results"][number]["reportedAt"],
          lines: lines.get(row.move) ?? [],
          judged: answer === "keep" || answer === "not_useful" ? answer : null,
          ...ended(row.move_status, lines.get(row.move) ?? []),
        };
      });
    const last = kept.at(-1);
    return {
      results,
      next: rows.length > page.limit && last !== undefined ? cursorOf([last.place_at, last.move]) : null,
      ...(page.after === undefined || page.after === null
        ? { thisWeek: await thisWeek(query, admin), unopened: await unopened(query, admin) }
        : {}),
    };
  });
}

// The owner's Keep or Not useful, or `none` to clear it: a `result_eval` decision on a result the
// feed shows, superseding their last in force. A move the feed does not show is not_found. An
// answer that changes nothing writes nothing: their judgment again returns its ruling; `none` with
// none is invalid_argument. A repeated request returns its first ruling.
export async function judgeResult(admin: AdminContext, body: JudgeResultBody): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [body.move]);
    const [shown] = await query<{ id: string }>(
      `select m.id from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id ${LATEST_REPORT}
       where m.id = $1 and ${SHOWN}`,
      [body.move],
    );
    const report = shown === undefined ? null : await reportOf(query, body.move);
    if (
      report === null ||
      (await erasedOf(query, new Map([[body.move, await resultLines({ query, keys: admin.keys }, body.move)]]))).size >
        0
    )
      throw new AdminError("not_found");
    const repeat = await repeatedDecision(query, body.requestId);
    if (repeat !== undefined) return repeat;
    const [last] = await query<{ id: RulingId; answer: string }>(
      `select id, answer from knowledge.owner_decisions where kind = 'result_eval' and target_kind = 'move' and target_id = $1 and tainted_at is null
       order by decided_at desc, id collate "C" desc limit 1`,
      [body.move],
    );
    if (body.reason !== undefined && body.answer !== "not_useful") throw new AdminError("invalid_argument");
    if ((last?.answer ?? "none") === body.answer) {
      if (last === undefined) throw new AdminError("invalid_argument");
      return last.id;
    }
    return ownerDecision(
      query,
      {
        requestId: body.requestId,
        kind: "result_eval",
        target: { kind: "move", id: body.move },
        answer: body.answer,
        supersedes: last?.id ?? null,
        details: body.reason === undefined ? {} : { reason: body.reason },
        compartments: report.compartments,
      },
      now,
    );
  });
}

// One line for each task finished in the last seven days (its latest event `done`) whose result the Results
// feed shows and the owner has not opened: no ledger.owner_views row of its move, and no Keep or Not useful
// of theirs on it: a result they judged, opened or not, they have seen enough of. A line says what was made
// in code's words (the task's kind, what it is about by name within the owner's audience, the agent whose
// move finished it, when); never an agent's words. `openResult` (R-T13) records an opening, from the shelf or
// any Results row.
const SHELF_DAYS = 7;

const OPENED = `(exists (select 1 from ledger.owner_views w where w.target_kind = 'move' and w.target_id = m.id)
  or exists (select 1 from knowledge.owner_decisions d where d.kind = 'result_eval' and d.target_kind = 'move' and d.target_id = m.id and d.tainted_at is null))`;

// Twice the room, so the lines whose cited records were erased can be left out and still fill it.
const LINES = `
  select m.id as move, o.id as opportunity, o.kind, o.about_kind, o.about_id, s.at as done_at, c.name as agent, ${MOVE_STATUS}
  from ledger.moves m
  join ledger.opportunities o on o.id = m.opportunity_id
  ${LATEST_REPORT}
  join lateral (${latestRow("x.event, x.at", "opportunity", "o.id", { alias: "x" })}) s on true
  left join policy.clients c on 'client:' || c.id = m.created_by
  where ${SHOWN} and s.event = 'done' and s.at >= $1 and not ${OPENED}
  order by s.at desc, m.id desc
  limit $2`;

type Row = {
  move: MoveId;
  opportunity: OpportunityId;
  kind: OpportunityKind;
  about_kind: ShelfLine["about"]["kind"];
  about_id: string | null;
  done_at: Date;
  agent: ClientName | null;
  move_status: string | null;
};

// The shelf's lines, in the caller's transaction.
async function unopened(query: Query, admin: AdminContext): Promise<ShelfLine[]> {
  const since = stamp(new Date(admin.now().getTime() - SHELF_DAYS * DAY_MS));
  const rows = await query<Row>(LINES, [since, SHELF_MOST * 2]);
  const lines = new Map<string, CardLine[]>();
  for (const row of rows) lines.set(row.move, await resultLines({ query, keys: admin.keys }, row.move));
  const erased = await erasedOf(query, lines);
  const kept = rows.filter((row) => !erased.has(row.move)).slice(0, SHELF_MOST);
  // Whom each is about, by name within the owner's audience; one withheld is not named.
  const withheld = await ownerWithheld(query);
  const entities = kept.flatMap((row) =>
    row.about_kind === "entity" && row.about_id !== null && !withheld.has(row.about_id) ? [row.about_id] : [],
  );
  const who = await ownerWho({ query, keys: admin.keys }, entities);
  return kept.map((row) => {
    const named = row.about_kind === "entity" && row.about_id !== null ? who.get(row.about_id) : undefined;
    return {
      move: row.move,
      opportunity: row.opportunity,
      kind: row.kind,
      agent: row.agent,
      about: { kind: row.about_kind, id: row.about_id, name: named?.name ?? named?.address ?? null },
      doneAt: stamp(row.done_at) as Timestamp,
      ...ended(row.move_status, lines.get(row.move) ?? []),
    };
  });
}

// Null for a move the feed does not show, or whose cited records were erased; nothing is written then.
export async function openResult(admin: AdminContext, move: MoveId): Promise<OwnerResult | null> {
  const now = admin.now();
  return admin.transaction(async (query: Query) => {
    const [row] = await query<{ at: Date; move_status: string | null }>(
      `select r.at, ${MOVE_STATUS} from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id ${LATEST_REPORT}
       where m.id = $1 and ${SHOWN}`,
      [move],
    );
    if (row === undefined) return null;
    const lines = await resultLines({ query, keys: admin.keys }, move);
    if ((await erasedOf(query, new Map([[move, lines]]))).size > 0) return null;
    const [judged] = await query<{ answer: string }>(
      `select answer from knowledge.owner_decisions where kind = 'result_eval' and target_kind = 'move' and target_id = $1 and tainted_at is null
       order by decided_at desc, id collate "C" desc limit 1`,
      [move],
    );
    await writeView(query, { kind: "move", id: move }, "web", now);
    return {
      move,
      reportedAt: stamp(row.at) as Timestamp,
      lines,
      judged: judged?.answer === "keep" || judged?.answer === "not_useful" ? judged.answer : null,
      ...ended(row.move_status, lines),
    };
  });
}
