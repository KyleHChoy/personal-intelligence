import { type Claim, ClaimId, EvidenceId, type HumanDecision, LocalEntityId } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { buildBelief, PERSONAL_ONTOLOGY } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { describe, expect, it, vi } from "vitest";
import { memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

// They live here, beside the rebuild they watch, not in the store's precondition file.

// The real builder, watched: rebuildBeliefs reaches it by import (the beliefs package's
// build-belief.ts), so the decisions it hands over are read from the calls.
vi.mock("../../beliefs/src/build-belief.ts", async (original) => {
  const built = await original<typeof import("../../beliefs/src/build-belief.ts")>();
  return { ...built, buildBelief: vi.fn(built.buildBelief) };
});

const NOW = new Date("2026-06-01T12:00:00.000Z");
const AS_OF = NOW.toISOString();
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const FACT_KEY_FP = "a".repeat(64);
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));

// A commitment Nora made about Nora, as a commit stores it.
function commitment(n: number, validFrom: string): Claim {
  const evidenceId = evidence(n);
  return {
    id: ClaimId.parse(`claim-${n}`),
    content: {
      type: "commitment",
      subject: NORA,
      fields: { counterparty: OWNER_ENTITY, what: `I will return item ${n}.` },
    },
    statementKind: "stated_fact",
    basis: "explicit_self",
    assertedBy: NORA,
    validFrom,
    evidence: [{ evidenceId, span: "chars:0-20" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: ["own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
}

const veto = (targetKind: "claim" | "belief", targetId: string): HumanDecision => ({
  id: "rul_01JABCDEFGHJKMNPQRSTVWXYZ0",
  kind: "veto",
  targetKind,
  targetId,
  decidedBy: THE_OWNER,
  decidedAt: "2026-05-20T00:00:00.000Z",
  label: { compartments: ["own"], readers: [THE_OWNER] },
});

describe("what corrections-and-digest builds on in the belief build", () => {
  it("buildBelief leaves out a claim vetoed by a decision on the claim, and closes a belief vetoed by a decision on its stored fact key", () => {
    const older = commitment(1, "2026-05-01T10:00:00.000Z");
    const newer = commitment(2, "2026-05-10T10:00:00.000Z");
    const build = (decisions: HumanDecision[]) =>
      buildBelief([older, newer], decisions, AS_OF, PERSONAL_ONTOLOGY, FACT_KEY_FP);

    // The positive control: with no decision the later claim decides, and the belief is open.
    const plain = build([]);
    expect(plain?.values).toEqual({ counterparty: OWNER_ENTITY });
    expect(plain?.lastConfirmedAt).toBe(newer.validFrom);
    expect(plain?.status).not.toBe("closed");

    // A veto on the later claim: the earlier one decides alone.
    const withoutNewer = build([veto("claim", newer.id)]);
    expect(withoutNewer?.lastConfirmedAt).toBe(older.validFrom);
    expect(withoutNewer?.status).not.toBe("closed");
    // Both vetoed: no claim counts, and there is no belief.
    expect(build([veto("claim", older.id), veto("claim", newer.id)])).toBeNull();

    // A veto on the belief, by the stored fact key the build was given: closed.
    expect(build([veto("belief", FACT_KEY_FP)])?.status).toBe("closed");
    // The control: a veto on another fact key closes nothing.
    expect(build([veto("belief", "b".repeat(64))])?.status).not.toBe("closed");
  });

  it("rebuildBeliefs passes an empty decision list today", async () => {
    const store = await memoryPipelineStore(world({ now: NOW }));
    const record = (n: number): ClaimRecord => ({
      claim: commitment(n, "2026-05-01T10:00:00.000Z"),
      subjectKind: "person",
      disclosure: ["third_party"],
      factKey: "fact-item",
      lane: "correspondence",
      fieldKinds: { counterparty: "entity", what: "text" },
      entities: [NORA],
      origin: "source",
      answersSystem: false,
    });
    store.putClaims(evidence(1), [record(1)]);
    store.putClaims(evidence(2), [record(2)]);
    const watched = vi.mocked(buildBelief);
    watched.mockClear();

    const summary = await rebuildBeliefs({ store, now: () => NOW });

    // The control: the builder was called, and wrote a belief.
    expect(summary.beliefs).toBeGreaterThan(0);
    expect(watched.mock.calls.length).toBeGreaterThan(0);
    for (const call of watched.mock.calls) expect(call[1]).toEqual([]);
  });
});
