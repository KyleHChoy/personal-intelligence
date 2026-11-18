import {
  type AgentActivity,
  type AgentRecordId,
  type CardLine,
  type ClientName,
  type KnownCardKind,
  keyedLine,
  linePart,
  type MoveId,
  type MoveReportBody,
  type MoveStatus,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityKind,
  type OpportunityStatus,
  type OutcomeLinkKind,
  OWNER_PAGE_MOST,
  type OwnerWorkItem,
  type ResultOutcome,
  type RoleName,
  resultHeadline,
  resultOutcome,
  type Stage,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { latestRow, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "../../core/statements.ts";
import { openedReport } from "../../core/work-refs.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";
import { handedOutcomeViews, waitingViews } from "../cards/admin-queue.ts";

// Work rows are the owner's own ledger, which none of that spec's stated reader filters covers; it keeps
// the one the work views keep, leaving out tainted opportunities and moves (a deletion reached them). No
// belief is read. Summaries are opened and marked as the agent's ({ untrusted }); one whose compartment
// key the key file lacks is null. Each bucket is cut at OWNER_PAGE_MOST, newest first by its own time.
// Nine statements at most, none per row.
//
// - needsYou.cards: the pending, unexpired cards of the kinds that wait on the owner's judgment of
//   agent work, oldest first, as `listPending` lists them; listing opens none (W8). After them, an
//   outcome card the card cap held back (`deferred`) on work handed to the owner, which `decide`
//   answers.
// - needsYou.handedToYou: open work handed to the owner.
// - working: work claimed by a client whose lease is live, since its latest claim.
// - finished: moves reported done in the last 7 days, with the agent records their report cites.
// - blocked: work whose latest move was reported blocked or failed and on which nothing has
//   happened since but that report's own status (the report and its status share a session), with
//   the outcome as its code and the report's reason (else its summary). Failed or blocked work
//   that is not a task is handed to the owner, so it is in needsYou too; a blocked task is back on the
//   board until claimed again; a failed task is withdrawn, and shown for 7 days.

const RECENT_DAYS = 7;
const MOST = OWNER_PAGE_MOST;
const NEEDS_YOU_KINDS = [
  "opportunity_decision",
  "owner_question",
  "outcome",
  "goal_proposal",
] satisfies KnownCardKind[];

// One work item's columns, for opportunity `o`, its latest status `s` and its move `mv` (id,
// stage, created_at, status, status_at, session_id), the lease at $1, the admin's clock. The role is
// the latest hand-off's, null for a hand-off to any agent, else the row's.
const ITEM = `o.id, o.kind, o.tier, o.compartments, o.body_enc, o.about_kind, o.about_id, s.event as status, s.at as status_at,
  case when exists (${OPPORTUNITY_ROUTED})
    then (${ROUTED_ROLE})
    else o.role end as role,
  (select c.name from queue.leases l join policy.clients c on c.id = l.holder
   where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= $1) as holder,
  (select max(r.at) from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed') as claimed_at,
  (select l.kind from ledger.outcome_links l where l.opportunity_id = o.id and l.applied and l.tainted_at is null order by l.judged_at desc, l.id desc limit 1) as outcome,
  mv.id as move_id, mv.stage as move_stage, mv.created_at as move_at, mv.status as move_status, mv.status_at as move_status_at,
  mv.status in ('blocked', 'failed') and s.session_id is not null and s.session_id = mv.session_id as blocked`;
const STATUS = `join lateral (${latestRow("r.event, r.at, r.session_id", "opportunity", "o.id")}) s on true`;
const MOVE_STATUS = `left join lateral (${latestRow("r.event as status, r.at as status_at, r.session_id", "move", "m.id", { and: "r.event <> 'reported'" })}) ms on true`;

// Work in a bucket: open and claimed or handed to the owner, or open or failed in the last $3 with its
// latest untainted move reported blocked or failed. `proposed` work with no such move is in none.
const OPEN_WORK = `
  select x.* from (
    select ${ITEM}
    from ledger.opportunities o
    ${STATUS}
    left join lateral (
      select m.id, m.stage, m.created_at, ms.status, ms.status_at, ms.session_id from ledger.moves m
      ${MOVE_STATUS}
      where m.opportunity_id = o.id and m.tainted_at is null
      order by m.created_at desc, m.id desc limit 1) mv on true
    where o.tainted_at is null and (s.event = any ($2::text[]) or (s.event = 'withdrawn' and s.at >= $3))
  ) x
  where x.status in ('claimed', 'handed_to_owner') or x.blocked
  order by x.status_at desc, x.id desc`;

// Moves reported done since $2, newest first, each with its opportunity.
const FINISHED = `
  select ${ITEM}
  from ledger.moves m
  ${MOVE_STATUS}
  cross join lateral (select m.id, m.stage, m.created_at, ms.status, ms.status_at, ms.session_id) mv
  join ledger.opportunities o on o.id = m.opportunity_id
  ${STATUS}
  where m.tainted_at is null and o.tainted_at is null and ms.status = 'done' and ms.status_at >= $2
  order by ms.status_at desc, m.id desc
  limit ${MOST}`;

// The latest report of each move asked.
const REPORTS = `
  select distinct on (r.row_id) r.row_id, r.compartments, r.body_enc from ledger.record_events r
  where r.row_kind = 'move' and r.row_id = any ($1::text[]) and r.event = 'reported' and r.code is distinct from 'progress'
    and r.body_enc is not null and r.tainted_at is null
  order by r.row_id, r.id desc`;

// The agent records each move's report cites, as its basis keeps them.
const FINDINGS = `
  select b.row_id, b.ref_id from ledger.basis b
  where b.row_kind = 'move' and b.row_id = any ($1::text[]) and b.ref_kind = 'agent_record' and b.tainted_at is null
  order by b.row_id, b.id`;

type ItemRow = {
  id: OpportunityId;
  kind: OpportunityKind;
  tier: string;
  compartments: string[];
  body_enc: Sealed;
  about_kind: NonNullable<OwnerWorkItem["about"]>["kind"];
  about_id: string | null;
  status: OpportunityStatus;
  status_at: Date;
  role: RoleName | null;
  holder: ClientName | null;
  claimed_at: Date | null;
  outcome: OutcomeLinkKind | null;
  move_id: MoveId | null;
  move_stage: Stage | null;
  move_at: Date | null;
  move_status: MoveStatus | null;
  move_status_at: Date | null;
  blocked: boolean | null;
};

// `named`: the people and organizations the work is about, by id, within the owner's audience.
function itemOf(
  keys: Keys,
  row: ItemRow,
  named: ReadonlyMap<string, UntrustedString | null> = new Map(),
): OwnerWorkItem {
  const summary = open(keys, row, "ledger.opportunities.body_enc", "withheld");
  return {
    opportunity: row.id,
    kind: row.kind,
    task: row.tier === "task",
    status: row.status,
    role: row.role,
    holder: row.holder,
    move:
      row.move_id === null || row.move_stage === null || row.move_at === null
        ? null
        : { id: row.move_id, stage: row.move_stage, status: row.move_status, at: stamp(row.move_at) },
    outcome: row.outcome,
    summary: summary === null ? null : { untrusted: summary },
    about: {
      kind: row.about_kind,
      id: row.about_id,
      name: row.about_kind === "entity" && row.about_id !== null ? (named.get(row.about_id) ?? null) : null,
    },
  };
}

// The agent records each finished report cites that a deletion removed, by move: a result citing one
// is not shown (admin-results.ts `erasedOf`), so its headline is not either (invariant 10).
const ERASED_CITES = "select id from ledger.agent_writes where id = any ($1::text[]) and tainted_at is null";

// How each finished move ended and its headline, from its latest report as a result's lines carry
// it (card-kinds-outcome.ts: the "found" heading, then the report's summary as the agent's words),
// opened under the report's whole label or not at all. A move whose report is unreadable, or cites
// a removed agent record, has no headline. One statement, none per row.
export type EndedRow = Pick<ItemRow, "move_id" | "move_status">;
export async function endedOf(
  query: Query,
  finished: readonly EndedRow[],
  bodies: ReadonlyMap<string, MoveReportBody>,
): Promise<(row: EndedRow) => { resultOutcome: ResultOutcome; headline: UntrustedString | null }> {
  const citesOf = (move: string | null): string[] =>
    (bodies.get(move ?? "")?.report?.sources ?? []).flatMap((one) =>
      typeof one !== "string" && one.kind === "agent_record" ? [one.id] : [],
    );
  const cites = [...new Set(finished.flatMap((row) => citesOf(row.move_id)))];
  const kept =
    cites.length === 0
      ? new Set<string>()
      : new Set((await query<{ id: string }>(ERASED_CITES, [cites])).map((one) => one.id));
  return (row) => {
    const body = bodies.get(row.move_id ?? "");
    const erased = citesOf(row.move_id).some((id) => !kept.has(id));
    // An agent says what it found as the report's summary, or, through report_move, its deliverable.
    const found = body?.summary ?? body?.report?.deliverable;
    const lines: CardLine[] =
      found === undefined || erased
        ? []
        : [keyedLine("code", "heading", [linePart.code("found")]), { text: found, from: "agent" }];
    const headline = resultHeadline(lines);
    return {
      resultOutcome: resultOutcome(row.move_status, lines),
      headline: headline === null ? null : { untrusted: headline },
    };
  };
}

// Rows newest first by `at`, then id, cut at MOST.
const newest = <Row extends ItemRow>(rows: Row[], at: (row: Row) => Date): Row[] =>
  [...rows]
    .sort((a, b) => at(b).getTime() - at(a).getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MOST);

export async function agentActivity(admin: AdminContext): Promise<AgentActivity> {
  const now = admin.now();
  const since = stamp(new Date(now.getTime() - RECENT_DAYS * DAY_MS));
  return admin.transaction(async (query: Query) => {
    const openWork = await query<ItemRow>(OPEN_WORK, [stamp(now), [...OPEN_STATUSES], since]);
    const finished = await query<ItemRow>(FINISHED, [stamp(now), since]);
    const blocked = newest(
      openWork.filter((row) => row.blocked === true),
      (row) => row.move_status_at as Date,
    );
    const reports = await query<{ row_id: string; compartments: string[]; body_enc: Sealed }>(REPORTS, [
      [...blocked, ...finished].map((row) => row.move_id),
    ]);
    const findings = await query<{ row_id: string; ref_id: AgentRecordId }>(FINDINGS, [
      finished.map((row) => row.move_id),
    ]);
    const handed = newest(
      openWork.filter((row) => row.status === "handed_to_owner"),
      (row) => row.status_at,
    );
    // With them, the outcome card that waits on each piece of work handed to the owner, pending or held
    // back by the cap, answered on that work's row: never cut by the waiting cards, which take the
    // room left.
    const handedCards = await handedOutcomeViews(
      query,
      now,
      handed.map((row) => row.id),
    );
    const held = new Set(handedCards.map((card) => card.id));
    const waiting = await waitingViews(query, now, NEEDS_YOU_KINDS, MOST);
    const cards = [
      ...waiting.filter((card) => !held.has(card.id)).slice(0, Math.max(0, MOST - handedCards.length)),
      ...handedCards.slice(0, MOST),
    ];

    const reasons = new Map<string, UntrustedString | null>();
    const bodies = new Map<string, MoveReportBody>();
    for (const report of reports) {
      const text = open(
        admin.keys,
        { ...report, id: `${report.row_id}/reported` },
        "ledger.record_events.body_enc",
        "withheld",
      );
      const body = text === null ? null : openedReport(text);
      if (body !== null) bodies.set(report.row_id, body);
      const reason = body?.report?.reason ?? body?.summary ?? null;
      reasons.set(report.row_id, reason === null ? null : { untrusted: reason });
    }
    const ended = await endedOf(query, finished, bodies);
    const withheld = await ownerWithheld(query);
    const entities = [
      ...new Set(
        [...openWork, ...finished].flatMap((row) =>
          row.about_kind === "entity" && row.about_id !== null && !withheld.has(row.about_id) ? [row.about_id] : [],
        ),
      ),
    ];
    const who = await ownerWho({ query, keys: admin.keys }, entities);
    const named = new Map([...who].map(([id, one]) => [id, one.name ?? one.address ?? null]));
    const item = (row: ItemRow): OwnerWorkItem => itemOf(admin.keys, row, named);
    const cited = new Map<string, AgentRecordId[]>();
    for (const row of findings) cited.set(row.row_id, [...(cited.get(row.row_id) ?? []), row.ref_id].slice(0, MOST));

    return {
      needsYou: {
        cards,
        handedToYou: handed.map(item),
      },
      working: newest(
        openWork.filter(
          (row): row is ItemRow & { claimed_at: Date } =>
            row.status === "claimed" && row.holder !== null && row.claimed_at !== null,
        ),
        (row) => row.claimed_at,
      ).map((row) => ({ ...item(row), since: stamp(row.claimed_at) })),
      finished: finished.map((row) => ({
        ...item(row),
        doneAt: stamp(row.move_status_at as Date),
        findings: cited.get(row.move_id ?? "") ?? [],
        ...ended(row),
      })),
      blocked: blocked.map((row) => ({
        ...item(row),
        code: row.move_status as string,
        reason: reasons.get(row.move_id ?? "") ?? null,
      })),
    };
  });
}
