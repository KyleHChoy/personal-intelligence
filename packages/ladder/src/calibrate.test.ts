import type {
  PointThresholds,
  PointVerdict,
  ThresholdBounds,
  ThresholdGrant,
  ThresholdName,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  bandOf,
  checkGrant,
  decides,
  effectiveSampleSize,
  effectiveThreshold,
  effectiveThresholds,
  findDrift,
  proposeThreshold,
  report,
  type ScoredVerdict,
  SUSPENDED_ON_DRIFT,
  weightOf,
  wilson,
} from "./calibrate.ts";

// Every verdict here is deliberate: the caller filters out hurried, batch and over-cap answers and
// never turns a release into a verdict.

const v = (p: number, verdict: PointVerdict, weight = 1): ScoredVerdict => ({ p, verdict, weight });
const many = (count: number, p: number, verdict: PointVerdict, weight = 1): ScoredVerdict[] =>
  Array.from({ length: count }, () => v(p, verdict, weight));
const bounds = (value: number, floor: number, ceiling: number): ThresholdBounds => ({ default: value, floor, ceiling });
const thr = (n: number): string => `thr_${"0".repeat(25)}${n}`;
const grant = (n: number, point: string, version: number, name: string, value: number): ThresholdGrant => ({
  id: thr(n),
  point,
  version,
  name,
  value,
  source: "proposal",
});

describe("bands, weights and intervals", () => {
  it("puts each probability in its band, the last band closed", () => {
    expect([0, 0.049, 0.05, 0.19, 0.2, 0.5, 0.79, 0.8, 0.95, 1].map(bandOf)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 5, 5]);
    expect(() => bandOf(1.01)).toThrow(RangeError);
    expect(() => bandOf(Number.NaN)).toThrow(RangeError);
  });

  it("weighs a verdict by its band's calls over the number drawn from it", () => {
    expect(weightOf(40, 5)).toBe(8);
    expect(weightOf(5, 5)).toBe(1);
    expect(() => weightOf(5, 0)).toThrow(RangeError);
  });

  it("gives the Wilson interval and the effective sample size", () => {
    const { low, high } = wilson(0.5, 10);
    expect(low).toBeCloseTo(0.2366, 4);
    expect(high).toBeCloseTo(0.7634, 4);
    expect(wilson(1, 20).high).toBe(1);
    expect(effectiveSampleSize([1, 1, 3])).toBeCloseTo(25 / 11, 12);
    expect(effectiveSampleSize([])).toBe(0);
  });
});

describe("what a threshold decides", () => {
  it("a hold, an accept and the lane say yes at or above; a clear and a reject say no at or below", () => {
    for (const name of ["hold", "accept", "lane"] as const)
      expect([decides({ name, value: 0.5 }, 0.5), decides({ name, value: 0.5 }, 0.49)]).toEqual(["yes", "no"]);
    for (const name of ["clear", "reject"] as const)
      expect([decides({ name, value: 0.5 }, 0.5), decides({ name, value: 0.5 }, 0.51)]).toEqual(["no", "yes"]);
  });
});

describe("report", () => {
  // A hold at 0.5, one verdict in each band, weighted as drawn.
  const table = [v(0.02, "no", 4), v(0.1, "no", 2), v(0.3, "yes", 2), v(0.6, "no"), v(0.9, "yes"), v(0.97, "yes")];

  it("gives the bands, precision, recall and agreement of a fixed table, weighted, with intervals", () => {
    const result = report(table, { name: "hold", value: 0.5 }, [v(0.9, "yes"), v(0.6, "no", 3)]);
    expect(result.n).toBe(6);
    expect(result.insufficient).toBe(true);
    expect(result.bands).toEqual([
      { band: 0, n: 1, yesShare: 0, meanP: 0.02 },
      { band: 1, n: 1, yesShare: 0, meanP: 0.1 },
      { band: 2, n: 1, yesShare: 1, meanP: 0.3 },
      { band: 3, n: 1, yesShare: 0, meanP: 0.6 },
      { band: 4, n: 1, yesShare: 1, meanP: 0.9 },
      { band: 5, n: 1, yesShare: 1, meanP: 0.97 },
    ]);
    // Held: 0.6 no, 0.9 yes, 0.97 yes. Yes items: 0.3 (weight 2), 0.9, 0.97.
    expect(result.precision).toBeCloseTo(2 / 3, 12);
    expect(result.recall).toBeCloseTo(0.5, 12);
    expect(result.agreement).toBeCloseTo(8 / 11, 12);
    expect(result.agreement28d).toBeCloseTo(1 / 4, 12);
    expect(result.intervals.precision).toEqual(wilson(2 / 3, 3));
    expect(result.intervals.recall).toEqual(wilson(0.5, 16 / 6));
    expect(result.intervals.agreement?.low).toBeCloseTo(wilson(8 / 11, 121 / 27).low, 12);
  });

  it("weights a band's share and mean", () => {
    const [band] = report([v(0.01, "yes", 3), v(0.03, "no")], { name: "hold", value: 0.5 }).bands;
    expect(band).toEqual({ band: 0, n: 2, yesShare: 0.75, meanP: 0.015 });
  });

  it("leaves a value with no denominator null", () => {
    const result = report([v(0.1, "no"), v(0.2, "no")], { name: "hold", value: 0.5 });
    expect([result.precision, result.recall, result.agreement28d, result.intervals.precision]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(result.agreement).toBe(1);
    expect(result.bands[5]).toEqual({ band: 5, n: 0, yesShare: null, meanP: null });
  });

  it("is insufficient under 30 verdicts or under 5 of either answer", () => {
    expect(report([...many(25, 0.9, "yes"), ...many(4, 0.1, "no")], null).insufficient).toBe(true);
    expect(report([...many(26, 0.9, "yes"), ...many(4, 0.1, "no")], null).insufficient).toBe(true);
    expect(report([...many(25, 0.9, "yes"), ...many(5, 0.1, "no")], null).insufficient).toBe(false);
  });

  it("gives identity_rank, which has no threshold, its bands alone", () => {
    const result = report(table, null);
    expect(result.bands.map((band) => band.n)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([result.precision, result.recall, result.agreement, result.agreement28d]).toEqual([null, null, null, null]);
    expect(result.intervals).toEqual({ precision: null, recall: null, agreement: null, agreement28d: null });
  });
});

describe("proposeThreshold", () => {
  const recovery = bounds(0.7, 0.3, 0.95);
  // 20 yes and 10 no. Recall is 20/20 at 0.31 and below, 19/20 up to 0.62, 18/20 above it.
  const holds = [
    v(0.31, "yes"),
    v(0.62, "yes"),
    ...many(18, 0.9, "yes"),
    ...many(5, 0.1, "no"),
    ...many(3, 0.4, "no"),
    ...many(2, 0.7, "no"),
  ];

  it("makes no proposal under 30 verdicts or under 5 of either answer, checked before the target", () => {
    expect(proposeThreshold(holds.slice(0, 29), null, recovery, "hold")).toBe("insufficient");
    expect(proposeThreshold([...many(26, 0.9, "yes"), ...many(4, 0.1, "no")], { recall: 0.5 }, recovery, "hold")).toBe(
      "insufficient",
    );
    expect(proposeThreshold([...many(4, 0.9, "yes"), ...many(26, 0.1, "no")], { recall: 0.5 }, recovery, "hold")).toBe(
      "insufficient",
    );
  });

  it("makes no proposal for a hold, clear, accept or reject with no target", () => {
    expect(proposeThreshold(holds, null, recovery, "hold")).toBe("no_target");
    expect(proposeThreshold(holds, { miss: 0.1 }, recovery, "hold")).toBe("no_target");
    expect(proposeThreshold(holds, { recall: 0.9 }, recovery, "clear")).toBe("no_target");
    expect(proposeThreshold(holds, { miss: 0.1 }, recovery, "accept")).toBe("no_target");
    expect(proposeThreshold(holds, { precision: 0.9 }, recovery, "reject")).toBe("no_target");
  });

  it("proposes a hold at the highest threshold whose recall's lower bound meets the target, inside a band", () => {
    // Lower bounds: 20/20 is 0.839, 19/20 is 0.764, 18/20 is 0.699.
    expect(proposeThreshold(holds, { recall: 0.75 }, recovery, "hold")).toEqual({ value: 0.62 });
    expect(proposeThreshold(holds, { recall: 0.8 }, recovery, "hold")).toEqual({ value: 0.31 });
    expect(proposeThreshold(holds, { recall: 0.9 }, recovery, "hold")).toBe("none");
  });

  it("weighs recall by the verdicts' weights", () => {
    // The yes at 0.62 now stands for 4 calls: the effective sample shrinks, and the target the
    // unweighted table met at 0.62 is met only at 0.31 (lower bounds: 23/23 is 0.797, 22/23 is 0.734).
    const weighted = [v(0.31, "yes"), v(0.62, "yes", 4), ...many(18, 0.9, "yes"), ...many(10, 0.1, "no")];
    expect(proposeThreshold(weighted, { recall: 0.75 }, recovery, "hold")).toEqual({ value: 0.31 });
    expect(proposeThreshold(weighted, { recall: 0.7 }, recovery, "hold")).toEqual({ value: 0.62 });
  });

  // A clear passes a draft at or below it. Miss upper bounds: 0/20 is 0.161, 0/30 is 0.114, 1/31 is 0.162.
  const clears = [...many(20, 0.02, "no"), ...many(10, 0.12, "no"), v(0.15, "yes"), ...many(6, 0.6, "yes")];

  it("proposes a clear at the highest threshold whose miss's upper bound meets the target, inside a band", () => {
    expect(proposeThreshold(clears, { miss: 0.15 }, bounds(0.05, 0.01, 0.5), "clear")).toEqual({ value: 0.12 });
    expect(proposeThreshold(clears, { miss: 0.1 }, bounds(0.05, 0.01, 0.5), "clear")).toBe("none");
  });

  it("proposes the lane at the threshold of most weighted agreement, ties to the one nearest the current value", () => {
    const lane = bounds(0.5, 0.2, 0.8);
    const verdicts = [
      ...many(10, 0.1, "no"),
      ...many(5, 0.3, "no"),
      ...many(5, 0.45, "yes"),
      ...many(2, 0.55, "no"),
      ...many(10, 0.7, "yes"),
      ...many(5, 0.9, "yes"),
    ];
    expect(proposeThreshold(verdicts, null, lane, "lane")).toEqual({ value: 0.45 });
    const tied = [...many(15, 0.1, "no"), ...many(15, 0.7, "yes")];
    expect(proposeThreshold(tied, null, lane, "lane", { current: 0.3 })).toEqual({ value: 0.2 });
    expect(proposeThreshold(tied, null, lane, "lane", { current: 0.6 })).toEqual({ value: 0.7 });
  });

  it("proposes an accept at the lowest threshold whose precision's lower bound meets the target", () => {
    // Lower bounds of the share of yes at or above: 25/25 at 0.75 is 0.867, 25/28 at 0.7 is 0.728.
    const verdicts = [
      ...many(20, 0.95, "yes"),
      ...many(5, 0.75, "yes"),
      ...many(3, 0.7, "no"),
      ...many(2, 0.6, "no"),
      ...many(10, 0.4, "no"),
    ];
    expect(proposeThreshold(verdicts, { precision: 0.85 }, bounds(0.9, 0.5, 0.99), "accept")).toEqual({ value: 0.75 });
    expect(proposeThreshold(verdicts, { precision: 0.95 }, bounds(0.9, 0.5, 0.99), "accept")).toBe("none");
  });

  it("proposes a reject at the highest threshold meeting the miss target, never at or above the effective accept", () => {
    const reject = bounds(0.2, 0.05, 0.6);
    // Miss upper bounds: 0/20 at 0.1 is 0.161, 0/30 at 0.3 is 0.114, 1/31 at 0.4 and 0.6 is 0.162.
    const verdicts = [...many(20, 0.1, "no"), ...many(10, 0.3, "no"), v(0.4, "yes"), ...many(6, 0.8, "yes")];
    expect(proposeThreshold(verdicts, { miss: 0.15 }, reject, "reject")).toEqual({ value: 0.3 });
    expect(proposeThreshold(verdicts, { miss: 0.15 }, reject, "reject", { accept: 0.3 })).toBe("none");
    expect(proposeThreshold(verdicts, { miss: 0.17 }, reject, "reject")).toEqual({ value: 0.6 });
    expect(proposeThreshold(verdicts, { miss: 0.17 }, reject, "reject", { accept: 0.35 })).toEqual({ value: 0.3 });
  });
});

describe("findDrift", () => {
  // 20 recent verdicts, 6 the threshold at 0.5 disagrees with: disagreement 0.3.
  const recent = [...many(7, 0.9, "yes"), ...many(7, 0.1, "no"), ...many(3, 0.9, "no"), ...many(3, 0.1, "yes")];
  const drift = (
    point: string,
    threshold: { name: "lane" | "hold"; value: number } | null,
    grantedDisagreement: number | null,
    verdicts = recent,
  ) => findDrift({ point, version: 1, recent: verdicts, threshold, grantedDisagreement });

  it("suspends the lane and draft_disclosure on drift", () => {
    expect(drift("extract_triage", { name: "lane", value: 0.5 }, null)).toEqual({ drift: true, suspend: true });
    expect(drift("draft_disclosure", { name: "hold", value: 0.5 }, null)).toEqual({ drift: true, suspend: true });
    expect([...SUSPENDED_ON_DRIFT].sort()).toEqual(["draft_disclosure", "extract_triage"]);
  });

  it("suspends nothing on drift at a hold point", () => {
    for (const point of ["extract_injection", "extract_sensitivity", "extract_recovery", "record_injection"]) {
      expect(drift(point, { name: "hold", value: 0.5 }, null)).toEqual({ drift: true, suspend: false });
    }
  });

  it("measures against the granted report's disagreement, else 0.25", () => {
    expect(drift("extract_triage", { name: "lane", value: 0.5 }, 0.15)).toEqual({ drift: true, suspend: true });
    expect(drift("extract_triage", { name: "lane", value: 0.5 }, 0.25)).toEqual({ drift: false, suspend: false });
    const fewWrong = [...many(9, 0.9, "yes"), ...many(7, 0.1, "no"), ...many(2, 0.9, "no"), ...many(2, 0.1, "yes")];
    expect(drift("extract_triage", { name: "lane", value: 0.5 }, null, fewWrong)).toEqual({
      drift: false,
      suspend: false,
    });
  });

  it("finds no drift under 20 recent verdicts, and none for identity_rank", () => {
    expect(drift("extract_triage", { name: "lane", value: 0.5 }, null, many(19, 0.9, "no"))).toEqual({
      drift: false,
      suspend: false,
    });
    expect(drift("identity_rank", null, null, many(40, 0.9, "no"))).toEqual({ drift: false, suspend: false });
  });
});

describe("thresholds", () => {
  it("refuses a grant outside the floor and ceiling with out_of_bounds", () => {
    const recovery = bounds(0.7, 0.3, 0.95);
    expect([0.29, 0.96, Number.NaN].map((value) => checkGrant(value, recovery))).toEqual([
      "out_of_bounds",
      "out_of_bounds",
      "out_of_bounds",
    ]);
    expect([0.3, 0.7, 0.95].map((value) => checkGrant(value, recovery))).toEqual([null, null, null]);
  });

  it("applies the latest unrevoked grant of the point version, else the default", () => {
    expect(effectiveThreshold([], "extract_recovery", 1, "hold")).toEqual({ value: 0.7, source: "default" });
    expect(effectiveThreshold([grant(1, "extract_recovery", 1, "hold", 0.5)], "extract_recovery", 1, "hold")).toEqual({
      value: 0.5,
      source: thr(1),
    });
    expect(effectiveThreshold([grant(1, "extract_recovery", 1, "hold", 0.5)], "extract_injection", 1, "hold")).toEqual({
      value: 0.9,
      source: "default",
    });
    expect(effectiveThreshold([], "identity_rank", 1, "hold")).toBeNull();
  });

  it("gives every point version's values in the shape a run reads", () => {
    const all = effectiveThresholds([grant(1, "extract_triage", 3, "lane", 0.4)]);
    expect(all["extract_triage@3"]).toEqual({ lane: { value: 0.4, source: thr(1) } });
    expect(all["draft_disclosure@2"]).toEqual({
      hold: { value: 0.3, source: "default" },
      clear: { value: 0.05, source: "default" },
    });
    expect(all["identity_rank@1"]).toEqual({});
  });
});

describe("thresholds, versions", () => {
  const constants: Record<string, PointThresholds> = {
    "screen@1": { hold: bounds(0.8, 0.5, 0.95), clear: bounds(0.05, 0.01, 0.1), lane: bounds(0.5, 0.2, 0.8) },
    "screen@2": { hold: bounds(0.7, 0.6, 0.9), clear: bounds(0.04, 0.02, 0.1), lane: bounds(0.6, 0.2, 0.8) },
    "screen@3": { hold: bounds(0.75, 0.5, 0.95) },
  };
  const at = (grants: ThresholdGrant[], version: number, name: ThresholdName = "hold") =>
    effectiveThreshold(grants, "screen", version, name, constants);

  it("applies the lower of a new version's default and a lowered hold on an earlier version, as carried", () => {
    expect(at([grant(1, "screen", 1, "hold", 0.65)], 2)).toEqual({ value: 0.65, source: `carried:${thr(1)}` });
    expect(at([grant(1, "screen", 1, "hold", 0.75)], 2)).toEqual({ value: 0.7, source: "default" });
    expect(at([grant(1, "screen", 1, "clear", 0.03)], 2, "clear")).toEqual({
      value: 0.03,
      source: `carried:${thr(1)}`,
    });
  });

  it("applies the lower of the new version's own grant and the carried one", () => {
    expect(at([grant(1, "screen", 1, "hold", 0.65), grant(2, "screen", 2, "hold", 0.62)], 2)).toEqual({
      value: 0.62,
      source: thr(2),
    });
    expect(at([grant(1, "screen", 1, "hold", 0.65), grant(2, "screen", 2, "hold", 0.68)], 2)).toEqual({
      value: 0.65,
      source: `carried:${thr(1)}`,
    });
  });

  it("carries no raised grant, and no lane", () => {
    expect(at([grant(1, "screen", 1, "hold", 0.9)], 2)).toEqual({ value: 0.7, source: "default" });
    expect(at([{ ...grant(1, "screen", 1, "hold", 0.9), source: "set" }], 2)).toEqual({
      value: 0.7,
      source: "default",
    });
    expect(at([grant(1, "screen", 1, "lane", 0.3)], 2, "lane")).toEqual({ value: 0.6, source: "default" });
  });

  it("raises a carried value below the new version's floor to the floor", () => {
    expect(at([grant(1, "screen", 1, "hold", 0.55)], 2)).toEqual({ value: 0.6, source: `carried:${thr(1)}` });
  });

  it("carries the lowered grant of the latest earlier version", () => {
    expect(at([grant(1, "screen", 1, "hold", 0.6), grant(2, "screen", 2, "hold", 0.65)], 3)).toEqual({
      value: 0.65,
      source: `carried:${thr(2)}`,
    });
  });
});
