import { inspect } from "node:util";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withDatabase } from "../test-support/store.ts";
import { Admin } from "./admin.ts";
import { googleSecretName } from "./admin-base.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The implementer's own database tests of the admin: a connection lost in the
// middle of a call, and what a database error carries. The blind tests are in admin.db.test.ts.

// Everything an error holds, shown or hidden, at any depth: its message, its stack, its cause.
const shown = (error: unknown): string =>
  `${inspect(error, { depth: 8, showHidden: true })}\n${String((error as Error).stack)}\n${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}\n${inspect((error as Error).cause, { depth: 8, showHidden: true })}`;

const rejection = async (run: () => Promise<unknown>): Promise<Error & { code?: string; cause?: unknown }> => {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("the call did not fail");
};

describe("Admin", () => {
  it("an admin error carries no value", async () => {
    await withDatabase(async (db) => {
      const { log, calls } = recordingLogger();
      const pool = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
      try {
        // A name the server refuses as text (SQLSTATE 22021).
        const canary = "canary-9f3b-name";
        const named = await rejection(() =>
          new Admin({ pool, keys: db.keys, log }).secrets.setSecret(`${canary}\0tail`, "canary-9f3b-value"),
        );
        expect(named.code).toBe("unavailable");
        expect(named.cause).toEqual({ sqlstate: "22021", constraint: undefined });
        expect(shown(named)).not.toContain("canary-9f3b");

        // A time the server refuses, which its message quotes in full (a class 22 SQLSTATE).
        const far = new Admin({ pool, keys: db.keys, log, now: () => new Date(8.64e15) });
        const timed = await rejection(() =>
          far.secrets.setSecret(googleSecretName("personal", "client"), "canary-9f3b-value"),
        );
        expect(timed.code).toBe("unavailable");
        expect((timed.cause as { sqlstate?: string }).sqlstate).toMatch(/^22\d{3}$/);
        expect(Object.keys(timed.cause as object).sort()).toEqual(["constraint", "sqlstate"]);
        expect(shown(timed)).not.toContain("275760");
        expect(shown(timed)).not.toContain("canary-9f3b");

        // The driver's own error for that statement does quote the value: the check above is not vacuous.
        const driver = await rejection(() => pool.query("select $1::timestamptz", [new Date(8.64e15).toISOString()]));
        expect(shown(driver)).toContain("275760");

        // A constraint's name is kept: it is a name in the schema, never a value.
        const refused = {
          connect: async () => ({
            query: () =>
              Promise.reject(
                Object.assign(new Error("Key (name)=(canary-9f3b) already exists."), {
                  code: "23505",
                  constraint: "clients_name_key",
                  detail: "canary-9f3b",
                }),
              ),
            release: () => {},
          }),
        };
        const broken = await rejection(() =>
          new Admin({ pool: refused as unknown as pg.Pool, keys: db.keys, log }).clients.listClients(),
        );
        expect(broken.cause).toEqual({ sqlstate: "23505", constraint: "clients_name_key" });
        expect(shown(broken)).not.toContain("canary-9f3b");

        expect(calls.map((one) => one.event)).toEqual(
          Array.from({ length: 3 }, () => ({ event: "admin_failed", code: "unavailable" })),
        );
        // The positive control: the same call with a name and a time the server takes.
        const admin = new Admin({ pool, keys: db.keys, log });
        await admin.secrets.setSecret(googleSecretName("personal", "client"), "canary-9f3b-value");
        expect(await admin.secrets.secret(googleSecretName("personal", "client"))).toBe("canary-9f3b-value");
      } finally {
        await pool.end();
      }
    });
  });

  it("a connection lost in the middle of a call is unavailable, and nothing is uncaught", async () => {
    await withDatabase(async (db) => {
      const { log, calls } = recordingLogger();
      const pool = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown): void => void uncaught.push(error);
      process.on("uncaughtException", onUncaught);
      try {
        // The server ends the admin's own connection just before its first statement on a table.
        let ended = 0;
        const lost = {
          async connect() {
            const client = await pool.connect();
            const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid ?? 0;
            return {
              async query(text: string, values: unknown[]) {
                if (text.includes("policy.clients") && ended === 0) {
                  ended += 1;
                  expect(await queryAs(db.urls.admin, "select pg_terminate_backend($1) as ended", [pid])).toEqual([
                    { ended: true },
                  ]);
                }
                return client.query(text, values);
              },
              release: (destroy?: boolean) => client.release(destroy),
              on: (event: "error", listener: (error: Error) => void) => client.on(event, listener),
              removeListener: (event: "error", listener: (error: Error) => void) =>
                client.removeListener(event, listener),
            };
          },
        };
        const admin = new Admin({ pool: lost as unknown as pg.Pool, keys: db.keys, log });

        await expect(admin.clients.listClients()).rejects.toMatchObject({ code: "unavailable" });
        expect(ended).toBe(1);
        // Whatever the lost connection still has to say arrives before this.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(calls.map((one) => one.event)).toEqual([{ event: "admin_failed", code: "unavailable" }]);

        // The positive control: the next call takes a new connection and answers.
        expect(await admin.clients.listClients()).toEqual([]);
        expect(uncaught).toEqual([]);
      } finally {
        process.removeListener("uncaughtException", onUncaught);
        await pool.end();
      }
    });
  });
});
