import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryAs } from "../../test-support/database.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";

// The capability ledger on a few runs worked out by hand: a run inside the 14 days counts, one
// before it does not but can still be the last run, a run after `now` is not seen, and every job
// the check accepts has a row, a job that never ran included, but a retired one (the box's
// task executor), which the check still accepts for its old rows, has none.

const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

describe("the capability ledger", () => {
  let store: TestStore;

  beforeAll(async () => {
    store = await openStore({ now: NOW, compartments: ["own"], writer: false });
    const run = (job: string, at: string, code: string) =>
      queryAs(
        store.db.urls.admin,
        "insert into ledger.job_runs (job, started_at, ended_at, code) values ($1, $2, $2, $3)",
        [job, at, code],
      );
    await run("backup", ago(20), "ok");
    await run("backup", ago(3), "failed");
    await run("backup", ago(1), "ok");
    await run("canary", ago(30), "ok");
    // After `now`: a clock the ledger is not yet at.
    await run("extract", new Date(NOW.getTime() + DAY_MS).toISOString(), "ok");
  }, 120_000);

  afterAll(async () => {
    await store?.close();
  });

  it("counts each job's runs in the window and names its last run", async () => {
    const ledger = await store.admin.box.capabilities();
    expect(ledger.at).toBe(NOW.toISOString());
    expect(ledger.days).toBe(14);
    const byId = new Map(ledger.capabilities.map((row) => [row.id, row]));
    expect(byId.get("backup")).toEqual({ id: "backup", runs: 2, lastRunAt: ago(1), lastStatus: "ok" });
    expect(byId.get("canary")).toEqual({ id: "canary", runs: 0, lastRunAt: ago(30), lastStatus: "ok" });
    expect(byId.get("extract")).toEqual({ id: "extract", runs: 0, lastRunAt: null, lastStatus: null });
  });

  it("lists every job the check accepts, in order, once, and no other", async () => {
    const ids = (await store.admin.box.capabilities()).capabilities.map((row) => row.id);
    // The jobs ledger.job_runs's check accepts, read from the constraint itself.
    const [check] = await queryAs<{ def: string }>(
      store.db.urls.admin,
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'ledger.job_runs'::regclass and conname = 'job_runs_job'",
    );
    const accepted = [...(check?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1] as string);
    expect(accepted).toEqual(
      expect.arrayContaining(["sync", "extract", "dream", "reasoner", "backup", "restore_drill", "canary"]),
    );
    // Every job the check accepts but the retired ones, which keep their old rows only.
    expect(ids).toEqual([...new Set(accepted)].filter((job) => job !== "executor").sort());
  });

  it("leaves out a retired job the check still accepts", async () => {
    const [check] = await queryAs<{ def: string }>(
      store.db.urls.admin,
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'job_runs_job'",
    );
    expect(check?.def).toContain("'executor'");
    const ids = (await store.admin.box.capabilities()).capabilities.map((row) => row.id);
    expect(ids).not.toContain("executor");
  });
});
