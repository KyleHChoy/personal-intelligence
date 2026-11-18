import type { RestrictedCategory } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { recoveryHold } from "./hold.ts";
import { RESTRICTED_TERMS, restrictedCategories } from "./screen.ts";

// The restricted-category screen at rung 0. Made-up values only.
const TERMS: Record<RestrictedCategory, string[]> = {
  health: [
    "diagnosis",
    "prescription",
    "lab results",
    "test results",
    "medical record",
    "patient portal",
    "explanation of benefits",
    "therapy session",
  ],
  money: [
    "bank statement",
    "account statement",
    "brokerage statement",
    "tax return",
    "credit report",
    "pay stub",
    "loan application",
    "wire transfer",
  ],
  legal: [
    "subpoena",
    "summons",
    "court date",
    "settlement agreement",
    "cease and desist",
    "legal notice",
    "attorney client privileged",
  ],
  intimate: [],
};
const ALL: RestrictedCategory[] = ["health", "money", "legal", "intimate"];
const LEAD = 2000;
const ASTRAL = "😀";

const screen = (subject: string | null, text: string | null, on: readonly RestrictedCategory[] = ALL) =>
  restrictedCategories({ subject, text }, on);

describe("the term screen", () => {
  it("the list is the expected table, version 1, with a lead of 2,000", () => {
    expect(RESTRICTED_TERMS).toEqual({ version: 1, leadChars: LEAD, terms: TERMS });
  });

  it("each term of each category in a subject restricts to that category, and only when it is on", () => {
    for (const category of ALL) {
      for (const term of TERMS[category]) {
        const capitalized = term.replaceAll(
          /(^| )([a-z])/g,
          (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`,
        );
        for (const subject of [
          term,
          term.toUpperCase(),
          capitalized,
          term.replaceAll(" ", "  "),
          `Re: your ${term}, attached`,
        ]) {
          expect(screen(subject, null), subject).toEqual([category]);
          expect(screen(subject, null, [category]), subject).toEqual([category]);
          // Off, it is never returned.
          expect(
            screen(
              subject,
              null,
              ALL.filter((one) => one !== category),
            ),
            subject,
          ).toEqual([]);
          expect(screen(subject, null, []), subject).toEqual([]);
        }
      }
    }
    // The control: a subject with no term.
    expect(screen("Notes from Tuesday", "See you then.")).toEqual([]);
  });

  it("a term in the first 2,000 code points of the text restricts, and one only after them does not", () => {
    for (const category of ["health", "money", "legal"] as const) {
      for (const term of TERMS[category]) {
        const inside = `${ASTRAL.repeat(LEAD - term.length)}${term}`;
        expect([...inside].length).toBe(LEAD);
        expect(screen("Notes", inside), term).toEqual([category]);
        expect(screen("Notes", `${ASTRAL.repeat(LEAD)}${term}`), term).toEqual([]);
        expect(screen("Notes", `${ASTRAL.repeat(LEAD - term.length + 1)}${term}`), term).toEqual([]);
      }
    }
  });

  it("a term inside other words is no match", () => {
    for (const value of ["diagnosis2", "prediagnosis", "subpoenas", "summonsed", "tax returns", "lab resultsx"])
      expect(screen(value, value), value).toEqual([]);
    // The control: the same words as words.
    expect(screen("a diagnosis, then", null)).toEqual(["health"]);
  });

  it("two categories' terms give both, sorted", () => {
    expect(screen("Subpoena for your bank statement and your lab results", null)).toEqual(["health", "legal", "money"]);
    expect(screen("Wire transfer", "A court date is set.")).toEqual(["legal", "money"]);
    // Each once, however many of its terms match.
    expect(screen("Diagnosis and prescription", "Your lab results")).toEqual(["health"]);
    // Only the on ones, in the same order whatever order the on list is in.
    expect(screen("Subpoena for your bank statement and your lab results", null, ["money", "health"])).toEqual([
      "health",
      "money",
    ]);
  });

  it("intimate has no term", () => {
    expect(RESTRICTED_TERMS.terms.intimate).toEqual([]);
    const everyTerm = Object.values(TERMS).flat().join(", ");
    expect(screen(everyTerm, everyTerm, ["intimate"])).toEqual([]);
  });

  it("a message held as account-recovery mail can also be restricted", () => {
    const about = { subject: "Your verification code for the patient portal", text: "Use 000000 to sign in." };
    expect(recoveryHold(about)).toBe(true);
    expect(restrictedCategories(about, ALL)).toEqual(["health"]);
  });

  it("an off category is never returned", () => {
    const everyTerm = Object.values(TERMS).flat().join(", ");
    for (const category of ALL) {
      const on = ALL.filter((one) => one !== category);
      expect(screen(everyTerm, everyTerm, on)).not.toContain(category);
    }
    expect(screen(everyTerm, everyTerm, [])).toEqual([]);
  });

  it("a message with no subject and no text restricts nothing", () => {
    expect(screen(null, null)).toEqual([]);
    expect(screen("", "")).toEqual([]);
  });

  it("the list is frozen", () => {
    const open = RESTRICTED_TERMS as unknown as { version: number; leadChars: number; terms: Record<string, string[]> };
    const attempts: (() => unknown)[] = [
      () => open.terms.health!.push("notes"),
      () => (open.terms.health![0] = "notes"),
      () => open.terms.intimate!.push("notes"),
      () => (open.terms.health = []),
      () => (open.terms.extra = []),
      () => (open.version = 2),
      () => (open.leadChars = 0),
      () => delete (open as { terms?: unknown }).terms,
    ];
    for (const attempt of attempts) expect(attempt, String(attempt)).toThrow(TypeError);
    expect(RESTRICTED_TERMS).toEqual({ version: 1, leadChars: LEAD, terms: TERMS });
  });
});
