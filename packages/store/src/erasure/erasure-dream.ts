import { countOf, type ErasureHook, removes } from "./erasure-hook.ts";

// A conflict the dream pass filed, and an agent's settlement of it, each name two
// claims by key; an erasure that takes either claim takes them (invariant 10). A settlement goes with
// its finding too.
const findingRows = removes(
  "dream_findings",
  [
    {
      table: "ledger.belief_settlements",
      where: "a_key = any ($1::text[]) or b_key = any ($1::text[])",
      values: (erased) => [erased.claimKeys],
    },
    {
      table: "ledger.dream_findings",
      where: "a_key = any ($1::text[]) or b_key = any ($1::text[])",
      values: (erased) => [erased.claimKeys],
    },
  ],
  (erased) => erased.claimKeys.length > 0,
);

// A dream merge that rested on an erased claim is lifted as a deletion's lift, and its candidate goes,
// before the findings and settlements naming the claim are removed.
export const dreamFindingsErasure: ErasureHook = {
  name: "dream_findings",
  async run(query, erased, options) {
    if (erased.claimKeys.length === 0) return 0;
    const merges = options.dryRun
      ? await countOf(query, "select ledger.count_dream_merges('{}'::text[], '{}'::text[], $1::text[]) as n", [
          erased.claimKeys,
        ])
      : await countOf(query, "select ledger.forget_dream_merges('{}'::text[], '{}'::text[], $1::text[]) as n", [
          erased.claimKeys,
        ]);
    return merges + (await findingRows.run(query, erased, options));
  },
};
