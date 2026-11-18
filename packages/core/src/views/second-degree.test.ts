import { SecondDegreeRules } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type PrepCandidate, prepOrder, secondDegreeRules } from "./second-degree.ts";

// The second degree's numbers, from `ontology/second-degree.json`.

describe("second-degree rules", () => {
  it("the rule file loads and refuses a weight outside 0 to 1", () => {
    const rules = secondDegreeRules();
    expect(rules).toMatchObject({
      namedPerLabelPerDay: 20,
      contactOrgsPerLabelPerDay: 1000,
      acquaintanceWeight: 0.5,
      introOfferWeight: { offered: 1, suggested: 0.5 },
      introOfferDays: 365,
      reportedWeight: 0.3,
      maxHops: 4,
      namedMeetingHours: 36,
      prepPerAttendee: 5,
      mapNamedPerNode: 5,
      explorePerDay: 2,
      exploreRestDays: 30,
      value: {
        goalTarget: 100,
        goalPath: 50,
        meetingSoon: 40,
        perNamer: 5,
        base: 1,
        tierFactor: { inner: 3, close: 2, regular: 1.5 },
        recencyHalfLifeDays: 90,
      },
    });
    for (const bad of [
      { ...rules, acquaintanceWeight: 1.5 },
      { ...rules, reportedWeight: -0.1 },
      { ...rules, introOfferWeight: { offered: 2, suggested: 0.5 } },
      { ...rules, introOfferWeight: { offered: 1, suggested: -1 } },
    ])
      expect(SecondDegreeRules.safeParse(bad).success).toBe(false);
    expect(SecondDegreeRules.safeParse({ ...rules, maxHops: 5 }).success).toBe(false);
    expect(SecondDegreeRules.safeParse({ ...rules, extra: 1 }).success).toBe(false);
  });
});

describe("prepOrder", () => {
  const line = (person: string, tie: PrepCandidate["tie"], extra: Partial<PrepCandidate> = {}): PrepCandidate => ({
    person,
    tie,
    goal: false,
    at: "2026-09-01T00:00:00.000Z",
    fact: "a".repeat(64),
    ...(tie === "intro_offer" ? { offer: "offered" as const } : {}),
    ...extra,
  });
  const people = (lines: PrepCandidate[]): string[] => lines.map((one) => one.person);

  it("a goal's target first, then offered, suggested, a relationship, an acquaintance, a connection, researched, reported, then heard", () => {
    const given = [
      line("heard", "relationship", { heard: true }),
      line("reported", "reported"),
      line("researched", "researched"),
      line("connection", "connection"),
      line("acquaintance", "acquaintance"),
      line("colleague", "relationship"),
      line("suggested", "intro_offer", { offer: "suggested" }),
      line("offered", "intro_offer"),
      line("goal", "reported", { goal: true }),
    ];
    expect(people(prepOrder(given, 20))).toEqual([
      "goal",
      "offered",
      "suggested",
      "colleague",
      "acquaintance",
      "connection",
      "researched",
      "reported",
      "heard",
    ]);
  });

  it("within a kind, newest first, then the lower cited id, then the lower person id", () => {
    const given = [
      line("old", "relationship", { at: "2026-08-01T00:00:00.000Z" }),
      line("high-fact", "relationship", { fact: "c".repeat(64) }),
      line("low-fact", "relationship", { fact: "b".repeat(64) }),
      line("new", "relationship", { at: "2026-09-02T00:00:00.000Z" }),
    ];
    expect(people(prepOrder(given, 20))).toEqual(["new", "low-fact", "high-fact", "old"]);
    expect(people(prepOrder([...given].reverse(), 20))).toEqual(["new", "low-fact", "high-fact", "old"]);
  });

  it("cuts to the cap in that order, each person once by their first line, so the cut is the same on every run", () => {
    const given = [
      line("p1", "reported"),
      line("p2", "acquaintance"),
      line("p1", "intro_offer", { offer: "suggested" }),
      line("p3", "connection"),
      line("p4", "relationship"),
      line("p5", "relationship", { heard: true }),
      line("p6", "intro_offer"),
      line("p7", "researched"),
    ];
    const cut = prepOrder(given, secondDegreeRules().prepPerAttendee);
    expect(people(cut)).toEqual(["p6", "p1", "p4", "p2", "p3"]);
    expect(cut[1]).toMatchObject({ tie: "intro_offer", offer: "suggested" });
    expect(people(prepOrder([...given].reverse(), 5))).toEqual(people(cut));
  });
});
