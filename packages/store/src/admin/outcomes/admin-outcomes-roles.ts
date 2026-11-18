import type { Query } from "../../core/db.ts";
import { stamp } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric } from "../../core/outcome-thresholds.ts";
import { latestRow, OPPORTUNITY_ROUTED, quoted, ROUTED_ROLE } from "../../core/statements.ts";
import type { Clock } from "./admin-outcomes-health.ts";

// `roles_unattended`: a role whose work waits and whose agents never ask.

// Tasks in go at $2, by route, that went to go before $1 and no client holds: the route as the board
// reads it, the latest hand-off's role, else the role at proposal. A route is attended when an active
// client holding that role, or named by it, asked for work between $1 and $2. No client is woken, so a
// role whose agents never ask leaves its work waiting, and here alone is it seen.
const ASKS_FOR_WORK = ["list_opportunities", "claim_opportunity", "get_changes"] as const;
const WAITING_BY_ROLE = `
  select w.role, count(*)::int as n,
    w.role is not null and exists (
      select 1 from policy.clients k
      where k.status = 'active' and (w.role = any (k.roles) or k.name = w.role)
        and exists (select 1 from policy.calls c where c.client_id = k.id and c.tool in (${quoted(ASKS_FOR_WORK)})
                    and c.at > $1 and c.at <= $2)) as attended
  from (
    select case when exists (${OPPORTUNITY_ROUTED}) then (${ROUTED_ROLE}) else o.role end as role
    from ledger.opportunities o
    cross join lateral (${latestRow("r.event, r.at", "opportunity", "o.id", { and: "r.at <= $2" })}) s
    where o.tier = 'task' and o.tainted_at is null and o.compartments <@ $3::text[]
      and s.event = 'go' and s.at <= $1
      and not exists (select 1 from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= $2)
  ) w
  group by w.role`;

// `waiting`: every task in go and unheld for over a day, of a role or none.
export async function unattendedRoles(
  query: Query,
  { now, within, ago }: Clock,
): Promise<{ metric: OutcomeMetric; waiting: number }> {
  const rows = await query<{ role: string | null; n: number; attended: boolean }>(WAITING_BY_ROLE, [
    ago(1),
    stamp(now),
    within,
  ]);
  const routed = rows.filter((row): row is typeof row & { role: string } => row.role !== null);
  const unattended = routed.filter((row) => !row.attended);
  return {
    metric: outcomeMetric("roles_unattended", {
      value: unattended.length,
      sample: routed.length,
      window: { fromDaysAgo: 1, toDaysAgo: 0 },
      ...(routed.length === 0 ? { code: "nothing_waiting" } : {}),
      parts: Object.fromEntries(unattended.map((row) => [`role:${row.role}`, row.n])),
    }),
    waiting: rows.reduce((sum, row) => sum + row.n, 0),
  };
}
