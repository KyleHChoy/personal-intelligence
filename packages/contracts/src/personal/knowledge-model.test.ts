import {
  BeliefLine,
  BeliefRecord,
  BeliefTier,
  ClaimRecord,
  ClaimTier,
  DECISION_DETAILS,
  ENTITY_LINES,
  FACT_GROUP_MAX,
  FactGrouping,
  FactRulingVerdict,
  GroupingBand,
  GroupingMode,
  GroupingState,
  KEY_FIELDS,
  keyPhraseOf,
  LIFE_DOMAINS,
  LifeDomain,
  PAIR_CALLS_PER_RUN,
  PAIR_KEYS,
  PersonalToolArgs,
  PersonalUnmappedReason,
  SAME_FACT_CARDS_PER_DAY,
  SELF_BRIEF_KINDS,
  SELF_SECTION_LINES,
  SELF_SECTION_PEOPLE,
  SectionDomain,
  SelfSection,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { claim } from "../test-samples.ts";

// Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("the knowledge model's shared shapes", () => {
  it("the twelve life domains, a closed list", () => {
    expect([...LIFE_DOMAINS]).toEqual([
      "career",
      "ventures",
      "education",
      "money",
      "health",
      "family",
      "relationships",
      "faith",
      "home",
      "travel",
      "interests",
      "admin",
    ]);
    expect(Object.isFrozen(LIFE_DOMAINS)).toBe(true);
    for (const domain of LIFE_DOMAINS) expect(accepts(LifeDomain, domain), domain).toBe(true);
    for (const domain of ["work", "Career", "", "other"]) expect(accepts(LifeDomain, domain), domain).toBe(false);
  });

  it("key fields for the six owner-side kinds and view, status and visited, the phrase among them (a view's among its values), domain first for the six", () => {
    expect(Object.keys(KEY_FIELDS).sort()).toEqual([...SELF_BRIEF_KINDS, "view", "status", "visited"].sort());
    expect(Object.isFrozen(KEY_FIELDS)).toBe(true);
    for (const [kind, fields] of Object.entries(KEY_FIELDS)) {
      if (SELF_BRIEF_KINDS.includes(kind as never)) expect(fields.key[0], kind).toBe("domain");
      // The phrase is in the key, or, for a view keyed by its topic, among its values.
      expect([...fields.key, ...("value" in fields ? fields.value : [])], kind).toContain(fields.phrase);
    }
    // A status keys by its organization and process, its state a
    // value; a visit by its place; a status's and a visit's domain a value.
    expect(KEY_FIELDS.view).toEqual({ phrase: "view", key: ["domain", "topic"], value: ["view"] });
    expect(KEY_FIELDS.status).toEqual({
      phrase: "process",
      key: ["organization_name", "process"],
      value: ["domain", "state", "since"],
    });
    expect(KEY_FIELDS.visited).toEqual({ phrase: "place", key: ["place"], value: ["domain", "when"] });
    expect(KEY_FIELDS.goal.phrase).toBe("objective");
    expect([KEY_FIELDS.need.phrase, KEY_FIELDS.capability.phrase]).toEqual(["object", "object"]);
    expect(KEY_FIELDS.preference.key).toEqual(["domain", "object", "polarity"]);
    expect(KEY_FIELDS.constraint.phrase).toBe("rule");
    expect(KEY_FIELDS.situation).toEqual({ phrase: "state", key: ["domain", "state"], value: ["momentary"] });
  });

  it("claim tiers in rank order, observed between owner_confirmed and source, system_notice between observed and source; a belief's tier is never agent_inferred", () => {
    // An agent's close of a commitment, below every source; never a belief's tier.
    // owner_relayed, the answer from the owner an agent relayed, below their card confirmations.
    // agent_confirmed, a second agent's confirm the owner has not answered, the lowest a belief may take.
    expect(ClaimTier.options).toEqual([
      "owner",
      "owner_confirmed",
      "owner_relayed",
      "observed",
      "system_notice",
      "source",
      "researched",
      "agent_confirmed",
      "agent_closed",
      "agent_inferred",
    ]);
    // researched and agent_confirmed, below every source, can be a belief's tier.
    expect(BeliefTier.options).toEqual([
      "owner",
      "owner_confirmed",
      "owner_relayed",
      "observed",
      "system_notice",
      "source",
      "researched",
      "agent_confirmed",
    ]);
    expect(accepts(BeliefTier, "agent_inferred")).toBe(false);
    expect(accepts(BeliefTier, "agent_closed")).toBe(false);
    expect(accepts(ClaimTier, "agent_reported")).toBe(false);
  });

  it("keyPhraseOf: an owner-side kind's key phrase, else the legacy what, else undefined", () => {
    expect(keyPhraseOf("goal", { domain: "career", objective: "ship the beta", what: "older words" })).toBe(
      "ship the beta",
    );
    expect(keyPhraseOf("preference", { domain: "interests", object: "em dashes", polarity: "avoids" })).toBe(
      "em dashes",
    );
    expect(keyPhraseOf("situation", { domain: "home", state: "moving flats", momentary: false })).toBe("moving flats");
    // A claim made before key fields has only `what`, as does a type with no key phrase.
    expect(keyPhraseOf("goal", { what: "Ship the beta by June." })).toBe("Ship the beta by June.");
    expect(keyPhraseOf("goal", { objective: "", what: "Ship the beta." })).toBe("Ship the beta.");
    expect(keyPhraseOf("commitment", { what: "I will send the report.", object: "not a key here" })).toBe(
      "I will send the report.",
    );
    // Nothing that is not a non-empty string, and nothing from the prototype.
    expect(keyPhraseOf("need", { object: 3 })).toBeUndefined();
    expect(keyPhraseOf("constructor", { what: 1 })).toBeUndefined();
    expect(keyPhraseOf("role", {})).toBeUndefined();
  });

  it("multi_fact and negated_object are unmapped reasons, after bad_speaker; not_standalone and not_what_was_said after them", () => {
    // not_first_hand comes after them, then the commitment bar's two, negation_cut and the three kind refusals.
    expect(PersonalUnmappedReason.options.slice(-12, -7)).toEqual([
      "bad_speaker",
      "multi_fact",
      "negated_object",
      "not_standalone",
      "not_what_was_said",
    ]);
  });

  it("E13: a claim record may carry its v1 fact key, and one without it is still valid", () => {
    const record = {
      claim,
      subjectKind: "owner",
      disclosure: [],
      factKey: "v2:goal",
      lane: "correspondence",
      fieldKinds: {},
      entities: [],
      origin: "source",
      answersSystem: false,
    };
    expect(accepts(ClaimRecord, record)).toBe(true);
    expect(accepts(ClaimRecord, { ...record, legacyFactKey: "v1:goal" })).toBe(true);
    expect(accepts(ClaimRecord, { ...record, legacyFactKey: "" })).toBe(false);
    expect(accepts(ClaimRecord, { ...record, legacy: "v1:goal" })).toBe(false);
  });

  it("R11, E16: a belief record may carry a belief tier, and one without it is still valid", () => {
    const belief = {
      kind: "goal",
      factKey: "f".repeat(64),
      supportHash: "a".repeat(64),
      subject: `ent_${ULID}`,
      type: "goal",
      values: {},
      label: { compartments: ["own"], readers: ["m-owner"] },
      status: "active",
      disputed: false,
      confidence: 1,
      lastConfirmedAt: at,
      changeKind: "backfill",
      support: ["b".repeat(64)],
    };
    const record = { belief, factKeyFp: "f".repeat(64), compartments: ["own"], provenance: "owner" };
    expect(accepts(BeliefRecord, record)).toBe(true);
    for (const tier of BeliefTier.options) expect(accepts(BeliefRecord, { ...record, tier }), tier).toBe(true);
    expect(accepts(BeliefRecord, { ...record, tier: "agent_inferred" })).toBe(false);
  });
});

describe("the grouping, ruling and outcome shapes", () => {
  const fp = (char: string): string => char.repeat(64);
  const grouping = {
    audience: ["agent:claude-code", "own"],
    keys: [fp("a"), fp("b")],
    band: "middle",
    rung: 1,
    state: "proposed",
    calls: ["dcc_01JABCDEFGHJKMNPQRSTVWXYZ0"],
  };

  it("the two rulings on two keys, and grouping's three modes", () => {
    expect(FactRulingVerdict.options).toEqual(["join", "split"]);
    expect(GroupingMode.options).toEqual(["off", "shadow", "apply"]);
    expect(GroupingBand.options).toEqual(["accept", "middle", "reject"]);
    expect(GroupingState.options).toEqual(["proposed", "accepted", "rejected", "joined", "split"]);
  });

  it("a fact_grouping row is ids, fingerprints and closed words, its keys and audience sorted", () => {
    expect(accepts(FactGrouping, grouping)).toBe(true);
    expect(accepts(FactGrouping, { ...grouping, rung: 0, calls: [] })).toBe(true);
    expect(accepts(FactGrouping, { ...grouping, keys: [fp("b"), fp("a")] })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, keys: [fp("a"), fp("a")] })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, audience: ["own", "agent:claude-code"] })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, audience: ["mailbox"] })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, rung: 3 })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, calls: ["call-1"] })).toBe(false);
    expect(accepts(FactGrouping, { ...grouping, phrase: "lives in portland" })).toBe(false);
  });

  it("the pinned caps", () => {
    expect([FACT_GROUP_MAX, PAIR_KEYS, PAIR_CALLS_PER_RUN, SAME_FACT_CARDS_PER_DAY]).toEqual([5, 10, 100, 5]);
    expect([SELF_SECTION_LINES, SELF_SECTION_PEOPLE, ENTITY_LINES]).toEqual([10, 5, 30]);
    expect(accepts(SectionDomain, "unsorted")).toBe(true);
    expect(accepts(SectionDomain, "career")).toBe(true);
    expect(accepts(SectionDomain, "other")).toBe(false);
  });

  it("a join or split names two fact keys, sorted; the lift takes nothing", () => {
    for (const kind of ["fact_join", "fact_split"] as const) {
      const details = DECISION_DETAILS[kind] as z.ZodType;
      expect(details, kind).toBeDefined();
      expect(accepts(details, { a: fp("a"), b: fp("b") }), kind).toBe(true);
      expect(accepts(details, { a: fp("b"), b: fp("a") }), kind).toBe(false);
      expect(accepts(details, { a: fp("a"), b: fp("a") }), kind).toBe(false);
      expect(accepts(details, { factKey: fp("a") }), kind).toBe(false);
    }
    expect(DECISION_DETAILS.fact_ruling_lift).toBeUndefined();
  });

  it("a belief record may carry its phrase claim, its group and the set's members", () => {
    const belief = {
      kind: "goal",
      factKey: fp("f"),
      supportHash: fp("a"),
      subject: `ent_${ULID}`,
      type: "goal",
      values: {},
      label: { compartments: ["own"], readers: ["m-owner"] },
      status: "active",
      disputed: false,
      confidence: 1,
      lastConfirmedAt: at,
      changeKind: "backfill",
      support: [fp("b")],
    };
    const record = { belief, factKeyFp: fp("f"), compartments: ["own"], provenance: "owner", tier: "owner" };
    expect(
      accepts(BeliefRecord, { ...record, phraseClaim: fp("b"), group: fp("c"), members: [fp("d"), fp("f")] }),
    ).toBe(true);
    expect(accepts(BeliefRecord, { ...record, members: [fp("f")] })).toBe(false);
    expect(accepts(BeliefRecord, { ...record, members: ["1", "2", "3", "4", "5", "6"].map(fp) })).toBe(false);
    expect(accepts(BeliefRecord, { ...record, group: "group-1" })).toBe(false);
  });

  it("a belief line has an until or a by, never both, and a tier or null", () => {
    const line = {
      fact: fp("a"),
      kind: "goal",
      domain: "career",
      line: { untrusted: "Goal: ship the beta" },
      tier: null,
      status: "active",
      since: at,
      at,
      cites: 2,
    };
    expect(accepts(BeliefLine, line)).toBe(true);
    expect(accepts(BeliefLine, { ...line, by: "2026-11-01", channel: "claude-code" })).toBe(true);
    expect(accepts(BeliefLine, { ...line, by: "2026-11-01", until: "2026-11-02" })).toBe(false);
    expect(accepts(BeliefLine, { ...line, line: "Goal: ship the beta" })).toBe(false);
    expect(accepts(BeliefLine, { ...line, cites: 0 })).toBe(false);
    expect(accepts(BeliefLine, { ...line, tier: "agent_inferred" })).toBe(false);
  });

  it("get_self takes a domain, find_facts a line's fact, and a section is bounded", () => {
    expect(accepts(PersonalToolArgs.get_self, { domain: "career", history: true })).toBe(true);
    expect(accepts(PersonalToolArgs.get_self, { domain: "unsorted" })).toBe(false);
    expect(accepts(PersonalToolArgs.find_facts, { belief: fp("a") })).toBe(true);
    expect(accepts(PersonalToolArgs.find_facts, { belief: "goal" })).toBe(false);
    const section = { domain: "career", lines: [], people: [], activeAt: at, more: false };
    expect(accepts(SelfSection, section)).toBe(true);
    const person = { who: { id: `ent_${ULID}`, kind: "person", name: null, address: null }, claims: 1 };
    expect(accepts(SelfSection, { ...section, people: Array.from({ length: 5 }, () => person) })).toBe(true);
    expect(accepts(SelfSection, { ...section, people: Array.from({ length: 6 }, () => person) })).toBe(false);
  });
});
