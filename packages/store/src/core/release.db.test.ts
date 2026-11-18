import type { RawItem, Timestamp } from "@intelligence/contracts";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { connect, OWNER, type Who } from "../test-support/cast.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { derive, type MailFixture, mail, mailItem, NOW } from "../test-support/items.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { withStore } from "../test-support/store.ts";
import type { Writer } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

const TIMEOUT = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };

const daysBefore = (days: number): Timestamp => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const held = (id: string, days: number): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at: daysBefore(days),
    from: PIPPA,
    to: [ME],
    subject: `Your sign-in code ${id}`,
    labels: ["INBOX"],
    held: true,
    text: "Your code is 000000.",
  });

async function ingest(writer: Writer, account: SourceAccountRow, fixture: MailFixture): Promise<void> {
  const raw: RawItem = mailItem(fixture, account);
  await writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));
}

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const heldIds = async (db: TestDatabase): Promise<string[]> =>
  (await admin<{ id: string }>(db, "select id from knowledge.messages where held order by id")).map((row) => row.id);
const decisions = (db: TestDatabase) =>
  admin<{
    kind: string;
    target_kind: string;
    target_id: string;
    batch: boolean;
    answer: string | null;
    card_id: string | null;
    compartments: string[];
    request_id: string;
  }>(
    db,
    "select kind, target_kind, target_id, batch, answer, card_id, compartments, request_id from knowledge.owner_decisions order by target_id",
  );

// An admin on a pool of the test's own. `failOn` makes the first statement whose text holds it
// fail, as the database would.
async function withAdmin<T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>, failOn?: string): Promise<T> {
  const { default: pgModule } = await import("pg");
  const pool = new pgModule.Pool({ connectionString: db.urls.admin, max: 2 });
  const wrapped = failOn === undefined ? pool : failing(pool, failOn);
  const { log } = recordingLogger();
  try {
    return await fn(new Admin({ pool: wrapped, keys: db.keys, log, now: () => new Date(NOW) }));
  } finally {
    await pool.end();
  }
}

function failing(pool: pg.Pool, text: string): pg.Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (statement: string, values?: unknown[]) =>
          statement.includes(text)
            ? Promise.reject(Object.assign(new Error("injected"), { code: "XX000" }))
            : client.query(statement, values),
        release: (destroy?: boolean) => client.release(destroy),
      };
    },
  } as unknown as pg.Pool;
}

describe("a release is an owner decision", { timeout: TIMEOUT }, () => {
  it("releasing one held message writes one release decision with the message as its target", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      await ingest(writer, personalMail, held("release-one", 1));
      const [id] = await heldIds(db);
      expect(await withAdmin(db, (one) => one.held.releaseHeld({ id: id ?? "" }))).toEqual({ released: 1 });
      expect(await decisions(db)).toEqual([
        {
          kind: "release",
          target_kind: "message",
          target_id: id,
          batch: false,
          answer: null,
          card_id: null,
          compartments: ["own"],
          request_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
        },
      ]);
    }));

  it("releasing by age writes one decision for each message, each marked batch", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      for (const [name, days] of [
        ["age-a", 20],
        ["age-b", 15],
        ["age-new", 1],
      ] as const)
        await ingest(writer, personalMail, held(name, days));
      const before = await heldIds(db);
      expect(await withAdmin(db, (one) => one.held.releaseHeld({ olderThanDays: 10 }))).toEqual({ released: 2 });
      const left = await heldIds(db);
      const released = before.filter((id) => !left.includes(id)).sort();
      const rows = await decisions(db);
      expect(rows.map((row) => row.target_id)).toEqual(released);
      expect(rows.every((row) => row.kind === "release" && row.batch)).toBe(true);
      expect(new Set(rows.map((row) => row.request_id)).size).toBe(2);
    }));

  it("a release that releases nothing writes no decision", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      await ingest(writer, personalMail, held("release-recent", 1));
      expect(await withAdmin(db, (one) => one.held.releaseHeld({ olderThanDays: 10 }))).toEqual({ released: 0 });
      await expect(
        withAdmin(db, (one) => one.held.releaseHeld({ id: "msg_00000000000000000000000000" })),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await decisions(db)).toEqual([]);
    }));

  it("the release decision and the release commit together: a failing statement after the release leaves neither", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      await ingest(writer, personalMail, held("release-fails", 1));
      const [id] = await heldIds(db);
      await expect(
        withAdmin(db, (one) => one.held.releaseHeld({ id: id ?? "" }), "insert into knowledge.owner_decisions"),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await heldIds(db)).toEqual([id]);
      expect(await admin(db, "select hold_released_at from vault.evidence_items")).toEqual([
        { hold_released_at: null },
      ]);
      expect(await decisions(db)).toEqual([]);
      // The positive control: the same release with nothing failing commits both.
      expect(await withAdmin(db, (one) => one.held.releaseHeld({ id: id ?? "" }))).toEqual({ released: 1 });
      expect((await decisions(db)).map((row) => row.target_id)).toEqual([id]);
    }));
});
