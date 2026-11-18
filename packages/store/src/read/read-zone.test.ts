import { describe, expect, it } from "vitest";
import { allDaySpan } from "../core/zone.ts";

// An all-day event's days in the owner's zone. Synthetic dates only.

describe("an all-day event's span", () => {
  const start = new Date("2026-10-09T00:00:00.000Z");
  const end = new Date("2026-10-10T00:00:00.000Z");

  it("is its stored UTC midnights while the owner has set no zone", () => {
    expect(allDaySpan(start, end, null)).toEqual({ start: start.getTime(), end: end.getTime() });
  });

  it("is its local days once the owner has: a Chicago day starts at five in the morning UTC in daylight time", () => {
    expect(allDaySpan(start, end, "America/Chicago")).toEqual({
      start: Date.parse("2026-10-09T05:00:00.000Z"),
      end: Date.parse("2026-10-10T05:00:00.000Z"),
    });
    // Two days, the last ending at the next local midnight.
    expect(allDaySpan(start, new Date("2026-10-11T00:00:00.000Z"), "America/Chicago").end).toBe(
      Date.parse("2026-10-11T05:00:00.000Z"),
    );
  });

  it("is one day when the calendar gave no end, or one not after its start", () => {
    expect(allDaySpan(start, null, "America/Chicago").end).toBe(Date.parse("2026-10-10T05:00:00.000Z"));
    expect(allDaySpan(start, start, null).end).toBe(end.getTime());
  });
});
