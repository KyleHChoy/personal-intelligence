import { describe, expect, it } from "vitest";
import { cutFromNegation } from "./grounding-negation.ts";

describe("cutFromNegation", () => {
  it("reads whole words, as the exact match does: a phrase inside a longer word stands nowhere", () => {
    expect(cutFromNegation("go home", "I will not go home. Mongo home is down.")).toBe(true);
  });

  it("reads a place in another case or spacing as the same place", () => {
    expect(cutFromNegation("take the offer", "We will not take the offer. Take  the offer is what we did.")).toBe(
      false,
    );
  });

  it("skips a hesitation, as durable grounding does", () => {
    expect(cutFromNegation("take the offer", "I won't take, um, the offer")).toBe(true);
  });

  it("a word that only looks like a negation is none", () => {
    for (const passage of [
      "No worries, I will take the offer.",
      "I not only take the offer.",
      "I did not like it and I take the offer.",
    ])
      expect(cutFromNegation("take the offer", passage)).toBe(false);
  });

  it("a line break, a parenthetical contrast word and an ellipsis end no clause", () => {
    for (const passage of [
      "I will not\ntake the offer",
      "I will not, however, take the offer",
      "I will not, though, take the offer",
      "I won't... take the offer",
      "I won\u2019t\u2026 take the offer",
    ])
      expect(cutFromNegation("take the offer", passage)).toBe(true);
    expect(cutFromNegation("take the offer", "I will not sell.\n\nI take the offer")).toBe(false);
  });

  it("idioms that hold a negator negate nothing", () => {
    for (const [phrase, passage] of [
      ["start at Northwind", "I can't wait to start at Northwind!"],
      ["start at Northwind", "I can\u2019t wait to start at Northwind!"],
      ["start at Northwind", "I cant wait to start at Northwind!"],
      ["joining Northwind in June", "Don't worry, joining Northwind in June"],
      ["joining Northwind in June", "No doubt joining Northwind in June"],
      ["joining Northwind in June", "No wonder, joining Northwind in June"],
    ] as const)
      expect(cutFromNegation(phrase, passage)).toBe(false);
  });

  it("a value that holds its hesitation reads as the same words", () => {
    expect(cutFromNegation("take, um, the offer", "I won't take, um, the offer")).toBe(true);
  });

  it("not yet is one negation", () => {
    expect(cutFromNegation("signed the lease", "I haven't yet signed the lease")).toBe(true);
  });

  it("a phrase that opens with its negation is its own", () => {
    expect(cutFromNegation("not moving to Lisbon", "I am not moving to Lisbon.")).toBe(false);
    expect(cutFromNegation("take the job with no equity", "I will not take the job with no equity.")).toBe(true);
  });
});
