import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BasisType, type Claim, ClaimId, EvidenceId, LocalEntityId } from "@intelligence/contracts";
import {
  BELIEF_KINDS_BY_SUBJECT,
  BELIEF_TYPES,
  type BeliefClaim,
  type ClaimRecord,
  type PersonalBeliefKind,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import {
  ADDED_FACT_TYPES,
  BELIEF_RULES,
  beliefTier,
  CAPTURE_PROJECT,
  claimTier,
  differs,
  factKey,
  PERSONAL_ONTOLOGY,
  PERSONAL_TYPES,
  settle,
} from "@intelligence/personal-beliefs";
import { repoRoot, THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import type { ExtractDeps } from "./config.ts";
import { ontologyFor } from "./lane-versions.ts";
import { typeLineV2 } from "./message-prompts.ts";
import { runExtraction } from "./run.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";
import { setup } from "./test-support/support.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const DAY = 86_400_000;
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const THEO = LocalEntityId.parse("ent_0000000000000000000000THEO");
const IRIS = LocalEntityId.parse("ent_0000000000000000000000IRIS");
const ALDER = LocalEntityId.parse("ent_000000000000000000000ALDER");
const HERON = LocalEntityId.parse("ent_000000000000000000000HERON");
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const day = (n: number) => new Date(Date.parse("2026-05-01T10:00:00.000Z") + n * DAY).toISOString();

type Shape = {
  n: number;
  type?: string;
  fields?: Record<string, unknown>;
  subject?: LocalEntityId;
  subjectKind?: SubjectKind;
  by?: LocalEntityId | null;
  basis?: BasisType;
  at?: string;
  validTo?: string;
  compartment?: string;
  // An agent record's whole label, in place of one compartment.
  label?: string[];
  factKey?: string;
  changeKind?: Claim["changeKind"];
  origin?: ClaimRecord["origin"];
  statementKind?: Claim["statementKind"];
};

const FIELDS: Record<string, Record<string, unknown>> = {
  role: { title: "Head of Finance", organization: ALDER },
  affiliation: { relation: "employee", organization: ALDER },
  relationship: { counterparty: OWNER_ENTITY, relation: "sibling" },
  need: { what: "I need a kitchen designer." },
  capability: { what: "I design kitchens." },
  contact_rule: { rule: "do_not_contact", channel: "phone", what: "Please don't call me at work." },
  goal: { what: "I want to run a marathon next year." },
  preference: { what: "I prefer early morning runs.", polarity: "prefers" },
  constraint: { what: "I cannot travel before the spring." },
  situation: { what: "I am on leave." },
  consent: { about: "introduce", to: ALDER, what: "Happy to be introduced to Alder." },
  "project.status": { status: "active", what: "The survey is under way." },
  "project.decision": { what: "We chose the oak boards." },
};

function record(shape: Shape): ClaimRecord {
  const type = shape.type ?? "role";
  const subject = shape.subject ?? NORA;
  const evidenceId = evidence(shape.n);
  const by = shape.by === undefined ? subject : shape.by;
  const claim: Claim = {
    id: ClaimId.parse(`claim-${String(shape.n).padStart(3, "0")}`),
    content: { type, subject, fields: shape.fields ?? FIELDS[type] ?? {} },
    statementKind: shape.statementKind ?? "stated_fact",
    basis: shape.basis ?? (by === subject ? "explicit_self" : "third_party"),
    ...(by === null ? {} : { assertedBy: by }),
    validFrom: shape.at ?? day(0),
    ...(shape.validTo === undefined ? {} : { validTo: shape.validTo }),
    evidence: [{ evidenceId, span: "chars:0-24" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: shape.label ?? [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 2,
    changeKind: shape.changeKind ?? "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: shape.subjectKind ?? (subject === OWNER_ENTITY ? "owner" : "person"),
    disclosure: ["third_party"],
    factKey: shape.factKey ?? `fact-${type}`,
    lane: "correspondence",
    fieldKinds: {},
    entities: [],
    origin: shape.origin ?? "source",
    answersSystem: false,
  };
}

const put = (store: MemoryPipelineStore, ...shapes: Shape[]): void => {
  for (const shape of shapes) store.putClaims(evidence(shape.n), [record(shape)]);
};

const deps = (store: MemoryPipelineStore, now = NOW): ExtractDeps => ({
  store,
  model: fakeModelClient({}),
  modelId: "test/model",
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => now,
});

const fresh = () => memoryPipelineStore(W);
const only = (store: MemoryPipelineStore, audience = OWN) => {
  const rows = store.beliefs(audience);
  expect(rows).toHaveLength(1);
  return rows[0]?.belief;
};

describe("BELIEF_RULES", () => {
  it("has a row for each kind that builds a belief, and no other", () => {
    expect(Object.keys(BELIEF_RULES).sort()).toEqual(
      [
        "affiliation",
        "capability",
        "capture_project",
        "commitment",
        "consent",
        "constraint",
        "contact_rule",
        "decision",
        "goal",
        "need",
        "preference",
        "project_status",
        "relationship",
        "role",
        "situation",
        "status",
        "view",
        "visited",
        // A row for every belief kind; an interest's counts nothing yet.
        "interest",
      ].sort(),
    );
    expect(Object.isFrozen(BELIEF_RULES)).toBe(true);
  });

  it("the contracts' BELIEF_TYPES, which the store reads and raises agent_claim cards for, are the types whose kind has a row", () => {
    // capture.project is made by code and is in no lane. The view, status and visited kinds are in the
    // whole view and in no lane's yet (ADDED_FACT_TYPES).
    const ruled = [...PERSONAL_TYPES, ...ADDED_FACT_TYPES, CAPTURE_PROJECT]
      .filter(
        (type) => type.beliefKind !== undefined && BELIEF_RULES[type.beliefKind as PersonalBeliefKind] !== undefined,
      )
      .map((type) => type.id);
    expect([...BELIEF_TYPES].sort()).toEqual(ruled.sort());
  });

  it("capture.project is a belief type of a project with no conflict rule", () => {
    expect(BELIEF_TYPES).toContain("capture.project");
    expect(BELIEF_TYPES).not.toContain("capture.anchor");
    expect(PERSONAL_ONTOLOGY.get("capture.project")?.beliefKind).toBe("capture_project");
    expect(BELIEF_KINDS_BY_SUBJECT.project).toContain("capture_project");
    for (const kind of ["owner", "person", "organization"] as const)
      expect(BELIEF_KINDS_BY_SUBJECT[kind]).not.toContain("capture_project");
    const rule = BELIEF_RULES.capture_project;
    expect(rule).toBeDefined();
    const link = (n: number, by: LocalEntityId): Claim =>
      record({
        n,
        type: "capture.project",
        fields: {},
        subject: HERON,
        subjectKind: "project",
        by,
        basis: "third_party",
        at: day(n),
      }).claim;
    expect(rule?.conflict([link(1, NORA), link(2, THEO)])).toBe(false);
    // No model is offered it, in any lane.
    for (const lane of ["correspondence", "transaction", "document", "meeting", "moment"] as const)
      expect(ontologyFor(lane).get("capture.project"), lane).toBeNull();
    expect(PERSONAL_TYPES.some((type) => type.id.startsWith("capture."))).toBe(false);
  });

  it("a role belief counts explicit_self and third_party claims, and the later wins", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, at: day(25), fields: { title: "Chief of Staff", organization: ALDER } },
    );
    await rebuildBeliefs(deps(store));
    const belief = only(store);
    expect(belief?.support).toEqual(["claim-001", "claim-002"]);
    expect(belief?.disputed).toBe(false);
    expect(belief?.lastConfirmedAt).toBe(day(25));
    expect(belief?.confidence).toBe(0.9);
  });

  it("a role belief's values hold its organization and no title", async () => {
    const store = await fresh();
    put(store, { n: 1 });
    await rebuildBeliefs(deps(store));
    expect(only(store)?.values).toEqual({ organization: ALDER });
  });

  it("an affiliation keeps its relation and organization, and a capability nothing but its subject", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "affiliation" }, { n: 2, type: "capability" });
    await rebuildBeliefs(deps(store));
    const values = Object.fromEntries(store.beliefs(OWN).map((row) => [row.belief.kind, row.belief.values]));
    expect(values).toEqual({ affiliation: { relation: "employee", organization: ALDER }, capability: {} });
  });

  it("a need expires 90 days after its last claim", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "need", at: day(0) });
    await rebuildBeliefs(deps(store, new Date(Date.parse(day(61)))));
    expect(only(store)?.status).toBe("stale");
    await rebuildBeliefs(deps(store, new Date(Date.parse(day(90)))));
    expect(only(store)?.status).toBe("expired");
  });

  it("a contact rule counts only the person's own words", async () => {
    const report = await fresh();
    put(report, { n: 1, type: "contact_rule", by: THEO });
    await rebuildBeliefs(deps(report));
    expect(report.beliefs(OWN)).toEqual([]);
    const own = await fresh();
    put(own, { n: 1, type: "contact_rule" }, { n: 2, type: "contact_rule", by: THEO, at: day(1) });
    await rebuildBeliefs(deps(own));
    expect(only(own)?.support).toEqual(["claim-001"]);
  });

  it("a relationship counts only a claim whose speaker is its subject or its counterparty", async () => {
    const store = await fresh();
    // Nora says it, the owner (the counterparty) says it, Theo reports it.
    put(
      store,
      { n: 1, type: "relationship" },
      { n: 2, type: "relationship", by: OWNER_ENTITY, at: day(1) },
      { n: 3, type: "relationship", by: THEO, at: day(2) },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)?.support).toEqual(["claim-001", "claim-002"]);
    const report = await fresh();
    put(report, { n: 3, type: "relationship", by: THEO });
    await rebuildBeliefs(deps(report));
    expect(report.beliefs(OWN)).toEqual([]);
  });

  it("a claim about the owner by someone else builds no belief, but for a role or an affiliation; the owner's own word does", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, type: "need", subject: OWNER_ENTITY, by: THEO, basis: "third_party" },
      { n: 2, type: "role", subject: OWNER_ENTITY, by: NORA, basis: "third_party" },
    );
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).map((row) => [row.belief.kind, row.belief.subject])).toEqual([["role", OWNER_ENTITY]]);
    const own = await fresh();
    put(own, { n: 1, type: "need", subject: OWNER_ENTITY });
    await rebuildBeliefs(deps(own));
    expect(only(own)?.subject).toBe(OWNER_ENTITY);
  });

  // About the owner, only what they wrote of themselves and stated.
  it("the owner's question, proposal, objection or hypothesis builds no belief of the owner's, whatever its type", async () => {
    for (const statementKind of ["question", "proposal", "objection", "hypothesis"] as const) {
      const store = await fresh();
      put(
        store,
        { n: 1, type: "need", subject: OWNER_ENTITY, statementKind, factKey: "fact-need" },
        { n: 2, type: "capability", subject: OWNER_ENTITY, statementKind, factKey: "fact-capability" },
        { n: 3, type: "goal", subject: OWNER_ENTITY, statementKind, factKey: "fact-goal" },
      );
      await rebuildBeliefs(deps(store));
      expect(store.beliefs(OWN), statementKind).toEqual([]);
      // The claims stay, for find_facts and the owner's review.
      expect(store.claims(), statementKind).toHaveLength(3);
    }
    const person = await fresh();
    put(person, { n: 1, type: "need", statementKind: "question" });
    await rebuildBeliefs(deps(person));
    expect(only(person)?.kind).toBe("need");
  });

  it("a claim about the owner the model marked the owner's own word, but whose speaker is someone else, builds no belief", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, type: "situation", subject: OWNER_ENTITY, by: THEO, basis: "explicit_self" },
      { n: 2, type: "preference", subject: OWNER_ENTITY, by: null, basis: "explicit_self", at: day(1) },
    );
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toEqual([]);
  });

  it("the owner's own statement and decision build the owner's belief, and their reversal closes it", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, type: "goal", subject: OWNER_ENTITY, at: day(0) },
      { n: 2, type: "goal", subject: OWNER_ENTITY, statementKind: "decision", at: day(1) },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)).toMatchObject({ kind: "goal", status: "active", support: ["claim-001", "claim-002"] });
    put(store, { n: 3, type: "goal", subject: OWNER_ENTITY, statementKind: "reversal", at: day(2) });
    await rebuildBeliefs(deps(store));
    expect(only(store)?.status).toBe("closed");
  });

  it("an owner-confirmed agent claim counts in a relationship, a contact rule and an owner-subject need whatever its basis and speaker, as agent_reported; an unconfirmed one counts in none", async () => {
    // An agent record's claims are third party with no speaker.
    const finding = (n: number, type: string, subject = NORA): Shape => ({
      n,
      type,
      subject,
      by: null,
      basis: "third_party",
      origin: "agent_record",
      factKey: `fact-${type}-${n}`,
    });
    const shapes = [finding(1, "relationship"), finding(2, "contact_rule"), finding(3, "need", OWNER_ENTITY)];
    const unconfirmed = await fresh();
    put(unconfirmed, ...shapes);
    await rebuildBeliefs(deps(unconfirmed));
    expect(unconfirmed.beliefs(OWN)).toEqual([]);
    const confirmed = await fresh();
    put(confirmed, ...shapes);
    for (const shape of shapes) confirmed.confirm(evidence(shape.n));
    await rebuildBeliefs(deps(confirmed));
    const rows = confirmed.beliefs(OWN);
    expect(rows.map((row) => row.belief.kind).sort()).toEqual(["contact_rule", "need", "relationship"]);
    expect(rows.every((row) => row.provenance === "agent_reported")).toBe(true);
  });

  it("a claim about an organization, always third party, counts", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "need", subject: ALDER, subjectKind: "organization", by: NORA, basis: "third_party" });
    await rebuildBeliefs(deps(store));
    expect(only(store)?.confidence).toBe(0.6);
  });

  it("two different titles within 30 days by two third parties are disputed", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, by: IRIS, at: day(20), fields: { title: "Chief of Staff", organization: ALDER } },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)?.disputed).toBe(true);
    // The same title from both, in another letter case and spacing, is no dispute.
    const same = await fresh();
    put(
      same,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, by: IRIS, at: day(20), fields: { title: "head of  finance", organization: ALDER } },
    );
    await rebuildBeliefs(deps(same));
    expect(only(same)?.disputed).toBe(false);
  });

  it("a title the person states supersedes, whatever the gap", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, at: day(2), fields: { title: "Chief of Staff", organization: ALDER } },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)?.disputed).toBe(false);
  });

  it("a different title 31 days later supersedes, and one by the same speaker within 30 days is no dispute", async () => {
    const later = await fresh();
    put(
      later,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, by: IRIS, at: day(31), fields: { title: "Chief of Staff", organization: ALDER } },
    );
    await rebuildBeliefs(deps(later));
    expect(only(later)?.disputed).toBe(false);
    const sameSpeaker = await fresh();
    put(
      sameSpeaker,
      { n: 1, by: THEO, at: day(0) },
      { n: 2, by: THEO, at: day(5), fields: { title: "Chief of Staff", organization: ALDER } },
    );
    await rebuildBeliefs(deps(sameSpeaker));
    expect(only(sameSpeaker)?.disputed).toBe(false);
  });

  it("two titles that agree, at one organization entity named by two spellings, are one undisputed fact", async () => {
    const store = await fresh();
    put(
      store,
      {
        n: 1,
        by: THEO,
        at: day(0),
        fields: { title: "Head of Finance", organization: ALDER, organization_name: "Alder" },
      },
      {
        n: 2,
        by: IRIS,
        at: day(20),
        fields: { title: "Head of Finance", organization: ALDER, organization_name: "Alder Holdings Inc." },
      },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)?.disputed).toBe(false);
    // With no organization entity the name is what is stated: two names are two statements.
    const named = [
      record({ n: 1, by: THEO, at: day(0), fields: { title: "Head of Finance", organization_name: "Alder" } }).claim,
      record({ n: 2, by: IRIS, at: day(20), fields: { title: "Head of Finance", organization_name: "Birch" } }).claim,
    ];
    expect(differs(named)).toBe(true);
    // The test is the fact key's: an organization given as null is an entity field, not its absence.
    const nulled = [
      record({
        n: 1,
        by: THEO,
        at: day(0),
        fields: { title: "Head of Finance", organization: null, organization_name: "Alder" },
      }).claim,
      record({
        n: 2,
        by: IRIS,
        at: day(20),
        fields: { title: "Head of Finance", organization: null, organization_name: "Alder Holdings Inc." },
      }).claim,
    ];
    expect(differs(nulled)).toBe(false);
  });

  it("two confirmed findings with no speaker that differ within 30 days supersede, not dispute", async () => {
    // An agent record's claims are third party with no speaker, under a label that holds its
    // writer's agent compartment: a dispute needs two parties, and two findings with no speaker are
    // one.
    const AGENT = ["agent:alpha", "own"];
    const finding = (n: number, title: string, at: string): Shape => ({
      n,
      by: null,
      basis: "third_party",
      origin: "agent_record",
      label: AGENT,
      at,
      fields: { title, organization: ALDER },
    });
    const store = await fresh();
    store.setAudiences([AGENT]);
    put(store, finding(1, "Head of Finance", day(0)), finding(2, "Chief of Staff", day(5)));
    store.confirm(evidence(1));
    store.confirm(evidence(2));
    await rebuildBeliefs(deps(store));
    expect(only(store, AGENT)).toMatchObject({ disputed: false, support: ["claim-001", "claim-002"] });
    expect(
      differs([
        record(finding(1, "Head of Finance", day(0))).claim,
        record(finding(2, "Chief of Staff", day(5))).claim,
      ]),
    ).toBe(false);
    // One speaker missing and the other named are still two parties.
    expect(
      differs([record({ n: 1, by: THEO, at: day(0) }).claim, record(finding(2, "Chief of Staff", day(5))).claim]),
    ).toBe(true);
  });

  it("two message claims whose speakers did not resolve are still two parties, and dispute", () => {
    // A message claim has no speaker when its author's mention did not resolve: nothing says two
    // such authors are one person.
    const unresolved = [
      record({ n: 1, by: null, basis: "third_party", at: day(0) }).claim,
      record({
        n: 2,
        by: null,
        basis: "third_party",
        at: day(10),
        fields: { title: "Chief of Staff", organization: ALDER },
      }).claim,
    ];
    expect(differs(unresolved)).toBe(true);
  });

  it("the conflict rule is pure over its claims, and false for need and capability", () => {
    const claims = [
      record({ n: 1, by: THEO, at: day(0) }).claim,
      record({ n: 2, by: IRIS, at: day(20), fields: { title: "Chief of Staff", organization: ALDER } }).claim,
    ];
    expect(differs(claims)).toBe(true);
    expect(differs([...claims].reverse())).toBe(true);
    expect(BELIEF_RULES.need?.conflict(claims)).toBe(false);
    expect(BELIEF_RULES.capability?.conflict(claims)).toBe(false);
  });

  it("a role belief is built from visible claims only, per audience; a person in two mailboxes has two beliefs", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, compartment: "own", factKey: "fact-role-own" },
      { n: 2, compartment: "employer:example", factKey: "fact-role-work", by: THEO, at: day(3) },
    );
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).map((row) => row.belief.support)).toEqual([["claim-001"]]);
    expect(
      store
        .beliefs(BOTH)
        .map((row) => row.belief.support)
        .sort(),
    ).toEqual([["claim-001"], ["claim-002"]]);
  });

  it("a fact veto closes, and a reject leaves out, a belief of every kind with a row", async () => {
    for (const type of ["role", "affiliation", "relationship", "need", "capability", "contact_rule"]) {
      const store = await fresh();
      put(store, { n: 1, type, factKey: `veto-${type}` }, { n: 2, type, factKey: `reject-${type}` });
      // The control: both build.
      await rebuildBeliefs(deps(store));
      expect(store.beliefs(OWN), type).toHaveLength(2);
      store.vetoFact(`veto-${type}`, ["own"]);
      store.reject("claim-002");
      await rebuildBeliefs(deps(store));
      // The vetoed fact key's belief is closed; the rejected claim is in no belief.
      expect(
        store.beliefs(OWN).map((row) => [row.belief.status, row.belief.support]),
        type,
      ).toEqual([["closed", ["claim-001"]]]);
    }
  });

  it("the rebuild reports each changed fact key with its audience, kind and change kind", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-a" }, { n: 2, type: "need", factKey: "fact-b", changeKind: "backfill" });
    const first = await rebuildBeliefs(deps(store));
    const keyed = (summary: typeof first) =>
      summary.changes.map((change) => `${JSON.stringify(change.audience)} ${change.kind} ${change.changeKind}`).sort();
    expect(keyed(first)).toEqual([
      `["employer:example","own"] need backfill`,
      `["employer:example","own"] role live`,
      `["own"] need backfill`,
      `["own"] role live`,
    ]);
    expect((await rebuildBeliefs(deps(store))).changes).toEqual([]);
  });

  it("after a generation change, a belief whose values, status and disputed mark are unchanged is not reported, and every change of that run is backfill", async () => {
    const store = await fresh();
    put(store, { n: 1, factKey: "fact-a" });
    await rebuildBeliefs(deps(store));
    // The same statement under a new claim id, as a raised generation gives it.
    put(store, { n: 1, factKey: "fact-a" }, { n: 9, factKey: "fact-a", at: day(0) });
    put(store, { n: 3, type: "need", factKey: "fact-new" });
    const after = await rebuildBeliefs(deps(store), { regenerated: true });
    expect(after.changes.map((change) => [change.kind, change.changeKind])).toEqual([
      ["need", "backfill"],
      ["need", "backfill"],
    ]);
  });
  // Goal, preference, constraint and situation.
  it("a third party's statement of the owner's goal builds no belief; the owner's own goal from an outbound item builds one", async () => {
    const report = await fresh();
    put(
      report,
      { n: 1, type: "goal", subject: OWNER_ENTITY, by: THEO, basis: "third_party" },
      { n: 2, type: "preference", subject: OWNER_ENTITY, by: THEO, basis: "third_party", at: day(1) },
    );
    await rebuildBeliefs(deps(report));
    expect(report.beliefs(OWN)).toEqual([]);
    // The claims stay, with their basis, for find_facts and get_self's stated claims to serve.
    expect(report.claims().map((one) => [one.claim.content.type, one.claim.basis])).toEqual([
      ["goal", "third_party"],
      ["preference", "third_party"],
    ]);
    const own = await fresh();
    put(own, { n: 1, type: "goal", subject: OWNER_ENTITY });
    await rebuildBeliefs(deps(own));
    expect(only(own)).toMatchObject({ kind: "goal", subject: OWNER_ENTITY, status: "active", values: {} });
  });

  it("goal, preference, constraint and situation about a person count the person's own word and a third party's", async () => {
    for (const type of ["goal", "preference", "constraint", "situation"]) {
      const store = await fresh();
      put(store, { n: 1, type, by: THEO, basis: "third_party" });
      await rebuildBeliefs(deps(store));
      expect(only(store), type).toMatchObject({ kind: type, confidence: 0.6 });
    }
    // A preference keeps its polarity, and the statement kinds nothing but their subject.
    const store = await fresh();
    put(store, { n: 1, type: "preference" }, { n: 2, type: "goal" });
    await rebuildBeliefs(deps(store));
    expect(Object.fromEntries(store.beliefs(OWN).map((row) => [row.belief.kind, row.belief.values]))).toEqual({
      preference: { polarity: "prefers" },
      goal: {},
    });
  });

  it("goal, preference and constraint are stale at 180 days and dormant at 365", async () => {
    for (const type of ["goal", "preference", "constraint"]) {
      const store = await fresh();
      put(store, { n: 1, type, at: day(0) });
      await rebuildBeliefs(deps(store, new Date(Date.parse(day(179)))));
      expect(only(store)?.status, type).toBe("active");
      await rebuildBeliefs(deps(store, new Date(Date.parse(day(180)))));
      expect(only(store)?.status, type).toBe("stale");
      await rebuildBeliefs(deps(store, new Date(Date.parse(day(365)))));
      expect(only(store)?.status, type).toBe("dormant");
    }
  });

  it("a situation is stale at 60 days and expired at 120", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "situation", at: day(0) });
    await rebuildBeliefs(deps(store, new Date(Date.parse(day(59)))));
    expect(only(store)?.status).toBe("active");
    await rebuildBeliefs(deps(store, new Date(Date.parse(day(60)))));
    expect(only(store)?.status).toBe("stale");
    await rebuildBeliefs(deps(store, new Date(Date.parse(day(120)))));
    expect(only(store)?.status).toBe("expired");
  });

  it("a situation with until expires at the end of that day", async () => {
    // The check sets validTo at the end of `until`'s day in UTC; the belief ends then.
    const store = await fresh();
    put(store, {
      n: 1,
      type: "situation",
      at: day(0),
      fields: { what: "I am on leave.", until: "2026-05-10" },
      validTo: "2026-05-10T23:59:59.999Z",
    });
    await rebuildBeliefs(deps(store, new Date("2026-05-10T23:59:00.000Z")));
    expect(only(store)?.status).toBe("active");
    await rebuildBeliefs(deps(store, new Date("2026-05-11T00:00:00.000Z")));
    expect(only(store)?.status).toBe("expired");
  });

  it("two situations of one person within 30 days by two third parties are disputed; the person's own word supersedes", async () => {
    const store = await fresh();
    put(
      store,
      { n: 1, type: "situation", by: THEO, at: day(0) },
      { n: 2, type: "situation", by: IRIS, at: day(20), fields: { what: "I am moving to Lisbon." } },
    );
    await rebuildBeliefs(deps(store));
    expect(only(store)?.disputed).toBe(true);
    const own = await fresh();
    put(
      own,
      { n: 1, type: "situation", by: THEO, at: day(0) },
      { n: 2, type: "situation", at: day(20), fields: { what: "I am moving to Lisbon." } },
    );
    await rebuildBeliefs(deps(own));
    expect(only(own)?.disputed).toBe(false);
  });

  it("the conflict rule is false for goal, preference and constraint, whose fact keys hold no value that can differ", () => {
    for (const type of ["goal", "preference", "constraint"] as const) {
      const claims = [
        record({ n: 1, type, by: THEO, at: day(0) }).claim,
        record({ n: 2, type, by: IRIS, at: day(20), fields: { what: "Something else entirely." } }).claim,
      ];
      expect(BELIEF_RULES[type]?.conflict(claims), type).toBe(false);
    }
  });

  it("adding the four belief kinds leaves every claim id, fact key and call key unchanged, and a run buys no call", async () => {
    const FOUR = ["goal", "preference", "constraint", "situation"];
    // The ontology as it was before this step: the four types with no belief kind.
    const before = {
      ...PERSONAL_ONTOLOGY,
      get: (id: string) => {
        const type = PERSONAL_ONTOLOGY.get(id);
        return type === null || !FOUR.includes(id) ? type : { ...type, beliefKind: undefined };
      },
    };
    // The call key is of the rendered prompt, whose type lines do not read a belief kind; its
    // version 2 text hash is pinned (prompts.ts), so a change to it fails that test too.
    for (const type of PERSONAL_TYPES.filter((one) => FOUR.includes(one.id))) {
      expect(type.beliefKind, type.id).toBe(type.id);
      expect(typeLineV2(type), type.id).toBe(typeLineV2({ ...type, beliefKind: undefined }));
    }
    // The world's run: its owner's goal and preference claims, keyed alike under both ontologies.
    // A claim id hashes evidence, span, content and generation, none of which is a belief kind.
    const s = await setup();
    const first = await runExtraction(s.deps);
    if (first === "already_running") throw new Error("locked");
    const stated = s.store.claims().filter((one) => FOUR.includes(one.claim.content.type));
    expect(stated.map((one) => one.claim.content.type).sort()).toEqual(["goal", "preference"]);
    for (const one of stated)
      expect(factKey(one.claim.content, { ontology: before }), one.claim.content.type).toBe(
        factKey(one.claim.content, { ontology: PERSONAL_ONTOLOGY }),
      );
    const ids = s.store
      .claims()
      .map((one) => one.claim.id)
      .sort();
    // The next run takes nothing, buys no call, and keeps every claim; the beliefs are there.
    const calls = s.calls.length;
    const second = await runExtraction(s.deps);
    if (second === "already_running") throw new Error("locked");
    expect(second.counts.liveCalls).toBe(0);
    expect(s.calls.length).toBe(calls);
    expect(
      s.store
        .claims()
        .map((one) => one.claim.id)
        .sort(),
    ).toEqual(ids);
    await rebuildBeliefs(s.deps);
    const kinds = s.store
      .beliefs(BOTH)
      .filter((row) => row.belief.subject === OWNER_ENTITY)
      .map((row) => row.belief.kind);
    expect(kinds).toEqual(expect.arrayContaining(["goal", "preference"]));
  });

  // Consent.
  it("a person's own consent builds a belief, and a third party's report of it builds none", async () => {
    const report = await fresh();
    put(report, { n: 1, type: "consent", by: THEO, basis: "third_party" });
    await rebuildBeliefs(deps(report));
    expect(report.beliefs(OWN)).toEqual([]);
    // The claim stays, with its basis, for find_facts and get_entity's claims to serve.
    expect(report.claims().map((one) => [one.claim.content.type, one.claim.basis])).toEqual([
      ["consent", "third_party"],
    ]);
    const own = await fresh();
    put(own, { n: 1, type: "consent" }, { n: 2, type: "consent", by: THEO, basis: "third_party", at: day(1) });
    await rebuildBeliefs(deps(own));
    expect(only(own)).toMatchObject({
      kind: "consent",
      subject: NORA,
      status: "active",
      disputed: false,
      support: ["claim-001"],
      values: { about: "introduce", to: ALDER },
    });
    expect(only(own)?.lastConfirmedAt).toBe(day(0));
  });

  it("a later reversal by the person closes the consent", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "consent", at: day(0) }, { n: 2, type: "consent", statementKind: "reversal", at: day(3) });
    await rebuildBeliefs(deps(store));
    // The shared rule: a statement and its reversal in one set close it and mark it disputed; either
    // holds a draft once the outbound gate reads it, and nothing here releases one.
    expect(only(store)).toMatchObject({ kind: "consent", status: "closed" });
    // A third party's reversal counts for nothing and changes nothing.
    const alone = await fresh();
    put(alone, { n: 1, type: "consent", at: day(0) });
    await rebuildBeliefs(deps(alone));
    const reported = await fresh();
    put(
      reported,
      { n: 1, type: "consent", at: day(0) },
      { n: 2, type: "consent", by: THEO, basis: "third_party", statementKind: "reversal", at: day(3) },
    );
    await rebuildBeliefs(deps(reported));
    expect(only(reported)?.status).toBe("active");
    expect(only(reported)?.disputed).toBe(false);
  });

  it("a consent never ages", async () => {
    const store = await fresh();
    put(store, { n: 1, type: "consent", at: day(0) });
    for (const days of [61, 181, 366, 3650]) {
      await rebuildBeliefs(deps(store, new Date(Date.parse(day(days)))));
      expect(only(store)?.status, String(days)).toBe("active");
      expect(only(store)?.reviewAfter, String(days)).toBeUndefined();
    }
  });

  it("the conflict rule of consent is false: a reversal is the only way it closes", () => {
    const claims = [
      record({ n: 1, type: "consent", at: day(0) }).claim,
      record({
        n: 2,
        type: "consent",
        at: day(5),
        fields: { about: "introduce", to: ALDER, what: "Fine to introduce me." },
      }).claim,
    ];
    expect(BELIEF_RULES.consent?.conflict(claims)).toBe(false);
    expect(BELIEF_RULES.consent?.conflict([...claims].reverse())).toBe(false);
  });

  it("an owner-confirmed agent consent counts whatever its basis; an unconfirmed one does not", async () => {
    const finding: Shape = { n: 1, type: "consent", by: null, basis: "third_party", origin: "agent_record" };
    const unconfirmed = await fresh();
    put(unconfirmed, finding);
    await rebuildBeliefs(deps(unconfirmed));
    expect(unconfirmed.beliefs(OWN)).toEqual([]);
    const confirmed = await fresh();
    put(confirmed, finding);
    confirmed.confirm(evidence(1));
    await rebuildBeliefs(deps(confirmed));
    expect(confirmed.beliefs(OWN).map((row) => [row.belief.kind, row.provenance])).toEqual([
      ["consent", "agent_reported"],
    ]);
  });

  it("adding the consent kind leaves its call key and fact key unchanged, and a run after this step buys no call", async () => {
    const consent = PERSONAL_TYPES.find((one) => one.id === "consent");
    expect(consent?.beliefKind).toBe("consent");
    // The call key is of the rendered prompt, whose type lines read no belief kind.
    expect(typeLineV2(consent as (typeof PERSONAL_TYPES)[number])).toBe(
      typeLineV2({ ...(consent as (typeof PERSONAL_TYPES)[number]), beliefKind: undefined }),
    );
    const before = {
      ...PERSONAL_ONTOLOGY,
      get: (id: string) =>
        id === "consent"
          ? {
              ...(PERSONAL_ONTOLOGY.get(id) as NonNullable<ReturnType<typeof PERSONAL_ONTOLOGY.get>>),
              beliefKind: undefined,
            }
          : PERSONAL_ONTOLOGY.get(id),
    };
    const content = record({ n: 1, type: "consent" }).claim.content;
    expect(factKey(content, { ontology: before })).toBe(factKey(content, { ontology: PERSONAL_ONTOLOGY }));
    // The world's run, then a consent claim stored as an earlier run left it: the next run takes
    // nothing, buys no call, and builds its belief from the claim already stored.
    const s = await setup();
    const first = await runExtraction(s.deps);
    if (first === "already_running") throw new Error("locked");
    const calls = s.calls.length;
    s.store.putClaims(evidence(900), [record({ n: 900, type: "consent", compartment: "own" })]);
    const second = await runExtraction(s.deps);
    if (second === "already_running") throw new Error("locked");
    expect(second.counts.liveCalls).toBe(0);
    expect(s.calls.length).toBe(calls);
    await rebuildBeliefs(s.deps);
    expect(
      s.store
        .beliefs(OWN)
        .filter((row) => row.belief.kind === "consent")
        .map((row) => row.belief.subject),
    ).toEqual([NORA]);
  });

  it("R23, B8: no statement of the extract or store packages writes projections.goal_state but durable-work's owner commands", async () => {
    // A structure test over the source: the goal state is built only from the owner's goal
    // decisions (admin-work.ts; goal-writes.ts, the same commands' code, which an accepted goal
    // proposal also runs; admin-erase.ts, the owner's erasure of a goal they set; goal-target-names.ts,
    // `pia goal target --name`; erasure-goal-targets.ts, whose `goal_targets` hook clears a target that
    // names an erased person, as invariant 10 requires and as the rebuild from the tainted decisions
    // would), and no belief code writes it.
    const roots = [join(import.meta.dirname), join(repoRoot(), "packages/store/src")];
    const writers: string[] = [];
    for (const root of roots) {
      for (const path of await readdir(root, { recursive: true })) {
        const name = path.split("/").at(-1) ?? path;
        if (!name.endsWith(".ts") || name.includes(".test.") || /fixtures|test-world|testing/.test(path)) continue;
        const text = await readFile(join(root, path), "utf8");
        if (/(insert\s+into|update|delete\s+from)\s+projections\.goal_state/i.test(text)) writers.push(name);
      }
    }
    expect(writers.sort()).toEqual([
      "admin-erase.ts",
      "admin-work.ts",
      "erasure-goal-targets.ts",
      "goal-target-names.ts",
      "goal-writes.ts",
    ]);
  });
});

// Every claim of an anchored item counts but a system message's; a status the owner states supersedes,
// and two different statuses by two people within 30 days are disputed.
describe("project_status and decision", () => {
  const project = (n: number, type: "project.status" | "project.decision", more: Partial<Shape> = {}): Shape => ({
    n,
    type,
    subject: HERON,
    subjectKind: "project",
    basis: "third_party",
    ...more,
  });

  it("every claim of an anchored item counts, whoever of its participants spoke, but a system message's", async () => {
    const store = await fresh();
    put(store, project(1, "project.decision", { by: THEO }), project(2, "project.status", { by: OWNER_ENTITY }));
    await rebuildBeliefs(deps(store));
    expect(
      store
        .beliefs(OWN)
        .map((row) => row.belief.kind)
        .sort(),
    ).toEqual(["decision", "project_status"]);
    const system = await fresh();
    const sent = record(project(3, "project.decision", { by: THEO }));
    system.putClaims(evidence(3), [{ ...sent, claim: { ...sent.claim, systemOriginated: true } }]);
    await rebuildBeliefs(deps(system));
    expect(system.beliefs(OWN)).toEqual([]);
  });

  it("a status change by the owner supersedes; two different statuses by two people within 30 days are disputed", async () => {
    const owned = await fresh();
    put(
      owned,
      project(1, "project.status", { by: THEO, at: day(0) }),
      project(2, "project.status", { by: OWNER_ENTITY, at: day(3), fields: { status: "done" } }),
    );
    await rebuildBeliefs(deps(owned));
    expect(only(owned)).toMatchObject({ disputed: false, values: { status: "done" } });
    const two = await fresh();
    put(
      two,
      project(1, "project.status", { by: THEO, at: day(0) }),
      project(2, "project.status", { by: IRIS, at: day(3), fields: { status: "blocked" } }),
    );
    await rebuildBeliefs(deps(two));
    expect(only(two)?.disputed).toBe(true);
    // Active and done are one fact: one belief, the later status in its values.
    const later = await fresh();
    put(
      later,
      project(1, "project.status", { by: THEO, at: day(0) }),
      project(2, "project.status", { by: IRIS, at: day(31), fields: { status: "done" } }),
    );
    await rebuildBeliefs(deps(later));
    expect(only(later)).toMatchObject({ disputed: false, values: { status: "done" } });
  });

  it("the conflict rule asks who spoke only through the rebuild's word on the owner, never a claim's own", () => {
    const a = record(project(1, "project.status", { by: THEO, at: day(0) })).claim;
    const b = record(project(2, "project.status", { by: IRIS, at: day(3), fields: { status: "done" } })).claim;
    const rule = BELIEF_RULES.project_status;
    expect(rule?.conflict([a, b])).toBe(true);
    expect(rule?.conflict([a, b], (claim) => claim.id === b.id)).toBe(false);
    expect(BELIEF_RULES.decision?.conflict([a, b])).toBe(false);
  });
});

// Credited to nobody it counts in no rule, as a document's; about the owner it counts only as the
// owner's own word. A mail claim of the same shape is the control.
describe("meeting claims and beliefs", () => {
  const claimOf = (span: string, over: Partial<Claim>, content: Claim["content"]): Claim => ({
    id: ClaimId.parse("a".repeat(64)),
    content,
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: day(0),
    evidence: [{ evidenceId: evidence(1), span }],
    primaryEvidenceId: evidence(1),
    label: { compartments: OWN, readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "test",
    extractorGeneration: 4,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
    ...over,
  });
  const counts = (
    kind: PersonalBeliefKind,
    span: string,
    subjectKind: SubjectKind,
    over: Partial<Claim>,
    content: Claim["content"],
  ) =>
    BELIEF_RULES[kind]?.counts({
      claim: claimOf(span, over, content),
      origin: "source",
      subjectKind,
      ownerSaid: over.assertedBy === OWNER_ENTITY,
    });
  const role = (subject: LocalEntityId) => ({
    type: "role",
    subject,
    fields: { title: "Head of Finance", organization_name: "Alder" },
  });
  const goal = (subject: LocalEntityId) => ({
    type: "goal",
    subject,
    fields: { objective: "run a marathon", domain: "health" },
  });

  // These claims carry no meeting mark, as a moment's do not: a moment's claim credited to nobody
  // counts in no rule. A meeting's, marked, is below.
  it("a capture claim credited to nobody counts in no rule; the same claim from mail counts", () => {
    expect(counts("role", "seg:4-40", "person", {}, role(NORA))).toBe(false);
    expect(counts("goal", "seg:4-40", "person", {}, goal(NORA))).toBe(false);
    expect(counts("role", "chars:0-40", "person", {}, role(NORA))).toBe(true);
    expect(counts("goal", "chars:0-40", "person", {}, goal(NORA))).toBe(true);
  });

  it("a meeting claim credited to its speaker counts under its kind's rule, as mail's", () => {
    expect(counts("role", "seg:4-40", "person", { assertedBy: NORA }, role(NORA))).toBe(true);
    expect(counts("goal", "seg:4-40", "person", { assertedBy: THEO }, goal(NORA))).toBe(true);
    expect(
      counts(
        "relationship",
        "seg:4-40",
        "person",
        { assertedBy: NORA },
        { type: "relationship", subject: NORA, fields: { counterparty: OWNER_ENTITY, relation: "sibling" } },
      ),
    ).toBe(true);
  });

  it("about the owner a meeting claim counts only as the owner's own word: another speaker's statement of the owner's role does not, as it would from mail", () => {
    expect(counts("role", "seg:4-40", "owner", { assertedBy: NORA }, role(OWNER_ENTITY))).toBe(false);
    expect(counts("role", "chars:0-40", "owner", { assertedBy: NORA }, role(OWNER_ENTITY))).toBe(true);
    expect(
      counts("role", "seg:4-40", "owner", { assertedBy: OWNER_ENTITY, basis: "explicit_self" }, role(OWNER_ENTITY)),
    ).toBe(true);
    expect(
      counts("goal", "seg:4-40", "owner", { assertedBy: OWNER_ENTITY, basis: "explicit_self" }, goal(OWNER_ENTITY)),
    ).toBe(true);
    expect(counts("goal", "seg:4-40", "owner", {}, goal(OWNER_ENTITY))).toBe(false);
  });

  // A meeting's claim that is not the owner's word counts as a source's, about a person as a third
  // party's in mail, about the owner only when stated, at the `source` tier, below the owner's word.
  const heard = (
    kind: PersonalBeliefKind,
    subjectKind: SubjectKind,
    over: Partial<Claim>,
    content: Claim["content"],
    meeting = true,
  ) =>
    BELIEF_RULES[kind]?.counts({
      claim: claimOf("seg:4-40", over, content),
      origin: "source",
      subjectKind,
      ownerSaid: over.assertedBy === OWNER_ENTITY,
      ...(meeting ? { meeting: true as const } : {}),
    });
  const need = (subject: LocalEntityId) => ({
    type: "need",
    subject,
    fields: { object: "a co-founder who can code", domain: "ventures" },
  });
  const capability = (subject: LocalEntityId) => ({
    type: "capability",
    subject,
    fields: { object: "negotiating term sheets", domain: "ventures" },
  });

  it("a meeting's claim credited to nobody about a participant counts for every owner-side kind, a role and an affiliation", () => {
    for (const [kind, content] of [
      ["need", need(NORA)],
      ["capability", capability(NORA)],
      ["goal", goal(NORA)],
      ["role", role(NORA)],
    ] as const)
      expect(heard(kind, "person", {}, content), kind).toBe(true);
    // A moment's claim credited to nobody still counts in none.
    expect(heard("goal", "person", {}, goal(NORA), false)).toBe(false);
    // A commitment counts only as its subject's own word, and a relationship only from a party.
    expect(
      heard(
        "commitment",
        "person",
        {},
        { type: "commitment", subject: NORA, fields: { counterparty: OWNER_ENTITY, what: "I will send it." } },
      ),
    ).toBe(false);
    expect(
      heard(
        "relationship",
        "person",
        {},
        { type: "relationship", subject: NORA, fields: { counterparty: OWNER_ENTITY, relation: "friend" } },
      ),
    ).toBe(false);
    // Never a claim the system's own mail made.
    expect(heard("goal", "person", { systemOriginated: true }, goal(NORA))).toBe(false);
  });

  it("about the owner, a meeting's claim credited to nobody or to another speaker counts when stated, never as a question, proposal or hypothesis", () => {
    expect(heard("goal", "owner", {}, goal(OWNER_ENTITY))).toBe(true);
    expect(heard("need", "owner", { assertedBy: NORA }, need(OWNER_ENTITY))).toBe(true);
    expect(heard("role", "owner", {}, role(OWNER_ENTITY))).toBe(true);
    // Nor a decision or a reversal, which could close the owner's own belief.
    for (const statementKind of ["question", "proposal", "hypothesis", "objection", "decision", "reversal"] as const)
      expect(heard("goal", "owner", { statementKind }, goal(OWNER_ENTITY)), statementKind).toBe(false);
    // About a person, a heard reversal counts, as a third party's in mail does.
    expect(heard("goal", "person", { statementKind: "reversal" }, goal(NORA))).toBe(true);
  });

  it("a meeting's claim about the owner credited to nobody is at the source tier, below the owner's word, and the owner's word outranks it where they differ", () => {
    const record = (n: number, over: Partial<Claim>, content: Claim["content"]): BeliefClaim => ({
      claim: claimOf("seg:4-40", { id: ClaimId.parse(String(n).repeat(64).slice(0, 64)), ...over }, content),
      origin: "source",
      subjectKind: "owner",
      ownerSaid: over.assertedBy === OWNER_ENTITY,
      meeting: true,
    });
    const situation = (state: string) => ({
      type: "situation",
      subject: OWNER_ENTITY,
      fields: { state, domain: "home" },
    });
    const heardOne = record(1, { validFrom: day(5) }, situation("moving to Porto"));
    const his = record(
      2,
      { assertedBy: OWNER_ENTITY, basis: "explicit_self", validFrom: day(1) },
      situation("staying in Lisbon"),
    );
    expect(claimTier(heardOne, true)).toBe("source");
    expect(claimTier(his, true)).toBe("owner");
    expect(beliefTier([heardOne])).toBe("source");
    expect(beliefTier([heardOne, his])).toBe("owner");
    // The later heard claim states something else: the owner's own word, though older, outranks it.
    const rule = BELIEF_RULES.situation as NonNullable<(typeof BELIEF_RULES)["situation"]>;
    expect(settle(rule, [heardOne, his]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    // Where the owner's word is on the key, what was heard is left out whatever its values,
    // in a kind with no conflict rule too, so it can neither close nor answer the owner's belief.
    const sameValue = record(3, { validFrom: day(6) }, situation("staying in Lisbon"));
    expect(settle(rule, [sameValue, his]).claims.map((one) => one.id)).toEqual([his.claim.id]);
    const goals = BELIEF_RULES.goal as NonNullable<(typeof BELIEF_RULES)["goal"]>;
    const hisGoal = record(4, { assertedBy: OWNER_ENTITY, basis: "explicit_self" }, goal(OWNER_ENTITY));
    const heardGoal = record(5, { validFrom: day(9) }, goal(OWNER_ENTITY));
    expect(settle(goals, [heardGoal, hisGoal]).claims.map((one) => one.id)).toEqual([hisGoal.claim.id]);
    // With no word of the owner's on the key, the heard claim is the belief's.
    expect(settle(goals, [heardGoal]).claims.map((one) => one.id)).toEqual([heardGoal.claim.id]);
  });

  it("two claims of one meeting credited to nobody are one party: one statement read in two windows disputes nothing", () => {
    const role = (n: number, title: string, evidenceN: number) =>
      claimOf(
        "seg:4-40",
        {
          id: ClaimId.parse(String(n).repeat(64).slice(0, 64)),
          validFrom: day(n),
          evidence: [{ evidenceId: evidence(evidenceN), span: "seg:4-40" }],
          primaryEvidenceId: evidence(evidenceN),
        },
        { type: "role", subject: NORA, fields: { title, organization_name: "Alder" } },
      );
    expect(differs([role(1, "head of finance", 7), role(2, "head of finances", 7)])).toBe(false);
    // Two meetings are two parties, as two unresolved mail authors are.
    expect(differs([role(1, "head of finance", 7), role(2, "head of finances", 8)])).toBe(true);
  });

  it("only the capture lanes write a seg: span: no other source file of the extract package forms one", async () => {
    const root = join(import.meta.dirname);
    const writers: string[] = [];
    for (const name of await readdir(root)) {
      if (!name.endsWith(".ts") || name.includes(".test.") || /testing|test-support/.test(name)) continue;
      const code = (await readFile(join(root, name), "utf8"))
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"));
      if (code.some((line) => /[`"']seg:/.test(line))) writers.push(name);
    }
    // The meeting lane's passages and turns (turns.ts), the moment lane's plan and the meeting
    // prompt's example.
    expect(writers.sort()).toEqual(["meeting-prompts.ts", "moments-plan.ts", "turns.ts"]);
  });
});

// An agent's close of a commitment, a reversal of origin agent_close under the commitment's own
// fact key and label, counted by the commitment rule beside the claim it closes.
describe("an agent's close of a commitment", () => {
  const promise = {
    type: "commitment",
    subject: NORA,
    fields: { counterparty: OWNER_ENTITY, what: "I will return the stove." },
    factKey: "fact-nora-stove",
  } as const;
  const closeOf = (n: number, at: string): Shape => ({
    ...promise,
    n,
    at,
    by: null,
    basis: "third_party",
    statementKind: "reversal",
    origin: "agent_close",
  });

  it("closes the commitment it names, as of its evidence", async () => {
    const store = await fresh();
    put(store, { ...promise, n: 1, at: day(0) }, closeOf(2, day(3)));
    await rebuildBeliefs(deps(store));
    expect(only(store)?.status).toBe("closed");
    // A close is the commitment's end, not a dispute.
    expect(only(store)?.disputed).toBe(false);
  });

  it("invariant 11: anything said after its evidence, the owner's promise or the subject's, reopens the commitment", async () => {
    const store = await fresh();
    put(store, { ...promise, n: 1, at: day(0) }, closeOf(2, day(3)), { ...promise, n: 3, at: day(5) });
    await rebuildBeliefs(deps(store));
    expect(only(store)?.status).not.toBe("closed");
    expect(only(store)?.disputed).toBe(false);
  });

  it("a close of nothing builds nothing, and one older than every claim it would close counts not", async () => {
    const alone = await fresh();
    put(alone, closeOf(2, day(3)));
    await rebuildBeliefs(deps(alone));
    expect(alone.beliefs(OWN)).toEqual([]);
    const older = await fresh();
    put(older, closeOf(2, day(0)), { ...promise, n: 3, at: day(5) });
    await rebuildBeliefs(deps(older));
    expect(only(older)?.status).not.toBe("closed");
  });

  it("is never the owner's word: its tier is agent_closed, and the belief keeps its promise's tier", async () => {
    const records = [record({ ...promise, n: 1, at: day(0) }), record(closeOf(2, day(3)))].map(
      (one): BeliefClaim => ({ claim: one.claim, origin: one.origin, subjectKind: one.subjectKind }),
    );
    expect(claimTier(records[1] as BeliefClaim, true)).toBe("agent_closed");
    expect(beliefTier(records)).toBe(beliefTier([records[0] as BeliefClaim]));
    expect(settle(BELIEF_RULES.commitment!, records).claims.map((claim) => claim.id)).toEqual([
      "claim-001",
      "claim-002",
    ]);
  });
});
