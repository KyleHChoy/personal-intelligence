import { describe, expect, it } from "vitest";
import { NEGATION_CUT_GENERATION } from "./check.ts";
import { EXTRACT_GENERATION } from "./config.ts";
import { checkCorrespondence, type EvalMessage, spanOf } from "./eval/eval-correspondence.ts";

// The exact match takes any run of a passage's words, so "take the offer" stands in "will not take
// the offer": the words are there and the fact is the reverse. An owner-side claim whose phrase
// starts after a negation of its clause is refused `negation_cut`, from the generation that holds the
// rule. Until that generation is raised every candidate passes as it did.

const OWNER = "sam@harbor.example";
const at = "2026-03-02T09:00:00.000Z";

async function said(
  sentence: string,
  type: string,
  fields: Record<string, unknown>,
  generation = NEGATION_CUT_GENERATION,
) {
  const message: EvalMessage = {
    id: "neg-01",
    from: OWNER,
    to: "lena.park@north.example",
    paragraphs: [sentence],
    expected: [],
  };
  const claim = {
    type,
    subject: { key: { kind: "address", value: OWNER }, observedAt: at },
    fields,
    statementKind: "stated_fact",
    basis: "explicit_self",
    span: await spanOf(message, sentence),
  };
  return checkCorrespondence(message, { claims: [claim], narrowing: "none" } as never, "4", generation);
}

const domain = "career";
const CUT = [
  ["didnt, no apostrophe", "I didnt sign the lease.", "situation", { state: "sign the lease", domain }],
  ["dont", "I dont want the Northwind job.", "goal", { objective: "want the Northwind job", domain }],
  ["wont", "We wont take the Lisbon offer.", "goal", { objective: "take the Lisbon offer", domain }],
  ["can't", "I can't attend the Lisbon summit.", "capability", { object: "attend the Lisbon summit", domain }],
  ["will not", "We will not take the offer.", "goal", { objective: "take the offer", domain }],
  ["never", "I have never led a Northwind team.", "capability", { object: "led a Northwind team", domain }],
  ["no longer", "I am no longer working at Northwind.", "situation", { state: "working at Northwind", domain }],
  ["not yet", "I have not yet signed the lease.", "situation", { state: "signed the lease", domain }],
  [
    "a negator later in the phrase",
    "I will not take the job with no equity.",
    "goal",
    { objective: "take the job with no equity", domain },
  ],
  ["over a comma", "I will not, under any terms, take the offer.", "goal", { objective: "take the offer", domain }],
] as const;

const KEPT = [
  [
    "the phrase holds its negation",
    "I am not moving to Lisbon.",
    "situation",
    { state: "not moving to Lisbon", domain },
  ],
  [
    "a negation in another sentence",
    "It is not cheap. I run the Lisbon office.",
    "situation",
    { state: "run the Lisbon office", domain },
  ],
  [
    "a negation before a contrast",
    "It is not cheap, but I run the Lisbon office.",
    "situation",
    { state: "run the Lisbon office", domain },
  ],
  [
    "a negation after the phrase",
    "I run the Lisbon office, not the Porto one.",
    "situation",
    { state: "run the Lisbon office", domain },
  ],
  ["no negation", "I will take the offer.", "goal", { objective: "take the offer", domain }],
  [
    "said plainly elsewhere too",
    "We will not sell. I will take the offer. We will not take the offer.",
    "goal",
    { objective: "take the offer", domain },
  ],
  [
    "a preference that says avoids: the model carried the negation",
    "I will not take the early meetings.",
    "preference",
    { object: "take the early meetings", domain, polarity: "avoids" },
  ],
] as const;

describe("negation_cut", () => {
  for (const [why, sentence, type, fields] of CUT) {
    it(`refuses: ${why}`, async () => {
      const result = await said(sentence, type, fields);
      expect(result.claims).toEqual([]);
      expect(result.unmapped.map((one) => one.reason)).toEqual(["negation_cut"]);
    });
    it(`until the generation is raised, passes as it did: ${why}`, async () => {
      const result = await said(sentence, type, fields, EXTRACT_GENERATION);
      expect(result.unmapped.map((one) => one.reason)).not.toContain("negation_cut");
    });
  }
  for (const [why, sentence, type, fields] of KEPT) {
    it(`keeps: ${why}`, async () => {
      const result = await said(sentence, type, fields);
      expect(result.unmapped.map((one) => one.reason)).not.toContain("negation_cut");
      expect(result.claims.length).toBe(1);
    });
  }

  it("keeps a status: its process is a label, and its outcome is in its state", async () => {
    const result = await said("We will not be moving forward with your application.", "status", {
      organization_name: "Northwind",
      process: "your application",
      state: "moving forward",
      domain,
    });
    expect(result.unmapped.map((one) => one.reason)).not.toContain("negation_cut");
  });

  it("leaves a type that is no owner-side kind as it is", async () => {
    const result = await said("We will not take the offer.", "plan", { what: "take the offer" });
    expect(result.unmapped.map((one) => one.reason)).not.toContain("negation_cut");
  });

  it("is held for the next generation: raising it is the owner's, and every stored item replays then", () => {
    expect(EXTRACT_GENERATION).toBeLessThan(NEGATION_CUT_GENERATION);
    expect(NEGATION_CUT_GENERATION).toBe(6);
  });
});
