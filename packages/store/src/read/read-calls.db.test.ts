import {
  ClientView,
  PersonalLogEvent,
  type ReadOutcome,
  type SearchResult,
  type SelfView,
  type TimelineView,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { createTestDatabase, queryAs } from "../test-support/database.ts";
import { NAMES_KNOWLEDGE } from "../test-support/order.ts";
import { eventLogger, recordingPool } from "../test-support/recording.ts";
import { type CallRow, callLog, leftOn, openStore } from "../test-support/store.ts";
import {
  instant,
  MISSING_ENTITY,
  outcomeValue,
  refusedWith,
  registration,
  UNKNOWN_TOKEN,
} from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createReader, Reader } from "./read.ts";

// What a call leaves behind: the policy.calls row, the logger's events, and nothing on stdout, and
// what revoking a client does to its next call. Each refusal has its positive control in the same
// test.

const UNAUTHORIZED = { ok: false, code: "unauthorized" };
const UNAVAILABLE = { ok: false, code: "unavailable" };

describe("the reader's calls", { timeout: 180_000 }, () => {
  it("revoke stops the next call", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(registration("to-revoke", ["own"]));
      const { token: kept } = await store.admin.clients.addClient(registration("kept-client", ["own"]));
      const { reader, admin } = store;

      // The call before the revoke answers.
      expect((await reader.search(token, { query: "blake" })).ok).toBe(true);
      expect((await reader.client(token))?.name).toBe("to-revoke");

      // An unknown name revokes nothing.
      expect(await admin.clients.revokeClient("no-such-client")).toBe(false);
      expect((await reader.getSelf(token)).ok).toBe(true);

      expect(await admin.clients.revokeClient("to-revoke")).toBe(true);

      // The call after it does not, for any tool.
      expect(await reader.search(token, { query: "blake" })).toEqual(UNAUTHORIZED);
      expect(await reader.getSelf(token)).toEqual(UNAUTHORIZED);
      expect(await reader.client(token)).toBeNull();

      // The positive control: the client that was not revoked still answers.
      expect((await reader.search(kept, { query: "blake" })).ok).toBe(true);

      const listed = await admin.clients.listClients();
      const revoked = listed.find((row) => row.name === "to-revoke");
      expect(revoked?.status).toBe("revoked");
      expect(revoked?.revokedAt).not.toBeNull();
      expect(listed.find((row) => row.name === "kept-client")).toMatchObject({ status: "active", revokedAt: null });

      // Revoking it again finds the client, and leaves it revoked as of the first time.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await admin.clients.revokeClient("to-revoke")).toBe(true);
      const again = (await admin.clients.listClients()).find((row) => row.name === "to-revoke");
      expect(again?.status).toBe("revoked");
      expect(instant(again?.revokedAt ?? null)).toBe(instant(revoked?.revokedAt ?? null));
      expect(await reader.search(token, { query: "blake" })).toEqual(UNAUTHORIZED);
      expect((await reader.search(kept, { query: "blake" })).ok).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("every call by a current client writes one policy.calls row, refusals included", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const both = ["own", "employer:example"];
      const { token } = await store.admin.clients.addClient(registration("wide-client", both));
      const { token: selfOnly } = await store.admin.clients.addClient(
        registration("self-only", both, { tools: ["get_self"] }),
      );
      const { reader } = store;
      const blake = world.entityOf(WORLD.both.address);
      const log = (): Promise<CallRow[]> => callLog(store.db.urls.admin);

      // One call, and the one row it must add; `null` when it must add none.
      const step = async <T>(
        name: string,
        call: () => Promise<T>,
        row: (answer: T) => Omit<CallRow, "client"> | null,
        client = "wide-client",
      ): Promise<void> => {
        const before = await log();
        const expected = row(await call());
        expect(await log(), name).toEqual(expected === null ? before : [...before, { client, ...expected }]);
      };
      const ok =
        <T>(tool: string, count: (value: T) => number) =>
        (answer: ReadOutcome<T>) => {
          const rows = count(outcomeValue(answer));
          return { tool, rows, outcome: "ok" };
        };
      const refused = (tool: string, code: string) => (answer: ReadOutcome<unknown>) => {
        expect(answer).toEqual({ ok: false, code });
        return { tool, rows: 0, outcome: code };
      };

      // An answer: `rows` is the number of top-level items.
      let meetingsAndContacts = 0;
      await step(
        "get_self",
        () => reader.getSelf(token),
        ok<SelfView>("get_self", (value) => {
          meetingsAndContacts = value.upcoming.length + value.contacts.length;
          return meetingsAndContacts + value.changes.length + (value.next?.moves.length ?? 0);
        }),
      );
      expect(meetingsAndContacts).toBe(2 + 3);
      await step(
        "search",
        () => reader.search(token, { query: "canary" }),
        ok<SearchResult>("search", (value) => value.results.length),
      );
      expect((await log()).at(-1)?.rows).toBe(3);
      await step(
        "search that finds nothing",
        () => reader.search(token, { query: "nobody-by-this-name" }),
        ok<SearchResult>("search", (value) => value.results.length),
      );
      expect((await log()).at(-1)).toEqual({ client: "wide-client", tool: "search", rows: 0, outcome: "ok" });
      await step(
        "get_entity",
        () => reader.getEntity(token, { id: blake }),
        ok("get_entity", () => 1),
      );
      await step(
        "get_timeline",
        () => reader.getTimeline(token, { id: blake }),
        ok<TimelineView>("get_timeline", (value) => value.entries.length),
      );
      expect((await log()).at(-1)?.rows).toBe(7);

      // A refusal of a current client: one row, with `rows` 0.
      await step(
        "not_permitted",
        () => reader.search(selfOnly, { query: "blake" }),
        refused("search", "not_permitted"),
        "self-only",
      );
      await step(
        "invalid_request",
        () => reader.search(token, { query: "blake", limit: 26 }),
        refused("search", "invalid_request"),
      );
      await step(
        "not_found, an entity",
        () => reader.getEntity(token, { id: MISSING_ENTITY }),
        refused("get_entity", "not_found"),
      );
      await step(
        "not_found, a timeline",
        () => reader.getTimeline(token, { id: MISSING_ENTITY }),
        refused("get_timeline", "not_found"),
      );

      // No current client, and client(): no row.
      const none = (answer: ReadOutcome<unknown>) => {
        expect(answer).toEqual(UNAUTHORIZED);
        return null;
      };
      await step("unauthorized get_self", () => reader.getSelf(UNKNOWN_TOKEN), none);
      await step("unauthorized search", () => reader.search("", { query: "blake" }), none);
      await step("unauthorized get_entity", () => reader.getEntity(UNKNOWN_TOKEN, { id: blake }), none);
      await step("unauthorized get_timeline", () => reader.getTimeline(UNKNOWN_TOKEN, { id: blake }), none);
      await step(
        "client",
        () => reader.client(token),
        (view) => {
          expect(view?.name).toBe("wide-client");
          return null;
        },
      );
      await step(
        "client, unknown",
        () => reader.client(UNKNOWN_TOKEN),
        (view) => {
          expect(view).toBeNull();
          return null;
        },
      );
    } finally {
      await store.close();
    }
  });

  it("client returns exactly the five fields of ClientView, and reads nothing else", async () => {
    const store = await openStore({ now: WORLD_NOW, writer: false });
    try {
      const made = registration("five-fields", ["own", "employer:example"], {
        views: ["people"],
        tools: ["search", "get_entity"],
        vendorRetention: "retains",
        runtime: "cloud",
      });
      const { token } = await store.admin.clients.addClient(made);
      const recorded = recordingPool(store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });

      const view = await reader.client(token);
      // The agent API parses it strictly: these five and no other.
      expect(ClientView.safeParse(view).success).toBe(true);
      expect(Object.keys(view ?? {}).sort()).toEqual(["compartments", "id", "name", "tools", "views"]);
      const [row] = (await store.admin.clients.listClients()).filter((one) => one.name === "five-fields");
      expect(view).toEqual({
        id: row?.id,
        name: "five-fields",
        compartments: made.compartments,
        views: made.views,
        tools: made.tools,
      });

      // It reads current_client() and does not log.
      expect(recorded.statements.some((text) => /current_client\s*\(\s*\)/i.test(text))).toBe(true);
      expect(recorded.statements.filter((text) => NAMES_KNOWLEDGE.test(text) || /log_call/i.test(text))).toEqual([]);
      expect(await callLog(store.db.urls.admin)).toEqual([]);

      // No client for no token, an unknown token, or a revoked one.
      expect(await reader.client("")).toBeNull();
      expect(await reader.client(UNKNOWN_TOKEN)).toBeNull();
      expect(await store.admin.clients.revokeClient("five-fields")).toBe(true);
      expect(await reader.client(token)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("every logger event parses as PersonalLogEvent, and nothing is written to stdout", async () => {
    const store = await openStore({ now: WORLD_NOW, readerMax: 1 });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const blake = world.entityOf(WORLD.both.address);
      // A logger of this test's own, so the events are the reader's and the admin's alone.
      const log = eventLogger();
      const options = { keys: store.db.keys, log, now: () => store.now };
      const admin = new Admin({ pool: store.adminPool, ...options });
      const reader = new Reader({ pool: store.readerPool, ...options });
      // Two readers on the same one connection, each with a statement that is rejected as a
      // database error is: every statement naming knowledge, and the log_call.
      const noKnowledge = recordingPool(store.readerPool, { rejectWhen: (text) => NAMES_KNOWLEDGE.test(text) });
      const noLog = recordingPool(store.readerPool, { rejectWhen: (text) => /log_call\s*\(/i.test(text) });
      const blind = new Reader({ pool: noKnowledge.pool, ...options });
      const unlogged = new Reader({ pool: noLog.pool, ...options });

      let token = "";
      // Nothing may reach stdout, by its own write or through console, which Vitest takes over.
      const spies = [
        vi.spyOn(process.stdout, "write").mockImplementation(() => true),
        ...(["log", "info", "debug", "warn", "error"] as const).map((level) =>
          vi.spyOn(console, level).mockImplementation(() => {}),
        ),
      ];
      let written = 0;
      try {
        // The admin: what it does, and what it refuses.
        ({ token } = await admin.clients.addClient(registration("wide-client", ["own", "employer:example"])));
        const { token: narrow } = await admin.clients.addClient(
          registration("self-only", ["own"], { tools: ["get_self"] }),
        );
        expect(await refusedWith(() => admin.clients.addClient(registration("wide-client", ["own"])))).toEqual({
          name: "AdminError",
          code: "duplicate_name",
        });
        expect(
          await refusedWith(() => admin.clients.addClient(registration("no-views", ["own"], { views: [] }))),
        ).toEqual({
          name: "AdminError",
          code: "invalid_registration",
        });
        expect(await refusedWith(() => admin.accounts.addOwnerAddress("canary not an address", "own"))).toEqual({
          name: "AdminError",
          code: "invalid_address",
        });
        expect(
          (await refusedWith(() => admin.accounts.addOwnerAddress("owner.alias@example.com", "employer:nobody"))).code,
        ).toBe("unknown_compartment");
        await admin.accounts.addOwnerAddress("owner.alias@example.com", "own");
        await admin.secrets.setSecret("google/personal/refresh_token", "canary-refresh-token-rotated");
        expect(await admin.secrets.secret("google/personal/refresh_token")).toBe("canary-refresh-token-rotated");
        await admin.secrets.listSecretNames("google/");
        await admin.accounts.listSourceAccounts();
        await admin.clients.listClients();
        await admin.accounts.status();
        expect(await admin.accounts.inspect(WORLD.both.address)).not.toBeNull();
        expect(await admin.accounts.inspect("nobody@example.com")).toBeNull();

        // The reader: each tool's answer, and each refusal.
        expect((await reader.getSelf(token)).ok).toBe(true);
        expect((await reader.search(token, { query: "canary" })).ok).toBe(true);
        expect((await reader.getEntity(token, { id: blake })).ok).toBe(true);
        expect((await reader.getTimeline(token, { id: blake })).ok).toBe(true);
        expect((await reader.client(token))?.name).toBe("wide-client");
        expect(await reader.search(UNKNOWN_TOKEN, { query: "canary" })).toEqual(UNAUTHORIZED);
        expect(await reader.search(narrow, { query: "canary" })).toEqual({ ok: false, code: "not_permitted" });
        expect(await reader.search(token, { query: "canary", limit: 26 })).toEqual({
          ok: false,
          code: "invalid_request",
        });
        expect(await reader.getEntity(token, { id: MISSING_ENTITY })).toEqual({ ok: false, code: "not_found" });

        // A database error: the answer is `unavailable`, never a throw, never an SQLSTATE and
        // never data. No policy.calls row is written, one read_failed event is logged, and the
        // transaction is ended: the pool's one connection, asked again, shows no row, no token
        // and no transaction. (The rejected statement never reaches the server, so a call that
        // only gave up would leave its transaction open with the token set.)
        const { backend } = await leftOn(store.readerPool);
        const fails = async (name: string, call: () => Promise<unknown>): Promise<void> => {
          const before = await callLog(store.db.urls.admin);
          const events = log.events.length;
          expect(await call(), name).toEqual(UNAVAILABLE);
          expect(await leftOn(store.readerPool), name).toEqual({ backend, accounts: 0, token: "", idle: true });
          expect(await callLog(store.db.urls.admin), name).toEqual(before);
          const logged = log.events.slice(events).filter((event) => event.event === "read_failed");
          expect(logged, name).toHaveLength(1);
          expect(logged[0], name).toMatchObject({ event: "read_failed", code: "unavailable" });
        };

        // The read fails.
        await fails("get_self, no knowledge", () => blind.getSelf(token));
        await fails("search, no knowledge", () => blind.search(token, { query: "canary" }));
        await fails("get_entity, no knowledge", () => blind.getEntity(token, { id: blake }));
        await fails("get_timeline, no knowledge", () => blind.getTimeline(token, { id: blake }));
        expect(noKnowledge.statements.some((text) => NAMES_KNOWLEDGE.test(text))).toBe(true);

        // The log insert fails: a call that cannot write its policy.calls row answers nothing,
        // whether it would have answered or refused.
        await fails("get_self, no log", () => unlogged.getSelf(token));
        await fails("search, no log", () => unlogged.search(token, { query: "canary" }));
        await fails("get_entity, no log", () => unlogged.getEntity(token, { id: blake }));
        await fails("get_timeline, no log", () => unlogged.getTimeline(token, { id: blake }));
        await fails("not_found, no log", () => unlogged.getEntity(token, { id: MISSING_ENTITY }));
        await fails("invalid_request, no log", () => unlogged.search(token, { query: "canary", limit: 26 }));
        await fails("not_permitted, no log", () => unlogged.search(narrow, { query: "canary" }));
        expect(noLog.statements.filter((text) => /log_call\s*\(/i.test(text))).toHaveLength(7);
        // The positive control: what writes no row is not failed by it.
        expect(await unlogged.search(UNKNOWN_TOKEN, { query: "canary" })).toEqual(UNAUTHORIZED);
        expect((await unlogged.client(token))?.name).toBe("wide-client");

        // The pool has one connection: the failed calls gave it back, or this would never answer.
        const before = await callLog(store.db.urls.admin);
        expect((await reader.getSelf(token)).ok).toBe(true);
        expect(await callLog(store.db.urls.admin)).toHaveLength(before.length + 1);
      } finally {
        written = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
        for (const spy of spies) spy.mockRestore();
      }
      expect(written).toBe(0);

      // Every event is the contract's shape: ids, counts and codes, with no free text.
      expect(log.events.length).toBeGreaterThan(0);
      for (const event of log.events)
        expect(PersonalLogEvent.safeParse(event).success, JSON.stringify(event)).toBe(true);
      const text = JSON.stringify(log.events).toLowerCase();
      for (const needle of ["canary", "example.com", "example.org", "57p01", token.toLowerCase()])
        expect(text, needle).not.toContain(needle);
    } finally {
      await store.close();
    }
  });

  it("close ends the pool createReader made, and leaves a pool the caller passed", async () => {
    const db = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: db.urls.reader, max: 1 });
    let made: Reader | undefined;
    try {
      const log = eventLogger();
      // How many connections pi_reader holds to this database, once the server has caught up.
      const connections = async (wanted: (n: number) => boolean): Promise<number> => {
        let n = -1;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const rows = await queryAs<{ n: number }>(
            db.urls.bootstrap,
            "select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'pi_reader'",
            [db.name],
          );
          n = rows[0]?.n ?? -1;
          if (wanted(n)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return n;
      };

      // With `new`, the caller owns the pool: close() leaves it usable.
      const mine = new Reader({ pool, keys: db.keys, log });
      expect(await mine.client(UNKNOWN_TOKEN)).toBeNull();
      await mine.close();
      expect((await pool.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
      await pool.end();
      expect(await connections((n) => n === 0)).toBe(0);

      // The factory makes its own pool, and close() ends it.
      made = createReader({ url: db.urls.reader, keys: db.keys, log });
      expect(await made.client(UNKNOWN_TOKEN)).toBeNull();
      expect(await connections((n) => n > 0)).toBeGreaterThan(0);
      await made.close();
      made = undefined;
      expect(await connections((n) => n === 0)).toBe(0);
    } finally {
      await made?.close().catch(() => {});
      if (!pool.ended) await pool.end();
      await db.drop();
    }
  });
});
