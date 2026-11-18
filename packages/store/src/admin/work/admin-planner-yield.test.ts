import { describe, expect, it } from "vitest";
import { weekDayOf } from "../../cards/asked-less.ts";
import { plannerWeeks } from "./admin-planner-yield.ts";

// `pi work report`'s planner yield by week: the runs summed by UTC week and prompt, with the cost
// of each accepted and each used item. Made-up values only.

const counts = (proposed: number, answered: number, accepted: number, used: number) => ({
  proposed,
  answered,
  accepted,
  used,
});

describe("the planner's yield by week", () => {
  it("dates a run by its UTC week's Monday", () => {
    expect(weekDayOf(new Date("2026-11-09T00:00:00Z"))).toBe("2026-11-09");
    expect(weekDayOf(new Date("2026-11-15T23:59:59Z"))).toBe("2026-11-09");
    expect(weekDayOf(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
    expect(weekDayOf(new Date("2026-11-01T12:00:00Z"))).toBe("2026-10-26");
  });

  it("sums runs by week and prompt, counts the runs that proposed anything, and divides the cost by what was accepted and used", () => {
    const weeks = plannerWeeks([
      {
        at: new Date("2026-11-12T10:00:00Z"),
        prompt: "personal_run",
        costMicroUsd: 1_000_000,
        yield: counts(3, 2, 2, 1),
      },
      {
        at: new Date("2026-11-10T10:00:00Z"),
        prompt: "personal_run",
        costMicroUsd: 500_001,
        yield: counts(0, 0, 0, 0),
      },
      {
        at: new Date("2026-11-11T10:00:00Z"),
        prompt: "personal_lessons",
        costMicroUsd: 200_000,
        yield: counts(1, 0, 0, 0),
      },
      {
        at: new Date("2026-11-04T10:00:00Z"),
        prompt: "personal_run",
        costMicroUsd: 700_000,
        yield: counts(1, 1, 0, 0),
      },
    ]);
    expect(weeks).toEqual([
      {
        week: "2026-11-02",
        prompt: "personal_run",
        runs: 1,
        proposing: 1,
        costMicroUsd: 700_000,
        ...counts(1, 1, 0, 0),
        costPerAcceptedMicroUsd: null,
        costPerUsedMicroUsd: null,
      },
      {
        week: "2026-11-09",
        prompt: "personal_lessons",
        runs: 1,
        proposing: 1,
        costMicroUsd: 200_000,
        ...counts(1, 0, 0, 0),
        costPerAcceptedMicroUsd: null,
        costPerUsedMicroUsd: null,
      },
      {
        week: "2026-11-09",
        prompt: "personal_run",
        runs: 2,
        proposing: 1,
        costMicroUsd: 1_500_001,
        ...counts(3, 2, 2, 1),
        costPerAcceptedMicroUsd: 750_001,
        costPerUsedMicroUsd: 1_500_001,
      },
    ]);
  });

  it("is empty with no runs", () => {
    expect(plannerWeeks([])).toEqual([]);
  });
});
