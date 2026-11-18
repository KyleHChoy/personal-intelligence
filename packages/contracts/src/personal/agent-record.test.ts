import { describe, expect, it } from "vitest";
import {
  AGENT_RECORD_DEFERRED_ANSWERS,
  AGENT_RECORD_NO_ANSWERS,
  AgentRecord,
  type AgentRecordCounts,
  AgentStanding,
  AgentWeek,
  agentRecordAsked,
  agentRecordEmpty,
  agentRecordOf,
  agentStandingOf,
  BET_BUDGET_MOST,
  betBudget,
  STANDING_CODES_MOST,
} from "./agent-record.ts";
import { CARD_CANT_TELL } from "./card-attempts.ts";
import { CARD_OPTIONS } from "./card-kinds.ts";

const NONE: AgentRecordCounts = {
  done: 0,
  used: 0,
  raised: 0,
  yes: 0,
  no: 0,
  deferred: 0,
  byAgent: 0,
  waiting: 0,
  other: 0,
  noCodes: [],
  overturned: 0,
  refused: 0,
  betsOpen: 0,
  betsUsed: 0,
  betsUnused: 0,
  betsPlaced: 0,
  betsEarned: 0,
  betsTakenBack: 0,
};

describe("an agent's own record", () => {
  it("counts the decline codes, the most given first, ties in the list's order, at most three, unknown codes left out", () => {
    const record = agentRecordOf({
      ...NONE,
      done: 4,
      used: 1,
      raised: 6,
      yes: 1,
      no: 2,
      deferred: 1,
      byAgent: 1,
      waiting: 1,
      noCodes: ["wrong_person", "not_worth_it", "wrong_timing", "not_worth_it", "other", "cancelled"],
    });
    expect(record.noReasons).toEqual([
      { reason: "not_worth_it", count: 2 },
      { reason: "wrong_timing", count: 1 },
      { reason: "wrong_person", count: 1 },
    ]);
    expect(record).toMatchObject({ days: 28, work: { done: 4, used: 1 }, questions: { raised: 6, byAgent: 1 } });
    expect(agentRecordAsked(record)).toBe(5);
    expect(AgentRecord.parse(record)).toEqual(record);
  });

  it("refuses a record whose counts disagree, or that carries anything but its counts", () => {
    const record = agentRecordOf({ ...NONE, done: 2, used: 1, raised: 2, yes: 1, no: 1 });
    expect(AgentRecord.safeParse(record).success).toBe(true);
    expect(AgentRecord.safeParse({ ...record, work: { done: 1, used: 2 } }).success).toBe(false);
    expect(AgentRecord.safeParse({ ...record, questions: { ...record.questions, yes: 2 } }).success).toBe(false);
    expect(AgentRecord.safeParse({ ...record, note: "text" }).success).toBe(false);
  });

  it("is empty only with nothing done, raised, declined with a reason, overturned or refused", () => {
    expect(agentRecordEmpty(agentRecordOf(NONE))).toBe(true);
    for (const field of ["done", "overturned", "refused"] as const)
      expect(agentRecordEmpty(agentRecordOf({ ...NONE, [field]: 1 }))).toBe(false);
    expect(agentRecordEmpty(agentRecordOf({ ...NONE, raised: 1, waiting: 1 }))).toBe(false);
    expect(agentRecordEmpty(agentRecordOf({ ...NONE, noCodes: ["other"] }))).toBe(false);
    for (const field of ["betsOpen", "betsUsed", "betsUnused"] as const)
      expect(agentRecordEmpty(agentRecordOf({ ...NONE, [field]: 1 }))).toBe(false);
  });

  it("places every answer a card takes, and cant_tell, as no, deferred or yes, none twice", () => {
    const answers = new Set([...Object.values(CARD_OPTIONS).flat(), CARD_CANT_TELL]);
    const no = new Set<string>(AGENT_RECORD_NO_ANSWERS);
    const deferred = new Set<string>(AGENT_RECORD_DEFERRED_ANSWERS);
    expect([...no].filter((one) => deferred.has(one))).toEqual([]);
    // ledger.auto_blocked's noes, and a decline and a wrong, which say no to what an agent put.
    expect([...no].sort()).toEqual(
      ["reject", "no", "no_go", "dismiss", "not_now", "different", "decline", "wrong"].sort(),
    );
    // Every listed answer is one a card or an agent's attempt can give.
    expect([...no, ...deferred].filter((one) => !answers.has(one))).toEqual([]);
    // The yeses, by elimination, as reviewed: a new answer must be placed here or in a list.
    expect([...answers].filter((one) => !no.has(one) && !deferred.has(one)).sort()).toEqual(
      [
        "accept",
        "acknowledge",
        "all_different",
        "all_same",
        "approve",
        "confirm",
        "done",
        "go",
        "one_person",
        "pursue",
        "right",
        "same",
        "seen",
        "shared",
      ].sort(),
    );
  });

  it("a bet budget starts at 3, gains one for each bet settled used in the week and loses two for each answer taken back in it, held to 1 to 10", () => {
    expect(betBudget(0, 0)).toBe(3);
    expect(betBudget(2, 0)).toBe(5);
    expect(betBudget(2, 1)).toBe(3);
    expect(betBudget(0, 1)).toBe(1);
    expect(betBudget(0, 5)).toBe(1);
    expect(betBudget(20, 0)).toBe(BET_BUDGET_MOST);
    // Stopping asking never pays: one guess overturned costs more than one used bet earns.
    expect(betBudget(4, 1)).toBeLessThan(betBudget(3, 0));
  });

  it("the record's bets, with what this week's budget leaves after the bets placed in it", () => {
    const record = agentRecordOf({
      ...NONE,
      betsOpen: 2,
      betsUsed: 3,
      betsUnused: 1,
      betsPlaced: 4,
      betsEarned: 3,
      betsTakenBack: 1,
    });
    expect(record.bets).toEqual({ open: 2, used: 3, unused: 1, budget: 4, left: 0 });
    expect(agentRecordOf({ ...NONE, betsPlaced: 1 }).bets).toMatchObject({ budget: 3, left: 2 });
    // Never below none, though a budget can shrink under what was placed.
    expect(agentRecordOf({ ...NONE, betsPlaced: 2, betsTakenBack: 1 }).bets).toMatchObject({ budget: 1, left: 0 });
    expect(AgentRecord.parse(record)).toEqual(record);
    expect(AgentRecord.safeParse({ ...record, bets: { ...record.bets, left: 5 } }).success).toBe(false);
    expect(AgentRecord.safeParse({ ...record, bets: { ...record.bets, budget: 11 } }).success).toBe(false);
  });

  it("the standing counts this week's bets and questions, and its refusals by code, the most first, ties by code, at most five", () => {
    const standing = agentStandingOf({
      betsPlaced: 2,
      betsEarned: 1,
      betsTakenBack: 0,
      asked: 3,
      paid: 2,
      refused: 2,
      refusals: {
        question_unpaid: 2,
        vague_summary: 1,
        bet_budget_spent: 1,
        schema_too_big: 1,
        invalid_request: 1,
        not_permitted: 1,
        "Not A Code": 4,
        none_at_all: 0,
      },
    });
    expect(standing).toEqual({
      days: 7,
      bets: { placed: 2, used: 1, budget: 4, left: 2 },
      questions: { asked: 3, paid: 2, unpaid: 1, refused: 2 },
      refusals: [
        { code: "question_unpaid", count: 2 },
        { code: "bet_budget_spent", count: 1 },
        { code: "invalid_request", count: 1 },
        { code: "not_permitted", count: 1 },
        { code: "schema_too_big", count: 1 },
      ],
    });
    expect(standing.refusals).toHaveLength(STANDING_CODES_MOST);
    expect(AgentStanding.parse(standing)).toEqual(standing);
    // Never below none left, though a budget can shrink under what was placed.
    expect(
      agentStandingOf({ betsPlaced: 3, betsEarned: 0, betsTakenBack: 1, asked: 0, paid: 0, refused: 0, refusals: {} })
        .bets,
    ).toEqual({ placed: 3, used: 0, budget: 1, left: 0 });
    expect(AgentStanding.safeParse({ ...standing, questions: { ...standing.questions, unpaid: 0 } }).success).toBe(
      false,
    );
  });

  it("a week holds each bet placed in it one way, never more paid than asked", () => {
    const week = {
      week: "2026-11-09",
      bets: { placed: 3, used: 1, unused: 1, open: 1, budget: 4, left: 1 },
      questions: { asked: 2, paid: 1, refused: 1 },
      takenBack: 0,
    };
    expect(AgentWeek.parse(week)).toEqual(week);
    expect(AgentWeek.safeParse({ ...week, bets: { ...week.bets, open: 0 } }).success).toBe(false);
    expect(AgentWeek.safeParse({ ...week, questions: { asked: 1, paid: 2, refused: 0 } }).success).toBe(false);
    expect(AgentWeek.safeParse({ ...week, week: "2026-11-31" }).success).toBe(false);
  });
});
