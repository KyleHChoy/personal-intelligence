import { describe, expect, it } from "vitest";
import {
  BUDGET_NEW_MS,
  backlogOf,
  boxHeld,
  budgetStands,
  budgetStopped,
  LOOP_MS,
  STOPPED_AFTER_MS,
  stoppedSince,
  stoppedWithWork,
  storesNothing,
} from "./box-health-detectors.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("the box health detectors' conditions", () => {
  it("a job but the night's pass stands from its first stop at the budget with work left", () => {
    expect(stoppedWithWork({ codes: ["budget"], backlogs: [12] })).toBe(true);
    // A backlog not recorded is told, not taken as none.
    expect(stoppedWithWork({ codes: ["budget", "ok"], backlogs: [null, null] })).toBe(true);
    expect(stoppedWithWork({ codes: ["budget"], backlogs: [0] })).toBe(false);
    expect(stoppedWithWork({ codes: ["ok", "budget"], backlogs: [null, 12] })).toBe(false);
    expect(stoppedWithWork({ codes: [], backlogs: [] })).toBe(false);
  });

  it("an account stores nothing: three days of ok syncs with no item, after storing on most days before", () => {
    const quiet = { syncs: 40, ok: 40, stored: 0, daysBefore: 13 };
    expect(storesNothing(quiet)).toBe(true);
    // One item stored, one sync that did not end ok, too few syncs to tell, or an account that
    // seldom stored before: none stands.
    expect(storesNothing({ ...quiet, stored: 1 })).toBe(false);
    expect(storesNothing({ ...quiet, ok: 39 })).toBe(false);
    expect(storesNothing({ ...quiet, syncs: 2, ok: 2 })).toBe(false);
    // Ten of fourteen is an account quiet on weekends.
    expect(storesNothing({ ...quiet, daysBefore: 10 })).toBe(false);
    expect(storesNothing({ ...quiet, daysBefore: 12 })).toBe(true);
  });

  it("a job keeps stopping on its budget: its last three runs, all of them", () => {
    expect(budgetStopped(["budget", "budget", "budget"])).toBe(true);
    expect(budgetStopped(["budget", "budget"])).toBe(false);
    expect(budgetStopped(["budget", "ok", "budget"])).toBe(false);
    expect(budgetStopped(["exit_1", "budget", "budget"])).toBe(false);
    expect(budgetStopped([])).toBe(false);
  });

  // imp_01M747YJ5NK761XN776VSHN3ME item 8: a job that usually ends on its budget would keep the
  // card standing from its third run on; it stands only while the stop is new or getting worse.
  it("a budget stop stands while it is new or its backlog grows, not while it is only usual", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    const stops = { codes: ["budget", "budget", "budget"], backlogs: [null, null, null], earlier: false };
    // New: the streak began within the window, and no stop came in the window before it.
    expect(budgetStands({ ...stops, since: new Date(now.getTime() - 3 * DAY) }, now)).toBe(true);
    expect(budgetStands({ ...stops, since: new Date(now.getTime() - BUDGET_NEW_MS) }, now)).toBe(true);
    // Usual: a streak older than the window, or one that follows a stop inside the window before it.
    const old = new Date(now.getTime() - BUDGET_NEW_MS - HOUR);
    expect(budgetStands({ ...stops, since: old }, now)).toBe(false);
    expect(budgetStands({ ...stops, since: new Date(now.getTime() - HOUR), earlier: true }, now)).toBe(false);
    // Worsening: the backlog after the latest run is larger than after the oldest of the three.
    expect(budgetStands({ ...stops, since: old, backlogs: [40, 35, 30] }, now)).toBe(true);
    expect(budgetStands({ ...stops, since: old, backlogs: [30, 35, 30] }, now)).toBe(false);
    expect(budgetStands({ ...stops, since: old, backlogs: [25, 35, 30] }, now)).toBe(false);
    expect(budgetStands({ ...stops, since: old, backlogs: [40, 35, null] }, now)).toBe(false);
    // Never without the three stops themselves.
    expect(
      budgetStands({ codes: ["budget", "ok", "budget"], backlogs: [40, 35, 30], since: now, earlier: false }, now),
    ).toBe(false);
  });

  it("extraction's backlog: fifty or more items failed over the runs given", () => {
    expect(backlogOf([{ failed: 20 }, { failed: 0 }, { failed: 30 }])).toBe(true);
    expect(backlogOf([{ failed: 49 }])).toBe(false);
    expect(backlogOf([])).toBe(false);
  });

  it("a daily job stopped: runs recorded, and none for three days", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    expect(STOPPED_AFTER_MS).toBe(72 * HOUR);
    expect(stoppedSince(ago(73 * HOUR), now)).toBe(true);
    expect(stoppedSince(ago(72 * HOUR), now)).toBe(false);
    expect(stoppedSince(ago(HOUR), now)).toBe(false);
    // A job that never ran was never turned on: nothing stopped.
    expect(stoppedSince(null, now)).toBe(false);
  });

  it("the box was held: no run of any job from before this loop inside the stopped window", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    expect(LOOP_MS).toBe(HOUR);
    // A sync two hours ago: the box was running, so a daily job's silence is a stop.
    expect(boxHeld(ago(2 * HOUR), now)).toBe(false);
    expect(boxHeld(ago(72 * HOUR), now)).toBe(false);
    // The last run of anything is older than the window: the box itself was held.
    expect(boxHeld(ago(73 * HOUR), now)).toBe(true);
    // Nothing recorded before this loop: no proof the box ran.
    expect(boxHeld(null, now)).toBe(true);
    // The lever's window, not the default.
    expect(boxHeld(ago(49 * HOUR), now, 48 * HOUR)).toBe(true);
  });
});
