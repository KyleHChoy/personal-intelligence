import { type EntityId, type Tier, WarmthLine } from "@intelligence/contracts/personal";
import { type Path, rankPathsByWeakestHop, warmthRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { groupLine, pathWeight, type WarmthRow, warmthOrder } from "./read-warmth.ts";

// The line a group is served from the stored rows that hold its
// members, and the order and path weight a line gives. Synthetic ids only.

const row = (entity: string, members: string[], tier: Tier, warmth: number): WarmthRow => ({
  entity_id: entity,
  members,
  tier,
  tier_source: "inferred",
  dormant: false,
  warmth: String(warmth),
  active: warmth,
  depth: warmth * 2,
  first_two_way_at: new Date("2025-01-02T00:00:00Z"),
  last_two_way_at: "2026-03-04T00:00:00Z",
  reply_rate: "0.5",
  reply_hours: null,
  they_start: 0.25,
  channels: ["email"],
});

describe("groupLine", () => {
  it("serves a row whose members are the group's as it is", () => {
    const line = groupLine([row("ent_a", ["ent_a"], "close", 3)], ["ent_a"]);
    expect(WarmthLine.parse(line)).toEqual({
      tier: "close",
      tierSource: "inferred",
      dormant: false,
      warmth: 3,
      active: 3,
      depth: 6,
      firstTwoWayAt: "2025-01-02T00:00:00.000Z",
      lastTwoWayAt: "2026-03-04T00:00:00.000Z",
      replyRate: 0.5,
      replyHours: null,
      theyStart: 0.25,
      channels: ["email"],
      stale: false,
      rebuilding: false,
    });
  });

  it("after a merge, serves the best-tiered member row, stale, with its tier", () => {
    const rows = [row("ent_a", ["ent_a"], "known", 9), row("ent_b", ["ent_b"], "close", 1)];
    expect(groupLine(rows, ["ent_a", "ent_b"])).toMatchObject({
      tier: "close",
      warmth: 1,
      stale: true,
      rebuilding: false,
    });
  });

  it("after a lift, serves the representative and the split member no tier, stale", () => {
    const rows = [row("ent_a", ["ent_a", "ent_b"], "inner", 5)];
    for (const members of [["ent_a"], ["ent_b"]])
      expect(groupLine(rows, members)).toMatchObject({
        tier: null,
        tierSource: null,
        warmth: null,
        stale: true,
        rebuilding: false,
      });
  });

  it("serves nothing for a person no row holds", () => {
    expect(groupLine([row("ent_a", ["ent_a"], "inner", 5)], ["ent_c"])).toBeUndefined();
  });
});

describe("warmthOrder and pathWeight", () => {
  const line = (tier: Tier | null, warmth: number | null): WarmthLine => ({
    ...(groupLine([row("ent_a", ["ent_a"], "inner", 1)], ["ent_a"]) as WarmthLine),
    tier,
    warmth,
  });

  it("orders by tier first, then warmth, with no tier and no line last", () => {
    const people = [
      { id: "known-hot", line: line("known", 40) },
      { id: "inner-cold", line: line("inner", 0.5) },
      { id: "inner-warm", line: line("inner", 2) },
      { id: "none", line: undefined },
      { id: "untiered", line: line(null, 1) },
    ];
    expect(people.sort((a, b) => warmthOrder(b.line) - warmthOrder(a.line)).map((one) => one.id)).toEqual([
      "inner-warm",
      "inner-cold",
      "known-hot",
      "untiered",
      "none",
    ]);
  });

  it("without tiers, orders by warmth alone, so a confirmed tier cannot be read from the order", () => {
    expect(warmthOrder(line("known", 40), false)).toBeGreaterThan(warmthOrder(line("inner", 2), false));
  });

  it("weighs an own-tie hop by its tier from the rule table, and none without a tier", () => {
    const weights = warmthRules().pathWeights;
    expect(pathWeight(line("inner", 1))).toBe(weights.inner);
    expect(pathWeight(line("known", 1))).toBe(weights.known);
    expect(pathWeight(line(null, null))).toBeUndefined();
    expect(pathWeight(undefined)).toBeUndefined();
  });

  it("find_paths prefers an inner hop over a shared organization, and a shared organization over a known hop", () => {
    const e = (id: string) => id as EntityId;
    const path = (...hops: [string, string, "own_tie" | "relationship" | "affiliation"][]): Path => ({
      score: 0,
      hops: hops.map(([from, to, via]) => ({ from: e(from), to: e(to), via, facts: [] })),
    });
    const viaInner = path(["owner", "i", "own_tie"], ["i", "t", "relationship"]);
    const viaOrganization = path(["owner", "o", "own_tie"], ["o", "t", "affiliation"]);
    const viaKnown = path(["owner", "k", "own_tie"], ["k", "t", "relationship"]);
    const own = new Map<string, number>(
      [
        ["i", line("inner", 1)],
        ["o", line("inner", 1)],
        ["k", line("known", 9)],
      ].map(([id, one]) => [id as string, pathWeight(one as WarmthLine) as number]),
    );
    const ranked = rankPathsByWeakestHop([viaKnown, viaOrganization, viaInner], own, e("t"), false);
    expect(ranked.map((one) => one.hops[0]?.to)).toEqual(["i", "o", "k"]);
  });
});
