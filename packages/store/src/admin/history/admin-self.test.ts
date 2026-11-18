import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { wordsOf } from "./admin-self.ts";

// A Self row's words are a sentence, never `name: value` joined by "; ". One raw-shaped claim
// of every kind the Self room can show about the owner, made-up words only.

const ORG = "ent_01J00000000000000000000009";
const record = (type: string, fields: Record<string, unknown>, fieldKinds: Record<string, string> = {}): ClaimRecord =>
  ({
    claim: { content: { type, subject: "ent_01J00000000000000000000001", fields } },
    fieldKinds,
  }) as unknown as ClaimRecord;

const CASES: [string, ClaimRecord, string][] = [
  [
    "a goal, version 4",
    record(
      "goal",
      { objective: "run a marathon", domain: "health", by: "2027-03-01" },
      { objective: "text", domain: "enum", by: "date" },
    ),
    "Run a marathon, by 1 Mar 2027",
  ],
  [
    "a goal, version 3",
    record("goal", { what: "I want to learn to sail", by: "2027-06-30" }, { what: "text", by: "date" }),
    "I want to learn to sail, by 30 Jun 2027",
  ],
  [
    "a need",
    record("need", { object: "a quiet desk", domain: "home" }, { object: "text", domain: "enum" }),
    "A quiet desk",
  ],
  [
    "a capability",
    record("capability", { object: "woodworking", domain: "interests" }, { object: "text", domain: "enum" }),
    "Woodworking",
  ],
  [
    "a preference",
    record(
      "preference",
      { object: "window seats", domain: "travel", polarity: "prefers" },
      { object: "text", domain: "enum", polarity: "enum" },
    ),
    "Prefers window seats",
  ],
  [
    "an avoided thing",
    record(
      "preference",
      { object: "early calls", domain: "career", polarity: "avoids" },
      { object: "text", domain: "enum", polarity: "enum" },
    ),
    "Avoids early calls",
  ],
  [
    "a preference, version 3",
    record("preference", { what: "Likes long walks", polarity: "likes" }, { what: "text", polarity: "enum" }),
    "Likes long walks",
  ],
  [
    "a constraint",
    record(
      "constraint",
      { rule: "no travel in December", domain: "travel", until: "2027-01-01" },
      { rule: "text", domain: "enum", until: "date" },
    ),
    "No travel in December, until 1 Jan 2027",
  ],
  [
    "a situation",
    record(
      "situation",
      { state: "between flats", domain: "home", momentary: false },
      { state: "text", domain: "enum", momentary: "boolean" },
    ),
    "Between flats",
  ],
  [
    "a role, named",
    record(
      "role",
      { title: "Head of Example", organization_name: "Example Co" },
      { title: "text", organization_name: "text" },
    ),
    "Head of Example at Example Co",
  ],
  [
    "a role, by entity",
    record("role", { title: "Head of Example", organization: ORG }, { title: "text", organization: "entity" }),
    "Head of Example at Sample Works",
  ],
  [
    "an affiliation",
    record("affiliation", { relation: "founder", organization: ORG }, { relation: "enum", organization: "entity" }),
    "Founder at Sample Works",
  ],
  [
    "an unknown kind",
    record(
      "something_else",
      { label: "a thing said", count: 3, who: ORG },
      { label: "text", count: "number", who: "entity" },
    ),
    "A thing said (3)",
  ],
  [
    "an unknown kind, its text after a list's value",
    record("something_else", { kind: "day_trip", note: "the coast in spring" }, { kind: "enum", note: "text" }),
    "The coast in spring (day trip)",
  ],
  [
    "an unknown kind, a list's value alone",
    record("something_else", { kind: "day_trip" }, { kind: "enum" }),
    "Day trip",
  ],
];

describe("wordsOf", () => {
  for (const [name, one, words] of CASES)
    it(`${name}: a sentence, no field name`, () => {
      const said = wordsOf(one, new Map([[ORG, "Sample Works"]]));
      expect(said).toBe(words);
      expect(said).not.toMatch(/\b[a-z_]+: /);
      expect(said).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });
});
