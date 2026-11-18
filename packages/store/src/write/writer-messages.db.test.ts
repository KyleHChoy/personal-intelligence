import { createHash } from "node:crypto";
import { ConnectorCursor, type RawItem } from "@intelligence/contracts";
import { messageBodyHash } from "@intelligence/contracts/body-hash";
import { MessageId } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import type { ItemContext, ItemFacts } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { connect, GUEST, LATER_OWNER, OWNER, QUENTIN, RHEA, type Who } from "../test-support/cast.ts";
import { hashFingerprint } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import {
  derive,
  eventFacts,
  eventItem,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailRevision,
  mailSourceId,
  NOW,
} from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { namesSealed, recordingStatements, type SentStatement } from "../test-support/recording.ts";
import { changed, comparableRows, lines, opened, rowCounts, snapshot } from "../test-support/snapshot.ts";
import { withDatabase, withStore, withWriter } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import type { Writer } from "./writer.ts";
import type { IngestAnswer, SourceAccountRow } from "./writer-types.ts";

// Written from the specs alone, against the stub of `ownerWrote`, through the writer's exported
// functions and SQL as pi_admin. Every address is on a reserved domain; every fact is written by
// hand.

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const cursor = (text: string): ConnectorCursor => ConnectorCursor.parse(text);
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const codePoints = (text: string): number => [...text].length;

// ---------------------------------------------------------------------------------------------
// The cast, and messages written by hand
// ---------------------------------------------------------------------------------------------

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const TOBIAS: Who = { address: "tobias@quayside.test", name: "Tobias Quayside" };
const MARLOW: Who = { address: "marlow@ferry-example.test", name: "Marlow Ferryman" };
// A person's address by its shape (`receipts@` would be a role mailbox, which makes no person on
// any message), so only the bulk rule keeps its bulk mail from making one.
const RECEIPTS: Who = { address: "clerk@chandlery-example.test", name: "Chandlery Clerk" };

// A received message from Pippa in the inbox, unless said otherwise.
const received = (id: string, over: Partial<MailFixture> = {}): MailFixture => ({
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@quayside.test`,
  at: "2026-09-20T09:00:00Z",
  from: PIPPA,
  to: [ME],
  subject: `Subject of ${id}`,
  labels: ["INBOX"],
  ...over,
});

// A message the owner sent to Pippa, unless said otherwise.
const sent = (id: string, over: Partial<MailFixture> = {}): MailFixture =>
  received(id, { messageId: `${id}@hearth-canary.test`, from: ME, to: [PIPPA], labels: ["SENT"], ...over });

// A text with a line end of each kind, trailing white space and characters outside the basic
// plane: its length in code points is not its length in UTF-16 units.
const TEXT =
  "The ferry rota, first draft.\r\nTuesday: \u{1D11E} and \u{1F6A2} at the quay.  \n\n  Bring the brass key.\n";

const ingest = (writer: Writer, account: SourceAccountRow, fixture: MailFixture): Promise<IngestAnswer> =>
  writer.ingestItem(account, mailItem(fixture, account), mailFacts(fixture));

// A declared fixture's item, with its facts picked by the fixtures' one `derive`, as a re-derive picks them.
const ingestDeclared = (writer: Writer, account: SourceAccountRow, raw: RawItem): Promise<IngestAnswer> =>
  writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));

const fp = (db: TestDatabase, kind: "address" | "domain" | "thread" | "source_id", value: string): string =>
  fingerprint(db.keys, kind, value);
const domainOf = (address: string): string => address.split("@")[1] ?? "";

// ---------------------------------------------------------------------------------------------
// Reading what the writer stored, as pi_admin
// ---------------------------------------------------------------------------------------------

type StoredMessage = {
  id: string;
  evidence_id: string;
  sent_at: Date;
  direction: string;
  bulk: boolean;
  category: string;
  held: boolean;
  thread_fp: string | null;
  sender_fp: string | null;
  sender_domain_fp: string | null;
  compartments: string[];
  subject_enc: unknown;
  thread_id_enc: unknown;
  sender_enc: unknown;
  sender_name_enc: unknown;
  body_enc: unknown;
  facts_enc: unknown;
  xmin: string;
};

const MESSAGE_COLUMNS =
  "m.id, m.evidence_id, m.sent_at, m.direction, m.bulk, m.category, m.held, m.thread_fp, m.sender_fp, m.sender_domain_fp, m.compartments, m.subject_enc, m.thread_id_enc, m.sender_enc, m.sender_name_enc, m.body_enc, m.facts_enc, m.xmin::text as xmin";

// A message's row with every sealed value opened at its own row and column, under its
// compartment's key.
function read(db: TestDatabase, row: StoredMessage) {
  const compartment = row.compartments[0] ?? "";
  const open = (column: string, value: unknown): string | null =>
    value === null ? null : opened(db, compartment, { table: "knowledge.messages", id: row.id, column }, value);
  return {
    id: row.id,
    evidence_id: row.evidence_id,
    sent_at: iso(row.sent_at),
    direction: row.direction,
    bulk: row.bulk,
    category: row.category,
    held: row.held,
    thread_fp: row.thread_fp,
    sender_fp: row.sender_fp,
    sender_domain_fp: row.sender_domain_fp,
    compartments: row.compartments,
    subject: open("subject_enc", row.subject_enc),
    threadId: open("thread_id_enc", row.thread_id_enc),
    sender: open("sender_enc", row.sender_enc),
    senderName: open("sender_name_enc", row.sender_name_enc),
    body: open("body_enc", row.body_enc),
    facts: JSON.parse(open("facts_enc", row.facts_enc) ?? "null") as Record<string, unknown> | null,
  };
}

// The message rows that cite any revision of a source item: one, or none.
const rowsOf = async (db: TestDatabase, account: SourceAccountRow, fixture: MailFixture) =>
  (
    await admin<StoredMessage>(
      db,
      `select ${MESSAGE_COLUMNS} from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
       where e.source_account_id = $1 and e.source_item_fp = $2`,
      [account.id, fp(db, "source_id", mailSourceId(fixture))],
    )
  ).map((row) => read(db, row));

// What the row of a fixture's message must hold, but for its id.
function expectedRow(db: TestDatabase, account: SourceAccountRow, fixture: MailFixture, revision = 0) {
  const text = fixture.text ?? null;
  const outbound = fixture.labels.includes("SENT") && !fixture.labels.includes("SPAM");
  const category =
    (["promotions", "social", "forums", "updates"] as const).find((one) =>
      fixture.labels.includes(`CATEGORY_${one.toUpperCase()}`),
    ) ?? "primary";
  return {
    evidence_id: evidenceIdOf(account, mailSourceId(fixture), revision),
    sent_at: iso(fixture.at),
    direction: outbound ? "outbound" : "inbound",
    category,
    held: fixture.held ?? false,
    thread_fp: fp(db, "thread", fixture.threadId),
    sender_fp: fixture.from === undefined ? null : fp(db, "address", fixture.from.address),
    sender_domain_fp: fixture.from === undefined ? null : fp(db, "domain", domainOf(fixture.from.address)),
    compartments: [account.compartment],
    subject: fixture.subject ?? null,
    threadId: fixture.threadId,
    sender: fixture.from?.address ?? null,
    senderName: fixture.from?.name ?? null,
    body: text,
    facts: {
      chars: text === null ? 0 : codePoints(text),
      unreadable: fixture.unreadable ?? false,
      attachments: fixture.attachments ?? [],
      ...(fixture.messageId === undefined ? {} : { messageId: fixture.messageId }),
      ...(fixture.references === undefined ? {} : { references: fixture.references }),
    },
  };
}

const interactionsOf = async (db: TestDatabase, account: SourceAccountRow, fixture: MailFixture): Promise<number> =>
  one(
    await admin<{ n: number }>(
      db,
      `select count(*)::int as n from knowledge.interaction_log i join vault.evidence_items e on e.id = i.evidence_id
       where e.source_account_id = $1 and e.source_item_fp = $2`,
      [account.id, fp(db, "source_id", mailSourceId(fixture))],
    ),
  ).n;

const accountRows = async (db: TestDatabase, who: Who): Promise<number> =>
  one(
    await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.accounts where value_fp = $1", [
      fp(db, "address", who.address),
    ]),
  ).n;

const entityKinds = async (db: TestDatabase): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await admin<{ kind: string; n: number }>(
        db,
        "select kind, count(*)::int as n from knowledge.entities group by kind",
      )
    ).map((row) => [row.kind, row.n]),
  );

type RecipientRow = { evidence_id: string; address_fp: string; account_id: string; compartments: string[] };

// By evidence id, then address fingerprint.
const byRecipient = <Row extends { evidence_id: string; address_fp: string }>(rows: Row[]): Row[] =>
  [...rows].sort((left, right) =>
    `${left.evidence_id} ${left.address_fp}` < `${right.evidence_id} ${right.address_fp}` ? -1 : 1,
  );

const recipientRows = async (db: TestDatabase): Promise<RecipientRow[]> =>
  byRecipient(
    await admin<RecipientRow>(
      db,
      "select evidence_id, address_fp, account_id, compartments from vault.sent_recipients",
    ),
  );

// The recipient rows a stored sent message must have: one per address, each once.
const recipientsOf = (db: TestDatabase, account: SourceAccountRow, evidenceId: string, people: Who[]): RecipientRow[] =>
  byRecipient(
    [...new Set(people.map((who) => fp(db, "address", who.address)))].map((address_fp) => ({
      evidence_id: evidenceId,
      address_fp,
      account_id: account.id,
      compartments: [account.compartment],
    })),
  );

type EvidenceMarks = { id: string; system_originated: boolean; answers_system: boolean; hold_released_at: Date | null };

const marks = (db: TestDatabase): Promise<EvidenceMarks[]> =>
  admin<EvidenceMarks>(
    db,
    "select id, system_originated, answers_system, hold_released_at from vault.evidence_items order by id",
  );

const storedSourceItems = async (db: TestDatabase, account: SourceAccountRow): Promise<string[]> =>
  (
    await admin<{ fp: string }>(
      db,
      "select distinct source_item_fp as fp from vault.evidence_items where source_account_id = $1",
      [account.id],
    )
  )
    .map((row) => row.fp)
    .sort();

const listedRows = async (db: TestDatabase, account: SourceAccountRow): Promise<string[]> =>
  (
    await admin<{ fp: string }>(db, "select source_item_fp as fp from vault.listed_items where account_id = $1", [
      account.id,
    ])
  )
    .map((row) => row.fp)
    .sort();

const fps = (db: TestDatabase, ...sourceItemIds: string[]): string[] =>
  sourceItemIds.map((id) => fp(db, "source_id", id)).sort();

// Two test databases that share one key file, so every fingerprint and every opened envelope of
// one compares with the other's.
const withPair = <T>(fn: (first: TestDatabase, second: TestDatabase) => Promise<T>): Promise<T> =>
  withDatabase((first) => withDatabase((second) => fn(first, second), { keyFile: first.keyFile }));

// The store of the re-derive tests: declared fixtures ingested in order under the personal mail
// account, with the address of one of their senders made the owner's before them ("first") or
// after them ("after"), and then one call of `rederiveIfNeeded`, with every statement it sent.
const rederived = (db: TestDatabase, when: "first" | "after", fixtures: MailFixture[]) =>
  withWriter(db, async (writer) => {
    const account = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
    const second = (): Promise<SourceAccountRow> =>
      writer.ensureSourceAccount("second", "google_mail", "own", LATER_OWNER.address);
    if (when === "first") await second();
    for (const fixture of fixtures) await ingestDeclared(writer, account, mailItem(fixture, account));
    if (when === "after") await second();
    const order: string[] = [];
    const { result, statements } = await recordingStatements(() =>
      writer.rederiveIfNeeded((raw, ctx) => {
        order.push(raw.sourceItemId);
        return derive(raw, ctx);
      }),
    );
    return { account, result, order, statements };
  });

const mostRows = (statements: SentStatement[]): number =>
  statements.reduce((most, statement) => Math.max(most, statement.rows), 0);

describe("the writer: a row for every message", { timeout: DB_TEST_TIMEOUT }, () => {
  describe("every stored email whose facts are of kind email, bulk or not, has exactly one knowledge.messages row", () => {
    it("every stored email whose facts are of kind email, bulk or not, has exactly one knowledge.messages row", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        const person = received("gm-r20-received", {
          text: TEXT,
          attachments: [
            { name: "rota-draft.pdf", type: "application/pdf", size: 20_480 },
            { name: "", type: "image/png", size: 0 },
          ],
          references: ["r20-first@quayside.test", "r20-second@ferry-example.test"],
          cc: [TOBIAS],
        });
        const outbound = sent("gm-r20-sent", {
          text: "Thank you, Tuesday suits.",
          threadId: person.threadId,
          to: [PIPPA],
          cc: [TOBIAS],
        });
        const bulk = received("gm-r20-bulk", {
          from: { address: RECEIPTS.address },
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
          text: "Receipt 0042: one coil of rope.",
        });
        // Under Forums and not bulk, so from a sender the owner has written to from that account:
        // the writer refuses facts that call it not bulk otherwise.
        const toMarlow = sent("gm-r20-to-marlow", { from: ME_AT_WORK, to: [MARLOW] });
        const atWork = received("gm-r20-work", {
          from: MARLOW,
          to: [ME_AT_WORK],
          labels: ["INBOX", "CATEGORY_FORUMS"],
          reads: "conditional",
          text: "The crossing is at nine.",
        });
        const unread = received("gm-r20-unread", { reads: "unread" });

        expect(await ingest(writer, personalMail, person)).toBe("stored");
        expect(await ingest(writer, personalMail, outbound)).toBe("stored");
        expect(await ingest(writer, personalMail, bulk)).toBe("stored");
        expect(await ingest(writer, workMail, toMarlow)).toBe("stored");
        expect(await ingest(writer, workMail, atWork)).toBe("stored");
        expect(await ingest(writer, personalMail, unread)).toBe("unread");

        // One row for each message whose facts are of kind email, a bulk one included, and none
        // for the unread one.
        const stored: [SourceAccountRow, MailFixture, boolean][] = [
          [personalMail, person, false],
          [personalMail, outbound, false],
          [personalMail, bulk, true],
          [workMail, toMarlow, false],
          [workMail, atWork, false],
        ];
        for (const [account, fixture, isBulk] of stored) {
          const row = one(await rowsOf(db, account, fixture));
          expect(MessageId.safeParse(row.id).success, fixture.id).toBe(true);
          // In clear, only what a query filters or orders by; sealed, everything it says.
          expect(row, fixture.id).toEqual({ id: row.id, bulk: isBulk, ...expectedRow(db, account, fixture) });
        }
        expect(await rowsOf(db, personalMail, unread)).toEqual([]);
        expect(
          one(
            await admin<{ n: number; items: number }>(
              db,
              "select count(*)::int as n, count(distinct evidence_id)::int as items from knowledge.messages",
            ),
          ),
        ).toEqual({ n: 5, items: 5 });

        // What the fixtures above cover, said once: a message the owner sent is outbound; each
        // category is the facts'; a sender with no name has none stored; the text is as the
        // facts give it, never cut or changed, and its length is counted in code points.
        expect(one(await rowsOf(db, personalMail, outbound)).direction).toBe("outbound");
        expect(one(await rowsOf(db, personalMail, bulk))).toMatchObject({ category: "updates", senderName: null });
        expect(one(await rowsOf(db, workMail, atWork))).toMatchObject({
          category: "forums",
          compartments: ["employer:example"],
        });
        const kept = one(await rowsOf(db, personalMail, person));
        expect(kept.body).toBe(TEXT);
        expect(kept.facts?.chars).toBe(codePoints(TEXT));
        expect(codePoints(TEXT)).toBeLessThan(TEXT.length);

        // Written in the item's transaction: the row shares its evidence row's xmin.
        const together = await admin<{ message: string; evidence: string }>(
          db,
          "select m.xmin::text as message, e.xmin::text as evidence from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
        );
        expect(together).toHaveLength(5);
        for (const row of together) expect(row.message).toBe(row.evidence);

        // A message with no thread id, no sender, no subject and no text: each of those is null,
        // in clear and sealed alike, and its facts hold nothing but the three counts.
        const bare = received("gm-r20-bare");
        const { threadId: _thread, sender: _sender, ...threadless } = mailItem(bare, personalMail);
        const bareFacts = async (): Promise<ItemFacts> => ({
          kind: "email",
          members: { participantMembers: [THE_OWNER] },
          bulk: true,
          message: {
            subject: null,
            at: bare.at,
            category: "primary",
            text: null,
            unreadable: false,
            held: false,
            restricted: [],
            attachments: [],
          },
        });
        expect(await writer.ingestItem(personalMail, threadless, bareFacts)).toBe("stored");
        const row = one(await rowsOf(db, personalMail, bare));
        expect(row).toEqual({
          id: row.id,
          evidence_id: evidenceIdOf(personalMail, mailSourceId(bare)),
          sent_at: iso(bare.at),
          direction: "inbound",
          bulk: true,
          category: "primary",
          held: false,
          thread_fp: null,
          sender_fp: null,
          sender_domain_fp: null,
          compartments: ["own"],
          subject: null,
          threadId: null,
          sender: null,
          senderName: null,
          body: null,
          facts: { chars: 0, unreadable: false, attachments: [] },
        });
      }));

    it("a bulk message has a message row and no entity, account, alias or interaction", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const receipt = received("gm-bulk-receipt", {
          from: RECEIPTS,
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
          subject: "Your receipt from the chandlery",
          text: TEXT,
          attachments: [{ name: "receipt-0042.pdf", type: "application/pdf", size: 31_337 }],
          cc: [TOBIAS],
        });
        const before = await rowCounts(db);
        const kinds = await entityKinds(db);

        expect(await ingest(writer, personalMail, receipt)).toBe("stored");

        // Its evidence and its one message row, and nothing else.
        expect(changed(before, await rowCounts(db))).toEqual({
          "vault.evidence_items": 1,
          "vault.evidence_blobs": 1,
          "knowledge.messages": 1,
        });
        expect(await entityKinds(db)).toEqual(kinds);
        expect(await accountRows(db, RECEIPTS)).toBe(0);
        expect(await accountRows(db, TOBIAS)).toBe(0);
        expect(await interactionsOf(db, personalMail, receipt)).toBe(0);
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.aliases")).n).toBe(0);

        // The row, with its text, its sender and its attachment list read back opened.
        const row = one(await rowsOf(db, personalMail, receipt));
        expect(row).toEqual({ id: row.id, bulk: true, ...expectedRow(db, personalMail, receipt) });
        expect(row).toMatchObject({
          body: TEXT,
          sender: RECEIPTS.address,
          senderName: RECEIPTS.name,
          sender_fp: fp(db, "address", RECEIPTS.address),
          sender_domain_fp: fp(db, "domain", "chandlery-example.test"),
        });
        expect(row.facts).toEqual({
          chars: codePoints(TEXT),
          unreadable: false,
          attachments: receipt.attachments,
          messageId: receipt.messageId,
        });

        // A bulk message with no text has its row too, with no body.
        expect(await ingest(writer, personalMail, MAIL.newsletter)).toBe("stored");
        expect(one(await rowsOf(db, personalMail, MAIL.newsletter))).toMatchObject({
          bulk: true,
          category: "promotions",
          body: null,
          facts: { chars: 0, attachments: [] },
        });

        // The control: the same sender on a message that is not bulk is a person, with an
        // account, a name and an interaction.
        const personal = received("gm-bulk-control", { from: RECEIPTS });
        const beforeControl = await rowCounts(db);
        expect(await ingest(writer, personalMail, personal)).toBe("stored");
        expect(changed(beforeControl, await rowCounts(db))).toMatchObject({
          "knowledge.messages": 1,
          "knowledge.accounts": 1,
          "knowledge.aliases": 1,
          "knowledge.interaction_log": 1,
        });
        expect(await accountRows(db, RECEIPTS)).toBe(1);
      }));

    it("a message's row keeps its id across a label change, and loses and regains its interaction rows", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const inInbox = received("gm-relabel-0001", { from: MARLOW, text: "The crossing is at nine." });
        const underUpdates: MailFixture = { ...inInbox, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" };
        expect(mailItem(underUpdates, personalMail).revisionTag).not.toBe(mailItem(inInbox, personalMail).revisionTag);
        const state = async () => {
          const row = one(await rowsOf(db, personalMail, inInbox));
          return {
            id: row.id,
            evidence_id: row.evidence_id,
            bulk: row.bulk,
            category: row.category,
            body: row.body,
            interactions: await interactionsOf(db, personalMail, inInbox),
            accounts: await accountRows(db, MARLOW),
          };
        };
        const revision = (n: number): string => evidenceIdOf(personalMail, mailSourceId(inInbox), n);

        // First seen under Updates: bulk, so the row and no person.
        expect(await ingest(writer, personalMail, underUpdates)).toBe("stored");
        const first = await state();
        expect(first).toEqual({
          id: first.id,
          evidence_id: revision(0),
          bulk: true,
          category: "updates",
          body: inInbox.text,
          interactions: 0,
          accounts: 0,
        });

        // Moved to the inbox: the same row, now a person's, with its interaction row.
        expect(await ingest(writer, personalMail, inInbox)).toBe("stored");
        expect(await state()).toEqual({
          id: first.id,
          evidence_id: revision(1),
          bulk: false,
          category: "primary",
          body: inInbox.text,
          interactions: 1,
          accounts: 1,
        });

        // Back under Updates: the same row again, and whoever only the earlier revision named is gone.
        expect(await ingest(writer, personalMail, underUpdates)).toBe("stored");
        expect(await state()).toEqual({
          id: first.id,
          evidence_id: revision(2),
          bulk: true,
          category: "updates",
          body: inInbox.text,
          interactions: 0,
          accounts: 0,
        });

        // And to the inbox once more: it regains them.
        expect(await ingest(writer, personalMail, inInbox)).toBe("stored");
        expect(await state()).toEqual({
          id: first.id,
          evidence_id: revision(3),
          bulk: false,
          category: "primary",
          body: inInbox.text,
          interactions: 1,
          accounts: 1,
        });

        // One row throughout, and every revision kept in the vault.
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.messages")).n).toBe(1);
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from vault.evidence_items")).n).toBe(4);
      }));

    it("a revision that is unread removes the message row", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const readable = received("gm-unread-revision-0001", { from: MARLOW, text: "The crossing is at nine." });
        const unreadNow: MailFixture = { ...readable, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "unread" };

        // The positive control: while its facts are an email's, it has its row and its person.
        expect(await ingest(writer, personalMail, readable)).toBe("stored");
        expect(await rowsOf(db, personalMail, readable)).toHaveLength(1);
        expect(await interactionsOf(db, personalMail, readable)).toBe(1);
        expect(await accountRows(db, MARLOW)).toBe(1);

        // A revision whose facts are unread: the row an earlier revision had is removed, with
        // everything else derived from it. Both revisions stay as evidence.
        expect(await ingest(writer, personalMail, unreadNow)).toBe("unread");
        expect(await rowsOf(db, personalMail, readable)).toEqual([]);
        expect(await interactionsOf(db, personalMail, readable)).toBe(0);
        expect(await accountRows(db, MARLOW)).toBe(0);
        expect(await rowCounts(db)).toMatchObject({
          "vault.evidence_items": 2,
          "vault.evidence_blobs": 2,
          "knowledge.messages": 0,
          "knowledge.aliases": 0,
        });

        // Read again at a later revision, it has a row again, citing that revision.
        expect(await ingest(writer, personalMail, readable)).toBe("stored");
        expect(one(await rowsOf(db, personalMail, readable)).evidence_id).toBe(
          evidenceIdOf(personalMail, mailSourceId(readable), 2),
        );
      }));

    it("a deletion removes the row of a bulk message", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const gone = received("gm-bulk-deleted", {
          from: RECEIPTS,
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
          text: "Receipt 0043.",
        });
        const stays = received("gm-bulk-kept", {
          from: RECEIPTS,
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
          text: "Receipt 0044.",
        });
        expect(await ingest(writer, personalMail, gone)).toBe("stored");
        expect(await ingest(writer, personalMail, stays)).toBe("stored");
        // The positive control: each has its row.
        expect(await rowsOf(db, personalMail, gone)).toHaveLength(1);
        const kept = one(await rowsOf(db, personalMail, stays));
        const before = await rowCounts(db);

        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: mailSourceId(gone),
          deletedAt: NOW,
        });

        expect(await rowsOf(db, personalMail, gone)).toEqual([]);
        expect(changed(before, await rowCounts(db))).toEqual({
          "vault.evidence_items": -1,
          "vault.evidence_blobs": -1,
          "knowledge.messages": -1,
        });
        expect(
          one(
            await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.messages where evidence_id = $1", [
              evidenceIdOf(personalMail, mailSourceId(gone)),
            ]),
          ).n,
        ).toBe(0);
        // The other bulk message's row is as it was.
        expect(one(await rowsOf(db, personalMail, stays))).toEqual(kept);
      }));

    it("email facts with no message, a time that is not the record's, a category outside the five or a bad attachment size are refused and nothing is written", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const person = received("gm-refused-person", {
          from: MARLOW,
          text: "The crossing is at nine.",
          attachments: [{ name: "tide-table.pdf", type: "application/pdf", size: 1_024 }],
        });
        const bulk = received("gm-refused-bulk", {
          from: RECEIPTS,
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
          attachments: [{ name: "receipt.pdf", type: "application/pdf", size: 0 }],
        });
        type Change = (facts: Record<string, unknown> & { message: Record<string, unknown> }) => unknown;
        // The fixture's own facts, changed in one respect.
        const changedFacts =
          (fixture: MailFixture, change: Change) =>
          async (ctx: ItemContext): Promise<ItemFacts> => {
            const facts = (await mailFacts(fixture)(ctx)) as unknown as Parameters<Change>[0];
            return change({ ...facts, message: { ...facts.message } }) as ItemFacts;
          };
        const size =
          (value: unknown): Change =>
          (facts) => ({
            ...facts,
            message: {
              ...facts.message,
              attachments: [{ name: "tide-table.pdf", type: "application/pdf", size: value }],
            },
          });
        const cases: [string, Change, ("person" | "bulk")[]][] = [
          ["no message", ({ message: _, ...rest }) => rest, ["person", "bulk"]],
          [
            "a time that is not the record's",
            (facts) => ({ ...facts, message: { ...facts.message, at: "2026-09-20T10:00:00Z" } }),
            ["person"],
          ],
          [
            "a time that is no timestamp",
            (facts) => ({ ...facts, message: { ...facts.message, at: "the day before yesterday" } }),
            ["bulk"],
          ],
          [
            "a category outside the five",
            (facts) => ({ ...facts, message: { ...facts.message, category: "spam" } }),
            ["person", "bulk"],
          ],
          [
            "a category in another case",
            (facts) => ({ ...facts, message: { ...facts.message, category: "Primary" } }),
            ["bulk"],
          ],
          ["a negative attachment size", size(-1), ["person", "bulk"]],
          ["an attachment size that is no integer", size(1.5), ["person"]],
          ["an attachment size that is no number", size("1024"), ["bulk"]],
        ];
        const fixtures = { person, bulk };
        const before = lines(await snapshot(db));

        for (const [what, change, kinds] of cases) {
          for (const kind of kinds) {
            const fixture = fixtures[kind];
            await expect(
              writer.ingestItem(personalMail, mailItem(fixture, personalMail), changedFacts(fixture, change)),
              `${what}: ${kind}`,
            ).rejects.toMatchObject({ code: "invalid_facts" });
            // Nothing is written: not the evidence row, and no person the derive resolved.
            expect(lines(await snapshot(db)), `${what}: ${kind}`).toEqual(before);
          }
        }

        // The positive control: the same items with their facts as they were are stored. A
        // person's message has its record's time, and a size of zero is a size.
        expect(
          await writer.ingestItem(
            personalMail,
            mailItem(person, personalMail),
            changedFacts(person, (facts) => facts),
          ),
        ).toBe("stored");
        expect(
          await writer.ingestItem(
            personalMail,
            mailItem(bulk, personalMail),
            changedFacts(bulk, (facts) => facts),
          ),
        ).toBe("stored");
        expect(await rowsOf(db, personalMail, person)).toHaveLength(1);
        expect(await rowsOf(db, personalMail, bulk)).toHaveLength(1);
      }));

    it("a message's Message-ID and References are stored sealed in its facts, and in no column in clear", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const messageId = "canary-msgid-7f3a91@quayside.test";
        const references = ["canary-ref-one-11c4@quayside.test", "canary-ref-two-22d5@ferry-example.test"];
        const withBoth = received("gm-ids-with", { messageId, references });
        const bulkWithBoth = received("gm-ids-bulk", {
          messageId: "canary-msgid-bulk-88e0@chandlery-example.test",
          references: [messageId],
          from: RECEIPTS,
          labels: ["INBOX", "CATEGORY_UPDATES"],
          reads: "bulk",
        });
        const { messageId: _id, ...withNeither } = received("gm-ids-without");
        expect(await ingest(writer, personalMail, withBoth)).toBe("stored");
        expect(await ingest(writer, personalMail, bulkWithBoth)).toBe("stored");
        expect(await ingest(writer, personalMail, withNeither)).toBe("stored");

        // Facts with both: `facts_enc`, opened, holds them as given, the references in their order.
        const both = one(await rowsOf(db, personalMail, withBoth)).facts ?? {};
        expect(both).toEqual({ chars: 0, unreadable: false, attachments: [], messageId, references });
        expect(Object.keys(both).sort()).toEqual(["attachments", "chars", "messageId", "references", "unreadable"]);
        expect(one(await rowsOf(db, personalMail, bulkWithBoth)).facts).toEqual({
          chars: 0,
          unreadable: false,
          attachments: [],
          messageId: bulkWithBoth.messageId,
          references: [messageId],
        });
        // Facts with neither: neither key is there at all.
        const neither = one(await rowsOf(db, personalMail, withNeither)).facts ?? {};
        expect(Object.keys(neither).sort()).toEqual(["attachments", "chars", "unreadable"]);

        // In no column in clear.
        const needles = [messageId, ...references, bulkWithBoth.messageId ?? ""];
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);
        // The control for the scan: the same id is found once it is planted in a clear column.
        await admin(db, "update knowledge.messages set thread_fp = $1 where evidence_id = $2", [
          messageId.toUpperCase(),
          evidenceIdOf(personalMail, mailSourceId(withBoth)),
        ]);
        expect(
          (await scanForPlaintext(db.urls.admin, needles)).map(
            (hit) => `${hit.table.split(".").pop() ?? ""}.${hit.column}`,
          ),
        ).toEqual(["messages.thread_fp"]);
      }));
  });

  describe("ownerWrote(account, { sender, threadId }) answers two questions, each over what is stored now and over that one source account", () => {
    it("ownerWrote(account, { sender, threadId }) answers two questions, each over what is stored now and over that one source account", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // One message the owner sent to 1003 addresses, bulk so that none of them is resolved:
        // the raw item names the first 1000, and those are the ones the owner has written to.
        const crowd: Who[] = Array.from({ length: 1003 }, (_, index) => ({
          address: `reader-${String(index + 1).padStart(4, "0")}@crowd-example.test`,
        }));
        const toMany = sent("gm-r21-crowd", { to: crowd, reads: "bulk", threadId: "thread-r21-crowd" });
        const raw = mailItem(toMany, personalMail);
        expect(raw.addressees).toHaveLength(1000);
        const [first, thousandth, beyond] = [crowd[0], crowd[999], crowd[1000]] as [Who, Who, Who];

        // Nothing stored yet: neither answer is true.
        expect(await writer.ownerWrote(personalMail, { sender: first.address, threadId: toMany.threadId })).toEqual({
          sender: false,
          thread: false,
        });

        expect(await writer.ingestItem(personalMail, raw, mailFacts(toMany))).toBe("stored");
        const evidenceId = evidenceIdOf(personalMail, raw.sourceItemId);
        expect(await recipientRows(db)).toEqual(recipientsOf(db, personalMail, evidenceId, crowd.slice(0, 1000)));
        expect(await writer.ownerWrote(personalMail, { sender: first.address, threadId: toMany.threadId })).toEqual({
          sender: true,
          thread: true,
        });
        expect(await writer.ownerWrote(personalMail, { sender: thousandth.address })).toEqual({
          sender: true,
          thread: false,
        });
        expect(await writer.ownerWrote(personalMail, { sender: beyond.address })).toEqual({
          sender: false,
          thread: false,
        });

        // Over what is stored now: once the message is deleted, both answers are false again.
        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: raw.sourceItemId,
          deletedAt: NOW,
        });
        expect(await recipientRows(db)).toEqual([]);
        expect(await writer.ownerWrote(personalMail, { sender: first.address, threadId: toMany.threadId })).toEqual({
          sender: false,
          thread: false,
        });
      }));

    it("ownerWrote answers for the sender and for the thread, each alone", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        // Under `personal`: the owner wrote to Pippa in one thread, and Tobias wrote in another.
        const toPippa = sent("gm-wrote-sent", { threadId: "thread-wrote-owner", to: [PIPPA] });
        const fromTobias = received("gm-wrote-received", { threadId: "thread-wrote-tobias", from: TOBIAS });
        // Under `work`: the owner wrote to Marlow, in a thread of its own.
        const toMarlow = sent("gm-wrote-work", { threadId: "thread-wrote-work", from: ME_AT_WORK, to: [MARLOW] });
        for (const fixture of [toPippa, fromTobias]) expect(await ingest(writer, personalMail, fixture)).toBe("stored");
        expect(await ingest(writer, workMail, toMarlow)).toBe("stored");
        const before = lines(await snapshot(db));

        // Each answer alone, and both together.
        expect(await writer.ownerWrote(personalMail, { sender: PIPPA.address })).toEqual({
          sender: true,
          thread: false,
        });
        expect(await writer.ownerWrote(personalMail, { threadId: "thread-wrote-owner" })).toEqual({
          sender: false,
          thread: true,
        });
        expect(
          await writer.ownerWrote(personalMail, { sender: PIPPA.address, threadId: "thread-wrote-owner" }),
        ).toEqual({ sender: true, thread: true });
        // One true does not make the other: a sender written to in a thread the owner never
        // posted in, and a sender never written to in a thread the owner did post in.
        expect(
          await writer.ownerWrote(personalMail, { sender: PIPPA.address, threadId: "thread-wrote-tobias" }),
        ).toEqual({ sender: true, thread: false });
        expect(
          await writer.ownerWrote(personalMail, { sender: TOBIAS.address, threadId: "thread-wrote-owner" }),
        ).toEqual({ sender: false, thread: true });
        // The address is normalized before it is looked for.
        expect(await writer.ownerWrote(personalMail, { sender: `  ${PIPPA.address.toUpperCase()} ` })).toEqual({
          sender: true,
          thread: false,
        });

        // False: an absent sender and an absent thread, an address that does not normalize, a
        // sender who only wrote, and a thread someone else alone posted in.
        expect(await writer.ownerWrote(personalMail, {})).toEqual({ sender: false, thread: false });
        expect(await writer.ownerWrote(personalMail, { sender: "not-an-address" })).toEqual({
          sender: false,
          thread: false,
        });
        expect(await writer.ownerWrote(personalMail, { sender: "pippa@localhost" })).toEqual({
          sender: false,
          thread: false,
        });
        expect(
          await writer.ownerWrote(personalMail, { sender: TOBIAS.address, threadId: "thread-wrote-tobias" }),
        ).toEqual({ sender: false, thread: false });
        expect(await writer.ownerWrote(personalMail, { threadId: "thread-nobody-holds" })).toEqual({
          sender: false,
          thread: false,
        });

        // Neither answer crosses accounts: what only the other account holds is false here, and
        // true there, which is the control.
        expect(
          await writer.ownerWrote(personalMail, { sender: MARLOW.address, threadId: "thread-wrote-work" }),
        ).toEqual({ sender: false, thread: false });
        expect(await writer.ownerWrote(workMail, { sender: MARLOW.address, threadId: "thread-wrote-work" })).toEqual({
          sender: true,
          thread: true,
        });
        expect(await writer.ownerWrote(workMail, { sender: PIPPA.address, threadId: "thread-wrote-owner" })).toEqual({
          sender: false,
          thread: false,
        });

        // It writes nothing.
        expect(lines(await snapshot(db))).toEqual(before);
      }));

    it("ownerWrote sends no statement that reads a sealed column", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const toPippa = sent("gm-sealed-sent", {
          threadId: "thread-sealed-owner",
          to: [PIPPA],
          text: "Tuesday suits.",
        });
        expect(await ingest(writer, personalMail, toPippa)).toBe("stored");
        const before = lines(await snapshot(db));

        const { result, statements } = await recordingStatements(async () => [
          await writer.ownerWrote(personalMail, { sender: PIPPA.address, threadId: "thread-sealed-owner" }),
          await writer.ownerWrote(personalMail, { sender: TOBIAS.address, threadId: "thread-nobody-holds" }),
          await writer.ownerWrote(personalMail, {}),
        ]);
        expect(result).toEqual([
          { sender: true, thread: true },
          { sender: false, thread: false },
          { sender: false, thread: false },
        ]);

        // The control for the recorder: it saw the statements that answered, on the two tables
        // the rule names.
        const texts = statements.map((statement) => statement.text);
        expect(texts.some((text) => /vault\.sent_recipients/i.test(text))).toBe(true);
        expect(texts.some((text) => /vault\.evidence_items/i.test(text))).toBe(true);
        // None names a sealed column, a payload or every column, and none writes.
        for (const text of texts) {
          expect(namesSealed(text), text).toBe(false);
          expect(/\b(insert|update|delete)\b/i.test(text), text).toBe(false);
          expect(/knowledge\./i.test(text), text).toBe(false);
        }
        // No value it sent is an address in clear: an address reaches the database as its fingerprint.
        for (const statement of statements)
          expect(JSON.stringify(statement.values).toLowerCase(), statement.text).not.toContain("@");
        expect(lines(await snapshot(db))).toEqual(before);
        // And the recorder does see a sealed column when one is read: the control for the pattern.
        const reading = await recordingStatements(() => writer.cursor(personalMail));
        expect(reading.statements.some((statement) => namesSealed(statement.text))).toBe(true);
      }));

    it("senderWrittenTo is true exactly when a stored message the owner sent from the same account names the sender", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar, workMail } = await connect(writer);
        const secondAddress = "odalys.second@second-home.test";
        const secondMail = await writer.ensureSourceAccount("second", "google_mail", "own", secondAddress);
        const people = Object.fromEntries(
          ["a", "b", "c", "d", "e", "f"].map((letter) => [
            letter,
            { address: `written-${letter}@correspondents.test` },
          ]),
        ) as Record<"a" | "b" | "c" | "d" | "e" | "f", Who>;

        // What the writer hands `derive` for a new message from `sender` under `account`.
        let probes = 0;
        const asked = async (
          account: SourceAccountRow,
          raw: RawItem,
          facts: (ctx: ItemContext) => Promise<ItemFacts>,
        ): Promise<boolean> => {
          const seen: (boolean | undefined)[] = [];
          await writer.ingestItem(account, raw, (ctx) => {
            seen.push(ctx.senderWrittenTo);
            return facts(ctx);
          });
          expect(seen).toHaveLength(1);
          // Absent is false.
          return seen[0] === true;
        };
        const writtenTo = (account: SourceAccountRow, sender: Who): Promise<boolean> => {
          probes += 1;
          const owner = account.compartment === "own" ? ME : ME_AT_WORK;
          const fixture = received(`gm-probe-${String(probes).padStart(3, "0")}`, {
            from: sender,
            to: [owner],
            at: "2026-09-25T09:00:00Z",
          });
          return asked(account, mailItem(fixture, account), mailFacts(fixture));
        };

        // Nothing sent yet.
        expect(await writtenTo(personalMail, people.a)).toBe(false);

        // A message under SENT and SPAM that names the address is not mail the owner sent.
        expect(
          await ingest(
            writer,
            personalMail,
            sent("gm-swt-spam", { to: [people.a], labels: ["SENT", "SPAM"], reads: "bulk" }),
          ),
        ).toBe("stored");
        expect(await writtenTo(personalMail, people.a)).toBe(false);

        // A sent message of another account in the same compartment: true there, false here.
        expect(
          await ingest(writer, secondMail, sent("gm-swt-second", { from: { address: secondAddress }, to: [people.a] })),
        ).toBe("stored");
        expect(await writtenTo(personalMail, people.a)).toBe(false);
        expect(await writtenTo(secondMail, people.a)).toBe(true);

        // A sent message in another compartment: true there, false here.
        expect(await ingest(writer, workMail, sent("gm-swt-work", { from: ME_AT_WORK, to: [people.a] }))).toBe(
          "stored",
        );
        expect(await writtenTo(personalMail, people.a)).toBe(false);
        expect(await writtenTo(workMail, people.a)).toBe(true);

        // A sent message that is bulk counts.
        expect(
          await ingest(
            writer,
            personalMail,
            sent("gm-swt-bulk", { to: [people.b], labels: ["SENT", "CATEGORY_PROMOTIONS"], reads: "bulk" }),
          ),
        ).toBe("stored");
        expect(await writtenTo(personalMail, people.b)).toBe(true);
        expect(await writtenTo(workMail, people.b)).toBe(false);

        // So does one sent from an owner address with a role local part, which the shared rule
        // makes bulk.
        expect(
          await ingest(
            writer,
            personalMail,
            sent("gm-swt-role", { from: { address: "info@hearth-canary.test" }, to: [people.c], reads: "bulk" }),
          ),
        ).toBe("stored");
        expect(await writtenTo(personalMail, people.c)).toBe(true);

        // To, Cc and Bcc alike: a Bcc recipient counts.
        expect(
          await ingest(
            writer,
            personalMail,
            sent("gm-swt-three", { to: [people.d], cc: [people.e], bcc: [people.f, GUEST] }),
          ),
        ).toBe("stored");
        for (const who of [people.d, people.e, people.f])
          expect(await writtenTo(personalMail, who), who.address).toBe(true);

        // And at last from this account to the first address: now it is true here.
        expect(await ingest(writer, personalMail, sent("gm-swt-first", { to: [people.a] }))).toBe("stored");
        expect(await writtenTo(personalMail, people.a)).toBe(true);
        // Someone the owner never wrote to is still false: the control for every true above.
        expect(await writtenTo(personalMail, { address: "never-written@correspondents.test" })).toBe(false);

        // False for an event, whoever organizes it: the guest was written to above, by Bcc.
        expect(await writer.ownerWrote(personalMail, { sender: GUEST.address })).toEqual({
          sender: true,
          thread: false,
        });
        expect(await asked(personalCalendar, eventItem(EVENTS.guest, personalCalendar), eventFacts(EVENTS.guest))).toBe(
          false,
        );
        // And for an item with no sender.
        const { from: _from, ...noSender } = received("gm-swt-no-sender", { reads: "unread" });
        const raw = mailItem(noSender, personalMail);
        expect(raw.sender).toBeUndefined();
        expect(await asked(personalMail, raw, mailFacts(noSender))).toBe(false);

        // The answer `derive` was given is `ownerWrote`'s first answer, for each case above.
        expect((await writer.ownerWrote(personalMail, { sender: people.b.address })).sender).toBe(true);
        expect((await writer.ownerWrote(workMail, { sender: people.b.address })).sender).toBe(false);
        expect(
          one(await admin<{ n: number }>(db, "select count(distinct account_id)::int as n from vault.sent_recipients"))
            .n,
        ).toBe(3);
      }));

    it("a message under SENT and SPAM makes no owner address and no recipient row, even when handed to the writer", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const forged: Who = { address: "o.forged@forged-sender.test" };
        const honest: Who = { address: "o.honest@honest-sender.test" };
        const spam = sent("gm-sent-spam", {
          from: forged,
          to: [PIPPA],
          labels: ["SENT", "SPAM"],
          reads: "bulk",
          threadId: "thread-sent-spam",
        });
        const owners = (await writer.ownerAddresses()).sort();
        const before = await rowCounts(db);

        // Sync never hands it over; the writer tests it itself all the same.
        expect(await ingest(writer, personalMail, spam)).toBe("stored");

        expect((await writer.ownerAddresses()).sort()).toEqual(owners);
        expect(await accountRows(db, forged)).toBe(0);
        expect(await recipientRows(db)).toEqual([]);
        expect(await writer.ownerWrote(personalMail, { sender: PIPPA.address, threadId: "thread-sent-spam" })).toEqual({
          sender: false,
          thread: false,
        });
        // It is stored as what it is: a bulk message someone else sent.
        expect(changed(before, await rowCounts(db))).toEqual({
          "vault.evidence_items": 1,
          "vault.evidence_blobs": 1,
          "knowledge.messages": 1,
        });
        expect(
          await admin(db, "select sender_member from vault.evidence_items where id = $1", [
            evidenceIdOf(personalMail, mailSourceId(spam)),
          ]),
        ).toEqual([{ sender_member: null }]);
        expect(one(await rowsOf(db, personalMail, spam))).toMatchObject({ direction: "inbound", bulk: true });

        // The positive control: the same message under SENT alone makes its sender the owner's
        // and has its recipient row.
        const real = sent("gm-sent-real", { from: honest, to: [PIPPA], reads: "bulk", threadId: "thread-sent-real" });
        expect(await ingest(writer, personalMail, real)).toBe("stored");
        expect((await writer.ownerAddresses()).sort()).toEqual([...owners, honest.address].sort());
        expect(await recipientRows(db)).toEqual(
          recipientsOf(db, personalMail, evidenceIdOf(personalMail, mailSourceId(real)), [PIPPA]),
        );
        expect(await writer.ownerWrote(personalMail, { sender: PIPPA.address, threadId: "thread-sent-real" })).toEqual({
          sender: true,
          thread: true,
        });
      }));

    it("the recipient rows go with their message", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // Pippa is named twice, on To and on Cc: one row.
        const first = sent("gm-recipients-first", { to: [PIPPA, TOBIAS], cc: [PIPPA, MARLOW], bcc: [RHEA] });
        const other = sent("gm-recipients-other", { to: [QUENTIN] });
        const revision = (n: number): string => evidenceIdOf(personalMail, mailSourceId(first), n);
        const otherRows = recipientsOf(db, personalMail, evidenceIdOf(personalMail, mailSourceId(other)), [QUENTIN]);
        const sorted = (rows: RecipientRow[]): RecipientRow[] => byRecipient(rows);

        expect(await ingest(writer, personalMail, first)).toBe("stored");
        expect(await ingest(writer, personalMail, other)).toBe("stored");
        // One row for each To, Cc and Bcc address, written with the evidence row it cites.
        expect(await recipientRows(db)).toEqual(
          sorted([...recipientsOf(db, personalMail, revision(0), [PIPPA, TOBIAS, MARLOW, RHEA]), ...otherRows]),
        );
        const together = await admin<{ recipient: string; evidence: string }>(
          db,
          "select r.xmin::text as recipient, e.xmin::text as evidence from vault.sent_recipients r join vault.evidence_items e on e.id = r.evidence_id",
        );
        for (const row of together) expect(row.recipient).toBe(row.evidence);
        expect(await writer.ownerWrote(personalMail, { sender: TOBIAS.address })).toEqual({
          sender: true,
          thread: false,
        });

        // A new revision replaces the rows the earlier one had: they cite it, and name whom it names.
        const again: MailFixture = { ...first, to: [PIPPA], cc: [GUEST], bcc: [] };
        expect(await writer.ingestItem(personalMail, mailRevision(again, personalMail), mailFacts(again))).toBe(
          "stored",
        );
        expect(await recipientRows(db)).toEqual(
          sorted([...recipientsOf(db, personalMail, revision(1), [PIPPA, GUEST]), ...otherRows]),
        );
        expect(await writer.ownerWrote(personalMail, { sender: TOBIAS.address })).toEqual({
          sender: false,
          thread: false,
        });
        expect(await writer.ownerWrote(personalMail, { sender: GUEST.address })).toEqual({
          sender: true,
          thread: false,
        });

        // A revision that is no longer mail the owner sent has none.
        const spammed: MailFixture = { ...again, labels: ["SENT", "SPAM"], reads: "bulk" };
        expect(await ingest(writer, personalMail, spammed)).toBe("stored");
        expect(await recipientRows(db)).toEqual(otherRows);
        expect(await writer.ownerWrote(personalMail, { sender: PIPPA.address })).toEqual({
          sender: false,
          thread: false,
        });

        // A deletion removes them with the message. The other message's row is the control: it
        // stays until its own message is deleted.
        expect(await ingest(writer, personalMail, first)).toBe("stored");
        expect(await recipientRows(db)).toEqual(
          sorted([...recipientsOf(db, personalMail, revision(3), [PIPPA, TOBIAS, MARLOW, RHEA]), ...otherRows]),
        );
        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: mailSourceId(first),
          deletedAt: NOW,
        });
        expect(await recipientRows(db)).toEqual(otherRows);
        expect(await writer.ownerWrote(personalMail, { sender: QUENTIN.address })).toEqual({
          sender: true,
          thread: false,
        });
        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: mailSourceId(other),
          deletedAt: NOW,
        });
        expect(await recipientRows(db)).toEqual([]);
        expect(await writer.ownerWrote(personalMail, { sender: QUENTIN.address })).toEqual({
          sender: false,
          thread: false,
        });
      }));
  });

  describe("rederiveIfNeeded, with a row for every message", () => {
    it("a re-derive gives a message row for every stored email, takes the owner's sent mail first and reads 25 items at a time", () =>
      withPair(async (knewFirst, learnedAfter) => {
        // 58 messages, more than two reads of 25: in turn one a person wrote (the address that
        // becomes the owner's among them), one the owner sent, one bulk, and one more received;
        // and one item that is unread.
        const fixtures = Array.from({ length: 58 }, (_, index) => {
          const n = String(index + 1).padStart(3, "0");
          const at = new Date(Date.parse("2026-07-01T00:00:00Z") + index * 60_000).toISOString();
          const base = {
            id: `gm-rederive-rows-${n}`,
            threadId: `thread-rederive-rows-${n}`,
            at,
            subject: `Rows ${n}`,
            text: `Body of ${n}.`,
          };
          if (index === 9) return mail(received(base.id, { ...base, reads: "unread" }));
          if (index % 4 === 0)
            return mail(received(base.id, { ...base, from: [LATER_OWNER, QUENTIN, RHEA][(index / 4) % 3] as Who }));
          if (index % 4 === 1) return mail(sent(base.id, { ...base, to: [index % 8 === 1 ? QUENTIN : RHEA] }));
          if (index % 4 === 2)
            return mail(
              received(base.id, { ...base, from: RECEIPTS, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" }),
            );
          return mail(received(base.id, { ...base, from: RHEA, cc: [LATER_OWNER] }));
        });
        const isSent = (fixture: MailFixture): boolean => fixture.labels.includes("SENT");
        const emails = fixtures.filter((fixture) => fixture.reads !== "unread");

        const first = await rederived(knewFirst, "first", fixtures);
        expect(first.result).toEqual({ rederived: false, items: 0, coarser: 0 });
        expect(first.order).toEqual([]);
        const after = await rederived(learnedAfter, "after", fixtures);
        // Every latest revision is derived again, the bulk ones and the unread one included.
        expect(after.result).toEqual({ rederived: true, items: fixtures.length, coarser: 0 });

        // The owner's sent mail first, then the rest, each group in the order it was stored.
        expect(after.order).toEqual(
          [...fixtures.filter(isSent), ...fixtures.filter((fixture) => !isSent(fixture))].map(mailSourceId),
        );

        // No statement brought back more than 25 rows, and one did bring 25.
        expect(mostRows(after.statements)).toBe(25);

        // A message row for every stored email, bulk or not, and none for the unread item.
        for (const db of [knewFirst, learnedAfter]) {
          const account = db === knewFirst ? first.account : after.account;
          const cited = (await admin<{ evidence_id: string }>(db, "select evidence_id from knowledge.messages"))
            .map((row) => row.evidence_id)
            .sort();
          expect(cited).toEqual(emails.map((fixture) => evidenceIdOf(account, mailSourceId(fixture))).sort());
          expect(
            one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.messages where bulk")).n,
          ).toBe(fixtures.filter((fixture) => fixture.reads === "bulk").length);
        }
        // The same rows as the store that knew the address from the start.
        expect(await rowCounts(learnedAfter)).toEqual(await rowCounts(knewFirst));
        expect(await comparableRows(learnedAfter)).toEqual(await comparableRows(knewFirst));
        // And what they agree on: the address is the owner's alone.
        expect(
          await admin(
            learnedAfter,
            "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
            [fp(learnedAfter, "address", LATER_OWNER.address)],
          ),
        ).toEqual([{ kind: "owner" }]);
      }));

    it("a re-derive holds one payload at a time", () =>
      withPair(async (knewFirst, learnedAfter) => {
        const fixtures = Array.from({ length: 60 }, (_, index) => {
          const n = String(index + 1).padStart(3, "0");
          const at = new Date(Date.parse("2026-07-02T00:00:00Z") + index * 60_000).toISOString();
          const base = {
            id: `gm-rederive-payload-${n}`,
            threadId: `thread-rederive-payload-${n}`,
            at,
            subject: `Payload ${n}`,
            text: `Body of ${n}.`,
          };
          if (index % 3 === 0)
            return mail(received(base.id, { ...base, from: [LATER_OWNER, QUENTIN][(index / 3) % 2] as Who }));
          if (index % 3 === 1) return mail(sent(base.id, { ...base, to: [RHEA] }));
          return mail(
            received(base.id, { ...base, from: RECEIPTS, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" }),
          );
        });

        expect((await rederived(knewFirst, "first", fixtures)).result).toEqual({
          rederived: false,
          items: 0,
          coarser: 0,
        });
        const { result, statements } = await rederived(learnedAfter, "after", fixtures);
        expect(result).toEqual({ rederived: true, items: 60, coarser: 0 });
        const blobRefs = (await admin<{ blob_ref: string }>(learnedAfter, "select blob_ref from vault.evidence_items"))
          .map((row) => row.blob_ref)
          .sort();
        expect(blobRefs).toHaveLength(60);

        // The cursor's statement, which reads the evidence rows with their `item_enc`, names
        // neither the blobs' table nor a payload.
        const evidenceReads = statements.filter((statement) => /\bitem_enc\b/i.test(statement.text));
        expect(evidenceReads.length).toBeGreaterThan(0);
        for (const statement of evidenceReads)
          expect(/evidence_blobs|\benvelope\b/i.test(statement.text), statement.text).toBe(false);

        // Every statement that reads `vault.evidence_blobs` names one `blob_ref` and brings back
        // one row: one statement for each stored item, and each blob read once.
        const blobReads = statements.filter((statement) => /evidence_blobs/i.test(statement.text));
        for (const statement of blobReads) {
          expect(statement.text, statement.text).toMatch(/\bblob_ref\b/i);
          expect(statement.values, statement.text).toHaveLength(1);
          expect(statement.rows, statement.text).toBe(1);
        }
        expect(blobReads.map((statement) => String(statement.values[0])).sort()).toEqual(blobRefs);
        // So no statement that names a payload brought back more than one row, and none of any
        // kind more than 25.
        for (const statement of statements.filter((one) => /\benvelope\b/i.test(one.text)))
          expect(statement.rows, statement.text).toBeLessThanOrEqual(1);
        expect(mostRows(statements)).toBe(25);

        // The rows after it equal those of the database that knew the address first.
        expect(await rowCounts(learnedAfter)).toEqual(await rowCounts(knewFirst));
        expect(await comparableRows(learnedAfter)).toEqual(await comparableRows(knewFirst));
      }));

    it("a re-derive's senderWrittenTo does not depend on the order of revisions", () =>
      withPair(async (conditionalFirst, sentFirst) => {
        // A Social message from Pippa, kept for its thread: bulk unless the owner has written to
        // Pippa. The owner's message to Pippa. And, to make a re-derive needed, one message from an
        // address that then becomes the owner's.
        const conditional = mail(
          received("gm-order-conditional", {
            from: PIPPA,
            labels: ["INBOX", "CATEGORY_SOCIAL"],
            reads: "conditional",
            threadId: "thread-order-social",
            text: "Pippa mentioned you.",
          }),
        );
        const toPippa = mail(
          sent("gm-order-sent", { to: [PIPPA], at: "2026-09-20T10:00:00Z", threadId: "thread-order-sent" }),
        );
        const fromLater = mail(received("gm-order-later", { from: LATER_OWNER, at: "2026-09-20T08:00:00Z" }));

        const load = (db: TestDatabase, order: MailFixture[]) =>
          withWriter(db, async (writer) => {
            const account = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
            const told: Record<string, boolean> = {};
            for (const fixture of order) {
              const raw = mailItem(fixture, account);
              expect(
                await writer.ingestItem(account, raw, (ctx) => {
                  told[fixture.id] = ctx.senderWrittenTo === true;
                  return derive(raw, ctx);
                }),
              ).toBe("stored");
            }
            const before = one(await rowsOf(db, account, conditional));
            const beforeInteractions = await interactionsOf(db, account, conditional);
            await writer.ensureSourceAccount("second", "google_mail", "own", LATER_OWNER.address);
            const again: Record<string, boolean> = {};
            const result = await writer.rederiveIfNeeded((raw, ctx) => {
              again[raw.sourceItemId] = ctx.senderWrittenTo === true;
              return derive(raw, ctx);
            });
            const after = one(await rowsOf(db, account, conditional));
            return {
              told,
              before,
              beforeInteractions,
              result,
              again,
              after,
              afterInteractions: await interactionsOf(db, account, conditional),
            };
          });

        // Stored before the sent message that names its sender: bulk until the re-derive, and
        // that person's after it.
        const early = await load(conditionalFirst, [fromLater, conditional, toPippa]);
        expect(early.told[conditional.id]).toBe(false);
        expect(early.before).toMatchObject({ bulk: true, category: "social" });
        expect(early.beforeInteractions).toBe(0);
        expect(early.result).toEqual({ rederived: true, items: 3, coarser: 0 });
        expect(early.again[mailSourceId(conditional)]).toBe(true);
        expect(early.after).toMatchObject({ bulk: false, category: "social" });
        expect(early.afterInteractions).toBe(1);

        // The same items stored in the other order: that person's from the start, and after it.
        const late = await load(sentFirst, [fromLater, toPippa, conditional]);
        expect(late.told[conditional.id]).toBe(true);
        expect(late.before).toMatchObject({ bulk: false, category: "social" });
        expect(late.beforeInteractions).toBe(1);
        expect(late.result).toEqual({ rederived: true, items: 3, coarser: 0 });
        expect(late.again[mailSourceId(conditional)]).toBe(true);

        // The same rows after it, whichever came first.
        expect(await rowCounts(conditionalFirst)).toEqual(await rowCounts(sentFirst));
        expect(await comparableRows(conditionalFirst)).toEqual(await comparableRows(sentFirst));
      }));
  });

  describe("finishPage counts every id a listing named, fetched or not", () => {
    it("an id named without an item counts as listed", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // Three stored messages. A reconciling listing hands the first over again, names the
        // second by its id alone (it is older than the window, and is not fetched), and names
        // an id that was never stored. The third it does not name at all.
        const [handedOver, namedOnly, unlisted] = [
          received("gm-listed-handed"),
          received("gm-listed-named", { from: TOBIAS }),
          received("gm-listed-unlisted", { from: MARLOW }),
        ];
        for (const fixture of [handedOver, namedOnly, unlisted])
          expect(await ingest(writer, personalMail, fixture)).toBe("stored");
        const [a, b] = [handedOver, namedOnly, unlisted].map(mailSourceId) as [string, string, string];
        const neverStored = "gmail-id:older-than-the-window-0001";
        const namedRow = one(await rowsOf(db, personalMail, namedOnly));

        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [a, b, neverStored],
            skippedIds: [],
            next: cursor("named-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        // Each id the page named has its row, whether or not an item came with it.
        expect(await listedRows(db, personalMail)).toEqual(fps(db, a, b, neverStored));

        expect(
          await writer.finishPage(personalMail, {
            listing: { first: false, ended: "complete" },
            listedIds: [],
            skippedIds: [],
            next: cursor("named-2"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        // The one named by its id alone stays, untouched; the one not named is removed.
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a, b));
        expect(one(await rowsOf(db, personalMail, namedOnly))).toEqual(namedRow);
        expect(await accountRows(db, TOBIAS)).toBe(1);
        expect(await accountRows(db, MARLOW)).toBe(0);
        // An id named without an item makes no item.
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from vault.evidence_items")).n).toBe(2);
        expect(await listedRows(db, personalMail)).toEqual([]);

        // The control: the next complete listing does not name it, and it is removed.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true, ended: "complete" },
            listedIds: [a],
            skippedIds: [],
            next: cursor("named-3"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a));
      }));
  });

  describe("no column holds an unkeyed hash of content", () => {
    it("the content hash and the body hash are stored as keyed fingerprints", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const body = "Tuesday suits. I will bring the brass key.\n\nOn Monday Pippa wrote:\n> Does Tuesday suit?\n";
        const sentOnce = sent("gm-hash-sent-one", { to: [PIPPA, TOBIAS], text: body });
        const sentTwice = sent("gm-hash-sent-two", { to: [MARLOW], text: body });
        const answer = received("gm-hash-received", { text: body });
        for (const fixture of [sentOnce, sentTwice, answer])
          expect(await ingest(writer, personalMail, fixture)).toBe("stored");
        const payloadHash = (fixture: MailFixture): string =>
          createHash("sha256")
            .update(Buffer.from(mailItem(fixture, personalMail).payload, "base64"))
            .digest("hex");
        const bodyHash = await messageBodyHash(body);

        // The control for the formula these fingerprints are compared with: for a kind the store
        // already has, it gives what the store's own function gives.
        expect(hashFingerprint(db.keys, "thread", "thread-formula-control")).toBe(
          fingerprint(db.keys, "thread", "thread-formula-control"),
        );

        // `content_hash`: the `content_hash` fingerprint of the payload's hash, never the hash.
        for (const fixture of [sentOnce, sentTwice, answer]) {
          const stored = one(
            await admin<{ content_hash: string }>(db, "select content_hash from vault.evidence_items where id = $1", [
              evidenceIdOf(personalMail, mailSourceId(fixture)),
            ]),
          ).content_hash;
          expect(stored, fixture.id).toBe(hashFingerprint(db.keys, "content_hash", payloadHash(fixture)));
          expect(stored, fixture.id).not.toBe(payloadHash(fixture));
          expect(stored, fixture.id).toMatch(/^[0-9a-f]{64}$/);
        }

        // `body_hash`: on each outbound row, the `body_hash` fingerprint of the record's body
        // hash; on an inbound row, nothing.
        const hashes = async (fixture: MailFixture): Promise<(string | null)[]> =>
          (
            await admin<{ body_hash: string | null }>(
              db,
              "select body_hash from knowledge.interaction_log where evidence_id = $1",
              [evidenceIdOf(personalMail, mailSourceId(fixture))],
            )
          ).map((row) => row.body_hash);
        const keyed = hashFingerprint(db.keys, "body_hash", bodyHash);
        expect(keyed).not.toBe(bodyHash);
        expect(await hashes(sentOnce)).toEqual([keyed, keyed]);
        // A message sent twice still shows as equal.
        expect(await hashes(sentTwice)).toEqual([keyed]);
        expect(await hashes(answer)).toEqual([null]);
        // Each kind has its own fingerprint: the same hash under the other kind is not what is stored.
        expect(keyed).not.toBe(hashFingerprint(db.keys, "content_hash", bodyHash));
      }));
  });

  describe("a reply to a message the system itself sent is tagged when it is stored", () => {
    it("system_originated is false for every item the writer stores", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        // Received, sent, bulk, unread, and a calendar item.
        expect(await ingest(writer, personalMail, MAIL.fromQuentin)).toBe("stored");
        expect(await ingest(writer, personalMail, MAIL.reply)).toBe("stored");
        expect(await ingest(writer, personalMail, MAIL.newsletter)).toBe("stored");
        expect(await ingest(writer, personalMail, MAIL.unread)).toBe("unread");
        expect(
          await writer.ingestItem(
            personalCalendar,
            eventItem(EVENTS.canary, personalCalendar),
            eventFacts(EVENTS.canary),
          ),
        ).toBe("stored");

        const stored = await marks(db);
        expect(stored).toHaveLength(5);
        for (const row of stored)
          expect(row, row.id).toMatchObject({ system_originated: false, answers_system: false });
        // Both marks are on the evidence row and nowhere else.
        const elsewhere = await admin<{ place: string }>(
          db,
          `select n.nspname || '.' || c.relname || '.' || a.attname as place from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('policy', 'vault', 'knowledge') and c.relkind in ('r', 'p') and a.attnum > 0 and a.attname in ('system_originated', 'answers_system') order by 1`,
        );
        expect(elsewhere.map((row) => row.place)).toEqual([
          "vault.evidence_items.answers_system",
          "vault.evidence_items.system_originated",
        ]);
      }));

    it("a message from someone else in a thread that holds an earlier system-originated message is tagged as its answer", () =>
      withPair(async (marked, unmarked) => {
        const thread = "thread-r25-system";
        const at = (hour: string): string => `2026-09-21T${hour}:00Z`;
        // The message the system sent (in stage 1, a sent message the test marks), and the rest.
        const systemSent = mail(sent("gm-r25-sent", { threadId: thread, at: at("10:00"), to: [PIPPA] }));
        const later = mail(received("gm-r25-later", { threadId: thread, at: at("11:00"), from: PIPPA }));
        const laterRelabelled = mail({ ...later, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" });
        const earlier = mail(received("gm-r25-earlier", { threadId: thread, at: at("09:00"), from: TOBIAS }));
        const otherThread = mail(
          received("gm-r25-other-thread", { threadId: "thread-r25-other", at: at("11:10"), from: PIPPA }),
        );
        const noThread = mail(received("gm-r25-no-thread", { at: at("11:20"), from: PIPPA }));
        const ownerLater = mail(sent("gm-r25-owner-later", { threadId: thread, at: at("11:30"), to: [PIPPA] }));
        const otherAccount = mail(
          received("gm-r25-other-account", { threadId: thread, at: at("11:40"), from: PIPPA, to: [ME_AT_WORK] }),
        );

        const scenario = (db: TestDatabase, mark: boolean) =>
          withWriter(db, async (writer) => {
            const { personalMail, workMail } = await connect(writer);
            const id = (account: SourceAccountRow, fixture: MailFixture, revision = 0): string =>
              evidenceIdOf(account, mailSourceId(fixture), revision);
            expect(await ingestDeclared(writer, personalMail, mailItem(systemSent, personalMail))).toBe("stored");
            // What a later stage does when the system sends: here, by hand, as pi_admin.
            if (mark)
              await admin(db, "update vault.evidence_items set system_originated = true where id = $1", [
                id(personalMail, systemSent),
              ]);

            const { result, statements } = await recordingStatements(() =>
              ingestDeclared(writer, personalMail, mailItem(later, personalMail)),
            );
            expect(result).toBe("stored");
            // Received earlier and stored afterwards; in another thread; with no thread id; one
            // the owner sent in that thread; and the same thread id under another account.
            expect(await ingestDeclared(writer, personalMail, mailItem(earlier, personalMail))).toBe("stored");
            expect(await ingestDeclared(writer, personalMail, mailItem(otherThread, personalMail))).toBe("stored");
            const { threadId: _thread, ...threadless } = mailItem(noThread, personalMail);
            expect(await ingestDeclared(writer, personalMail, threadless)).toBe("stored");
            expect(await ingestDeclared(writer, personalMail, mailItem(ownerLater, personalMail))).toBe("stored");
            expect(await ingestDeclared(writer, workMail, mailItem(otherAccount, workMail))).toBe("stored");
            // A new revision of the tagged message, after a label change.
            expect(await ingestDeclared(writer, personalMail, mailItem(laterRelabelled, personalMail))).toBe("stored");

            const stored = new Map((await marks(db)).map((row) => [row.id, row]));
            const answers = (evidenceId: string): boolean | undefined => stored.get(evidenceId)?.answers_system;
            const tagged = {
              systemSent: answers(id(personalMail, systemSent)),
              later: answers(id(personalMail, later)),
              laterRelabelled: answers(id(personalMail, later, 1)),
              earlier: answers(id(personalMail, earlier)),
              otherThread: answers(id(personalMail, otherThread)),
              noThread: answers(id(personalMail, noThread)),
              ownerLater: answers(id(personalMail, ownerLater)),
              otherAccount: answers(id(workMail, otherAccount)),
            };
            const originated = [...stored.values()].filter((row) => row.system_originated).map((row) => row.id);

            // A re-derive leaves every row's marks as they were: Tobias's address becomes the owner's.
            const before = await marks(db);
            await writer.ensureSourceAccount("second", "google_mail", "own", TOBIAS.address);
            const again = await writer.rederiveIfNeeded(derive);
            return {
              tagged,
              originated,
              statements,
              before,
              again,
              after: await marks(db),
              sentId: id(personalMail, systemSent),
            };
          });

        const withMark = await scenario(marked, true);
        expect(withMark.tagged).toEqual({
          systemSent: false,
          later: true,
          laterRelabelled: true,
          earlier: false,
          otherThread: false,
          noThread: false,
          ownerLater: false,
          otherAccount: false,
        });
        // The writer itself stored `system_originated` false for every item: the one true is the test's.
        expect(withMark.originated).toEqual([withMark.sentId]);
        expect(withMark.again.rederived).toBe(true);
        expect(withMark.after).toEqual(withMark.before);

        // The statement that decides the tag reads no sealed column: it answers from clear
        // evidence columns alone.
        const deciding = withMark.statements.filter(
          (statement) => /^\s*(select|with)\b/i.test(statement.text) && /\bsystem_originated\b/i.test(statement.text),
        );
        expect(deciding.length).toBeGreaterThan(0);
        for (const statement of deciding) {
          expect(namesSealed(statement.text), statement.text).toBe(false);
          expect(/knowledge\.|evidence_blobs/i.test(statement.text), statement.text).toBe(false);
        }

        // With no system-originated row, the same messages are all stored with it false.
        const withoutMark = await scenario(unmarked, false);
        expect(withoutMark.tagged).toEqual({
          systemSent: false,
          later: false,
          laterRelabelled: false,
          earlier: false,
          otherThread: false,
          noThread: false,
          ownerLater: false,
          otherAccount: false,
        });
        expect(withoutMark.originated).toEqual([]);
        expect(withoutMark.after).toEqual(withoutMark.before);
      }));
  });

  describe("a held message reaches no client", () => {
    it("a message whose facts say held is stored held, and a released one stays released across a revision and a re-derive", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const heldPerson = mail(
          received("gm-r26-held", {
            from: PIPPA,
            held: true,
            subject: "Your sign-in code",
            text: "Your code is 000000.",
          }),
        );
        const heldBulk = mail(
          received("gm-r26-held-bulk", {
            from: { address: "no-reply@accounts-example.test" },
            labels: ["INBOX", "CATEGORY_UPDATES"],
            reads: "bulk",
            held: true,
            subject: "Reset your password",
          }),
        );
        const free = mail(received("gm-r26-free", { from: TOBIAS, held: false }));
        const released = mail(received("gm-r26-released", { from: PIPPA, held: true, subject: "Your recovery link" }));
        // The same two messages after a label change, their facts still saying held.
        const heldPersonMoved = mail({ ...heldPerson, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" });
        const releasedMoved = mail({ ...released, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" });
        const held = async (): Promise<Record<string, boolean>> => ({
          heldPerson: one(await rowsOf(db, personalMail, heldPerson)).held,
          heldBulk: one(await rowsOf(db, personalMail, heldBulk)).held,
          free: one(await rowsOf(db, personalMail, free)).held,
          released: one(await rowsOf(db, personalMail, released)).held,
        });
        const releasedAt = async (fixture: MailFixture, revision: number): Promise<string | null> => {
          const row = one(
            await admin<{ at: Date | null }>(
              db,
              "select hold_released_at as at from vault.evidence_items where id = $1",
              [evidenceIdOf(personalMail, mailSourceId(fixture), revision)],
            ),
          );
          return row.at === null ? null : iso(row.at);
        };

        // Facts with `held` true give a row with `held` true, and with false, false.
        for (const fixture of [heldPerson, heldBulk, free, released])
          expect(await ingestDeclared(writer, personalMail, mailItem(fixture, personalMail))).toBe("stored");
        expect(await held()).toEqual({ heldPerson: true, heldBulk: true, free: false, released: true });
        expect((await marks(db)).map((row) => row.hold_released_at)).toEqual([null, null, null, null]);
        // A held message is stored and derived as any other: its person and its interaction row.
        expect(await interactionsOf(db, personalMail, heldPerson)).toBe(1);

        // The owner releases one: the time on its evidence row, set here as pi_admin.
        const when = "2026-09-22T08:00:00.000Z";
        await admin(db, "update vault.evidence_items set hold_released_at = $1 where id = $2", [
          when,
          evidenceIdOf(personalMail, mailSourceId(released)),
        ]);

        // A new revision whose facts say held copies the time and is stored with `held` false;
        // a message never released is held again.
        expect(await ingestDeclared(writer, personalMail, mailItem(releasedMoved, personalMail))).toBe("stored");
        expect(await ingestDeclared(writer, personalMail, mailItem(heldPersonMoved, personalMail))).toBe("stored");
        expect(await releasedAt(released, 0)).toBe(when);
        expect(await releasedAt(released, 1)).toBe(when);
        expect(await releasedAt(heldPerson, 1)).toBeNull();
        expect(await held()).toEqual({ heldPerson: true, heldBulk: true, free: false, released: false });
        expect(one(await rowsOf(db, personalMail, released)).evidence_id).toBe(
          evidenceIdOf(personalMail, mailSourceId(released), 1),
        );

        // So is the row a re-derive rebuilds: Tobias's address becomes the owner's.
        const before = await marks(db);
        await writer.ensureSourceAccount("second", "google_mail", "own", TOBIAS.address);
        expect(await writer.rederiveIfNeeded(derive)).toEqual({ rederived: true, items: 4, coarser: 0 });
        expect(await held()).toEqual({ heldPerson: true, heldBulk: true, free: false, released: false });
        // The release is on the evidence row, which a re-derive never changes.
        expect(await marks(db)).toEqual(before);
        expect(await releasedAt(released, 1)).toBe(when);
      }));
  });
});
