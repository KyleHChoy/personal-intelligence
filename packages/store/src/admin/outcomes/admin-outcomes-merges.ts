import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { latestEvent } from "../../core/statements.ts";
import type { Clock } from "./admin-outcomes-health.ts";

// How often the standing rule joins two different people: of its merges an agent audited in the
// window, the share an agent reported as wrong. Owner-side only: no client reads it.

// A merge counts as audited when its audit task was done, or a report names it: an agent that finds
// it wrong may report and never finish the task. A task's subject is the ruling's id, 30 characters,
// with `_2` after it for a second look, which is the same merge.
const AUDITS = `
  with tasks as (
    select left(o.gap_subject, 30) as ruling_id, (${latestEvent("opportunity", "o.id")}) = 'done' as done
    from ledger.opportunities o
    where o.gap_trigger = 'merge_audit' and o.tainted_at is null and o.created_at >= $1 and o.compartments <@ $2::text[]
  ),
  named as (
    select c.one as ruling_id, bool_or(w.state = 'split') as split
    from ledger.wrong_merge_reports w cross join lateral unnest(w.cross_rulings) as c (one)
    where w.compartments <@ $2::text[]
    group by c.one
  )
  select
    (select count(distinct t.ruling_id) from tasks t left join named n on n.ruling_id = t.ruling_id where t.done or n.ruling_id is not null)::int as audited,
    (select count(distinct t.ruling_id) from tasks t join named n on n.ruling_id = t.ruling_id)::int as found_wrong,
    (select count(distinct t.ruling_id) from tasks t join named n on n.ruling_id = t.ruling_id and n.split)::int as split,
    (select count(*) from ledger.wrong_merge_reports w where w.state = 'owner' and w.compartments <@ $2::text[])::int as waiting_owner`;

export type MergeAudits = { audited: number; found_wrong: number; split: number; waiting_owner: number };

export const mergeAuditMetric = (read: MergeAudits, days: number): OutcomeMetric =>
  outcomeMetric("policy_merges_wrong_share", {
    value: shareOf(read.found_wrong, read.audited),
    sample: read.audited,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
    parts: { ...read },
  });

export async function mergeAudits(query: Query, days: number, { within, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<MergeAudits>(AUDITS, [ago(days), within]);
  return mergeAuditMetric(row ?? { audited: 0, found_wrong: 0, split: 0, waiting_owner: 0 }, days);
}
