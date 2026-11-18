import { describe, expect, it } from "vitest";
import {
  isLeverKey,
  LEVER_KEYS,
  LEVERS,
  type LeverSpec,
  leverAdmits,
  leverDefault,
  leverListing,
  leverRefusal,
  leverValue,
  NEVER_AN_AGENTS,
} from "./levers.ts";

const specs = Object.entries(LEVERS) as [string, LeverSpec][];

describe("the lever registry", () => {
  it("holds a well-formed key, a range and a default inside it for every lever", () => {
    for (const [key, spec] of specs) {
      expect(key, key).toMatch(/^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,2}$/);
      expect(spec.measure, key).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(spec.min, key).toBeLessThan(spec.max);
      expect(leverAdmits(key as never, spec.default), key).toBe(true);
    }
    expect(LEVER_KEYS).toEqual(Object.keys(LEVERS).sort());
  });

  it("marks no lever an agent's whose key names money, access, sending, a healthy line, a retry or a sample", () => {
    for (const [key, spec] of specs) if (spec.mover === "agent") expect(key, key).not.toMatch(NEVER_AN_AGENTS);
    for (const word of [
      "spend",
      "budget",
      "model",
      "grant",
      "release",
      "send",
      "clearance",
      "healthy",
      "retry",
      "sample",
    ])
      expect(NEVER_AN_AGENTS.test(`lane.${word}_limit`), word).toBe(true);
    // Retries are spend and the outcome sample is the owner's check: one lever alone is an agent's.
    expect(specs.filter(([, spec]) => spec.mover === "agent").map(([key]) => key)).toEqual(["lessons.digest_weekly"]);
    // The system's own alarms are the owner's.
    for (const [key, spec] of specs) if (/^(detect|filing)\./.test(key)) expect(spec.mover, key).toBe("owner");
  });

  it("admits a value of the lever's type inside its range, and nothing else", () => {
    expect(leverAdmits("lessons.digest_weekly", 1)).toBe(true);
    // Never none: an agent may not end the lesson cards.
    expect(leverAdmits("lessons.digest_weekly", 0)).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", 10)).toBe(true);
    expect(leverAdmits("lessons.digest_weekly", 11)).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", -1)).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", 2.5)).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", "5")).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", Number.NaN)).toBe(false);
    expect(leverAdmits("lessons.digest_weekly", null)).toBe(false);
    expect(leverAdmits("outcomes.sample_share", 0.2)).toBe(true);
    expect(leverAdmits("outcomes.sample_share", 0)).toBe(false);
    expect(leverAdmits("outcomes.sample_weekly", 0)).toBe(false);
  });

  it("answers the default with no row, and for a row that may not take effect", () => {
    expect(leverValue("lessons.digest_weekly", null)).toBe(5);
    expect(leverValue("lessons.digest_weekly", undefined)).toBe(5);
    expect(leverValue("lessons.digest_weekly", { value: 2, by: "client:one" })).toBe(2);
    expect(leverValue("lessons.digest_weekly", { value: 2, by: "owner" })).toBe(2);
    expect(leverValue("lessons.digest_weekly", { value: 99, by: "owner" })).toBe(5);
    expect(leverValue("lessons.digest_weekly", { value: "2", by: "owner" })).toBe(5);
    // A lever that is the owner's takes the owner's row alone.
    expect(leverValue("detect.backlog_over", { value: 100, by: "owner" })).toBe(100);
    expect(leverValue("detect.backlog_over", { value: 100, by: "client:one" })).toBe(50);
    for (const key of LEVER_KEYS) expect(leverValue(key, null), key).toBe(leverDefault(key));
  });

  it("refuses an unknown key, an agent on a lever that is the owner's, and a value out of range", () => {
    expect(leverRefusal("no.such_lever", 1, "owner")).toBe("not_found");
    expect(leverRefusal("constructor", 1, "owner")).toBe("not_found");
    expect(isLeverKey("toString")).toBe(false);
    expect(leverRefusal("detect.backlog_over", 100, "agent")).toBe("not_permitted");
    expect(leverRefusal("detect.backlog_over", 100, "owner")).toBeNull();
    expect(leverRefusal("lessons.digest_weekly", 3, "agent")).toBeNull();
    expect(leverRefusal("lessons.digest_weekly", 30, "agent")).toBe("invalid_request");
    expect(leverRefusal("lessons.digest_weekly", 30, "owner")).toBe("invalid_request");
  });

  it("lists a lever with its range, its mover, its undo and its measure", () => {
    expect(leverListing("outcomes.sample_share")).toEqual({
      key: "outcomes.sample_share",
      type: "number",
      min: 0.05,
      max: 0.5,
      default: 0.15,
      mover: "owner",
      undo: "previous_value",
      measure: "settled_without_owner_overturned",
    });
  });
});
