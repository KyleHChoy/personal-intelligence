import { describe, expect, it } from "vitest";
import { secondDegreeRules } from "../views/second-degree.ts";
import {
  type ExploreCandidate,
  type ExploredFlag,
  type FrontierParts,
  frontierValue,
  planExplore,
} from "./frontier.ts";
import { planGapFlags } from "./gaps.ts";

// Synthetic ids only.

const rules = secondDegreeRules();
const NOW = new Date("2026-10-30T12:00:00Z");
const parts = (over: Partial<FrontierParts> = {}): FrontierParts => ({
  goalTarget: false,
  goalPath: false,
  meetingSoon: false,
  namerTiers: [],
  namedDays: 0,
  missing: ["identity"],
  ...over,
});
const node = (subject: string, over: Partial<FrontierParts> = {}, labelKey = "own"): ExploreCandidate => ({
  trigger: "explore",
  subject,
  labelKey,
  goal: null,
  source: subject,
  at: "2026-10-29T00:00:00Z",
  frontier: parts(over),
});
const none = {
  open: [],
  history: { quiet: new Set<string>(), declined: new Map() },
  explored: [] as ExploredFlag[],
  now: NOW,
  rules,
};
const raised = (plan: ReturnType<typeof planExplore>): string[] =>
  plan.filter((one) => !one.hold).map((one) => one.subject);

describe("frontierValue", () => {
  it("weighs the goal, the path, a meeting soon and each namer by tier, from the rule file", () => {
    const score = frontierValue(
      parts({
        goalTarget: true,
        goalPath: true,
        meetingSoon: true,
        namerTiers: ["inner", "close", "regular", "known", "none"],
      }),
      rules,
    );
    expect(score.parts).toEqual({
      goalTarget: 100,
      goalPath: 50,
      meetingSoon: 40,
      namers: 5 * 3 + 5 * 2 + 5 * 1.5 + 5 + 5,
      base: 1,
      recency: 1,
      lacking: true,
    });
    expect(score.value).toBe(100 + 50 + 40 + 42.5 + 1);
  });

  it("halves for every recencyHalfLifeDays since it was last named", () => {
    expect(frontierValue(parts({ namerTiers: ["inner"], namedDays: 90 }), rules).value).toBeCloseTo(8);
    expect(frontierValue(parts({ namerTiers: ["inner"], namedDays: 180 }), rules).value).toBeCloseTo(4);
    expect(frontierValue(parts({ namerTiers: ["inner"], namedDays: null }), rules).value).toBe(15);
  });

  it("a node only a claim names scores the base, more the more recently named; with no naming claim, 0", () => {
    expect(frontierValue(parts({ namedDays: 0 }), rules).value).toBe(rules.value.base);
    expect(frontierValue(parts({ namedDays: 0 }), rules).value).toBeGreaterThan(
      frontierValue(parts({ namedDays: 30 }), rules).value,
    );
    expect(frontierValue(parts({ namedDays: 30 }), rules).value).toBeGreaterThan(0);
    expect(frontierValue(parts({ namedDays: null }), rules).value).toBe(0);
  });

  it("a namer of any tier, a meeting and a goal each outrank a node only a claim names", () => {
    const base = frontierValue(parts({ namedDays: 0 }), rules).value;
    for (const tier of ["inner", "close", "regular", "none"])
      expect(frontierValue(parts({ namerTiers: [tier], namedDays: 30 }), rules).value).toBeGreaterThan(base);
    expect(frontierValue(parts({ meetingSoon: true, namedDays: 30 }), rules).value).toBeGreaterThan(base);
    expect(frontierValue(parts({ goalPath: true, namedDays: 30 }), rules).value).toBeGreaterThan(base);
    expect(frontierValue(parts({ goalTarget: true, namedDays: 30 }), rules).value).toBeGreaterThan(base);
  });

  it("a node lacking nothing scores 0", () => {
    const score = frontierValue(parts({ goalTarget: true, namerTiers: ["inner", "inner"], missing: [] }), rules);
    expect(score.value).toBe(0);
    expect(score.parts.lacking).toBe(false);
    expect(frontierValue(parts({ missing: [] }), rules).value).toBe(0);
  });

  it("a goal target scores above a namer of any tier", () => {
    const target = frontierValue(parts({ goalTarget: true }), rules).value;
    for (const tier of ["inner", "close", "regular", "none"])
      expect(target).toBeGreaterThan(frontierValue(parts({ namerTiers: [tier] }), rules).value);
  });
});

describe("planExplore", () => {
  it("raises every goal-relevant node, then two others a day, highest first, ties by the lower id", () => {
    const plan = planExplore({
      ...none,
      candidates: [
        node("ent_e", { namerTiers: ["none"] }),
        node("ent_d", { namerTiers: ["inner"] }),
        node("ent_c", { namerTiers: ["none"] }),
        node("ent_b", { goalPath: true }),
        node("ent_a", { goalTarget: true }),
        node("ent_f", { namerTiers: ["none"] }),
      ],
    });
    expect(raised(plan).sort()).toEqual(["ent_a", "ent_b", "ent_c", "ent_d"]);
    expect(
      plan
        .filter((one) => one.hold)
        .map((one) => one.subject)
        .sort(),
    ).toEqual(["ent_e", "ent_f"]);
  });

  it("the day's budget is per label, and counts what was raised earlier today outside goals", () => {
    const explored: ExploredFlag[] = [
      { subject: "ent_x", labelKey: "own", at: "2026-10-30T01:00:00Z", value: 5, goal: false },
      { subject: "ent_y", labelKey: "own", at: "2026-10-30T02:00:00Z", value: 100, goal: true },
      { subject: "ent_z", labelKey: "own", at: "2026-10-29T23:00:00Z", value: 5, goal: false },
    ];
    const plan = planExplore({
      ...none,
      explored,
      candidates: [
        node("ent_c", { namerTiers: ["none"] }),
        node("ent_d", { namerTiers: ["inner"] }),
        node("ent_k", { namerTiers: ["none"] }, "employer:x"),
      ],
    });
    expect(raised(plan).sort()).toEqual(["ent_d", "ent_k"]);
  });

  it("nodes only a claim names are explored within the day's two, most recently named first, and rest after", () => {
    const candidates = [
      node("ent_a", { namedDays: 40 }),
      node("ent_b", { namedDays: 2 }),
      node("ent_c", { namedDays: 10 }),
      node("ent_d", { namedDays: null }),
    ];
    const plan = planExplore({ ...none, candidates });
    expect(raised(plan)).toEqual(["ent_b", "ent_c"]);
    expect(plan.map((one) => one.subject).sort()).toEqual(["ent_a", "ent_b", "ent_c"]);
    // The next day: the two explored rest, so the third takes a place; their value has not risen.
    const explored: ExploredFlag[] = plan
      .filter((one) => !one.hold)
      .map((one) => ({
        subject: one.subject,
        labelKey: "own",
        at: "2026-10-30T12:00:00Z",
        value: one.score.value,
        goal: false,
      }));
    const next = planExplore({ ...none, explored, now: new Date("2026-10-31T12:00:00Z"), candidates });
    expect(raised(next)).toEqual(["ent_a"]);
  });

  it("a namer outranks a node only a claim names for the day's two", () => {
    const plan = planExplore({
      ...none,
      candidates: [
        node("ent_a", { namedDays: 0 }),
        node("ent_b", { namedDays: 0 }),
        node("ent_c", { namerTiers: ["none"], namedDays: 90 }),
      ],
    });
    expect(raised(plan).sort()).toEqual(["ent_a", "ent_c"]);
  });

  it("a node lacking nothing does not hold, so an open flag on it closes", () => {
    const plan = planExplore({ ...none, candidates: [node("ent_a", { goalTarget: true, missing: [] })] });
    expect(plan).toEqual([]);
  });

  it("a rested node returns early only when its value rises above the value it was raised at", () => {
    const value = frontierValue(parts({ namerTiers: ["inner"] }), rules).value;
    const explored: ExploredFlag[] = [
      { subject: "ent_a", labelKey: "own", at: "2026-10-20T00:00:00Z", value, goal: false },
    ];
    expect(raised(planExplore({ ...none, explored, candidates: [node("ent_a", { namerTiers: ["inner"] })] }))).toEqual(
      [],
    );
    expect(
      raised(planExplore({ ...none, explored, candidates: [node("ent_a", { namerTiers: ["inner", "none"] })] })),
    ).toEqual(["ent_a"]);
    // Past exploreRestDays it may come back at any value.
    const old: ExploredFlag[] = [
      { subject: "ent_a", labelKey: "own", at: "2026-09-01T00:00:00Z", value: 15, goal: false },
    ];
    expect(
      raised(planExplore({ ...none, explored: old, candidates: [node("ent_a", { namerTiers: ["inner"] })] })),
    ).toEqual(["ent_a"]);
  });

  it("a declined node and one with a flag open are never raised by code", () => {
    const declined = new Map([["explore\nent_a", new Set(["ent_a"])]]);
    const open = [{ id: "opp_1", trigger: "explore" as const, subject: "ent_b", labelKey: "own", held: false }];
    const plan = planExplore({
      ...none,
      open,
      history: { quiet: new Set(), declined },
      candidates: [
        node("ent_a", { goalTarget: true }),
        node("ent_b", { namerTiers: ["inner"] }),
        node("ent_c", { namerTiers: ["none"] }),
      ],
    });
    expect(raised(plan)).toEqual(["ent_c"]);
  });

  it("planGapFlags raises the chosen, keeps an open flag on a held node open, and passes over quiet for explore", () => {
    const plan = planExplore({
      ...none,
      candidates: [
        node("ent_a", { goalTarget: true }),
        node("ent_b", { namerTiers: ["none"] }),
        node("ent_c", { namerTiers: ["none"] }),
        node("ent_d", { namerTiers: ["none"] }),
      ],
    });
    const open = [{ id: "opp_d", trigger: "explore" as const, subject: "ent_d", labelKey: "own", held: false }];
    const gaps = planGapFlags({
      candidates: plan,
      open,
      history: { quiet: new Set(["explore\nent_a"]), declined: new Map() },
    });
    expect(gaps.raise.map((one) => one.gap.subject).sort()).toEqual(["ent_a", "ent_b", "ent_c"]);
    expect(gaps.close).toEqual([]);
  });

  it("planGapFlags raises no explore gap planExplore did not choose", () => {
    const gaps = planGapFlags({
      candidates: [node("ent_a", { goalTarget: true })],
      open: [],
      history: { quiet: new Set(), declined: new Map() },
    });
    expect(gaps.raise).toEqual([]);
  });
});
