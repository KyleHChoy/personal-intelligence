import { AutonomyRules } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { autonomyRules, autonomyWindows, closeNoTieRule, loopWindows } from "./autonomy.ts";

// The three triggers' windows and the deferred cards' age, from `ontology/autonomy.json`.

const NOW = new Date("2026-10-27T12:00:00.000Z");
const RULES = {
  version: 2,
  meetingSoonHours: 36,
  commitmentDueHours: 48,
  replyOwedDays: 3,
  replyOwedWithinDays: 14,
  deferredCardDays: 14,
  closeNoTieTiers: ["inner" as const, "close" as const],
  closeNoTiePeople: 30,
};

describe("autonomy rules", () => {
  it("ontology/autonomy.json parses, with its windows (36 hours, 48 hours, 3 days, 14 days)", () => {
    expect(autonomyRules()).toMatchObject({
      meetingSoonHours: 36,
      commitmentDueHours: 48,
      replyOwedDays: 3,
      deferredCardDays: 14,
    });
    expect(autonomyRules().replyOwedWithinDays).toBeGreaterThan(autonomyRules().replyOwedDays);
  });

  it("refuses a table whose reply window ends before it starts", () => {
    expect(AutonomyRules.safeParse(RULES).success).toBe(true);
    expect(AutonomyRules.safeParse({ ...RULES, replyOwedWithinDays: 3 }).success).toBe(false);
    expect(AutonomyRules.safeParse({ ...RULES, extra: 1 }).success).toBe(false);
  });

  it("turns the rules into one tick's times", () => {
    expect(autonomyWindows(NOW, RULES)).toEqual({
      meetingUntil: new Date("2026-10-29T00:00:00.000Z"),
      dueUntil: new Date("2026-10-29T12:00:00.000Z"),
      replyFrom: new Date("2026-10-13T12:00:00.000Z"),
      replyUntil: new Date("2026-10-24T12:00:00.000Z"),
      deferredBefore: new Date("2026-10-13T12:00:00.000Z"),
    });
  });

  it("reply_owed is retired from the rule data: an owed reply is a free signal, and no task is raised for one", () => {
    expect(autonomyRules().replyOwedOn).toBe(false);
  });

  // The system assigns work as well as the agents: something dated with nobody else on it is the
  // owner's own deadline or reminder, and an agent prepares it.
  it("upcoming calendar deadlines raise a task: deadline_soon is on in the rule data", () => {
    expect(autonomyRules().deadlineSoonOn).toBe(true);
  });

  it("goal_review and meeting_followup are on in the rule data, each with its window set", () => {
    expect(autonomyRules()).toMatchObject({
      goalReviewOn: true,
      goalReviewDays: 14,
      meetingFollowUpOn: true,
      meetingFollowUpHours: 36,
    });
    expect(loopWindows(NOW, { ...autonomyRules(), goalReviewOn: false, meetingFollowUpOn: false })).toEqual({
      goalQuietSince: null,
      followUpFrom: null,
    });
    expect(AutonomyRules.safeParse({ ...RULES, goalReviewOn: true }).success).toBe(false);
    expect(AutonomyRules.safeParse({ ...RULES, meetingFollowUpOn: true }).success).toBe(false);
  });

  it("turns each switch that is on into its window, and leaves one off null", () => {
    const on = { ...RULES, goalReviewOn: true, goalReviewDays: 14, meetingFollowUpOn: true, meetingFollowUpHours: 36 };
    expect(AutonomyRules.safeParse(on).success).toBe(true);
    expect(loopWindows(NOW, on)).toEqual({
      goalQuietSince: new Date("2026-10-13T12:00:00.000Z"),
      followUpFrom: new Date("2026-10-26T00:00:00.000Z"),
    });
    expect(loopWindows(NOW, { ...on, meetingFollowUpOn: false })).toEqual({
      goalQuietSince: new Date("2026-10-13T12:00:00.000Z"),
      followUpFrom: null,
    });
    // A window with no switch is off: absent is off.
    expect(loopWindows(NOW, { ...RULES, goalReviewDays: 14 })).toEqual({ goalQuietSince: null, followUpFrom: null });
  });

  it("the planner's belief_changed runs are off in the rule data", () => {
    expect(autonomyRules().beliefChangedRunsOn).toBe(false);
  });

  // Absent, every such card went to the owner untried.
  it("agents try a card first: card_question is on in the rule data", () => {
    expect(autonomyRules().cardAttemptsOn).toBe(true);
  });

  it("each window moves with the rule that sets it, and with the tick", () => {
    expect(autonomyWindows(NOW, { ...RULES, meetingSoonHours: 1 }).meetingUntil).toEqual(
      new Date("2026-10-27T13:00:00.000Z"),
    );
    expect(autonomyWindows(NOW, { ...RULES, deferredCardDays: 1 }).deferredBefore).toEqual(
      new Date("2026-10-26T12:00:00.000Z"),
    );
    const later = new Date(NOW.getTime() + 1000);
    expect(autonomyWindows(later, RULES).replyUntil.getTime() - autonomyWindows(NOW, RULES).replyUntil.getTime()).toBe(
      1000,
    );
  });

  // close_no_tie's candidates are the people of these tiers, closest tier first.
  it("close_no_tie takes the inner and close tiers, at most 30 people at once", () => {
    expect(closeNoTieRule()).toEqual({ tiers: ["inner", "close"], people: 30 });
  });

  it("orders the tiers closest first whatever order the table lists them in, and refuses a bad table", () => {
    expect(closeNoTieRule({ ...RULES, closeNoTieTiers: ["regular", "inner", "close"] }).tiers).toEqual([
      "inner",
      "close",
      "regular",
    ]);
    expect(closeNoTieRule({ ...RULES, closeNoTiePeople: 5 }).people).toBe(5);
    expect(AutonomyRules.safeParse({ ...RULES, closeNoTieTiers: [] }).success).toBe(false);
    expect(AutonomyRules.safeParse({ ...RULES, closeNoTieTiers: ["inner", "inner"] }).success).toBe(false);
    expect(AutonomyRules.safeParse({ ...RULES, closeNoTieTiers: ["warm"] }).success).toBe(false);
    expect(AutonomyRules.safeParse({ ...RULES, closeNoTiePeople: 0 }).success).toBe(false);
    const { closeNoTiePeople: _, ...without } = RULES;
    expect(AutonomyRules.safeParse(without).success).toBe(false);
  });
});
