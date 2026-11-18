import { createHash } from "node:crypto";
import type { RawItem } from "@intelligence/contracts";
import { PERSONAL_LIMITS, THE_OWNER } from "@intelligence/personal-core";
import { deriveItem, type ItemContext, type ItemFacts, type MessageFacts } from "@intelligence/personal-core/items";
import { describe, expect, it, vi } from "vitest";
import { connect, GUEST, OWNER, QUENTIN } from "../test-support/cast.ts";
import { insertClient } from "../test-support/clients.ts";
import { asOwner, one, readAs, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventItem, type MailFixture, mailItem, mailMessage, mailRevision } from "../test-support/items.ts";
import { EVENTS } from "../test-support/items-named.ts";
import { opened } from "../test-support/snapshot.ts";
import { withDatabase, withStore } from "../test-support/store.ts";
import type { SourceAccountRow } from "./writer-types.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The writer's own tests: two rulings its plan does not state, and the choices left to the writer.

const OWNER_TO = [{ address: "odalys.owner-canary@hearth-canary.test" }];

const received = (id: string, extra: Partial<MailFixture> = {}): MailFixture => ({
  id,
  threadId: `thread-${id}`,
  at: "2026-09-10T09:00:00Z",
  from: QUENTIN,
  to: OWNER_TO,
  subject: `Subject of ${id}`,
  labels: ["INBOX", "CATEGORY_UPDATES"],
  ...extra,
});

// Bulk facts for a fixture, written by hand: its message, with whatever a test says of it.
const bulk =
  (fixture: MailFixture, said: Partial<MessageFacts> = {}) =>
  async (): Promise<ItemFacts> => ({
    kind: "email",
    members: { participantMembers: [THE_OWNER] },
    bulk: true,
    message: { ...mailMessage(fixture), ...said },
  });

type MessageRow = {
  id: string;
  evidence_id: string;
  held: boolean;
  bulk: boolean;
  category: string;
  sender_fp: string | null;
  sender_domain_fp: string | null;
  sender_enc: unknown;
  sender_name_enc: unknown;
  body_enc: unknown;
  facts_enc: unknown;
};

const messages = (db: TestDatabase): Promise<MessageRow[]> =>
  queryAs<MessageRow>(db.urls.admin, "select * from knowledge.messages order by sent_at, id");

describe("the writer and migration, the implementer's own", () => {
  it("the reader's policy leaves a held message out, and the admin sees both", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const [shown, kept] = [received("gm-shown-0001"), received("gm-kept-0002", { at: "2026-09-10T10:00:00Z" })];
      await writer.ingestItem(personalMail, mailItem(shown, personalMail), bulk(shown));
      await writer.ingestItem(personalMail, mailItem(kept, personalMail), bulk(kept, { held: true }));

      // The positive control: both rows are there, one of them held, under one compartment.
      const all = await messages(db);
      expect(all.map((row) => ({ held: row.held }))).toEqual([{ held: false }, { held: true }]);
      expect(await queryAs(db.urls.writer, "select id from knowledge.messages")).toHaveLength(2);

      // A reader cleared for that compartment selects exactly the one that is not held, with no
      // clause of its own about the hold.
      const client = await insertClient(db, "cleared-for-own", ["own"]);
      const seen = await readAs(db, client.token, (query) =>
        query<{ id: string }>("select id from knowledge.messages order by id"),
      );
      expect(seen).toEqual([{ id: all[0]?.id }]);
      expect(await readAs(db, client.token, (query) => query("select id from knowledge.messages where held"))).toEqual(
        [],
      );
    }));

  it("a tool name is added by one plain insert, and a name already there is refused", () =>
    withDatabase(async (db) => {
      const insert = (name: string, suffix = "") =>
        asOwner(db, (query) => query(`insert into policy.tool_names (name) values ($1)${suffix}`, [name]));
      // The positive control: a new name goes in as pi_owner, as a later migration adds one.
      expect(await sqlState(() => insert("a_later_tool"))).toBeNull();
      expect(await sqlState(() => insert("search"))).toBe("23505");
      // With a conflict target the insert needs a select policy; the owner has one since the read
      // allowance reads which tools are reads, so it goes in.
      expect(await sqlState(() => insert("another_tool", " on conflict (name) do nothing"))).toBeNull();
      expect(await sqlState(() => insert("Not-A-Name"))).toBe("23514");
      // Nothing above was kept, read by the one role that may. database.db.test.ts holds the names to the contract.
      const names = await queryAs<{ name: string }>(db.urls.admin, "select name from policy.tool_names");
      const held = names.map((row) => row.name);
      expect(held).toEqual(expect.arrayContaining(["search"]));
      for (const refused of ["a_later_tool", "another_tool", "Not-A-Name"]) expect(held).not.toContain(refused);
    }));

  it("a message row holds its text, sender and facts sealed under itself, and the sender's two fingerprints in clear", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const fixture = received("gm-receipt-0003");
      const text = "Thank you for your order \u{1F9FE}. It ships on Thursday.";
      const attachments = [{ name: "receipt.pdf", type: "application/pdf", size: 20_481 }];
      const raw = mailItem(fixture, personalMail);
      await writer.ingestItem(
        personalMail,
        raw,
        bulk(fixture, { text, attachments, messageId: "<receipt-0003@lighthouse.test>" }),
      );
      // A second message whose facts name no sender and no text.
      const bare = received("gm-bare-0004", { at: "2026-09-10T11:00:00Z" });
      const { sender: _, ...noSender } = mailMessage(bare);
      await writer.ingestItem(personalMail, mailItem(bare, personalMail), async () => ({
        kind: "email",
        members: { participantMembers: [THE_OWNER] },
        bulk: true,
        message: noSender,
      }));

      const [row, other] = await messages(db);
      if (row === undefined || other === undefined) throw new Error("expected two message rows");
      const open = (column: string, value: unknown) =>
        opened(db, "own", { table: "knowledge.messages", id: row.id, column }, value);
      expect(row).toMatchObject({ bulk: true, category: "updates", held: false });
      expect(row.sender_fp).toBe(fingerprint(db.keys, "address", QUENTIN.address));
      expect(row.sender_domain_fp).toBe(fingerprint(db.keys, "domain", "lighthouse.test"));
      expect(open("sender_enc", row.sender_enc)).toBe(QUENTIN.address);
      expect(open("sender_name_enc", row.sender_name_enc)).toBe(QUENTIN.name);
      expect(open("body_enc", row.body_enc)).toBe(text);
      // The length is in code points: the receipt sign is one.
      expect(JSON.parse(open("facts_enc", row.facts_enc))).toEqual({
        chars: [...text].length,
        unreadable: false,
        attachments,
        messageId: "<receipt-0003@lighthouse.test>",
      });

      expect(other).toMatchObject({
        sender_fp: null,
        sender_domain_fp: null,
        sender_enc: null,
        sender_name_enc: null,
        body_enc: null,
      });
      expect(
        JSON.parse(
          opened(db, "own", { table: "knowledge.messages", id: other.id, column: "facts_enc" }, other.facts_enc),
        ),
      ).toEqual({ chars: 0, unreadable: false, attachments: [] });

      // The payload's hash is stored only as its keyed fingerprint.
      const plain = createHash("sha256").update(Buffer.from(raw.payload, "base64")).digest("hex");
      const stored = one(
        await queryAs<{ content_hash: string }>(
          db.urls.admin,
          "select content_hash from vault.evidence_items where id = $1",
          [row.evidence_id],
        ),
      );
      expect(stored.content_hash).toBe(fingerprint(db.keys, "content_hash", plain));
      expect(stored.content_hash).not.toBe(plain);
    }));

  it("a release is copied to the next revision as the database holds it, and a message never released is held again", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const [released, never] = [received("gm-code-0005"), received("gm-code-0006", { at: "2026-09-10T12:00:00Z" })];
      for (const fixture of [released, never])
        await writer.ingestItem(personalMail, mailItem(fixture, personalMail), bulk(fixture, { held: true }));
      const [first, second] = await messages(db);
      if (first === undefined || second === undefined) throw new Error("expected two message rows");
      expect([first.held, second.held]).toEqual([true, true]);

      // What a release does, as pi_admin: a time with microseconds on the evidence row.
      await queryAs(
        db.urls.admin,
        "update vault.evidence_items set hold_released_at = '2026-09-11T08:00:00.123456Z' where id = $1",
        [first.evidence_id],
      );
      for (const fixture of [released, never])
        await writer.ingestItem(personalMail, mailRevision(fixture, personalMail), bulk(fixture, { held: true }));

      const after = await messages(db);
      expect(after.map((row) => ({ id: row.id, held: row.held }))).toEqual([
        { id: first.id, held: false },
        { id: second.id, held: true },
      ]);
      const times = await queryAs<{ revision: number; released: string | null }>(
        db.urls.admin,
        `select e.revision, e.hold_released_at::text as released from vault.evidence_items e
         where e.source_item_fp = (select source_item_fp from vault.evidence_items where id = $1) order by e.revision`,
        [first.evidence_id],
      );
      expect(times).toHaveLength(2);
      expect(times[1]?.released).toBe(times[0]?.released);
      expect(times[0]?.released).toContain(".123456");
      const unreleased = await queryAs(
        db.urls.admin,
        "select 1 from vault.evidence_items where hold_released_at is not null and id <> all($1)",
        [[first.evidence_id, after[0]?.evidence_id]],
      );
      expect(unreleased).toEqual([]);
    }));
});

// The forged sender: Gmail's SENT and SPAM, with an owner address in From. Sync drops it as junk;
// here it is handed straight to the writer with the facts core's own `deriveItem` makes of it, as
// sync would derive them, so the writer is the guard if sync's junk test were ever wrong. Outbound,
// the owner as sender, recipient rows, an owner address and `ownerWrote().thread` follow
// `ownerSent` (SENT and not SPAM) alone.
describe("a message under SENT and SPAM with an owner address in From, handed to the writer", () => {
  type Stored = { direction: string; sender_member: string | null };
  const derive = (raw: RawItem) => (ctx: ItemContext) => deriveItem(raw, ctx, PERSONAL_LIMITS);
  const storedAs = async (db: TestDatabase, threadId: string): Promise<Stored> =>
    one(
      await queryAs<Stored>(
        db.urls.admin,
        "select m.direction, e.sender_member from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where m.thread_fp = $1",
        [fingerprint(db.keys, "thread", threadId)],
      ),
    );
  const recipientRows = async (db: TestDatabase): Promise<number> =>
    one(await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from vault.sent_recipients")).n;
  // The owner writing to Quentin, from the account's own address or from an alias no account has.
  const fromOwner = (
    id: string,
    labels: string[],
    from: { address: string; name?: string } = { address: OWNER.personal, name: OWNER.name },
  ): MailFixture => ({
    id,
    threadId: `thread-${id}`,
    at: "2026-09-12T09:00:00Z",
    from,
    to: [QUENTIN],
    subject: `Subject of ${id}`,
    labels,
  });

  it("(a) is stored inbound, with no owner sender, no recipient row and no owner address learned", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const forged = [
        fromOwner("gm-forged-0101", ["SENT", "SPAM"]),
        fromOwner("gm-forged-0102", ["SENT", "SPAM", "INBOX"], { address: OWNER.alias }),
      ];
      for (const fixture of forged) {
        const raw = mailItem(fixture, personalMail);
        expect(raw.addressees?.length).toBeGreaterThan(0);
        expect(await writer.ingestItem(personalMail, raw, derive(raw))).toBe("stored");
        const stored = await storedAs(db, fixture.threadId);
        expect(stored.direction).not.toBe("outbound");
        expect(stored.sender_member).not.toBe(THE_OWNER);
      }
      expect(await recipientRows(db)).toBe(0);
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);
    }));

  it("(b) does not make ownerWrote's thread answer true", () =>
    withStore(async ({ writer }) => {
      const { personalMail } = await connect(writer);
      const forged = fromOwner("gm-forged-0201", ["SENT", "SPAM"]);
      const raw = mailItem(forged, personalMail);
      expect(await writer.ingestItem(personalMail, raw, derive(raw))).toBe("stored");
      expect(await writer.ownerWrote(personalMail, { sender: QUENTIN.address, threadId: forged.threadId })).toEqual({
        sender: false,
        thread: false,
      });
    }));

  // Facts that disagree with the raw item are refused, as facts of another kind or another
  // revision are (checkFacts): the owner sent a message only when its labels say so, so facts
  // that name the owner as the sender of one under SENT and SPAM do not fit it.
  it("(d) facts written by hand that name the owner as its sender are refused, and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const asOwnerSent = (facts: ItemFacts): ItemFacts => ({
        ...facts,
        members: { ...facts.members, senderMember: THE_OWNER },
      });
      const forged = [
        fromOwner("gm-forged-0401", ["SENT", "SPAM"]),
        fromOwner("gm-forged-0402", ["SENT", "SPAM", "CATEGORY_UPDATES"], { address: OWNER.alias }),
      ];
      for (const fixture of forged) {
        const raw = mailItem(fixture, personalMail);
        const derived = async (ctx: ItemContext) => asOwnerSent(await deriveItem(raw, ctx, PERSONAL_LIMITS));
        await expect(writer.ingestItem(personalMail, raw, derived), fixture.id).rejects.toMatchObject({
          code: "invalid_facts",
        });
        await expect(
          writer.ingestItem(personalMail, raw, async () => asOwnerSent(await bulk(fixture)())),
          fixture.id,
        ).rejects.toMatchObject({ code: "invalid_facts" });
      }
      const rows = async (table: string) =>
        one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`)).n;
      expect([await rows("vault.evidence_items"), await rows("knowledge.messages"), await recipientRows(db)]).toEqual([
        0, 0, 0,
      ]);
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);
    }));

  // The record's direction decides the interaction rows' direction, so it is checked against
  // the labels as the sender member is: outbound exactly when ownerSent(raw). Core derives a
  // message under SENT and SPAM as bulk, with no record, so the outbound record here is the one
  // core makes of the same message without SPAM, with no owner sender, and the inbound one is
  // core's own of a SENT message, turned round.
  it("(e) facts written by hand whose record's direction disagrees with the labels are refused, and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const record = (facts: ItemFacts, direction: string) => {
        if (facts.kind !== "email" || facts.bulk || facts.record.direction !== direction)
          throw new Error(`expected an email's ${direction} record`);
        return facts;
      };
      const outboundUnderSpam =
        (fixture: MailFixture) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const facts = record(
            await deriveItem(
              mailItem({ ...fixture, labels: fixture.labels.filter((label) => label !== "SPAM") }, personalMail),
              ctx,
              PERSONAL_LIMITS,
            ),
            "outbound",
          );
          const { senderMember: _, ...members } = facts.members;
          return { ...facts, members };
        };
      const inboundUnderSent =
        (fixture: MailFixture) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const facts = record(await deriveItem(mailItem(fixture, personalMail), ctx, PERSONAL_LIMITS), "outbound");
          return { ...facts, record: { ...facts.record, direction: "inbound" } };
        };
      const cases: [MailFixture, (fixture: MailFixture) => (ctx: ItemContext) => Promise<ItemFacts>][] = [
        [fromOwner("gm-forged-0501", ["SENT", "SPAM"]), outboundUnderSpam],
        [fromOwner("gm-forged-0502", ["SENT", "SPAM", "INBOX"], { address: OWNER.alias }), outboundUnderSpam],
        [fromOwner("gm-real-0503", ["SENT"]), inboundUnderSent],
      ];
      for (const [fixture, forge] of cases) {
        await expect(
          writer.ingestItem(personalMail, mailItem(fixture, personalMail), forge(fixture)),
          fixture.id,
        ).rejects.toMatchObject({ code: "invalid_facts" });
      }
      const rows = async (table: string) =>
        one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`)).n;
      expect([
        await rows("vault.evidence_items"),
        await rows("knowledge.messages"),
        await rows("knowledge.interaction_log"),
        await recipientRows(db),
      ]).toEqual([0, 0, 0, 0]);
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);
    }));

  // Nothing of a refused item is written: no evidence, message, interaction, recipient or event row.
  const nothingWritten = async (db: TestDatabase): Promise<number[]> => {
    const rows = async (table: string) =>
      one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`)).n;
    return [
      await rows("vault.evidence_items"),
      await rows("knowledge.messages"),
      await rows("knowledge.interaction_log"),
      await recipientRows(db),
      await rows("knowledge.events"),
    ];
  };

  // An event's sender member is the owner exactly when the owner organizes it, as core decides
  // (by `self` or by an owner address). Core's own facts, with the sender member turned round:
  // dropped from an event the owner organizes, added to one a guest organizes.
  it("(f) facts written by hand whose event sender member disagrees with its organizer are refused, and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalCalendar } = await connect(writer);
      const turned =
        (raw: RawItem, organizes: boolean) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
          if (facts.kind !== "event" || (facts.members.senderMember === THE_OWNER) !== organizes)
            throw new Error("expected core's event facts");
          const { senderMember: _, ...members } = facts.members;
          return { ...facts, members: organizes ? members : { ...members, senderMember: THE_OWNER } };
        };
      for (const [fixture, organizes] of [
        [EVENTS.canary, true],
        [EVENTS.guest, false],
      ] as const) {
        const raw = eventItem(fixture, personalCalendar);
        await expect(
          writer.ingestItem(personalCalendar, raw, turned(raw, organizes)),
          fixture.event.id,
        ).rejects.toMatchObject({ code: "invalid_facts" });
      }
      expect(await nothingWritten(db)).toEqual([0, 0, 0, 0, 0]);
    }));

  // An email is bulk whenever personalBulk(raw, senderWrittenTo) says so, with the
  // senderWrittenTo core is handed. The facts are core's own of the same message without its
  // bulk marker, so they are not bulk: under Updates; under Social from a sender the owner has
  // not written to; and under SENT and SPAM, where they are (e)'s outbound facts turned inbound,
  // with no owner sender, so that only the bulk check can refuse them.
  it("(g) facts written by hand that call a bulk message not bulk are refused, and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const without =
        (fixture: MailFixture, marker: string) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const facts = await deriveItem(
            mailItem({ ...fixture, labels: fixture.labels.filter((label) => label !== marker) }, personalMail),
            ctx,
            PERSONAL_LIMITS,
          );
          if (facts.kind !== "email" || facts.bulk)
            throw new Error("expected core's facts of a message that is not bulk");
          if (facts.record.direction === "inbound") return facts;
          const { senderMember: _, ...members } = facts.members;
          return { ...facts, members, record: { ...facts.record, direction: "inbound" } };
        };
      const cases: [MailFixture, string][] = [
        [received("gm-bulk-0601"), "CATEGORY_UPDATES"],
        [received("gm-bulk-0602", { labels: ["INBOX", "CATEGORY_SOCIAL"] }), "CATEGORY_SOCIAL"],
        [fromOwner("gm-forged-0603", ["SENT", "SPAM"]), "SPAM"],
      ];
      for (const [fixture, marker] of cases) {
        await expect(
          writer.ingestItem(personalMail, mailItem(fixture, personalMail), without(fixture, marker)),
          fixture.id,
        ).rejects.toMatchObject({ code: "invalid_facts" });
      }
      expect(await nothingWritten(db)).toEqual([0, 0, 0, 0, 0]);
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);
    }));

  // A record's channel is the item's source kind: core's own facts of a message and of an
  // event, each with the other's channel.
  it("(h) facts written by hand whose record's channel is not the item's source kind are refused, and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, personalCalendar } = await connect(writer);
      const other =
        (raw: RawItem) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
          if (
            facts.kind === "unread" ||
            facts.kind === "contact" ||
            facts.kind === "document" ||
            facts.kind === "page" ||
            (facts.kind === "email" && facts.bulk) ||
            facts.record.channel !== raw.sourceKind
          )
            throw new Error("expected core's record");
          return { ...facts, record: { ...facts.record, channel: raw.sourceKind === "email" ? "calendar" : "email" } };
        };
      const items: [SourceAccountRow, RawItem][] = [
        [personalMail, mailItem(received("gm-channel-0701", { labels: ["INBOX"] }), personalMail)],
        [personalCalendar, eventItem(EVENTS.guest, personalCalendar)],
      ];
      for (const [account, raw] of items) {
        await expect(writer.ingestItem(account, raw, other(raw)), raw.sourceKind).rejects.toMatchObject({
          code: "invalid_facts",
        });
      }
      expect(await nothingWritten(db)).toEqual([0, 0, 0, 0, 0]);
    }));

  // checkFacts checks against the context as the writer read it, not as the derive left it. Each
  // derive loosens its context and then returns the facts that loosened context calls right:
  // the guest's address made an owner address, so the guest's event is the owner's to send; and
  // the owner said to have written to a Social sender, so the message is not bulk.
  it("(i) a derive that changes its context and returns facts that agree with the change is refused, at ingest and at a re-derive", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, personalCalendar } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const organizes =
        (raw: RawItem) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          ctx.ownerAddresses.push(GUEST.address);
          const facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
          if (facts.members.senderMember !== THE_OWNER) throw new Error("expected the guest's event to be the owner's");
          return facts;
        };
      const writtenTo =
        (raw: RawItem) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          ctx.senderWrittenTo = true;
          const facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
          if (facts.kind !== "email" || facts.bulk) throw new Error("expected facts that are not bulk");
          return facts;
        };
      const guest = eventItem(EVENTS.guest, personalCalendar);
      const social = mailItem(received("gm-social-0901", { labels: ["INBOX", "CATEGORY_SOCIAL"] }), personalMail);
      await expect(
        writer.ingestItem(personalCalendar, guest, organizes(guest)),
        "ownerAddresses",
      ).rejects.toMatchObject({ code: "invalid_facts" });
      await expect(writer.ingestItem(personalMail, social, writtenTo(social)), "senderWrittenTo").rejects.toMatchObject(
        { code: "invalid_facts" },
      );
      expect(await nothingWritten(db)).toEqual([0, 0, 0, 0, 0]);
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);

      // The same derives at a re-derive, over the two items stored as core derives them.
      const honest = (raw: RawItem) => (ctx: ItemContext) => deriveItem(raw, ctx, PERSONAL_LIMITS);
      expect(await writer.ingestItem(personalCalendar, guest, honest(guest))).toBe("stored");
      expect(await writer.ingestItem(personalMail, social, honest(social))).toBe("stored");
      await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
      for (const [what, loosen] of [
        ["ownerAddresses", organizes],
        ["senderWrittenTo", writtenTo],
      ] as const) {
        const derive = (raw: RawItem, ctx: ItemContext) =>
          raw.sourceKind === (what === "ownerAddresses" ? "calendar" : "email") ? loosen(raw)(ctx) : honest(raw)(ctx);
        await expect(writer.rederiveIfNeeded(derive), what).rejects.toMatchObject({ code: "invalid_facts" });
      }
      expect(await writer.rederiveIfNeeded((raw, ctx) => honest(raw)(ctx))).toMatchObject({
        rederived: true,
        items: 2,
      });
    }));

  it("(c) the control: the same messages under SENT without SPAM are outbound, written to Quentin, and teach the alias", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owners = (await writer.ownerAddresses()).sort();
      const real = [
        fromOwner("gm-real-0301", ["SENT"]),
        fromOwner("gm-real-0302", ["SENT", "INBOX"], { address: OWNER.alias }),
      ];
      for (const fixture of real) {
        const raw = mailItem(fixture, personalMail);
        expect(await writer.ingestItem(personalMail, raw, derive(raw))).toBe("stored");
        expect(await storedAs(db, fixture.threadId)).toEqual({ direction: "outbound", sender_member: THE_OWNER });
        expect(await writer.ownerWrote(personalMail, { sender: QUENTIN.address, threadId: fixture.threadId })).toEqual({
          sender: true,
          thread: true,
        });
      }
      expect(await recipientRows(db)).toBe(2);
      expect((await writer.ownerAddresses()).sort()).toEqual([...owners, OWNER.alias].sort());
    }));
});
