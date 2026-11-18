import { describe, expect, it } from "vitest";
import { byMatch, isMatchSide, MATCH_SIDES, matchScore, matchWords } from "./match.ts";
import { VIEW_KINDS } from "./view-kind.ts";

// The match mode of search, computed at read from the claims the caller's token returned.

describe("the match mode", () => {
  it("puts text in extract's normal form and splits it at white space, each word once", () => {
    expect(matchWords("  Needs a ＫＩＴＣＨＥＮ   designer —  kitchen designer! ")).toEqual([
      "needs",
      "a",
      "kitchen",
      "designer",
    ]);
    // A word's own punctuation at its ends is not part of it; inside it is.
    expect(matchWords("“Rust,” (Go) and C++ in e-mail.")).toEqual(["rust", "go", "and", "c", "in", "e-mail"]);
    expect(matchWords("")).toEqual([]);
    expect(matchWords("— ... !")).toEqual([]);
  });

  it("a word with a decomposed accent is the same word written precomposed", () => {
    expect(matchWords("cafe\u0301 owner")).toEqual(matchWords("café owner"));
    expect(matchScore(matchWords("naïve café"), "A nai\u0308ve cafe\u0301.")).toBe(2);
  });

  it("each claim is scored by its own tokens: how many distinct words of the query it holds", () => {
    const query = matchWords("kitchen designer kitchen");
    expect(matchScore(query, "Looking for a kitchen designer.")).toBe(2);
    expect(matchScore(query, "A designer for the KITCHEN, a kitchen designer")).toBe(2);
    expect(matchScore(query, "A garden designer")).toBe(1);
    expect(matchScore(query, "Nothing like it")).toBe(0);
    // A word is matched whole, never as a part of another.
    expect(matchScore(matchWords("design"), "A designer")).toBe(0);
    // No other claim changes a claim's score: it takes no list of claims at all.
    expect(matchScore.length).toBe(2);
  });

  it("a reversal is never a match, nor a claim of a message the system sent", () => {
    expect(isMatchSide({ statementKind: "stated_fact", systemOriginated: false })).toBe(true);
    expect(isMatchSide({ statementKind: "reversal", systemOriginated: false })).toBe(false);
    expect(isMatchSide({ statementKind: "stated_fact", systemOriginated: true })).toBe(false);
  });

  it("orders by score, most first, then newest, then by id", () => {
    const rows = [
      { id: "b", at: "2026-03-01T00:00:00.000Z", score: 1 },
      { id: "c", at: "2026-03-02T00:00:00.000Z", score: 2 },
      { id: "a", at: "2026-03-01T00:00:00.000Z", score: 1 },
      { id: "d", at: "2026-03-03T00:00:00.000Z", score: 1 },
    ];
    expect([...rows].sort(byMatch).map((row) => row.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("each mode is one side of the shared match index, and a view", () => {
    expect(MATCH_SIDES).toEqual({ needs: "need", capabilities: "capability" });
    for (const side of Object.values(MATCH_SIDES)) expect(VIEW_KINDS).toContain(side);
  });
});
