import { describe, expect, it } from "vitest";
import { runsReliability } from "../admin/outcomes/admin-outcomes-runs.ts";
import { request } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// A brief slower than next_run's deadline: the take is committed before the brief is read, so a
// cancel uses up an attempt and the queue moves on.

// A brief that never finishes: `ledger.intentions`, which the brief reads and the take does not, held
// by another session. The signal is aborted once the reader waits on it.
async function cancelledBrief(w: WorkWorld, token: string): Promise<{ ok: boolean; code?: string }> {
  return session(w.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query("lock table ledger.intentions in access exclusive mode");
    try {
      const controller = new AbortController();
      const pending = w.work.nextRun(token, { requestId: request() }, { signal: controller.signal });
      for (let tries = 0; ; tries += 1) {
        // As pi_reader: only a member of a role sees its backends' wait events.
        const waiting = await queryAs(
          w.db.urls.reader,
          "select pid from pg_stat_activity where datname = current_database() and usename = 'pi_reader' and pid <> pg_backend_pid() and wait_event_type = 'Lock'",
        );
        if (waiting.length > 0) break;
        if (tries > 200) throw new Error("the brief never waited on the lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      controller.abort();
      return (await pending) as { ok: boolean; code?: string };
    } finally {
      await query("rollback");
    }
  });
}

const attempts = (w: WorkWorld, run: string) =>
  w.admin<{ attempt: number }>("select attempt from ledger.run_attempts where run_id = $1 order by attempt", [run]);
const latest = async (w: WorkWorld, run: string): Promise<string | undefined> =>
  (
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'run' and row_id = $1 order by id desc limit 1",
      [run],
    )
  )[0]?.event;

describe("next_run with a slow brief", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a cancelled brief keeps its attempt and the next call takes the next run", () =>
    withWorkWorld(async (w) => {
      const r = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const slow = await w.queuedRun(["own"], [["message", (await w.message()).id]]);
      const next = await w.queuedRun(["own"], [["message", (await w.message()).id]]);

      expect(await cancelledBrief(w, r.token)).toMatchObject({ ok: false, code: "unavailable" });

      expect(await attempts(w, slow)).toEqual([{ attempt: 1 }]);
      expect(await latest(w, slow)).toBe("running");
      // The brief's own rows went with the cancel: no reading is recorded of what it never gave.
      expect(
        await w.admin("select tool from ledger.read_log where client_id = $1 and tool = 'next_run'", [r.id]),
      ).toEqual([]);

      const taken = ok(await w.work.nextRun(r.token, { requestId: request() }));
      expect(taken.run?.id).toBe(next);
    }));

  it("a taken run is one read log row and one call row, its brief read under the attempt it took", () =>
    withWorkWorld(async (w) => {
      const r = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const run = await w.queuedRun(["own"], [["message", (await w.message()).id]]);

      const taken = ok(await w.work.nextRun(r.token, { requestId: request() }));

      expect(taken.run).toMatchObject({ id: run, attempt: 1 });
      expect(await attempts(w, run)).toEqual([{ attempt: 1 }]);
      expect(
        await w.admin("select tool from ledger.read_log where client_id = $1 and tool = 'next_run'", [r.id]),
      ).toHaveLength(1);
      expect(
        await w.admin("select outcome from policy.calls where client_id = $1 and tool = 'next_run'", [r.id]),
      ).toEqual([{ outcome: "ok" }]);
    }));

  it("pia outcomes counts the sessions that hold a read of removed evidence", () =>
    withWorkWorld(async (w) => {
      const window = {
        since: new Date(Date.now() - 60_000).toISOString(),
        until: new Date(Date.now() + 60_000).toISOString(),
        within: ["own"],
      };
      const [clean, reading] = [await w.client("clean"), await w.client("reading")];
      const message = await w.message();
      expect((await w.reader.readMessage(clean.token, { id: message.id as never })).ok).toBe(true);
      expect((await w.reader.readMessage(reading.token, { id: message.id as never })).ok).toBe(true);
      expect((await runsReliability(w.admin, window)).sessions).toEqual({ read: 2, readRemoved: 0 });
      // One read of evidence no row holds, as a deletion leaves it.
      const [row] = await w.admin<{ session_id: string }>(
        "select session_id from ledger.read_log where client_id = $1",
        [reading.id],
      );
      await readAs(w.db, reading.token, (query) =>
        query("select policy.log_read($1, 'read_message', $2, '{}', '{}')", [row?.session_id, ["d".repeat(64)]]),
      );
      expect((await runsReliability(w.admin, window)).sessions).toEqual({ read: 2, readRemoved: 1 });
    }));

  it("no run to take is one call row and an empty answer", () =>
    withWorkWorld(async (w) => {
      const r = await w.client("reasoner", ["own"], { kind: "reasoner" });
      expect(ok(await w.work.nextRun(r.token, { requestId: request() }))).toEqual({ run: null });
      expect(
        await w.admin("select outcome from policy.calls where client_id = $1 and tool = 'next_run'", [r.id]),
      ).toEqual([{ outcome: "ok" }]);
    }));
});
