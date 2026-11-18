import { describe, expect, it } from "vitest";
import {
  afterNegation,
  beginsNegated,
  keyPhrase,
  NEGATIONS,
  polarPhrase,
  statesTwoFacts,
  wordCount,
} from "./key-phrase.ts";

// The key phrase of a fact.

describe("the key phrase", () => {
  it("is lower case, NFKC, with punctuation and standalone articles removed", () => {
    expect(keyPhrase("  The Seed-Round, for ALDER!  ")).toBe("seed round for alder");
    expect(keyPhrase("Ｓｅｅｄ round")).toBe("seed round");
    expect(keyPhrase("O’Neil’s fund")).toBe(keyPhrase("O'Neil's fund"));
    expect(keyPhrase("theater")).toBe("theater");
  });

  it("drops a standalone article anywhere, but keeps the last word and one joined to a slash", () => {
    expect(keyPhrase("an MBA at a school")).toBe("mba at school");
    expect(keyPhrase("raise the seed round")).toBe(keyPhrase("raise a seed round"));
    expect(keyPhrase("raise the seed round")).toBe("raise seed round");
    expect(keyPhrase("A/B testing")).toBe("a b testing");
    expect(keyPhrase("A/B testing")).not.toBe(keyPhrase("B testing"));
    expect(keyPhrase("vitamin A")).toBe("vitamin a");
    expect(keyPhrase("vitamin A")).not.toBe(keyPhrase("vitamin"));
    expect(keyPhrase("Plan A")).toBe("plan a");
    expect(keyPhrase("Plan A")).not.toBe(keyPhrase("Plan"));
    expect(keyPhrase("🙂")).toBe("");
  });

  it("keeps combining marks in their word, so two Devanagari words stay two", () => {
    expect(keyPhrase("कुल")).not.toBe(keyPhrase("काल"));
    expect(keyPhrase("कुल")).toBe("कुल");
  });

  it("the pinned table: `no em dashes`, `never em dashes` and `avoid em dashes` give one phrase, negated", () => {
    expect(NEGATIONS).toEqual([
      "no",
      "not",
      "never",
      "avoid",
      "avoids",
      "avoiding",
      "dont",
      "do not",
      "doesnt",
      "does not",
      "didnt",
      "did not",
      "wont",
      "will not",
      "without",
    ]);
    for (const text of ["no em dashes", "Never em dashes", "avoid em-dashes", "Don’t em dashes", "do not em dashes"])
      expect(polarPhrase(text), text).toEqual({ phrase: "em dashes", negated: true });
    expect(polarPhrase("em dashes")).toEqual({ phrase: "em dashes", negated: false });
    // One negation moves; a second stays, and the check refuses it.
    expect(polarPhrase("not never meetings")).toEqual({ phrase: "never meetings", negated: true });
    expect(beginsNegated("never meetings")).toBe(true);
    // A word that only starts like one is not one.
    expect(polarPhrase("nothing fancy")).toEqual({ phrase: "nothing fancy", negated: false });
    expect(beginsNegated("notion docs")).toBe(false);
  });

  it("a negation counts only standing as its own word, never inside a hyphenated compound", () => {
    expect(polarPhrase("no-name brands")).toEqual({ phrase: "no name brands", negated: false });
    expect(polarPhrase("no-code tools")).toEqual({ phrase: "no code tools", negated: false });
    expect(beginsNegated("no-code tools")).toBe(false);
    expect(afterNegation("do not-call list")).toBeNull();
    expect(afterNegation("No, early calls")).toBe("early calls");
  });

  it("afterNegation returns the text's own slice after its leading negation", () => {
    expect(afterNegation("Never em dashes")).toBe("em dashes");
    expect(afterNegation("don’t  schedule calls before 10")).toBe("schedule calls before 10");
    expect(afterNegation("do not book red-eyes")).toBe("book red-eyes");
    expect(afterNegation("no")).toBe("");
    expect(afterNegation("Never, em dashes")).toBe("em dashes");
    expect(afterNegation("early calls")).toBeNull();
  });
});

describe("one fact per phrase", () => {
  it("a sentence break, or a joiner between two verb phrases, is two facts", () => {
    for (const text of [
      "raise a seed round and hire two engineers",
      "raise a seed and hire engineers",
      "moving to Portland and starting at Alder",
      "I run. I swim.",
      "Finish the thesis; then start a job",
      "learn Rust but I will quit Go",
      "Selling the house\nmoving abroad",
      "raise a seed round, hire two engineers",
    ]) {
      expect(statesTwoFacts(text), text).toBe(true);
    }
  });

  it("a conjunction of nouns, or a verb with two objects, is one fact", () => {
    for (const text of [
      "find a cofounder and a designer",
      "salt and pepper",
      "a meeting and a call",
      "research and development",
      "learn Spanish and French",
      "U.S. visa",
      "fewer meetings",
    ]) {
      expect(statesTwoFacts(text), text).toBe(false);
    }
  });

  it("two bare verbs, an alternative and a circumstance are one fact", () => {
    for (const text of [
      "buy and sell",
      "buy and sell houses",
      "buy, sell and trade stocks",
      "move to Portland or stay in Denver",
      "work remotely while traveling",
      "learn French, Spanish and German",
    ]) {
      expect(statesTwoFacts(text), text).toBe(false);
    }
  });

  it("an abbreviation or an initial before a capital is no sentence break", () => {
    for (const text of [
      "moved to St. Louis",
      "join the U.S. Army",
      "see Dr. Patel",
      "work with J. Smith",
      "beat Alder Inc. Next year",
      "study e.g. Latin",
    ]) {
      expect(statesTwoFacts(text), text).toBe(false);
    }
    expect(statesTwoFacts("moved to Portland. Started at Alder")).toBe(true);
  });

  it("counts words by white space", () => {
    expect(wordCount("  raise a seed round  ")).toBe(4);
  });

  // An emoji is no word, standing alone or against one.
  it("counts no emoji as a word, alone, against a word or joined, and splits no word at a selector", () => {
    expect(wordCount("can only do weekends \u{1F629}\u{1F629}\nbc of work")).toBe(7);
    expect(wordCount("weekends\u{1F629} work")).toBe(2);
    expect(wordCount("new \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} place \u{2764}\u{FE0F}")).toBe(2);
    expect(wordCount("\u{845B}\u{E0100}\u{57CE}")).toBe(1);
  });
});
