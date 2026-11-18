import { FactType } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  CLAIM_RELATION_KINDS,
  CONTRADICTION_CLAIMS,
  CONTRADICTION_SCENARIOS,
  CONTRADICTIONS,
  contradictionCounts,
  wilsonInterval,
} from "./contradictions.ts";
import { world } from "./world.ts";

// The set loads, every pair names claims the set holds
// about people the synthetic world holds, and every relation is a relation kind or `unrelated`.

const WORLD_TEXT = JSON.stringify(world({ now: new Date("2026-10-01T00:00:00Z") }));
const RELATIONS = new Set<string>([...CLAIM_RELATION_KINDS, "unrelated"]);

describe("the contradiction set", () => {
  it("holds at least 200 pairs, at least a third of them unrelated", () => {
    const counts = contradictionCounts();
    expect(counts.total).toBeGreaterThanOrEqual(200);
    expect(counts.byRelation.unrelated * 3).toBeGreaterThanOrEqual(counts.total);
  });

  it("names, in every pair, claims the set holds about people the world holds", () => {
    const held = new Map(CONTRADICTION_CLAIMS.map((claim) => [claim.id, claim]));
    expect(held.size).toBe(CONTRADICTION_CLAIMS.length);
    for (const pair of CONTRADICTIONS) {
      for (const claim of [pair.a, pair.b]) {
        expect(held.get(claim.id)).toBe(claim);
        expect(FactType.safeParse(claim.type).success).toBe(true);
        for (const address of [claim.subject, claim.statedBy])
          expect(WORLD_TEXT.includes(address), `${pair.id} ${address}`).toBe(true);
      }
      expect(pair.a.id).not.toBe(pair.b.id);
    }
  });

  it("labels every pair with a relation kind or unrelated, and every prevails with how it is settled", () => {
    for (const pair of CONTRADICTIONS) {
      expect(RELATIONS.has(pair.relation)).toBe(true);
      if (pair.relation === "prevails") expect(pair.settledBy !== undefined && pair.winner !== undefined).toBe(true);
    }
  });

  it("covers every scenario and every relation kind", () => {
    const { byRelation, byScenario } = contradictionCounts();
    for (const scenario of CONTRADICTION_SCENARIOS) expect(byScenario[scenario]).toBeGreaterThan(0);
    for (const kind of CLAIM_RELATION_KINDS) expect(byRelation[kind]).toBeGreaterThan(0);
    expect(CONTRADICTIONS.some((pair) => pair.settledBy === "evidence")).toBe(true);
    expect(CONTRADICTIONS.some((pair) => pair.settledBy === "model")).toBe(true);
  });

  it("gives a precision interval that narrows with more judged pairs", () => {
    const small = wilsonInterval(19, 20);
    const large = wilsonInterval(95, 100);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});
