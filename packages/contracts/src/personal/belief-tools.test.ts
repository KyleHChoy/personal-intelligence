import {
  BeliefList,
  GetBeliefsArgs,
  PersonalReadTool,
  PersonalToolArgs,
  SearchArgs,
  SearchResult,
  TimelineEntry,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// get_beliefs, the match mode of search and the timeline's facts. Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const who = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const fact = {
  id: "c".repeat(64),
  type: "need",
  subject: who,
  statedBy: who,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at,
  message: `msg_${ULID}`,
  thirdParty: true,
  agentReported: false,
  provenance: "source",
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  fields: { what: { untrusted: "A designer for the spring launch." } },
};
const belief = {
  fact: "a".repeat(64),
  state: "b".repeat(64),
  kind: "need",
  type: "need",
  status: "active",
  disputed: false,
  provenance: "source",
  confirmedAt: at,
  reviewAfter: null,
  subject: who,
  values: {},
  cites: [fact],
};

describe("get_beliefs", () => {
  it("is a read tool of the people view, and its arguments are GetBeliefsArgs", () => {
    expect(PersonalReadTool.options).toContain("get_beliefs");
    expect(TOOL_VIEW.get_beliefs).toBe("people");
    expect(PersonalToolArgs.get_beliefs).toBe(GetBeliefsArgs);
  });

  it("get_beliefs refuses a limit of 51 and an unknown kind", () => {
    expect(accepts(GetBeliefsArgs, {})).toBe(true);
    expect(accepts(GetBeliefsArgs, { kind: "role", entity: `ent_${ULID}`, state: "any", limit: 50 })).toBe(true);
    expect(accepts(GetBeliefsArgs, { limit: 1 })).toBe(true);
    expect(accepts(GetBeliefsArgs, { limit: 51 })).toBe(false);
    expect(accepts(GetBeliefsArgs, { limit: 0 })).toBe(false);
    expect(accepts(GetBeliefsArgs, { kind: "title" })).toBe(false);
    expect(accepts(GetBeliefsArgs, { state: "overdue" })).toBe(false);
    expect(accepts(GetBeliefsArgs, { entity: "alex@example.com" })).toBe(false);
    expect(accepts(GetBeliefsArgs, { audience: ["own"] })).toBe(false);
    const schema = z.toJSONSchema(GetBeliefsArgs, { io: "input" }) as { type?: string; additionalProperties?: boolean };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("a belief list is strict, and each belief cites at least one claim", () => {
    expect(accepts(BeliefList, { beliefs: [belief], more: false })).toBe(true);
    expect(accepts(BeliefList, { beliefs: [], more: true })).toBe(true);
    expect(accepts(BeliefList, { beliefs: [belief] })).toBe(false);
    expect(accepts(BeliefList, { beliefs: [{ ...belief, cites: [] }], more: false })).toBe(false);
    expect(accepts(BeliefList, { beliefs: [belief], more: false, extra: 1 })).toBe(false);
  });
});

describe("search's modes", () => {
  it("search refuses an unknown mode, and a names search parses as before", () => {
    expect(SearchArgs.parse({ query: "alex" })).toEqual({ query: "alex" });
    expect(accepts(SearchArgs, { query: "alex", limit: 25 })).toBe(true);
    for (const mode of ["names", "needs", "capabilities"])
      expect(accepts(SearchArgs, { query: "designer", mode })).toBe(true);
    expect(accepts(SearchArgs, { query: "designer", mode: "roles" })).toBe(false);
    expect(accepts(SearchArgs, { query: "designer", mode: "" })).toBe(false);
  });

  it("a match mode's answer holds matches and more, each match a fact and a positive whole score", () => {
    expect(accepts(SearchResult, { results: [] })).toBe(true);
    expect(accepts(SearchResult, { results: [], matches: [{ fact, score: 2 }], more: false })).toBe(true);
    expect(accepts(SearchResult, { results: [], matches: [{ fact, score: 0 }], more: false })).toBe(false);
    expect(accepts(SearchResult, { results: [], matches: [{ fact, score: 1.5 }], more: false })).toBe(false);
    expect(accepts(SearchResult, { results: [], matches: [{ fact, score: 1 }] })).toBe(false);
    expect(accepts(SearchResult, { results: [], more: true })).toBe(false);
    expect(
      accepts(SearchResult, {
        results: [],
        matches: [{ fact: { ...fact, fields: { what: "plain" } }, score: 1 }],
        more: false,
      }),
    ).toBe(false);
  });
});

describe("the timeline's facts", () => {
  it("a timeline entry may be a fact, a strict FactView at a time", () => {
    expect(accepts(TimelineEntry, { kind: "fact", at, fact })).toBe(true);
    expect(accepts(TimelineEntry, { kind: "fact", at })).toBe(false);
    expect(accepts(TimelineEntry, { kind: "fact", at, fact, extra: 1 })).toBe(false);
    expect(accepts(TimelineEntry, { kind: "fact", at, fact: { ...fact, type: "title" } })).toBe(false);
  });
});
