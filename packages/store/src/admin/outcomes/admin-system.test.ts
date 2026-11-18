import { SystemMeasure } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { measureOf, measuresInOrder } from "./admin-system.ts";

// The System room's measures without a database: a stored reading with its healthy line, and the
// order the page shows them in.

const row = (metric: string, state: "ok" | "failing" | "no_data", failingSince: string | null = null) => ({
  metric,
  state,
  value: state === "no_data" ? null : 0.4,
  sample: 12,
  read_at: new Date("2026-10-20T09:00:00Z"),
  failing_since: failingSince === null ? null : new Date(failingSince),
});

const NOW = new Date("2026-10-20T12:00:00Z");
const measureOf2 = (one: ReturnType<typeof row>) => measureOf(one, NOW);

describe("the System room's measures", () => {
  // The filing pass reads each measure daily: a reading it has not replaced in 48 hours says
  // what was, and the page must not show it as what is.
  it("marks a reading older than 48 hours as not current", () => {
    const read = (hoursAgo: number) => ({
      ...row("credited_share", "failing", "2026-10-01T09:00:00Z"),
      read_at: new Date(NOW.getTime() - hoursAgo * 3_600_000),
    });
    expect(measureOf(read(3), NOW).stale).toBe(false);
    expect(measureOf(read(48), NOW).stale).toBe(false);
    expect(measureOf(read(49), NOW)).toMatchObject({
      stale: true,
      state: "failing",
      failingSince: "2026-10-01T09:00:00.000Z",
    });
  });

  it("gives a reading its measure's healthy line, and none to a count sent from outside", () => {
    const known = measureOf2(row("credited_share", "failing", "2026-10-01T09:00:00Z"));
    expect(SystemMeasure.parse(known)).toEqual(known);
    expect(known).toMatchObject({
      healthy: { test: "at_least", value: 0.7 },
      minSample: 60,
      failingSince: "2026-10-01T09:00:00.000Z",
      readAt: "2026-10-20T09:00:00.000Z",
    });
    expect(measureOf2(row("nightly_red", "ok"))).toMatchObject({ healthy: null, minSample: null, failingSince: null });
    // A name that is a property of every object is still no measure.
    expect(measureOf2(row("constructor", "ok")).healthy).toBeNull();
  });

  it("says how long only for a measure that reads low now", () => {
    expect(measureOf2(row("credited_share", "ok", "2026-10-01T09:00:00Z")).failingSince).toBeNull();
  });

  it("orders them low first, the longest low leading, then no data, then healthy, each by name", () => {
    const measures = [
      measureOf2(row("signals_picked_up", "ok")),
      measureOf2(row("backup_age_days", "failing", "2026-10-16T09:00:00Z")),
      measureOf2(row("task_used_share", "no_data")),
      measureOf2(row("credited_share", "failing", "2026-10-01T09:00:00Z")),
      measureOf2(row("candidates_refused", "ok")),
    ];
    expect(measuresInOrder(measures).map((one) => one.metric)).toEqual([
      "credited_share",
      "backup_age_days",
      "task_used_share",
      "candidates_refused",
      "signals_picked_up",
    ]);
  });
});
