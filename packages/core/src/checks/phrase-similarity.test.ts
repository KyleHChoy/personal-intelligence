import { describe, expect, it } from "vitest";
import { keyPhrase, polarPhrase } from "../key-phrase.ts";
import { phraseSimilarity, SAME_FACT_SIMILARITY } from "./phrase-similarity.ts";

// Synthetic phrases only.

describe("phraseSimilarity", () => {
  it("is the token-set Jaccard of two normalized phrases", () => {
    const table: [string, string, number][] = [
      ["raise seed round", "raise seed round", 1],
      ["raise seed round", "raise series round", 0.5],
      ["find cofounder", "hire designer", 0],
      ["work from home", "work from home office", 0.75],
      ["", "", 0],
    ];
    for (const [a, b, expected] of table) {
      expect(phraseSimilarity(a, b), `${a} / ${b}`).toBe(expected);
      expect(phraseSimilarity(b, a), `${b} / ${a}`).toBe(expected);
    }
    expect(SAME_FACT_SIMILARITY).toBe(0.35);
    expect(phraseSimilarity(keyPhrase("Raise the seed round"), keyPhrase("raise a seed round"))).toBe(1);
  });

  it("puts R8's own example, lives in portland and based in portland tx, at 0.4, a candidate", () => {
    const similarity = phraseSimilarity(keyPhrase("lives in Portland"), keyPhrase("based in Portland, OR"));
    expect(similarity).toBeCloseTo(0.4);
    expect(similarity).toBeGreaterThanOrEqual(SAME_FACT_SIMILARITY);
  });

  // Polarity is in a preference's fact key, so same-fact pairing never pairs "prefers email" with
  // "avoids email": their phrases are one, and only the key tells them apart.
  it("cannot tell a preference's polarity, which the key holds", () => {
    const avoided = polarPhrase("no email");
    expect(avoided).toEqual({ phrase: "email", negated: true });
    expect(phraseSimilarity(avoided.phrase, keyPhrase("email"))).toBe(1);
  });
});
