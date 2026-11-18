import type { Claim } from "@intelligence/contracts";
import { type BeliefClaim, type BeliefTier, ClaimTier, claimTierOf } from "@intelligence/contracts/personal";

// A claim's provenance tier and a belief's, pure. Claim rows are immutable and whether the owner
// said a claim is the store's speaker resolution at read, so a tier is computed at every rebuild
// from what the store gives and stored on the belief alone. Nothing here reads a model's words, and
// no client argument reaches it.

// The rank of each tier: the first ranks highest.
const RANK: ReadonlyMap<ClaimTier, number> = new Map(ClaimTier.options.map((tier, index) => [tier, index]));
export const ranksAbove = (a: ClaimTier, b: ClaimTier): boolean => (RANK.get(a) as number) < (RANK.get(b) as number);

// One claim's tier. `given` says the store gave it to the belief build (pipeline.ts beliefClaims),
// which it does for an agent record's claim only once the owner confirmed it on its card or it
// answers the owner's own question; a source's confirmation is its `ownerConfirmed`.
export function claimTier(record: BeliefClaim, given: boolean): ClaimTier {
  const { claim, origin } = record;
  return claimTierOf({
    origin,
    pipelineVersion: claim.pipelineVersion,
    basis: claim.basis,
    ownerSaid: record.ownerSaid === true,
    ownLine: record.ownLine === true,
    confirmed: origin === "agent_record" ? given : record.ownerConfirmed === true,
    // A second agent's confirmation on the card, which the store gives only while the
    // owner has not answered or reopened it.
    agentConfirmed: record.agentConfirmed === true,
    // The owner's confirm relayed by an agent, which the store gives only while the owner has not
    // answered or reopened the card themselves.
    relayed: record.relayed === true,
    // A system notice's, by its record's lane, as the store marks it.
    notice: record.notice === true,
    // A released claim the owner's standing release made, never their own word.
    granted: record.granted === true,
  });
}

// A belief's tier: its best supporting claim's, over the claims one audience's rule kept, every one
// of which the store gave. An agent's unconfirmed claim never reaches a belief, so the floor is
// `source`. A belief whose every kept claim is researched is `researched`. One whose every kept
// claim ranks below a source (researched or agent_confirmed) takes the best of them.
const BELOW_SOURCE: ReadonlySet<ClaimTier> = new Set(["researched", "agent_confirmed"]);
export function beliefTier(kept: readonly BeliefClaim[]): BeliefTier {
  const tiers = kept.map((one) => claimTier(one, true));
  if (tiers.length > 0 && tiers.every((tier) => BELOW_SOURCE.has(tier)))
    return tiers.includes("researched") ? "researched" : "agent_confirmed";
  let best: BeliefTier = "source";
  for (const tier of tiers) {
    // An agent's close ranks below every source, so it never raises a belief's tier.
    if (tier !== "agent_inferred" && tier !== "agent_closed" && ranksAbove(tier, best)) best = tier;
  }
  return best;
}

export function ownerSideTiers(kept: readonly BeliefClaim[]): ((claim: Claim) => ClaimTier) | undefined {
  if (kept.length === 0 || kept.some((one) => one.subjectKind !== "owner")) return undefined;
  const tiers = new Map(kept.map((one) => [one.claim.id as string, claimTier(one, true)]));
  return (claim) => tiers.get(claim.id) ?? "source";
}
