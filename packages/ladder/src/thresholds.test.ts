import type { PointThresholds, ThresholdBounds, ThresholdGrant } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { effectiveThreshold } from "./calibrate.ts";
import { bandFor } from "./thresholds.ts";

const bounds = (value: number, floor: number, ceiling: number): ThresholdBounds => ({ default: value, floor, ceiling });
const thr = (n: number): string => `thr_${"0".repeat(25)}${n}`;
const grant = (n: number, point: string, version: number, name: string, value: number): ThresholdGrant => ({
  id: thr(n),
  point,
  version,
  name,
  value,
  source: "set",
});

describe("the band table", () => {
  it("p at or above accept is accept", () => {
    expect(bandFor(0.8, 0.8, 0.2)).toBe("accept");
    expect(bandFor(1, 0.8, 0.2)).toBe("accept");
  });

  it("p at or below reject is reject", () => {
    expect(bandFor(0.2, 0.8, 0.2)).toBe("reject");
    expect(bandFor(0, 0.8, 0.2)).toBe("reject");
  });

  it("p between reject and accept is next", () => {
    expect(bandFor(0.21, 0.8, 0.2)).toBe("next");
    expect(bandFor(0.79, 0.8, 0.2)).toBe("next");
  });

  it("reject below_accept: no middle band, p under accept is reject", () => {
    expect(bandFor(0.79, 0.8, "below_accept")).toBe("reject");
    expect(bandFor(0.8, 0.8, "below_accept")).toBe("accept");
  });

  it("reject null: no reject band, p under accept is next", () => {
    expect(bandFor(0, 0.8, null)).toBe("next");
    expect(bandFor(0.79, 0.8, null)).toBe("next");
    expect(bandFor(0.8, 0.8, null)).toBe("accept");
  });

  it("a two-question rung bands on the larger probability", () => {
    expect(bandFor([0.1, 0.35], 0.3, 0.05)).toBe("accept");
    expect(bandFor([0.35, 0.1], 0.3, 0.05)).toBe("accept");
    expect(bandFor([0.01, 0.04], 0.3, 0.05)).toBe("reject");
    expect(bandFor([0.01, 0.2], 0.3, 0.05)).toBe("next");
  });

  it("a probability outside 0 to 1, or none, is refused", () => {
    expect(() => bandFor(Number.NaN, 0.8, 0.2)).toThrow(RangeError);
    expect(() => bandFor(1.01, 0.8, 0.2)).toThrow(RangeError);
    expect(() => bandFor([], 0.8, 0.2)).toThrow(RangeError);
  });
});

describe("accept and reject are per point version", () => {
  const constants: Record<string, PointThresholds> = {
    "link@1": { accept: bounds(0.8, 0.6, 0.95), reject: bounds(0.2, 0.05, 0.65) },
    "link@2": { accept: bounds(0.85, 0.6, 0.95), reject: bounds(0.2, 0.05, 0.5) },
  };

  it("a grant made under version 1 does not apply to version 2", () => {
    const accept = grant(1, "link", 1, "accept", 0.6);
    expect(effectiveThreshold([accept], "link", 1, "accept", constants)).toEqual({ value: 0.6, source: thr(1) });
    expect(effectiveThreshold([accept], "link", 2, "accept", constants)).toEqual({ value: 0.85, source: "default" });
    const reject = grant(2, "link", 1, "reject", 0.05);
    expect(effectiveThreshold([reject], "link", 2, "reject", constants)).toEqual({ value: 0.2, source: "default" });
  });
});
