import { describe, expect, it } from "vitest";
import { decisionRate } from "./decision-rate.ts";

// The owner's decisions per day, classed by `teachesOf`; made-up counts only.
describe("decisionRate", () => {
  it("classes each kind, an answer by its card's kind, and sums them per day", () => {
    const rate = decisionRate(
      [
        { day: "2026-10-28", kind: "answer", cardKind: "opportunity_decision", n: 3 },
        { day: "2026-10-28", kind: "answer", cardKind: "lesson", n: 1 },
        { day: "2026-10-28", kind: "answer", cardKind: "same_person", n: 4 },
        { day: "2026-10-28", kind: "warmth_tier", cardKind: null, n: 5 },
        { day: "2026-10-28", kind: "erase", cardKind: null, n: 1 },
        { day: "2026-10-29", kind: "goal_reword", cardKind: null, n: 2 },
        { day: "2026-10-29", kind: "answer", cardKind: null, n: 1 },
        { day: "2026-10-29", kind: "answer", cardKind: "not_a_card_kind", n: 1 },
        { day: "2026-10-29", kind: "not_a_kind", cardKind: null, n: 1 },
        { day: "2026-10-29", kind: "constructor", cardKind: null, n: 1 },
      ],
      7,
    );
    expect(rate.byDay).toEqual([
      { day: "2026-10-28", plan: 3, ruling: 9, none: 2, unclassed: 0 },
      { day: "2026-10-29", plan: 2, ruling: 0, none: 0, unclassed: 4 },
    ]);
    expect(rate.plan).toBe(5);
    expect(rate.planPerDay).toBe(0.71);
  });

  it("reads no decisions as a zero rate", () => {
    expect(decisionRate([], 30)).toEqual({ byDay: [], plan: 0, planPerDay: 0 });
  });
});
