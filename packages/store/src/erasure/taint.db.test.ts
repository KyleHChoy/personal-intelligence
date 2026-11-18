import { randomBytes } from "node:crypto";
import type { RawItem } from "@intelligence/contracts";
import type { CardId, EntityId, MessageId, NewCard, PersonalRef } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { connect, OWNER, type Who } from "../test-support/cast.ts";
import { addOwnerAddressUnderived, one, type Query, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import {
  derive,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailRevision,
  mailSourceId,
  NOW,
} from "../test-support/items.ts";
import { recordingStatements } from "../test-support/recording.ts";
import { withStore } from "../test-support/store.ts";
import type { Writer } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

const TIMEOUT = 120_000;
const AT = new Date(NOW);
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const QUENTIN: Who = { address: "quentin@lighthouse.test", name: "Quentin Lampwick" };

const from = (who: Who, id: string): MailFixture =>
  mail({ id, threadId: `thread-${id}`, at: NOW, from: who, to: [ME], subject: `Hello ${id}`, labels: ["INBOX"] });

async function ingest(writer: Writer, account: SourceAccountRow, raw: RawItem): Promise<void> {
  await writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));
}

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

const asAdmin = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(db.urls.admin, async (query) => {
    await query("begin");
    const result = await fn(query);
    await query("commit");
    return result;
  });

// A pending notice with a body, citing `refs`, about `target`.
async function card(db: TestDatabase, refs: PersonalRef[], target: PersonalRef | null = null): Promise<CardId> {
  const made: NewCard = {
    id: newId("crd") as CardId,
    requestId: `req-${randomBytes(8).toString("hex")}`,
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target,
    refs,
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a body to lose",
    bodyFrom: "code",
  };
  await asAdmin(db, (query) => raiseCard(query, made, { now: AT, keys: db.keys }));
  return made.id;
}

type CardState = { tainted: boolean; body: boolean; state: string };
const cardState = async (db: TestDatabase, id: CardId): Promise<CardState> =>
  one(
    await admin<CardState>(
      db,
      `select c.tainted_at is not null as tainted, c.body_enc is not null as body,
         (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
       from ledger.cards c where c.id = $1`,
      [id],
    ),
  );
const TAINTED: CardState = { tainted: true, body: false, state: "withdrawn" };
const WHOLE: CardState = { tainted: false, body: true, state: "pending" };

const messageOf = async (
  db: TestDatabase,
  account: SourceAccountRow,
  fixture: MailFixture,
): Promise<MessageId | undefined> =>
  (
    await admin<{ id: MessageId }>(
      db,
      "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [account.id, fingerprint(db.keys, "source_id", mailSourceId(fixture))],
    )
  )[0]?.id;

const deletion = (account: SourceAccountRow, fixture: MailFixture) => ({
  sourceAccount: account.id,
  sourceItemId: mailSourceId(fixture),
  deletedAt: NOW,
});

// Every statement any pg client sends fails when its text holds `text`, while `fn` runs.
async function failingOn<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    if (typeof args[0] === "string" && args[0].includes(text))
      return Promise.reject(Object.assign(new Error("injected"), { code: "XX000" }));
    return (original as (...given: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    return await fn();
  } finally {
    pg.Client.prototype.query = original;
  }
}

describe("a deletion taints the ledger", { timeout: TIMEOUT }, () => {
  it("a message deleted at the source taints the card that cited it, in the same transaction", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const fixture = from(PIPPA, "taint-deleted");
      await ingest(writer, personalMail, mailItem(fixture, personalMail));
      const message = (await messageOf(db, personalMail, fixture)) as MessageId;
      const cited = await card(db, [{ kind: "message", id: message }]);

      // A statement that fails after the deletion rolls back the deletion and the taint alike.
      await expect(
        failingOn("delete from vault.listed_items", () =>
          writer.applyDeletion(personalMail, deletion(personalMail, fixture)),
        ),
      ).rejects.toBeDefined();
      expect(await messageOf(db, personalMail, fixture)).toBe(message);
      expect(await cardState(db, cited)).toEqual(WHOLE);

      await writer.applyDeletion(personalMail, deletion(personalMail, fixture));
      expect(await messageOf(db, personalMail, fixture)).toBeUndefined();
      expect(await cardState(db, cited)).toEqual(TAINTED);
      expect(await admin(db, "select tainted_at is not null as tainted, evidence_id from ledger.basis")).toEqual([
        { tainted: true, evidence_id: null },
      ]);
    }));

  it("a pending card whose target is a card the taint tainted is withdrawn", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const fixture = from(PIPPA, "taint-target");
      await ingest(writer, personalMail, mailItem(fixture, personalMail));
      const cited = await card(db, [
        { kind: "message", id: (await messageOf(db, personalMail, fixture)) as MessageId },
      ]);
      const about = await card(db, [], { kind: "card", id: cited } as never);
      const unrelated = await card(db, []);
      await writer.applyDeletion(personalMail, deletion(personalMail, fixture));
      expect(await cardState(db, cited)).toEqual(TAINTED);
      expect((await cardState(db, about)).state).toBe("withdrawn");
      expect(await cardState(db, unrelated)).toEqual(WHOLE);
    }));

  it("a new revision that is unread taints the card that cited the message", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const fixture = from(PIPPA, "taint-unread");
      await ingest(writer, personalMail, mailItem(fixture, personalMail));
      const cited = await card(db, [
        { kind: "message", id: (await messageOf(db, personalMail, fixture)) as MessageId },
      ]);
      const unread: MailFixture = { ...fixture, reads: "unread" };
      await writer.ingestItem(personalMail, mailRevision(unread, personalMail), mailFacts(unread));
      expect(await messageOf(db, personalMail, fixture)).toBeUndefined();
      expect(await cardState(db, cited)).toEqual(TAINTED);
    }));

  it("a person removed with their last message taints the card about them", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const pippa = from(PIPPA, "taint-last");
      const quentin = from(QUENTIN, "taint-other");
      await ingest(writer, personalMail, mailItem(pippa, personalMail));
      await ingest(writer, personalMail, mailItem(quentin, personalMail));
      const entityOf = async (who: Who): Promise<EntityId> =>
        one(
          await admin<{ id: EntityId }>(db, "select entity_id as id from knowledge.accounts where value_fp = $1", [
            fingerprint(db.keys, "address", who.address),
          ]),
        ).id;
      const about = await card(db, [], { kind: "entity", id: await entityOf(PIPPA) });
      const other = await card(db, [], { kind: "entity", id: await entityOf(QUENTIN) });
      await writer.applyDeletion(personalMail, deletion(personalMail, pippa));
      expect(await cardState(db, about)).toEqual(TAINTED);
      // A person who keeps a message keeps the card about them whole.
      expect(await cardState(db, other)).toEqual(WHOLE);
    }));

  // A re-derive keeps its messages, so the card stays whole, and the one call it makes is for the
  // person who went.
  it("a re-derive keeps whole the card that cited a message, and locks the messages before the taint lock", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const quentin = from(QUENTIN, "taint-rederive");
      await ingest(writer, personalMail, mailItem(quentin, personalMail));
      await ingest(writer, personalMail, mailItem(from(PIPPA, "taint-rederive-pippa"), personalMail));
      const cited = await card(db, [
        { kind: "message", id: (await messageOf(db, personalMail, quentin)) as MessageId },
      ]);
      // Pippa's address becomes the owner's, so a re-derive is needed.
      await addOwnerAddressUnderived(db, PIPPA.address, "own");
      const { result, statements } = await recordingStatements(() => writer.rederiveIfNeeded(derive));
      expect(result.rederived).toBe(true);
      const taint = statements.findIndex((one) => one.text.includes("taint_citing"));
      const locked = statements.findIndex((one) => /knowledge\.messages[\s\S]*for update/.test(one.text));
      expect(locked).toBeGreaterThanOrEqual(0);
      expect(locked).toBeLessThan(taint);
      expect(await cardState(db, cited)).toEqual(WHOLE);
    }));

  it("a deletion with no card makes no call", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const stored = from(PIPPA, "taint-stored");
      // A new item deletes nothing, and a deletion of an item that is not stored deletes nothing.
      const quiet = await recordingStatements(async () => {
        await ingest(writer, personalMail, mailItem(stored, personalMail));
        await writer.applyDeletion(personalMail, deletion(personalMail, from(PIPPA, "taint-never-stored")));
      });
      expect(quiet.statements.filter((one) => one.text.includes("taint_citing"))).toEqual([]);
      // The positive control: a deletion of a stored item makes the one call, and taints nothing.
      const loud = await recordingStatements(() => writer.applyDeletion(personalMail, deletion(personalMail, stored)));
      expect(loud.statements.filter((one) => one.text.includes("taint_citing")).length).toBeGreaterThan(0);
      expect(await admin(db, "select count(*)::int as n from ledger.cards")).toEqual([{ n: 0 }]);
    }));
});
