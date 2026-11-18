import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { KeyFileRefused, type Keys } from "../core/keys.ts";
import { keys, log, thrown } from "../test-support/unit.ts";
import { createReader, Reader } from "./read.ts";

// The parts of the reader that need no database: what it does with a URL that does not parse,
// and how a call's signal cancels it (on a fake pool). Its database tests are in
// read*.db.test.ts.

describe("createReader", () => {
  it("a malformed URL is refused without its password", async () => {
    const secret = `canary-${randomBytes(6).toString("hex")}`;
    const malformed = [
      `postgres://pi_reader:${secret}@127.0.0.1:notaport/personal`,
      `postgres://pi_reader:${secret}@[::1/personal`,
      `pi_reader:${secret}@127.0.0.1/personal`,
      `http://pi_reader:${secret}@127.0.0.1:54329/personal`,
      `not a url ${secret}`,
      "",
    ];
    for (const url of malformed) {
      const error = thrown(() => createReader({ url, keys, log }));
      expect(error).toBeInstanceOf(Error);
      expect(error?.code).toBe("bad_url");
      // No part of the URL, in the message, the stack, or any property, shown or hidden.
      const shown = `${inspect(error, { depth: 8, showHidden: true })}\n${String(error?.stack)}\n${JSON.stringify(Object.getOwnPropertyDescriptors(error))}`;
      for (const part of [secret, "pi_reader", "127.0.0.1", "notaport", "not a url"]) expect(shown).not.toContain(part);
    }
    // The positive control: a well-formed URL makes a reader. Nothing connects until it is used.
    const reader = createReader({ url: `postgres://pi_reader:${secret}@127.0.0.1:54329/personal`, keys, log });
    await reader.close();
  });
});

// A pool that stands in for the server. The fake answers each statement, and a statement it holds
// fails as a cancelled one does (57014) once the cancel arrives on another connection.
const CLIENT_ROW = {
  id: `cli_${"0".repeat(26)}`,
  name: "scribe",
  compartments: ["own"],
  views: ["self"],
  tools: ["get_self"],
};
function fakePool(processID?: number, row: typeof CLIENT_ROW = CLIENT_ROW) {
  const statements: string[] = [];
  const cancels: unknown[][] = [];
  let release: ((error: Error) => void) | undefined;
  const client = {
    ...(processID === undefined ? {} : { processID }),
    on: () => {},
    removeListener: () => {},
    release: () => {},
    query: async (text: string) => {
      // The shared taint lock, taken before the transaction and given back after it.
      statements.push(
        /pg_advisory_lock_shared/.test(text)
          ? "TAKE"
          : /pg_advisory_unlock_shared/.test(text)
            ? "GIVE"
            : text.split(/\s+/).slice(0, 4).join(" "),
      );
      if (text.includes("pg_backend_pid")) return { rows: [{ pid: 42 }] };
      if (text.includes("current_client")) return { rows: [row] };
      if (text === "select pg_sleep(60)") return new Promise((_resolve, reject) => (release = reject));
      return { rows: [] };
    },
  };
  const pool = {
    connect: async () => client,
    query: async (text: string, values: unknown[]) => {
      cancels.push([text, ...values]);
      release?.(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
      return { rows: [{ pg_cancel_backend: true }] };
    },
  };
  return { pool: pool as unknown as pg.Pool, statements, cancels };
}

describe("Reader.withClient with a signal", () => {
  const reader = (pool: pg.Pool) => new Reader({ pool, keys, log });

  it("an abort during a statement cancels it on another connection and rolls back", async () => {
    const { pool, statements, cancels } = fakePool();
    const controller = new AbortController();
    const call = reader(pool).withClient(
      "pit_token",
      { isolation: "repeatable read", signal: controller.signal },
      async ({ run }) => {
        const held = run("select pg_sleep(60)", []);
        controller.abort();
        await held;
        return "done";
      },
    );
    await expect(call).rejects.toMatchObject({ name: "Unavailable" });
    expect(cancels).toEqual([["select pg_cancel_backend($1)", 42]]);
    expect(statements).toEqual([
      "TAKE",
      "BEGIN ISOLATION LEVEL REPEATABLE",
      "select pg_backend_pid() as pid",
      "select set_config('pi.client_token', case when",
      "select id, name, compartments,",
      "select pg_sleep(60)",
      "ROLLBACK",
      "GIVE",
    ]);
  });

  it("the driver's own record of the backend is used when it has one: no statement asks for it", async () => {
    const { pool, statements, cancels } = fakePool(77);
    const controller = new AbortController();
    const call = reader(pool).withClient(
      "pit_token",
      { isolation: "repeatable read", signal: controller.signal },
      async ({ run }) => {
        const held = run("select pg_sleep(60)", []);
        controller.abort();
        await held;
        return "done";
      },
    );
    await expect(call).rejects.toMatchObject({ name: "Unavailable" });
    expect(cancels).toEqual([["select pg_cancel_backend($1)", 77]]);
    expect(statements).toEqual([
      "TAKE",
      "BEGIN ISOLATION LEVEL REPEATABLE",
      "select set_config('pi.client_token', case when",
      "select id, name, compartments,",
      "select pg_sleep(60)",
      "ROLLBACK",
      "GIVE",
    ]);
  });

  it("an abort between statements refuses the next one, and one after the last rolls back", async () => {
    for (const late of [false, true]) {
      const { pool, statements, cancels } = fakePool();
      const controller = new AbortController();
      const call = reader(pool).withClient(
        "pit_token",
        { isolation: "read committed", signal: controller.signal },
        async ({ run }) => {
          controller.abort();
          if (!late) await run("select 2", []);
          return "done";
        },
      );
      await expect(call).rejects.toMatchObject({ name: "Unavailable" });
      expect(statements.slice(-2)).toEqual(["ROLLBACK", "GIVE"]);
      expect(statements).not.toContain("select 2");
      expect(statements).not.toContain("COMMIT");
      // Nothing was running: the cancel finds the backend idle, and is waited for.
      expect(cancels).toHaveLength(1);
    }
  });

  it("a signal aborted before the call sends nothing; with none, or one never aborted, it commits and no cancel is sent", async () => {
    const before = fakePool();
    await expect(
      reader(before.pool).withClient(
        "pit_token",
        { isolation: "read committed", signal: AbortSignal.abort() },
        async () => "done",
      ),
    ).rejects.toMatchObject({ name: "Unavailable" });
    expect(before.statements).toEqual([]);

    const none = fakePool();
    expect(await reader(none.pool).withClient("pit_token", { isolation: "read committed" }, async () => "done")).toBe(
      "done",
    );
    // Without a signal no backend is asked.
    expect(none.statements).toEqual([
      "TAKE",
      "BEGIN ISOLATION LEVEL READ",
      "select set_config('pi.client_token', case when",
      "select id, name, compartments,",
      "COMMIT",
      "GIVE",
    ]);

    const kept = fakePool();
    const controller = new AbortController();
    expect(
      await reader(kept.pool).withClient(
        "pit_token",
        { isolation: "read committed", signal: controller.signal },
        async () => "done",
      ),
    ).toBe("done");
    controller.abort();
    expect(kept.statements.slice(-2)).toEqual(["COMMIT", "GIVE"]);
    expect(kept.cancels).toEqual([]);
  });
});

// A long-running reader (`pi http`) is given its keys as a source asked before each call: a client
// given record after the process started records without a restart.
describe("Reader with keys read again", () => {
  const key = (fill: string) => Buffer.alloc(32, fill).toString("base64") as never;
  const SCRIBE = { ...CLIENT_ROW, compartments: ["own", "agent:scribe"] };

  it("each call is given the keys the source holds at that call", async () => {
    const { pool } = fakePool(undefined, SCRIBE);
    const held: Keys[] = [
      { compartments: new Map([["own", key("a")]]), fingerprintKey: Buffer.alloc(32) },
      {
        compartments: new Map([
          ["own", key("a")],
          ["agent:scribe", key("b")],
        ]),
        fingerprintKey: Buffer.alloc(32),
      },
    ];
    let asked = 0;
    const reader = new Reader({ pool, keys: async () => held[Math.min(asked++, 1)] as Keys, log });
    const compartmentsOfCall = () =>
      reader.withClient("pit_token", { isolation: "read committed" }, async ({ client, ctx }) => [
        ...ctx(client ?? (SCRIBE as never)).keys.compartments.keys(),
      ]);
    expect(await compartmentsOfCall()).toEqual(["own"]);
    expect(await compartmentsOfCall()).toEqual(["own", "agent:scribe"]);
    expect(asked).toBe(2);
  });

  it("a source that refuses answers unavailable, logs its code and sends nothing", async () => {
    const { pool, statements } = fakePool();
    const events: unknown[] = [];
    const logged: PersonalLogger = { info: () => {}, warn: () => {}, error: (event) => void events.push(event) };
    const reader = new Reader({ pool, keys: () => Promise.reject(new KeyFileRefused("mode")), log: logged });
    await expect(
      reader.withClient("pit_token", { isolation: "read committed" }, async () => "done"),
    ).rejects.toMatchObject({ name: "Unavailable" });
    expect(await reader.getSelf("pit_token")).toEqual({ ok: false, code: "unavailable" });
    expect(statements).toEqual([]);
    expect(events).toEqual([
      { event: "keys_reload_failed", code: "mode" },
      { event: "keys_reload_failed", code: "mode" },
      { event: "read_failed", code: "unavailable" },
    ]);

    // A call whose signal is aborted before it starts does not ask the source.
    let asked = 0;
    const counted = new Reader({
      pool,
      keys: async () => {
        asked += 1;
        return keys;
      },
      log,
    });
    await expect(
      counted.withClient("pit_token", { isolation: "read committed", signal: AbortSignal.abort() }, async () => "done"),
    ).rejects.toMatchObject({ name: "Unavailable" });
    expect(asked).toBe(0);

    // Any other failure is logged under one code, and nothing of the error is.
    const other = new Reader({ pool, keys: () => Promise.reject(new Error("EACCES: /secret/path")), log: logged });
    events.length = 0;
    expect(await other.getSelf("pit_token")).toEqual({ ok: false, code: "unavailable" });
    expect(events[0]).toEqual({ event: "keys_reload_failed", code: "unreadable" });
  });

  it("a push that cannot reach the store answers unavailable and logs read_failed, ids and codes only", async () => {
    const { pool, statements } = fakePool();
    const events: unknown[] = [];
    const logged: PersonalLogger = { info: () => {}, warn: () => {}, error: (event) => void events.push(event) };
    const reader = new Reader({ pool, keys: () => Promise.reject(new KeyFileRefused("mode")), log: logged });
    expect(await reader.pushCapture("pit_token", { batch: "unit-batch-0001", items: [] })).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(statements).toEqual([]);
    expect(events).toEqual([
      { event: "keys_reload_failed", code: "mode" },
      { event: "read_failed", code: "unavailable" },
    ]);
  });
});
