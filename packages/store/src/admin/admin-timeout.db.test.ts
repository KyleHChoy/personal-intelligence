import type { PersonalLogger } from "@intelligence/contracts/personal";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { createAdmin } from "./admin.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// An admin made with a timeout gives up on a statement that waits, so `pi models import-key`
// cannot hold the box's start or its timer on a stalled pi-db.

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

describe("an admin with a timeout", () => {
  it("fails a statement that waits on a lock, and succeeds once the lock is gone", async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const setup = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    await setup.secrets.setSecret("openrouter/key", "sk-test-first-key");
    await setup.close();

    // Another session holds the row, as a stalled transaction would.
    const holder = new pg.Client({ connectionString: db.urls.admin });
    await holder.connect();
    await holder.query("begin");
    await holder.query("select name from policy.secrets where name = 'openrouter/key' for update");

    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet, timeoutMs: 300 });
    try {
      const started = Date.now();
      await expect(admin.secrets.setSecret("openrouter/key", "sk-test-second-key")).rejects.toMatchObject({
        code: "unavailable",
      });
      // The failure is waiting on the lock for good, so this only has to outlast a slow machine.
      expect(Date.now() - started).toBeLessThan(60_000);

      // The positive control: with the lock released, the same admin writes.
      await holder.query("rollback");
      await admin.secrets.setSecret("openrouter/key", "sk-test-second-key");
      expect(await admin.secrets.secret("openrouter/key")).toBe("sk-test-second-key");
    } finally {
      await admin.close();
      await holder.end();
    }
  });
});
