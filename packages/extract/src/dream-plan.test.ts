import type { RelationJob, RelationSide } from "@intelligence/contracts/personal";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import {
  checkVerdictOf,
  type PairPassage,
  pairReadable,
  pairSlot,
  SAME_PERSON_PROMPT,
  samePersonJudge,
  verifyPairCites,
} from "./dream-identity.ts";
import { afterScreen, capReached, inChunks, nightOrder, screenSplit } from "./dream-plan.ts";

// Pass, pure: the night's order, chunks, the screen's split and the miss sample, the
// trial's caps, and the same-person judge's slot and cite check. Invented ids and passages.

const key = (n: number): string => n.toString(16).padStart(64, "c");
const side = (n: number): RelationSide => ({
  key: key(n),
  id: `claim-${n}`,
  type: "role",
  phrase: "partner at Northstar",
  passage: "She is a partner at Northstar now.",
  evidenceId: `item-${n}`,
  at: "2026-06-01T09:00:00.000Z",
  compartments: ["own"],
});

describe("the night's order and chunks", () => {
  it("takes each tier in turn, a subject once at its first tier", () => {
    expect(nightOrder([["s1", "s2"], ["s2", "s3"], [], ["s4", "s1"]])).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("chunks in order, the last one short", () => {
    expect(inChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inChunks([], 3)).toEqual([]);
  });
});

describe("the cheap screen", () => {
  const check = (claim: number, other: number, first: string | null, second: string | null) => ({
    claimKey: key(claim),
    otherKey: key(other),
    firstAnswer: first,
    secondAnswer: second,
  });

  it("passes over a pair only when both orders say unrelated", () => {
    const split = screenSplit([
      check(1, 2, "unrelated", "unrelated"),
      check(1, 3, "unrelated", "contradicts"),
      check(1, 4, null, "unrelated"),
    ]);
    // Each answer stands for both orders: the pair is screened both ways at once.
    expect([...split.passed]).toEqual([`${key(1)}\n${key(2)}`, `${key(2)}\n${key(1)}`]);
    expect(split.flagged.size).toBe(4);
  });

  it("one order flagged and the other passed is flagged: the judge sees it", () => {
    const split = screenSplit([check(1, 2, "unrelated", "unrelated"), check(2, 1, "contradicts", "contradicts")]);
    expect(split.passed.size).toBe(0);
    expect(split.flagged.has(`${key(1)}\n${key(2)}`)).toBe(true);
  });

  it("a pair the screen passed from one side is passed over from the other too", () => {
    const job: RelationJob = {
      claim: side(2),
      candidates: [1].map((n) => ({ other: side(n), mayPrevail: false })),
      unjudged: false,
    };
    const { jobs } = afterScreen([job], screenSplit([check(1, 2, "unrelated", "unrelated")]), () => false);
    expect(jobs[0]?.candidates).toEqual([]);
  });

  it("the judge asks what it flagged, what it never answered, and the miss sample of what it passed", () => {
    const job: RelationJob = {
      claim: side(1),
      candidates: [2, 3, 4, 5].map((n) => ({ other: side(n), mayPrevail: false })),
      unjudged: false,
    };
    const screen = screenSplit([
      check(1, 2, "unrelated", "unrelated"),
      check(1, 3, "contradicts", "contradicts"),
      check(1, 4, "unrelated", "unrelated"),
    ]);
    const { jobs, misses } = afterScreen([job], screen, (pair) => pair.endsWith(key(4)));
    expect(jobs[0]?.candidates.map((one) => one.other.key)).toEqual([key(3), key(4), key(5)]);
    expect([...misses]).toEqual([`${key(1)}\n${key(4)}`]);
  });
});

describe("a hand-run trial's caps", () => {
  it("both unset is uncapped; each stops at its own", () => {
    expect(capReached({ usd: null, calls: null }, { microUsd: 10 ** 12, calls: 10 ** 9 })).toBeNull();
    expect(capReached({ usd: 2, calls: null }, { microUsd: 2_000_000, calls: 0 })).toBe("usd");
    expect(capReached({ usd: 2, calls: null }, { microUsd: 1_999_999, calls: 0 })).toBeNull();
    expect(capReached({ usd: null, calls: 10 }, { microUsd: 0, calls: 10 })).toBe("calls");
  });
});

describe("the same-person judge", () => {
  const passage = (n: number, text: string | null): PairPassage => ({
    claimKey: key(n),
    evidenceId: `item-${n}`,
    text,
    at: "2026-06-01T09:00:00.000Z",
    phrase: "role: partner",
  });
  const pair = {
    a: [passage(1, "Dana Reyes is a partner at Northstar Capital.")],
    b: [passage(2, "Dana joined Northstar Capital as a partner.")],
  };

  it("its prompt is pinned by its text, and its judge names it", () => {
    expect(SAME_PERSON_PROMPT.textHash).toBe(promptTextHash(SAME_PERSON_PROMPT));
    expect(samePersonJudge("anthropic/claude-opus-5-5")).toBe("model:anthropic/claude-opus-5-5@personal_same_person@1");
  });

  it("shows each side's passages numbered, with no label", () => {
    const slot = JSON.parse(pairSlot(pair)) as { a: { n: number }[]; b: { n: number }[] };
    expect(slot.a[0]?.n).toBe(1);
    expect(slot.b[0]?.n).toBe(1);
    expect(pairSlot(pair)).not.toContain("own");
    expect(pairReadable(pair)).toBe(true);
    expect(pairReadable({ a: pair.a, b: [passage(3, null)] })).toBe(false);
  });

  it("a same cites both sides from the passages shown; a cite not found fails", () => {
    const both = {
      verdict: "same" as const,
      cites: [
        { side: "a" as const, passage: 1, text: "a partner at Northstar Capital" },
        { side: "b" as const, passage: 1, text: "joined Northstar Capital as a partner" },
      ],
    };
    expect(verifyPairCites(both, pair)).toBe(true);
    expect(verifyPairCites({ ...both, cites: both.cites.slice(0, 1) }, pair)).toBe(false);
    expect(
      verifyPairCites(
        { verdict: "same", cites: [{ side: "a", passage: 1, text: "a director at Elsewhere Ltd" }] },
        pair,
      ),
    ).toBe(false);
    expect(verifyPairCites({ verdict: "cant_tell", cites: [] }, pair)).toBe(true);
  });

  it("the second model's answer is a check of the judge's same", () => {
    expect(checkVerdictOf("same")).toBe("supported");
    expect(checkVerdictOf("different")).toBe("wrong");
    expect(checkVerdictOf("cant_tell")).toBe("unsupported");
  });
});
