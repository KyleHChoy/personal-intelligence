import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { CODE_CLOSED } from "./admin-outcomes-value.ts";

// `pi outcomes`' headline: whether the agents had what they needed and whether signals were acted on.
// Raised: what the hourly backtest pass saw surface, each once, and the knowledge gaps code put on the
// board, so a signal no agent read still counts. A gap rung 0 closed with no agent ever claiming it was
// never there to pick up: it is left out of raised and counted beside it, as the funnel does. Picked
// up: a client read it in get_changes, or claimed the task it is, each signal once. Written back: an
// agent said what happened, by write_back or, on a gap task it claimed, by reporting a move on it, each
// source once at its latest. By role: of the clients that hold it.
// The two sources count differently (the pass also sees plain meetings, the feed new people), so each
// share is bounded at 1 and reads as a trend, not an exact rate. Ids, counts and codes only, and only
// rows within the owner's unrestricted label.

const GAP_TASK =
  "o.tier = 'task' and o.gap_trigger is not null and o.tainted_at is null and o.compartments <@ $3::text[]";
const RAISED_GAP = `${GAP_TASK} and o.created_at >= $1 and o.created_at <= $2`;

const RAISED = `
  select
    (select count(*)::int from (
       select s.item_key from ledger.surfaced_items s
       where s.compartments <@ $3::text[] and s.source_kind <> 'goal'
       group by 1 having min(s.first_at) >= $1 and min(s.first_at) <= $2) x) as surfaced,
    (select count(*)::int from ledger.opportunities o where ${RAISED_GAP} and not ${CODE_CLOSED}) as gaps,
    (select count(*)::int from ledger.opportunities o where ${RAISED_GAP} and ${CODE_CLOSED}) as code_closed`;

// A gap task's key in the change feed, as get_changes makes it (gapSignalKey in read/read-changes.ts).
// A read of the gap, a read of the task as work handed to the client and a claim of it are then one signal.
const gapKey = (id: string): string =>
  `'sig_' || left(encode(sha256(convert_to('gap' || chr(10) || 'opportunity' || chr(10) || ${id}, 'UTF8')), 'hex'), 32)`;

// Every pick-up in the window: a client's first read of a signal in the feed, and a claim of a gap
// task, dated from when the task was raised. A claim by anyone but a client names no client.
const SEEN = `
    select 'read' as how, l.client_id,
      case when l.kind = 'work' and l.ref_id is not null then ${gapKey("l.ref_id")} else l.signal_key end as key,
      l.signal_at, l.first_at
    from ledger.change_log l
    where l.kind <> 'write_back' and l.first_at >= $1 and l.first_at <= $2 and l.compartments <@ $3::text[]
    union all
    select 'claimed', case when r.by like 'client:%' then substr(r.by, 8) end, ${gapKey("o.id")}, o.created_at, r.at
    from ledger.opportunities o
    join ledger.record_events r on r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed'
    where ${GAP_TASK} and r.at >= $1 and r.at <= $2`;

const PICKED = `
  with seen as (${SEEN})
  select count(distinct s.key)::int as picked,
    count(distinct s.key) filter (where s.how = 'read')::int as read,
    count(distinct s.key) filter (where s.how = 'claimed')::int as claimed,
    percentile_cont(0.5) within group (order by extract(epoch from s.first_at - s.signal_at) / 60)
      filter (where s.signal_at <= s.first_at) as median_minutes
  from seen s`;

// Every time an agent said what happened in the window: a write-back, and a report on a move of a gap
// task, which is how an agent that claimed the task says it (a progress report says nothing yet). A
// claim counts as a pick-up, so the report that closes the claim is what it wrote back. A report is
// keyed by its task, a write-back by what it marks: the task itself, which then merges with the
// report, or the task's source. So that one agent's work on one gap task counts once, a report is left
// out when the same agent wrote back on the task's source in the window; another agent's mark on a
// shared source leaves it, and its role's credit, as they are.
const MARKS = `
    select m.ref_id, m.client_id, m.state, m.created_at as at, m.id as tie
    from ledger.signal_marks m
    where m.tainted_at is null and m.created_at >= $1 and m.created_at <= $2 and m.compartments <@ $3::text[]`;
const SAID = `${MARKS}
    union all
    select o.id, case when v.created_by like 'client:%' then substr(v.created_by, 8) end, 'reported', r.at, r.id::text
    from ledger.opportunities o
    join ledger.moves v on v.opportunity_id = o.id and v.tainted_at is null and v.compartments <@ $3::text[]
    join ledger.record_events r on r.row_kind = 'move' and r.row_id = v.id and r.event = 'reported'
      and r.tainted_at is null and r.code is distinct from 'progress'
    where ${GAP_TASK} and r.at >= $1 and r.at <= $2 and r.compartments <@ $3::text[]
      and not exists (select 1 from (${MARKS}) m where m.ref_id = o.gap_source and 'client:' || m.client_id = v.created_by)`;

const WRITTEN = `
  with said as (${SAID})
  select x.state, count(*)::int as n from (
    select distinct on (s.ref_id) s.ref_id, s.state from said s
    order by s.ref_id, s.at desc, s.tie desc) x
  group by 1`;

const BY_ROLE = `
  with holders as (
    select k.id, k.name, one as role from policy.clients k
    left join lateral unnest(case when cardinality(k.roles) = 0 then array['no_role'] else k.roles end) as one on true
    where k.kind = 'agent'
  ), seen as (${SEEN}), said as (${SAID})
  select h.role,
    (select count(distinct s.key)::int from seen s join holders i on i.id = s.client_id where i.role = h.role) as picked,
    (select percentile_cont(0.5) within group (order by extract(epoch from s.first_at - s.signal_at) / 60)
     from seen s join holders i on i.id = s.client_id
     where i.role = h.role and s.signal_at <= s.first_at) as median_minutes,
    (select count(distinct s.ref_id)::int from said s join holders i on i.id = s.client_id where i.role = h.role) as written,
    (select count(*)::int from ledger.opportunities o
     where ${RAISED_GAP} and o.role = h.role and not ${CODE_CLOSED}) as gaps
  from (select distinct role from holders) h
  order by 1`;

type SeamRole = {
  role: string;
  gapsRaised: number;
  pickedUp: number;
  writtenBack: number;
  medianPickupMinutes: number | null;
};
export type SeamView = {
  raised: number;
  codeClosed: number;
  pickedUp: number;
  writtenBack: { handled: number; drafted: number; needsOwner: number; reported: number };
  medianPickupMinutes: number | null;
  byRole: SeamRole[];
  metrics: OutcomeMetric[];
};

const rounded = (minutes: number | null | undefined): number | null =>
  minutes === null || minutes === undefined ? null : Math.round(Number(minutes));

export async function seamSignals(
  query: Query,
  days: number,
  clock: { since: string; until: string; within: string[] },
): Promise<SeamView> {
  const values = [clock.since, clock.until, clock.within];
  const [raisedRow] = await query<{ surfaced: number; gaps: number; code_closed: number }>(RAISED, values);
  const [pickedRow] = await query<{ picked: number; read: number; claimed: number; median_minutes: number | null }>(
    PICKED,
    values,
  );
  const written = new Map(
    (await query<{ state: string; n: number }>(WRITTEN, values)).map((row) => [row.state, row.n] as const),
  );
  const roles = await query<{
    role: string;
    picked: number;
    median_minutes: number | null;
    written: number;
    gaps: number;
  }>(BY_ROLE, values);
  const raised = (raisedRow?.surfaced ?? 0) + (raisedRow?.gaps ?? 0);
  const pickedUp = pickedRow?.picked ?? 0;
  const handled = written.get("handled") ?? 0;
  const drafted = written.get("drafted") ?? 0;
  const needsOwner = written.get("needs_owner") ?? 0;
  const reported = written.get("reported") ?? 0;
  const window = { fromDaysAgo: days, toDaysAgo: 0 };
  return {
    raised,
    codeClosed: raisedRow?.code_closed ?? 0,
    pickedUp,
    writtenBack: { handled, drafted, needsOwner, reported },
    medianPickupMinutes: rounded(pickedRow?.median_minutes),
    byRole: roles.map((row) => ({
      role: row.role,
      gapsRaised: row.gaps,
      pickedUp: row.picked,
      writtenBack: row.written,
      medianPickupMinutes: rounded(row.median_minutes),
    })),
    metrics: [
      outcomeMetric("signals_picked_up", {
        value: Math.min(1, shareOf(pickedUp, raised) ?? 0),
        sample: raised,
        window,
        parts: { read: pickedRow?.read ?? 0, claimed: pickedRow?.claimed ?? 0 },
      }),
      outcomeMetric("signals_written_back", {
        value: Math.min(1, shareOf(handled + drafted + needsOwner + reported, pickedUp) ?? 0),
        sample: pickedUp,
        window,
        parts: { handled, drafted, needs_owner: needsOwner, reported },
      }),
    ],
  };
}
