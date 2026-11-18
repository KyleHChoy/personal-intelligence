import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCursor, type SourceDeletion } from "@intelligence/contracts";
import type { ErasureJournalEntry } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { appendJournal, ensureJournal } from "../core/journal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createReader } from "../read/read.ts";
import { type Accounts, CANARY_PERSON, connect, QUENTIN, RHEA, SOLO } from "../test-support/cast.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { type Store, withStore } from "../test-support/store.ts";
import { createWriter } from "./writer.ts";

// The writer's two checks for an erasure, and the erasure level. The erasure's rows are written
// here in SQL as pi_admin, as an erasure leaves them; the erasure itself is tested elsewhere.

const TIMEOUT = 180_000;
const AT = "2026-09-20T00:00:00Z";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;

// An erasure row at a journal sequence number, with its decision.
async function erasureRow(db: TestDatabase, seq: number): Promise<string> {
  const ruling = testId("rul");
  await admin(
    db,
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')`,
    [ruling, testId("req"), AT],
  );
  const erasure = testId("ers");
  await admin(
    db,
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', $3, $4, 0, 0, 0, '{own}')`,
    [erasure, ruling, seq, AT],
  );
  return erasure;
}

// The removed-evidence row an erasure writes for a source item.
async function removed(db: TestDatabase, accounts: Accounts, fixture: MailFixture): Promise<void> {
  const erasure = await erasureRow(db, 1);
  await admin(
    db,
    `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
     values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, '{own}')`,
    [testId("rme"), erasure, accounts.personalMail.id, fingerprint(db.keys, "source_id", mailSourceId(fixture)), AT],
  );
}

// The suppression an erasure of a person writes for an address.
async function suppressed(db: TestDatabase, address: string): Promise<void> {
  const erasure = await erasureRow(db, 1);
  await admin(
    db,
    `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')`,
    [testId("sup"), erasure, fingerprint(db.keys, "address", address), AT],
  );
}

const deletion = (accounts: Accounts, fixture: MailFixture): SourceDeletion =>
  ({ sourceAccount: accounts.personalMail.id, sourceItemId: mailSourceId(fixture) }) as SourceDeletion;
const stored = (store: Store, accounts: Accounts, fixture: MailFixture): Promise<number> =>
  count(store.db, "vault.evidence_items", "source_account_id = $1 and source_item_fp = $2", [
    accounts.personalMail.id,
    fingerprint(store.db.keys, "source_id", mailSourceId(fixture)),
  ]);
const accountsOf = (db: TestDatabase, address: string): Promise<number> =>
  count(db, "knowledge.accounts", "value_fp = $1", [fingerprint(db.keys, "address", address)]);

describe("the writer and an erasure", { timeout: TIMEOUT }, () => {
  it("an erased source item is not stored again, under its old revision or a new one, and its page still reconciles", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("stored");
      // What the erasure leaves: the item gone, and its removed-evidence row.
      await store.writer.applyDeletion(accounts.personalMail, deletion(accounts, MAIL.solo));
      await removed(store.db, accounts, MAIL.solo);

      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("removed");
      expect(
        await store.writer.ingestItem(
          accounts.personalMail,
          mailRevision(MAIL.soloAgain, accounts.personalMail),
          mailFacts(MAIL.soloAgain),
        ),
      ).toBe("removed");
      expect(await stored(store, accounts, MAIL.solo)).toBe(0);
      expect(await accountsOf(store.db, SOLO.address)).toBe(0);
      // The positive control: another message of the same account is stored.
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.fromQuentin)).toBe("stored");

      // A full listing that names the erased item reconciles, and stores nothing of it.
      const page = await store.writer.finishPage(accounts.personalMail, {
        listing: { first: true, ended: "complete" },
        listedIds: [mailSourceId(MAIL.solo), mailSourceId(MAIL.fromQuentin)],
        skippedIds: [],
        next: ConnectorCursor.parse("cursor-erasure-1"),
      });
      expect(page).toEqual({ removed: 0, reconciled: true, recordsRemoved: 0 });
      expect(await stored(store, accounts, MAIL.solo)).toBe(0);
      expect(await stored(store, accounts, MAIL.fromQuentin)).toBe(1);
    }));

  it("a message deleted at the source and then handed over again is stored again, and writes no removed-evidence row in between", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      await ingestMail(store.writer, accounts.personalMail, MAIL.solo);
      await store.writer.applyDeletion(accounts.personalMail, deletion(accounts, MAIL.solo));
      expect(await stored(store, accounts, MAIL.solo)).toBe(0);
      expect(await count(store.db, "knowledge.removed_evidence")).toBe(0);
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("stored");
      expect(await stored(store, accounts, MAIL.solo)).toBe(1);
    }));

  it("a message that became junk and then stopped being junk is stored again", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      await ingestMail(store.writer, accounts.personalMail, MAIL.solo);
      // Sync removes a stored message that became junk through the deletion path.
      const junk: MailFixture = { ...MAIL.solo, labels: ["SPAM"] };
      await store.writer.applyDeletion(accounts.personalMail, deletion(accounts, junk));
      expect(await stored(store, accounts, MAIL.solo)).toBe(0);
      expect(await count(store.db, "knowledge.removed_evidence")).toBe(0);
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("stored");
      expect(await stored(store, accounts, MAIL.solo)).toBe(1);
    }));

  it("mail from a suppressed address is not stored", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      await suppressed(store.db, SOLO.address);
      const before = await count(store.db, "knowledge.entities");
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("suppressed");
      expect(await stored(store, accounts, MAIL.solo)).toBe(0);
      // The item's transaction rolled back whole: no entity of the identity port's is left.
      expect(await count(store.db, "knowledge.entities")).toBe(before);
      expect(await count(store.db, "knowledge.messages")).toBe(0);
      // The positive control: Quentin's own mail is stored.
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.fromQuentin)).toBe("stored");
      expect(await accountsOf(store.db, QUENTIN.address)).toBe(1);
    }));

  it("an item that copies a suppressed address is stored and derives no row for it", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      await suppressed(store.db, QUENTIN.address);
      // Solo's message has Quentin on Cc.
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.solo)).toBe("stored");
      expect(await accountsOf(store.db, QUENTIN.address)).toBe(0);
      expect(await accountsOf(store.db, SOLO.address)).toBe(1);
      expect(await count(store.db, "knowledge.interaction_log")).toBe(1);
      expect(
        await count(store.db, "knowledge.domains", "domain_fp = $1", [
          fingerprint(store.db.keys, "domain", "lighthouse.test"),
        ]),
      ).toBe(0);
    }));

  it("a message the owner sends to a suppressed address is stored and writes no sent-recipient row for it", () =>
    withStore(async (store) => {
      const accounts = await connect(store.writer);
      await suppressed(store.db, CANARY_PERSON.address);
      expect(await ingestMail(store.writer, accounts.personalMail, MAIL.reply)).toBe("stored");
      const recipients = await admin<{ address_fp: string }>(
        store.db,
        "select address_fp from vault.sent_recipients order by address_fp",
      );
      expect(recipients.map((row) => row.address_fp).sort()).toEqual(
        [QUENTIN.address, RHEA.address].map((address) => fingerprint(store.db.keys, "address", address)).sort(),
      );
      expect(await accountsOf(store.db, CANARY_PERSON.address)).toBe(0);
      expect((await store.writer.ownerWrote(accounts.personalMail, { sender: QUENTIN.address })).sender).toBe(true);
      expect((await store.writer.ownerWrote(accounts.personalMail, { sender: CANARY_PERSON.address })).sender).toBe(
        false,
      );
    }));
});

describe("the erasure level", { timeout: TIMEOUT }, () => {
  // A writer, a reader and a pipeline on the store, each given the journal's path.
  const levels = async (store: Store, journal: string): Promise<string[]> => {
    const { log } = recordingLogger();
    const writer = createWriter({ url: store.db.urls.writer, keys: store.db.keys, log, journal });
    const reader = createReader({ url: store.db.urls.reader, keys: store.db.keys, log, journal });
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log, journal });
    try {
      const answers: string[] = [];
      for (const level of [() => writer.erasureLevel(), () => reader.erasureLevel(), () => pipeline.erasureLevel()]) {
        answers.push(
          await level().then(
            (answer) => answer,
            (error: unknown) => `refused ${(error as { code?: string }).code}`,
          ),
        );
      }
      return answers;
    } finally {
      await Promise.all([writer.close(), reader.close(), pipeline.close()]);
    }
  };
  const inTemp = async <T>(fn: (journal: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "pi-level-"));
    try {
      return await fn(join(dir, "keys.json.erasures"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const entry = (seq: number): ErasureJournalEntry =>
    ({ seq, erasure: testId("ers"), kind: "item", items: [], suppress: [] }) as unknown as ErasureJournalEntry;

  it("erasureLevel is level with no erasure and no journal", () =>
    withStore((store) =>
      inTemp(async (journal) => {
        expect(await levels(store, journal)).toEqual(["level", "level", "level"]);
        await ensureJournal(journal);
        expect(await levels(store, journal)).toEqual(["level", "level", "level"]);
      }),
    ));

  it("erasureLevel is behind when the journal is ahead", () =>
    withStore((store) =>
      inTemp(async (journal) => {
        await appendJournal(journal, entry(1));
        expect(await levels(store, journal)).toEqual(["behind", "behind", "behind"]);
        // The positive control: the database catches up.
        await erasureRow(store.db, 1);
        expect(await levels(store, journal)).toEqual(["level", "level", "level"]);
      }),
    ));

  it("erasureLevel is behind when the database is ahead, and the journal is refused when it is missing", () =>
    withStore((store) =>
      inTemp(async (journal) => {
        await erasureRow(store.db, 1);
        // A wrong path never reads as no erasure.
        expect(await levels(store, journal)).toEqual([
          "refused journal_refused",
          "refused journal_refused",
          "refused journal_refused",
        ]);
        await ensureJournal(journal);
        expect(await levels(store, journal)).toEqual(["behind", "behind", "behind"]);
        await appendJournal(journal, entry(1));
        expect(await levels(store, journal)).toEqual(["level", "level", "level"]);
      }),
    ));

  it("a reader made with the journal answers unavailable before its first call while the journal is ahead, and serves once the two are level", () =>
    withStore((store) =>
      inTemp(async (journal) => {
        const client = await insertClient(store.db, "level-reader", ["own"]);
        const { log } = recordingLogger();
        const reader = createReader({ url: store.db.urls.reader, keys: store.db.keys, log, journal });
        try {
          await appendJournal(journal, entry(1));
          expect(await reader.getSelf(client.token)).toEqual({ ok: false, code: "unavailable" });
          // No call was logged: nothing was read.
          expect(await count(store.db, "policy.calls")).toBe(0);
          await erasureRow(store.db, 1);
          expect((await reader.getSelf(client.token)).ok).toBe(true);
        } finally {
          await reader.close();
        }
      }),
    ));
});
