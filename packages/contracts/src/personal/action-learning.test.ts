import { describe, expect, it } from "vitest";
import { OWNER_ACTION_LEARNING, type OwnerActionTeaching, teachesOf } from "./action-learning.ts";
import { OwnerDecisionKind } from "./owner.ts";

// Every owner decision kind says how it teaches. The store's
// card-kinds-learning.test.ts checks that every card kind has an `answer` entry.

const entries = (): [string, OwnerActionTeaching][] => [
  ...OwnerDecisionKind.options
    .filter((kind): kind is Exclude<OwnerDecisionKind, "answer"> => kind !== "answer")
    .map((kind): [string, OwnerActionTeaching] => [kind, OWNER_ACTION_LEARNING[kind]]),
  ...Object.entries(OWNER_ACTION_LEARNING.answer).map(([card, teaching]): [string, OwnerActionTeaching] => [
    `answer:${card}`,
    teaching,
  ]),
];

describe("OWNER_ACTION_LEARNING", () => {
  it("has an entry for every decision kind, and nothing else", () => {
    for (const kind of OwnerDecisionKind.options) expect(Object.hasOwn(OWNER_ACTION_LEARNING, kind), kind).toBe(true);
    expect(Object.keys(OWNER_ACTION_LEARNING).sort()).toEqual([...OwnerDecisionKind.options].sort());
  });

  it("gives every none a reason and every ruling a proposer", () => {
    for (const [name, teaching] of entries()) {
      expect(["plan", "ruling", "none"], name).toContain(teaching.teaches);
      if (teaching.teaches === "none") expect(teaching.reason.trim().length, name).toBeGreaterThan(0);
      if (teaching.teaches === "ruling") expect(["tier", "confirm_rate", "pending"], name).toContain(teaching.proposer);
    }
  });

  it("classifies each decision kind by what it teaches", () => {
    expect(teachesOf("warmth_tier")).toEqual({ teaches: "ruling", proposer: "tier" });
    expect(teachesOf("goal_reword")).toEqual({ teaches: "plan" });
    // The owner's adoption and removal of a source's goal, and their undos.
    for (const kind of ["goal_adopt", "goal_adopt_undo", "goal_hide", "goal_hide_lift"] as const)
      expect(teachesOf(kind)).toEqual({ teaches: "plan" });
    expect(teachesOf("list_add")).toEqual({ teaches: "ruling", proposer: "pending" });
    expect(teachesOf("erase")?.teaches).toBe("none");
    expect(teachesOf("card_label")?.teaches).toBe("none");
    expect(teachesOf("answer", "opportunity_decision")).toEqual({ teaches: "plan" });
    for (const card of ["same_person", "shared_address", "about_you", "same_fact"])
      expect(teachesOf("answer", card)?.teaches, card).toBe("ruling");
    for (const card of [
      "lesson",
      "research_request",
      "client_preference",
      "draft_waiting",
      "notice",
      "ignore_narrowed",
      "ruling_carry",
      "calibration_drift",
      "stale_restatement",
    ])
      expect(teachesOf("answer", card)?.teaches, card).toBe("none");
  });

  it("answers null for an answer with no card kind or an unknown one", () => {
    expect(teachesOf("answer")).toBeNull();
    expect(teachesOf("answer", "no_such_kind")).toBeNull();
    expect(teachesOf("answer", "toString")).toBeNull();
  });

  it("answers null for a kind read from the database that the registry lacks", () => {
    expect(teachesOf("no_such_kind" as OwnerDecisionKind)).toBeNull();
    expect(teachesOf("constructor" as OwnerDecisionKind)).toBeNull();
  });
});
