import { describe, expect, it } from "vitest";
import { threadWindows } from "./moment-batch.ts";

// A thread's due local days, cut into windows of MOMENT_THREAD_DAYS from its newest day back.
describe("a source thread's windows of local days", () => {
  it("holds seven local days: the newest due day and the six before it", () => {
    const windows = threadWindows(["2026-03-02", "2026-03-08", "2026-03-05", "2026-03-01"]);
    expect(Object.fromEntries(windows)).toEqual({
      "2026-03-08": "2026-03-08",
      "2026-03-05": "2026-03-08",
      "2026-03-02": "2026-03-08",
      "2026-03-01": "2026-03-01",
    });
  });

  it("starts the next window from the newest day the last one left out, not from a fixed calendar", () => {
    const windows = threadWindows(["2026-03-20", "2026-03-12", "2026-03-11", "2026-03-06", "2026-03-05"]);
    expect([...new Set(windows.values())]).toEqual(["2026-03-20", "2026-03-12", "2026-03-05"]);
    expect(windows.get("2026-03-06")).toBe("2026-03-12");
    expect(windows.get("2026-03-05")).toBe("2026-03-05");
  });

  it("reads days across a month's end and repeats, and a span of one is a day each", () => {
    expect(Object.fromEntries(threadWindows(["2026-03-01", "2026-02-23", "2026-02-22", "2026-03-01"]))).toEqual({
      "2026-03-01": "2026-03-01",
      "2026-02-23": "2026-03-01",
      "2026-02-22": "2026-02-22",
    });
    expect([...threadWindows(["2026-03-02", "2026-03-01"], 1).values()]).toEqual(["2026-03-02", "2026-03-01"]);
    expect(threadWindows([]).size).toBe(0);
  });
});
