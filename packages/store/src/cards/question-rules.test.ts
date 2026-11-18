import { describe, expect, it } from "vitest";
import { ruleDayDue } from "./question-rules.ts";

// When the tick proposes rules: once a day of the owner's, from its sweep hour, whatever hour the
// first tick after it comes.

describe("ruleDayDue", () => {
  const at = (iso: string): Date => new Date(iso);

  it("before the sweep hour nothing is due; from it, the day is due once", () => {
    expect(ruleDayDue(at("2026-11-17T05:59:00Z"), null, 6, null)).toBeNull();
    expect(ruleDayDue(at("2026-11-17T06:00:00Z"), null, 6, null)).toBe("2026-11-17");
    expect(ruleDayDue(at("2026-11-17T06:05:00Z"), null, 6, "2026-11-17")).toBeNull();
  });

  it("a tick held past the old quarter hour, even hours late, still finds the day", () => {
    expect(ruleDayDue(at("2026-11-17T06:40:00Z"), null, 6, "2026-11-16")).toBe("2026-11-17");
    expect(ruleDayDue(at("2026-11-17T21:10:00Z"), null, 6, "2026-11-16")).toBe("2026-11-17");
  });

  it("the hour and the day are the owner's once their zone is set", () => {
    // 12:30 UTC is 06:30 in Chicago on this day, the owner's sweep hour 6.
    expect(ruleDayDue(at("2026-11-17T12:30:00Z"), "America/Chicago", 6, "2026-11-16")).toBe("2026-11-17");
    // 06:30 UTC is still the night before in Chicago: not yet due.
    expect(ruleDayDue(at("2026-11-17T06:30:00Z"), "America/Chicago", 6, "2026-11-16")).toBeNull();
    // 03:00 UTC on the 18th is the 17th in Chicago, already proposed for.
    expect(ruleDayDue(at("2026-11-18T03:00:00Z"), "America/Chicago", 6, "2026-11-17")).toBeNull();
  });
});
