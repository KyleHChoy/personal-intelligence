import { type Claim, ClaimId, EvidenceId, type HumanDecision, LocalEntityId } from "@intelligence/contracts";
import type { BeliefClaim, ClaimRecord, FactReclassification, FactRetirement } from "@intelligence/contracts/personal";
import {
  carriedOut,
  legacyFactKey,
  legacyKeysOf,
  reclassify,
  rulableDomain,
  rulableKind,
} from "@intelligence/personal-beliefs";
import { sha256, THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import type { ExtractDeps } from "./config.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

// Synthetic values only.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const COLLEAGUE = LocalEntityId.parse("ent_00000000000000000COLLEAGUE");
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const before = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

type Shape = {
  n: number;
  type?: string;
  fields?: Record<string, unknown>;
  factKey: string;
  legacy?: string;
  legacyAlt?: string;
  validFrom?: string;
  compartment?: string;
  generation?: number;
  assertedBy?: LocalEntityId;
  basis?: Claim["basis"];
};

// One claim about the owner, written as a commit would store it: generation 5 with its version 1
// keys beside its own when `legacy` is given.
function record(shape: Shape): ClaimRecord {
  const evidenceId = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${shape.n}-${shape.generation ?? 4}`),
    content: {
      type: shape.type ?? "situation",
      subject: OWNER_ENTITY,
      fields: shape.fields ?? { state: "moving flat", domain: "home" },
    },
    statementKind: "stated_fact",
    basis: shape.basis ?? "explicit_self",
    assertedBy: shape.assertedBy ?? OWNER_ENTITY,
    validFrom: shape.validFrom ?? before(10),
    evidence: [{ evidenceId, span: "chars:0-10" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "personal-correspondence-3",
    extractorGeneration: shape.generation ?? 4,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: shape.factKey,
    ...(shape.legacy === undefined ? {} : { legacyFactKey: shape.legacy }),
    ...(shape.legacyAlt === undefined ? {} : { legacyAltFactKey: shape.legacyAlt }),
    lane: "correspondence",
    fieldKinds: {},
    entities: [],
    origin: "source",
    answersSystem: false,
  };
}

const deps = (store: MemoryPipelineStore): ExtractDeps => ({
  store,
  model: fakeModelClient({}),
  modelId: "test/model",
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => NOW,
});
const fresh = () => memoryPipelineStore(W);
const rowOf = (store: MemoryPipelineStore, factKey: string, audience = OWN) =>
  store.beliefs(audience).find((row) => row.factKeyFp === sha256(factKey));

const beliefClaim = (shape: Shape & { carried?: string[] }): BeliefClaim => ({
  claim: record(shape).claim,
  origin: "source",
  subjectKind: "owner",
  ...(shape.carried === undefined ? {} : { carried: shape.carried }),
});
const ruling = (verdict: "domain" | "kind", value: string, compartments = OWN): FactReclassification => ({
  id: `rul-${verdict}`,
  factKeyFp: "f",
  verdict,
  value,
  at: before(1),
  compartments,
});
const covers = (audience: string[]) => (compartments: readonly string[]) =>
  compartments.every((one) => audience.includes(one));

describe("what the owner may rule", () => {
  it("a domain from the closed list on an owner-side kind; a kind among the owner-side kinds", () => {
    expect(rulableDomain("goal", "career")).toBe(true);
    expect(rulableDomain("goal", "hobbies")).toBe(false);
    expect(rulableDomain("role", "career")).toBe(false);
    expect(rulableKind("goal", "need")).toBe(true);
    expect(rulableKind("goal", "goal")).toBe(false);
    expect(rulableKind("role", "goal")).toBe(false);
    expect(rulableKind("goal", "commitment")).toBe(false);
    // A preference needs a polarity no ruling gives.
    expect(rulableKind("goal", "preference")).toBe(false);
  });
});

describe("reclassify", () => {
  it("a domain ruling sets the domain of every claim of its fact key; its ids stay", () => {
    const claims = [beliefClaim({ n: 1, factKey: "f" }), beliefClaim({ n: 2, factKey: "f" })];
    const ruled = reclassify(claims, "f", [ruling("domain", "money")], covers(OWN));
    expect(ruled.map((one) => one.claim.content.fields.domain)).toEqual(["money", "money"]);
    expect(ruled.map((one) => one.claim.id)).toEqual(claims.map((one) => one.claim.id));
  });

  it("a kind ruling moves the key phrase to the new kind's field and leaves out what the kind does not declare", () => {
    const goal = beliefClaim({
      n: 1,
      type: "goal",
      factKey: "f",
      fields: { objective: "learn to sail", domain: "interests", by: "2026-09-01" },
    });
    const [need] = reclassify([goal], "f", [ruling("kind", "situation")], covers(OWN));
    expect(need?.claim.content).toMatchObject({
      type: "situation",
      fields: { state: "learn to sail", domain: "interests" },
    });
    expect(need?.claim.content.fields.by).toBeUndefined();
    // A legacy `what` stays as it is.
    const legacy = beliefClaim({ n: 2, type: "goal", factKey: "f", fields: { what: "ship the survey" } });
    expect(reclassify([legacy], "f", [ruling("kind", "need")], covers(OWN))[0]?.claim.content).toEqual({
      type: "need",
      subject: OWNER_ENTITY,
      fields: { what: "ship the survey" },
    });
  });

  it("a ruling in a compartment the audience cannot read, of another fact key, or of a value no longer allowed changes nothing", () => {
    const claims = [beliefClaim({ n: 1, factKey: "f" })];
    expect(reclassify(claims, "f", [ruling("domain", "money", BOTH)], covers(OWN))).toEqual(claims);
    expect(reclassify(claims, "g", [ruling("domain", "money")], covers(OWN))).toEqual(claims);
    expect(reclassify(claims, "f", [ruling("domain", "hobbies")], covers(OWN))).toEqual(claims);
  });
});

describe("carriedOut: the carry's choice for each verdict", () => {
  const veto = (compartments = OWN): HumanDecision => ({
    id: "rul-veto",
    kind: "veto",
    targetKind: "belief",
    targetId: "v1",
    decidedBy: THE_OWNER,
    decidedAt: before(5),
    label: { compartments, readers: [THE_OWNER] },
  });
  const retire = (at = before(5), compartments = OWN): FactRetirement => ({
    id: "rul-retire",
    factKeyFp: "v1",
    at,
    compartments,
  });
  const go = NOW.toISOString();

  it("a carried veto leaves out a claim dated before the go, and none after it or before any go", () => {
    expect(
      carriedOut(
        beliefClaim({ n: 1, factKey: "g", carried: ["rul-veto"], validFrom: before(1) }),
        [veto()],
        [],
        go,
        covers(OWN),
      ),
    ).toBe(true);
    expect(
      carriedOut(
        beliefClaim({
          n: 1,
          factKey: "g",
          carried: ["rul-veto"],
          validFrom: new Date(NOW.getTime() + 1000).toISOString(),
        }),
        [veto()],
        [],
        go,
        covers(OWN),
      ),
    ).toBe(false);
    expect(
      carriedOut(beliefClaim({ n: 1, factKey: "g", carried: ["rul-veto"] }), [veto()], [], null, covers(OWN)),
    ).toBe(false);
  });

  it("a carried retire leaves out a claim dated at or before the retire, as the retire held it", () => {
    expect(
      carriedOut(
        beliefClaim({ n: 1, factKey: "g", carried: ["rul-retire"], validFrom: before(6) }),
        [],
        [retire()],
        go,
        covers(OWN),
      ),
    ).toBe(true);
    expect(
      carriedOut(
        beliefClaim({ n: 1, factKey: "g", carried: ["rul-retire"], validFrom: before(2) }),
        [],
        [retire()],
        go,
        covers(OWN),
      ),
    ).toBe(false);
  });

  it("a ruling not carried to the claim, or in a compartment the audience cannot read, leaves out nothing", () => {
    expect(
      carriedOut(beliefClaim({ n: 1, factKey: "g", validFrom: before(6) }), [veto()], [retire()], go, covers(OWN)),
    ).toBe(false);
    expect(
      carriedOut(
        beliefClaim({ n: 1, factKey: "g", carried: ["rul-veto", "rul-retire"], validFrom: before(6) }),
        [veto(BOTH)],
        [retire(before(5), BOTH)],
        go,
        covers(OWN),
      ),
    ).toBe(false);
  });
});

describe("legacyKeysOf", () => {
  it("a version 4 preference carries both version 1 keys; a goal carries one", () => {
    const preference = {
      type: "preference",
      subject: OWNER_ENTITY,
      fields: { object: "em dashes", polarity: "avoids", domain: "interests" },
    };
    const keys = legacyKeysOf(preference, "thread-1", OWN);
    expect(keys.legacyFactKey).toBe(legacyFactKey(preference, "thread-1", OWN));
    expect(keys.legacyAltFactKey).toBeDefined();
    expect(keys.legacyAltFactKey).not.toBe(keys.legacyFactKey);
    expect(
      legacyKeysOf(
        { type: "goal", subject: OWNER_ENTITY, fields: { objective: "learn to sail", domain: "interests" } },
        "thread-1",
        OWN,
      ).legacyAltFactKey,
    ).toBeUndefined();
  });
});

describe("the rulings through the belief build (memory store)", () => {
  it("a domain ruling moves the fact, holds at the next rebuild, and its lift restores the claim's own", async () => {
    const store = await fresh();
    store.putClaims(evidence(1), [record({ n: 1, factKey: "fact-flat" })]);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-flat")?.belief.values).toMatchObject({ domain: "home" });
    const id = store.reclassify("fact-flat", "domain", "money", OWN);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-flat")?.belief.values).toMatchObject({ domain: "money" });
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-flat")?.belief.values).toMatchObject({ domain: "money" });
    store.lift(id);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-flat")?.belief.values).toMatchObject({ domain: "home" });
  });

  it("a kind ruling builds the fact under the new kind", async () => {
    const store = await fresh();
    store.putClaims(evidence(1), [
      record({ n: 1, type: "goal", factKey: "fact-sail", fields: { objective: "learn to sail", domain: "interests" } }),
    ]);
    store.reclassify("fact-sail", "kind", "need", OWN);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-sail")?.belief).toMatchObject({
      kind: "need",
      type: "need",
      values: { domain: "interests" },
    });
  });

  it("invariant 6: a domain ruling whose compartments an audience does not hold changes nothing it sees", async () => {
    const store = await fresh();
    store.putClaims(evidence(1), [record({ n: 1, factKey: "fact-flat" })]);
    await rebuildBeliefs(deps(store));
    const seen = structuredClone(rowOf(store, "fact-flat", OWN));
    store.reclassify("fact-flat", "domain", "money", BOTH);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-flat", OWN)).toEqual(seen);
    // The control: the audience that holds both sees the ruling.
    expect(rowOf(store, "fact-flat", BOTH)?.belief.values).toMatchObject({ domain: "money" });
  });

  it("a version 1 retire of a two-situation belief from one message closes neither of them again, and not a situation of another message under the same coarse key", async () => {
    const store = await fresh();
    // Version 1: one message's two situations share the coarse key of every situation of the owner.
    store.putClaims(evidence(1), [
      record({ n: 1, factKey: "v1-situations", fields: { what: "moving flat and changing jobs" } }),
    ]);
    store.retireFact("v1-situations", OWN, before(3) as never);
    // The go: message 1 re-extracted as two atomic situations, and message 2's situation, every
    // one under the same version 1 key, dated before the retire.
    store.putClaims(evidence(1), [
      record({ n: 1, generation: 5, factKey: "v2-flat", legacy: "v1-situations", validFrom: before(10) }),
      record({
        n: 11,
        generation: 5,
        factKey: "v2-jobs",
        legacy: "v1-situations",
        validFrom: before(10),
        fields: { state: "changing jobs", domain: "career" },
      }),
    ]);
    store.putClaims(evidence(2), [
      record({
        n: 2,
        generation: 5,
        factKey: "v2-visa",
        legacy: "v1-situations",
        validFrom: before(10),
        fields: { state: "renewing visa", domain: "travel" },
      }),
    ]);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "v2-flat")).toBeUndefined();
    expect(rowOf(store, "v2-jobs")).toBeUndefined();
    expect(rowOf(store, "v2-visa")?.belief.status).toBe("active");
  });

  it("a version 1 `likes` veto still binds the re-extracted `prefers` fact, and nothing stated after the go", async () => {
    const store = await fresh();
    store.putClaims(evidence(1), [
      record({ n: 1, type: "preference", factKey: "v1-likes-tea", fields: { what: "green tea", polarity: "likes" } }),
    ]);
    store.vetoFact("v1-likes-tea", OWN, before(5) as never);
    const fields = { object: "green tea", polarity: "prefers", domain: "interests" };
    // The re-extraction: its own word's version 1 key is `prefers`', the other `likes`'.
    store.putClaims(evidence(1), [
      record({
        n: 1,
        generation: 5,
        type: "preference",
        factKey: "v2-tea",
        legacy: "v1-prefers-tea",
        legacyAlt: "v1-likes-tea",
        validFrom: before(9),
        fields,
      }),
    ]);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "v2-tea")).toBeUndefined();
    // Stated again under key version 2, from the same message's item: it counts.
    store.putClaims(evidence(1), [
      record({
        n: 12,
        generation: 5,
        type: "preference",
        factKey: "v2-tea",
        legacy: "v1-prefers-tea",
        legacyAlt: "v1-likes-tea",
        validFrom: new Date(NOW.getTime() + 1000).toISOString(),
        fields,
      }),
    ]);
    await rebuildBeliefs({ ...deps(store), now: () => new Date(NOW.getTime() + 60_000) });
    expect(rowOf(store, "v2-tea")?.belief.support).toEqual(["claim-12-5"]);
  });

  it("a version 1 reject holds for its item's re-extracted claims by either version 1 key", async () => {
    const store = await fresh();
    store.putClaims(evidence(1), [
      record({ n: 1, type: "preference", factKey: "v1-likes-tea", fields: { what: "green tea", polarity: "likes" } }),
    ]);
    store.reject("claim-1-4");
    store.putClaims(evidence(1), [
      record({
        n: 1,
        generation: 5,
        type: "preference",
        factKey: "v2-tea",
        legacy: "v1-prefers-tea",
        legacyAlt: "v1-likes-tea",
        fields: { object: "green tea", polarity: "prefers", domain: "interests" },
      }),
    ]);
    store.putClaims(evidence(2), [
      record({
        n: 2,
        generation: 5,
        type: "preference",
        factKey: "v2-tea",
        legacy: "v1-prefers-tea",
        legacyAlt: "v1-likes-tea",
        fields: { object: "green tea", polarity: "prefers", domain: "interests" },
      }),
    ]);
    await rebuildBeliefs(deps(store));
    // Message 2's claim is no claim the reject named.
    expect(rowOf(store, "v2-tea")?.belief.support).toEqual(["claim-2-5"]);
  });

  it("the belief's tier is written, and the owner's own title stands over a colleague's later one", async () => {
    const store = await fresh();
    const role = (n: number, title: string, by: LocalEntityId, validFrom: string): ClaimRecord => ({
      ...record({
        n,
        type: "role",
        factKey: "fact-role",
        fields: { title, organization_name: "Example Works" },
        assertedBy: by,
        basis: by === OWNER_ENTITY ? "explicit_self" : "third_party",
        validFrom,
      }),
    });
    store.putClaims(evidence(1), [role(1, "CTO", OWNER_ENTITY, before(10))]);
    store.putClaims(evidence(2), [role(2, "VP", COLLEAGUE, before(5))]);
    await rebuildBeliefs(deps(store));
    const row = rowOf(store, "fact-role");
    expect(row?.tier).toBe("owner");
    // The later, lower-tier claim neither supersedes nor disputes the owner's word: the owner's claim is
    // the answer, alone in the support.
    expect(row?.belief.disputed).toBe(false);
    expect(row?.belief.support).toEqual(["claim-1-4"]);
  });

  it("a later claim a higher tier outranks does not reopen a fact the owner retired", async () => {
    const store = await fresh();
    const role = (n: number, title: string, by: LocalEntityId, validFrom: string): ClaimRecord =>
      record({
        n,
        type: "role",
        factKey: "fact-role",
        fields: { title, organization_name: "Example Works" },
        assertedBy: by,
        basis: by === OWNER_ENTITY ? "explicit_self" : "third_party",
        validFrom,
      });
    store.putClaims(evidence(1), [role(1, "CTO", OWNER_ENTITY, before(10))]);
    store.retireFact("fact-role", OWN, before(5) as never);
    // A colleague's later word, which the owner's outranks: it is no restatement of the fact.
    store.putClaims(evidence(2), [role(2, "VP", COLLEAGUE, before(2))]);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-role")?.belief.status).toBe("closed");
    // The control: the owner stating it again reopens it.
    store.putClaims(evidence(3), [role(3, "CTO", OWNER_ENTITY, before(1))]);
    await rebuildBeliefs(deps(store));
    expect(rowOf(store, "fact-role")?.belief.status).not.toBe("closed");
  });
});
