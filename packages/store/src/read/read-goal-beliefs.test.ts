import type { GoalId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { isStale } from "../core/goal-review.ts";
import { type ComputedGoal, requestGoals } from "./read-goal-beliefs.ts";

// A goal's review window counted in days of the owner's time zone, support dated after the read
// counting as at the read, and the goals a reasoner's request carries.

const at = (iso: string): number => Date.parse(iso);

describe("a goal's review window", () => {
  it("counts the owner's local days: the window's last day is not stale, the day after is", () => {
    // 23:00 on 31 July in Chicago is 04:00 on 1 August in UTC.
    const last = at("2026-08-01T04:00:00.000Z");
    // 29 September is the 60th local day after 31 July; 30 September the 61st.
    expect(isStale(last, at("2026-09-29T12:00:00.000Z"), 60, "America/Chicago")).toBe(false);
    expect(isStale(last, at("2026-09-30T12:00:00.000Z"), 60, "America/Chicago")).toBe(true);
    // In UTC the same instants are one local day later: 30 September is still within 60.
    expect(isStale(last, at("2026-09-30T12:00:00.000Z"), 60, null)).toBe(false);
    expect(isStale(last, at("2026-10-01T12:00:00.000Z"), 60, null)).toBe(true);
  });

  it("support dated after the read counts as at the read", () => {
    expect(isStale(at("2027-01-01T00:00:00.000Z"), at("2026-10-01T00:00:00.000Z"), 30, null)).toBe(false);
  });
});

describe("a reasoner's request goals", () => {
  const goal = (id: string, over: Partial<ComputedGoal> = {}): ComputedGoal => ({
    id,
    goal: id as GoalId,
    factKeyFp: "f".repeat(64),
    statement: `words of ${id}`,
    status: "active",
    setAt: "2026-01-01T00:00:00.000Z",
    stale: false,
    disputed: false,
    reversal: null,
    ...over,
  });

  it("carries every active goal the owner set, a stale one marked, in goal id order; no other", () => {
    const goals = [
      goal("gol_B"),
      goal("gol_A", { stale: true }),
      goal("gol_C", { status: "paused" }),
      goal("f".repeat(64), { goal: null }),
    ];
    expect(requestGoals(goals)).toEqual([
      { id: "gol_A", statement: { untrusted: "words of gol_A" }, stale: true },
      { id: "gol_B", statement: { untrusted: "words of gol_B" } },
    ]);
  });
});
