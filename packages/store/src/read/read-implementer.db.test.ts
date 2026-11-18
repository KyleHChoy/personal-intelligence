import { randomBytes } from "node:crypto";
import type { EntityId, PersonalReadTool, PersonalView } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { CANARIES, CANARY_PERSON, connect } from "../test-support/cast.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestEvent, ingestMail, mailFacts, mailItem, NOW } from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { callLog, openStore, type Store, withStore } from "../test-support/store.ts";
import { registration } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The implementer's own database tests of the reader: one snapshot per call,
// a connection lost in the middle of one, the thread of a message its source gave none, a time
// argument the server would not take as text, and a session that is not pi_reader's. The blind tests are in the other read*.db.test.ts.

const VIEWS: PersonalView[] = ["self", "people"];
const TOOLS: PersonalReadTool[] = ["get_self", "search", "get_entity", "get_timeline"];
const now = (): Date => new Date(NOW);

// A pool that hands `before` each statement's text before it is sent, and `after` once it has
// answered. It passes on everything else a checked-out client has.
function watchedPool(
  pool: pg.Pool,
  hooks: { before?: (text: string, pid: number) => Promise<void>; after?: (text: string) => Promise<void> },
): { pool: pg.Pool; statements: string[] } {
  const statements: string[] = [];
  const watched = {
    async connect() {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid ?? 0;
      return {
        async query(text: string, values: unknown[]) {
          statements.push(text);
          await hooks.before?.(text, pid);
          const result = await client.query(text, values);
          await hooks.after?.(text);
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
        on: (event: "error", listener: (error: Error) => void) => client.on(event, listener),
        removeListener: (event: "error", listener: (error: Error) => void) => client.removeListener(event, listener),
      };
    },
  };
  return { pool: watched as unknown as pg.Pool, statements };
}

// A store with the canary person's one message in it, a client cleared for `own`, and a pool
// as pi_reader that `fn` wraps as it likes.
async function withSeeded(
  fn: (
    seeded: Store & { accounts: Awaited<ReturnType<typeof connect>>; token: string; pool: pg.Pool; canary: EntityId },
  ) => Promise<void>,
): Promise<void> {
  await withStore(async (store) => {
    const { db, writer } = store;
    const accounts = await connect(writer);
    await ingestMail(writer, accounts.personalMail, MAIL.canary);
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
    const pool = new pg.Pool({ connectionString: db.urls.reader, max: 1 });
    try {
      const { token } = await admin.clients.addClient({
        name: "snapshot-client",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"],
        views: VIEWS,
        tools: TOOLS,
      });
      const found = await new Reader({ pool, keys: db.keys, log: recordingLogger().log, now }).search(token, {
        query: CANARY_PERSON.address,
      });
      const canary = found.ok ? (found.value.results[0]?.id as EntityId | undefined) : undefined;
      if (canary === undefined) throw new Error("the seeded person was not found");
      await fn({ ...store, accounts, token, pool, canary });
    } finally {
      await pool.end();
      await admin.close();
    }
  });
}

describe("Reader", () => {
  it("a commit by the writer between two of a tool's statements does not change that tool's result", async () => {
    await withSeeded(async ({ db, writer, accounts, token, pool, canary }) => {
      const { log } = recordingLogger();
      const plain = new Reader({ pool, keys: db.keys, log, now });

      // Each tool, with a write that changes what it returns: the owner's reply for the entity's
      // mail counts, and an event the person attends for the timeline.
      const cases = [
        {
          call: (reader: Reader) => reader.getEntity(token, { id: canary }),
          write: () => ingestMail(writer, accounts.personalMail, MAIL.reply),
        },
        {
          call: (reader: Reader) => reader.getTimeline(token, { id: canary, to: "2026-12-31T00:00:00Z" }),
          write: () => ingestEvent(writer, accounts.personalCalendar, EVENTS.canary),
        },
      ];
      for (const { call, write } of cases) {
        const before = await call(plain);
        expect(before.ok).toBe(true);

        // The writer commits once, as soon as the call's first knowledge statement has answered.
        let written = 0;
        const paused = watchedPool(pool, {
          after: async (text) => {
            if (!text.includes("knowledge.") || written > 0) return;
            written += 1;
            expect(await write()).toBe("stored");
          },
        });
        const during = await call(new Reader({ pool: paused.pool, keys: db.keys, log, now }));
        expect(written).toBe(1);
        // More knowledge statements followed the write, and none of them saw it.
        expect(paused.statements.filter((text) => text.includes("knowledge.")).length).toBeGreaterThan(1);
        expect(during).toEqual(before);

        // The positive control: the write did change what the tool returns.
        expect(await call(plain)).not.toEqual(before);
      }
    });
  });

  it("a message with no thread id is a thread of one, its own id", async () => {
    await withSeeded(async ({ db, writer, accounts, token, pool, canary }) => {
      // The owner's reply, as a source that gives no thread would hand it over.
      const { threadId: _, ...threadless } = mailItem(MAIL.reply, accounts.personalMail);
      expect(await writer.ingestItem(accounts.personalMail, threadless, mailFacts(MAIL.reply))).toBe("stored");

      const timeline = await new Reader({ pool, keys: db.keys, log: recordingLogger().log, now }).getTimeline(token, {
        id: canary,
      });
      if (!timeline.ok) throw new Error(timeline.code);
      const threads = timeline.value.entries.flatMap((entry) =>
        entry.kind === "email" ? [{ id: entry.id, thread: entry.thread.untrusted }] : [],
      );
      expect(threads.length).toBe(2);
      const [reply, first] = threads;
      expect(reply?.thread).toBe(reply?.id);
      // The positive control: a message with a thread id keeps it.
      expect(first?.thread).toBe(CANARIES.threadId);
    });
  });

  it("a from with an offset Postgres refuses is answered, with its one call row", async () => {
    await withSeeded(async ({ db, token, pool, canary }) => {
      const { log, calls } = recordingLogger();
      const reader = new Reader({ pool, keys: db.keys, log, now });
      const logged = async (): Promise<{ outcome: string; rows: number }[]> =>
        queryAs(db.urls.admin, "select outcome, rows from policy.calls where tool = 'get_timeline' order by id");

      // The seeded message was sent at 2026-09-01T09:00:00Z. Every bound here is a Timestamp of
      // the contract, and among them are forms the server does not take as text: an offset past
      // 15:59, and an instant past the year 9999.
      const windows: { window: { from?: string; to?: string }; entries: number }[] = [
        { window: { from: "2026-09-02T00:00:00+16:00" }, entries: 1 }, // 08:00Z the day before
        { window: { from: "2026-09-02T02:00:00+16:00" }, entries: 0 }, // 10:00Z
        { window: { from: "2026-09-02T08:58:59+23:59" }, entries: 1 }, // 08:59:59Z the day before
        { window: { to: "2026-08-31T18:00:00-16:00" }, entries: 1 }, // 10:00Z
        { window: { to: "2026-08-31T16:00:00-16:00" }, entries: 0 }, // 08:00Z
        { window: { from: "0100-01-01T00:00:00+23:59", to: "9999-12-31T23:59:59-23:59" }, entries: 1 }, // to the year 10000
        { window: { from: "2026-09-01T09:00:00.000000000Z", to: "2026-09-01T09:00:00.999999999Z" }, entries: 1 },
      ];
      for (const { window, entries } of windows) {
        const before = await logged();
        const answer = await reader.getTimeline(token, { id: canary, ...window });
        expect(answer.ok ? answer.value.entries.length : answer.code, JSON.stringify(window)).toBe(entries);
        // One row for the call, with what it returned.
        expect(await logged(), JSON.stringify(window)).toEqual([...before, { outcome: "ok", rows: entries }]);
      }
      expect(calls).toEqual([]);
    });
  });

  it("a reader connected as another role answers unauthorized for a valid token", async () => {
    await withSeeded(async ({ db, token, pool, canary }) => {
      // A login role that is not pi_reader and can do all pi_reader needs to learn its client:
      // connect, use the schemas, and execute the three functions. The local bootstrap is no
      // superuser, so this stands for a superuser or BYPASSRLS URL in the reader's variable.
      const other = `pit${randomBytes(3).toString("hex")}_reads`;
      const database = pg.escapeIdentifier(db.name);
      const functions = "policy.current_client(), policy.client_clearance(), policy.log_call(text, integer, text)";
      await session(db.urls.bootstrap, async (query) => {
        await query(`create role ${other} login password 'local-only'`);
        await query(`grant connect on database ${database} to ${other}`);
        await query("set role pi_owner");
        await query(`grant usage on schema policy, knowledge to ${other}`);
        await query(`grant execute on function ${functions} to ${other}`);
      });
      try {
        const url = new URL(db.urls.reader);
        url.username = other;
        const theirs = new pg.Pool({ connectionString: url.href, max: 1 });
        try {
          // Not vacuous: left to itself, this role's session does find the token's client.
          const connection = await theirs.connect();
          try {
            await connection.query("begin");
            await connection.query("select set_config('pi.client_token', $1, true)", [token]);
            expect((await connection.query("select name from policy.current_client()")).rows).toEqual([
              { name: "snapshot-client" },
            ]);
            await connection.query("rollback");
          } finally {
            connection.release();
          }

          // What each session reports, and what the reader's own statement makes of it. Row
          // security is active for both: the other role is an ordinary one, refused by its name.
          // (A superuser or a BYPASSRLS role, which the local bootstrap cannot make, reports
          // false there.) The statement is the reader's, taken from a call, with a marker for a token.
          const watched = watchedPool(pool, {});
          await new Reader({ pool: watched.pool, keys: db.keys, log: recordingLogger().log, now }).client(token);
          const setToken = watched.statements.find((text) => /set_config\s*\(/i.test(text)) ?? "";
          expect(setToken).toMatch(/row_security_active\s*\(\s*'policy\.clients'\s*\)/i);
          const reported = async (from: pg.Pool): Promise<unknown> => {
            const one = await from.connect();
            try {
              await one.query("begin");
              const said = (
                await one.query(
                  "select session_user::text as session, current_user::text as acting, row_security_active('policy.clients') as active",
                )
              ).rows[0] as object;
              // By position: the statement also sets enable_seqscan, in a second column of the same
              // name.
              const set = (
                (await one.query({ text: setToken, values: ["marker"], rowMode: "array" })).rows[0] as unknown[]
              )[0];
              await one.query("rollback");
              return { ...said, set };
            } finally {
              one.release();
            }
          };
          expect(await reported(pool)).toEqual({
            session: "pi_reader",
            acting: "pi_reader",
            active: true,
            set: "marker",
          });
          expect(await reported(theirs)).toEqual({ session: other, acting: other, active: true, set: "" });

          const { log, calls } = recordingLogger();
          const reader = new Reader({ pool: theirs, keys: db.keys, log, now });
          const callsBefore = await queryAs(db.urls.admin, "select count(*)::int as n from policy.calls");
          const unauthorized = { ok: false, code: "unauthorized" };
          expect(await reader.client(token)).toBeNull();
          expect(await reader.getSelf(token)).toEqual(unauthorized);
          expect(await reader.search(token, { query: CANARY_PERSON.address })).toEqual(unauthorized);
          expect(await reader.getEntity(token, { id: canary })).toEqual(unauthorized);
          expect(await reader.getTimeline(token, { id: canary })).toEqual(unauthorized);
          // A refusal like any other: no call row, and nothing logged.
          expect(await queryAs(db.urls.admin, "select count(*)::int as n from policy.calls")).toEqual(callsBefore);
          expect(calls).toEqual([]);
        } finally {
          await theirs.end();
        }

        // The positive control: the same token through a reader connected as pi_reader.
        const reader = new Reader({ pool, keys: db.keys, log: recordingLogger().log, now });
        expect((await reader.client(token))?.name).toBe("snapshot-client");
        expect((await reader.getSelf(token)).ok).toBe(true);
        expect((await reader.search(token, { query: CANARY_PERSON.address })).ok).toBe(true);
        expect((await reader.getEntity(token, { id: canary })).ok).toBe(true);
        expect((await reader.getTimeline(token, { id: canary })).ok).toBe(true);
      } finally {
        await session(db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query(`revoke execute on function ${functions} from ${other}`);
          await query(`revoke usage on schema policy, knowledge from ${other}`);
          await query("reset role");
          await query(`revoke connect on database ${database} from ${other}`);
          await query(`drop role ${other}`);
        });
      }
    });
  });

  it("a row of a compartment the client is not cleared for does not open, even if it reaches the reader", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const { db, reader, admin, log } = store;
      const seeded = await seedWorld(store.writer, admin);
      const { token: own } = await admin.clients.addClient(registration("own-client", ["own"]));
      const { token: wide } = await admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      // Seen under both labels, so every tool reads a row of each compartment for this person.
      const blake = seeded.entityOf(WORLD.both.address);
      const calls = (token: string) => [
        reader.getSelf(token),
        reader.search(token, { query: "blake" }),
        reader.getEntity(token, { id: blake }),
        reader.getTimeline(token, { id: blake }),
      ];
      const holdsWork = (answers: unknown): boolean =>
        WORLD.workNeedles.some((needle) => JSON.stringify(answers).includes(needle));

      // The positive control: under the policies as they are, the client cleared for `own` is
      // answered by every tool, with nothing of the employer's.
      const before = await Promise.all(calls(own));
      expect(before.map((answer) => answer.ok)).toEqual([true, true, true, true]);
      expect(holdsWork(before)).toBe(false);

      // In this test database only: the row policies of pi_reader let every row through, as a
      // policy written wrongly would. The reader's keys are then all that stands.
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        for (const table of [
          "accounts",
          "domains",
          "aliases",
          "messages",
          "interaction_log",
          "events",
          "event_details",
          "event_participants",
        ]) {
          await query(`alter policy pi_reader_select on knowledge.${table} using (true)`);
        }
      });
      // Not vacuous: the employer's rows do reach a session that carries the `own` token.
      const reached = await session(db.urls.reader, async (query) => {
        await query("begin");
        await query("select set_config('pi.client_token', $1, true)", [own]);
        const rows = await query<{ compartment: string }>(
          "select distinct compartments[1] as compartment from knowledge.aliases order by 1",
        );
        await query("rollback");
        return rows.map((row) => row.compartment);
      });
      expect(reached).toEqual(["employer:example", "own"]);

      const logged = await callLog(db.urls.admin);
      const events = log.events.length;
      // Every tool now reads a row sealed under a key this client's call was not given: none of
      // them opens it, and each answers as for any value that does not open, with no call row.
      const after = await Promise.all(calls(own));
      expect(after).toEqual(Array.from({ length: 4 }, () => ({ ok: false, code: "unavailable" })));
      expect(log.events.slice(events)).toEqual(
        Array.from({ length: 4 }, () => ({ event: "read_failed", code: "unavailable" })),
      );
      expect(await callLog(db.urls.admin)).toEqual(logged);

      // The other control: the same rows through the same policies open for a client cleared
      // for both compartments, so it is the keys that refused, not the rows that broke.
      const cleared = await Promise.all(calls(wide));
      expect(cleared.map((answer) => answer.ok)).toEqual([true, true, true, true]);
      expect(holdsWork(cleared)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("a connection lost in the middle of a call answers unavailable, and nothing is uncaught", async () => {
    await withSeeded(async ({ db, token, pool, canary }) => {
      const { log, calls } = recordingLogger();
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown): void => void uncaught.push(error);
      process.on("uncaughtException", onUncaught);
      try {
        // The server ends the reader's own connection just before its first knowledge statement.
        let ended = 0;
        const lost = watchedPool(pool, {
          before: async (text, pid) => {
            if (!text.includes("knowledge.") || ended > 0) return;
            ended += 1;
            expect(await queryAs(db.urls.reader, "select pg_terminate_backend($1) as ended", [pid])).toEqual([
              { ended: true },
            ]);
          },
        });
        const reader = new Reader({ pool: lost.pool, keys: db.keys, log, now });
        const callsBefore = await queryAs(db.urls.admin, "select count(*)::int as n from policy.calls");

        expect(await reader.getEntity(token, { id: canary })).toEqual({ ok: false, code: "unavailable" });
        expect(ended).toBe(1);
        // Whatever the lost connection still has to say arrives before this.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(calls.map((one) => one.event)).toEqual([{ event: "read_failed", code: "unavailable" }]);
        expect(await queryAs(db.urls.admin, "select count(*)::int as n from policy.calls")).toEqual(callsBefore);

        // The positive control: the next call takes a new connection and answers.
        expect((await reader.getEntity(token, { id: canary })).ok).toBe(true);
        expect(uncaught).toEqual([]);
      } finally {
        process.removeListener("uncaughtException", onUncaught);
      }
    });
  });
});
