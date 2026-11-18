import { describe, expect, it } from "vitest";
import { groupKey, isoWeek, MERGE_AUDIT_SAMPLE, partitionKey, weekSample } from "./wrong-merges.ts";

describe("wrong merges", () => {
  it("two partitions are equal whatever order their parts and ids come in, and differ when one person moves", () => {
    const one = partitionKey([["ent_b", "ent_a"], ["ent_c"]]);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(partitionKey([["ent_c"], ["ent_a", "ent_b", "ent_a"]])).toBe(one);
    expect(partitionKey([["ent_a"], ["ent_b", "ent_c"]])).not.toBe(one);
    expect(partitionKey([["ent_a"], ["ent_b"], ["ent_c"]])).not.toBe(one);
  });

  it("what is no partition has no key", () => {
    expect(partitionKey([["ent_a", "ent_b"]])).toBeNull();
    expect(partitionKey([["ent_a"], []])).toBeNull();
    expect(partitionKey([["ent_a"], ["ent_a", "ent_b"]])).toBeNull();
  });

  it("a group's key reads its people, not their order", () => {
    expect(groupKey(["ent_b", "ent_a"])).toBe(groupKey(["ent_a", "ent_b"]));
    expect(groupKey(["ent_a", "ent_b"])).not.toBe(groupKey(["ent_a", "ent_c"]));
  });

  it("the ISO week is the database's, across a year's end", () => {
    expect(isoWeek(new Date("2026-11-11T12:00:00Z"), "W")).toBe("2026W46");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"), "W")).toBe("2026W53");
    expect(isoWeek(new Date("2024-12-30T00:00:00Z"), "W")).toBe("2025W01");
    expect(isoWeek(new Date("2026-11-10T09:00:00Z"), "-W")).toBe("2026-W46");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"), "-W")).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00Z"), "-W")).toBe("2027-W01");
  });

  it("the week's sample is the same on every run, changes with the week, and is at most its size", () => {
    const rulings = Array.from({ length: 40 }, (_, i) => `rul_${String(i).padStart(2, "0")}`);
    const week = weekSample(rulings, "2026W46", MERGE_AUDIT_SAMPLE);
    expect(week).toHaveLength(MERGE_AUDIT_SAMPLE);
    expect(weekSample([...rulings].reverse(), "2026W46", MERGE_AUDIT_SAMPLE)).toEqual(week);
    expect(weekSample(rulings, "2026W47", MERGE_AUDIT_SAMPLE)).not.toEqual(week);
    expect(rulings).toEqual(expect.arrayContaining(week));
    // What the label was already given this week comes off the sample.
    expect(weekSample(rulings, "2026W46", MERGE_AUDIT_SAMPLE, 3)).toEqual(week.slice(0, 2));
    expect(weekSample(rulings, "2026W46", MERGE_AUDIT_SAMPLE, 9)).toEqual([]);
    expect(weekSample(rulings.slice(0, 2), "2026W46", MERGE_AUDIT_SAMPLE)).toHaveLength(2);
  });
});
