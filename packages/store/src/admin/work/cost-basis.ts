import { CostBasis } from "@intelligence/contracts/personal";
import type { Query } from "../../core/db.ts";

// How each cost was counted, derived at read with no column of its own, one SQL expression per
// table. `assumed`: the vendor gave no cost, so a ceiling or a guess was counted. Otherwise the
// route is read from the id the client called: Anthropic's form (`claude-...`, the two Anthropic
// clients) is priced from the system's price list; any other id is OpenRouter's (`vendor/model`),
// whose cost the vendor reported. Rows written before the Anthropic clients recorded their own form
// carry the slash and count as `reported`. The keyed replay's id `replay`, at zero cost, has no
// basis and is in no part, so every total is unchanged.

export type SpendBasis = Record<CostBasis, number>;

const byForm = (row: string): string =>
  `case when ${row}.model_id = 'replay' then null when ${row}.model_id like 'claude-%' then 'price_list' else 'reported' end`;

// A vault.model_usage row: a call that timed out or answered with no cost was counted at the
// assumed call cost. A check call's row is written with the outcome `check` whatever its cost, so
// a check priced at an assumed cost reads from its id: a rare undercount of `assumed`, as a
// truncated step's below.
export const usageBasis = (row: string): string =>
  `case when ${row}.outcome in ('cost_missing', 'timed_out') then 'assumed' else ${byForm(row)} end`;

// A ledger.run_steps model call: cost_missing was priced at the ceiling. A truncated call keeps its
// code whatever its cost, so it is read from its id, a rare undercount of `assumed`.
const stepBasis = (row: string): string =>
  `case when ${row}.code = 'cost_missing' then 'assumed' else ${byForm(row)} end`;

// Rows of (basis, micro-dollars) as the split; a row with no basis is in no part.
export function spendBasis(rows: readonly { basis: string | null; micro: string | null }[]): SpendBasis {
  const split: SpendBasis = { reported: 0, price_list: 0, assumed: 0 };
  for (const row of rows) {
    const basis = CostBasis.safeParse(row.basis);
    if (basis.success) split[basis.data] += Number(row.micro ?? 0);
  }
  return split;
}

// The UTC day's model calls of runs, by basis, summing to the run steps' part of ledger.spend_on.
export async function stepSpendBasis(query: Query, day: string): Promise<{ spent: SpendBasis }> {
  const rows = await query<{ basis: string | null; micro: string | null }>(
    `select ${stepBasis("s")} as basis, sum(s.cost_microusd)::text as micro
     from ledger.run_steps s
     where s.kind = 'model_call' and s.created_at >= ($1::date::timestamp at time zone 'UTC') and s.created_at < (($1::date + 1)::timestamp at time zone 'UTC')
     group by 1`,
    [day],
  );
  return { spent: spendBasis(rows) };
}
