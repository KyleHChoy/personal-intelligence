import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import { createWriter, journalPath } from "@intelligence/personal-store";
import { createTestDatabase, dropDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../commands.ts";
import { runSync } from "../intake/sync.ts";
import { RESTORE_DATABASE, restoreCheck } from "./restore-check.ts";

// Invariant 10 on the restore test: a copy of the store taken before an erasure, as a dump is, is
// checked by `pi restore check`, which applies the erasure to the copy and leaves the live store, its
// journal and its key file as they were. Synthetic world only.

const TIMEOUT = 240_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

let db: TestDatabase;
let folder = "";
let keyFile = "";
let copy = "";

const capture = (into: Buffer[]) =>
  new Writable({
    write(chunk: Buffer, _encoding, done) {
      into.push(chunk);
      done();
    },
  });

function context(env: Record<string, string>) {
  const out: Buffer[] = [];
  const log: { event: string; code?: string }[] = [];
  return {
    out,
    ctx: {
      env,
      log: {
        info: () => {},
        warn: () => {},
        error: (event: { event: string; code?: string }) => void log.push(event),
      },
      io: { stdout: capture(out), stderr: capture([]), stdin: Readable.from([]), stdoutIsTTY: false },
    } as unknown as Parameters<typeof restoreCheck>[0],
  };
}

const admin = () => ({ PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile, PI_RECORD_ENABLED: "1" });

async function owner(argv: string[]): Promise<{ exit: number; stdout: string }> {
  const out: Buffer[] = [];
  const exit = await run(argv, admin(), {
    stdout: capture(out),
    stderr: capture([]),
    stdin: Readable.from([]),
    stdoutIsTTY: false,
  });
  return { exit, stdout: Buffer.concat(out).toString("utf8") };
}

const at = (url: string, name: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

// One message's id on the store at `url`.
const firstMessage = async (url: string): Promise<{ id: string; evidence_id: string }> => {
  const [row] = await queryAs<{ id: string; evidence_id: string }>(
    url,
    "select id, evidence_id from knowledge.messages order by id limit 1",
  );
  if (row === undefined) throw new Error("no message");
  return row;
};

const rowsOf = async (url: string, id: string): Promise<number> =>
  (await queryAs<{ n: number }>(url, "select count(*)::int as n from knowledge.messages where id = $1", [id]))[0]?.n ??
  0;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "pi-restore-test-"));
  keyFile = join(folder, "keys.json");
  const init = { PI_KEY_FILE: keyFile };
  const made = await run(["keys", "init", "--compartments", "own,employer:example"], init, {
    stdout: capture([]),
    stderr: capture([]),
    stdin: Readable.from([]),
    stdoutIsTTY: false,
  });
  expect(made).toBe(0);
  db = await createTestDatabase({ keyFile });
  const quiet = { info() {}, warn() {}, error() {} };
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  try {
    await runSync({ writer, sources: fakeSources(world({ now: NOW })), log: quiet, now: NOW, backfillDays: 90 });
  } finally {
    await writer.close();
  }
  expect((await owner(["erase", "replay"])).exit).toBe(0);
  // Its name begins with the restored database's, as the check requires, and is this file's own.
  copy = `${RESTORE_DATABASE}_${db.name.replace(/[^a-z0-9_]/g, "_")}`.slice(0, 60);
  const server = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
  await queryAs(server, `create database ${pg.escapeIdentifier(copy)} template ${pg.escapeIdentifier(db.name)}`);
}, TIMEOUT);

afterAll(async () => {
  const server = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
  await queryAs(server, `drop database if exists ${pg.escapeIdentifier(copy)} with (force)`).catch(() => {});
  await db.drop();
  await rm(folder, { recursive: true, force: true });
}, TIMEOUT);

describe("pi restore check", () => {
  it(
    "a dump older than the newest migration is its own code and raises no card",
    async () => {
      const server = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
      const older = `${copy}_o`.slice(0, 60);
      await queryAs(server, `create database ${pg.escapeIdentifier(older)} template ${pg.escapeIdentifier(db.name)}`);
      try {
        await queryAs(
          at(db.urls.bootstrap, older),
          // Aged by naming its newest migration below every real one, so a store made from one
          // migration is behind too.
          "set role pi_owner; update policy.migrations set name = '0000' where name = (select max(name) from policy.migrations)",
        );
        const cards = "select count(*)::int as n from ledger.cards where kind = 'box_health'";
        const [before] = await queryAs<{ n: number }>(db.urls.admin, cards);
        const { ctx, out } = context(admin());
        await restoreCheck(ctx, older);
        expect(JSON.parse(Buffer.concat(out).toString("utf8"))).toMatchObject({ code: "schema_behind" });
        expect(
          await queryAs<{ code: string }>(
            db.urls.admin,
            "select code from ledger.job_runs where job = 'restore_drill' order by id desc limit 1",
          ),
        ).toEqual([{ code: "schema_behind" }]);
        expect((await queryAs<{ n: number }>(db.urls.admin, cards))[0]).toEqual(before);
      } finally {
        await dropDatabase(older);
      }
    },
    TIMEOUT,
  );

  it(
    "a copy that answers and holds no store is a test that failed, with a card, not a test that did not run",
    async () => {
      const server = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
      const empty = `${copy}_e`.slice(0, 60);
      await queryAs(server, `create database ${pg.escapeIdentifier(empty)}`);
      try {
        const { ctx, out } = context(admin());
        await restoreCheck(ctx, empty);
        expect(JSON.parse(Buffer.concat(out).toString("utf8"))).toMatchObject({ code: "failed" });
        expect(
          await queryAs<{ code: string }>(
            db.urls.admin,
            "select code from ledger.job_runs where job = 'restore_drill' order by id desc limit 1",
          ),
        ).toEqual([{ code: "failed" }]);
      } finally {
        await dropDatabase(empty);
      }
    },
    TIMEOUT,
  );

  it(
    "invariant 10: an erasure after the dump is applied to the restored copy, and nothing of the live store changes",
    async () => {
      const copyUrl = at(db.urls.admin, copy);
      const item = await firstMessage(db.urls.admin);
      expect(await rowsOf(copyUrl, item.id)).toBe(1);
      expect((await owner(["erase", "item", item.id])).exit).toBe(0);
      expect(await rowsOf(db.urls.admin, item.id)).toBe(0);
      // The copy, like a dump, still holds what was erased after it was taken.
      expect(await rowsOf(copyUrl, item.id)).toBe(1);
      const journal = await readFile(journalPath(keyFile), "utf8");
      const seenRuns = async () =>
        queryAs<{ code: string }>(
          db.urls.admin,
          "select code from ledger.job_runs where job = 'restore_drill' order by id",
        );

      const { ctx, out } = context(admin());
      await restoreCheck(ctx, copy);
      const result = JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, unknown>;
      expect(result).toMatchObject({ code: "ok", before: "behind", after: "level", applied: 1, survivors: 0 });

      expect(await rowsOf(copyUrl, item.id)).toBe(0);
      expect((await seenRuns()).at(-1)).toEqual({ code: "ok" });
      // The live journal is byte for byte what it was, and the copy of it is gone.
      expect(await readFile(journalPath(keyFile), "utf8")).toBe(journal);
      await expect(stat(`${journalPath(keyFile)}.restore-test`)).rejects.toThrow();
      // Asked again: nothing to apply, and it still holds.
      const again = context(admin());
      await restoreCheck(again.ctx, copy);
      expect(JSON.parse(Buffer.concat(again.out).toString("utf8"))).toMatchObject({
        code: "ok",
        before: "level",
        applied: 0,
      });
    },
    TIMEOUT,
  );

  it(
    "with no journal yet, the check still gives its answer: a store that never erased anything has none",
    async () => {
      const journal = journalPath(keyFile);
      const kept = await readFile(journal);
      await rm(journal);
      const server = db.urls.bootstrap.replace(new RegExp(`/${db.name}$`), "/postgres");
      const fresh = `${copy}_j`.slice(0, 60);
      await queryAs(server, `create database ${pg.escapeIdentifier(fresh)}`);
      try {
        const { ctx, out } = context(admin());
        await restoreCheck(ctx, fresh);
        expect(JSON.parse(Buffer.concat(out).toString("utf8"))).toMatchObject({ code: "failed" });
      } finally {
        await writeFile(journal, kept, { mode: 0o600 });
        await dropDatabase(fresh);
      }
    },
    TIMEOUT,
  );

  it(
    "refuses any database but a restored copy, the live store first of all, and records nothing",
    async () => {
      const before = await queryAs<{ n: number }>(
        db.urls.admin,
        "select count(*)::int as n from ledger.job_runs where job in ('backup', 'restore_drill')",
      );
      const { ctx } = context(admin());
      await expect(restoreCheck(ctx, db.name)).rejects.toMatchObject({ code: "not_restore_database" });
      await expect(restoreCheck(ctx, `${RESTORE_DATABASE}_absent`)).rejects.toThrow();
      expect(
        await queryAs<{ n: number }>(
          db.urls.admin,
          "select count(*)::int as n from ledger.job_runs where job in ('backup', 'restore_drill')",
        ),
      ).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "a restored copy with what an erasure removed still in it fails, and says so on the live store",
    async () => {
      const copyUrl = at(db.urls.admin, copy);
      const { id, evidence_id } = await firstMessage(copyUrl);
      await queryAs(
        copyUrl,
        `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
         select 'rme_01HZZZZZZZZZZZZZZZZZZZZZZZ', erasure_id, source_account_id, repeat('c', 64), array[$1], reason, removed_at, compartments
         from knowledge.removed_evidence where reason = 'owner_erasure' limit 1`,
        [evidence_id],
      );
      expect(await rowsOf(copyUrl, id)).toBe(1);
      const { ctx, out } = context(admin());
      await restoreCheck(ctx, copy);
      expect(JSON.parse(Buffer.concat(out).toString("utf8"))).toMatchObject({ code: "erased_came_back", survivors: 1 });
      const [last] = await queryAs<{ code: string }>(
        db.urls.admin,
        "select code from ledger.job_runs where job = 'restore_drill' order by id desc limit 1",
      );
      expect(last).toEqual({ code: "failed" });
      expect(
        await queryAs<{ case_key: string }>(
          db.urls.admin,
          `select c.case_key from ledger.cards c where c.kind = 'box_health' and c.case_key = 'box:failure_streak:restore_drill'
             and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) = 'pending'`,
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );
});
