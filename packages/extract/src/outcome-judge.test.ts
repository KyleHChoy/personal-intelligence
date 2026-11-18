import { OutcomeAnswer } from "@intelligence/contracts/personal";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { OUTCOME_JUDGE_POINT } from "./decision-points.ts";
import {
  type AskOutcome,
  attributionOf,
  boundedKind,
  judgeOutcomes,
  type OutcomeCandidate,
  type OutcomeExpectation,
  type OutcomeItem,
  outcomeJudge,
  outcomeSlot,
  ruleOutcome,
  verifyOutcomeCites,
} from "./outcome-judge.ts";
import { OUTCOME_JUDGE_PROMPT } from "./question-prompts.ts";

// The outcome judge over stub model calls. Invented work and passages; no model is called.

const JUDGE = outcomeJudge("vendor/some-model");
const expectation = (over: Partial<OutcomeExpectation> = {}): OutcomeExpectation => ({
  id: "41",
  opportunityId: "opp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  type: "answered",
  success: null,
  failure: null,
  person: true,
  compartments: ["own"],
  ...over,
});
const item = (n: number, over: Partial<OutcomeItem> = {}): OutcomeItem => ({
  evidenceId: `item-${n}`,
  claimKey: null,
  passage: `Thanks for the note about the orchard lease, happy to sign it this week.`,
  at: "2026-10-01T10:00:00.000Z",
  compartments: ["own"],
  flagged: false,
  fromPerson: false,
  firstHand: false,
  decline: false,
  reply: false,
  afterMove: false,
  source: {
    item: `item-${n}`,
    domain: `domain-${n}`,
    thread: `thread-${n}`,
    agent: false,
    firstHand: false,
    authenticated: false,
    domainMatches: false,
    at: "2026-10-01T10:00:00.000Z",
    flagged: false,
  },
  ...over,
});
const candidate = (one: OutcomeItem, over: Partial<OutcomeCandidate> = {}): OutcomeCandidate => ({
  expectation: expectation(),
  item: one,
  path: "watched",
  unjudged: false,
  ...over,
});
const subjectOf = (one: OutcomeCandidate): string =>
  `facts:${"a".repeat(64)}:${one.item.evidenceId.padStart(64, "0").slice(-64)}`;

// A stub that answers `answer` in both orders, citing the passage's first words.
const stub = (answer: (call: { slot: string }) => OutcomeAnswer["outcome"]): AskOutcome & { calls: number } => {
  const ask = (async (call) => {
    ask.calls += 1;
    const slot = JSON.parse(call.slot) as { passage: { text: string } };
    return { output: { outcome: answer(call), cites: [{ text: slot.passage.text.split(",")[0] as string }] } };
  }) as AskOutcome & { calls: number };
  ask.calls = 0;
  return ask;
};

describe("the prompt and the point", () => {
  it("personal_outcome_judge@1 is pinned by its hash, answers OutcomeAnswer and takes one case slot, with no tools", () => {
    expect(OUTCOME_JUDGE_PROMPT.textHash).toBe(promptTextHash(OUTCOME_JUDGE_PROMPT));
    expect(OUTCOME_JUDGE_PROMPT.outputSchema).toBe(OutcomeAnswer);
    expect(OUTCOME_JUDGE_PROMPT.slots).toEqual(["case"]);
    expect(OUTCOME_JUDGE_PROMPT.tools).toBe("none");
    expect(OUTCOME_JUDGE_POINT).toMatchObject({
      id: "outcome_judge",
      version: 1,
      rungs: [0, 2],
      prompt: { id: "personal_outcome_judge", version: "1", textHash: OUTCOME_JUDGE_PROMPT.textHash },
    });
    expect(JUDGE).toBe("model:vendor/some-model@personal_outcome_judge@1");
  });

  it("the slot names what is expected and the passage, in the order asked, and nothing of who or where", () => {
    const one = item(1);
    expect(Object.keys(JSON.parse(outcomeSlot(expectation(), one, true)) as object)).toEqual(["expected", "passage"]);
    expect(Object.keys(JSON.parse(outcomeSlot(expectation(), one, false)) as object)).toEqual(["passage", "expected"]);
    expect(outcomeSlot(expectation(), one, true)).not.toMatch(/item-1|own|opp_/);
  });

  it("a cite must be found in the passage shown, and any answer but unrelated needs one", () => {
    const passage = "We have agreed the lease terms and will sign on Friday.";
    expect(verifyOutcomeCites({ outcome: "met", cites: [{ text: "agreed the lease terms" }] }, passage)).toBe(true);
    expect(verifyOutcomeCites({ outcome: "met", cites: [{ text: "the lease is signed" }] }, passage)).toBe(false);
    expect(verifyOutcomeCites({ outcome: "met", cites: [] }, passage)).toBe(false);
    expect(verifyOutcomeCites({ outcome: "unrelated", cites: [] }, passage)).toBe(true);
  });
});

describe("the rule step (rung 0)", () => {
  it("a reply from the expected person on the work's thread after its move meets answered; a typed decline there fails it", () => {
    const reply = item(1, { reply: true, fromPerson: true, afterMove: true });
    expect(ruleOutcome(candidate(reply))).toBe("met");
    expect(ruleOutcome(candidate({ ...reply, decline: true }))).toBe("not_met");
    // Each condition is needed: the person, the move before it, the watched path, an answered expectation.
    expect(ruleOutcome(candidate({ ...reply, fromPerson: false }))).toBeNull();
    expect(ruleOutcome(candidate({ ...reply, afterMove: false }))).toBeNull();
    expect(ruleOutcome(candidate(reply, { path: "open" }))).toBeNull();
    expect(ruleOutcome(candidate(reply, { expectation: expectation({ type: "meeting_held" }) }))).toBeNull();
    // A decline fails any expectation the reply is about.
    expect(
      ruleOutcome(candidate({ ...reply, decline: true }, { expectation: expectation({ type: "meeting_held" }) })),
    ).toBe("not_met");
  });

  it("the decline is written by rule, applied and caused, with no model call; the reply is left to the tick's rule", async () => {
    const ask = stub(() => "met");
    const run = await judgeOutcomes(
      [
        candidate(item(1, { reply: true, fromPerson: true, afterMove: true, decline: true })),
        candidate(item(2, { reply: true, fromPerson: true, afterMove: true })),
      ],
      ask,
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(ask.calls).toBe(0);
    expect(run.links).toEqual([
      expect.objectContaining({
        evidenceId: "item-1",
        kind: "not_met",
        judge: "rule",
        applied: true,
        attribution: "caused",
        path: "watched",
      }),
    ]);
    expect(run.checks.map((one) => [one.evidenceId, one.code])).toEqual([
      ["item-1", "rule_decline"],
      ["item-2", "rule_reply"],
    ]);
  });

  it("an injection-flagged item never counts, by rule or by the model", async () => {
    const ask = stub(() => "met");
    const run = await judgeOutcomes(
      [
        candidate(item(1, { flagged: true, reply: true, fromPerson: true, afterMove: true, decline: true })),
        candidate(item(2, { flagged: true })),
      ],
      ask,
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(ask.calls).toBe(0);
    expect(run.links).toEqual([]);
    expect(run.checks.map((one) => one.code)).toEqual(["flagged", "flagged"]);
  });
});

describe("the model step (rung 2)", () => {
  it("orders that agree on a cite not in the passage write no link, so none takes effect unverified", async () => {
    const unverified = (async () => ({
      output: { outcome: "met", cites: [{ text: "the lease is signed and filed" }] },
    })) as AskOutcome;
    const run = await judgeOutcomes([candidate(item(1))], unverified, { calls: 20 }, JUDGE, subjectOf);
    expect(run.links).toEqual([]);
    expect(run.checks.map((one) => [one.agreed, one.code])).toEqual([[true, "uncited"]]);
  });

  it("both orders asked; a link only when they agree, written unapplied for the tick, judged by the model; disagreement writes none", async () => {
    const agree = stub(() => "advances");
    const run = await judgeOutcomes([candidate(item(1))], agree, { calls: 20 }, JUDGE, subjectOf);
    expect(agree.calls).toBe(2);
    expect(run.links).toEqual([
      expect.objectContaining({
        kind: "advances",
        judge: JUDGE,
        applied: false,
        passage: { start: 0, end: "Thanks for the note about the orchard lease".length },
      }),
    ]);
    // An answer that turns on which comes first.
    const split = stub((call) => (Object.keys(JSON.parse(call.slot) as object)[0] === "expected" ? "met" : "partial"));
    const disagreed = await judgeOutcomes([candidate(item(2))], split, { calls: 20 }, JUDGE, subjectOf);
    expect(disagreed.links).toEqual([]);
    expect(disagreed.checks).toEqual([
      expect.objectContaining({
        firstAnswer: "met",
        secondAnswer: "partial",
        agreed: false,
        code: "disagreed",
        written: null,
      }),
    ]);
  });

  it("attribution: the same news in the work's thread after its move is caused, and in another thread observed", async () => {
    expect(attributionOf({ afterMove: true })).toBe("caused");
    expect(attributionOf({ afterMove: false })).toBe("observed");
    const run = await judgeOutcomes(
      [
        candidate(item(1, { fromPerson: true, afterMove: true })),
        candidate(item(2, { fromPerson: true, afterMove: false }), { path: "open" }),
      ],
      stub(() => "met"),
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(run.links.map((one) => [one.evidenceId, one.kind, one.attribution])).toEqual([
      ["item-1", "met", "caused"],
      ["item-2", "met", "observed"],
    ]);
  });

  it("the named-person bound: a met not from the person, not first-hand and uncorroborated is advances; an independent second source corroborates", async () => {
    // The pure bound.
    const third = item(1);
    expect(boundedKind("met", { person: true }, third, [])).toBe("advances");
    expect(boundedKind("met", { person: true }, { ...third, fromPerson: true }, [])).toBe("met");
    expect(boundedKind("met", { person: true }, { ...third, firstHand: true }, [])).toBe("met");
    expect(boundedKind("met", { person: false }, third, [])).toBe("met");
    expect(boundedKind("partial", { person: true }, third, [])).toBe("partial");
    // Another item of the same domain and thread is not independent.
    expect(boundedKind("met", { person: true }, third, [{ ...third.source, item: "item-9" }])).toBe("advances");
    expect(boundedKind("met", { person: true }, third, [item(2).source])).toBe("met");

    // Through the step: one uncorroborated third-party met is written as advances, with the code.
    const alone = await judgeOutcomes(
      [candidate(item(1))],
      stub(() => "met"),
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(alone.links.map((one) => [one.kind, one.applied])).toEqual([["advances", false]]);
    expect(alone.checks.map((one) => [one.code, one.written])).toEqual([["bound_advances", "advances"]]);
    // Two independent third-party items for one expectation corroborate each other.
    const both = await judgeOutcomes(
      [candidate(item(1)), candidate(item(2))],
      stub(() => "met"),
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(both.links.map((one) => [one.kind, one.applied])).toEqual([
      ["met", false],
      ["met", false],
    ]);
  });

  it("past the budget, candidates are marked unjudged and taken first next run; an outage marks the rest unjudged", async () => {
    const ask = stub(() => "unrelated");
    const run = await judgeOutcomes(
      [candidate(item(1)), candidate(item(2)), candidate(item(3))],
      ask,
      { calls: 4 },
      JUDGE,
      subjectOf,
    );
    expect(ask.calls).toBe(4);
    expect(run.stopped).toBe("budget");
    expect(run.checks.map((one) => [one.evidenceId, one.state])).toEqual([
      ["item-1", "judged"],
      ["item-2", "judged"],
      ["item-3", "unjudged"],
    ]);
    // Next run: the unjudged one first, and those already judged are not asked again.
    const next = stub(() => "unrelated");
    const order: string[] = [];
    const watching: AskOutcome = async (call) => {
      order.push(call.refs[0] as string);
      return next(call);
    };
    await judgeOutcomes(
      [candidate(item(4)), candidate(item(3), { unjudged: true })],
      watching,
      { calls: 2 },
      JUDGE,
      subjectOf,
      new Set([`41\nitem-1`, `41\nitem-2`]),
    );
    expect(order).toEqual(["item-3", "item-3"]);
    const away = await judgeOutcomes(
      [candidate(item(5)), candidate(item(6))],
      async () => "unavailable",
      { calls: 20 },
      JUDGE,
      subjectOf,
    );
    expect(away.stopped).toBe("unavailable");
    expect(away.checks.map((one) => one.state)).toEqual(["unjudged", "unjudged"]);
    expect(away.links).toEqual([]);
  });

  it("an item with no passage is never asked", async () => {
    const ask = stub(() => "met");
    const run = await judgeOutcomes([candidate(item(1, { passage: null }))], ask, { calls: 20 }, JUDGE, subjectOf);
    expect(ask.calls).toBe(0);
    expect(run.checks.map((one) => one.code)).toEqual(["no_passage"]);
  });
});
