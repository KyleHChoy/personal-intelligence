import { z } from "zod";
import { IdentityBasis, IdentityException, PolicyMergeRefusal } from "./owner.ts";

// `pia work report`'s `settled` block, counts within the report's
// window and never ids. Per card kind, the claims code raised no card for (by the answer that
// settled them, or `waiting` on an open card), the duplicates withdrawn when the owner answered, and the
// settlements the owner reopened; and the identity sweep's merges by basis and the same-person cards
// raised. The sweep's own counts (SweepSettledCounts) carry the pairs it carded by exception and
// the merges ledger.policy_merge refused, by code: no table holds those, so they are the sweep's
// log line and return, and the dry run's.
const tally = z.number().int().nonnegative();
const tallies = <T extends string>(codes: readonly T[]) =>
  z.strictObject(Object.fromEntries(codes.map((code) => [code, tally])) as Record<T, typeof tally>);
export const SettledFactCounts = z.strictObject({
  confirmed: tally,
  rejected: tally,
  vetoed: tally,
  waiting: tally,
  withdrawn: tally,
  reopened: tally,
});
export type SettledFactCounts = z.infer<typeof SettledFactCounts>;
export const SettledReport = z.strictObject({
  facts: z.strictObject({ about_you: SettledFactCounts, agent_claim: SettledFactCounts }),
  identity: z.strictObject({ merged: tallies(IdentityBasis.options), carded: tally }),
});
export type SettledReport = z.infer<typeof SettledReport>;
export const SweepSettledCounts = z.strictObject({
  merged: tally,
  carded: tallies(IdentityException.options),
  refused: tallies(PolicyMergeRefusal.options),
});
export type SweepSettledCounts = z.infer<typeof SweepSettledCounts>;
