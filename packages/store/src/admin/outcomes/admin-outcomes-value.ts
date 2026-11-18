import { GAP_VALUE_WINDOW_DAYS, gapWeight } from "@intelligence/personal-core/planner";
import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";

// `pi outcomes`' `value`: whether finished tasks were used, by what code can show and what the owner
// said, by trigger. `kept` and `dropped` are the small weekly sample's: `used` is the main measure, and
// their answer outranks it on the result they judged. A `weight` under 1 is less room for that trigger
// and a later place on the board. Counts, codes and ids of triggers only.

type TaskValueLine = {
  trigger: string;
  done: number;
  scored: number;
  used: number;
  kept: number;
  dropped: number;
  rejected: number;
  usedShare: number | null;
  weight: number;
};
export type TaskValue = TaskValueLine & {
  cited: number;
  acted: number;
  confirmed: number;
  reasons: Record<string, number>;
  triggers: TaskValueLine[];
};

const BY_TRIGGER = `
  select v.trigger, count(*)::int as done, count(*) filter (where v.scored)::int as scored, count(*) filter (where v.used)::int as used,
    count(*) filter (where v.judged = 'keep')::int as kept, count(*) filter (where v.dropped)::int as dropped,
    count(*) filter (where v.rejected and not v.confirmed)::int as rejected,
    count(*) filter (where v.cited)::int as cited, count(*) filter (where v.acted)::int as acted, count(*) filter (where v.confirmed)::int as confirmed
  from ledger.task_value($1, $2, $3::text[]) v
  group by 1 order by 2 desc, 1`;
const REASONS = `
  select coalesce(v.reason, 'none') as reason, count(*)::int as n from ledger.task_value($1, $2, $3::text[]) v
  where v.dropped group by 1`;

type Row = Omit<TaskValueLine, "usedShare" | "weight"> & { cited: number; acted: number; confirmed: number };
const lineOf = (row: Omit<TaskValueLine, "usedShare" | "weight">): TaskValueLine => ({
  ...row,
  usedShare: shareOf(row.used, row.scored),
  weight: gapWeight(row),
});

export async function taskValue(query: Query, since: string, until: string, within: string[]): Promise<TaskValue> {
  const rows = await query<Row>(BY_TRIGGER, [since, until, within]);
  const total = (field: keyof Omit<Row, "trigger">): number => rows.reduce((sum, row) => sum + row[field], 0);
  const reasons = await query<{ reason: string; n: number }>(REASONS, [since, until, within]);
  return {
    ...lineOf({
      trigger: "all",
      done: total("done"),
      scored: total("scored"),
      used: total("used"),
      kept: total("kept"),
      dropped: total("dropped"),
      rejected: total("rejected"),
    }),
    cited: total("cited"),
    acted: total("acted"),
    confirmed: total("confirmed"),
    reasons: Object.fromEntries(reasons.map((one) => [one.reason, one.n])),
    triggers: rows.map(({ cited: _cited, acted: _acted, confirmed: _confirmed, ...row }) => lineOf(row)),
  };
}

// Of the finished tasks old enough to show a signal, or judged, the share used.
export const taskUsedShare = (value: TaskValue): OutcomeMetric =>
  outcomeMetric("task_used_share", {
    value: value.usedShare,
    sample: value.scored,
    window: { fromDaysAgo: GAP_VALUE_WINDOW_DAYS, toDaysAgo: 0 },
  });

// The board's funnel: of the tasks raised in a UTC week (from its Monday), how many were ever
// claimed, ever done, and kept by the owner, and the share claimed. A cohort, so a late claim counts
// for the week its task was raised.
// `codeClosed`: closed by rung 0 with no agent ever claiming it. These were never supply: a gap flag raised
// and closed tick after tick says nothing about whether work gets picked up, so they sit beside the
// counts, in none of them.
type FunnelCounts = {
  raised: number;
  codeClosed: number;
  claimed: number;
  done: number;
  kept: number;
  claimedShare: number | null;
};
export type TaskFunnel = FunnelCounts & { weeks: ({ week: string } & FunnelCounts)[] };

// Whether rung 0 closed the opportunity aliased `o` with no agent ever claiming it, as of $2. One
// definition, so the funnel and the headline's signals leave out the same rows.
export const CODE_CLOSED = `(exists (select 1 from ledger.opportunity_decisions d where d.opportunity_id = o.id and d.decided_by = 'policy' and d.decision = 'no_go' and d.created_at <= $2)
      and not exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed' and r.at <= $2))`;

const FUNNEL = `
  select to_char(date_trunc('week', o.created_at at time zone 'UTC'), 'YYYY-MM-DD') as week,
    count(*) filter (where not c.closed)::int as raised,
    count(*) filter (where c.closed)::int as code_closed,
    count(*) filter (where exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed' and r.at <= $2))::int as claimed,
    count(*) filter (where exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'done' and r.at <= $2))::int as done,
    count(*) filter (where exists (select 1 from ledger.moves v join knowledge.owner_decisions d on d.target_kind = 'move' and d.target_id = v.id
                                   where v.opportunity_id = o.id and d.kind = 'result_eval' and d.answer = 'keep' and d.tainted_at is null
                                     and d.compartments <@ $3::text[] and d.decided_at <= $2))::int as kept
  from ledger.opportunities o
  cross join lateral (select ${CODE_CLOSED} as closed) c
  where o.tier = 'task' and o.tainted_at is null and o.created_at >= $1 and o.created_at <= $2 and o.compartments <@ $3::text[]
  group by 1
  order by 1`;

export async function taskFunnel(query: Query, since: string, until: string, within: string[]): Promise<TaskFunnel> {
  const rows = await query<{
    week: string;
    raised: number;
    code_closed: number;
    claimed: number;
    done: number;
    kept: number;
  }>(FUNNEL, [since, until, within]);
  const counted = (counts: {
    raised: number;
    code_closed: number;
    claimed: number;
    done: number;
    kept: number;
  }): FunnelCounts => {
    const { code_closed: codeClosed, ...rest } = counts;
    return { ...rest, codeClosed, claimedShare: shareOf(counts.claimed, counts.raised) };
  };
  const total = (field: "raised" | "code_closed" | "claimed" | "done" | "kept"): number =>
    rows.reduce((sum, row) => sum + row[field], 0);
  return {
    ...counted({
      raised: total("raised"),
      code_closed: total("code_closed"),
      claimed: total("claimed"),
      done: total("done"),
      kept: total("kept"),
    }),
    weeks: rows.map(({ week, ...counts }) => ({ week, ...counted(counts) })),
  };
}
