import type { PersonalTool } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { createWork } from "../agent-work/work.ts";
import { type Query, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";

// The store cancels its own statement (pg_cancel_backend, which pi_reader may do to a backend of
// its own role), rolls the call's transaction back and answers `unavailable`: nothing is written,
// not even the call log row, so a retry by request id finds nothing. Every cancelled case has its
// control, the same call without a signal.

const COMPARTMENTS = ["own", "employer:example", "agent:scribe"];

let store: TestStore;
let token: string;

beforeAll(async () => {
  store = await openStore({ compartments: COMPARTMENTS });
  const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
  ({ token } = await admin.clients.addClient(
    registration("scribe", ["own"], { tools: ["get_self", "record"] as PersonalTool[] }),
  ));
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

// As pi_admin, which reads the ledger, as the other record tests do: the bootstrap reaches no
// schema of the store.
const recordsOf = async (requestId: string): Promise<number> =>
  Number(
    (
      await queryAs<{ n: string }>(
        store.db.urls.admin,
        "select count(*) as n from ledger.agent_writes where request_id = $1",
        [requestId],
      )
    )[0]?.n,
  );

// pi_reader's other backends of this database in `state`, read as pi_reader: only a member of a
// role, or of pg_read_all_stats, sees its backends' state and wait event, and the bootstrap is
// neither.
const readerBackends = (where: string): Promise<{ pid: number }[]> =>
  queryAs(
    store.db.urls.reader,
    `select pid from pg_stat_activity where datname = current_database() and usename = 'pi_reader' and pid <> pg_backend_pid() and ${where}`,
  );

// Waits until a pi_reader backend of this database waits on a lock: the call is inside its
// statement.
async function blockedReader(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await readerBackends("wait_event_type = 'Lock'")).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the reader never waited on the lock");
}

// Runs `call` while `table` is locked by another session, aborts its signal once it waits, and
// returns its answer. The lock is let go after the answer.
async function cancelledWhileLocked<T>(table: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return session(store.db.urls.bootstrap, async (query: Query) => {
    await query("begin");
    // As pi_owner, through the bootstrap's membership, as the other tests that act as the owner do.
    await query("set local role pi_owner");
    await query(`lock table ${table} in access exclusive mode`);
    try {
      const controller = new AbortController();
      const pending = call(controller.signal);
      await blockedReader();
      controller.abort();
      return await pending;
    } finally {
      await query("rollback");
    }
  });
}

describe("a cancelled call writes nothing", { timeout: DB_TEST_TIMEOUT }, () => {
  it("record cancelled inside its statement answers unavailable, writes no record and no call log row; the retry writes it", async () => {
    const args = { kind: "note" as const, body: "A note that the cancel must not keep.", requestId: "req-cancel-0001" };
    const calls = (await callLog(store.db.urls.admin)).length;

    const answer = await cancelledWhileLocked("ledger.agent_writes", (signal) =>
      store.reader.record(token, args, { signal }),
    );
    expect(answer).toEqual({ ok: false, code: "unavailable" });
    expect(await recordsOf(args.requestId)).toBe(0);
    expect(await callLog(store.db.urls.admin)).toHaveLength(calls);
    // No statement of the reader is left waiting or running.
    expect(await readerBackends("state = 'active'")).toEqual([]);

    // The control: the same request, with no signal, is written once.
    expect(outcomeValue(await store.reader.record(token, args)).recordId).toMatch(/^rec_/);
    expect(await recordsOf(args.requestId)).toBe(1);
    expect((await callLog(store.db.urls.admin)).slice(calls)).toEqual([
      { client: "scribe", tool: "record", rows: 1, outcome: "ok" },
    ]);
  });

  it("a read cancelled inside its statement answers unavailable and leaves no call log row; the pool still serves", async () => {
    const calls = (await callLog(store.db.urls.admin)).length;
    const answer = await cancelledWhileLocked("knowledge.entities", (signal) =>
      store.reader.getSelf(token, {}, { signal }),
    );
    expect(answer).toEqual({ ok: false, code: "unavailable" });
    expect(await callLog(store.db.urls.admin)).toHaveLength(calls);
    // The control: the same read with a signal never aborted answers, on the same pool.
    expect((await store.reader.getSelf(token, {}, { signal: new AbortController().signal })).ok).toBe(true);
    expect((await callLog(store.db.urls.admin)).slice(calls)).toEqual([
      { client: "scribe", tool: "get_self", rows: expect.any(Number), outcome: "ok" },
    ]);
  });

  it("a signal aborted before the call answers unavailable with no statement, for reads, record and work", async () => {
    const calls = (await callLog(store.db.urls.admin)).length;
    const signal = AbortSignal.abort();
    const work = createWork({ reader: store.reader, log: store.log });
    expect(await store.reader.getSelf(token, {}, { signal })).toEqual({ ok: false, code: "unavailable" });
    expect(
      await store.reader.record(token, { kind: "note", body: "x", requestId: "req-cancel-0002" }, { signal }),
    ).toEqual({ ok: false, code: "unavailable" });
    expect(await store.reader.refused(token, "search", { signal })).toEqual({ ok: false, code: "unavailable" });
    expect(await work.listOpportunities(token, {}, { signal })).toEqual({ ok: false, code: "unavailable" });
    await expect(store.reader.client(token, { signal })).rejects.toMatchObject({ code: "unavailable" });
    expect(await recordsOf("req-cancel-0002")).toBe(0);
    expect(await callLog(store.db.urls.admin)).toHaveLength(calls);
    // The control: unaborted, the client is found.
    expect((await store.reader.client(token, { signal: new AbortController().signal }))?.name).toBe("scribe");
  });
});
