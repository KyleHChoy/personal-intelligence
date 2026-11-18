import {
  type CaseAnswer,
  type ClosedCase,
  DeclineReason,
  type HypothesisId,
  type HypothesisStatus,
  type OpportunityId,
  type OpportunityStatus,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { byText, stamp } from "../core/db.ts";
import { LESSON_IN_FORCE, latestRow, moveStatus } from "../core/statements.ts";
import { storedAbout, type WorkCall } from "../core/work-refs.ts";
import { servedOrNull } from "../read/read-ctx.ts";

// The closed and answered cases a run or an agent's brief sees, the planner's learning loop; the
// lessons the owner confirmed and the evidence cited rows show, for a brief; and the opener every
// part of a run request serves sealed text through.

const CLOSED_LIMIT = 50;
// Which closed cases a run sees: those that share the run's focus, of the last 180 days, and the
// others of the last 30, the 10 newest of which are always taken first.
const CLOSED_DAYS = 30;
const CLOSED_RELEVANT_DAYS = 180;
const CLOSED_RECENT_KEPT = 10;
// The most code points the closed cases may take, as JSON text, so months of long summaries and
// notes cannot crowd the run's input.
export const CLOSED_CODE_POINTS = 24_000;

// The evidence of what the rows named cite.
export const CITED_SQL = `
    select distinct b.evidence_id from ledger.basis b
    where b.evidence_id is not null and (b.row_kind, b.row_id) in (select * from unnest($1::text[], $2::text[]))
    order by 1`;

const SQL = {
  // A hypothesis or opportunity a run is anchored on: its kind and what it is about join the
  // run's focus.
  focus: `
    select h.id, h.kind, h.about_kind, h.about_id from ledger.hypotheses h where h.id = any($1) and h.tainted_at is null
    union all
    select o.id, o.kind, o.about_kind, o.about_id from ledger.opportunities o where o.id = any($1) and o.tainted_at is null`,
  // The planner's learning loop: each case that closed (the owner's no_go or rejection, an expiry,
  // work done, a hypothesis settled) or that the owner answered, with its latest status, the
  // owner's latest answer (an event they wrote on its card) and the note they left with that answer, if
  // any. Asked for several focuses at once, numbered 0 to $8 - 1 (a brief's list, one per
  // opportunity), each case is read once and judged for each focus: `relevant` when the case is, or
  // is about, or cites, or serves the goal or hypothesis of, a ref of that focus ($3 to $5), or is
  // of a kind of it ($6, $7): those of the last 180 days ($2), the others of the last 30 ($1); at
  // most 50 of each per focus, each newest first, the relevant first.
  closed: `
    with f as (select * from unnest($3::int[], $4::text[], $5::text[]) as f(v, ref_kind, ref_id)),
    k as (select * from unnest($6::int[], $7::text[]) as k(v, kind)),
    x as (
      select 'opportunity' as row_kind, o.id, o.kind, o.about_kind, o.about_id, o.goal_id, o.hypothesis_id, o.compartments, o.body_enc, o.created_by from ledger.opportunities o where o.tainted_at is null
      union all
      select 'hypothesis', h.id, h.kind, h.about_kind, h.about_id, null, null, h.compartments, h.body_enc, h.created_by from ledger.hypotheses h where h.tainted_at is null and h.kind <> 'lesson'
    ), y as materialized (
      select * from (
        select x.*, s.event as status, s.by as status_by, d.event as answered,
          case when d.body_enc is null then null else d.event end as note_event, d.compartments as note_compartments, d.body_enc as note_enc,
          -- The reason the owner gave with their no, the code of its event.
          case when d.event in ('no_go', 'rejected') then d.code end as decline_code,
          (s.event in ('expired', 'done', 'supported', 'refuted', 'confirmed', 'retired') or (s.event in ('no_go', 'rejected') and s.by = 'owner')) as closed,
          greatest(case when s.event in ('expired', 'done', 'supported', 'refuted', 'confirmed', 'retired') or (s.event in ('no_go', 'rejected') and s.by = 'owner') then s.at end, d.at) as closed_at
        from x
        join lateral (${latestRow("r.event, r.by, r.at", "x.row_kind", "x.id")}) s on true
        left join lateral (
          select r.event, r.at, r.compartments, r.body_enc, r.code from ledger.record_events r
          where r.row_kind = x.row_kind and r.row_id = x.id and r.by = 'owner'
            and r.event = any (case when x.row_kind = 'opportunity' then array['go', 'handed_to_owner', 'later', 'no_go'] else array['confirmed', 'rejected', 'open', 'pursued', 'not_now'] end)
          order by r.id desc limit 1) d on true
        -- A lessons run shown the owner's actions sees only cases within its label.
        where ($9::text[] is null or x.compartments <@ $9::text[])
      ) c
      -- No case closed before the older of the two windows is ever kept.
      where c.closed_at >= $2::timestamptz
    ), z as (
      select v.v, y.row_kind, y.id, y.kind, y.about_kind, y.about_id, y.compartments, y.body_enc, y.status, y.status_by, y.answered, y.note_event, y.note_compartments, y.note_enc, y.decline_code, y.created_by, y.closed,
        (exists (select 1 from k where k.v = v.v and k.kind = y.kind)
          or exists (
            select 1 from f
            where f.v = v.v
              and ((f.ref_kind = y.row_kind and f.ref_id = y.id) or (f.ref_kind = y.about_kind and f.ref_id = y.about_id)
                or (f.ref_kind = 'goal' and f.ref_id = y.goal_id) or (f.ref_kind = 'hypothesis' and f.ref_id = y.hypothesis_id)))
          or exists (
            select 1 from ledger.basis b join f on f.ref_kind = b.ref_kind and f.ref_id = b.ref_id
            where f.v = v.v and b.row_kind = y.row_kind and b.row_id = y.id and b.tainted_at is null)) as relevant,
        y.closed_at
      from y cross join generate_series(0, $8::int - 1) as v(v)
    )
    select v, row_kind, id, kind, about_kind, about_id, compartments, body_enc, status, status_by, answered, note_event, note_compartments, note_enc, decline_code, created_by, closed, relevant, closed_at
    from (
      select z.*, row_number() over (partition by v, relevant order by closed_at desc, id desc) as n from z
      where closed_at >= case when relevant then $2::timestamptz else $1::timestamptz end
    ) w
    where n <= ${CLOSED_LIMIT}
    order by v, relevant desc, closed_at desc, id desc`,
  // What came of them: an opportunity's moves by their status (a move's status is its latest
  // event but a report), a hypothesis's tests by result.
  moves: `
    select m.opportunity_id as id, (${moveStatus()}) as state,
      count(*)::int as n
    from ledger.moves m where m.opportunity_id = any($1) and m.tainted_at is null group by 1, 2`,
  tests:
    "select t.hypothesis_id as id, t.result as state, count(*)::int as n from ledger.hypothesis_tests t where t.hypothesis_id = any($1) and t.tainted_at is null group by 1, 2",
  // An owner_question's answer: the test it recorded cites the opportunity, so the owner's
  // supports, refutes or neither reaches the learning loop with the case.
  answers: `
    select b.ref_id as id, t.result as state, count(*)::int as n from ledger.hypothesis_tests t
    join ledger.basis b on b.row_kind = 'test' and b.row_id = t.id and b.ref_kind = 'opportunity'
    where b.ref_id = any($1) and t.tainted_at is null group by 1, 2`,
  // And only a lesson whose label the client's clearance ($3) covers, by this condition and not by
  // row-level security alone.
  briefLessons: `
    select x.kind, x.id, x.compartments, x.body_enc from (
      select k.kind, h.id, h.compartments, h.body_enc, row_number() over (partition by k.kind order by h.created_at desc, h.id desc) as n
      from ledger.hypotheses h cross join unnest($1::text[]) as k (kind)
      where ${LESSON_IN_FORCE} and h.compartments <@ $3::text[]
        and (coalesce(cardinality(h.applies_kinds), 0) = 0 or k.kind = any (h.applies_kinds))
        and (coalesce(cardinality(h.applies_roles), 0) = 0 or h.applies_roles && $2::text[])
    ) x where x.n <= 50 order by x.kind, x.n`,
  cited: CITED_SQL,
} as const;

type ClosedRow = {
  row_kind: "hypothesis" | "opportunity";
  id: string;
  kind: ClosedCase["kind"];
  about_kind: string;
  about_id: string | null;
  compartments: string[];
  body_enc: unknown;
  status: OpportunityStatus | HypothesisStatus;
  status_by: string;
  answered: string | null;
  note_event: string | null;
  note_compartments: string[] | null;
  note_enc: unknown;
  decline_code: string | null;
  created_by: string;
  closed: boolean;
  relevant: boolean;
  closed_at: Date;
};

// Whose decline reasons a call is told. A run of the reasoner sees every case's; an agent's brief
// only those of the work it proposed, `client:<id>` (invariant 6).
type ReasonsFor = "all" | { author: string };

// The owner's decline reason on a case, when the caller may be told it. A code off the list (a task
// cancel's `cancelled`) is no reason.
function declineOf(row: ClosedRow, reasons: ReasonsFor): DeclineReason | undefined {
  if (row.decline_code === null || (reasons !== "all" && row.created_by !== reasons.author)) return undefined;
  const parsed = DeclineReason.safeParse(row.decline_code);
  return parsed.success ? parsed.data : undefined;
}

// The owner's decision on a case, from the status event their decision on its card wrote. An idea's
// `no` is its `rejected`.
const ANSWERS: Readonly<Record<string, CaseAnswer>> = {
  go: "go",
  handed_to_owner: "go",
  later: "later",
  no_go: "no_go",
  confirmed: "confirm",
  rejected: "reject",
  open: "skip",
  pursued: "pursue",
  not_now: "not_now",
};
const answerOf = (row: { kind: string; answered: string | null }): CaseAnswer | null =>
  row.answered === null
    ? null
    : row.kind === "idea" && row.answered === "rejected"
      ? "no"
      : (ANSWERS[row.answered] ?? null);

// A sealed text served as untrusted (servedOrNull), or null for one that will not open too, so one
// bad row does not stop a run.
export function untrustedOrNull(
  call: WorkCall,
  compartments: string[] | null,
  at: { table: string; id: string; column: string },
  envelope: unknown,
): UntrustedString | null {
  try {
    return servedOrNull(call.ctx.keys, compartments, at, envelope);
  } catch {
    return null;
  }
}

// The owner's note on a case: a note that will not open is left out, so one bad row does not
// stop every run.
function noteOf(call: WorkCall, row: ClosedRow, within: readonly string[] | null): UntrustedString | null {
  if (within !== null && !(row.note_compartments ?? []).every((one) => within.includes(one))) return null;
  return untrustedOrNull(
    call,
    row.note_compartments,
    { table: "ledger.record_events", id: `${row.id}/${row.note_event}`, column: "body_enc" },
    row.note_enc,
  );
}

export type Anchor = { ref_kind: string; ref_id: string; evidence_id: string | null };

// Each focus: its anchors, and for an anchor that is a hypothesis or an opportunity, its kind
// and what it is about. Read under the reasoner's policies, as every row of the request is, in
// one statement for every focus.
async function focusOf(
  call: WorkCall,
  focuses: readonly Anchor[][],
): Promise<{ refs: [kind: string, id: string][]; kinds: string[] }[]> {
  const rowIds = (anchors: readonly Anchor[]): string[] =>
    anchors.filter((one) => one.ref_kind === "hypothesis" || one.ref_kind === "opportunity").map((one) => one.ref_id);
  const ids = [...new Set(focuses.flatMap(rowIds))];
  const rows =
    ids.length === 0
      ? []
      : await call.ctx.run<{ id: string; kind: string; about_kind: string; about_id: string | null }>(SQL.focus, [ids]);
  return focuses.map((anchors) => {
    const refs = anchors.map((one): [string, string] => [one.ref_kind, one.ref_id]);
    const own = new Set(rowIds(anchors));
    const found = rows.filter((row) => own.has(row.id));
    for (const row of found) if (row.about_id !== null) refs.push([row.about_kind, row.about_id]);
    return { refs, kinds: [...new Set(found.map((row) => row.kind))].sort(byText) };
  });
}

type Closed = { cases: ClosedCase[]; rows: ClosedRow[] };

// The closed and answered cases a run sees: the 10 newest of those of the last 30 days that do not
// share its focus, then those of the last 180 that do, then the rest of the first group; each group
// newest first and stopped at the first case that would pass CLOSED_CODE_POINTS as JSON text, all
// at most 50; listed the relevant first. Each with its summary, the owner's decision and note, and
// what came of it. Returns the rows kept, for the evidence the request shows. A run sees every
// case's decline reason. `within`: a lessons run's label, outside which no case or note is shown.
export async function closedCases(
  call: WorkCall,
  anchors: Anchor[],
  now: Date,
  within: readonly string[] | null = null,
): Promise<Closed> {
  return (await closedCasesFor(call, [anchors], now, "all", within))[0] as Closed;
}

// The same for several focuses at once, in a fixed number of statements whatever their count (a
// brief's list): each focus's cases are exactly those closedCases gives it. `reasons`: whose decline
// reasons the caller is told.
export async function closedCasesFor(
  call: WorkCall,
  focuses: readonly Anchor[][],
  now: Date,
  reasons: ReasonsFor,
  within: readonly string[] | null = null,
): Promise<Closed[]> {
  if (focuses.length === 0) return [];
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY_MS);
  const focus = await focusOf(call, focuses);
  const refs = focus.flatMap((one, v) => one.refs.map(([kind, id]) => [v, kind, id] as const));
  const kinds = focus.flatMap((one, v) => one.kinds.map((kind) => [v, kind] as const));
  const all = await call.ctx.run<ClosedRow & { v: number }>(SQL.closed, [
    ago(CLOSED_DAYS),
    ago(CLOSED_RELEVANT_DAYS),
    refs.map(([v]) => v),
    refs.map(([, kind]) => kind),
    refs.map(([, , id]) => id),
    kinds.map(([v]) => v),
    kinds.map(([, kind]) => kind),
    focuses.length,
    within === null ? null : [...within],
  ]);
  const ids = (keep: (row: ClosedRow) => boolean): string[] => [...new Set(all.filter(keep).map((row) => row.id))];
  const counted = async (text: string, of: string[]): Promise<Map<string, Record<string, number>>> => {
    const found = new Map<string, Record<string, number>>();
    for (const row of await call.ctx.run<{ id: string; state: string | null; n: number }>(text, [of])) {
      if (row.state !== null) found.set(row.id, { ...found.get(row.id), [row.state]: row.n });
    }
    return found;
  };
  const moves = await counted(
    SQL.moves,
    ids((row) => row.row_kind === "opportunity"),
  );
  const tests = await counted(
    SQL.tests,
    ids((row) => row.row_kind === "hypothesis"),
  );
  const answers = await counted(
    SQL.answers,
    ids((row) => row.kind === "owner_question"),
  );
  const made = new Map<string, ClosedCase>();
  const caseOf = (row: ClosedRow): ClosedCase => {
    const known = made.get(row.id);
    if (known !== undefined) return known;
    const table = row.row_kind === "opportunity" ? "ledger.opportunities" : "ledger.hypotheses";
    const done = moves.get(row.id) ?? {};
    const results = tests.get(row.id) ?? answers.get(row.id) ?? {};
    const reason = declineOf(row, reasons);
    const one: ClosedCase = {
      rowKind: row.row_kind,
      kind: row.kind,
      about: storedAbout(row.about_kind, row.about_id),
      closedAt: stamp(row.closed_at),
      by:
        row.closed && row.status === "expired"
          ? "expiry"
          : row.answered !== null || row.status_by === "owner"
            ? "owner"
            : "policy",
      id: row.id as OpportunityId | HypothesisId,
      status: row.status,
      summary: servedOrNull(call.ctx.keys, row.compartments, { table, id: row.id, column: "body_enc" }, row.body_enc),
      decision: answerOf(row),
      note: noteOf(call, row, within),
      outcome: {
        moves: { done: done.done ?? 0, failed: done.failed ?? 0, blocked: done.blocked ?? 0 },
        tests: {
          supports: results.supports ?? 0,
          refutes: results.refutes ?? 0,
          inconclusive: results.inconclusive ?? 0,
        },
      },
      ...(reason === undefined ? {} : { declineReason: reason }),
    };
    made.set(row.id, one);
    return one;
  };
  return focuses.map((_, v) =>
    keptOf(
      all.filter((row) => row.v === v),
      caseOf,
    ),
  );
}

// One focus's cases, from its rows as SQL.closed lists them.
function keptOf(rows: ClosedRow[], caseOf: (row: ClosedRow) => ClosedCase): Closed {
  type Group = { rows: ClosedRow[]; at: number; full: boolean; kept: [ClosedRow, ClosedCase][] };
  const group = (relevant: boolean): Group => ({
    rows: rows.filter((row) => row.relevant === relevant),
    at: 0,
    full: false,
    kept: [],
  });
  const relevant = group(true);
  const recent = group(false);
  let size = 0;
  let count = 0;
  const take = (from: Group, upTo: number): void => {
    for (; !from.full && from.at < Math.min(upTo, from.rows.length) && count < CLOSED_LIMIT; from.at += 1) {
      const row = from.rows[from.at] as ClosedRow;
      const one = caseOf(row);
      const length = [...JSON.stringify(one)].length;
      if (size + length > CLOSED_CODE_POINTS) {
        from.full = true;
        return;
      }
      size += length;
      count += 1;
      from.kept.push([row, one]);
    }
  };
  take(recent, CLOSED_RECENT_KEPT);
  take(relevant, Infinity);
  take(recent, Infinity);
  const kept = [...relevant.kept, ...recent.kept];
  return { cases: kept.map(([, one]) => one), rows: kept.map(([row]) => row) };
}

// The lessons the owner confirmed, as a run's request holds them, for a brief: for each kind
// given, those for it that meet the client's roles. One statement, and each lesson opened once.
export async function confirmedLessons(
  call: WorkCall,
  fit: { kinds: readonly string[]; roles: readonly string[] },
): Promise<Map<string, { id: HypothesisId; lesson: UntrustedString }[]>> {
  const rows = await call.ctx.run<{ kind: string; id: string; compartments: string[]; body_enc: unknown }>(
    SQL.briefLessons,
    [[...fit.kinds], [...fit.roles], [...call.client.compartments]],
  );
  const opened = new Map<string, UntrustedString | null>();
  const byKind = new Map<string, { id: HypothesisId; lesson: UntrustedString }[]>(fit.kinds.map((kind) => [kind, []]));
  for (const row of rows) {
    if (!opened.has(row.id))
      opened.set(
        row.id,
        servedOrNull(
          call.ctx.keys,
          row.compartments,
          { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
          row.body_enc,
        ),
      );
    const lesson = opened.get(row.id) ?? null;
    if (lesson !== null) byKind.get(row.kind)?.push({ id: row.id as HypothesisId, lesson });
  }
  return byKind;
}

// The evidence the named rows cite, which a brief that shows them shows.
export async function citedEvidence(
  call: WorkCall,
  rows: readonly (readonly [kind: string, id: string])[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  return (
    await call.ctx.run<{ evidence_id: string }>(SQL.cited, [rows.map(([kind]) => kind), rows.map(([, id]) => id)])
  ).map((row) => row.evidence_id);
}
