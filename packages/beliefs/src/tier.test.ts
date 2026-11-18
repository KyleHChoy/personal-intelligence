import type { BeliefClaim } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { beliefTier, claimTier } from "./tier.ts";

const record = (over: Partial<BeliefClaim>): BeliefClaim =>
  ({
    claim: { id: "clm_1", pipelineVersion: "p", basis: "explicit" },
    origin: "agent_record",
    subjectKind: "owner",
    ...over,
  }) as unknown as BeliefClaim;

// a second agent's confirmation on an agent's claim, which the owner has not answered.
describe("an agent's confirmation", () => {
  const agent = record({ agentConfirmed: true });

  it("gives a claim its own tier, never the owner's", () => {
    expect(claimTier(agent, true)).toBe("agent_confirmed");
  });

  it("gives a belief resting on it alone that tier, and every source and the owner's word outrank it", () => {
    expect(beliefTier([agent])).toBe("agent_confirmed");
    expect(beliefTier([agent, record({ origin: "source" })])).toBe("source");
    expect(
      beliefTier([agent, record({ claim: { id: "clm_2", pipelineVersion: "p", basis: "explicit" } as never })]),
    ).toBe("owner_confirmed");
    expect(beliefTier([agent, record({ origin: "agent_research" })])).toBe("researched");
  });
});

// The owner's confirm relayed by an agent on the card: their word relayed, below their own
// confirmation and above every source, never `owner` or `owner_confirmed`.
describe("a relayed confirmation", () => {
  const relayed = record({ relayed: true });

  it("gives a claim the relayed tier, never the owner's own", () => {
    expect(claimTier(relayed, true)).toBe("owner_relayed");
    // A quoted proposal's claim, which the owner's own confirm makes `owner`, takes it too.
    const quoted = record({
      relayed: true,
      claim: { id: "clm_3", pipelineVersion: "q", basis: "explicit_self" } as never,
    });
    expect(claimTier(quoted, true)).toBe("owner_relayed");
    // A question of the owner's own about themselves, from their mail.
    expect(claimTier(record({ origin: "source", relayed: true }), true)).toBe("owner_relayed");
  });

  it("is outranked by the owner's own confirmation and outranks every source", () => {
    expect(beliefTier([relayed])).toBe("owner_relayed");
    expect(beliefTier([relayed, record({ origin: "source" })])).toBe("owner_relayed");
    expect(
      beliefTier([relayed, record({ claim: { id: "clm_2", pipelineVersion: "p", basis: "explicit" } as never })]),
    ).toBe("owner_confirmed");
  });
});
