import { type OwnerDecisionKind, teachesOf } from "@intelligence/contracts/personal";
import { type Query, stamp } from "../../core/db.ts";
import { noCanaryIn } from "../../core/statements.ts";

// The owner's untainted decisions of the window's last `days` whole UTC days (today, still
// partial, left out), per day, by how `teachesOf` classes them (an answer by its untainted card's
// kind), and the mean per day of `plan` ones, so `lessons_every` can be set from the measured rate
// before the wake widens. `unclassed`: an answer with no card, or a kind the registry does not
// hold. Counts only.
type DecisionDay = { day: string; plan: number; ruling: number; none: number; unclassed: number };
export type DecisionRate = { byDay: DecisionDay[]; plan: number; planPerDay: number };
type DecisionCount = { day: string; kind: string; cardKind: string | null; n: number };

// `rows` in day order.
export function decisionRate(rows: readonly DecisionCount[], days: number): DecisionRate {
  const byDay = new Map<string, DecisionDay>();
  for (const row of rows) {
    const teaching = teachesOf(row.kind as OwnerDecisionKind, row.cardKind ?? undefined);
    const day = byDay.get(row.day) ?? { day: row.day, plan: 0, ruling: 0, none: 0, unclassed: 0 };
    day[teaching?.teaches ?? "unclassed"] += row.n;
    byDay.set(row.day, day);
  }
  const plan = [...byDay.values()].reduce((total, day) => total + day.plan, 0);
  return { byDay: [...byDay.values()], plan, planPerDay: Math.round((plan / days) * 100) / 100 };
}

export async function decisionRateReport(query: Query, now: Date, days: number): Promise<DecisionRate> {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(until.getTime() - days * 86_400_000);
  const rows = await query<DecisionCount>(
    `select to_char(o.decided_at at time zone 'UTC', 'YYYY-MM-DD') as day, o.kind, c.kind as "cardKind", count(*)::int as n
     from knowledge.owner_decisions o left join ledger.cards c on o.kind = 'answer' and c.id = o.card_id and c.tainted_at is null
     where o.decided_at >= $1 and o.decided_at < $2 and o.tainted_at is null and (o.details ->> 'via') is distinct from 'cleanup' and ${noCanaryIn("o.compartments")}
     group by 1, 2, 3 order by 1`,
    [stamp(from), stamp(until)],
  );
  return decisionRate(rows, days);
}
