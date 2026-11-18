import type { RawItem, Timestamp } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { connect, OWNER, type Who } from "../../test-support/cast.ts";
import { one } from "../../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../../test-support/database.ts";
import {
  derive,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailRevision,
  mailSourceId,
  NOW,
} from "../../test-support/items.ts";
import { namesSealed, recordingLogger, recordingStatements } from "../../test-support/recording.ts";
import { withStore } from "../../test-support/store.ts";
import { evidenceIdOf } from "../../test-support/values.ts";
import type { Writer } from "../../write/writer.ts";
import type { IngestAnswer, SourceAccountRow } from "../../write/writer-types.ts";
import { type Admin, createAdmin } from "../admin.ts";

// Every message is seeded through the writer with hand-written facts; a held message is one whose
// facts say `held`.

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const DAY_MS = 24 * 60 * 60 * 1000;

const daysBefore = (days: number): Timestamp => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

// A message from Pippa in the inbox, held unless said otherwise.
const held = (id: string, over: Partial<MailFixture> = {}): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at: daysBefore(1),
    from: PIPPA,
    to: [ME],
    subject: `Your sign-in code ${id}`,
    labels: ["INBOX"],
    held: true,
    text: "Your code is 000000.",
    ...over,
  });

const ingest = (writer: Writer, account: SourceAccountRow, fixture: MailFixture): Promise<IngestAnswer> => {
  const raw: RawItem = mailItem(fixture, account);
  return writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

type Row = { id: string; held: boolean; sent_at: Date; evidence_id: string };

// The message row of a fixture, read as pi_admin, which sees held rows.
const rowOf = async (db: TestDatabase, account: SourceAccountRow, fixture: MailFixture): Promise<Row> =>
  one(
    await admin<Row>(
      db,
      `select m.id, m.held, m.sent_at, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
       where e.source_account_id = $1 and e.source_item_fp = $2`,
      [account.id, fingerprint(db.keys, "source_id", mailSourceId(fixture))],
    ),
  );

const releasedAt = async (db: TestDatabase, evidenceId: string): Promise<string | null> => {
  const row = one(
    await admin<{ at: Date | null }>(db, "select hold_released_at as at from vault.evidence_items where id = $1", [
      evidenceId,
    ]),
  );
  return row.at === null ? null : row.at.toISOString();
};

const heldIds = async (db: TestDatabase): Promise<string[]> =>
  (await admin<{ id: string }>(db, "select id from knowledge.messages where held order by id")).map((row) => row.id);

async function withAdmin<T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const { log } = recordingLogger();
  const made = createAdmin({ url: db.urls.admin, keys: db.keys, log, now: () => new Date(NOW) });
  try {
    return await fn(made);
  } finally {
    await made.close();
  }
}

describe("Admin: the hold on account-recovery mail", () => {
  it("heldMessages counts the held rows and lists the newest fifty by id and time", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, workMail } = await connect(writer);
      // 51 held messages, two of them at one time so the tie is ordered by id, one held under
      // the employer's compartment, and one that is not held.
      const fixtures = Array.from({ length: 50 }, (_, n) =>
        held(`gm-held-${String(n).padStart(2, "0")}`, {
          at: new Date(Date.parse(NOW) - (n + 1) * 60_000).toISOString(),
        }),
      );
      const tie = held("gm-held-tie", { at: fixtures[0]?.at ?? NOW });
      const work = held("gm-held-work", { at: daysBefore(30), to: [{ address: OWNER.work, name: OWNER.name }] });
      const free = held("gm-free", { held: false, at: NOW });
      for (const fixture of [...fixtures, tie, free])
        expect(await ingest(writer, personalMail, fixture)).toBe("stored");
      expect(await ingest(writer, workMail, work)).toBe("stored");

      const expected = (
        await admin<{ id: string; sent_at: Date }>(
          db,
          "select id, sent_at from knowledge.messages where held order by sent_at desc, id limit 50",
        )
      ).map((row) => ({
        id: row.id,
        at: row.sent_at.toISOString(),
        // Every one here is held by a marker rule: none has a model_hold_at.
        by: "markers",
      }));
      const { result, statements } = await recordingStatements(() => withAdmin(db, (one) => one.held.messages()));

      expect(result.held).toBe(52);
      expect(result.messages).toEqual(expected);
      expect(result.messages).toHaveLength(50);
      // Newest first, the tie by id, the oldest two left out, the one not held never listed.
      const freeId = (await rowOf(db, personalMail, free)).id;
      const tied = [
        (await rowOf(db, personalMail, fixtures[0] as MailFixture)).id,
        (await rowOf(db, personalMail, tie)).id,
      ].sort();
      expect(result.messages.slice(0, 2).map((row) => row.id)).toEqual(tied);
      expect(result.messages.map((row) => row.id)).not.toContain(freeId);
      expect(result.messages.map((row) => row.id)).not.toContain((await rowOf(db, workMail, work)).id);
      expect(result.messages.map((row) => row.id)).not.toContain(
        (await rowOf(db, personalMail, fixtures[49] as MailFixture)).id,
      );

      // It opens nothing: no statement it sends names a sealed column.
      const sent = statements.filter((statement) => /knowledge\.messages/i.test(statement.text));
      expect(sent.length).toBeGreaterThan(0);
      for (const statement of statements) expect(namesSealed(statement.text), statement.text).toBe(false);
    }));

  it("releaseHeld by id releases that message, and an unknown id, the id of a message that is not held and a malformed id are not_found", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const first = held("gm-release-first");
      const second = held("gm-release-second");
      const free = held("gm-release-free", { held: false });
      for (const fixture of [first, second, free]) expect(await ingest(writer, personalMail, fixture)).toBe("stored");
      const firstId = (await rowOf(db, personalMail, first)).id;
      const secondId = (await rowOf(db, personalMail, second)).id;
      const freeId = (await rowOf(db, personalMail, free)).id;

      await withAdmin(db, async (one) => {
        // The positive control: the held message is released, and only it.
        expect(await one.held.releaseHeld({ id: firstId })).toEqual({ released: 1 });
        expect(await heldIds(db)).toEqual([secondId]);

        const notFound = { name: "AdminError", code: "not_found" };
        // Released already, never held, unknown, and no MessageId at all.
        for (const id of [
          firstId,
          freeId,
          "msg_01J0000000000000000000ZZZZ",
          "msg_",
          "evt_01J0000000000000000000ZZZZ",
          "",
          secondId.toLowerCase(),
        ]) {
          await expect(one.held.releaseHeld({ id }), id).rejects.toMatchObject(notFound);
        }
        expect(await heldIds(db)).toEqual([secondId]);
      });
    }));

  it("releaseHeld by age releases only the messages older than that, and a value that is no positive integer is invalid_argument", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const old = held("gm-age-old", { at: daysBefore(40) });
      const older = held("gm-age-older", { at: daysBefore(10) });
      const boundary = held("gm-age-boundary", { at: daysBefore(7) });
      const recent = held("gm-age-recent", { at: daysBefore(2) });
      const free = held("gm-age-free", { held: false, at: daysBefore(60) });
      for (const fixture of [old, older, boundary, recent, free])
        expect(await ingest(writer, personalMail, fixture)).toBe("stored");
      const ids = async (...fixtures: MailFixture[]) =>
        (await Promise.all(fixtures.map((fixture) => rowOf(db, personalMail, fixture)))).map((row) => row.id).sort();

      await withAdmin(db, async (one) => {
        const invalid = { name: "AdminError", code: "invalid_argument" };
        // 1e9 days is a safe integer whose date is outside the range a Date holds; 750 000 and
        // 1 000 000 days are inside it, but before year 1, which the database cannot take.
        for (const days of [
          0,
          -1,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          "7" as unknown as number,
          750_000,
          1_000_000,
          1e9,
          Number.MAX_SAFE_INTEGER,
        ]) {
          await expect(one.held.releaseHeld({ olderThanDays: days }), String(days)).rejects.toMatchObject(invalid);
        }
        expect(await heldIds(db)).toEqual(await ids(old, older, boundary, recent));

        // Exactly seven days before now is not more than seven.
        expect(await one.held.releaseHeld({ olderThanDays: 7 })).toEqual({ released: 2 });
        expect(await heldIds(db)).toEqual(await ids(boundary, recent));
        // None older: nothing released, and no refusal.
        expect(await one.held.releaseHeld({ olderThanDays: 365 })).toEqual({ released: 0 });
        expect(await one.held.releaseHeld({ olderThanDays: 1 })).toEqual({ released: 2 });
        expect(await heldIds(db)).toEqual([]);
      });
    }));

  it("a release sets the evidence row's time and the message row's mark in one transaction", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const first = held("gm-tx-first", { at: daysBefore(20) });
      // A second revision after a label change: the latest revision's row takes the time.
      const moved = mail({ ...first, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" });
      const second = held("gm-tx-second", { at: daysBefore(20) });
      for (const fixture of [first, moved, second]) expect(await ingest(writer, personalMail, fixture)).toBe("stored");
      const latest = evidenceIdOf(personalMail, mailSourceId(first), 1);
      expect((await rowOf(db, personalMail, first)).evidence_id).toBe(latest);
      expect(await releasedAt(db, latest)).toBeNull();

      const { statements } = await recordingStatements(() =>
        withAdmin(db, (one) => one.held.releaseHeld({ olderThanDays: 10 })),
      );

      expect((await rowOf(db, personalMail, first)).held).toBe(false);
      expect((await rowOf(db, personalMail, second)).held).toBe(false);
      expect(await releasedAt(db, latest)).toBe(new Date(NOW).toISOString());
      expect(await releasedAt(db, evidenceIdOf(personalMail, mailSourceId(first), 0))).toBeNull();
      expect(await releasedAt(db, evidenceIdOf(personalMail, mailSourceId(second), 0))).toBe(
        new Date(NOW).toISOString(),
      );

      // Each message's two updates are in one transaction, with no commit between them, and
      // each message has a transaction of its own.
      const texts = statements.map((statement) => statement.text.trim().toLowerCase());
      const evidence = texts.flatMap((text, at) => (text.startsWith("update vault.evidence_items") ? [at] : []));
      const messages = texts.flatMap((text, at) => (text.startsWith("update knowledge.messages") ? [at] : []));
      expect(evidence).toHaveLength(2);
      expect(messages).toHaveLength(2);
      for (const [n, at] of evidence.entries()) {
        const mark = messages[n] ?? -1;
        const [from, to] = [Math.min(at, mark), Math.max(at, mark)];
        // The admin's transactions begin read committed, set explicitly.
        const begin = texts.slice(0, from).findLastIndex((text) => text.startsWith("begin"));
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(
          texts.slice(begin + 1, to).some((text) => text === "commit" || text.startsWith("begin")),
          "one transaction",
        ).toBe(false);
        expect(texts.slice(to).indexOf("commit")).toBeGreaterThan(0);
      }
      const between = texts.slice(
        Math.max(evidence[0] ?? 0, messages[0] ?? 0),
        Math.min(evidence[1] ?? 0, messages[1] ?? 0),
      );
      expect(between, "a transaction for each message").toContain("commit");
    }));

  it("a release while a sync ingests a new revision of the message is not lost", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const first = held("gm-race");
      expect(await ingest(writer, personalMail, first)).toBe("stored");
      const { id } = await rowOf(db, personalMail, first);
      // The next revision of the same message, still held by its facts.
      const raw = mailRevision(first, personalMail);

      // The writer's transaction stops once it has read the revision it supersedes, and its
      // facts are asked for, until the release has run or is waiting on a lock.
      let hasRead: () => void = () => undefined;
      const read = new Promise<void>((resolve) => (hasRead = resolve));
      let go: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (go = resolve));
      const ingesting = writer.ingestItem(personalMail, raw, async (ctx) => {
        hasRead();
        await gate;
        return mailFacts(first)(ctx);
      });
      try {
        await read;
        await withAdmin(db, async (owner) => {
          let settled = false;
          const releasing = owner.held.releaseHeld({ id }).finally(() => (settled = true));
          const waiting = async () =>
            one(
              await admin<{ waiting: boolean }>(
                db,
                `select exists (select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
                              where not l.granted and a.datname = current_database()) as waiting`,
              ),
            ).waiting;
          while (!settled && !(await waiting())) await new Promise((resolve) => setTimeout(resolve, 10));
          go();
          expect(await ingesting).toBe("stored");
          expect(await releasing).toEqual({ released: 1 });
        });
      } finally {
        go();
      }

      // The message is released, and the release is on its newest revision.
      const latest = evidenceIdOf(personalMail, mailSourceId(first), 1);
      const row = await rowOf(db, personalMail, first);
      expect(row.evidence_id).toBe(latest);
      expect(row.held).toBe(false);
      expect(await releasedAt(db, latest)).toBe(new Date(NOW).toISOString());
      expect(await heldIds(db)).toEqual([]);
    }));
});
