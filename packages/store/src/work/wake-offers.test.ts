import { describe, expect, it } from "vitest";
import { dueInterval } from "../pipeline/pipeline-beliefs.ts";

describe("dueInterval", () => {
  it("a day is [D, D + 1 day) in UTC while the owner has set no zone", () => {
    expect(dueInterval("2026-06-01", null)).toEqual(["2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"]);
    expect(dueInterval("2026-12-31", null)).toEqual(["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
  });
  it("a day is the owner's local day once they set a zone, across a change of the clocks", () => {
    // Chicago is UTC-5 in June.
    expect(dueInterval("2026-06-01", "America/Chicago")).toEqual([
      "2026-06-01T05:00:00.000Z",
      "2026-06-02T05:00:00.000Z",
    ]);
    // The day Chicago goes back to UTC-6 is 25 hours long.
    expect(dueInterval("2026-11-01", "America/Chicago")).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
    ]);
  });
  it("an instant is [t, t], whatever the zone", () => {
    for (const zone of [null, "America/Chicago"])
      expect(dueInterval("2026-06-01T14:30:00+02:00", zone)).toEqual([
        "2026-06-01T12:30:00.000Z",
        "2026-06-01T12:30:00.000Z",
      ]);
  });
  it("a value that is no date is no interval", () => {
    expect(dueInterval("next week", null)).toBeNull();
    expect(dueInterval("2026-13-45", "America/Chicago")).toBeNull();
  });
});
