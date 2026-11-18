import { readFileSync } from "node:fs";
import {
  AboutArgs,
  AboutView,
  AgentRecordAck,
  AgentRecordArgs,
  AREAS,
  AreaTable,
  BeliefAt,
  CLAIM_REFUSAL_HINTS,
  ClaimRefusal,
  ClaimRelation,
  ClaimRelationKind,
  GoalReview,
  InputKey,
  PersonalClaimOrigin,
  PersonalReadTool,
  PersonalSourceKind,
  PersonalToolArgs,
  Provenance,
  READ_BUDGET,
  RelationJudge,
  RelationRules,
  SourceCheckAnswer,
  TOOL_VIEW,
  TypedClaimArgs,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

const ULID = "01J00000000000000000000000";
const EVIDENCE = "a".repeat(64);
const ontology = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../ontology/${name}`, import.meta.url), "utf8"));
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

const claim = {
  subject: { id: `ent_${ULID}` },
  type: "role",
  fields: { title: "head of research", organization_name: "Example Labs" },
  cites: [{ evidenceId: EVIDENCE, span: { start: 0, end: 12 } }],
  requestId: "typed-claim-1",
};

describe("typed claims", () => {
  it("takes a typed claim of a known type with its fields", () => {
    expect(accepts(TypedClaimArgs, claim)).toBe(true);
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "goal",
        fields: { domain: "career", objective: "raise a seed round" },
        cites: [],
      }),
    ).toBe(true);
  });

  it("takes every belief kind the ontology keys, an entity field by its id", () => {
    const person = `ent_${ULID}`;
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "relationship",
        fields: { counterparty: person, relation: "colleague" },
      }),
    ).toBe(true);
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "commitment",
        fields: { counterparty: person, what: "send the deck", due: "2030-01-02" },
      }),
    ).toBe(true);
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "consent",
        fields: { about: "introduce", what: "happy to be introduced" },
      }),
    ).toBe(true);
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "contact_rule",
        fields: { rule: "prefers_channel", channel: "email", what: "email only" },
      }),
    ).toBe(true);
    expect(
      accepts(TypedClaimArgs, {
        ...claim,
        type: "relationship",
        fields: { counterparty: "Pat", relation: "colleague" },
      }),
    ).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, type: "project.status", fields: { status: "active" } })).toBe(false);
  });

  it("refuses an unknown type, and a field outside the type's key and value fields", () => {
    expect(accepts(TypedClaimArgs, { ...claim, type: "favourite_colour" })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, fields: { ...claim.fields, salary: "high" } })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, fields: { organization_name: "Example Labs" } })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, type: "goal" })).toBe(false);
  });

  it("refuses more than 20 cites", () => {
    const cites = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ evidenceId: EVIDENCE, span: { start: i, end: i + 1 } }));
    expect(accepts(TypedClaimArgs, { ...claim, cites: cites(20) })).toBe(true);
    expect(accepts(TypedClaimArgs, { ...claim, cites: cites(21) })).toBe(false);
  });

  it("refuses a subject that is not exactly one of id, address or name", () => {
    expect(accepts(TypedClaimArgs, { ...claim, subject: { address: "someone@example.com" } })).toBe(true);
    expect(accepts(TypedClaimArgs, { ...claim, subject: { name: "Example Person" } })).toBe(true);
    expect(accepts(TypedClaimArgs, { ...claim, subject: `ent_${ULID}` })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, subject: { id: `ent_${ULID}`, name: "Example Person" } })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, subject: {} })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, subject: { email: "someone@example.com" } })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, subject: { address: "not an address" } })).toBe(false);
  });

  it("refuses a label, a tier or a key in a typed claim", () => {
    expect(accepts(TypedClaimArgs, { ...claim, tier: "owner" })).toBe(false);
    expect(accepts(TypedClaimArgs, { ...claim, compartments: ["own"] })).toBe(false);
  });

  it("still takes every record a live agent sends today, and claims only on a finding", () => {
    expect(accepts(AgentRecordArgs, { kind: "finding", body: "found it", requestId: "record-0001" })).toBe(true);
    expect(
      accepts(AgentRecordArgs, { kind: "note", body: "a note", cites: [`msg_${ULID}`], requestId: "record-0002" }),
    ).toBe(true);
    expect(
      accepts(AgentRecordArgs, { kind: "finding", body: "found it", claims: [claim], requestId: "record-0003" }),
    ).toBe(true);
    expect(accepts(AgentRecordArgs, { kind: "note", body: "a note", claims: [claim], requestId: "record-0004" })).toBe(
      false,
    );
    // Each typed claim stands alone: a finding whose second claim names an unknown type or
    // fields outside its type's still parses, so its write path can refuse that claim by its index
    // (fields_invalid) and commit the first.
    const bad = [
      { ...claim, requestId: "typed-claim-2", type: "favourite_colour" },
      { ...claim, requestId: "typed-claim-3", fields: { salary: "high" } },
    ];
    for (const one of bad)
      expect(
        accepts(AgentRecordArgs, { kind: "finding", body: "found it", claims: [claim, one], requestId: "record-0005" }),
      ).toBe(true);
    expect(
      accepts(AgentRecordArgs, {
        kind: "finding",
        body: "found it",
        claims: [{ ...claim, subject: {} }],
        requestId: "record-0006",
      }),
    ).toBe(false);
    expect(accepts(AgentRecordAck, { recordId: `rec_${ULID}` })).toBe(true);
  });

  it("declares the four refusal codes, each with a fixed hint, and the write ack's additions", () => {
    for (const code of ["finding_untyped", "subject_ambiguous", "subject_unknown", "fields_invalid"]) {
      expect(ClaimRefusal.options).toContain(code);
      expect(CLAIM_REFUSAL_HINTS[code as ClaimRefusal].length).toBeGreaterThan(0);
    }
    const ack = {
      recordId: `rec_${ULID}`,
      duplicates: [{ claimKey: "b".repeat(64), factKey: "c".repeat(64) }],
      known: [{ subject: `ent_${ULID}`, factKeys: ["c".repeat(64)] }],
      refused: [{ index: 0, code: "subject_ambiguous", candidates: [`ent_${ULID}`] }],
    };
    expect(accepts(AgentRecordAck, ack)).toBe(true);
    expect(accepts(AgentRecordAck, { ...ack, refused: [{ index: 0, code: "no_such_code" }] })).toBe(false);
  });
});

describe("relations", () => {
  const relation = {
    from: "b".repeat(64),
    to: "c".repeat(64),
    kind: "supersedes",
    judge: "rule:reversal",
    passages: [],
    applied: true,
    judgedAt: "2026-10-23T00:00:00Z",
  };

  it("takes each kind of the closed set and refuses any other", () => {
    expect(ClaimRelationKind.options).toEqual([
      "supersedes",
      "contradicts",
      "fulfils",
      "refines",
      "same_fact",
      "prevails",
    ]);
    for (const kind of ClaimRelationKind.options) expect(accepts(ClaimRelation, { ...relation, kind })).toBe(true);
    expect(accepts(ClaimRelation, { ...relation, kind: "merges" })).toBe(false);
    expect(accepts(ClaimRelation, { ...relation, to: relation.from })).toBe(false);
  });

  it("names its judge as a rule, a model and prompt version, or an owner ruling", () => {
    expect(accepts(RelationJudge, "rule:evidence_order")).toBe(true);
    expect(accepts(RelationJudge, "model:openrouter/some-model@personal_claim_relations@1")).toBe(true);
    expect(accepts(RelationJudge, "model:openrouter/some-model")).toBe(false);
    expect(accepts(RelationJudge, `owner:rul_${ULID}`)).toBe(true);
    expect(accepts(RelationJudge, "owner:someone")).toBe(false);
    expect(accepts(RelationJudge, "agent:hermes")).toBe(false);
  });
});

describe("about and the computed belief", () => {
  it("is a read tool, served with the people view as a list tool", () => {
    expect(PersonalReadTool.options).toContain("about");
    expect(TOOL_VIEW.about).toBe("people");
    expect(READ_BUDGET.about).toBe("list");
    expect(PersonalToolArgs.about).toBe(AboutArgs);
  });

  it("answers candidates and builds nothing, or a subject and its picture", () => {
    const candidate = { id: `ent_${ULID}`, kind: "person", name: { untrusted: "Example Person" }, matched: "name" };
    const empty = {
      beliefs: [],
      claims: [],
      claimCount: 0,
      commitments: [],
      toOwner: null,
      connections: [],
      links: [],
      knownVia: null,
      mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: null,
      nextMeeting: null,
      warmth: null,
      asOf: "2026-10-23T00:00:00Z",
      next: null,
    };
    expect(accepts(AboutView, { ...empty, subject: null, candidates: [candidate] })).toBe(true);
    expect(accepts(AboutView, { ...empty, subject: null, candidates: [] })).toBe(false);
    expect(
      accepts(AboutView, { ...empty, subject: { id: `ent_${ULID}`, kind: "person", name: null }, candidates: [] }),
    ).toBe(true);
    // Candidates build nothing: no commitment, no tie and no page token beside them.
    expect(
      accepts(AboutView, {
        ...empty,
        subject: null,
        candidates: [candidate],
        commitments: [{ factKey: "c".repeat(64), direction: "owed_by_owner" }],
      }),
    ).toBe(false);
    expect(accepts(AboutView, { ...empty, subject: null, candidates: [candidate], next: "x" })).toBe(false);
  });

  it("refuses an unknown area and a subject not named exactly one way", () => {
    expect(accepts(AboutArgs, { subject: { name: "Example Person" }, areas: ["work", "ties"] })).toBe(true);
    expect(accepts(AboutArgs, { subject: { name: "Example Person" }, areas: ["gossip"] })).toBe(false);
    expect(accepts(AboutArgs, { subject: { name: "Example Person" }, areas: ["work", "work"] })).toBe(false);
    expect(accepts(AboutArgs, { subject: { name: "Example Person", address: "someone@example.com" } })).toBe(false);
  });

  it("serves a belief's dispute marks and how it was settled", () => {
    const belief = {
      kind: "role",
      factKey: "c".repeat(64),
      value: { title: { untrusted: "head of research" } },
      status: "active",
      tier: "source",
      provenance: "source",
      disputed: true,
      settledBy: "rule",
      independentSources: 2,
      canonical: "e".repeat(64),
      support: [
        {
          fact: "e".repeat(64),
          speaker: `ent_${ULID}`,
          at: "2026-10-01T00:00:00Z",
          span: { start: 0, end: 4 },
          tier: "source",
        },
      ],
      supportCount: 1,
      relations: [
        { id: "3", from: "b".repeat(64), to: "d".repeat(64), kind: "prevails", judge: "rule:evidence_order" },
      ],
      asOf: "2026-10-23T00:00:00Z",
    };
    expect(accepts(BeliefAt, belief)).toBe(true);
    expect(accepts(BeliefAt, { ...belief, tier: "agent_inferred" })).toBe(false);
    expect(accepts(BeliefAt, { ...belief, settledBy: "owner" })).toBe(false);
  });

  it("keeps Provenance's values in step with tools-views.ts", () => {
    expect(BeliefAt.shape.provenance.options).toEqual(Provenance.options);
  });

  it("keys a saved value by its sorted inputs", () => {
    const key = {
      clearance: ["own"],
      claimKeys: ["b".repeat(64), "c".repeat(64)],
      generation: 1,
      rulingSeq: 0,
      erasureSeq: 0,
      rulesVersion: 1,
    };
    expect(accepts(InputKey, key)).toBe(true);
    expect(accepts(InputKey, { ...key, claimKeys: ["c".repeat(64), "b".repeat(64)] })).toBe(false);
  });
});

describe("owner_command", () => {
  it("is an origin and a source kind", () => {
    expect(PersonalClaimOrigin.options).toContain("owner_command");
    expect(PersonalSourceKind.options).toContain("owner_command");
  });
});

describe("rule data", () => {
  it("the area table in ontology/ loads and names only belief kinds the ontology has", () => {
    const table = AreaTable.parse(ontology("areas.json"));
    expect(Object.keys(table.areas).sort()).toEqual([...AREAS].sort());
    const kept = new Set(
      [
        ...readFileSync(new URL("../../../../ontology/belief-kinds.yaml", import.meta.url), "utf8").matchAll(
          /^ {2}([a-z_]+):/gm,
        ),
      ].map((match) => match[1]),
    );
    // The personal-only kinds (capture_project, interest, view, status, visited) are in the
    // contract's BeliefKind, which the table's schema checks; the rest are in belief-kinds.yaml too.
    const personalOnly = new Set(["capture_project", "interest", "view", "status", "visited"]);
    for (const area of Object.values(table.areas))
      for (const kind of area.kinds) expect(kept.has(kind) || personalOnly.has(kind)).toBe(true);
    expect(accepts(AreaTable, { ...table, areas: { ...table.areas, self: { kinds: ["horoscope"] } } })).toBe(false);
  });

  it("the relations table in ontology/ loads and refuses a threshold outside 0 to 1", () => {
    const table = RelationRules.parse(ontology("relations.json"));
    expect(table.switch.precisionMin).toBe(0.95);
    expect(accepts(RelationRules, { ...table, switch: { ...table.switch, precisionMin: 1.2 } })).toBe(false);
    expect(accepts(RelationRules, { ...table, switch: { ...table.switch, overturnRateMax: -0.01 } })).toBe(false);
    expect(
      accepts(RelationRules, { ...table, evidenceOrder: [...table.evidenceOrder.slice(1), table.evidenceOrder[1]] }),
    ).toBe(false);
    // The dream pass's budget, the source check's sample and the audit.
    expect(table.dream).toMatchObject({ sourceChecksPerNight: 50, auditShare: 0.1, auditsPerDay: 1 });
    // The kinds on by each finding's own check are relation kinds, never a merge of two people.
    expect(table.switch.checkedEachKinds).toEqual(expect.arrayContaining(["same_fact"]));
    expect(accepts(RelationRules, { ...table, switch: { ...table.switch, checkedEachKinds: ["same_person"] } })).toBe(
      false,
    );
    expect(accepts(RelationRules, { ...table, dream: { ...table.dream, auditShare: 1.5 } })).toBe(false);
  });

  it("the source check's answer: a closed verdict and cites that name their passage", () => {
    expect(
      accepts(SourceCheckAnswer, { verdict: "supported", cites: [{ passage: 1, text: "joined Alder in May" }] }),
    ).toBe(true);
    expect(accepts(SourceCheckAnswer, { verdict: "unsupported", cites: [] })).toBe(true);
    expect(accepts(SourceCheckAnswer, { verdict: "maybe", cites: [] })).toBe(false);
    expect(accepts(SourceCheckAnswer, { verdict: "wrong", cites: [{ passage: 0, text: "x" }] })).toBe(false);
    expect(accepts(SourceCheckAnswer, { verdict: "wrong", cites: [], label: "own" })).toBe(false);
  });

  it("the goal review windows in ontology/ load: 60 days for a goal the owner set, 30 for one they stated", () => {
    expect(GoalReview.parse(ontology("goals.json"))).toEqual({ set: 60, stated: 30 });
    expect(accepts(GoalReview, { set: 0, stated: 30 })).toBe(false);
    expect(accepts(GoalReview, { set: 60 })).toBe(false);
  });
});
