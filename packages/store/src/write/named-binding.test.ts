import { describe, expect, it } from "vitest";
import { namedScope, oneWord } from "./named-binding.ts";

// The pure parts of the binding step's key.

const FP = "a".repeat(64);

describe("a named person's scope", () => {
  it("one word is a name with no white space once trimmed", () => {
    expect(oneWord("Theo")).toBe(true);
    expect(oneWord("  Theo ")).toBe(true);
    expect(oneWord("Theo Marsh")).toBe(false);
    expect(oneWord("Theo\tMarsh")).toBe(false);
  });

  it("a full name's scope holds the name and the sorted label, and no speaker", () => {
    expect(namedScope(FP, ["own", "employer:x"], null)).toBe(`named person\n${FP}\nemployer:x,own`);
    expect(namedScope(FP, ["employer:x", "own"], null)).toBe(namedScope(FP, ["own", "employer:x"], null));
  });

  it("a one-word name's scope holds its speaker, so two speakers' names are two people", () => {
    expect(namedScope(FP, ["own"], "ent_A")).toBe(`named person\n${FP}\nent_A\nown`);
    expect(namedScope(FP, ["own"], "ent_A")).not.toBe(namedScope(FP, ["own"], "ent_B"));
    expect(namedScope(FP, ["own"], "ent_A")).not.toBe(namedScope(FP, ["own"], null));
  });
});
