import { ListLeversResult } from "@intelligence/contracts/personal";
import { LEVER_KEYS, LEVERS, leverDefault } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { backlogOf, budgetStopped, stoppedSince, storesNothing } from "./box-health-detectors.ts";
import type { Query } from "./db.ts";
import { OUTCOME_THRESHOLDS } from "./outcome-thresholds.ts";
import { type LeverRow, lever, leverViews } from "./settings.ts";

// A database that holds these rows of policy.settings, and answers nothing else.
const holding = (rows: Record<string, { value: unknown; updated_by: string }>): Query =>
  (async (_text: string, values?: unknown[]) => {
    const row = rows[String(values?.[0])];
    return row === undefined ? [] : [row];
  }) as Query;

describe("a lever's read", () => {
  it("answers every default from a database with no rows", async () => {
    for (const key of LEVER_KEYS) expect(await lever(holding({}), key), key).toBe(leverDefault(key));
  });

  it("answers the stored value inside the range, from a transaction or a read's context", async () => {
    const query = holding({ "lessons.digest_weekly": { value: 2, updated_by: "client:cli_1" } });
    expect(await lever(query, "lessons.digest_weekly")).toBe(2);
    expect(await lever({ run: query }, "lessons.digest_weekly")).toBe(2);
  });

  it("a row out of range, of the wrong type, or an agent's on the owner's lever has no effect", async () => {
    const query = holding({
      "lessons.digest_weekly": { value: 500, updated_by: "owner" },
      "outcomes.sample_weekly": { value: "many", updated_by: "owner" },
      "detect.backlog_over": { value: 400, updated_by: "client:cli_1" },
      "filing.refusal_floor": { value: 100, updated_by: "owner" },
    });
    expect(await lever(query, "lessons.digest_weekly")).toBe(5);
    expect(await lever(query, "outcomes.sample_weekly")).toBe(3);
    expect(await lever(query, "detect.backlog_over")).toBe(50);
    expect(await lever(query, "filing.refusal_floor")).toBe(100);
  });
});

describe("the registry against the store", () => {
  it("judges every lever by a measure the outcomes report holds", () => {
    for (const key of LEVER_KEYS) expect(Object.keys(OUTCOME_THRESHOLDS), key).toContain(LEVERS[key].measure);
  });

  it("each rule takes the lever's value in place of its default", () => {
    const quiet = { syncs: 40, ok: 40, stored: 0, daysBefore: 10 };
    expect(storesNothing(quiet)).toBe(false);
    expect(storesNothing(quiet, 9)).toBe(true);
    expect(budgetStopped(["budget", "budget"], 2)).toBe(true);
    expect(budgetStopped(["budget", "budget", "budget", "ok"], 4)).toBe(false);
    expect(backlogOf([{ failed: 30 }], 25)).toBe(true);
    expect(backlogOf([{ failed: 60 }], 100)).toBe(false);
    const now = new Date("2026-03-10T12:00:00Z");
    const twoDaysAgo = new Date(now.getTime() - 49 * 3_600_000);
    expect(stoppedSince(twoDaysAgo, now)).toBe(false);
    expect(stoppedSince(twoDaysAgo, now, 2 * 24 * 3_600_000)).toBe(true);
  });
});

describe("the list", () => {
  const row = (over: Partial<LeverRow> & { key: string }): LeverRow => ({
    value: null,
    set_by: null,
    old_value: null,
    new_value: null,
    reason: null,
    changed_at: null,
    changed_by: null,
    ...over,
  });

  it("serves every registered lever, at its default with no row, in the contract's shape", () => {
    const levers = leverViews([]);
    expect(levers.map((one) => one.key)).toEqual([...LEVER_KEYS]);
    for (const one of levers) expect([one.value, one.lastChange], one.key).toEqual([one.default, null]);
    expect(ListLeversResult.safeParse({ levers }).success).toBe(true);
  });

  it("serves the stored value and the last change, and no key the registry does not hold", () => {
    const at = new Date("2026-03-10T12:00:00Z");
    const levers = leverViews([
      row({
        key: "lessons.digest_weekly",
        value: 2,
        set_by: "you",
        old_value: null,
        new_value: 2,
        reason: "tune",
        changed_at: at,
        changed_by: "you",
      }),
      // An agent's row on the owner's lever: listed with its change, and without effect.
      row({
        key: "detect.backlog_over",
        value: 400,
        set_by: "agent",
        old_value: null,
        new_value: 400,
        reason: "tune",
        changed_at: at,
        changed_by: "agent",
      }),
      // Undone: no row stands, and the change says so.
      row({
        key: "outcomes.sample_weekly",
        old_value: 5,
        new_value: null,
        reason: "undo",
        changed_at: at,
        changed_by: "owner",
      }),
      row({ key: "not.registered", value: 1, set_by: "owner" }),
    ]);
    const of = (key: string) => levers.find((one) => one.key === key);
    expect(of("lessons.digest_weekly")).toMatchObject({
      value: 2,
      default: 5,
      mover: "agent",
      lastChange: { at: at.toISOString(), by: "you", from: null, to: 2, reason: "tune" },
    });
    expect(of("detect.backlog_over")).toMatchObject({
      value: 50,
      mover: "owner",
      lastChange: { by: "agent", to: 400 },
    });
    expect(of("outcomes.sample_weekly")).toMatchObject({ value: 3, lastChange: { by: "owner", from: 5, to: null } });
    expect(of("not.registered")).toBeUndefined();
    expect(ListLeversResult.safeParse({ levers }).success).toBe(true);
  });
});
