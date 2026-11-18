import { createHash } from "node:crypto";
import {
  type BasisType,
  type Claim,
  ClaimId,
  EvidenceId,
  LocalEntityId,
  type StatementKind,
} from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import type { ExtractDeps } from "./config.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
// The fake store groups claims by this fingerprint of their fact key.
const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Shape = {
  n: number;
  compartment?: string;
  what?: string;
  basis?: BasisType;
  kind?: StatementKind;
  validFrom?: string;
  subject?: LocalEntityId;
  systemOriginated?: boolean;
  factKey?: string;
};

// One commitment claim record, written by hand as a commit would store it.
function record(shape: Shape): ClaimRecord {
  const evidenceId = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${shape.n}`),
    content: {
      type: "commitment",
      subject: shape.subject ?? NORA,
      fields: { counterparty: OWNER_ENTITY, what: shape.what ?? "I will return the stove." },
    },
    statementKind: shape.kind ?? "stated_fact",
    basis: shape.basis ?? "explicit_self",
    assertedBy: shape.subject ?? NORA,
    validFrom: shape.validFrom ?? "2026-05-01T10:00:00.000Z",
    evidence: [{ evidenceId, span: "chars:0-24" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: shape.systemOriginated ?? false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: "person",
    disclosure: ["third_party"],
    factKey: shape.factKey ?? "fact-stove",
    lane: "correspondence",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: [NORA],
    origin: shape.systemOriginated === true ? "agent_record" : "source",
    answersSystem: false,
  };
}

const put = (store: MemoryPipelineStore, ...shapes: Shape[]): void => {
  for (const shape of shapes) store.putClaims(evidence(shape.n), [record(shape)]);
};

const deps = (store: MemoryPipelineStore): ExtractDeps => ({
  store,
  model: fakeModelClient({}),
  modelId: "test/model",
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => NOW,
});

// A fresh store holding no claim of the world's, so each test sees only what it writes.
const fresh = () => memoryPipelineStore(W);

describe("rebuildBeliefs", () => {
  it("a belief is built from visible claims only", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, compartment: "own" },
      { n: 2, compartment: "employer:example", validFrom: "2026-05-02T10:00:00.000Z" },
    );
    const summary = await rebuildBeliefs(deps(store));
    const [own] = store.beliefs(OWN);
    expect(store.beliefs(OWN)).toHaveLength(1);
    expect(own?.belief.support).toEqual(["claim-1"]);
    expect(own?.compartments).toEqual(["own"]);
    // The audience that sees both compartments sees two compartment sets: nothing, and mixed.
    expect(store.beliefs(BOTH)).toEqual([]);
    expect(summary).toMatchObject({ beliefs: 1, mixed: 1, failed: 0 });
  });

  it("a hidden claim changes no visible belief", async () => {
    const alone = await fresh();
    put(alone, { n: 1 });
    await rebuildBeliefs(deps(alone));
    const beside = await fresh();
    put(
      beside,
      { n: 1 },
      { n: 2, compartment: "employer:example", kind: "reversal", validFrom: "2026-05-03T10:00:00.000Z" },
    );
    await rebuildBeliefs(deps(beside));
    expect(beside.beliefs(OWN)).toEqual(alone.beliefs(OWN));
  });

  it("two claims of one fact whose one-word text values differ build one belief", async () => {
    const store = await fresh();
    put(store, { n: 1, what: "Done" }, { n: 2, what: "Yes", validFrom: "2026-05-02T10:00:00.000Z" });
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toHaveLength(1);
    expect(store.beliefs(OWN)[0]?.belief.support).toEqual(["claim-1", "claim-2"]);
    expect(summary.failed).toBe(0);
  });

  it("a fact key that throws is counted, and the others are built", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    const broken = record({ n: 2, factKey: "fact-broken" });
    // Fields the builder cannot read make buildBelief throw.
    (broken.claim.content as { fields: unknown }).fields = null;
    store.putClaims(evidence(2), [broken]);
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toHaveLength(1);
    expect(store.beliefs(OWN)[0]?.belief.support).toEqual(["claim-1"]);
    // Once for each audience that can see it.
    expect(summary.failed).toBe(2);
  });

  it("a reversal by its own subject closes the commitment", async () => {
    const store = await fresh();
    put(store, { n: 1 }, { n: 2, kind: "reversal", validFrom: "2026-05-02T10:00:00.000Z" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("closed");
    // Its end, not a dispute.
    expect(store.beliefs(OWN)[0]?.belief.disputed).toBe(false);
  });

  it("a third party's report builds no belief and changes none", async () => {
    const report = await fresh();
    put(report, { n: 1, basis: "third_party" });
    await rebuildBeliefs(deps(report));
    expect(report.beliefs(OWN)).toEqual([]);

    const alone = await fresh();
    put(alone, { n: 1 });
    await rebuildBeliefs(deps(alone));
    const reversed = await fresh();
    put(reversed, { n: 1 }, { n: 2, basis: "third_party", kind: "reversal", validFrom: "2026-05-02T10:00:00.000Z" });
    await rebuildBeliefs(deps(reversed));
    expect(reversed.beliefs(OWN)).toEqual(alone.beliefs(OWN));
    expect(reversed.beliefs(OWN)[0]?.belief.status).toBe("active");
  });

  it("claims of two compartment sets build nothing for the audience that sees both, and the audience that sees one keeps its belief", async () => {
    const store = await fresh();
    put(store, { n: 1, compartment: "own" }, { n: 2, compartment: "employer:example" });
    store.setAudiences([OWN, ["employer:example"], BOTH]);
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).map((row) => row.belief.support)).toEqual([["claim-1"]]);
    expect(store.beliefs(["employer:example"]).map((row) => row.belief.support)).toEqual([["claim-2"]]);
    expect(store.beliefs(BOTH)).toEqual([]);
    expect(summary.mixed).toBe(1);
  });

  it("an agent-reported claim builds no belief, closes none and makes no fact key mixed", async () => {
    const agent = await fresh();
    put(agent, { n: 1, systemOriginated: true });
    await rebuildBeliefs(deps(agent));
    expect(agent.beliefs(OWN)).toEqual([]);

    const alone = await fresh();
    put(alone, { n: 1 });
    await rebuildBeliefs(deps(alone));
    const store = await fresh();
    put(
      store,
      { n: 1 },
      { n: 2, kind: "reversal", systemOriginated: true, validFrom: "2026-05-02T10:00:00.000Z" },
      { n: 3, compartment: "employer:example", systemOriginated: true },
    );
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toEqual(alone.beliefs(OWN));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("active");
    expect(store.beliefs(BOTH).map((row) => row.belief.support)).toEqual([["claim-1"]]);
    expect(summary.mixed).toBe(0);
  });

  it("a replaceBeliefs that throws counts its audience as failed; the other audiences are written and the run's code is unchanged", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    store.failReplace(OWN);
    const summary = await rebuildBeliefs(deps(store));
    expect(summary.failed).toBe(1);
    expect(store.beliefs(OWN)).toEqual([]);
    expect(store.beliefs(BOTH)).toHaveLength(1);
  });

  it("rows of an audience no active client has are deleted by the next rebuild", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(BOTH)).toHaveLength(1);
    store.setAudiences([OWN]);
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(BOTH)).toEqual([]);
    expect(store.beliefs(OWN)).toHaveLength(1);
    expect(summary.removed).toBe(1);
  });

  it("with no active client the owner's audience is built, and pruneAudiences keeps it", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    await rebuildBeliefs(deps(store));
    store.setAudiences([]);
    const summary = await rebuildBeliefs(deps(store));
    // The owner's audience is `own`, the one compartment of the stored claims; BOTH is no one's.
    expect(store.beliefs(OWN).map((row) => row.belief.support)).toEqual([["claim-1"]]);
    expect(store.beliefs(BOTH)).toEqual([]);
    expect(summary).toMatchObject({ beliefs: 1, removed: 1, failed: 0 });
    expect(await rebuildBeliefs(deps(store))).toMatchObject({ beliefs: 1, changed: 0, removed: 0, changes: [] });
    expect(store.beliefs(OWN)).toHaveLength(1);
  });

  it("a client whose clearance equals every compartment reads the same rows as before, and the audience is built once", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, compartment: "own", factKey: "fact-own" },
      { n: 2, compartment: "employer:example", factKey: "fact-work" },
    );
    store.setAudiences([BOTH]);
    const summary = await rebuildBeliefs(deps(store));
    expect(
      store
        .beliefs(BOTH)
        .map((row) => row.belief.support)
        .sort(),
    ).toEqual([["claim-1"], ["claim-2"]]);
    // Two fact keys, one audience: two rows, each built once, each reported once.
    expect(summary).toMatchObject({ beliefs: 2, changed: 2, removed: 0 });
    expect(summary.changes.map((change) => change.audience)).toEqual([BOTH, BOTH]);
  });

  it("belief-kinds: with two clients of different clearance, the owner's audience holds each fact once", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, compartment: "own", factKey: "fact-own" },
      { n: 2, compartment: "employer:example", factKey: "fact-work" },
    );
    store.setAudiences([OWN, ["employer:example"]]);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toHaveLength(1);
    expect(store.beliefs(["employer:example"])).toHaveLength(1);
    // The owner's audience is both compartments, which no client holds: each fact once.
    const owner = store.beliefs(BOTH);
    expect(owner.map((row) => row.belief.support).sort()).toEqual([["claim-1"], ["claim-2"]]);
    expect(new Set(owner.map((row) => row.factKeyFp)).size).toBe(2);
  });

  it("when a compartment gets its first claim, the old owner's audience rows are pruned and the new ones built in one run", async () => {
    const store = await fresh();
    store.setAudiences([]);
    put(store, { n: 1, compartment: "own", factKey: "fact-own" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toHaveLength(1);
    put(store, { n: 2, compartment: "employer:example", factKey: "fact-work" });
    const summary = await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toEqual([]);
    expect(
      store
        .beliefs(BOTH)
        .map((row) => row.belief.support)
        .sort(),
    ).toEqual([["claim-1"], ["claim-2"]]);
    expect(summary).toMatchObject({ beliefs: 2, removed: 1 });
  });

  it("the owner's audience's rows are built and counted, but only a client's audience reports its changes", async () => {
    const store = await fresh();
    store.setAudiences([OWN]);
    put(store, { n: 1, compartment: "own", factKey: "fact-own" });
    const first = await rebuildBeliefs(deps(store));
    // `own` is both the client's audience and the owner's: built once, reported once.
    expect(first.changes.map((change) => change.audience)).toEqual([OWN]);
    // A first claim in another compartment moves the owner's audience: its rows are all new,
    // and none of them is reported, so a new compartment wakes nothing by itself.
    put(store, { n: 2, compartment: "employer:example", factKey: "fact-work" });
    const second = await rebuildBeliefs(deps(store));
    expect(store.beliefs(BOTH)).toHaveLength(2);
    expect(second.changes).toEqual([]);
    expect(second).toMatchObject({ beliefs: 3, changed: 2 });
  });

  it("a finding the owner has not confirmed names the owner's audience and builds nothing", async () => {
    const store = await fresh();
    store.setAudiences([]);
    put(store, { n: 1, compartment: "own", factKey: "fact-own" });
    const finding = record({ n: 2, factKey: "fact-finding" });
    store.putClaims(evidence(2), [
      {
        ...finding,
        origin: "agent_record",
        claim: { ...finding.claim, label: { compartments: ["agent:alpha", "own"], readers: [THE_OWNER] } },
      },
    ]);
    expect(await store.ownerAudience()).toEqual(["agent:alpha", "own"]);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(["agent:alpha", "own"]).map((row) => row.belief.support)).toEqual([["claim-1"]]);
  });

  it("no claim at all, no audience of the owner's and no belief", async () => {
    const store = await fresh();
    store.setAudiences([]);
    expect(await store.ownerAudience()).toEqual([]);
    expect(await rebuildBeliefs(deps(store))).toEqual({
      beliefs: 0,
      changed: 0,
      mixed: 0,
      refused: 0,
      failed: 0,
      removed: 0,
      ms: 0,
      changes: [],
    });
  });
});

// A rejected claim is left out by the store's beliefClaims; a fact veto is a decision on the belief, for the
// audiences that hold its compartments; the rulings mark makes a replace that read older rulings stale.
describe("rebuildBeliefs under the owner's rulings", () => {
  it("a rejected claim counts in no belief after the next rebuild, is in no belief's support, and the belief rests on the others", async () => {
    const store = await fresh();
    put(store, { n: 1 }, { n: 2, what: "I will return the stove on Friday.", validFrom: "2026-05-02T10:00:00.000Z" });
    await rebuildBeliefs(deps(store));
    // The positive control: before the ruling both claims are in the support.
    expect(store.beliefs(OWN)[0]?.belief.support).toEqual(["claim-1", "claim-2"]);

    store.reject("claim-2");
    await rebuildBeliefs(deps(store));
    for (const audience of [OWN, BOTH]) {
      const [row] = store.beliefs(audience);
      expect(row?.belief.support, audience.join(",")).toEqual(["claim-1"]);
      expect(row?.belief.lastConfirmedAt).toBe("2026-05-01T10:00:00.000Z");
    }
    // The claim is still stored: only the belief leaves it out.
    expect(
      store
        .claims()
        .map((record) => record.claim.id)
        .sort(),
    ).toEqual(["claim-1", "claim-2"]);
  });

  it("a fact key whose only claim is rejected has no belief", async () => {
    const store = await fresh();
    put(store, { n: 1 }, { n: 2, factKey: "fact-other" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toHaveLength(2);

    store.reject("claim-1");
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).map((row) => row.belief.support)).toEqual([["claim-2"]]);
    expect(store.beliefs(BOTH).map((row) => row.belief.support)).toEqual([["claim-2"]]);
  });

  it("a vetoed fact key's belief is closed in every audience, and a later claim of it does not reopen it", async () => {
    const store = await fresh();
    put(store, { n: 1 }, { n: 2, factKey: "fact-other" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).map((row) => row.belief.status)).toEqual(["active", "active"]);

    store.vetoFact("fact-stove", ["own"]);
    await rebuildBeliefs(deps(store));
    const stove = sha256Of("fact-stove");
    for (const audience of [OWN, BOTH]) {
      const rows = store.beliefs(audience);
      expect(rows.find((row) => row.factKeyFp === stove)?.belief.status, audience.join(",")).toBe("closed");
      // The control: the other fact key is untouched.
      expect(rows.find((row) => row.factKeyFp !== stove)?.belief.status, audience.join(",")).toBe("active");
    }

    // A later claim of the vetoed fact key, even one that restates it, leaves it closed.
    put(store, { n: 3, validFrom: "2026-05-20T10:00:00.000Z" });
    await rebuildBeliefs(deps(store));
    const [later] = store.beliefs(OWN).filter((row) => row.factKeyFp === stove);
    expect(later?.belief.support).toEqual(["claim-1", "claim-3"]);
    expect(later?.belief.status).toBe("closed");
  });

  it("a veto in force closes the belief even when its time is after the rebuild's clock", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    // The admin's clock runs ahead of the pipeline's: the ruling's time is after asOf.
    store.vetoFact("fact-stove", ["own"], "2026-06-01T12:00:05.000Z");
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("closed");
    expect(store.beliefs(BOTH)[0]?.belief.status).toBe("closed");
  });

  it("a rejection holds for a new claim of its fact key from its item", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    store.reject("claim-1");
    // The item extracted again, under another generation: a new claim id from the same item.
    const again = record({ n: 1 });
    store.putClaims(evidence(1), [{ ...again, claim: { ...again.claim, id: ClaimId.parse("claim-1-again") } }]);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toEqual([]);
    // The control: a claim of the fact key from another item counts.
    put(store, { n: 2 });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.support).toEqual(["claim-2"]);
  });

  it("a lifted veto's belief is active again after the next rebuild", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    const ruling = store.vetoFact("fact-stove", ["own"]);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("closed");

    store.lift(ruling);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("active");
    expect(store.beliefs(BOTH)[0]?.belief.status).toBe("active");
  });

  it("a ruling outside an audience's clearance changes nothing that audience reads", async () => {
    const store = await fresh();
    // One fact key with a claim under each compartment: the veto's compartments are both.
    put(
      store,
      { n: 1, compartment: "own" },
      { n: 2, compartment: "employer:example", validFrom: "2026-05-02T10:00:00.000Z" },
    );
    store.setAudiences([OWN, ["employer:example"], BOTH]);
    await rebuildBeliefs(deps(store));
    const before = store.beliefs(OWN);
    expect(before[0]?.belief.status).toBe("active");

    store.vetoFact("fact-stove", ["employer:example", "own"]);
    await rebuildBeliefs(deps(store));
    // Neither single audience holds both compartments: its row, its version and all, is as it was.
    expect(store.beliefs(OWN)).toEqual(before);
    expect(store.beliefs(["employer:example"])[0]?.belief.status).toBe("active");

    // The control: a veto within the audience closes its belief.
    store.vetoFact("fact-stove", ["own"]);
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("closed");
  });

  it("a veto that commits after the rebuild read the mark makes its replace stale, and the next run closes the belief", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    await rebuildBeliefs(deps(store));
    const before = { own: store.beliefs(OWN), both: store.beliefs(BOTH) };

    // The veto commits once the rebuild has read the rulings, before it writes.
    let vetoed = false;
    const racing: MemoryPipelineStore = Object.assign(Object.create(store) as MemoryPipelineStore, {
      beliefDecisions: async () => {
        const read = await store.beliefDecisions();
        if (!vetoed) {
          vetoed = true;
          store.vetoFact("fact-stove", ["own"]);
        }
        return read;
      },
    });
    const summary = await rebuildBeliefs(deps(racing));
    // Every audience's write was stale: nothing was written, and each is counted as failed.
    expect(summary).toMatchObject({ beliefs: 0, changed: 0, failed: 2 });
    expect({ own: store.beliefs(OWN), both: store.beliefs(BOTH) }).toEqual(before);

    const next = await rebuildBeliefs(deps(store));
    expect(next.failed).toBe(0);
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("closed");
    expect(store.beliefs(BOTH)[0]?.belief.status).toBe("closed");
  });

  it("reads the rulings before the claims, and hands their mark to every replace", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    store.vetoFact("fact-other", ["own"]);
    const order: string[] = [];
    const marks: number[] = [];
    const watched: MemoryPipelineStore = Object.assign(Object.create(store) as MemoryPipelineStore, {
      beliefDecisions: () => {
        order.push("beliefDecisions");
        return store.beliefDecisions();
      },
      beliefClaims: () => {
        order.push("beliefClaims");
        return store.beliefClaims();
      },
      replaceBeliefs: (
        audience: string[],
        rows: Parameters<MemoryPipelineStore["replaceBeliefs"]>[1],
        mark: number,
      ) => {
        marks.push(mark);
        return store.replaceBeliefs(audience, rows, mark);
      },
    });
    await rebuildBeliefs(deps(watched));
    expect(order).toEqual(["beliefDecisions", "beliefClaims"]);
    expect(marks).toEqual([1, 1]);
    // The veto of another fact key closes nothing here.
    expect(store.beliefs(OWN)[0]?.belief.status).toBe("active");
  });
});
