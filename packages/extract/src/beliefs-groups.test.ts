import { type Claim, ClaimId, EvidenceId, LocalEntityId } from "@intelligence/contracts";
import type { ClaimRecord, FactGrouping, FactRuling, GroupingMode } from "@intelligence/contracts/personal";
import { groupOf } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { sha256 } from "./call-failure.ts";
import type { ExtractDeps } from "./config.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

// The store gives the rulings as `beliefDecisions` would; the store's database tests read them from
// Postgres.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const [STOVE, LAMP, ROTA] = ["fact-stove", "fact-lamp", "fact-rota"].map(sha256) as [string, string, string];

type Shape = {
  n: number;
  factKey: string;
  compartment?: string;
  validFrom?: string;
  ownerSaid?: boolean;
  domain?: string;
};

// One commitment of Nora's to the owner, written by hand as a commit would store it.
function record(shape: Shape): ClaimRecord {
  const evidenceId = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${shape.n}`),
    content: {
      type: "commitment",
      subject: NORA,
      fields: {
        counterparty: OWNER_ENTITY,
        what: "I will return the stove.",
        ...(shape.domain === undefined ? {} : { domain: shape.domain }),
      },
    },
    statementKind: "stated_fact",
    basis: "explicit_self",
    assertedBy: NORA,
    validFrom: shape.validFrom ?? `2026-05-0${shape.n}T10:00:00.000Z`,
    evidence: [{ evidenceId, span: "chars:0-24" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: "person",
    disclosure: ["third_party"],
    factKey: shape.factKey,
    lane: "correspondence",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: [NORA],
    origin: "source",
    answersSystem: false,
  };
}
const put = (store: MemoryPipelineStore, ...shapes: Shape[]): void => {
  for (const shape of shapes) store.putClaims(evidence(shape.n), [record(shape)]);
};

const pair = (verdict: FactRuling["verdict"], x: string, y: string, compartments = ["own"]): FactRuling => {
  const [a, b] = x < y ? [x, y] : [y, x];
  return {
    id: `rul_${verdict}_${a.slice(0, 4)}_${b.slice(0, 4)}`,
    verdict,
    a,
    b,
    at: "2026-05-20T10:00:00.000Z",
    compartments,
  };
};
const accepted = (x: string, y: string): FactGrouping => ({
  audience: ["own"],
  keys: (x < y ? [x, y] : [y, x]) as [string, string],
  band: "accept",
  rung: 1,
  state: "accepted",
  calls: [],
});

// The store with the joins, splits and grouping rows given, as beliefDecisions reads them.
const deps = (
  store: MemoryPipelineStore,
  given: { rulings?: FactRuling[]; groupings?: FactGrouping[]; mode?: GroupingMode } = {},
): ExtractDeps => ({
  store: {
    ...store,
    beliefDecisions: async () => ({
      ...(await store.beliefDecisions()),
      factRulings: given.rulings ?? [],
      groupings: given.groupings ?? [],
      groupingMode: given.mode ?? "shadow",
    }),
  },
  model: fakeModelClient({}),
  modelId: "test/model",
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => NOW,
});
const fresh = () => memoryPipelineStore(W);

describe("the belief build with joined facts", () => {
  it("a join builds one belief under the earliest claim's fact key, with its group and members", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp" });
    await rebuildBeliefs(deps(store));
    expect(
      store
        .beliefs(OWN)
        .map((row) => row.factKeyFp)
        .sort(),
    ).toEqual([STOVE, LAMP].sort());
    expect(store.beliefs(OWN).every((row) => row.group === undefined && row.members === undefined)).toBe(true);

    const summary = await rebuildBeliefs(deps(store, { rulings: [pair("join", STOVE, LAMP)] }));
    const [one, ...rest] = store.beliefs(OWN);
    expect(rest).toEqual([]);
    expect(one).toMatchObject({
      factKeyFp: STOVE,
      group: groupOf([STOVE, LAMP]),
      members: [STOVE, LAMP].sort(),
      phraseClaim: "claim-2",
    });
    expect(one?.belief.support).toEqual(["claim-1", "claim-2"]);
    expect(summary).toMatchObject({ refused: 0, mixed: 0, failed: 0 });
  });

  it("every belief takes its phrase from its highest tier claim, then its newest", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-stove" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)[0]?.phraseClaim).toBe("claim-2");
  });

  it("a split undoes an applied grouping at the next rebuild (invariant 11)", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp" });
    await rebuildBeliefs(deps(store, { groupings: [accepted(STOVE, LAMP)], mode: "apply" }));
    expect(store.beliefs(OWN)).toHaveLength(1);
    // In shadow, the same row groups nothing.
    await rebuildBeliefs(deps(store, { groupings: [accepted(STOVE, LAMP)], mode: "shadow" }));
    expect(store.beliefs(OWN)).toHaveLength(2);
    await rebuildBeliefs(
      deps(store, { rulings: [pair("split", STOVE, LAMP)], groupings: [accepted(STOVE, LAMP)], mode: "apply" }),
    );
    expect(store.beliefs(OWN)).toHaveLength(2);
    expect(store.beliefs(OWN).every((row) => row.group === undefined)).toBe(true);
  });

  it("a veto of any member closes the joined belief; a retire too", async () => {
    const vetoed = await fresh();
    put(vetoed, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp" });
    vetoed.vetoFact("fact-lamp", OWN);
    await rebuildBeliefs(deps(vetoed, { rulings: [pair("join", STOVE, LAMP)] }));
    expect(vetoed.beliefs(OWN).map((row) => [row.factKeyFp, row.belief.status])).toEqual([[STOVE, "closed"]]);

    const retired = await fresh();
    put(retired, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp" });
    retired.retireFact("fact-lamp", OWN, "2026-05-10T10:00:00.000Z");
    await rebuildBeliefs(deps(retired, { rulings: [pair("join", STOVE, LAMP)] }));
    expect(retired.beliefs(OWN).map((row) => [row.factKeyFp, row.belief.status])).toEqual([[STOVE, "closed"]]);
  });

  it("a join across labels keeps one belief a label, each carrying only its own label's keys", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp", compartment: "employer:example" });
    const join = pair("join", STOVE, LAMP, BOTH);
    const summary = await rebuildBeliefs(deps(store, { rulings: [join] }));
    const both = store.beliefs(BOTH);
    expect(both.map((row) => [row.factKeyFp, row.compartments, row.group, row.members])).toEqual(
      [
        [STOVE, ["own"], undefined, undefined],
        [LAMP, ["employer:example"], undefined, undefined],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    expect(summary.mixed).toBe(0);
    // The audience that sees `own` alone sees one key and no join.
    expect(store.beliefs(OWN).map((row) => [row.factKeyFp, row.group])).toEqual([[STOVE, undefined]]);
  });

  it("invariant 4: a joined row labelled `own` carries no employer key, group or veto", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, factKey: "fact-stove" },
      { n: 2, factKey: "fact-lamp" },
      { n: 3, factKey: "fact-rota", compartment: "employer:example" },
    );
    store.vetoFact("fact-rota", ["employer:example"]);
    await rebuildBeliefs(deps(store, { rulings: [pair("join", STOVE, LAMP), pair("join", LAMP, ROTA, BOTH)] }));
    const [ownRow, ...others] = store.beliefs(BOTH).filter((row) => row.compartments.join() === "own");
    expect(others).toEqual([]);
    expect(ownRow).toMatchObject({ factKeyFp: STOVE, group: groupOf([STOVE, LAMP]), members: [STOVE, LAMP].sort() });
    expect(ownRow?.belief.status).not.toBe("closed");
    // The same row as the audience of `own` alone builds, which reads no employer ruling.
    const seen = (row: typeof ownRow) =>
      row && {
        factKeyFp: row.factKeyFp,
        compartments: row.compartments,
        group: row.group,
        members: row.members,
        phraseClaim: row.phraseClaim,
        status: row.belief.status,
        support: row.belief.support,
      };
    expect(seen(ownRow)).toEqual(seen(store.beliefs(OWN)[0]));
    // The employer's part holds its own key alone, closed by its veto.
    expect(
      store
        .beliefs(BOTH)
        .filter((row) => row.compartments.join() !== "own")
        .map((row) => [row.factKeyFp, row.group, row.belief.status]),
    ).toEqual([[ROTA, undefined, "closed"]]);
  });

  it("invariant 4: keys of one label joined only through an employer key stay apart in that label", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, factKey: "fact-stove" },
      { n: 2, factKey: "fact-lamp" },
      { n: 3, factKey: "fact-rota", compartment: "employer:example" },
    );
    await rebuildBeliefs(deps(store, { rulings: [pair("join", STOVE, ROTA, BOTH), pair("join", ROTA, LAMP, BOTH)] }));
    const own = store.beliefs(BOTH).filter((row) => row.compartments.join() === "own");
    expect(own.map((row) => [row.factKeyFp, row.group, row.members, row.belief.support])).toEqual(
      store.beliefs(OWN).map((row) => [row.factKeyFp, row.group, row.members, row.belief.support]),
    );
    expect(own.map((row) => [row.factKeyFp, row.group]).sort()).toEqual(
      [
        [STOVE, undefined],
        [LAMP, undefined],
      ].sort(),
    );
  });

  it("keys no longer of one domain are not joined, and counted", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-stove", domain: "home" }, { n: 2, factKey: "fact-lamp", domain: "work" });
    const summary = await rebuildBeliefs(deps(store, { rulings: [pair("join", STOVE, LAMP)] }));
    expect(
      store
        .beliefs(OWN)
        .map((row) => [row.factKeyFp, row.group])
        .sort(),
    ).toEqual(
      [
        [STOVE, undefined],
        [LAMP, undefined],
      ].sort(),
    );
    expect(summary.refused).toBeGreaterThan(0);
  });

  it("invariant 6: a join in a compartment the audience cannot read changes none of its beliefs", async () => {
    const alone = await fresh();
    put(alone, { n: 1, factKey: "fact-stove" }, { n: 2, factKey: "fact-lamp" });
    await rebuildBeliefs(deps(alone));
    const hidden = await fresh();
    put(
      hidden,
      { n: 1, factKey: "fact-stove" },
      { n: 2, factKey: "fact-lamp" },
      { n: 3, factKey: "fact-rota", compartment: "employer:example" },
    );
    await rebuildBeliefs(deps(hidden, { rulings: [pair("join", STOVE, LAMP, BOTH), pair("join", LAMP, ROTA, BOTH)] }));
    expect(hidden.beliefs(OWN)).toEqual(alone.beliefs(OWN));
  });

  it("a set past the cut, or of keys no longer one kind and subject, is not joined, and counted", async () => {
    const store = await fresh();
    const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
    put(store, ...keys.map((factKey, i) => ({ n: i + 1, factKey })));
    const [head, ...others] = keys.map(sha256) as [string, ...string[]];
    const summary = await rebuildBeliefs(deps(store, { rulings: others.map((key) => pair("join", head, key)) }));
    expect(store.beliefs(OWN)).toHaveLength(6);
    // Once for each audience that holds the six.
    expect(summary.refused).toBe(2);
  });
});
