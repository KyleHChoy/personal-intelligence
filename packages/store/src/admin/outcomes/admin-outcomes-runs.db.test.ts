import { describe, expect, it } from "vitest";
import { session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { withWorkWorld } from "../../test-support/work-test-world.ts";
import { runsReliability } from "./admin-outcomes-runs.ts";

// `pi outcomes`' `runs` as pi_admin: a queued run nothing takes shows as its age and a day with none
// taken, the reasoner's failed exits by the day they happened and a run's end by its code. A
// restricted run is in no count, and the numbers are the seeded ones.

const WINDOW = { since: "2000-01-01T00:00:00Z", until: "2100-01-01T00:00:00Z", within: ["own"] };

describe("the runs' reliability by day", { timeout: DB_TEST_TIMEOUT }, () => {
  it("counts what happened to runs and the reasoner, within the label", async () => {
    await withWorkWorld(async (w) => {
      const waiting = await w.queuedRun(["own"]);
      const failing = await w.queuedRun(["own"]);
      await w.status("run", failing, "running");
      await queryAs(
        w.db.urls.work,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('run', $1, 'failed', now(), 'reasoner', '{own}', 'bad_output')",
        [failing],
      );
      await queryAs(
        w.db.urls.admin,
        "insert into ledger.job_runs (job, started_at, ended_at, code) values ('reasoner', now(), now(), 'exit_1'), ('reasoner', now(), now(), 'exit_1'), ('reasoner', now(), now(), 'ok')",
      );
      await queryAs(
        w.db.urls.work,
        "insert into ledger.silences (request_id, created_by, compartments, reason, wake_source, wake_key, day) values ('silence-budget-1', 'system:tick', '{own}', 'budget', 'daily_sweep', 'k', current_date)",
      );

      const view = await session(w.db.urls.admin, (query) => runsReliability(query, WINDOW));
      expect(view.queue.queued).toBe(1);
      expect(view.queue.oldestQueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(view.queue.lastTakenAt).toBeNull();
      const [today, ...rest] = view.days;
      expect(rest).toEqual([]);
      expect(today).toMatchObject({
        queued: 2,
        taken: 0,
        finished: 0,
        failed: 1,
        failedBy: { bad_output: 1 },
        reasonerFailed: 2,
        budgetSkips: 1,
      });
      expect(view.sources).toEqual([
        { source: expect.any(String), runs: 2, finished: 0, failed: 1, spentMicroUsd: 0, spentOnFailedMicroUsd: 0 },
      ]);

      // A label outside the key file's list is in no count; the reasoner's exits have no label.
      const narrow = await session(w.db.urls.admin, (query) =>
        runsReliability(query, { ...WINDOW, within: ["employer:example"] }),
      );
      expect(narrow.queue.queued).toBe(0);
      expect(narrow.sources).toEqual([]);
      expect(narrow.days[0]).toMatchObject({ queued: 0, failed: 0, reasonerFailed: 2, budgetSkips: 0 });
      expect(JSON.stringify(view)).not.toContain(waiting);
    });
  }, 120_000);
});
