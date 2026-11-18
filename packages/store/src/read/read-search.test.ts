import { describe, expect, it } from "vitest";
import { bestMatch, byAddressThenRank, byRank, byRankAndWarmth, normalized } from "./read-search.ts";

// The reader's matching and ranking, which need no database.

const person = (names: string[], addresses: string[]) => ({
  names: names.map(normalized),
  addresses: addresses.map(normalized),
});

describe("normalized", () => {
  it("strips accents and lower-cases", () => {
    expect(normalized("Zoë  Brontë")).toBe("zoe bronte");
    expect(normalized("ÉMILE")).toBe("emile");
    // A composed and a decomposed spelling are one text.
    expect(normalized("José")).toBe(normalized("José"));
  });
});

describe("bestMatch", () => {
  const avery = person(["Avery Stone", "A. Stone"], ["avery@stone.example"]);

  it("a whole name is an exact match, several words included", () => {
    expect(bestMatch(normalized("avery stone"), avery)).toBe(0);
    expect(bestMatch(normalized("AVERY  STONE"), avery)).toBe(0);
  });

  it("a prefix of any word of a name is a word prefix", () => {
    expect(bestMatch(normalized("ave"), avery)).toBe(1);
    expect(bestMatch(normalized("sto"), avery)).toBe(1);
    expect(bestMatch(normalized("avery"), avery)).toBe(1);
    expect(bestMatch(normalized("Avery Sto"), avery)).toBe(1);
    expect(bestMatch(normalized("very sto"), avery)).toBeNull();
    const project = { names: [normalized("Applied Kiln Build")], addresses: [] };
    expect(bestMatch(normalized("kiln bu"), project)).toBe(1);
    expect(bestMatch(normalized("applied build"), project)).toBeNull();
  });

  it("a substring of a whole address is a substring match", () => {
    expect(bestMatch(normalized("very@st"), avery)).toBe(2);
    expect(bestMatch(normalized("avery@stone.example"), avery)).toBe(2);
    expect(bestMatch(normalized("example"), avery)).toBe(2);
  });

  it("the middle of a name, and a text found nowhere, match nothing", () => {
    expect(bestMatch(normalized("very"), person(["Avery Stone"], ["a@b.example"]))).toBeNull();
    expect(bestMatch(normalized("quill"), avery)).toBeNull();
    expect(bestMatch(normalized("   "), avery)).toBeNull();
  });

  it("a candidate ranks by its best match", () => {
    expect(bestMatch(normalized("stone"), person(["Stone", "Avery Stone"], ["x@stone.example"]))).toBe(0);
  });
});

describe("byRank", () => {
  it("orders by match, then count, then id", () => {
    const results = [
      { id: "ent_D", rank: 2 as const, emails: 9 },
      { id: "ent_C", rank: 1 as const, emails: 1 },
      { id: "ent_B", rank: 1 as const, emails: 4 },
      { id: "ent_A", rank: 1 as const, emails: 4 },
      { id: "ent_E", rank: 0 as const, emails: 0 },
    ];
    expect(results.sort(byRank).map((one) => one.id)).toEqual(["ent_E", "ent_A", "ent_B", "ent_C", "ent_D"]);
  });
});

describe("the match mode's statement", () => {
  it("the statement holds no aggregate over rows", async () => {
    const { FIND_FACTS } = await import("./read-fact-rows.ts");
    const text = FIND_FACTS.toLowerCase();
    expect(text).toContain("from knowledge.claims c");
    for (const aggregate of [
      "count(",
      "sum(",
      "avg(",
      " over (",
      " over(",
      "rank(",
      "row_number(",
      "group by",
      "ts_rank",
      "similarity(",
    ])
      expect(text, aggregate).not.toContain(aggregate);
  });
});

describe("byRankAndWarmth", () => {
  it("orders by match, then warmth (tier, then warmth), then byRank's order", () => {
    const page = [
      { id: "ent_A", rank: 1 as const, emails: 9, warmth: 0 },
      { id: "ent_B", rank: 1 as const, emails: 1, warmth: 2.5 },
      { id: "ent_C", rank: 0 as const, emails: 0, warmth: 0 },
      { id: "ent_D", rank: 1 as const, emails: 5, warmth: 2.5 },
    ];
    expect(page.sort(byRankAndWarmth).map((one) => one.id)).toEqual(["ent_C", "ent_D", "ent_B", "ent_A"]);
  });
});

describe("byAddressThenRank", () => {
  it("puts people known by a name alone after people with an address, each part by match rank", () => {
    const page = [
      { id: "ent_N1", rank: 0 as const, emails: 0, warmth: 0, nameOnly: true },
      { id: "ent_A", rank: 2 as const, emails: 0, warmth: 0, nameOnly: false },
      { id: "ent_N2", rank: 1 as const, emails: 0, warmth: 0, nameOnly: true },
      { id: "ent_B", rank: 0 as const, emails: 0, warmth: 0, nameOnly: false },
    ];
    expect(page.sort(byAddressThenRank).map((one) => one.id)).toEqual(["ent_B", "ent_A", "ent_N1", "ent_N2"]);
  });
});
