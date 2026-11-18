import { RevealedClaim, type UseOnlyCandidate } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type RevealedClaimsInput, revealedClaims } from "./disclosure.ts";

// The disclosure check at rung 0. Made-up claims and text.

// A use-only claim off its thread, tied by nothing yet.
function candidate(id: string, change: Partial<UseOnlyCandidate> = {}): UseOnlyCandidate {
  return { id, thirdParty: true, isPublic: false, offThread: true, citedItem: false, textValues: [], ...change };
}

function input(change: Partial<RevealedClaimsInput>): RevealedClaimsInput {
  return {
    subject: "A note on the spring visit",
    body: "Thanks for the call today.",
    candidates: [],
    released: [],
    ...change,
  };
}

// A value of exactly 12 code points, and one of 11.
const TWELVE = "harbor plans";
const ELEVEN = "harbor plan";

describe("revealedClaims", () => {
  it("the two values are 12 and 11 code points", () => {
    expect([...TWELVE].length).toBe(12);
    expect([...ELEVEN].length).toBe(11);
  });

  it("a cited item's use-only claim is revealed to a recipient off its thread, with the tie cited_item", () => {
    expect(revealedClaims(input({ candidates: [candidate("claim-a", { citedItem: true })] }))).toEqual([
      { id: "claim-a", tie: "cited_item", valueIndex: null },
    ]);
  });

  it("the same claim with every recipient on its thread reveals nothing", () => {
    const body = `We spoke about the ${TWELVE} on Monday.`;
    expect(
      revealedClaims(
        input({
          body,
          candidates: [candidate("claim-a", { citedItem: true, offThread: false, textValues: [TWELVE] })],
        }),
      ),
    ).toEqual([]);
  });

  it("a text value of 12 code points in the body is a tie, with the tie text_value and the value's index, and one of 11 is not", () => {
    const body = `We spoke about the ${TWELVE} on Monday.`;
    expect(
      revealedClaims(
        input({ body, candidates: [candidate("claim-a", { textValues: ["not in the draft at all", TWELVE] })] }),
      ),
    ).toEqual([{ id: "claim-a", tie: "text_value", valueIndex: 1 }]);
    const shortBody = `We spoke about the ${ELEVEN} on Monday.`;
    expect(
      revealedClaims(input({ body: shortBody, candidates: [candidate("claim-b", { textValues: [ELEVEN] })] })),
    ).toEqual([]);
  });

  it("the index is that of the first value that ties", () => {
    const body = `The ${TWELVE} and the quarterly figures are attached.`;
    const values = ["spring", "absent from the draft", "quarterly figures", TWELVE];
    expect(revealedClaims(input({ body, candidates: [candidate("claim-a", { textValues: values })] }))).toEqual([
      { id: "claim-a", tie: "text_value", valueIndex: 2 },
    ]);
  });

  it("a cited item wins over a text value", () => {
    const body = `We spoke about the ${TWELVE} on Monday.`;
    expect(
      revealedClaims(input({ body, candidates: [candidate("claim-a", { citedItem: true, textValues: [TWELVE] })] })),
    ).toEqual([{ id: "claim-a", tie: "cited_item", valueIndex: null }]);
  });

  it("code points are counted, not UTF-16 units: 11 code points never tie", () => {
    const value = "abcdefghij\u{1F600}";
    expect([...value].length).toBe(11);
    expect(value.length).toBe(12);
    expect(
      revealedClaims(input({ body: `see ${value} here`, candidates: [candidate("claim-a", { textValues: [value] })] })),
    ).toEqual([]);
  });

  it("a value is measured after it is normalised", () => {
    // 12 code points as written, 11 once its two spaces are one.
    const spaced = "harbor  plan";
    expect([...spaced].length).toBe(12);
    expect(
      revealedClaims(
        input({ body: `the ${ELEVEN} again`, candidates: [candidate("claim-a", { textValues: [spaced] })] }),
      ),
    ).toEqual([]);
    // Spaces about the value are trimmed, and what is left is 12.
    expect(
      revealedClaims(
        input({ body: `the ${TWELVE} again`, candidates: [candidate("claim-b", { textValues: [`  ${TWELVE}  `] })] }),
      ),
    ).toEqual([{ id: "claim-b", tie: "text_value", valueIndex: 0 }]);
  });

  it("a text value in the subject is a tie", () => {
    expect(
      revealedClaims(
        input({
          subject: `About the ${TWELVE}`,
          body: "See you soon.",
          candidates: [candidate("claim-a", { textValues: [TWELVE] })],
        }),
      ),
    ).toEqual([{ id: "claim-a", tie: "text_value", valueIndex: 0 }]);
  });

  it("the subject and body are joined by a line break, which is white space", () => {
    expect(
      revealedClaims(
        input({
          subject: "About the harbor",
          body: "plans for spring.",
          candidates: [candidate("claim-a", { textValues: [TWELVE] })],
        }),
      ),
    ).toEqual([{ id: "claim-a", tie: "text_value", valueIndex: 0 }]);
  });

  it("text is compared without case, width or spacing", () => {
    const one = (body: string, value: string) =>
      revealedClaims(input({ body, candidates: [candidate("claim-a", { textValues: [value] })] }));
    const tied = [{ id: "claim-a", tie: "text_value", valueIndex: 0 }];
    expect(one("Notes on the HARBOR PLANS follow.", TWELVE)).toEqual(tied);
    expect(one(`Notes on the ${TWELVE} follow.`, "Harbor Plans")).toEqual(tied);
    expect(one("Notes on the ＨＡＲＢＯＲ ＰＬＡＮＳ follow.", TWELVE)).toEqual(tied);
    expect(one(`Notes on the ${TWELVE} follow.`, "ｈａｒｂｏｒ ｐｌａｎｓ")).toEqual(tied);
    expect(one("Notes on the harbor\n\t  plans follow.", TWELVE)).toEqual(tied);
    expect(one(`Notes on the ${TWELVE} follow.`, "harbor \n plans")).toEqual(tied);
    expect(one("Notes on the harbor plans follow.", TWELVE)).toEqual(tied);
  });

  // A writer could split a value with a code point that does not
  // print, which the payload's contract admits.
  it("an invisible format character inside a value does not hide it", () => {
    for (const hidden of ["\u200B", "\u00AD", "\u200C", "\u200D", "\u2060", "\uFEFF"]) {
      const body = `We spoke about the harbor${hidden} plans on Monday.`;
      expect(
        revealedClaims(input({ body, candidates: [candidate("claim-a", { textValues: [TWELVE] })] })),
        JSON.stringify(hidden),
      ).toEqual([{ id: "claim-a", tie: "text_value", valueIndex: 0 }]);
    }
    // Nor does one between every letter, nor one in the claim's own value.
    const spread = [...TWELVE].join("\u200B");
    expect(
      revealedClaims(input({ body: spread, candidates: [candidate("claim-a", { textValues: [TWELVE] })] })),
    ).toHaveLength(1);
    expect(
      revealedClaims(
        input({ body: TWELVE, candidates: [candidate("claim-a", { textValues: [`harbor\u00AD plans`] })] }),
      ),
    ).toHaveLength(1);
  });

  it("a claim that is not third_party reveals nothing", () => {
    const body = `We spoke about the ${TWELVE}.`;
    expect(
      revealedClaims(
        input({
          body,
          candidates: [candidate("claim-a", { thirdParty: false, citedItem: true, textValues: [TWELVE] })],
        }),
      ),
    ).toEqual([]);
  });

  it("a claim under public (isPublic) reveals nothing", () => {
    const body = `We spoke about the ${TWELVE}.`;
    expect(
      revealedClaims(
        input({ body, candidates: [candidate("claim-a", { isPublic: true, citedItem: true, textValues: [TWELVE] })] }),
      ),
    ).toEqual([]);
  });

  it("a claim tied by nothing reveals nothing", () => {
    expect(
      revealedClaims(
        input({ candidates: [candidate("claim-a", { textValues: ["a value the draft does not hold"] })] }),
      ),
    ).toEqual([]);
  });

  it("no candidates, nothing revealed", () => {
    expect(revealedClaims(input({ candidates: [] }))).toEqual([]);
  });

  it("what is returned holds a claim's id, tie and index, and no text", () => {
    const body = `We spoke about the ${TWELVE} and the quarterly figures.`;
    const candidates = [
      candidate("claim-a", { citedItem: true, textValues: ["quarterly figures"] }),
      candidate("claim-b", { textValues: [TWELVE] }),
    ];
    const result = revealedClaims(input({ body, candidates }));
    expect(result).toHaveLength(2);
    for (const one of result) {
      expect(Object.keys(one).sort()).toEqual(["id", "tie", "valueIndex"]);
      expect(RevealedClaim.parse(one)).toEqual(one);
    }
    const printed = JSON.stringify(result);
    for (const value of [TWELVE, "quarterly figures", "spoke"]) expect(printed).not.toContain(value);
  });

  it("claims are returned in the order of the candidates", () => {
    const body = `The ${TWELVE} and the quarterly figures.`;
    const candidates = [
      candidate("claim-c", { textValues: ["quarterly figures"] }),
      candidate("claim-x", { thirdParty: false, citedItem: true }),
      candidate("claim-a", { citedItem: true }),
      candidate("claim-b", { textValues: [TWELVE] }),
    ];
    expect(revealedClaims(input({ body, candidates })).map((one) => one.id)).toEqual(["claim-c", "claim-a", "claim-b"]);
  });

  it("a released claim is not returned, and an unreleased one beside it still is", () => {
    const candidates = [candidate("claim-a", { citedItem: true }), candidate("claim-b", { citedItem: true })];
    expect(revealedClaims(input({ candidates, released: ["claim-a"] }))).toEqual([
      { id: "claim-b", tie: "cited_item", valueIndex: null },
    ]);
  });

  it("with every held claim released, nothing is returned", () => {
    const candidates = [candidate("claim-a", { citedItem: true }), candidate("claim-b", { citedItem: true })];
    expect(revealedClaims(input({ candidates, released: ["claim-b", "claim-a"] }))).toEqual([]);
  });

  it("a released id that names no candidate changes nothing", () => {
    const candidates = [candidate("claim-a", { citedItem: true })];
    expect(revealedClaims(input({ candidates, released: ["claim-z"] }))).toEqual([
      { id: "claim-a", tie: "cited_item", valueIndex: null },
    ]);
  });

  it("a candidate that does not parse as UseOnlyCandidate throws", () => {
    const bad: unknown[] = [
      { id: "", thirdParty: true, isPublic: false, offThread: true, citedItem: true, textValues: [] },
      { id: "claim-a", thirdParty: "yes", isPublic: false, offThread: true, citedItem: true, textValues: [] },
      { id: "claim-a", thirdParty: true, isPublic: false, offThread: true, citedItem: true },
      { ...candidate("claim-a", { citedItem: true }), text: "an extra field" },
    ];
    expect(() => revealedClaims(input({ candidates: [candidate("claim-a", { citedItem: true })] }))).not.toThrow();
    for (const one of bad) expect(() => revealedClaims(input({ candidates: [one as UseOnlyCandidate] }))).toThrow();
  });
});
