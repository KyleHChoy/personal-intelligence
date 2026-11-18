import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ListPeopleArgs, TIERS, Tier, WarmthLine, WarmthRules } from "./warmth.ts";

const table = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../../../../ontology/warmth.json", import.meta.url), "utf8"));

describe("warmth contracts", () => {
  it("the rule table in ontology/ loads", () => {
    expect(WarmthRules.parse(table()).caps).toEqual([5, 15, 50, 150]);
  });

  it("refuses a cap list that is not increasing", () => {
    expect(WarmthRules.safeParse({ ...table(), caps: [5, 15, 15, 150] }).success).toBe(false);
  });

  it("refuses a half-life of 0 or below", () => {
    expect(WarmthRules.safeParse({ ...table(), activeHalfLifeDays: 0 }).success).toBe(false);
    expect(WarmthRules.safeParse({ ...table(), depthHalfLifeDays: -1 }).success).toBe(false);
  });

  it("refuses a chat conversation gap or a daily answered-start cap of 0 or below (version 3)", () => {
    expect(WarmthRules.parse(table())).toMatchObject({
      version: 3,
      chatConversationGapMinutes: 30,
      answeredStartsPerDayMax: 1,
    });
    expect(WarmthRules.safeParse({ ...table(), chatConversationGapMinutes: 0 }).success).toBe(false);
    expect(WarmthRules.safeParse({ ...table(), chatConversationGapMinutes: -5 }).success).toBe(false);
    expect(WarmthRules.safeParse({ ...table(), answeredStartsPerDayMax: 0 }).success).toBe(false);
  });

  it("refuses a dormant active rank at or below its depth rank", () => {
    expect(WarmthRules.safeParse({ ...table(), dormantActiveRank: 15 }).success).toBe(false);
  });

  it("Tier is a closed list", () => {
    expect(TIERS).toEqual(["inner", "close", "regular", "known", "outer", "one-way"]);
    expect(Tier.safeParse("warm").success).toBe(false);
  });

  it("ListPeopleArgs refuses an unknown tier and a limit above 50", () => {
    expect(ListPeopleArgs.safeParse({ tiers: ["warm"] }).success).toBe(false);
    expect(ListPeopleArgs.safeParse({ limit: 51 }).success).toBe(false);
    expect(ListPeopleArgs.parse({ tiers: ["inner", "close"], dormant: true }).tiers).toEqual(["inner", "close"]);
  });

  it("a rebuilding line has no tier", () => {
    const line = {
      tier: null,
      tierSource: null,
      dormant: false,
      warmth: null,
      active: null,
      depth: null,
      firstTwoWayAt: null,
      lastTwoWayAt: null,
      replyRate: null,
      replyHours: null,
      theyStart: null,
      channels: [],
      stale: false,
      rebuilding: true,
    };
    expect(WarmthLine.parse(line).rebuilding).toBe(true);
    expect(WarmthLine.safeParse({ ...line, replyRate: 1.5 }).success).toBe(false);
  });
});
