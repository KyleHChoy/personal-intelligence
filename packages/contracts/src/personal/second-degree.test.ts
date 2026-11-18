import { describe, expect, it } from "vitest";
import {
  BeliefTier,
  ClaimTier,
  CONNECTION_KINDS,
  EntityView,
  FactType,
  FactView,
  FiledMention,
  Fill,
  INTRO_OFFERS,
  MentionedBy,
  PathHop,
  PathList,
  RELATIONSHIP_RELATIONS,
  SYMMETRIC_CONNECTIONS,
  Who,
} from "./index.ts";

// The shapes of the second degree. Made-up values only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const person = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const named = { id: `ent_${ULID}`, kind: "person", name: { untrusted: "Theo Marsh" }, address: null, nameOnly: true };
const fact = "a".repeat(64);
const base = {
  id: fact,
  subject: person,
  statedBy: person,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at,
  message: `msg_${ULID}`,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: true,
  agentReported: false,
  provenance: "source",
};

describe("the relations", () => {
  it("relationship gains acquaintance; offers are offered and suggested", () => {
    expect(RELATIONSHIP_RELATIONS).toContain("acquaintance");
    expect([...INTRO_OFFERS]).toEqual(["offered", "suggested"]);
    expect(FactType.options).toContain("intro_offer");
  });

  it("intro_offer takes person and offer and nothing else", () => {
    const offer = { ...base, type: "intro_offer", fields: { person: named, offer: "offered" } };
    expect(accepts(FactView, offer)).toBe(true);
    expect(accepts(FactView, { ...offer, fields: { person: named, offer: "suggested" } })).toBe(true);
    expect(accepts(FactView, { ...offer, fields: { person: named, offer: "promised" } })).toBe(false);
    expect(accepts(FactView, { ...offer, fields: { person: named } })).toBe(false);
    expect(accepts(FactView, { ...offer, fields: { offer: "offered" } })).toBe(false);
    expect(accepts(FactView, { ...offer, fields: { person: named, offer: "offered", relation: "friend" } })).toBe(
      false,
    );
  });
});

describe("a filing", () => {
  it("FiledMention takes firstHand, subjectFp and speakerFp, each optional, fingerprints of 64 hex", () => {
    const row = { name: "Theo Marsh", type: "relationship", field: "counterparty" };
    expect(accepts(FiledMention, row)).toBe(true);
    expect(
      accepts(FiledMention, { ...row, firstHand: true, subjectFp: "b".repeat(64), speakerFp: "c".repeat(64) }),
    ).toBe(true);
    expect(accepts(FiledMention, { ...row, subjectFp: "B".repeat(64) })).toBe(false);
    expect(accepts(FiledMention, { ...row, speakerFp: "c".repeat(63) })).toBe(false);
    expect(accepts(FiledMention, { ...row, firstHand: "yes" })).toBe(false);
  });
});

describe("a named person, served", () => {
  it("Who takes nameOnly true only", () => {
    expect(accepts(Who, named)).toBe(true);
    expect(accepts(Who, { ...named, nameOnly: false })).toBe(false);
  });

  it("EntityView takes nameOnly and at most 10 mentionedBy, each a relation or an offer", () => {
    const by = { by: person, relation: "colleague", fact, at };
    expect(accepts(MentionedBy, by)).toBe(true);
    expect(accepts(MentionedBy, { by: person, offer: "suggested", fact, at, heard: true })).toBe(true);
    expect(accepts(MentionedBy, { ...by, offer: "offered" })).toBe(false);
    expect(accepts(MentionedBy, { by: person, fact, at })).toBe(false);
    const card = {
      id: `ent_${ULID}`,
      kind: "person",
      names: [{ untrusted: "Theo Marsh" }],
      addresses: [],
      organization: null,
      people: [],
      mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: null,
      nextMeeting: null,
      details: [],
      shared: false,
    };
    expect(accepts(EntityView, card)).toBe(true);
    expect(accepts(EntityView, { ...card, nameOnly: true, mentionedBy: [by] })).toBe(true);
    expect(accepts(EntityView, { ...card, mentionedBy: Array.from({ length: 11 }, () => by) })).toBe(false);
  });
});

describe("hops", () => {
  it("a hop takes the new kinds, an offer exactly on an intro_offer hop, and a path at most 4 hops", () => {
    const hop = { from: person, to: named, via: "relationship", facts: [fact] };
    for (const via of ["acquaintance", "connection", "reported", "researched"])
      expect(accepts(PathHop, { ...hop, via }), via).toBe(true);
    expect(accepts(PathHop, { ...hop, via: "intro_offer", offer: "offered" })).toBe(true);
    expect(accepts(PathHop, { ...hop, via: "intro_offer" })).toBe(false);
    expect(accepts(PathHop, { ...hop, offer: "offered" })).toBe(false);
    const path = (n: number) => ({ paths: [{ score: 0.5, hops: Array.from({ length: n }, () => hop) }], cut: false });
    expect(accepts(PathList, path(4))).toBe(true);
    expect(accepts(PathList, path(5))).toBe(false);
  });

  it("propose_person's link kinds gain knows, symmetric", () => {
    expect(CONNECTION_KINDS).toContain("knows");
    expect(SYMMETRIC_CONNECTIONS).toContain("knows");
  });
});

describe("work and tiers", () => {
  it("researched ranks after source and before agent_closed, and can be a belief's tier", () => {
    const tiers = ClaimTier.options;
    expect(tiers.indexOf("researched")).toBe(tiers.indexOf("source") + 1);
    // A second agent's confirmation sits between them, the lowest a belief may take.
    expect(tiers.indexOf("agent_confirmed")).toBe(tiers.indexOf("researched") + 1);
    expect(tiers.indexOf("agent_closed")).toBe(tiers.indexOf("agent_confirmed") + 1);
    expect(accepts(BeliefTier, "researched")).toBe(true);
  });
});

describe("a fill", () => {
  const sources = [{ kind: "agent_record", id: `rec_${ULID}` }];
  it("takes each field optional, each citing its sources, and refuses an empty fill", () => {
    expect(accepts(Fill, { identity: { email: "theo@example.com", sources } })).toBe(true);
    expect(
      accepts(Fill, {
        identity: { linkedin: "https://www.linkedin.com/in/theo-marsh-example", sources: ["https://example.com/team"] },
      }),
    ).toBe(true);
    expect(accepts(Fill, { role: { title: "Head of Design", organization: { name: "Alder Example" }, sources } })).toBe(
      true,
    );
    expect(
      accepts(Fill, { affiliation: { organization: { domain: "alder.example" }, relation: "founder", sources } }),
    ).toBe(true);
    expect(
      accepts(Fill, {
        domain: { domain: "alder.example", sources },
        links: { urls: ["https://alder.example"], sources },
      }),
    ).toBe(true);
    expect(
      accepts(Fill, {
        relations: [
          { other: { entity: `ent_${ULID}` }, relation: "knows", sources },
          { other: { name: "Zoe Example" }, relation: "colleague", sources },
        ],
      }),
    ).toBe(true);
    expect(accepts(Fill, {})).toBe(false);
    expect(
      accepts(Fill, { identity: { email: "theo@example.com", linkedin: "https://www.linkedin.com/in/x", sources } }),
    ).toBe(false);
    expect(accepts(Fill, { identity: { email: "theo@example.com", sources: [] } })).toBe(false);
    expect(
      accepts(Fill, { role: { title: "Head", organization: { name: "Alder", domain: "alder.example" }, sources } }),
    ).toBe(false);
    expect(
      accepts(Fill, { links: { urls: Array.from({ length: 6 }, (_, i) => `https://alder.example/${i}`), sources } }),
    ).toBe(false);
    expect(accepts(Fill, { relations: [{ other: { name: "Zoe Example" }, relation: "rival", sources }] })).toBe(false);
    expect(accepts(Fill, { label: "own" })).toBe(false);
  });
});
