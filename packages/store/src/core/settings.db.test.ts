import type { LeverView } from "@intelligence/contracts/personal";
import { LEVER_KEYS, leverDefault } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { request } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { withAdmin } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { lever } from "./settings.ts";

// The settings table and the levers, on a migrated database: a lever reads its default with no row;
// an agent moves one only with the tool, only a lever that is an agent's, only inside its range;
// every change has its history row; the owner sets any lever and undoes one; a row the registry
// does not admit has no effect; and no runtime role writes either table but through its definers.
// Synthetic rows only.

const READ = ["list_improvements", "list_levers"];
const MOVE = [...READ, "set_lever"];

const listed = async (w: WorkWorld, token: string): Promise<LeverView[]> =>
  ok(await w.work.listLevers(token, {} as never)).levers;
const one = (levers: readonly LeverView[], key: string): LeverView => {
  const found = levers.find((each) => each.key === key);
  if (found === undefined) throw new Error(`no lever ${key}`);
  return found;
};
const set = (w: WorkWorld, token: string, key: string, value: number | string, requestId = request()) =>
  w.work.setLever(token, { key, value, reason: "tune", requestId } as never);
type Change = {
  key: string;
  old_value: unknown;
  new_value: unknown;
  changed_by: string;
  reason: string;
  measure: string;
};
const history = (w: WorkWorld): Promise<Change[]> =>
  w.admin<Change>(
    "select key, old_value, new_value, changed_by, reason, measure from policy.setting_changes order by id",
    [],
  );
const stored = (w: WorkWorld) =>
  w.admin<{ key: string; value: unknown; updated_by: string }>(
    "select key, value, updated_by from policy.settings order by key",
    [],
  );

describe("settings and levers", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a database with no rows answers every default, to the code, an agent and the owner", () =>
    withWorkWorld(async (w) => {
      expect(await stored(w)).toEqual([]);
      for (const key of LEVER_KEYS) expect(await lever(w.admin, key), key).toBe(leverDefault(key));
      const agent = await w.client("reader", ["own"], { tools: READ });
      const levers = await listed(w, agent.token);
      expect(levers.map((each) => each.key)).toEqual([...LEVER_KEYS]);
      for (const each of levers) expect([each.value, each.lastChange], each.key).toEqual([each.default, null]);
      expect(await withAdmin(w, (admin) => admin.box.levers())).toEqual({ levers });
    }));

  it("an agent without the tool is refused, and one that holds it cannot set a lever that is the owner's", () =>
    withWorkWorld(async (w) => {
      const none = await w.client("none", ["own"], { tools: ["list_improvements"] });
      const reader = await w.client("reader", ["own"], { tools: READ });
      const mover = await w.client("mover", ["own"], { tools: MOVE });
      expect(await w.work.listLevers(none.token, {} as never)).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await set(w, reader.token, "lessons.digest_weekly", 2)).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      expect(await set(w, mover.token, "detect.backlog_over", 100)).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      expect(await set(w, mover.token, "filing.refusal_floor", 100)).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      expect(await set(w, mover.token, "no.such_lever", 1)).toMatchObject({ ok: false, code: "not_found" });
      for (const value of [11, -1, 2.5, "many"])
        expect(await set(w, mover.token, "lessons.digest_weekly", value)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      // Nothing was written by any of them.
      expect(await stored(w)).toEqual([]);
      expect(await history(w)).toEqual([]);
    }));

  it("an agent's change takes effect, is listed, and has one history row however often it is repeated", () =>
    withWorkWorld(async (w) => {
      const mover = await w.client("mover", ["own"], { tools: MOVE });
      const other = await w.client("other", ["own"], { tools: READ });
      const requestId = request();
      expect(ok(await set(w, mover.token, "lessons.digest_weekly", 2, requestId))).toEqual({
        key: "lessons.digest_weekly",
        value: 2,
      });
      ok(await set(w, mover.token, "lessons.digest_weekly", 2, requestId));
      // A repeat that names another value writes nothing and answers what the first call wrote.
      expect(ok(await set(w, mover.token, "lessons.digest_weekly", 7, requestId))).toEqual({
        key: "lessons.digest_weekly",
        value: 2,
      });
      expect(await lever(w.admin, "lessons.digest_weekly")).toBe(2);
      expect(await history(w)).toMatchObject([
        {
          key: "lessons.digest_weekly",
          old_value: null,
          new_value: 2,
          reason: "tune",
          measure: "owner_questions_per_week",
        },
      ]);
      expect((await history(w))[0]?.changed_by).toMatch(/^client:/);
      expect(one(await listed(w, mover.token), "lessons.digest_weekly")).toMatchObject({
        value: 2,
        default: 5,
        lastChange: { by: "you", from: null, to: 2, reason: "tune" },
      });
      expect(one(await listed(w, other.token), "lessons.digest_weekly")).toMatchObject({
        value: 2,
        lastChange: { by: "agent", to: 2 },
      });
      // A second change records the value it replaced; the same value again records nothing.
      ok(await set(w, mover.token, "lessons.digest_weekly", 4));
      ok(await set(w, mover.token, "lessons.digest_weekly", 4));
      expect((await history(w)).map((row) => [row.old_value, row.new_value])).toEqual([
        [null, 2],
        [2, 4],
      ]);
      // Every other lever still reads its default.
      for (const key of LEVER_KEYS)
        if (key !== "lessons.digest_weekly") expect(await lever(w.admin, key), key).toBe(leverDefault(key));
    }));

  it("the owner sets any lever inside its range, and undo restores the value before", () =>
    withWorkWorld(async (w) => {
      const mover = await w.client("mover", ["own"], { tools: MOVE });
      ok(await set(w, mover.token, "lessons.digest_weekly", 2));
      await withAdmin(w, async (admin) => {
        expect(await admin.box.setLever("lessons.digest_weekly", 7)).toEqual({
          key: "lessons.digest_weekly",
          value: 7,
        });
        expect(await admin.box.setLever("detect.backlog_over", 100)).toEqual({
          key: "detect.backlog_over",
          value: 100,
        });
        await expect(admin.box.setLever("detect.backlog_over", 5000)).rejects.toMatchObject({
          code: "invalid_argument",
        });
        await expect(admin.box.setLever("no.such_lever", 1)).rejects.toMatchObject({ code: "not_found" });
        await expect(admin.box.undoLever("no.such_lever")).rejects.toMatchObject({ code: "not_found" });
        expect(await lever(w.admin, "detect.backlog_over")).toBe(100);

        // Back to the agent's 2, written as the owner's change.
        expect(await admin.box.undoLever("lessons.digest_weekly")).toEqual({
          key: "lessons.digest_weekly",
          value: 2,
        });
        // The owner's lever had no value before: its row is removed and the default stands.
        expect(await admin.box.undoLever("detect.backlog_over")).toEqual({ key: "detect.backlog_over", value: 50 });
        // A lever nobody changed: nothing to undo, and nothing written.
        expect(await admin.box.undoLever("outcomes.sample_weekly")).toEqual({
          key: "outcomes.sample_weekly",
          value: 3,
        });
        expect(one((await admin.box.levers()).levers, "detect.backlog_over")).toMatchObject({
          value: 50,
          lastChange: { by: "owner", from: 100, to: null, reason: "undo" },
        });
      });
      expect(await stored(w)).toEqual([{ key: "lessons.digest_weekly", value: 2, updated_by: "owner" }]);
      expect((await history(w)).map((row) => [row.key, row.old_value, row.new_value, row.reason])).toEqual([
        ["lessons.digest_weekly", null, 2, "tune"],
        ["lessons.digest_weekly", 2, 7, "owner_set"],
        ["detect.backlog_over", null, 100, "owner_set"],
        ["lessons.digest_weekly", 7, 2, "undo"],
        ["detect.backlog_over", 100, null, "undo"],
      ]);
      const owners = (await history(w)).slice(1).map((row) => row.changed_by);
      expect(owners).toEqual(["owner", "owner", "owner", "owner"]);
    }));

  it("a stored row the registry does not admit has no effect", () =>
    withWorkWorld(async (w) => {
      // The definer checks forms, not ranges: the registry is code. A value past the range and a
      // key no lever has are stored, and nothing reads either.
      await w.admin("select policy.owner_set_lever($1, $2::jsonb, 'test', 'owner_questions_per_week')", [
        "lessons.digest_weekly",
        "500",
      ]);
      await w.admin("select policy.owner_set_lever($1, $2::jsonb, 'test', 'owner_questions_per_week')", [
        "not.registered",
        "1",
      ]);
      expect((await stored(w)).map((row) => row.key)).toEqual(["lessons.digest_weekly", "not.registered"]);
      expect(await lever(w.admin, "lessons.digest_weekly")).toBe(5);
      const agent = await w.client("reader", ["own"], { tools: READ });
      const levers = await listed(w, agent.token);
      expect(one(levers, "lessons.digest_weekly")).toMatchObject({ value: 5, lastChange: { by: "owner", to: 500 } });
      expect(levers.map((each) => each.key)).toEqual([...LEVER_KEYS]);
      // A value that is neither a number nor a code is refused by the definer itself.
      await expect(
        w.admin(
          "select policy.owner_set_lever('lessons.digest_weekly', $1::jsonb, 'test', 'owner_questions_per_week')",
          ['{"a":1}'],
        ),
      ).rejects.toThrow();
    }));

  it("no runtime role writes a setting or its history but through a definer, and the history is append-only", () =>
    withWorkWorld(async (w) => {
      await w.admin(
        "select policy.owner_set_lever('lessons.digest_weekly', '3'::jsonb, 'test', 'owner_questions_per_week')",
        [],
      );
      await expect(
        w.admin(
          "insert into policy.settings (key, value, updated_by) values ('outcomes.sample_weekly', '9', 'owner')",
          [],
        ),
      ).rejects.toThrow();
      await expect(w.admin("update policy.settings set value = '9'", [])).rejects.toThrow();
      await expect(w.admin("delete from policy.settings", [])).rejects.toThrow();
      await expect(
        w.admin(
          "insert into policy.setting_changes (key, new_value, changed_by, reason, measure) values ('outcomes.sample_weekly', '9', 'owner', 'test', 'test')",
          [],
        ),
      ).rejects.toThrow();
      await expect(w.admin("update policy.setting_changes set reason = 'other'", [])).rejects.toThrow();
      await expect(w.admin("delete from policy.setting_changes", [])).rejects.toThrow();
      // The agent's definer is not the owner's role's to call, nor the owner's the reader's.
      await expect(
        w.admin(
          "select policy.set_lever('lessons.digest_weekly', '2'::jsonb, 'tune', 'test', 'request-0001', 'ses_x')",
          [],
        ),
      ).rejects.toThrow();
      expect(await lever(w.admin, "lessons.digest_weekly")).toBe(3);
      expect(await history(w)).toHaveLength(1);
    }));
});
