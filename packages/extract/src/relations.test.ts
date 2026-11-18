import { RelationAnswer } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { CLAIM_RELATIONS_POINT } from "./decision-points.ts";
import { CLAIM_RELATIONS_PROMPT } from "./question-prompts.ts";
import {
  type AskRelation,
  framed,
  type RelationJob,
  type RelationSide,
  relateClaims,
  relationJudge,
  relationSlot,
  relationSubject,
  verifyRelationCites,
} from "./relations.ts";

// The relation step's rules over stub model calls. Invented claims; no model is called.

const key = (n: number): string => n.toString(16).padStart(64, "d");
const side = (n: number, phrase: string, compartments = ["own"]): RelationSide => ({
  key: key(n),
  id: `claim-${n}`,
  type: "situation",
  phrase,
  passage: `In this message: ${phrase}.`,
  evidenceId: `item-${n}`,
  at: "2026-05-01T10:00:00.000Z",
  compartments,
});
const job = (claim: RelationSide, others: RelationSide[], mayPrevail = false, unjudged = false): RelationJob => ({
  claim,
  candidates: others.map((other) => ({ other, mayPrevail })),
  unjudged,
});

// A stub that answers `answer(first, second)` and cites both phrases.
const stub = (
  answer: (first: RelationSide, second: RelationSide) => Pick<RelationAnswer, "relation" | "from">,
): AskRelation & { calls: number } => {
  const ask = (async ({ first, second }) => {
    ask.calls += 1;
    return {
      output: {
        ...answer(first, second),
        cites: [
          { slot: "first", text: first.phrase },
          { slot: "second", text: second.phrase },
        ],
      },
      savedCall: `dcc_${ask.calls}`,
    };
  }) as AskRelation & { calls: number };
  ask.calls = 0;
  return ask;
};
const BUDGET = relationRules().budget;
const budget = { candidates: BUDGET.candidatesPerSubject, calls: BUDGET.callsPerRun };

describe("the prompt and the point", () => {
  it("personal_claim_relations@1 is pinned by its hash, answers RelationAnswer and takes one pair slot, with no tools", () => {
    expect(CLAIM_RELATIONS_PROMPT.textHash).toBe(promptTextHash(CLAIM_RELATIONS_PROMPT));
    expect(CLAIM_RELATIONS_PROMPT.outputSchema).toBe(RelationAnswer);
    expect(CLAIM_RELATIONS_PROMPT.slots).toEqual(["pair"]);
    expect(CLAIM_RELATIONS_PROMPT.tools).toBe("none");
    expect(CLAIM_RELATIONS_POINT).toMatchObject({
      id: "claim_relations",
      version: 1,
      prompt: { id: "personal_claim_relations", version: "1", textHash: CLAIM_RELATIONS_PROMPT.textHash },
    });
    const example = CLAIM_RELATIONS_PROMPT.instructions.split("Example output: ")[1] ?? "";
    expect(RelationAnswer.safeParse(JSON.parse(example)).success).toBe(true);
    expect(relationJudge("openrouter/some-model")).toBe("model:openrouter/some-model@personal_claim_relations@1");
  });

  it("the slot holds the two statements and the prevails flag, nothing else", () => {
    const slot = JSON.parse(relationSlot(side(1, "based in Lisbon"), side(2, "moved to Porto"), true)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(slot).sort()).toEqual(["first", "may_prevail", "second"]);
    expect(Object.keys(slot.first as object).sort()).toEqual(["passage", "phrase", "said", "type"]);
    expect(relationSubject(key(2), key(1))).toBe(`facts:${key(1)}:${key(2)}`);
  });
});

describe("relateClaims", () => {
  it("asks each pair in both orders and writes a relation both orders agree on, in the claim's frame", async () => {
    const claim = side(2, "moved to Porto for good");
    const other = side(1, "based in Lisbon for the year");
    // The newer statement, whichever order shows it, supersedes the older.
    const ask = stub((first) => ({ relation: "supersedes", from: first.key === claim.key ? "first" : "second" }));
    const run = await relateClaims([job(claim, [other])], ask, budget);
    expect(ask.calls).toBe(2);
    expect(run.relations).toEqual([{ from: claim.key, to: other.key, kind: "supersedes", compartments: ["own"] }]);
    expect(run.checks).toEqual([
      {
        claimKey: claim.key,
        claimId: claim.id,
        otherKey: other.key,
        firstAnswer: "supersedes:claim",
        secondAnswer: "supersedes:claim",
        agreed: true,
        written: "supersedes",
        code: null,
        compartments: ["own"],
      },
    ]);
    expect(run.marks).toEqual([{ claimKey: claim.key, claimId: claim.id, state: "judged", compartments: ["own"] }]);
  });

  it("the order-swap check drops a relation the two orders disagree on, and logs it", async () => {
    const claim = side(2, "moved to Porto for good");
    const other = side(1, "based in Lisbon for the year");
    // A model that always says the first statement shown supersedes: the orders disagree.
    const run = await relateClaims(
      [job(claim, [other])],
      stub(() => ({ relation: "supersedes", from: "first" })),
      budget,
    );
    expect(run.relations).toEqual([]);
    expect(run.checks[0]).toMatchObject({
      firstAnswer: "supersedes:claim",
      secondAnswer: "supersedes:other",
      agreed: false,
      written: null,
      code: "disagreed",
    });
    expect(run.counts).toMatchObject({ pairs: 1, calls: 2, agreed: 0, disagreed: 1, written: 0 });
  });

  it("a cite not in the passage shown writes nothing", async () => {
    const claim = side(2, "moved to Porto for good");
    const other = side(1, "based in Lisbon for the year");
    const ask: AskRelation = async () => ({
      output: { relation: "same_fact", from: "first", cites: [{ slot: "first", text: "something nobody wrote here" }] },
      savedCall: "dcc_1",
    });
    const run = await relateClaims([job(claim, [other])], ask, budget);
    expect(run.relations).toEqual([]);
    expect(run.checks[0]).toMatchObject({ agreed: true, code: "uncited", written: null });
    expect(verifyRelationCites({ relation: "unrelated", from: "first", cites: [] }, claim, other)).toBe(true);
  });

  it("a model's prevails is written only where code left the sides equal", async () => {
    const claim = side(2, "relocated to Porto for good");
    const other = side(1, "based in Lisbon for the year");
    const prevails = stub((first) => ({ relation: "prevails", from: first.key === claim.key ? "first" : "second" }));
    expect((await relateClaims([job(claim, [other], false)], prevails, budget)).checks[0]).toMatchObject({
      agreed: true,
      written: null,
      code: "prevails_refused",
    });
    expect((await relateClaims([job(claim, [other], true)], prevails, budget)).relations).toEqual([
      { from: claim.key, to: other.key, kind: "prevails", compartments: ["own"] },
    ]);
  });

  it("past the budget a claim is marked unjudged, and the next run takes it first, skipping the pairs already asked", async () => {
    const a = side(10, "joined Kestrel as an analyst");
    const b = side(11, "leads the Kestrel launch");
    const others = [side(1, "one"), side(2, "two"), side(3, "three")];
    const unrelated = stub(() => ({ relation: "unrelated", from: "first" }));
    // Four calls: two pairs fit, so `a` (first by key) is cut short and `b` is never reached.
    const first = await relateClaims([job(b, others), job(a, others)], unrelated, { candidates: 40, calls: 4 });
    expect(first.stopped).toBe("budget");
    expect(first.marks.map((one) => [one.claimKey, one.state])).toEqual([
      [a.key, "unjudged"],
      [b.key, "unjudged"],
    ]);
    expect(first.checks.map((one) => one.otherKey)).toEqual([others[0]?.key, others[1]?.key]);
    // The next run: `b` is new, `a` is unjudged and goes first; its two asked pairs are skipped.
    const checked = new Set(first.checks.map((one) => `${one.claimKey}\n${one.otherKey}`));
    const next = await relateClaims(
      [job(b, others), job(a, others, false, true)],
      unrelated,
      { candidates: 40, calls: 2 },
      checked,
    );
    expect(next.checks.map((one) => [one.claimKey, one.otherKey])).toEqual([[a.key, others[2]?.key]]);
    expect(next.marks.map((one) => [one.claimKey, one.state])).toEqual([
      [a.key, "judged"],
      [b.key, "unjudged"],
    ]);
  });

  it("takes at most the budget's candidates a claim, in claim key order", async () => {
    const claim = side(99, "the claim");
    const others = Array.from({ length: 50 }, (_, n) => side(50 - n, `other ${50 - n}`));
    const run = await relateClaims(
      [job(claim, others)],
      stub(() => ({ relation: "unrelated", from: "first" })),
      { candidates: 40, calls: 1_000 },
    );
    expect(run.checks).toHaveLength(40);
    expect(run.checks.map((one) => one.otherKey)).toEqual(
      [...others]
        .map((one) => one.key)
        .sort()
        .slice(0, 40),
    );
  });

  it("an outage stops the step and leaves every claim not finished unjudged", async () => {
    const run = await relateClaims(
      [job(side(2, "x"), [side(1, "y")]), job(side(3, "z"), [side(1, "y")])],
      async () => "unavailable",
      budget,
    );
    expect(run.stopped).toBe("unavailable");
    expect(run.marks.every((one) => one.state === "unjudged")).toBe(true);
    expect(run.checks).toEqual([]);
  });

  it("a reached budget in the asker stops the step as `budget`, not as an outage", async () => {
    const run = await relateClaims(
      [job(side(2, "x"), [side(1, "y")]), job(side(3, "z"), [side(1, "y")])],
      async () => "budget",
      budget,
    );
    expect(run.stopped).toBe("budget");
    expect(run.marks.every((one) => one.state === "unjudged")).toBe(true);
    expect(run.checks).toEqual([]);
  });

  it("frames each order's answer by which claim it showed first", () => {
    expect(framed({ relation: "fulfils", from: "first", cites: [] }, true)).toBe("fulfils:claim");
    expect(framed({ relation: "fulfils", from: "first", cites: [] }, false)).toBe("fulfils:other");
    expect(framed({ relation: "contradicts", from: "second", cites: [] }, false)).toBe("contradicts");
    expect(framed({ relation: "unrelated", from: "second", cites: [] }, true)).toBe("unrelated");
  });
});
