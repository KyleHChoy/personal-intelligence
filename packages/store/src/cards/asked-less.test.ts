import { describe, expect, it } from "vitest";
import {
  lessonKey,
  lessonsToAsk,
  mergeLessons,
  OUTCOME_SAMPLE_SHARE,
  OUTCOME_SAMPLE_WEEKLY,
  outcomeAllowance,
  outcomeDraw,
  outcomeLabel,
  outcomeSampled,
  weekStartOf,
} from "./asked-less.ts";

// Made-up values only.

const at = (text: string): Date => new Date(text);
const moves = Array.from({ length: 400 }, (_, n) => `mov_${String(n).padStart(4, "0")}`);

describe("the ISO week", () => {
  it("starts on Monday in UTC", () => {
    expect(weekStartOf(at("2026-11-10T12:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(weekStartOf(at("2026-11-15T23:59:59Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(weekStartOf(at("2026-11-09T00:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});

describe("the weekly sample of outcomes", () => {
  it("draws the same for one report in one week, and anew in the next", () => {
    const week = "2026-W46";
    for (const move of moves.slice(0, 20)) {
      expect(outcomeDraw(move, week)).toBe(outcomeDraw(move, week));
      expect(outcomeDraw(move, week)).toBeGreaterThanOrEqual(0);
      expect(outcomeDraw(move, week)).toBeLessThan(1);
    }
    expect(moves.some((move) => outcomeDraw(move, "2026-W46") !== outcomeDraw(move, "2026-W47"))).toBe(true);
  });

  it("draws about its share of the reports", () => {
    const now = at("2026-11-10T12:00:00Z");
    const drawn = moves.filter((move) => outcomeSampled(move, now, 0)).length / moves.length;
    expect(drawn).toBeGreaterThan(OUTCOME_SAMPLE_SHARE / 2);
    expect(drawn).toBeLessThan(OUTCOME_SAMPLE_SHARE * 2);
  });

  // On the week's last day the whole sample is open.
  it("raises none once the week's sample is full, whatever the draw", () => {
    const now = at("2026-11-15T12:00:00Z");
    const drawn = moves.filter((move) => outcomeSampled(move, now, 0));
    expect(drawn.length).toBeGreaterThan(0);
    for (const move of drawn) {
      expect(outcomeSampled(move, now, OUTCOME_SAMPLE_WEEKLY - 1)).toBe(true);
      expect(outcomeSampled(move, now, OUTCOME_SAMPLE_WEEKLY)).toBe(false);
    }
  });

  it("a walk over a week's reports raises at most the weekly sample", () => {
    const now = at("2026-11-15T12:00:00Z");
    let raised = 0;
    for (const move of moves) if (outcomeSampled(move, now, raised)) raised += 1;
    expect(raised).toBe(OUTCOME_SAMPLE_WEEKLY);
  });

  it("the sample is spread over the week: by each UTC day's end, the weekly sample times the days so far over seven, rounded up", () => {
    const days = ["09", "10", "11", "12", "13", "14", "15"].map((day) => at(`2026-11-${day}T12:00:00Z`));
    expect(days.map((day) => outcomeAllowance(day, 3))).toEqual([1, 1, 2, 2, 3, 3, 3]);
    expect(days.map((day) => outcomeAllowance(day, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(outcomeAllowance(at("2026-11-09T00:00:00Z"), 3)).toBe(1);
    expect(outcomeAllowance(at("2026-11-15T23:59:59Z"), 3)).toBe(3);
    expect(outcomeAllowance(at("2026-11-12T12:00:00Z"), 0)).toBe(0);
    // A busy Monday takes one; the rest of the week's reports still reach the owner.
    let raised = 0;
    const each = (day: Date, from: number, to: number) => {
      for (const move of moves.slice(from, to)) if (outcomeSampled(move, day, raised)) raised += 1;
      return raised;
    };
    expect(each(days[0] as Date, 0, 200)).toBe(1);
    expect(each(days[1] as Date, 200, 220)).toBeLessThanOrEqual(1);
    expect(each(days[6] as Date, 220, 400)).toBe(OUTCOME_SAMPLE_WEEKLY);
  });
});

describe("the label code gives an outcome", () => {
  it("takes the code judge's met or not met before the report", () => {
    expect(outcomeLabel({ judged: "met", move: "failed" })).toBe("settled_met");
    expect(outcomeLabel({ judged: "not_met", move: "done" })).toBe("settled_not_met");
  });

  it("takes the report where the judge said nothing final", () => {
    expect(outcomeLabel({ judged: null, move: "done" })).toBe("settled_met");
    expect(outcomeLabel({ judged: "partial", move: "failed" })).toBe("settled_not_met");
    expect(outcomeLabel({ judged: "advances", move: "done" })).toBe("settled_met");
  });

  it("says unjudged when neither labels it", () => {
    expect(outcomeLabel({ judged: null, move: "blocked" })).toBe("settled_unjudged");
    expect(outcomeLabel({ judged: null, move: null })).toBe("settled_unjudged");
  });
});

describe("the lessons asked", () => {
  const lesson = (id: string, support: number, day: number) => ({
    id,
    support,
    createdAt: at(`2026-11-0${day}T00:00:00Z`),
  });

  it("asks every lesson, the most supported first, then the oldest, then by id", () => {
    const offered = lessonsToAsk([
      lesson("hyp_c", 2, 3),
      lesson("hyp_a", 5, 4),
      lesson("hyp_b", 2, 1),
      lesson("hyp_e", 2, 3),
      lesson("hyp_d", 0, 1),
    ]);
    expect(offered.map((one) => one.id)).toEqual(["hyp_a", "hyp_b", "hyp_c", "hyp_e", "hyp_d"]);
  });

  it("has no weekly limit", () => {
    const many = Array.from({ length: 12 }, (_, n) => lesson(`hyp_${String(n).padStart(2, "0")}`, n, 1));
    expect(lessonsToAsk(many)).toHaveLength(12);
  });

  it("leaves out a lesson whose basis a veto covers", () => {
    const vetoed = Array.from({ length: 5 }, (_, n) => ({ ...lesson(`hyp_v${n}`, 50 + n, 1), vetoed: true }));
    const askable = Array.from({ length: 6 }, (_, n) => ({ ...lesson(`hyp_${n}`, n, 1), vetoed: false }));
    expect(lessonsToAsk([...vetoed, ...askable]).map((one) => one.id)).toEqual([
      "hyp_5",
      "hyp_4",
      "hyp_3",
      "hyp_2",
      "hyp_1",
      "hyp_0",
    ]);
    expect(lessonsToAsk(vetoed)).toEqual([]);
  });
});

describe("exact duplicate lessons", () => {
  const decision = (id: string) => ({ kind: "decision", id });

  it("keeps a lesson stated twice once, with every decision either cites", () => {
    const merged = mergeLessons(
      [
        { lesson: "Ask before booking travel.", basis: [decision("rul_1"), decision("rul_2")] },
        { lesson: "  ask before  booking travel. ", basis: [decision("rul_2"), decision("rul_3")] },
        { lesson: "Keep replies short.", basis: [decision("rul_4")] },
      ],
      new Set(),
    );
    expect(merged).toEqual([
      { lesson: "Ask before booking travel.", basis: [decision("rul_1"), decision("rul_2"), decision("rul_3")] },
      { lesson: "Keep replies short.", basis: [decision("rul_4")] },
    ]);
  });

  it("leaves out a lesson already standing in the same words for the same kinds and roles", () => {
    const standing = new Set([lessonKey({ words: "Keep replies short.", kinds: ["reply"], roles: [] })]);
    const merged = mergeLessons(
      [
        { lesson: "keep replies SHORT.", basis: [decision("rul_1")], appliesTo: { kinds: ["reply"], roles: [] } },
        { lesson: "Keep replies short.", basis: [decision("rul_2")] },
      ],
      standing,
    );
    expect(merged.map((one) => one.basis)).toEqual([[decision("rul_2")]]);
  });

  it("keeps apart the same words for other kinds, or replacing another lesson", () => {
    const words = "Keep replies short.";
    const keys = new Set([
      lessonKey({ words }),
      lessonKey({ words, kinds: ["reply"] }),
      lessonKey({ words, roles: ["writer"] }),
      lessonKey({ words, supersedes: "hyp_1" }),
    ]);
    expect(keys.size).toBe(4);
    expect(lessonKey({ words, kinds: ["reply", "research"] })).toBe(lessonKey({ words, kinds: ["research", "reply"] }));
    expect(lessonKey({ words, kinds: null, roles: null, supersedes: null })).toBe(lessonKey({ words }));
  });
});
