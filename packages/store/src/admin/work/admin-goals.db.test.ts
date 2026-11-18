import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminRows as rows, scanForPlaintext } from "../../test-support/database.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

const TIMEOUT = 120_000;
const T0 = new Date("2026-09-20T09:00:00.000Z");
const STATEMENT = "Canary goal: finish the heron survey by the solstice";

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

const withGoals = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

// The state rows with the statement opened, so two sealings of one statement compare equal.
const state = async (store: TestStore) =>
  (await store.admin.work.listGoals()).map((goal) => ({ ...goal })).sort((a, b) => (a.id < b.id ? -1 : 1));
const stateRows = (store: TestStore) =>
  rows<Record<string, unknown>>(
    store,
    "select goal_id, status, ruling_id, stated_at, updated_at, compartments from projections.goal_state order by goal_id",
  );

describe("goals", { timeout: TIMEOUT }, () => {
  it("a goal's statement is in no column in plaintext", () =>
    withGoals(async (store) => {
      const goal = await store.admin.work.addGoal(STATEMENT, "own", { requestId: requestId() });
      expect(goal).toMatch(/^gol_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(await scanForPlaintext(store.db.urls.admin, [STATEMENT, "heron survey"])).toEqual([]);
      // The positive control: the statement opens under the admin's keys.
      expect((await store.admin.work.listGoals()).map((one) => one.statement)).toEqual([STATEMENT]);
      expect(
        await rows(
          store,
          "select kind, target_kind, target_id, answer, supersedes, compartments, body_enc is not null as sealed from knowledge.owner_decisions",
        ),
      ).toEqual([
        {
          kind: "goal_set",
          target_kind: "goal",
          target_id: goal,
          answer: null,
          supersedes: null,
          compartments: ["own"],
          sealed: true,
        },
      ]);
    }));

  it("goal state rebuilt from the decisions equals the state the commands left", () =>
    withGoals(async (store) => {
      const first = await store.admin.work.addGoal(STATEMENT, "own", { requestId: requestId() });
      await store.admin.work.addGoal("Canary goal two", "employer:example", { requestId: requestId() });
      const later = new Admin({
        pool: store.adminPool,
        keys: store.db.keys,
        log: store.log,
        now: () => new Date(T0.getTime() + 60_000),
      });
      await later.work.setGoalStatus(first, "paused", { requestId: requestId() });
      const before = { opened: await state(store), stored: await stateRows(store) };
      expect(before.stored).toHaveLength(2);
      expect(await store.admin.work.rebuildGoalState()).toBe(2);
      expect({ opened: await state(store), stored: await stateRows(store) }).toEqual(before);
    }));

  it("a repeated request id adds one goal", () =>
    withGoals(async (store) => {
      const request = requestId();
      const goal = await store.admin.work.addGoal(STATEMENT, "own", { requestId: request });
      expect(await store.admin.work.addGoal(STATEMENT, "own", { requestId: request })).toBe(goal);
      expect(await rows(store, "select count(*)::int as n from projections.goal_state")).toEqual([{ n: 1 }]);
      expect(await rows(store, "select count(*)::int as n from knowledge.owner_decisions")).toEqual([{ n: 1 }]);
    }));

  it("a status change supersedes the last and keeps the statement", () =>
    withGoals(async (store) => {
      const goal = await store.admin.work.addGoal(STATEMENT, "own", { requestId: requestId() });
      const [set] = await rows<{ id: string }>(store, "select id from knowledge.owner_decisions");
      expect(await store.admin.work.setGoalStatus(goal, "paused", { requestId: requestId() })).toBe(true);
      expect(await store.admin.work.setGoalStatus(goal, "done", { requestId: requestId() })).toBe(true);
      const decided = await rows<{ id: string; kind: string; answer: string | null; supersedes: string | null }>(
        store,
        "select id, kind, answer, supersedes from knowledge.owner_decisions order by decided_at, id",
      );
      expect(decided.map(({ kind, answer }) => [kind, answer])).toEqual([
        ["goal_set", null],
        ["goal_status", "paused"],
        ["goal_status", "done"],
      ]);
      expect(decided[1]?.supersedes).toBe(set?.id);
      expect(decided[2]?.supersedes).toBe(decided[1]?.id);
      expect(await store.admin.work.listGoals()).toMatchObject([{ id: goal, status: "done", statement: STATEMENT }]);
      expect(await rows(store, "select ruling_id from projections.goal_state")).toEqual([
        { ruling_id: decided[2]?.id },
      ]);
      // A goal that does not exist changes nothing.
      expect(
        await store.admin.work.setGoalStatus(`gol_${"0".repeat(26)}` as never, "done", { requestId: requestId() }),
      ).toBe(false);
    }));

  it("a compartment the keys lack is unknown_compartment", () =>
    withGoals(async (store) => {
      expect(
        await refusedWith(() => store.admin.work.addGoal(STATEMENT, "employer:absent", { requestId: requestId() })),
      ).toEqual({ name: "AdminError", code: "unknown_compartment" });
      expect(await rows(store, "select count(*)::int as n from knowledge.owner_decisions")).toEqual([{ n: 0 }]);
    }));
});
