import type { ClientView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { READER_IDLE_IN_TRANSACTION_MS, Reader } from "../read/read.ts";
import { insertClient } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { insideHold, recordingLogger, recordingPool } from "../test-support/recording.ts";
import { storeFiles, storeText } from "../test-support/sources.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { endOwnPool, ownPool } from "./db.ts";

// The one call path. The Reader's own call tests and statement-list tests are the regression
// contract; these add what withClient itself must hold.

const GUARDED = "set_config('pi.client_token'";

let store: TestStore;
beforeAll(async () => {
  store = await openStore();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await store?.close();
});

describe("withClient", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the guarded statement appears once in the store's source", async () => {
    const files = storeFiles().filter((name) => !name.includes(".test."));
    let count = 0;
    const holders: string[] = [];
    for (const name of files) {
      const text = storeText(name);
      const here = text.split(GUARDED).length - 1;
      if (here > 0) holders.push(name);
      count += here;
    }
    expect(holders).toEqual(["read-db.ts"]);
    expect(count).toBe(1);
  });

  it("withClient under read committed sets the token, opens the session once and logs the call, as a read does", async () => {
    const client = await insertClient(store.db, "with-client", ["own"]);
    await queryAs(store.db.urls.admin, "update policy.clients set tools = $2, views = $3 where id = $1", [
      client.id,
      ["get_self"],
      ["self"],
    ]);
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });

    let seen: ClientView | null = null;
    const sessions: string[] = [];
    await reader.withClient(
      client.token,
      { isolation: "read committed" },
      async ({ client: found, ctx, logRead, logCall }) => {
        seen = found;
        if (found === null) throw new Error("no client");
        const one = ctx(found);
        sessions.push(await one.session(), await one.session());
        await logRead(one, "get_self", { bound: [], shown: [], factKeyFps: [] });
        await logCall("get_self", 0, "ok");
      },
    );
    const statements = insideHold([...recorded.statements]);
    expect(seen).toMatchObject({ id: client.id, name: "with-client" });
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(statements[1]).toMatch(/set_config\('pi\.client_token'/);
    expect(statements[2]).toMatch(/current_client\(\)/);
    expect(statements.slice(3)).toEqual([
      "select policy.open_session($1)",
      "select policy.log_read($1, $2, $3, $4, $5, $6, $7)",
      "select policy.log_call($1, $2, $3)",
      "COMMIT",
    ]);
    expect(sessions[0]).toBe(sessions[1]);
    expect(reader.sessions.of(client.id as ClientView["id"])).toBe(sessions[0]);

    // A read in the same process uses the same session, and opens none.
    recorded.statements.length = 0;
    expect((await reader.getSelf(client.token)).ok).toBe(true);
    expect(insideHold([...recorded.statements])[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(recorded.statements.filter((text) => /open_session/.test(text))).toEqual([]);
    const logged = await queryAs<{ session_id: string }>(
      store.db.urls.admin,
      "select session_id from ledger.read_log where client_id = $1 order by id",
      [client.id],
    );
    expect(logged.map((row) => row.session_id)).toEqual([sessions[0], sessions[0]]);
    expect(
      (await callLog(store.db.urls.admin)).filter((row) => row.client === "with-client").map((row) => row.outcome),
    ).toEqual(["ok", "ok"]);
  });
});

// A client that dies inside a transaction leaves its backend, and the locks it took, behind. The
// reader's pool asks the server to end a session idle inside a transaction, so such a lock frees
// itself; here with a short wait, the reader's own being READER_IDLE_IN_TRANSACTION_MS.
describe("a session idle inside a transaction", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is ended by the server, and its advisory lock freed", async () => {
    expect(READER_IDLE_IN_TRANSACTION_MS).toBeLessThanOrEqual(60_000);
    const { log } = recordingLogger();
    const stuck = ownPool(store.db.urls.reader, 1, log, { idleInTransactionMs: 300 });
    const other = ownPool(store.db.urls.reader, 1, log);
    try {
      const held = await stuck.connect();
      held.on("error", () => {});
      await held.query("begin");
      await held.query("select pg_advisory_xact_lock(hashtextextended('idle-test', 0))");
      // Idle, as a client that has gone away is.
      await vi.waitFor(
        async () => {
          const [row] = (await other.query("select pg_try_advisory_lock(hashtextextended('idle-test', 0)) as got"))
            .rows;
          expect(row?.got).toBe(true);
        },
        { timeout: 20_000, interval: 100 },
      );
      held.release(true);
    } finally {
      await endOwnPool(stuck);
      await endOwnPool(other);
    }
  });
});

// The store's statements are short and many, and a read's plan holds hundreds of row-policy
// subplans. The server's compiler took 3.4 of one read's 4.0 seconds on the deployed database
// compiling them, for a statement that then ran in half a second.
describe("a pool of the store's own", { timeout: DB_TEST_TIMEOUT }, () => {
  it("runs every statement with the server's compiler off", async () => {
    const pool = ownPool(store.db.urls.reader, 1, recordingLogger().log);
    try {
      const { rows } = await pool.query<{ jit: string }>("show jit");
      expect(rows[0]?.jit).toBe("off");
    } finally {
      await endOwnPool(pool);
    }
  });
});
