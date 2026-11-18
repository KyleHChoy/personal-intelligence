import { type Claim, ClaimId, EvidenceId, LocalEntityId, type Timestamp } from "@intelligence/contracts";
import type {
  BeliefRecord,
  BeliefRelation,
  ClaimRecord,
  FactRuling,
  SubjectKind,
} from "@intelligence/contracts/personal";
import { type BeliefInputs, beliefAt, beliefsFor } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { sha256 } from "./call-failure.ts";
import type { ExtractDeps } from "./config.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

// `beliefsFor`, the rebuild's per-audience body in personal-beliefs, gives the rows the rebuild
// writes for every audience; `beliefAt` computes them for one clearance as of the time it is given,
// with rulings applied at once. Synthetic entities and reserved compartments only.

const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];
const DAY = 86_400_000;
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const THEO = LocalEntityId.parse("ent_0000000000000000000000THEO");
const ALDER = LocalEntityId.parse("ent_000000000000000000000ALDER");
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const day = (n: number) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + n * DAY).toISOString();

type Shape = {
  n: number;
  type: string;
  fields: Record<string, unknown>;
  subject?: LocalEntityId;
  subjectKind?: SubjectKind;
  by?: LocalEntityId;
  at?: string;
  compartment?: string;
  factKey: string;
};

function record(shape: Shape): ClaimRecord {
  const subject = shape.subject ?? NORA;
  const by = shape.by ?? subject;
  const evidenceId = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${String(shape.n).padStart(3, "0")}`),
    content: { type: shape.type, subject, fields: shape.fields },
    statementKind: "stated_fact",
    basis: by === subject ? "explicit_self" : "third_party",
    assertedBy: by,
    validFrom: shape.at ?? day(0),
    evidence: [{ evidenceId, span: "chars:0-24" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 2,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: shape.subjectKind ?? (subject === OWNER_ENTITY ? "owner" : "person"),
    disclosure: ["third_party"],
    factKey: shape.factKey,
    lane: "correspondence",
    fieldKinds: {},
    entities: [],
    origin: "source",
    answersSystem: false,
  };
}

const ROLE = { title: "Head of Finance", organization: ALDER };
const OTHER_ROLE = { title: "Chief of Staff", organization: ALDER };
const STOVE = { counterparty: OWNER_ENTITY, what: "I will return the stove." };

// A world of several kinds, two compartments, a dispute, a join and a momentary situation.
const SHAPES: Shape[] = [
  { n: 1, type: "role", fields: ROLE, factKey: "fact-role-nora", at: day(1) },
  { n: 2, type: "role", fields: OTHER_ROLE, factKey: "fact-role-nora", at: day(2), by: THEO },
  { n: 3, type: "role", fields: ROLE, factKey: "fact-role-nora-work", at: day(3), compartment: "employer:example" },
  { n: 4, type: "commitment", fields: STOVE, factKey: "fact-stove", at: day(4) },
  { n: 5, type: "commitment", fields: STOVE, factKey: "fact-lamp", at: day(5) },
  {
    n: 6,
    type: "situation",
    fields: { what: "I am at the dentist today." },
    subject: OWNER_ENTITY,
    by: OWNER_ENTITY,
    factKey: "fact-leave",
    at: day(28),
  },
  {
    n: 7,
    type: "affiliation",
    fields: { relation: "employee", organization: ALDER },
    subject: THEO,
    factKey: "fact-theo-alder",
    at: day(6),
    compartment: "employer:example",
  },
  {
    n: 8,
    type: "preference",
    fields: { what: "I prefer early morning runs.", polarity: "prefers" },
    subject: OWNER_ENTITY,
    by: OWNER_ENTITY,
    factKey: "fact-runs",
    at: day(7),
  },
];
const JOIN: FactRuling = (() => {
  const [a, b] = [sha256("fact-stove"), sha256("fact-lamp")].sort() as [string, string];
  return { id: "rul_join_stove_lamp", verdict: "join", a, b, at: day(10) as Timestamp, compartments: OWN };
})();

async function seeded(): Promise<MemoryPipelineStore> {
  const store = await memoryPipelineStore(W);
  for (const shape of SHAPES) store.putClaims(evidence(shape.n), [record(shape)]);
  store.setAudiences([OWN, BOTH, WORK]);
  return store;
}

// The store with the owner's join, as beliefDecisions reads it, and each audience's rows as the
// rebuild handed them to replaceBeliefs.
function harness(store: MemoryPipelineStore, now: Date) {
  const written = new Map<string, BeliefRecord[]>();
  const decisions = async () => ({
    ...(await store.beliefDecisions()),
    factRulings: [JOIN],
    groupingMode: "shadow" as const,
  });
  const watched: MemoryPipelineStore = {
    ...store,
    beliefDecisions: decisions,
    replaceBeliefs: async (audience, rows, mark) => {
      written.set(JSON.stringify([...audience].sort()), rows);
      return store.replaceBeliefs(audience, rows, mark);
    },
  };
  const deps: ExtractDeps = {
    store: watched,
    model: fakeModelClient({}),
    modelId: "test/model",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  };
  const inputs = async (): Promise<BeliefInputs> => {
    const { mark: _mark, ...rulings } = await decisions();
    return { groups: await store.beliefClaims(), ...rulings };
  };
  return { deps, written, inputs };
}

const byKey = (rows: readonly BeliefRecord[]) => [...rows].sort((a, b) => (a.factKeyFp < b.factKeyFp ? -1 : 1));

describe("beliefsFor", () => {
  it("gives the rows rebuildBeliefs writes, for every audience of the fixtures", async () => {
    const store = await seeded();
    const { deps, written, inputs } = harness(store, NOW);
    await rebuildBeliefs(deps);
    const audiences = [...written.keys()];
    expect(audiences.length).toBe(3);
    const given = await inputs();
    for (const key of audiences) {
      const audience = JSON.parse(key) as string[];
      const rows = written.get(key) ?? [];
      expect(rows.length, key).toBeGreaterThan(0);
      expect(byKey(beliefsFor(given, audience, NOW.toISOString()).rows), key).toEqual(byKey(rows));
    }
  });

  it("counts what the rebuild counts: mixed, refused and failed", async () => {
    const store = await seeded();
    const { deps, inputs } = harness(store, NOW);
    const summary = await rebuildBeliefs(deps);
    const given = await inputs();
    const totals = (await store.audiences()).map((audience) => beliefsFor(given, audience, NOW.toISOString()));
    expect({ mixed: summary.mixed, refused: summary.refused }).toEqual({
      mixed: totals.reduce((n, one) => n + one.mixed, 0),
      refused: totals.reduce((n, one) => n + one.refused, 0),
    });
  });
});

describe("beliefAt", () => {
  it("matches the rebuild of its clearance as of the time it is given, the clock's status cases included", async () => {
    for (const at of [NOW, new Date(NOW.getTime() + 10 * DAY), new Date(NOW.getTime() + 400 * DAY)]) {
      const store = await seeded();
      const { deps, written, inputs } = harness(store, at);
      await rebuildBeliefs(deps);
      const given = await inputs();
      for (const clearance of [OWN, BOTH, WORK]) {
        const rows = written.get(JSON.stringify(clearance)) ?? [];
        const keys = rows.map((row) => row.factKeyFp);
        expect(byKey(beliefAt(given, clearance, keys, at.toISOString())), `${clearance} ${at.toISOString()}`).toEqual(
          byKey(rows),
        );
      }
    }
  });

  it("a momentary situation's status follows asOf, not a clock", async () => {
    const store = await seeded();
    const { inputs } = harness(store, NOW);
    const given = await inputs();
    const leave = sha256("fact-leave");
    const at = (iso: string) => beliefAt(given, OWN, [leave], iso).map((row) => row.belief.status);
    expect(at(NOW.toISOString())).not.toEqual(at(new Date(NOW.getTime() + 30 * DAY).toISOString()));
  });

  it("returns only the keys asked, and a joined row when one of its members is asked", async () => {
    const store = await seeded();
    const { inputs } = harness(store, NOW);
    const given = await inputs();
    const rows = beliefAt(given, OWN, [sha256("fact-lamp")], NOW.toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.members).toEqual([sha256("fact-stove"), sha256("fact-lamp")].sort());
    expect(beliefAt(given, OWN, [sha256("fact-runs")], NOW.toISOString()).map((row) => row.factKeyFp)).toEqual([
      sha256("fact-runs"),
    ]);
    expect(beliefAt(given, OWN, [], NOW.toISOString())).toEqual([]);
  });

  it("a ruling made after the last rebuild shows at once: beliefAt gives what the next rebuild writes", async () => {
    const store = await seeded();
    const { deps, written, inputs } = harness(store, NOW);
    await rebuildBeliefs(deps);
    const role = sha256("fact-role-nora");
    const before = (written.get(JSON.stringify(OWN)) ?? []).find((row) => row.factKeyFp === role);
    expect(before).toBeDefined();
    store.vetoFact("fact-role-nora", OWN, NOW.toISOString() as Timestamp);
    const now = beliefAt(await inputs(), OWN, [role], NOW.toISOString());
    expect(now).not.toEqual([before]);
    await rebuildBeliefs(deps);
    expect(now).toEqual((written.get(JSON.stringify(OWN)) ?? []).filter((row) => row.factKeyFp === role));
  });

  it("a claim outside the clearance changes nothing it computes (invariant 6)", async () => {
    const store = await seeded();
    const { inputs } = harness(store, NOW);
    const given = await inputs();
    const withHidden = beliefAt(
      given,
      OWN,
      given.groups.map((group) => group.factKeyFp),
      NOW.toISOString(),
    );
    const visible: BeliefInputs = {
      ...given,
      groups: given.groups.map((group) => ({
        ...group,
        claims: group.claims.filter((one) => one.claim.label.compartments.every((c) => OWN.includes(c))),
      })),
    };
    expect(
      beliefAt(
        visible,
        OWN,
        given.groups.map((group) => group.factKeyFp),
        NOW.toISOString(),
      ),
    ).toEqual(withHidden);
  });
});

describe("the stored rebuild applies the claim relations a read applies", () => {
  // Two statements of one person's role, the later reversing the earlier, and the relation between
  // them as the store gives it: by claim key, judged by the owner.
  const EARLIER: Shape = { n: 21, type: "role", fields: ROLE, factKey: "fact-role-theo", subject: THEO, at: day(1) };
  const LATER: Shape = { ...EARLIER, n: 22, fields: OTHER_ROLE, at: day(2) };
  const keyOf = (claimId: string) => `key:${claimId}`;

  async function reversed() {
    const store = await memoryPipelineStore(W);
    for (const shape of [EARLIER, LATER]) store.putClaims(evidence(shape.n), [record(shape)]);
    store.setAudiences([OWN]);
    const [earlier, later] = [record(EARLIER).claim.id, record(LATER).claim.id];
    const relation: BeliefRelation = {
      id: "1",
      from: keyOf(later),
      to: keyOf(earlier),
      kind: "supersedes",
      judge: "owner:ruling",
      judgedAt: day(3),
      compartments: OWN,
    };
    const { deps, written, inputs } = harness(
      {
        ...store,
        beliefDecisions: async () => ({ ...(await store.beliefDecisions()), relations: [relation], switches: [] }),
        beliefClaims: async () =>
          (await store.beliefClaims()).map((group) => ({
            ...group,
            claims: group.claims.map((one) => ({ ...one, keys: [keyOf(one.claim.id)] })),
          })),
      },
      NOW,
    );
    return { deps, written, inputs, earlier, later };
  }

  it("a claim reversed by a later claim reads the same from the stored rows and at read", async () => {
    const { deps, written, inputs, earlier, later } = await reversed();
    await rebuildBeliefs(deps);
    const fp = sha256("fact-role-theo");
    const stored = (written.get(JSON.stringify(OWN)) ?? []).filter((row) => row.factKeyFp === fp);
    const given = await inputs();
    const read = beliefAt(given, OWN, [fp], NOW.toISOString());
    expect(stored).toEqual(read);
    // The relation acts: the earlier claim supports nothing, and without the relation it would.
    const support = (rows: readonly BeliefRecord[]) => rows.flatMap((row) => row.belief.support);
    expect(support(stored)).toEqual([later]);
    const { relations: _relations, ...without } = given;
    expect(support(beliefAt(without, OWN, [fp], NOW.toISOString()))).toContain(earlier);
  });
});

describe("the owner's reopen counts as confirming a commitment", () => {
  const factKey = "f".repeat(64);
  const made = record({ n: 1, type: "commitment", fields: { counterparty: THEO, what: "send the lease" }, factKey });
  const inputs = (reopens: BeliefInputs["reopens"]): BeliefInputs => ({
    groups: [{ factKeyFp: factKey, claims: [{ ...made, carried: [] } as never] }],
    decisions: [],
    retirements: [],
    reclassifications: [],
    goAt: null,
    ...(reopens === undefined ? {} : { reopens }),
  });
  const statusAt = (reopens: BeliefInputs["reopens"], days: number, audience = OWN) => {
    const at = new Date(Date.parse(day(0)) + days * DAY).toISOString();
    return beliefsFor(inputs(reopens), audience, at).rows[0]?.belief;
  };
  const reopen = (days: number, compartments = OWN) => ({
    factKeyFp: factKey,
    at: new Date(Date.parse(day(0)) + days * DAY).toISOString(),
    compartments,
  });

  it("with none, it goes dormant a year after it was last confirmed", () => {
    expect(statusAt(undefined, 366)?.status).toBe("dormant");
  });

  it("reopened at day 360, it stands a year from the reopen and does not go in five days", () => {
    const belief = statusAt([reopen(360)], 366);
    expect(belief?.status).toBe("active");
    expect(belief?.lastConfirmedAt).toBe(reopen(360).at);
    expect(statusAt([reopen(360)], 360 + 366)?.status).toBe("dormant");
  });

  it("a reopen after the build's time, or under a label the audience cannot see, changes nothing", () => {
    expect(statusAt([reopen(400)], 366)?.status).toBe("dormant");
    expect(statusAt([reopen(360, WORK)], 366)?.status).toBe("dormant");
    expect(statusAt([reopen(360, WORK)], 366, BOTH)?.status).toBe("active");
  });
});
