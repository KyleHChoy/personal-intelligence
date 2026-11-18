import { createHash } from "node:crypto";
import { ConnectorCursor, Envelope, type RawItem, type Resolution, SourceAccount } from "@intelligence/contracts";
import { EntityId, EventId, PersonalLogEvent, SourceAccountId } from "@intelligence/contracts/personal";
import { CONSUMER_DOMAINS, foldDomain, THE_OWNER } from "@intelligence/personal-core";
import { calendarItem, type ItemContext, type ItemFacts } from "@intelligence/personal-core/items";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  CANARIES,
  CANARY_PERSON,
  connect,
  GUEST,
  LATER_OWNER,
  OWNER,
  QUENTIN,
  RHEA,
  SOLO,
  type Who,
  WORK_ONLY,
} from "../test-support/cast.ts";
import { OWNER_ONLY } from "../test-support/catalogue.ts";
import { RESEARCH_KNOWLEDGE, syncedBy, tablesIn } from "../test-support/catalogue-grants.ts";
import { SEALED } from "../test-support/catalogue-work.ts";
import { hashFingerprint, insertClient, insertSecret } from "../test-support/clients.ts";
import { one, readAs, thrownBy } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import {
  ask,
  bodyHashOf,
  derive,
  type EventFixture,
  event,
  eventFacts,
  eventItem,
  ingestEvent,
  ingestMail,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailMessage,
  mailRevision,
  mailSourceId,
  NOW,
  resolveAddress,
} from "../test-support/items.ts";
import { allDayEvent, EVENTS, MAIL, plainEvent } from "../test-support/items-named.ts";
import { changed, comparableRows, lines, opened, rowCounts, snapshot } from "../test-support/snapshot.ts";
import { withDatabase, withStore, withWriter } from "../test-support/store.ts";
import { tampering } from "../test-support/tamper.ts";
import { evidenceIdOf, interactionId } from "../test-support/values.ts";
import { sourceAccountOf, type Writer } from "./writer.ts";
import type { IngestAnswer, SourceAccountRow } from "./writer-types.ts";

// Written from the design alone, through the writer's exported functions and SQL as pi_admin.

const TIMEOUT = 240_000;

// The knowledge tables whose rows cite an evidence item.
const CITING = ["knowledge.aliases", "knowledge.messages", "knowledge.interaction_log", "knowledge.events"];

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const cursor = (text: string): ConnectorCursor => ConnectorCursor.parse(text);
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const withoutPayload = ({ payload: _, ...rest }: RawItem): Omit<RawItem, "payload"> => rest;
const fromRegistry = (writer: Writer, account: SourceAccountRow, raw: RawItem): Promise<IngestAnswer> =>
  writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));

// The entity an address belongs to, whatever its compartments.
const entityOf = async (db: TestDatabase, who: Who): Promise<string> =>
  one(
    await admin<{ id: string }>(db, "select distinct entity_id as id from knowledge.accounts where value_fp = $1", [
      fingerprint(db.keys, "address", who.address),
    ]),
  ).id;

const ownerEntity = async (db: TestDatabase): Promise<string> =>
  one(await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'")).id;

const accountRows = async (db: TestDatabase, who: Who): Promise<number> =>
  one(
    await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.accounts where value_fp = $1", [
      fingerprint(db.keys, "address", who.address),
    ]),
  ).n;

const domainRows = async (db: TestDatabase, domain: string): Promise<number> =>
  one(
    await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.domains where domain_fp = $1", [
      fingerprint(db.keys, "domain", domain),
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

// How many rows of each table name an evidence id: the evidence row itself and every row citing it.
async function naming(db: TestDatabase, evidenceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  counts["vault.evidence_items"] = one(
    await admin<{ n: number }>(db, "select count(*)::int as n from vault.evidence_items where id = $1", [evidenceId]),
  ).n;
  for (const table of CITING)
    counts[table] = one(
      await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where evidence_id = $1`, [evidenceId]),
    ).n;
  return counts;
}

const named = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, n) => sum + n, 0);

type Revision = {
  id: string;
  revision: number;
  supersedes: string | null;
  next_revision_id: string;
  revision_tag_fp: string;
};

const revisionsOf = (db: TestDatabase, account: SourceAccountRow, sourceItemId: string): Promise<Revision[]> =>
  admin<Revision>(
    db,
    `select id, revision, supersedes, next_revision_id, revision_tag_fp from vault.evidence_items
     where source_account_id = $1 and source_item_fp = $2 order by revision`,
    [account.id, fingerprint(db.keys, "source_id", sourceItemId)],
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

const listedRows = async (db: TestDatabase, account: SourceAccountRow): Promise<{ fp: string }[]> =>
  (
    await admin<{ fp: string }>(db, "select source_item_fp as fp from vault.listed_items where account_id = $1", [
      account.id,
    ])
  ).sort((left, right) => (left.fp < right.fp ? -1 : 1));

const fps = (db: TestDatabase, ...sourceItemIds: string[]): string[] =>
  sourceItemIds.map((id) => fingerprint(db.keys, "source_id", id)).sort();

describe("the writer", { timeout: TIMEOUT }, () => {
  it("every content value is sealed before it is sent to the database", () =>
    withStore(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const items = [
        mailItem(MAIL.canary, accounts.personalMail),
        mailItem(MAIL.reply, accounts.personalMail),
        mailItem(MAIL.workCanary, accounts.workMail),
      ];
      const meeting = eventItem(EVENTS.canary, accounts.personalCalendar);
      await ingestMail(writer, accounts.personalMail, MAIL.canary);
      await ingestMail(writer, accounts.personalMail, MAIL.reply);
      await ingestMail(writer, accounts.workMail, MAIL.workCanary);
      await ingestEvent(writer, accounts.personalCalendar, EVENTS.canary);
      await writer.setCursor(accounts.personalMail, cursor("cursor-sealed-0001"));
      await writer.recordSendAs(accounts.workMail, ["alias.sealed@employer-example.test"]);

      // Every sealed column the writer fills: an envelope that opens at its own row and column
      // under its row's one compartment, and under no other compartment's key.
      const plain: Record<string, string[]> = {};
      for (const { table, id, column } of SEALED.filter(
        (sealed) => sealed.table !== "policy.secrets" && syncedBy(sealed.table),
      )) {
        const rows = await admin<{ id: string; compartments: string[]; sealed: unknown; type: string }>(
          db,
          `select (${id})::text as id, compartments, ${column} as sealed, pg_typeof(${column})::text as type from ${table} where ${column} is not null`,
        );
        const place = `${table}.${column}`;
        expect(rows.length, place).toBeGreaterThan(0);
        plain[place] = rows.map((row) => {
          expect(row.type, place).toBe("jsonb");
          expect(Envelope.safeParse(row.sealed).success, place).toBe(true);
          expect(row.compartments, place).toHaveLength(1);
          const compartment = row.compartments[0] ?? "";
          const other = compartment === "own" ? "employer:example" : "own";
          const at = { table, id: row.id, column };
          expect(
            thrownBy(() => opened(db, other, at, row.sealed)),
            place,
          ).toMatchObject({ name: "CryptoError", code: "open_failed" });
          // The positive control: the same envelope under its own compartment's key.
          return opened(db, compartment, at, row.sealed);
        });
      }

      const sorted = (place: string): string[] => [...(plain[place] ?? [])].sort();
      expect(sorted("vault.source_accounts.address_enc")).toEqual(
        [OWNER.personal, OWNER.personal, OWNER.work, OWNER.work].sort(),
      );
      expect(sorted("vault.source_accounts.cursor_enc")).toEqual(["cursor-sealed-0001"]);
      expect(sorted("vault.source_accounts.send_as_enc")).toEqual([
        JSON.stringify(["alias.sealed@employer-example.test"]),
      ]);
      // The payload in the blob, and the raw item without it in `item_enc`.
      expect(sorted("vault.evidence_blobs.envelope")).toEqual([...items, meeting].map((item) => item.payload).sort());
      const stored = sorted("vault.evidence_items.item_enc").map((text) => JSON.parse(text) as unknown);
      expect(stored).toHaveLength(4);
      for (const item of [...items, meeting]) expect(stored).toContainEqual(withoutPayload(item));
      // Each address once per compartment it was seen under; the owner's two, once each.
      expect(sorted("knowledge.accounts.value_enc")).toEqual(
        [
          OWNER.personal,
          OWNER.work,
          CANARY_PERSON.address,
          CANARY_PERSON.address,
          QUENTIN.address,
          RHEA.address,
        ].sort(),
      );
      expect(sorted("knowledge.domains.domain_enc")).toEqual(
        [CANARIES.domain, CANARIES.domain, "lighthouse.test"].sort(),
      );
      expect(new Set(sorted("knowledge.aliases.value_enc"))).toEqual(
        new Set([CANARY_PERSON.name, QUENTIN.name, RHEA.name]),
      );
      expect(sorted("knowledge.messages.subject_enc")).toEqual(
        [CANARIES.subject, CANARIES.subject, MAIL.reply.subject].sort(),
      );
      expect(sorted("knowledge.messages.thread_id_enc")).toEqual(
        [MAIL.canary.threadId, MAIL.reply.threadId, MAIL.workCanary.threadId].sort(),
      );
      expect(sorted("knowledge.event_details.title_enc")).toEqual([CANARIES.eventTitle]);
    }));

  it("ingesting the same item twice changes nothing", () =>
    withStore(async ({ db, writer }) => {
      const accounts = await connect(writer);
      const again = async (changeKind: RawItem["changeKind"]): Promise<string[]> => [
        await writer.ingestItem(
          accounts.personalMail,
          mailItem(MAIL.canary, accounts.personalMail, changeKind),
          mailFacts(MAIL.canary),
        ),
        await writer.ingestItem(
          accounts.personalMail,
          mailItem(MAIL.reply, accounts.personalMail, changeKind),
          mailFacts(MAIL.reply),
        ),
        await writer.ingestItem(
          accounts.personalMail,
          mailItem(MAIL.newsletter, accounts.personalMail, changeKind),
          mailFacts(MAIL.newsletter),
        ),
        await writer.ingestItem(
          accounts.personalMail,
          mailItem(MAIL.unread, accounts.personalMail, changeKind),
          mailFacts(MAIL.unread),
        ),
        await writer.ingestItem(
          accounts.personalCalendar,
          eventItem(EVENTS.canary, accounts.personalCalendar, changeKind),
          eventFacts(EVENTS.canary),
        ),
        await writer.ingestItem(
          accounts.workMail,
          mailItem(MAIL.workCanary, accounts.workMail, changeKind),
          mailFacts(MAIL.workCanary),
        ),
      ];

      // The positive control: the first time, each is kept.
      expect(await again("backfill")).toEqual(["stored", "stored", "stored", "unread", "stored", "stored"]);
      const before = lines(await snapshot(db));
      expect(before.length).toBeGreaterThan(20);

      // (table, key, xmin) of every row, read as pi_admin: no new row, and none updated.
      expect(await again("backfill")).toEqual(Array.from({ length: 6 }, () => "repeat"));
      expect(lines(await snapshot(db))).toEqual(before);
      // The revision tag decides, not how the item came.
      expect(await again("live")).toEqual(Array.from({ length: 6 }, () => "repeat"));
      expect(lines(await snapshot(db))).toEqual(before);
    }));

  it("a 500-recipient message ingests in one transaction", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const before = await snapshot(db);

      expect(await ingestMail(writer, personalMail, MAIL.crowd)).toBe("stored");

      // Every row it wrote, new or changed, shares one xmin.
      const after = await snapshot(db);
      const written = [...after].filter(([key, xmin]) => before.get(key) !== xmin);
      expect(new Set(written.map(([, xmin]) => xmin)).size).toBe(1);
      const perTable: Record<string, number> = {};
      for (const [key] of written) {
        const table = key.split(" ")[0] ?? "";
        perTable[table] = (perTable[table] ?? 0) + 1;
      }
      // 500 people of one organization, and the owner's one message to them all. And one recipient
      // row for each address the owner wrote to.
      expect(perTable).toEqual({
        "vault.evidence_items": 1,
        "vault.evidence_blobs": 1,
        "knowledge.entities": 501,
        "knowledge.accounts": 500,
        "knowledge.domains": 1,
        "knowledge.messages": 1,
        "knowledge.interaction_log": 500,
        "vault.sent_recipients": 500,
      });
      expect([...before.keys()].every((key) => after.has(key))).toBe(true);
    }));

  it("an item's evidence row, blob, owner address, accounts, domains, aliases, message row, interaction rows, event rows and participants commit in one transaction", () =>
    withStore(async ({ db, writer }) => {
      const accounts = await connect(writer);
      await ingestMail(writer, accounts.personalMail, MAIL.fromQuentin);
      const before = lines(await snapshot(db));
      const kinds = await entityKinds(db);
      const owners = (await writer.ownerAddresses()).sort();

      // A sent message from a new alias, a received message with new people, and an event.
      const items: [SourceAccountRow, RawItem, (ctx: ItemContext) => Promise<ItemFacts>][] = [
        [accounts.personalMail, mailItem(MAIL.aliasSent, accounts.personalMail), mailFacts(MAIL.aliasSent)],
        [accounts.personalMail, mailItem(MAIL.canary, accounts.personalMail), mailFacts(MAIL.canary)],
        [accounts.personalCalendar, eventItem(EVENTS.guest, accounts.personalCalendar), eventFacts(EVENTS.guest)],
      ];
      for (const [account, raw, facts] of items) {
        let resolved = 0;
        // The break: a derive that resolves every address and then throws.
        const broken = async (ctx: ItemContext): Promise<ItemFacts> => {
          await facts(ctx);
          resolved += 1;
          throw new Error("derive broke after resolving every address");
        };
        await expect(writer.ingestItem(account, raw, broken)).rejects.toThrow();
        expect(resolved).toBe(1);

        // No row of any table names the item's evidence id, and no entity or account was added.
        expect(named(await naming(db, evidenceIdOf(account, raw.sourceItemId)))).toBe(0);
        expect(lines(await snapshot(db))).toEqual(before);
        expect(await entityKinds(db)).toEqual(kinds);
      }
      // The sender of the sent message did not stay an owner address.
      expect((await writer.ownerAddresses()).sort()).toEqual(owners);

      // The positive control: the same items, with a derive that returns.
      for (const [account, raw, facts] of items) {
        expect(await writer.ingestItem(account, raw, facts)).toBe("stored");
        expect((await naming(db, evidenceIdOf(account, raw.sourceItemId)))["vault.evidence_items"]).toBe(1);
      }
      expect(await writer.ownerAddresses()).toContain(OWNER.alias);
      expect((await entityKinds(db)).person).toBeGreaterThan(kinds.person ?? 0);
    }));

  describe("every knowledge row derived from an item cites the latest revision of its source item", () => {
    it("every knowledge row derived from an item cites the latest revision of its source item", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        // One item with one revision, a message with two, and an event with three.
        await ingestMail(writer, personalMail, MAIL.canary);
        await ingestMail(writer, personalMail, MAIL.solo);
        await writer.ingestItem(personalMail, mailRevision(MAIL.soloAgain, personalMail), mailFacts(MAIL.soloAgain));
        await ingestEvent(writer, personalCalendar, EVENTS.canary);
        await ingestEvent(writer, personalCalendar, EVENTS.canaryMoved);
        await ingestEvent(writer, personalCalendar, EVENTS.canaryCancelled);

        // Earlier revisions stay in the vault.
        const superseded = await admin<{ id: string }>(
          db,
          "select supersedes as id from vault.evidence_items where supersedes is not null",
        );
        expect(superseded).toHaveLength(3);
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from vault.evidence_items")).n).toBe(6);

        for (const table of CITING) {
          const rows = await admin<{ evidence_id: string }>(db, `select evidence_id from ${table}`);
          expect(rows.length, table).toBeGreaterThan(0);
          for (const row of rows)
            expect(
              superseded.map((one) => one.id),
              table,
            ).not.toContain(row.evidence_id);
        }
      }));

    it("a second revision tag for one source id is revision 1, superseding revision 0, and the derived rows cite it", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        const seen: { revision: number; evidenceId: string }[] = [];
        const watching =
          (facts: (ctx: ItemContext) => Promise<ItemFacts>) =>
          (ctx: ItemContext): Promise<ItemFacts> => {
            seen.push({ revision: ctx.revision, evidenceId: ctx.evidenceId });
            return facts(ctx);
          };

        // A message: the same Gmail message, handed over again under another revision tag.
        const first = mailItem(MAIL.solo, personalMail);
        const second = mailRevision(MAIL.soloAgain, personalMail);
        expect(second.sourceItemId).toBe(first.sourceItemId);
        expect(second.revisionTag).not.toBe(first.revisionTag);
        const [rev0, rev1, rev2] = [0, 1, 2].map((revision) =>
          evidenceIdOf(personalMail, first.sourceItemId, revision),
        );
        expect(await writer.ingestItem(personalMail, first, watching(mailFacts(MAIL.solo)))).toBe("stored");
        expect(await writer.ingestItem(personalMail, second, watching(mailFacts(MAIL.soloAgain)))).toBe("stored");
        expect(seen).toEqual([
          { revision: 0, evidenceId: rev0 },
          { revision: 1, evidenceId: rev1 },
        ]);
        expect(await revisionsOf(db, personalMail, first.sourceItemId)).toEqual([
          {
            id: rev0,
            revision: 0,
            supersedes: null,
            next_revision_id: rev1,
            revision_tag_fp: fingerprint(db.keys, "revision_tag", first.revisionTag),
          },
          {
            id: rev1,
            revision: 1,
            supersedes: rev0,
            next_revision_id: rev2,
            revision_tag_fp: fingerprint(db.keys, "revision_tag", second.revisionTag),
          },
        ]);
        // Nothing cites revision 0 any more; the message, its interactions and its names cite revision 1.
        expect(await naming(db, String(rev0))).toEqual({
          "vault.evidence_items": 1,
          "knowledge.aliases": 0,
          "knowledge.messages": 0,
          "knowledge.interaction_log": 0,
          "knowledge.events": 0,
        });
        expect(await naming(db, String(rev1))).toEqual({
          "vault.evidence_items": 1,
          "knowledge.aliases": 2,
          "knowledge.messages": 1,
          "knowledge.interaction_log": 2,
          "knowledge.events": 0,
        });
        const message = one(
          await admin<{ id: string; subject_enc: unknown }>(
            db,
            "select id, subject_enc from knowledge.messages where evidence_id = $1",
            [rev1],
          ),
        );
        expect(
          opened(
            db,
            "own",
            { table: "knowledge.messages", id: message.id, column: "subject_enc" },
            message.subject_enc,
          ),
        ).toBe(MAIL.soloAgain.subject);
        const onMessage = (
          await admin<{ entity_id: string }>(
            db,
            "select entity_id from knowledge.interaction_log where evidence_id = $1",
            [rev1],
          )
        ).map((row) => row.entity_id);
        expect(onMessage.sort()).toEqual([await entityOf(db, SOLO), await entityOf(db, RHEA)].sort());
        // The latest revision's tag is a repeat: nothing is written and no facts are read.
        expect(await writer.ingestItem(personalMail, second, watching(mailFacts(MAIL.soloAgain)))).toBe("repeat");
        expect(seen).toHaveLength(2);
        expect((await naming(db, String(rev1)))["knowledge.messages"]).toBe(1);

        // An event: the same event id under a new etag. The event keeps its id.
        const event = eventItem(EVENTS.canary, personalCalendar);
        const moved = eventItem(EVENTS.canaryMoved, personalCalendar);
        const [event0, event1, event2] = [0, 1, 2].map((revision) =>
          evidenceIdOf(personalCalendar, event.sourceItemId, revision),
        );
        expect(await ingestEvent(writer, personalCalendar, EVENTS.canary)).toBe("stored");
        const before = one(
          await admin<{ id: string; evidence_id: string }>(db, "select id, evidence_id from knowledge.events"),
        );
        expect(before.evidence_id).toBe(event0);
        expect(EventId.safeParse(before.id).success).toBe(true);
        const quentin = await entityOf(db, QUENTIN);

        expect(await ingestEvent(writer, personalCalendar, EVENTS.canaryMoved)).toBe("stored");
        expect(await revisionsOf(db, personalCalendar, event.sourceItemId)).toEqual([
          {
            id: event0,
            revision: 0,
            supersedes: null,
            next_revision_id: event1,
            revision_tag_fp: fingerprint(db.keys, "revision_tag", event.revisionTag),
          },
          {
            id: event1,
            revision: 1,
            supersedes: event0,
            next_revision_id: event2,
            revision_tag_fp: fingerprint(db.keys, "revision_tag", moved.revisionTag),
          },
        ]);
        const after = one(
          await admin<{ id: string; evidence_id: string; occurred_at: Date; xmin: string }>(
            db,
            "select id, evidence_id, occurred_at, xmin::text as xmin from knowledge.events",
          ),
        );
        expect(after.id).toBe(before.id);
        expect(after.evidence_id).toBe(event1);
        expect(iso(after.occurred_at)).toBe(EVENTS.canaryMoved.startsAt);
        const details = one(
          await admin<{ event_id: string; starts_at: Date; ends_at: Date; title_enc: unknown; xmin: string }>(
            db,
            "select event_id, starts_at, ends_at, title_enc, xmin::text as xmin from knowledge.event_details",
          ),
        );
        expect(details.event_id).toBe(before.id);
        expect([iso(details.starts_at), iso(details.ends_at)]).toEqual([
          EVENTS.canaryMoved.startsAt,
          EVENTS.canaryMoved.endsAt,
        ]);
        expect(
          opened(
            db,
            "own",
            { table: "knowledge.event_details", id: before.id, column: "title_enc" },
            details.title_enc,
          ),
        ).toBe(EVENTS.canaryMoved.title);
        // The participants and names are rebuilt: Rhea is in, Quentin is out.
        const participants = await admin<{ event_id: string; entity_id: string }>(
          db,
          "select event_id, entity_id from knowledge.event_participants",
        );
        expect(participants.map((row) => row.event_id)).toEqual([before.id, before.id]);
        expect(participants.map((row) => row.entity_id).sort()).toEqual(
          [await entityOf(db, CANARY_PERSON), await entityOf(db, RHEA)].sort(),
        );
        expect(participants.map((row) => row.entity_id)).not.toContain(quentin);
        expect(await naming(db, String(event0))).toEqual({
          "vault.evidence_items": 1,
          "knowledge.aliases": 0,
          "knowledge.messages": 0,
          "knowledge.interaction_log": 0,
          "knowledge.events": 0,
        });
        expect(await naming(db, String(event1))).toEqual({
          "vault.evidence_items": 1,
          "knowledge.aliases": 2,
          "knowledge.messages": 0,
          "knowledge.interaction_log": 0,
          "knowledge.events": 1,
        });
        // In the same transaction as its evidence row.
        const evidence = one(
          await admin<{ xmin: string }>(db, "select xmin::text as xmin from vault.evidence_items where id = $1", [
            event1,
          ]),
        );
        expect([after.xmin, details.xmin]).toEqual([evidence.xmin, evidence.xmin]);
      }));

    it("a cancelled event that keeps its fields is a revision marked cancelled", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const cancelledItem = eventItem(EVENTS.canaryCancelled, personalCalendar);
        expect(cancelledItem.markers).toContain("cancelled");

        expect(await ingestEvent(writer, personalCalendar, EVENTS.canary)).toBe("stored");
        const read = async () =>
          one(
            await admin<{ event_id: string; cancelled: boolean; title_enc: unknown }>(
              db,
              "select event_id, cancelled, title_enc from knowledge.event_details",
            ),
          );
        const before = await read();
        expect(before.cancelled).toBe(false);

        expect(await ingestEvent(writer, personalCalendar, EVENTS.canaryCancelled)).toBe("stored");
        const after = await read();
        expect(after).toMatchObject({ event_id: before.event_id, cancelled: true });
        expect(
          opened(
            db,
            "own",
            { table: "knowledge.event_details", id: after.event_id, column: "title_enc" },
            after.title_enc,
          ),
        ).toBe(CANARIES.eventTitle);
        const revisions = await revisionsOf(db, personalCalendar, cancelledItem.sourceItemId);
        expect(revisions.map((row) => row.revision)).toEqual([0, 1]);
        const event = one(
          await admin<{ id: string; evidence_id: string }>(db, "select id, evidence_id from knowledge.events"),
        );
        expect(event).toEqual({ id: before.event_id, evidence_id: revisions[1]?.id });
        // It keeps its participants.
        const participants = (
          await admin<{ entity_id: string }>(
            db,
            "select entity_id from knowledge.event_participants where event_id = $1",
            [event.id],
          )
        ).map((row) => row.entity_id);
        expect(participants.sort()).toEqual([await entityOf(db, CANARY_PERSON), await entityOf(db, QUENTIN)].sort());
      }));
  });

  describe("entities come only from addresses the identity port resolves", () => {
    it("entities come only from addresses the identity port resolves", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        const fp = (kind: "address" | "domain" | "name" | "thread" | "source_id", value: string): string =>
          fingerprint(db.keys, kind, value);
        const interactions = (evidenceId: string) =>
          admin<{
            id: string;
            member_id: string;
            entity_id: string;
            direction: string;
            channel: string;
            occurred_at: Date;
            body_hash: string | null;
            entity_role: string;
          }>(
            db,
            "select id, member_id, entity_id, direction, channel, occurred_at, body_hash, entity_role from knowledge.interaction_log where evidence_id = $1 order by entity_role desc, id",
            [evidenceId],
          );
        const aliases = async (evidenceId: string): Promise<string[]> =>
          (
            await admin<{ entity_id: string; value_fp: string }>(
              db,
              "select entity_id, value_fp from knowledge.aliases where evidence_id = $1",
              [evidenceId],
            )
          )
            .map((row) => `${row.entity_id} ${row.value_fp}`)
            .sort();

        // A received message: From the canary person, To the owner, Cc Quentin.
        expect(await ingestMail(writer, personalMail, MAIL.canary)).toBe("stored");
        const received = evidenceIdOf(personalMail, mailSourceId(MAIL.canary));
        const owner = one(await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'")).id;
        const canary = await entityOf(db, CANARY_PERSON);
        const quentin = await entityOf(db, QUENTIN);
        for (const id of [owner, canary, quentin]) expect(EntityId.safeParse(id).success).toBe(true);
        expect(await entityKinds(db)).toEqual({ owner: 1, person: 2, organization: 2 });

        const account = one(
          await admin(
            db,
            "select a.entity_id, a.kind, a.domain_fp, a.compartments, e.kind as entity_kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
            [fp("address", CANARY_PERSON.address)],
          ),
        );
        expect(account).toEqual({
          entity_id: canary,
          kind: "email",
          domain_fp: fp("domain", CANARIES.domain),
          compartments: ["own"],
          entity_kind: "person",
        });
        // Each organization domain has one row under the compartment; the owner's address makes none.
        const domains = await admin<{ domain_fp: string; compartments: string[]; kind: string }>(
          db,
          "select d.domain_fp, d.compartments, e.kind from knowledge.domains d join knowledge.entities e on e.id = d.entity_id",
        );
        expect(domains.map((row) => row.domain_fp).sort()).toEqual(
          [fp("domain", CANARIES.domain), fp("domain", "lighthouse.test")].sort(),
        );
        for (const row of domains) expect(row).toMatchObject({ compartments: ["own"], kind: "organization" });
        expect(await domainRows(db, "hearth-canary.test")).toBe(0);

        const message = one(
          await admin<{ sent_at: Date; direction: string; thread_fp: string; compartments: string[] }>(
            db,
            "select sent_at, direction, thread_fp, compartments from knowledge.messages where evidence_id = $1",
            [received],
          ),
        );
        expect({ ...message, sent_at: iso(message.sent_at) }).toEqual({
          sent_at: iso(MAIL.canary.at),
          direction: "inbound",
          thread_fp: fp("thread", MAIL.canary.threadId),
          compartments: ["own"],
        });
        // One interaction row per entity in the record's participants, with its role.
        const inbound = { member_id: THE_OWNER, direction: "inbound", channel: "email", body_hash: null };
        expect((await interactions(received)).map((row) => ({ ...row, occurred_at: iso(row.occurred_at) }))).toEqual([
          {
            ...inbound,
            id: interactionId(received, canary),
            entity_id: canary,
            entity_role: "sender",
            occurred_at: iso(MAIL.canary.at),
          },
          {
            ...inbound,
            id: interactionId(received, quentin),
            entity_id: quentin,
            entity_role: "recipient",
            occurred_at: iso(MAIL.canary.at),
          },
        ]);
        // Aliases come from the facts' names.
        expect(await aliases(received)).toEqual(
          [`${canary} ${fp("name", CANARY_PERSON.name ?? "")}`, `${quentin} ${fp("name", QUENTIN.name ?? "")}`].sort(),
        );

        // A sent message: To the canary person, Cc Quentin and Rhea.
        expect(await ingestMail(writer, personalMail, MAIL.reply)).toBe("stored");
        const sent = evidenceIdOf(personalMail, mailSourceId(MAIL.reply));
        const rhea = await entityOf(db, RHEA);
        // Rhea is new; Rhea's organization is Quentin's, already there.
        expect(await entityKinds(db)).toEqual({ owner: 1, person: 3, organization: 2 });
        expect(await domainRows(db, "lighthouse.test")).toBe(1);
        expect(
          one(
            await admin<{ direction: string }>(db, "select direction from knowledge.messages where evidence_id = $1", [
              sent,
            ]),
          ).direction,
        ).toBe("outbound");
        const outbound = await interactions(sent);
        expect(outbound.map((row) => row.id).sort()).toEqual(
          [canary, quentin, rhea].map((entity) => interactionId(sent, entity)).sort(),
        );
        for (const row of outbound) {
          expect(row).toMatchObject({
            member_id: THE_OWNER,
            direction: "outbound",
            channel: "email",
            entity_role: "recipient",
            body_hash: hashFingerprint(db.keys, "body_hash", bodyHashOf(MAIL.reply)),
          });
        }

        // An event: its row, its details and one participant row per entity, never the owner.
        expect(await ingestEvent(writer, personalCalendar, EVENTS.guest)).toBe("stored");
        const meeting = evidenceIdOf(personalCalendar, EVENTS.guest.event.id);
        const guest = await entityOf(db, GUEST);
        const event = one(
          await admin<{
            id: string;
            event_kind: string;
            occurred_at: Date;
            evidence_id: string;
            compartments: string[];
          }>(db, "select id, event_kind, occurred_at, evidence_id, compartments from knowledge.events"),
        );
        expect(EventId.safeParse(event.id).success).toBe(true);
        expect({ ...event, occurred_at: iso(event.occurred_at) }).toEqual({
          id: event.id,
          event_kind: "meeting",
          occurred_at: EVENTS.guest.startsAt,
          evidence_id: meeting,
          compartments: ["own"],
        });
        const details = one(
          await admin<{
            event_id: string;
            account_id: string;
            source_event_fp: string;
            starts_at: Date;
            ends_at: Date;
            all_day: boolean;
            cancelled: boolean;
            owner_response: string | null;
            compartments: string[];
            title_enc: unknown;
          }>(
            db,
            "select event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, owner_response, compartments, title_enc from knowledge.event_details",
          ),
        );
        expect({
          ...details,
          starts_at: iso(details.starts_at),
          ends_at: iso(details.ends_at),
          title_enc: opened(
            db,
            "own",
            { table: "knowledge.event_details", id: event.id, column: "title_enc" },
            details.title_enc,
          ),
        }).toEqual({
          event_id: event.id,
          account_id: personalCalendar.id,
          source_event_fp: fp("source_id", EVENTS.guest.event.id),
          starts_at: EVENTS.guest.startsAt,
          ends_at: EVENTS.guest.endsAt,
          all_day: false,
          cancelled: false,
          owner_response: "needsAction",
          compartments: ["own"],
          title_enc: EVENTS.guest.title,
        });
        const participants = await admin(
          db,
          "select event_id, entity_id, participant_role, compartments from knowledge.event_participants order by participant_role",
        );
        expect(participants).toEqual([
          { event_id: event.id, entity_id: guest, participant_role: "organizer", compartments: ["own"] },
          { event_id: event.id, entity_id: quentin, participant_role: "participant", compartments: ["own"] },
        ]);
        expect(await aliases(meeting)).toEqual(
          [`${guest} ${fp("name", GUEST.name ?? "")}`, `${quentin} ${fp("name", QUENTIN.name ?? "")}`].sort(),
        );
        // A meeting is in `events`, not in the interaction log.
        expect(await interactions(meeting)).toEqual([]);

        // A bulk item makes no entity.
        const kinds = await entityKinds(db);
        expect(await ingestMail(writer, personalMail, MAIL.newsletter)).toBe("stored");
        expect(await entityKinds(db)).toEqual(kinds);
        expect(await accountRows(db, { address: "bulletin@bulletin.test" })).toBe(0);

        // Only the addresses a derive resolves: this one resolves the sender and leaves the Cc alone.
        const partly: MailFixture = {
          id: "gm-partly-0101",
          threadId: "thread-partly-0101",
          messageId: "partly-0101@one-message.test",
          at: "2026-09-12T12:00:00Z",
          from: SOLO,
          to: [{ address: OWNER.personal }],
          cc: [{ address: "passed-over@never-resolved.test" }],
          labels: ["INBOX"],
        };
        const senderOnly = async (ctx: ItemContext): Promise<ItemFacts> => {
          const entity = await resolveAddress(ctx, SOLO.address, partly.at);
          if (entity === null) throw new Error("the sender did not resolve");
          return {
            kind: "email",
            members: { participantMembers: [THE_OWNER] },
            bulk: false,
            message: mailMessage(partly),
            record: {
              evidenceId: ctx.evidenceId,
              occurredAt: partly.at,
              channel: "email",
              direction: "inbound",
              teamRecipients: [THE_OWNER],
              participants: [entity],
            },
            roles: [{ entity, role: "sender" }],
            names: [],
          };
        };
        // The item also comes with no thread id, which a raw item may lack.
        const { threadId: _, ...threadless } = mailItem(partly, personalMail);
        expect(await writer.ingestItem(personalMail, threadless, senderOnly)).toBe("stored");
        expect(await accountRows(db, SOLO)).toBe(1);
        expect(await accountRows(db, { address: "passed-over@never-resolved.test" })).toBe(0);
        expect(await domainRows(db, "never-resolved.test")).toBe(0);
        expect(await entityKinds(db)).toEqual({
          owner: 1,
          person: kinds.person === undefined ? 0 : kinds.person + 1,
          organization: kinds.organization === undefined ? 0 : kinds.organization + 1,
        });
        // A message with no subject and no thread id has neither stored, sealed or fingerprinted.
        const bare = await admin(
          db,
          "select subject_enc, thread_id_enc, thread_fp from knowledge.messages where evidence_id = $1",
          [evidenceIdOf(personalMail, mailSourceId(partly))],
        );
        expect(bare).toEqual([{ subject_enc: null, thread_id_enc: null, thread_fp: null }]);
        expect(
          await admin(db, "select thread_fp from vault.evidence_items where id = $1", [
            evidenceIdOf(personalMail, mailSourceId(partly)),
          ]),
        ).toEqual([{ thread_fp: null }]);
      }));

    it("a consumer domain makes no domain row", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        expect(CONSUMER_DOMAINS.length).toBeGreaterThan(0);
        const consumers: Who[] = CONSUMER_DOMAINS.map((domain, index) => ({
          address: `synthetic-fixture-person-${index}@${domain}`,
        }));
        const [first, ...rest] = consumers;
        if (first === undefined) throw new Error("no consumer domain is listed");
        const fixture: MailFixture = {
          id: "gm-consumer-0201",
          threadId: "thread-consumer-0201",
          messageId: "consumer-0201@synthetic-fixture.test",
          at: "2026-09-13T12:00:00Z",
          from: first,
          to: [{ address: OWNER.personal }],
          cc: [...rest, QUENTIN],
          subject: "From a consumer address",
          labels: ["INBOX"],
        };
        expect(await writer.ingestItem(personalMail, mailItem(fixture, personalMail), mailFacts(fixture))).toBe(
          "stored",
        );

        // Each is a person with an account row that carries its registrable domain's fingerprint
        // (a relay's subdomain carries its parent's)...
        for (const [index, consumer] of consumers.entries()) {
          const domain = CONSUMER_DOMAINS[index] ?? "";
          const rows = await admin(
            db,
            "select a.domain_fp, a.compartments, e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
            [fingerprint(db.keys, "address", consumer.address)],
          );
          expect(rows, domain).toEqual([
            { domain_fp: fingerprint(db.keys, "domain", foldDomain(domain)), compartments: ["own"], kind: "person" },
          ]);
          // ...and no domain row, so no organization.
          expect(await domainRows(db, domain), domain).toBe(0);
        }
        // The positive control: on the same message, Quentin's organization domain has its row and
        // its organization, the only one there is.
        expect(await domainRows(db, "lighthouse.test")).toBe(1);
        expect(await entityKinds(db)).toEqual({ owner: 1, person: consumers.length + 1, organization: 1 });
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.domains")).n).toBe(1);
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.interaction_log")).n).toBe(
          consumers.length + 1,
        );
      }));

    it("the identity port links an owner address to the owner and creates a person once per address, across compartments", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        const contexts: ItemContext[] = [];
        const answers: Record<string, Resolution> = {};
        const asking =
          (fixture: MailFixture, questions: [string, "address" | "source_id" | "name", string][]) =>
          async (ctx: ItemContext): Promise<ItemFacts> => {
            contexts.push(ctx);
            for (const [label, kind, value] of questions) answers[label] = await ask(ctx, kind, value, fixture.at);
            return mailFacts(fixture)(ctx);
          };

        // Under `own`.
        const first = mailItem(MAIL.canary, personalMail);
        expect(
          await writer.ingestItem(
            personalMail,
            first,
            asking(MAIL.canary, [
              ["owner", "address", OWNER.personal],
              ["owner, another account's address", "address", OWNER.work],
              ["owner, not normalized", "address", `  ${OWNER.personal.toUpperCase()} `],
              ["new", "address", CANARY_PERSON.address],
              ["again", "address", CANARY_PERSON.address],
              ["again, not normalized", "address", ` ${CANARY_PERSON.address.toUpperCase()}`],
              ["no at sign", "address", "not-an-address"],
              ["no dot in the domain", "address", "someone@localhost"],
              ["a name", "name", CANARY_PERSON.name ?? ""],
              ["a source id", "source_id", "U012345"],
            ]),
          ),
        ).toBe("stored");
        const [own] = contexts;
        if (own === undefined) throw new Error("derive was not called");
        // What the writer hands a derive.
        expect(own.evidenceId).toBe(evidenceIdOf(personalMail, first.sourceItemId));
        expect(own.revision).toBe(0);
        expect(own.compartment).toBe("own");
        expect([...own.ownerAddresses].sort()).toEqual([OWNER.personal, OWNER.work].sort());
        expect(
          one(await admin<{ kind: string }>(db, "select kind from knowledge.entities where id = $1", [own.ownerEntity]))
            .kind,
        ).toBe("owner");

        const linkedToOwner = { outcome: "linked", entity: own.ownerEntity, epoch: 0 };
        expect(answers.owner).toEqual(linkedToOwner);
        expect(answers["owner, another account's address"]).toEqual(linkedToOwner);
        expect(answers["owner, not normalized"]).toEqual(linkedToOwner);
        const person = await entityOf(db, CANARY_PERSON);
        expect(person).not.toBe(own.ownerEntity);
        expect(EntityId.safeParse(person).success).toBe(true);
        expect(answers.new).toEqual({ outcome: "created", entity: person, epoch: 0 });
        expect(answers.again).toEqual({ outcome: "linked", entity: person, epoch: 0 });
        expect(answers["again, not normalized"]).toEqual({ outcome: "linked", entity: person, epoch: 0 });
        for (const label of ["no at sign", "no dot in the domain", "a name", "a source id"])
          expect(answers[label], label).toEqual({ outcome: "not_a_person" });

        // Under `employer:example`: the same address is the same person.
        expect(
          await writer.ingestItem(
            workMail,
            mailItem(MAIL.workCanary, workMail),
            asking(MAIL.workCanary, [
              ["known elsewhere", "address", CANARY_PERSON.address],
              ["owner, from the other compartment", "address", OWNER.personal],
            ]),
          ),
        ).toBe("stored");
        expect(contexts[1]?.compartment).toBe("employer:example");
        expect(contexts[1]?.ownerEntity).toBe(own.ownerEntity);
        expect(answers["known elsewhere"]).toEqual({ outcome: "linked", entity: person, epoch: 0 });
        expect(answers["owner, from the other compartment"]).toEqual(linkedToOwner);
        // And a new address there is a new person. Each question in this test is about an address
        // its item's facts name, so the person is cited and stays: this one is its message's sender.
        expect(
          await writer.ingestItem(
            workMail,
            mailItem(MAIL.workOnly, workMail),
            asking(MAIL.workOnly, [["new at work", "address", WORK_ONLY.address]]),
          ),
        ).toBe("stored");
        expect(contexts[2]?.compartment).toBe("employer:example");
        const workOnly = await entityOf(db, WORK_ONLY);
        expect(workOnly).not.toBe(person);
        expect(answers["new at work"]).toEqual({ outcome: "created", entity: workOnly, epoch: 0 });

        // One person, with one account row per compartment the address was seen under.
        const rows = await admin<{ entity_id: string; compartments: string[] }>(
          db,
          "select entity_id, compartments from knowledge.accounts where value_fp = $1 order by compartments",
          [fingerprint(db.keys, "address", CANARY_PERSON.address)],
        );
        expect(rows).toEqual([
          { entity_id: person, compartments: ["employer:example"] },
          { entity_id: person, compartments: ["own"] },
        ]);
        expect((await entityKinds(db)).owner).toBe(1);
      }));
  });

  it("a person the port resolved and the facts do not name is not kept", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      // Quentin is a person an earlier item names.
      await ingestMail(writer, personalMail, MAIL.fromQuentin);
      const quentin = await entityOf(db, QUENTIN);
      const quentinRows = await naming(db, String(evidenceIdOf(personalMail, mailSourceId(MAIL.fromQuentin))));
      const before = await rowCounts(db);

      // Solo writes to the owner: the facts name Solo and nobody else.
      const fixture = mail({
        id: "gm-leftout-0301",
        threadId: "thread-leftout-0301",
        messageId: "leftout-0301@one-message.test",
        at: "2026-09-14T12:00:00Z",
        from: SOLO,
        to: [{ address: OWNER.personal }],
        subject: "Named, and not named",
        labels: ["INBOX"],
      });
      // Two addresses the derive resolves and then leaves out: one on a domain of its own, one on
      // Solo's. And Quentin, whom it asks about and leaves out too.
      const stranger: Who = { address: "left-out@left-out-domain.test" };
      const colleague: Who = { address: "left-out@one-message.test" };
      const asked: Resolution[] = [];
      const result = await writer.ingestItem(personalMail, mailItem(fixture, personalMail), async (ctx) => {
        for (const who of [stranger, colleague, QUENTIN])
          asked.push(await ask(ctx, "address", who.address, fixture.at));
        return mailFacts(fixture)(ctx);
      });
      expect(result).toBe("stored");

      // The port did resolve them: two new people, and one known.
      expect(asked.map((answer) => answer.outcome)).toEqual(["created", "created", "linked"]);
      const created = asked.flatMap((answer) => (answer.outcome === "created" ? [answer.entity] : []));
      expect(new Set(created).size).toBe(2);
      expect(asked[2]).toEqual({ outcome: "linked", entity: quentin, epoch: 0 });

      // After the commit nothing is left of the two the facts did not name: no entity, no
      // account, and for the one alone on its domain no domain row and no organization.
      expect(await admin(db, "select id from knowledge.entities where id = any($1)", [created])).toEqual([]);
      expect(await accountRows(db, stranger)).toBe(0);
      expect(await accountRows(db, colleague)).toBe(0);
      expect(await domainRows(db, "left-out-domain.test")).toBe(0);
      // The positive control: Solo, whom the same facts name, is kept, with a name, a message,
      // an interaction and Solo's organization, whose domain row Solo's own account row keeps.
      expect(await accountRows(db, SOLO)).toBe(1);
      expect(await domainRows(db, "one-message.test")).toBe(1);
      expect(changed(before, await rowCounts(db))).toEqual({
        "vault.evidence_items": 1,
        "vault.evidence_blobs": 1,
        "knowledge.entities": 2,
        "knowledge.accounts": 1,
        "knowledge.domains": 1,
        "knowledge.aliases": 1,
        "knowledge.messages": 1,
        "knowledge.interaction_log": 1,
      });
      // Quentin was asked about and not named here, but the earlier item names Quentin: Quentin stays.
      expect(await entityOf(db, QUENTIN)).toBe(quentin);
      expect(await accountRows(db, QUENTIN)).toBe(1);
      expect(await naming(db, String(evidenceIdOf(personalMail, mailSourceId(MAIL.fromQuentin))))).toEqual(quentinRows);
      expect(quentinRows).toMatchObject({ "knowledge.messages": 1, "knowledge.interaction_log": 1 });

      // In a re-derive too. Quentin's address becomes the owner's, so one is needed; its derive
      // resolves one more address that no item's facts name.
      await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
      const again: Who = { address: "left-out-again@left-out-domain.test" };
      const answers: Resolution[] = [];
      const rederived = await writer.rederiveIfNeeded(async (raw, ctx) => {
        answers.push(await ask(ctx, "address", again.address, fixture.at));
        return derive(raw, ctx);
      });
      expect(rederived).toEqual({ rederived: true, items: 2, coarser: 0 });
      // Asked once per item, and resolved each time: whether the second finds the first's person
      // depends on when the re-derive removes it, which is left open.
      expect(answers).toHaveLength(2);
      for (const answer of answers) expect(["created", "linked"]).toContain(answer.outcome);
      expect(await accountRows(db, again)).toBe(0);
      expect(await domainRows(db, "left-out-domain.test")).toBe(0);
      // What is left is the owner, and Solo with Solo's organization. Quentin's organization is gone
      // with the person: the owner's account row keeps no domain row.
      expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });
      expect(await accountRows(db, SOLO)).toBe(1);
      expect(await domainRows(db, "one-message.test")).toBe(1);
      expect(await domainRows(db, "lighthouse.test")).toBe(0);
      expect(await entityOf(db, QUENTIN)).toBe(await ownerEntity(db));
    }));

  it("the owner's addresses always resolve to the owner entity", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const owner = one(await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'")).id;
      expect((await writer.ownerAddresses()).sort()).toEqual([OWNER.personal, OWNER.work].sort());
      const before = await rowCounts(db);

      // A sent message from an address no account has: it is the owner's before derive is called.
      let inDerive: { known: boolean; resolution: Resolution } | undefined;
      const sent = mailItem(MAIL.aliasSent, personalMail);
      const result = await writer.ingestItem(personalMail, sent, async (ctx) => {
        inDerive = {
          known: ctx.ownerAddresses.includes(OWNER.alias),
          resolution: await ask(ctx, "address", OWNER.alias, MAIL.aliasSent.at),
        };
        return mailFacts(MAIL.aliasSent)(ctx);
      });
      expect(result).toBe("stored");
      expect(inDerive).toEqual({ known: true, resolution: { outcome: "linked", entity: owner, epoch: 0 } });
      expect((await writer.ownerAddresses()).sort()).toEqual([OWNER.alias, OWNER.personal, OWNER.work].sort());
      // Its one account row is the owner entity's, under the account's compartment, written in
      // the item's transaction; an owner address makes no domain row.
      const alias = one(
        await admin<{ entity_id: string; compartments: string[]; xmin: string }>(
          db,
          "select entity_id, compartments, xmin::text as xmin from knowledge.accounts where value_fp = $1",
          [fingerprint(db.keys, "address", OWNER.alias)],
        ),
      );
      expect(alias).toMatchObject({ entity_id: owner, compartments: ["own"] });
      const evidence = one(
        await admin<{ xmin: string }>(db, "select xmin::text as xmin from vault.evidence_items where id = $1", [
          evidenceIdOf(personalMail, sent.sourceItemId),
        ]),
      );
      expect(alias.xmin).toBe(evidence.xmin);
      expect(await domainRows(db, "alias-one.test")).toBe(0);
      // The owner is no counterpart of their own message: its one interaction is Quentin's.
      const quentin = await entityOf(db, QUENTIN);
      expect(
        await admin(db, "select entity_id from knowledge.interaction_log where evidence_id = $1", [
          evidenceIdOf(personalMail, sent.sourceItemId),
        ]),
      ).toEqual([{ entity_id: quentin }]);

      // Mail addressed to that alias afterwards resolves it to the owner: no person, no row for it.
      expect(await ingestMail(writer, personalMail, MAIL.toAlias)).toBe("stored");
      expect(await accountRows(db, { address: OWNER.alias })).toBe(1);
      const toAlias = await admin(db, "select entity_id from knowledge.interaction_log where evidence_id = $1", [
        evidenceIdOf(personalMail, mailSourceId(MAIL.toAlias)),
      ]);
      expect(toAlias).toEqual([{ entity_id: await entityOf(db, RHEA) }]);

      // Even when the message is bulk: the sender becomes an owner address, and nothing else is derived.
      const beforeBulk = await rowCounts(db);
      expect(await ingestMail(writer, personalMail, MAIL.bulkSent)).toBe("stored");
      expect(changed(beforeBulk, await rowCounts(db))).toEqual({
        "vault.evidence_items": 1,
        "vault.evidence_blobs": 1,
        "vault.sent_recipients": 1,
        "knowledge.accounts": 1,
        "knowledge.messages": 1,
      });
      expect(await writer.ownerAddresses()).toContain(OWNER.bulkAlias);
      expect(await entityOf(db, { address: OWNER.bulkAlias })).toBe(owner);

      // The control: the sender of a message without SENT is a person, not the owner.
      expect(await ingestMail(writer, personalMail, MAIL.fromQuentin)).toBe("stored");
      expect(await writer.ownerAddresses()).not.toContain(QUENTIN.address);
      expect(quentin).not.toBe(owner);
      expect((await entityKinds(db)).owner).toBe(1);
      // Quentin, Quentin's organization and Rhea: the owner's three new addresses made no entity.
      expect(changed(before, await rowCounts(db))["knowledge.entities"]).toBe(3);
    }));

  describe("applyDeletion deletes every revision of the source item and its blobs", () => {
    it("applyDeletion deletes every revision of the source item and its blobs", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // Solo's one message, in two revisions: Quentin is on the first, Rhea on the second.
        const solo = mailItem(MAIL.solo, personalMail);
        const kept = mailItem(MAIL.fromQuentin, personalMail);
        await ingestMail(writer, personalMail, MAIL.solo);
        await writer.ingestItem(personalMail, mailRevision(MAIL.soloAgain, personalMail), mailFacts(MAIL.soloAgain));
        await ingestMail(writer, personalMail, MAIL.fromQuentin);
        await writer.finishPage(personalMail, {
          listing: { first: true },
          listedIds: [solo.sourceItemId, kept.sourceItemId],
          skippedIds: [],
          next: cursor("cursor-r7-1"),
        });
        const [rev0, rev1] = [0, 1].map((revision) => evidenceIdOf(personalMail, solo.sourceItemId, revision));
        const blobs = (
          await admin<{ blob_ref: string }>(db, "select blob_ref from vault.evidence_items where id = any($1)", [
            [rev0, rev1],
          ])
        ).map((row) => row.blob_ref);
        expect(blobs).toHaveLength(2);
        expect(await listedRows(db, personalMail)).toHaveLength(2);
        expect(await entityKinds(db)).toEqual({ owner: 1, person: 3, organization: 2 });

        // A source item that is not stored does nothing.
        const before = lines(await snapshot(db));
        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: "never-stored",
          deletedAt: NOW,
        });
        expect(lines(await snapshot(db))).toEqual(before);

        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: solo.sourceItemId,
          deletedAt: NOW,
        });

        // Every revision, its blobs, its listed row and every row citing either revision.
        expect(named(await naming(db, String(rev0))) + named(await naming(db, String(rev1)))).toBe(0);
        expect(
          one(
            await admin<{ n: number }>(
              db,
              "select count(*)::int as n from vault.evidence_blobs where blob_ref = any($1)",
              [blobs],
            ),
          ).n,
        ).toBe(0);
        expect(await listedRows(db, personalMail)).toEqual([
          { fp: fingerprint(db.keys, "source_id", kept.sourceItemId) },
        ]);
        // The people seen only in it, and the organization only they belonged to.
        expect(await accountRows(db, SOLO)).toBe(0);
        expect(await accountRows(db, RHEA)).toBe(0);
        expect(await domainRows(db, "one-message.test")).toBe(0);
        expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });
        // What another item still cites stays: Quentin, Quentin's organization, and the name Quentin's own
        // message shows.
        expect(await accountRows(db, QUENTIN)).toBe(1);
        expect(await domainRows(db, "lighthouse.test")).toBe(1);
        const quentin = await entityOf(db, QUENTIN);
        const keptEvidence = evidenceIdOf(personalMail, kept.sourceItemId);
        expect(await admin(db, "select evidence_id from knowledge.aliases where entity_id = $1", [quentin])).toEqual([
          { evidence_id: keptEvidence },
        ]);
        expect(await naming(db, String(keptEvidence))).toEqual({
          "vault.evidence_items": 1,
          "knowledge.aliases": 1,
          "knowledge.messages": 1,
          "knowledge.interaction_log": 1,
          "knowledge.events": 0,
        });
        expect((await writer.ownerAddresses()).sort()).toEqual([OWNER.personal, OWNER.work].sort());
      }));

    it("a deleted event is removed with its details, participants and a person seen only in it", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        await ingestMail(writer, personalMail, MAIL.fromQuentin);
        const beforeEvent = await rowCounts(db);
        // The guest organizes; the owner and Quentin attend.
        expect(await ingestEvent(writer, personalCalendar, EVENTS.guest)).toBe("stored");
        expect(await accountRows(db, GUEST)).toBe(1);
        expect(changed(beforeEvent, await rowCounts(db))).toMatchObject({
          "knowledge.events": 1,
          "knowledge.event_details": 1,
          "knowledge.event_participants": 2,
        });

        // Google deleted it: the builder hands a bare cancellation over as a source deletion.
        const deletion = calendarItem(
          { id: EVENTS.guest.event.id, status: "cancelled" },
          { sourceAccount: personalCalendar.id, changeKind: "live", now: NOW },
        );
        if ("payload" in deletion) throw new Error("a bare cancellation is a deletion");
        await writer.applyDeletion(personalCalendar, deletion);

        // Nothing of the event is left, nor of the guest or the guest's organization.
        expect(await rowCounts(db)).toEqual(beforeEvent);
        expect(named(await naming(db, String(evidenceIdOf(personalCalendar, EVENTS.guest.event.id))))).toBe(0);
        expect(await accountRows(db, GUEST)).toBe(0);
        expect(await domainRows(db, "one-event.test")).toBe(0);
        // Quentin, who is also on a message, stays.
        expect(await accountRows(db, QUENTIN)).toBe(1);
      }));
  });

  it("a deletion in one compartment leaves the other compartment's rows", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, workMail } = await connect(writer);
      // The canary person, of one organization, is seen under `own` and under the employer's
      // compartment; Quentin, on Cc of the `own` message, under `own` alone.
      const ownItem = mailItem(MAIL.canary, personalMail);
      await ingestMail(writer, personalMail, MAIL.canary);
      await ingestMail(writer, workMail, MAIL.workCanary);
      const person = await entityOf(db, CANARY_PERSON);
      const organization = one(
        await admin<{ id: string }>(db, "select distinct entity_id as id from knowledge.domains where domain_fp = $1", [
          fingerprint(db.keys, "domain", CANARIES.domain),
        ]),
      ).id;
      const compartmentsOf = async (table: "accounts" | "domains", entity: string): Promise<string[][]> =>
        (
          await admin<{ compartments: string[] }>(
            db,
            `select compartments from knowledge.${table} where entity_id = $1 order by compartments`,
            [entity],
          )
        ).map((row) => row.compartments);
      expect(await compartmentsOf("accounts", person)).toEqual([["employer:example"], ["own"]]);
      expect(await compartmentsOf("domains", organization)).toEqual([["employer:example"], ["own"]]);

      const ownClient = await insertClient(db, "own-only", ["own"]);
      const employerClient = await insertClient(db, "employer-only", ["employer:example"]);
      const seen = (token: string): Promise<string[]> =>
        readAs(db, token, async (query) =>
          (
            await query<{ id: string }>("select id from knowledge.entities where id = any($1)", [
              [person, organization],
            ])
          )
            .map((row) => row.id)
            .sort(),
        );
      // The positive control: before the deletion, each client sees both entities.
      expect(await seen(ownClient.token)).toEqual([person, organization].sort());
      expect(await seen(employerClient.token)).toEqual([person, organization].sort());
      const workEvidence = evidenceIdOf(workMail, mailSourceId(MAIL.workCanary));
      const workRows = await naming(db, String(workEvidence));
      const before = await snapshot(db);

      await writer.applyDeletion(personalMail, {
        sourceAccount: personalMail.id,
        sourceItemId: ownItem.sourceItemId,
        deletedAt: NOW,
      });

      // The `own` account and domain rows go; the employer's rows and both entities stay.
      expect(named(await naming(db, String(evidenceIdOf(personalMail, ownItem.sourceItemId))))).toBe(0);
      expect(await compartmentsOf("accounts", person)).toEqual([["employer:example"]]);
      expect(await compartmentsOf("domains", organization)).toEqual([["employer:example"]]);
      expect(
        (
          await admin<{ id: string }>(db, "select id from knowledge.entities where id = any($1)", [
            [person, organization],
          ])
        )
          .map((row) => row.id)
          .sort(),
      ).toEqual([person, organization].sort());
      // Quentin was seen in that message alone, so Quentin and Quentin's organization are gone altogether.
      expect(await accountRows(db, QUENTIN)).toBe(0);
      expect(await domainRows(db, "lighthouse.test")).toBe(0);
      expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });
      // The employer's item, and every row derived from it, is as it was.
      expect(await naming(db, String(workEvidence))).toEqual(workRows);
      expect(workRows).toMatchObject({
        "vault.evidence_items": 1,
        "knowledge.messages": 1,
        "knowledge.interaction_log": 1,
      });
      const after = await snapshot(db);
      for (const [key, xmin] of after) expect(before.get(key), key).toBe(xmin);
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from knowledge.accounts where compartments = '{own}' and entity_id <> $1",
            [await ownerEntity(db)],
          ),
        ).n,
      ).toBe(0);

      // A reader cleared for `own` alone no longer sees either entity; the employer's still does.
      expect(await seen(ownClient.token)).toEqual([]);
      expect(await seen(employerClient.token)).toEqual([person, organization].sort());
    }));

  it("one source item id under two accounts is two items", () =>
    withStore(async ({ db, writer }) => {
      const { personalCalendar, workCalendar } = await connect(writer);
      // One event id, under the same etag, handed over by two accounts.
      const id = EVENTS.guest.event.id;
      const personalItem = eventItem(EVENTS.guest, personalCalendar);
      const workItem = eventItem(EVENTS.guest, workCalendar);
      expect([workItem.sourceItemId, workItem.revisionTag]).toEqual([
        personalItem.sourceItemId,
        personalItem.revisionTag,
      ]);
      const personalEvidence = evidenceIdOf(personalCalendar, id);
      const workEvidence = evidenceIdOf(workCalendar, id);
      expect(workEvidence).not.toBe(personalEvidence);

      // Neither is a repeat of the other...
      expect(await ingestEvent(writer, personalCalendar, EVENTS.guest)).toBe("stored");
      expect(await ingestEvent(writer, workCalendar, EVENTS.guest)).toBe("stored");
      // ...and each is a repeat of itself.
      expect(await ingestEvent(writer, personalCalendar, EVENTS.guest)).toBe("repeat");
      expect(await ingestEvent(writer, workCalendar, EVENTS.guest)).toBe("repeat");

      // Two revision-0 items with one source item fingerprint, each in its account's compartment.
      const evidence = await admin(
        db,
        "select id, source_account_id, source_item_fp, revision, supersedes, compartments from vault.evidence_items order by compartments",
      );
      const sourceItemFp = fingerprint(db.keys, "source_id", id);
      expect(evidence).toEqual([
        {
          id: workEvidence,
          source_account_id: workCalendar.id,
          source_item_fp: sourceItemFp,
          revision: 0,
          supersedes: null,
          compartments: ["employer:example"],
        },
        {
          id: personalEvidence,
          source_account_id: personalCalendar.id,
          source_item_fp: sourceItemFp,
          revision: 0,
          supersedes: null,
          compartments: ["own"],
        },
      ]);
      // Two events, each with its details and its two participants.
      const events = await admin<{
        id: string;
        evidence_id: string;
        compartments: string[];
        account_id: string;
        source_event_fp: string;
        participants: number;
      }>(
        db,
        `select e.id, e.evidence_id, e.compartments, d.account_id, d.source_event_fp,
                (select count(*)::int from knowledge.event_participants p where p.event_id = e.id and p.compartments = e.compartments) as participants
         from knowledge.events e join knowledge.event_details d on d.event_id = e.id and d.compartments = e.compartments order by e.compartments`,
      );
      expect(events).toEqual([
        {
          id: events[0]?.id,
          evidence_id: workEvidence,
          compartments: ["employer:example"],
          account_id: workCalendar.id,
          source_event_fp: sourceItemFp,
          participants: 2,
        },
        {
          id: events[1]?.id,
          evidence_id: personalEvidence,
          compartments: ["own"],
          account_id: personalCalendar.id,
          source_event_fp: sourceItemFp,
          participants: 2,
        },
      ]);
      expect(events[0]?.id).not.toBe(events[1]?.id);
      expect(await rowCounts(db)).toMatchObject({
        "vault.evidence_items": 2,
        "vault.evidence_blobs": 2,
        "knowledge.events": 2,
        "knowledge.event_details": 2,
        "knowledge.event_participants": 4,
      });

      // A new revision under one account is that account's alone: the other's item stays at
      // revision 0, and its event is not touched.
      const moved = event({
        event: {
          ...EVENTS.guest.event,
          etag: '"etag-guest-2"',
          updated: "2026-09-03T09:00:00Z",
          summary: "Guest walkabout, moved",
        },
        title: "Guest walkabout, moved",
        startsAt: EVENTS.guest.startsAt,
        endsAt: EVENTS.guest.endsAt,
        allDay: false,
      });
      const beforeRevision = await snapshot(db);
      expect(await ingestEvent(writer, workCalendar, moved)).toBe("stored");
      expect((await revisionsOf(db, workCalendar, id)).map((row) => row.revision)).toEqual([0, 1]);
      expect((await revisionsOf(db, personalCalendar, id)).map((row) => row.id)).toEqual([personalEvidence]);
      const workLatest = evidenceIdOf(workCalendar, id, 1);
      expect(await admin(db, "select id, evidence_id from knowledge.events order by compartments")).toEqual([
        { id: events[0]?.id, evidence_id: workLatest },
        { id: events[1]?.id, evidence_id: personalEvidence },
      ]);
      const afterRevision = await snapshot(db);
      for (const key of [
        `vault.evidence_items ${personalEvidence}`,
        `knowledge.events ${events[1]?.id}`,
        `knowledge.event_details ${events[1]?.id}`,
      ]) {
        expect(afterRevision.get(key), key).toBe(beforeRevision.get(key));
        expect(afterRevision.has(key), key).toBe(true);
      }

      // Deleting it under one account leaves the other's evidence and derived rows intact.
      const beforeDeletion = await snapshot(db);
      await writer.applyDeletion(personalCalendar, {
        sourceAccount: personalCalendar.id,
        sourceItemId: id,
        deletedAt: NOW,
      });
      expect(named(await naming(db, String(personalEvidence)))).toBe(0);
      expect((await revisionsOf(db, workCalendar, id)).map((row) => row.revision)).toEqual([0, 1]);
      const left = await admin(
        db,
        "select e.id, e.evidence_id, e.compartments, d.account_id from knowledge.events e join knowledge.event_details d on d.event_id = e.id",
      );
      expect(left).toEqual([
        { id: events[0]?.id, evidence_id: workLatest, compartments: ["employer:example"], account_id: workCalendar.id },
      ]);
      expect(await admin(db, "select distinct event_id, compartments from knowledge.event_participants")).toEqual([
        { event_id: events[0]?.id, compartments: ["employer:example"] },
      ]);
      expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.event_participants")).n).toBe(
        2,
      );
      // No surviving row was rewritten.
      const afterDeletion = await snapshot(db);
      for (const [key, xmin] of afterDeletion) expect(beforeDeletion.get(key), key).toBe(xmin);
      // The people on it are still there, under the employer's compartment alone.
      for (const who of [GUEST, QUENTIN]) {
        const rows = await admin(db, "select compartments from knowledge.accounts where value_fp = $1", [
          fingerprint(db.keys, "address", who.address),
        ]);
        expect(rows, who.address).toEqual([{ compartments: ["employer:example"] }]);
      }
      // And the positive control for the deletion: the same call under the other account removes its item.
      await writer.applyDeletion(workCalendar, { sourceAccount: workCalendar.id, sourceItemId: id, deletedAt: NOW });
      expect(await rowCounts(db)).toMatchObject({
        "vault.evidence_items": 0,
        "vault.evidence_blobs": 0,
        "knowledge.events": 0,
        "knowledge.event_details": 0,
        "knowledge.event_participants": 0,
      });
    }));

  it("logger calls carry PersonalLogEvent fields only", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoles = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")].map((spy) =>
      spy.mockImplementation(() => undefined),
    );
    try {
      const logged = await withStore(async ({ writer, logged }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        await ingestMail(writer, personalMail, MAIL.canary);
        await ingestMail(writer, personalMail, MAIL.canary);
        await ingestMail(writer, personalMail, MAIL.newsletter);
        await ingestMail(writer, personalMail, MAIL.unread);
        await ingestEvent(writer, personalCalendar, EVENTS.canary);
        // A failure whose message holds content: no log call may carry it.
        const broken = async (): Promise<ItemFacts> => {
          throw new Error(`could not read "${CANARIES.subject}" from ${CANARIES.address}`);
        };
        await expect(writer.ingestItem(personalMail, mailItem(MAIL.reply, personalMail), broken)).rejects.toThrow();
        await writer.finishPage(personalMail, {
          listing: { first: true, ended: "complete" },
          listedIds: [mailSourceId(MAIL.newsletter)],
          skippedIds: [],
          next: cursor(CANARIES.cursor),
        });
        await writer.recordOutcome(personalMail, "ok", NOW, 0);
        await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
        await writer.rederiveIfNeeded(derive);
        await expect(
          writer.ensureSourceAccount("personal", "google_mail", "employer:example", OWNER.personal),
        ).rejects.toMatchObject({ code: "account_mismatch" });
        return logged;
      });

      for (const call of logged)
        expect(PersonalLogEvent.safeParse(call.event).success, JSON.stringify(Object.keys(call.event))).toBe(true);
      const text = JSON.stringify(logged).toLowerCase();
      for (const canary of Object.values(CANARIES)) expect(text).not.toContain(canary.toLowerCase());
      // Nothing is written to stdout.
      expect(stdout).not.toHaveBeenCalled();
      for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
      // The control: the shape does refuse a field that could hold a free string.
      expect(PersonalLogEvent.safeParse({ event: "item_failed", detail: CANARIES.subject }).success).toBe(false);
    } finally {
      stdout.mockRestore();
      for (const spy of consoles) spy.mockRestore();
    }
  });

  describe("every row derived from an item carries its source account's compartment", () => {
    it("every row derived from an item carries its source account's compartment", () =>
      withStore(async ({ db, writer }) => {
        // The tables an ingest writes: every vault and knowledge table but the entities, which
        // have no compartments, extraction's, the owner's own (OWNER_ONLY), which no ingest writes,
        // and the pages, which only a research run's item writes (RESEARCH_KNOWLEDGE; its
        // compartment is the account's, research-store.db.test.ts). And vault.sync_outcomes,
        // written by a sync's recordOutcome, never by an item's ingest; its
        // compartments are its account's (coverage.db.test.ts). And knowledge.promoted_claims,
        // written only by a receiving instance's promotion intake (promotion.db.test.ts).
        const labelled = tablesIn("vault", "knowledge").filter(
          (table) =>
            table.name !== "knowledge.entities" &&
            table.name !== "vault.sync_outcomes" &&
            table.name !== "knowledge.promoted_claims" &&
            syncedBy(table.name) &&
            !OWNER_ONLY.includes(table.name) &&
            !RESEARCH_KNOWLEDGE.includes(table.name),
        );
        const compartments = async (): Promise<Map<string, string[]>> => {
          const rows = new Map<string, string[]>();
          for (const table of labelled) {
            for (const row of await admin<{ key: string; compartments: string[] }>(
              db,
              `select (${table.key})::text as key, compartments from ${table.name}`,
            ))
              rows.set(`${table.name} ${row.key}`, row.compartments);
          }
          return rows;
        };

        // The employer's account alone, first: every row in the store is its.
        const workMail = await writer.ensureSourceAccount("work", "google_mail", "employer:example", OWNER.work);
        const workCalendar = await writer.ensureSourceAccount(
          "work",
          "google_calendar",
          "employer:example",
          OWNER.work,
        );
        await ingestMail(writer, workMail, MAIL.workCanary);
        await ingestMail(writer, workMail, MAIL.workOnly);
        await ingestMail(writer, workMail, MAIL.workSent);
        await ingestEvent(writer, workCalendar, EVENTS.work);
        await writer.finishPage(workMail, {
          listing: { first: true },
          listedIds: [mailSourceId(MAIL.workOnly)],
          skippedIds: [],
          next: cursor("cursor-r16-1"),
        });
        const work = await compartments();
        const counts = await rowCounts(db);
        for (const table of labelled) expect(counts[table.name], table.name).toBeGreaterThan(0);
        for (const table of OWNER_ONLY) expect(counts[table], table).toBe(0);
        for (const [key, value] of work) expect(value, key).toEqual(["employer:example"]);

        // Then an account under `own`: every row added since is `own`, the shared person's included.
        const personalMail = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
        const personalCalendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER.personal);
        await ingestMail(writer, personalMail, MAIL.canary);
        await ingestMail(writer, personalMail, MAIL.reply);
        await ingestEvent(writer, personalCalendar, EVENTS.canary);
        const all = await compartments();
        const added = [...all].filter(([key]) => !work.has(key));
        expect(added.length).toBeGreaterThan(20);
        for (const [key, value] of added) expect(value, key).toEqual(["own"]);
        for (const [key, value] of work) expect(all.get(key), key).toEqual(value);

        // `readers` is the owner alone, wherever the table has the column.
        for (const table of ["vault.evidence_items", "knowledge.interaction_log", "knowledge.events"]) {
          const readers = await admin<{ readers: string[] }>(db, `select distinct readers from ${table}`);
          expect(readers, table).toEqual([{ readers: [THE_OWNER] }]);
        }

        const received = mailItem(MAIL.canary, personalMail);
        const receivedId = evidenceIdOf(personalMail, received.sourceItemId);
        const row = one(
          await admin<Record<string, unknown>>(
            db,
            `select source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, supersedes, next_revision_id, thread_fp, content_hash, media_type,
                    observed_at, change_kind, participant_members, sender_member, system_originated, payload_state, compartments, readers
             from vault.evidence_items where id = $1`,
            [receivedId],
          ),
        );
        expect({ ...row, observed_at: iso(row.observed_at) }).toEqual({
          source_account_id: personalMail.id,
          source_kind: "email",
          source_item_fp: fingerprint(db.keys, "source_id", received.sourceItemId),
          revision_tag_fp: fingerprint(db.keys, "revision_tag", received.revisionTag),
          revision: 0,
          supersedes: null,
          next_revision_id: evidenceIdOf(personalMail, received.sourceItemId, 1),
          thread_fp: fingerprint(db.keys, "thread", MAIL.canary.threadId),
          content_hash: hashFingerprint(db.keys, "content_hash", sha256OfBase64(received.payload)),
          media_type: "message/rfc822",
          observed_at: iso(received.observedAt),
          change_kind: "backfill",
          participant_members: [THE_OWNER],
          sender_member: null,
          system_originated: false,
          payload_state: "present",
          compartments: ["own"],
          readers: [THE_OWNER],
        });
        const sent = one(
          await admin(db, "select participant_members, sender_member from vault.evidence_items where id = $1", [
            evidenceIdOf(personalMail, mailSourceId(MAIL.reply)),
          ]),
        );
        expect(sent).toEqual({ participant_members: [THE_OWNER], sender_member: THE_OWNER });

        // A bulk item is kept in the two vault tables and in its one message row only...
        const beforeBulk = await rowCounts(db);
        expect(await ingestMail(writer, personalMail, MAIL.newsletter)).toBe("stored");
        expect(changed(beforeBulk, await rowCounts(db))).toEqual({
          "vault.evidence_items": 1,
          "vault.evidence_blobs": 1,
          "knowledge.messages": 1,
        });
        // ...except that a sent one still makes its sender an owner address, and has its recipient row.
        const beforeSent = await rowCounts(db);
        expect(await ingestMail(writer, personalMail, MAIL.bulkSent)).toBe("stored");
        expect(changed(beforeSent, await rowCounts(db))).toEqual({
          "vault.evidence_items": 1,
          "vault.evidence_blobs": 1,
          "vault.sent_recipients": 1,
          "knowledge.accounts": 1,
          "knowledge.messages": 1,
        });
        const bulk = await admin(
          db,
          "select participant_members, sender_member, compartments from vault.evidence_items where id = any($1) order by sender_member nulls first",
          [
            [
              evidenceIdOf(personalMail, mailSourceId(MAIL.newsletter)),
              evidenceIdOf(personalMail, mailSourceId(MAIL.bulkSent)),
            ],
          ],
        );
        expect(bulk).toEqual([
          { participant_members: [THE_OWNER], sender_member: null, compartments: ["own"] },
          { participant_members: [THE_OWNER], sender_member: THE_OWNER, compartments: ["own"] },
        ]);
      }));

    it("an unread item is kept as evidence and derives nothing", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const raw = mailItem(MAIL.unread, personalMail);
        const before = await rowCounts(db);

        expect(await writer.ingestItem(personalMail, raw, mailFacts(MAIL.unread))).toBe("unread");

        expect(changed(before, await rowCounts(db))).toEqual({ "vault.evidence_items": 1, "vault.evidence_blobs": 1 });
        const evidence = one(
          await admin<{
            blob_ref: string;
            participant_members: string[];
            sender_member: string | null;
            compartments: string[];
            item_enc: unknown;
          }>(
            db,
            "select blob_ref, participant_members, sender_member, compartments, item_enc from vault.evidence_items where id = $1",
            [evidenceIdOf(personalMail, raw.sourceItemId)],
          ),
        );
        expect(evidence).toMatchObject({
          participant_members: [THE_OWNER],
          sender_member: null,
          compartments: ["own"],
        });
        // The evidence is whole: the raw item and its payload open as they were handed over.
        const item = opened(
          db,
          "own",
          { table: "vault.evidence_items", id: evidenceIdOf(personalMail, raw.sourceItemId), column: "item_enc" },
          evidence.item_enc,
        );
        expect(JSON.parse(item)).toEqual(withoutPayload(raw));
        const blob = one(
          await admin<{ envelope: unknown }>(db, "select envelope from vault.evidence_blobs where blob_ref = $1", [
            evidence.blob_ref,
          ]),
        );
        expect(
          opened(
            db,
            "own",
            { table: "vault.evidence_blobs", id: evidence.blob_ref, column: "envelope" },
            blob.envelope,
          ),
        ).toBe(raw.payload);
        // Handed over again, it is a repeat.
        expect(await writer.ingestItem(personalMail, raw, mailFacts(MAIL.unread))).toBe("repeat");
        expect(changed(before, await rowCounts(db))).toEqual({ "vault.evidence_items": 1, "vault.evidence_blobs": 1 });
      }));
  });

  describe("finishPage keeps a full listing's reconciliation durable across kills", () => {
    it("finishPage keeps a full listing's reconciliation durable across kills", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        const [a, b, c] = [MAIL.canary, MAIL.fromQuentin, MAIL.solo].map(mailSourceId) as [string, string, string];
        const w = mailSourceId(MAIL.workOnly);
        for (const fixture of [MAIL.canary, MAIL.fromQuentin, MAIL.solo])
          await ingestMail(writer, personalMail, fixture);
        await ingestMail(writer, workMail, MAIL.workOnly);

        // An earlier listing that was never finished left a row for C; the other account has a
        // listing of its own under way.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [c],
            skippedIds: [],
            next: cursor("p-0"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(
          await writer.finishPage(workMail, {
            listing: { first: true },
            listedIds: [w],
            skippedIds: [],
            next: cursor("w-0"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(await listedRows(db, personalMail)).toEqual([{ fp: fingerprint(db.keys, "source_id", c) }]);

        // A first page deletes the account's listed rows before it adds its own.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [a],
            skippedIds: [],
            next: cursor("p-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(await listedRows(db, personalMail)).toEqual([{ fp: fingerprint(db.keys, "source_id", a) }]);
        expect(await listedRows(db, workMail)).toHaveLength(1);
        expect(await writer.cursor(personalMail)).toBe("p-1");

        // A page with no listing touches no listed row, and still moves the cursor.
        const listed = await admin<{ key: string; xmin: string }>(
          db,
          "select account_id || source_item_fp as key, xmin::text as xmin from vault.listed_items order by 1",
        );
        expect(await writer.finishPage(personalMail, { listedIds: [b], skippedIds: [], next: cursor("p-2") })).toEqual({
          removed: 0,
          reconciled: false,
          recordsRemoved: 0,
        });
        expect(
          await admin(
            db,
            "select account_id || source_item_fp as key, xmin::text as xmin from vault.listed_items order by 1",
          ),
        ).toEqual(listed);
        expect(await writer.cursor(personalMail)).toBe("p-2");

        // The last page, complete: C was not listed, so it is removed as a deletion removes it.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: false, ended: "complete" },
            listedIds: [b],
            skippedIds: [],
            next: cursor("p-3"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a, b));
        expect(await accountRows(db, SOLO)).toBe(0);
        expect(await listedRows(db, personalMail)).toEqual([]);
        expect(await writer.cursor(personalMail)).toBe("p-3");
        // The other account's listing and items are untouched.
        expect(await listedRows(db, workMail)).toHaveLength(1);
        expect(await storedSourceItems(db, workMail)).toEqual(fps(db, w));
        expect(await writer.cursor(workMail)).toBe("w-0");
      }));

    it("a listing killed after its second page and resumed reconciles as one that ran whole", () =>
      withDatabase((whole) =>
        withDatabase(
          async (killed) => {
            const fixtures = [MAIL.canary, MAIL.fromQuentin, MAIL.solo, MAIL.reply];
            const [a, b, c] = fixtures.map(mailSourceId) as [string, string, string, string];
            const load = async (writer: Writer): Promise<SourceAccountRow> => {
              const { personalMail } = await connect(writer);
              for (const fixture of fixtures) await ingestMail(writer, personalMail, fixture);
              return personalMail;
            };
            const pages = [
              { listing: { first: true }, listedIds: [a], skippedIds: [], next: cursor("page-1") },
              { listing: { first: false }, listedIds: [b], skippedIds: [], next: cursor("page-2") },
              {
                listing: { first: false, ended: "complete" as const },
                listedIds: [c],
                skippedIds: [],
                next: cursor("page-3"),
              },
            ] as const;

            // One that ran whole.
            const ranWhole = await withWriter(whole, async (writer) => {
              const account = await load(writer);
              const results = [];
              for (const page of pages)
                results.push(
                  await writer.finishPage(account, { ...page, listedIds: [...page.listedIds], skippedIds: [] }),
                );
              return results;
            });
            expect(ranWhole).toEqual([
              { removed: 0, reconciled: false, recordsRemoved: 0 },
              { removed: 0, reconciled: false, recordsRemoved: 0 },
              { removed: 1, reconciled: true, recordsRemoved: 0 },
            ]);

            // One killed after its second page: the writer is gone, and with it everything in memory.
            await withWriter(killed, async (writer) => {
              const account = await load(writer);
              for (const page of pages.slice(0, 2))
                await writer.finishPage(account, { ...page, listedIds: [...page.listedIds], skippedIds: [] });
            });
            // Resumed by a new writer, from the stored cursor.
            const resumed = await withWriter(killed, async (writer) => {
              const account = (await writer.listSourceAccounts()).find(
                (row) => row.label === "personal" && row.connector === "google_mail",
              );
              if (account === undefined) throw new Error("the personal mail account is not stored");
              expect(await writer.cursor(account)).toBe("page-2");
              const [, , last] = pages;
              return writer.finishPage(account, { ...last, listedIds: [...last.listedIds], skippedIds: [] });
            });
            expect(resumed).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });

            // The same rows either way: the two share one key file, so every fingerprint compares.
            expect(await rowCounts(killed)).toEqual(await rowCounts(whole));
            expect(await comparableRows(killed)).toEqual(await comparableRows(whole));
            const left = await admin<{ fp: string }>(
              killed,
              "select distinct source_item_fp as fp from vault.evidence_items",
            );
            expect(left.map((row) => row.fp).sort()).toEqual(fps(killed, a, b, c));
            expect(one(await admin<{ n: number }>(killed, "select count(*)::int as n from vault.listed_items")).n).toBe(
              0,
            );
          },
          { keyFile: whole.keyFile },
        ),
      ));

    it("a listing ended at the window removes nothing", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const [a, b] = [MAIL.canary, MAIL.solo].map(mailSourceId) as [string, string];
        await ingestMail(writer, personalMail, MAIL.canary);
        await ingestMail(writer, personalMail, MAIL.solo);

        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [a],
            skippedIds: [],
            next: cursor("window-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: false, ended: "window" },
            listedIds: [],
            skippedIds: [],
            next: cursor("window-2"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a, b));
        // Its rows are deleted and its cursor set, so the next full listing starts clean.
        expect(await listedRows(db, personalMail)).toEqual([]);
        expect(await writer.cursor(personalMail)).toBe("window-2");

        // The positive control: the same listing, ended complete, removes the unlisted item.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [a],
            skippedIds: [],
            next: cursor("complete-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: false, ended: "complete" },
            listedIds: [],
            skippedIds: [],
            next: cursor("complete-2"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a));
      }));

    it("a complete listing that skipped an item reconciles the rest", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const [a, b] = [MAIL.canary, MAIL.solo, MAIL.fromQuentin].map(mailSourceId) as [string, string, string];
        for (const fixture of [MAIL.canary, MAIL.solo, MAIL.fromQuentin])
          await ingestMail(writer, personalMail, fixture);

        // A page adds a row per listed id and per skipped id alike: here a stored item's own id,
        // and the id of one that was never stored. A skipped id counts as listed.
        const skippedIds = [b, "gmail-id:never-read-0001"];
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true },
            listedIds: [a],
            skippedIds,
            next: cursor("skipped-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(await listedRows(db, personalMail)).toEqual(
          [
            { fp: fingerprint(db.keys, "source_id", a) },
            { fp: fingerprint(db.keys, "source_id", b) },
            { fp: fingerprint(db.keys, "source_id", "gmail-id:never-read-0001") },
          ].sort((left, right) => (left.fp < right.fp ? -1 : 1)),
        );
        // Complete, though it skipped: the unlisted item is removed, and the skipped id's stored
        // item is left as it is.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: false, ended: "complete" },
            listedIds: [],
            skippedIds: [],
            next: cursor("skipped-2"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a, b));
        expect(await accountRows(db, QUENTIN)).toBe(1);
        expect(await accountRows(db, SOLO)).toBe(1);
        expect(await listedRows(db, personalMail)).toEqual([]);
        expect(await writer.cursor(personalMail)).toBe("skipped-2");
        // The skipped id that was never stored made no item.
        expect(await storedSourceItems(db, personalMail)).not.toContain(
          fingerprint(db.keys, "source_id", "gmail-id:never-read-0001"),
        );

        // The control: what kept the skipped item was its place in the listing. The next full
        // listing neither lists nor skips it, and it is removed like any unlisted item.
        expect(
          await writer.finishPage(personalMail, {
            listing: { first: true, ended: "complete" },
            listedIds: [a],
            skippedIds: [],
            next: cursor("skipped-3"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, a));
        expect(await accountRows(db, SOLO)).toBe(0);
      }));

    it("a calendar listing reconciles only after listing.since", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar, personalMail } = await connect(writer);
        const since = "2026-09-01T00:00:00Z";
        const listed = plainEvent("evlisted01", "2026-09-25T10:00:00Z");
        const endedBefore = plainEvent("evbefore02", "2026-08-25T10:00:00Z");
        const endsAfter = plainEvent("evafter03", "2026-09-20T10:00:00Z");
        const endUnknown = plainEvent("evunknown04", null);
        for (const fixture of [listed, endedBefore, endsAfter, endUnknown])
          expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");
        // Another account's item is no part of this listing.
        await ingestMail(writer, personalMail, MAIL.fromQuentin);

        expect(
          await writer.finishPage(personalCalendar, {
            listing: { first: true, since },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor("calendar-1"),
          }),
        ).toEqual({ removed: 0, reconciled: false, recordsRemoved: 0 });
        expect(
          await writer.finishPage(personalCalendar, {
            listing: { first: false, ended: "complete", since },
            listedIds: [],
            skippedIds: [],
            next: cursor("calendar-2"),
          }),
        ).toEqual({ removed: 2, reconciled: true, recordsRemoved: 0 });
        // The unlisted event that ended before `since` stays; the one that ends after it, and the
        // one whose end is unknown, are removed.
        expect(await storedSourceItems(db, personalCalendar)).toEqual(fps(db, listed.event.id, endedBefore.event.id));
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from knowledge.events")).n).toBe(2);
        expect(await storedSourceItems(db, personalMail)).toHaveLength(1);

        // A listing with no `since` reconciles every stored event.
        expect(
          await writer.finishPage(personalCalendar, {
            listing: { first: true, ended: "complete" },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor("calendar-3"),
          }),
        ).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(fps(db, listed.event.id));
      }));
  });

  describe("a calendar listing with listing.until reconciles only what starts before it", () => {
    it("a calendar listing keeps an unlisted event that starts at or after listing.until", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const [since, until] = ["2026-09-01T00:00:00Z", "2027-09-15T12:00:00Z"];
        const starting = (fixture: EventFixture, start: string | null): EventFixture => {
          const { start: _start, ...rest } = fixture.event;
          return {
            ...fixture,
            event: { ...rest, ...(start === null ? {} : { start: { dateTime: start } }) },
            startsAt: start,
          };
        };
        const listed = plainEvent("evlisted21", "2026-09-25T10:00:00Z");
        const startsBefore = starting(plainEvent("evbefore22", "2027-09-15T13:00:00Z"), "2027-09-15T11:59:59Z");
        const startsAt = starting(plainEvent("evatuntil23", "2027-09-15T13:00:00Z"), until);
        const startsAfter = starting(plainEvent("evafter24", "2028-01-01T10:00:00Z"), "2028-01-01T09:00:00Z");
        const startUnknown = starting(plainEvent("evnostart25", "2026-09-20T10:00:00Z"), null);
        // An all-day event's start is midnight UTC of its date, read by the source in the
        // calendar's zone: it is kept unless it starts more than fourteen hours before the bound.
        const allDayWithin = allDayEvent("evallday26", "2027-09-15", "2027-09-16");
        const allDayBefore = allDayEvent("evallday27", "2027-09-14", "2027-09-15");
        const all = [listed, startsBefore, startsAt, startsAfter, startUnknown, allDayWithin, allDayBefore];
        for (const fixture of all) expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");

        const complete = (listing: { since?: string; until?: string }, next: string) =>
          writer.finishPage(personalCalendar, {
            listing: { first: true, ended: "complete", ...listing },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor(next),
          });
        expect(await complete({ since, until }, "until-1")).toEqual({
          removed: 3,
          reconciled: true,
          recordsRemoved: 0,
        });
        // What starts at or after the bound the listing did not reach stays; what starts before
        // it, or at no known time, is removed.
        expect(await storedSourceItems(db, personalCalendar)).toEqual(
          fps(db, listed.event.id, startsAt.event.id, startsAfter.event.id, allDayWithin.event.id),
        );

        // With until alone, the same holds; with no until, everything unlisted after since goes.
        expect(await complete({ until }, "until-2")).toEqual({ removed: 0, reconciled: true, recordsRemoved: 0 });
        expect(await complete({ since }, "until-3")).toEqual({ removed: 3, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(fps(db, listed.event.id));
      }));
  });

  describe("past listing.until, a recurring occurrence goes and a one-off event stays", () => {
    it("an event whose id has the instance form is stored recurring", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const fixtures = [
          plainEvent("evseries31_20270915T090000Z", "2027-09-15T10:00:00Z"),
          allDayEvent("evseries32_20270915", "2027-09-15", "2027-09-16"),
          plainEvent("evsingle33", "2027-09-15T10:00:00Z"),
          plainEvent("evnear34_2027", "2027-09-15T10:00:00Z"),
        ];
        for (const fixture of fixtures) expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");
        const recurring = async (id: string): Promise<boolean | null> =>
          one(
            await admin<{ recurring: boolean | null }>(
              db,
              "select recurring from knowledge.event_details where source_event_fp = $1",
              [fingerprint(db.keys, "source_id", id)],
            ),
          ).recurring;
        expect(await Promise.all(fixtures.map((fixture) => recurring(fixture.event.id)))).toEqual([
          true,
          true,
          false,
          false,
        ]);
      }));

    it("a calendar listing with listing.until removes past it only the occurrences of a series", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const [since, until] = ["2026-09-01T00:00:00Z", "2027-09-15T12:00:00Z"];
        const starting = (fixture: EventFixture, start: string): EventFixture => ({
          ...fixture,
          event: { ...fixture.event, start: { dateTime: start } },
          startsAt: start,
        });
        const listed = plainEvent("evlisted51", "2026-09-25T10:00:00Z");
        const oneOff = starting(plainEvent("evoneoff52", "2028-01-01T10:00:00Z"), "2028-01-01T09:00:00Z");
        const occurrence = starting(
          plainEvent("evseries53_20280101T090000Z", "2028-01-01T10:00:00Z"),
          "2028-01-01T09:00:00Z",
        );
        const allDayOccurrence = allDayEvent("evseries54_20270915", "2027-09-15", "2027-09-16");
        const oldOneOff = starting(plainEvent("evoneoff55", "2028-02-01T10:00:00Z"), "2028-02-01T09:00:00Z");
        const oldOccurrence = starting(
          plainEvent("evseries56_20280201T090000Z", "2028-02-01T10:00:00Z"),
          "2028-02-01T09:00:00Z",
        );
        for (const fixture of [listed, oneOff, occurrence, allDayOccurrence, oldOneOff, oldOccurrence])
          expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");
        // Two rows as a store before the column holds them: what they are is read from the item.
        const unknown = [oldOneOff, oldOccurrence].map((fixture) =>
          fingerprint(db.keys, "source_id", fixture.event.id),
        );
        await admin(db, "update knowledge.event_details set recurring = null where source_event_fp = any($1)", [
          unknown,
        ]);

        expect(
          await writer.finishPage(personalCalendar, {
            listing: { first: true, ended: "complete", since, until },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor("recurring-1"),
          }),
        ).toEqual({
          removed: 3,
          reconciled: true,
          recordsRemoved: 0,
        });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(
          fps(db, listed.event.id, oneOff.event.id, oldOneOff.event.id),
        );
        // The row whose kind was unknown is now known.
        expect(
          await admin(db, "select recurring from knowledge.event_details where source_event_fp = $1", [unknown[0]]),
        ).toEqual([{ recurring: false }]);
      }));

    it("an occurrence that ends before listing.since stays, an unknown row there is not read, and past listing.until an unknown row whose item does not open stays unknown and is kept", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const [since, until] = ["2026-09-01T00:00:00Z", "2027-09-15T12:00:00Z"];
        const starting = (fixture: EventFixture, start: string): EventFixture => ({
          ...fixture,
          event: { ...fixture.event, start: { dateTime: start } },
          startsAt: start,
        });
        const listed = plainEvent("evlisted61", "2026-09-25T10:00:00Z");
        const pastOccurrence = starting(
          plainEvent("evseries62_20260801T090000Z", "2026-08-01T10:00:00Z"),
          "2026-08-01T09:00:00Z",
        );
        const pastUnknown = starting(
          plainEvent("evseries63_20260802T090000Z", "2026-08-02T10:00:00Z"),
          "2026-08-02T09:00:00Z",
        );
        const unopened = starting(
          plainEvent("evseries64_20280301T090000Z", "2028-03-01T10:00:00Z"),
          "2028-03-01T09:00:00Z",
        );
        for (const fixture of [listed, pastOccurrence, pastUnknown, unopened])
          expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");
        const [pastFp, unopenedFp, listedFp] = [pastUnknown, unopened, listed].map((fixture) =>
          fingerprint(db.keys, "source_id", fixture.event.id),
        );
        await admin(db, "update knowledge.event_details set recurring = null where source_event_fp = any($1)", [
          [pastFp, unopenedFp],
        ]);
        // The unopened row's item is another row's envelope, bound to that row: it does not open here.
        const swap = `update vault.evidence_items set item_enc = (select item_enc from vault.evidence_items where source_account_id = $1 and source_item_fp = $3) where source_account_id = $1 and source_item_fp = $2`;
        await tampering(db, () => admin(db, swap, [personalCalendar.id, unopenedFp, listedFp]));

        expect(
          await writer.finishPage(personalCalendar, {
            listing: { first: true, ended: "complete", since, until },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor("recurring-2"),
          }),
        ).toEqual({
          removed: 0,
          reconciled: true,
          recordsRemoved: 0,
        });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(
          fps(db, listed.event.id, pastOccurrence.event.id, pastUnknown.event.id, unopened.event.id),
        );
        // Neither unknown row was decided: one is before listing.since, where its kind changes
        // nothing, and the other's item does not open.
        expect(
          await admin(db, "select recurring from knowledge.event_details where source_event_fp = any($1)", [
            [pastFp, unopenedFp],
          ]),
        ).toEqual([{ recurring: null }, { recurring: null }]);
      }));
  });

  describe("an all-day event's end is midnight UTC of its date, and the listing's bound is in the calendar's zone", () => {
    it("an all-day event that ends within fourteen hours after listing.since stays", () =>
      withStore(async ({ db, writer }) => {
        const { personalCalendar } = await connect(writer);
        const since = "2026-08-31T10:00:00Z";
        const listed = plainEvent("evlisted11", "2026-09-25T10:00:00Z");
        // Stored as ending at 2026-09-01T00:00:00Z, fourteen hours after `since` to the second.
        // In a calendar kept fourteen hours east of UTC it ended at `since`, so the source did
        // not list it, and it still exists.
        const allDayWithin = allDayEvent("evallday12", "2026-08-31", "2026-09-01");
        const allDayAfter = allDayEvent("evallday13", "2026-09-01", "2026-09-02");
        // A timed event's end is an instant: the allowance is not for it.
        const timedWithin = plainEvent("evtimed14", "2026-08-31T22:00:00Z");
        for (const fixture of [listed, allDayWithin, allDayAfter, timedWithin])
          expect(await ingestEvent(writer, personalCalendar, fixture)).toBe("stored");
        expect(
          await admin(db, "select all_day, ends_at from knowledge.event_details where source_event_fp = $1", [
            fingerprint(db.keys, "source_id", allDayWithin.event.id),
          ]),
        ).toEqual([{ all_day: true, ends_at: new Date("2026-09-01T00:00:00Z") }]);

        const complete = (bound: string, next: string) =>
          writer.finishPage(personalCalendar, {
            listing: { first: true, ended: "complete", since: bound },
            listedIds: [listed.event.id],
            skippedIds: [],
            next: cursor(next),
          });
        expect(await complete(since, "allday-1")).toEqual({ removed: 2, reconciled: true, recordsRemoved: 0 });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(fps(db, listed.event.id, allDayWithin.event.id));

        // The positive control: a second earlier, the same event ends more than fourteen hours
        // after the bound, and an unlisted one is removed.
        expect(await complete("2026-08-31T09:59:59Z", "allday-2")).toEqual({
          removed: 1,
          reconciled: true,
          recordsRemoved: 0,
        });
        expect(await storedSourceItems(db, personalCalendar)).toEqual(fps(db, listed.event.id));
      }));
  });

  describe("a repeat is the latest revision's tag, and no earlier one's", () => {
    it("a label set seen before is a new revision", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // One Gmail message under two sets of labels: its revision tag covers the deriving ones.
        const labelled = (labels: string[]): RawItem => mailItem({ ...MAIL.solo, labels }, personalMail);
        const [spam, inbox] = [labelled(["SPAM"]), labelled(["INBOX"])];
        expect(spam.sourceItemId).toBe(inbox.sourceItemId);
        expect(spam.revisionTag).not.toBe(inbox.revisionTag);
        const [spamFp, inboxFp] = [spam, inbox].map((raw) => fingerprint(db.keys, "revision_tag", raw.revisionTag));
        const bulk = async (): Promise<ItemFacts> => ({
          kind: "email",
          members: { participantMembers: [THE_OWNER] },
          bulk: true,
          message: mailMessage({ ...MAIL.solo, labels: ["SPAM"] }),
        });
        const [rev0, rev1, rev2, rev3] = [0, 1, 2, 3].map((revision) =>
          evidenceIdOf(personalMail, spam.sourceItemId, revision),
        );

        // First seen in spam: evidence only. The same labels again are a repeat.
        expect(await writer.ingestItem(personalMail, spam, bulk)).toBe("stored");
        expect(await writer.ingestItem(personalMail, spam, bulk)).toBe("repeat");
        expect(await accountRows(db, SOLO)).toBe(0);
        // Moved to the inbox: the next revision, and the message is a person's.
        expect(await writer.ingestItem(personalMail, inbox, mailFacts(MAIL.solo))).toBe("stored");
        expect(await accountRows(db, SOLO)).toBe(1);
        expect((await naming(db, String(rev1)))["knowledge.messages"]).toBe(1);

        // Back in spam: a tag an earlier revision carried, and a third revision all the same.
        expect(await writer.ingestItem(personalMail, spam, bulk)).toBe("stored");
        expect(await revisionsOf(db, personalMail, spam.sourceItemId)).toEqual([
          { id: rev0, revision: 0, supersedes: null, next_revision_id: rev1, revision_tag_fp: spamFp },
          { id: rev1, revision: 1, supersedes: rev0, next_revision_id: rev2, revision_tag_fp: inboxFp },
          { id: rev2, revision: 2, supersedes: rev1, next_revision_id: rev3, revision_tag_fp: spamFp },
        ]);
        // Its derived rows went with the revision that made them, and so did whoever only it named.
        for (const id of [rev0, rev1]) expect(named(await naming(db, String(id))), String(id)).toBe(1);
        // The latest revision, a bulk one, is named by its evidence row and by the message's one
        // row.
        expect(named(await naming(db, String(rev2))), String(rev2)).toBe(2);
        expect(await accountRows(db, SOLO)).toBe(0);
        // The latest tag is a repeat again; the earlier one is not.
        expect(await writer.ingestItem(personalMail, spam, bulk)).toBe("repeat");
        expect(await writer.ingestItem(personalMail, inbox, mailFacts(MAIL.solo))).toBe("stored");
        expect(await revisionsOf(db, personalMail, spam.sourceItemId)).toHaveLength(4);
        expect(await accountRows(db, SOLO)).toBe(1);
      }));
  });

  describe("two Gmail messages are two source items, whatever their Message-ID headers", () => {
    it("two Gmail messages with one Message-ID are two source items, and deleting one leaves the other", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        expect(MAIL.twinA.messageId).toBe(MAIL.twinB.messageId);
        const a = mailItem(MAIL.twinA, personalMail);
        const b = mailItem(MAIL.twinB, personalMail);
        expect(await ingestMail(writer, personalMail, MAIL.twinA)).toBe("stored");
        expect(await ingestMail(writer, personalMail, MAIL.twinB)).toBe("stored");

        // Two items with two evidence ids, neither a revision of the other.
        const stored = await admin<{ id: string; revision: number; supersedes: string | null; source_item_fp: string }>(
          db,
          "select id, revision, supersedes, source_item_fp from vault.evidence_items order by source_item_fp",
        );
        expect(stored).toHaveLength(2);
        expect(new Set(stored.map((row) => row.id)).size).toBe(2);
        expect(new Set(stored.map((row) => row.source_item_fp)).size).toBe(2);
        for (const row of stored) expect(row).toMatchObject({ revision: 0, supersedes: null });
        const evidenceB = evidenceIdOf(personalMail, b.sourceItemId);
        const citingB = await naming(db, String(evidenceB));
        expect(citingB).toMatchObject({
          "vault.evidence_items": 1,
          "knowledge.messages": 1,
          "knowledge.interaction_log": 1,
        });

        // A deletion names one of them by its own source id, and under its own account: the same
        // id under another account removes nothing.
        expect(a.sourceItemId).not.toBe(b.sourceItemId);
        const before = await snapshot(db);
        await writer.applyDeletion(workMail, {
          sourceAccount: workMail.id,
          sourceItemId: a.sourceItemId,
          deletedAt: NOW,
        });
        expect(await snapshot(db)).toEqual(before);

        // Applying it leaves the other's evidence and derived rows intact.
        await writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: a.sourceItemId,
          deletedAt: NOW,
        });
        expect(named(await naming(db, String(evidenceIdOf(personalMail, a.sourceItemId))))).toBe(0);
        expect(await naming(db, String(evidenceB))).toEqual(citingB);
        const after = await snapshot(db);
        expect(after.get(`vault.evidence_items ${evidenceB}`)).toBe(before.get(`vault.evidence_items ${evidenceB}`));
        // Quentin sent only the first; Solo, who sent the second, stays.
        expect(await accountRows(db, QUENTIN)).toBe(0);
        expect(await accountRows(db, SOLO)).toBe(1);
        expect(await storedSourceItems(db, personalMail)).toEqual(fps(db, b.sourceItemId));
      }));
  });

  describe("rederiveIfNeeded", () => {
    // A store with mail and a meeting, where the address of one person on them is then made the
    // owner's by connecting an account under it.
    const needingRederive = async (db: TestDatabase, writer: Writer): Promise<void> => {
      const { personalMail, personalCalendar } = await connect(writer);
      for (const fixture of [MAIL.canary, MAIL.reply, MAIL.fromQuentin, MAIL.newsletter, MAIL.unread])
        await fromRegistry(writer, personalMail, mailItem(fixture, personalMail));
      await fromRegistry(writer, personalCalendar, eventItem(EVENTS.canary, personalCalendar));
      await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
      // The owner's row stands beside the person's until the re-derive.
      const holders = await admin<{ kind: string }>(
        db,
        "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by 1",
        [fingerprint(db.keys, "address", QUENTIN.address)],
      );
      expect(holders.map((row) => row.kind)).toEqual(["owner", "person"]);
    };

    it("a re-derive gives the same rows as ingesting with the owner address known from the start", () =>
      withDatabase((knewFirst) =>
        withDatabase(
          async (learnedAfter) => {
            const load = (db: TestDatabase, when: "first" | "after") =>
              withWriter(db, async (writer) => {
                const mailAccount = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
                const calendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER.personal);
                const second = (): Promise<SourceAccountRow> =>
                  writer.ensureSourceAccount("second", "google_mail", "own", LATER_OWNER.address);
                if (when === "first") await second();
                // The address sends one message, receives another and attends an event.
                expect(await fromRegistry(writer, mailAccount, mailItem(MAIL.fromLater, mailAccount))).toBe("stored");
                expect(await fromRegistry(writer, mailAccount, mailItem(MAIL.toLater, mailAccount))).toBe("stored");
                expect(await fromRegistry(writer, calendar, eventItem(EVENTS.withLater, calendar))).toBe("stored");
                if (when === "after") await second();
                const people = one(
                  await admin<{ n: number }>(
                    db,
                    "select count(*)::int as n from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 and e.kind = 'person'",
                    [fingerprint(db.keys, "address", LATER_OWNER.address)],
                  ),
                ).n;
                return { heldByPerson: people, result: await writer.rederiveIfNeeded(derive) };
              });

            expect(await load(knewFirst, "first")).toEqual({
              heldByPerson: 0,
              result: { rederived: false, items: 0, coarser: 0 },
            });
            expect(await load(learnedAfter, "after")).toEqual({
              heldByPerson: 1,
              result: { rederived: true, items: 3, coarser: 0 },
            });

            // The same row count per table, and the same rows.
            expect(await rowCounts(learnedAfter)).toEqual(await rowCounts(knewFirst));
            expect(await comparableRows(learnedAfter)).toEqual(await comparableRows(knewFirst));
            // And what they agree on: the address is the owner's alone.
            for (const db of [knewFirst, learnedAfter]) {
              const holders = await admin(
                db,
                "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
                [fingerprint(db.keys, "address", LATER_OWNER.address)],
              );
              expect(holders).toEqual([{ kind: "owner" }]);
            }
          },
          { keyFile: knewFirst.keyFile },
        ),
      ));

    it("a re-derive over more items than one batch reads them a batch at a time and gives the same rows", () =>
      withDatabase((knewFirst) =>
        withDatabase(
          async (learnedAfter) => {
            const batch = 25;
            const fixtures = Array.from({ length: 16 * batch + 5 }, (_, index) => {
              const n = String(index + 1).padStart(4, "0");
              return mail({
                id: `gm-batch-${n}`,
                threadId: `thread-batch-${n}`,
                at: new Date(Date.parse("2026-07-01T00:00:00Z") + index * 60_000).toISOString(),
                from: [LATER_OWNER, QUENTIN, RHEA][index % 3] as Who,
                to: [{ address: OWNER.personal }],
                subject: `Batch ${n}`,
                labels: ["INBOX"],
              });
            });

            // The two databases are loaded side by side, and re-derived one after the other.
            const ingest = async (writer: Writer, when: "first" | "after"): Promise<void> => {
              const mailAccount = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
              const second = (): Promise<SourceAccountRow> =>
                writer.ensureSourceAccount("second", "google_mail", "own", LATER_OWNER.address);
              if (when === "first") await second();
              for (const fixture of fixtures) await fromRegistry(writer, mailAccount, mailItem(fixture, mailAccount));
              if (when === "after") await second();
            };
            const rederive = async (writer: Writer) => {
              // Every statement any client sends while the re-derive runs, with how many rows
              // came back: the writer makes its own pool, so there is none to wrap.
              const derived: string[] = [];
              let most = 0;
              const query = pg.Client.prototype.query;
              const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
                this: pg.Client,
                ...args: unknown[]
              ) {
                const sent: unknown = (query as (...given: unknown[]) => unknown).apply(this, args);
                if (sent instanceof Promise)
                  void sent.then(
                    (result: { rows?: unknown[] }) => (most = Math.max(most, result.rows?.length ?? 0)),
                    () => undefined,
                  );
                return sent;
              } as typeof query);
              try {
                const result = await writer.rederiveIfNeeded((raw, ctx) => {
                  derived.push(raw.sourceItemId);
                  return derive(raw, ctx);
                });
                return { result, derived, most };
              } finally {
                spy.mockRestore();
              }
            };

            const after = await withWriter(knewFirst, (first) =>
              withWriter(learnedAfter, async (later) => {
                await Promise.all([ingest(first, "first"), ingest(later, "after")]);
                expect(await rederive(first)).toMatchObject({ result: { rederived: false, items: 0 }, derived: [] });
                return rederive(later);
              }),
            );
            expect(after.result).toEqual({ rederived: true, items: fixtures.length, coarser: 0 });
            // Each item once, oldest first, as one read of them all gave them.
            expect(after.derived).toEqual(fixtures.map(mailSourceId));
            // No statement brought back more than one batch.
            expect(after.most).toBe(batch);

            expect(await rowCounts(learnedAfter)).toEqual(await rowCounts(knewFirst));
            expect(await comparableRows(learnedAfter)).toEqual(await comparableRows(knewFirst));
          },
          { keyFile: knewFirst.keyFile },
        ),
      ));

    it("no re-derive runs when no owner address is held by a person", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        await fromRegistry(writer, personalMail, mailItem(MAIL.canary, personalMail));
        await fromRegistry(writer, personalMail, mailItem(MAIL.fromQuentin, personalMail));
        const before = lines(await snapshot(db));
        const watched = vi.fn(derive);

        expect(await writer.rederiveIfNeeded(watched)).toEqual({ rederived: false, items: 0, coarser: 0 });
        expect(watched).not.toHaveBeenCalled();
        expect(lines(await snapshot(db))).toEqual(before);

        // The positive control: once a person's address is an owner address, the same call re-derives.
        await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
        expect(await writer.rederiveIfNeeded(watched)).toEqual({ rederived: true, items: 2, coarser: 0 });
        expect(watched).toHaveBeenCalledTimes(2);
        const holders = await admin(
          db,
          "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
          [fingerprint(db.keys, "address", QUENTIN.address)],
        );
        expect(holders).toEqual([{ kind: "owner" }]);
        // And then none is needed any more.
        expect(await writer.rederiveIfNeeded(watched)).toEqual({ rederived: false, items: 0, coarser: 0 });
        expect(watched).toHaveBeenCalledTimes(2);
      }));

    it("a re-derive that throws leaves every row as it was", () =>
      withStore(async ({ db, writer }) => {
        await needingRederive(db, writer);
        const before = lines(await snapshot(db));
        let calls = 0;
        const breaking = async (raw: RawItem, ctx: ItemContext): Promise<ItemFacts> => {
          calls += 1;
          if (calls === 2) throw new Error("derive broke on the second item");
          return derive(raw, ctx);
        };

        await expect(writer.rederiveIfNeeded(breaking)).rejects.toThrow();
        expect(calls).toBe(2);
        // (table, key, xmin) of every row, read as pi_admin.
        expect(lines(await snapshot(db))).toEqual(before);

        // A later call with a working derive re-derives.
        const result = await writer.rederiveIfNeeded(derive);
        expect(result.rederived).toBe(true);
        expect(result.items).toBeGreaterThan(0);
        expect(lines(await snapshot(db))).not.toEqual(before);
        expect(await writer.rederiveIfNeeded(derive)).toEqual({ rederived: false, items: 0, coarser: 0 });
      }));

    it("a re-derive never changes an evidence payload, item_enc or content_hash", () =>
      withStore(async ({ db, writer }) => {
        await needingRederive(db, writer);
        const evidence = async () => {
          const rows = await admin<{
            id: string;
            blob_ref: string;
            content_hash: string;
            item_enc: unknown;
            envelope: unknown;
          }>(
            db,
            "select e.id, e.blob_ref, e.content_hash, e.item_enc, b.envelope from vault.evidence_items e join vault.evidence_blobs b on b.blob_ref = e.blob_ref order by e.id",
          );
          return rows.map((row) => ({
            ...row,
            item: opened(db, "own", { table: "vault.evidence_items", id: row.id, column: "item_enc" }, row.item_enc),
            payload: opened(
              db,
              "own",
              { table: "vault.evidence_blobs", id: row.blob_ref, column: "envelope" },
              row.envelope,
            ),
          }));
        };
        const before = await evidence();
        expect(before).toHaveLength(6);
        const members = await admin<{ id: string; sender_member: string | null }>(
          db,
          "select id, sender_member from vault.evidence_items order by id",
        );

        const result = await writer.rederiveIfNeeded(derive);
        expect(result.rederived).toBe(true);
        expect(result.items).toBeGreaterThan(0);

        // Each blob envelope and `item_enc`, as stored and opened, and each `content_hash`.
        expect(await evidence()).toEqual(before);
        expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from vault.evidence_blobs")).n).toBe(6);
        // The re-derive did happen: the person who held the address is gone.
        expect(
          await admin(
            db,
            "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
            [fingerprint(db.keys, "address", QUENTIN.address)],
          ),
        ).toEqual([{ kind: "owner" }]);
        // The fixtures' facts give every item the same members as before, so the member columns
        // read the same too.
        expect(await admin(db, "select id, sender_member from vault.evidence_items order by id")).toEqual(members);
      }));
  });

  // The writer's interfaces that no rule names. No spec names a test for them, so these names are
  // the test author's.
  describe("the writer's interfaces", () => {
    it("ensureSourceAccount finds an account by label and connector, or creates it", () =>
      withStore(async ({ db, writer }) => {
        const mailAccount = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal);
        expect(mailAccount).toEqual({
          id: mailAccount.id,
          label: "personal",
          connector: "google_mail",
          sourceKind: "email",
          compartment: "own",
        });
        expect(SourceAccountId.safeParse(mailAccount.id).success).toBe(true);
        const calendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER.personal);
        expect(calendar).toEqual({
          id: calendar.id,
          label: "personal",
          connector: "google_calendar",
          sourceKind: "calendar",
          compartment: "own",
        });
        expect(calendar.id).not.toBe(mailAccount.id);
        // The address is given as the source wrote it; it is kept normalized.
        const work = await writer.ensureSourceAccount(
          "work",
          "google_mail",
          "employer:example",
          `  ${OWNER.work.toUpperCase()} `,
        );

        // Found again, not made again: also when the address differs only in case.
        expect(await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal)).toEqual(mailAccount);
        expect(
          await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.personal.toUpperCase()),
        ).toEqual(mailAccount);
        expect(await writer.listSourceAccounts()).toEqual([calendar, mailAccount, work]);

        // Each address is an owner address under its account's compartment, once.
        expect((await writer.ownerAddresses()).sort()).toEqual([OWNER.personal, OWNER.work].sort());
        const owners = await admin<{ compartments: string[]; kind: string }>(
          db,
          "select a.compartments, e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id order by a.compartments",
        );
        expect(owners).toEqual([
          { compartments: ["employer:example"], kind: "owner" },
          { compartments: ["own"], kind: "owner" },
        ]);
        expect(await rowCounts(db)).toMatchObject({
          "knowledge.entities": 1,
          "knowledge.domains": 0,
          "vault.source_accounts": 3,
        });

        // An existing account with another compartment or another address is refused; a
        // compartment the keys lack is refused. Each is a plain Error with a code.
        const before = lines(await snapshot(db));
        await expect(
          writer.ensureSourceAccount("personal", "google_mail", "employer:example", OWNER.personal),
        ).rejects.toMatchObject({ code: "account_mismatch" });
        await expect(writer.ensureSourceAccount("personal", "google_mail", "own", OWNER.alias)).rejects.toMatchObject({
          code: "account_mismatch",
        });
        await expect(
          writer.ensureSourceAccount("third", "google_mail", "employer:elsewhere", OWNER.alias),
        ).rejects.toMatchObject({ code: "unknown_compartment" });
        expect(lines(await snapshot(db))).toEqual(before);
        // The positive control: a new label under a compartment the keys hold.
        expect(
          (await writer.ensureSourceAccount("third", "google_mail", "employer:example", OWNER.alias)).compartment,
        ).toBe("employer:example");

        // The contract shape a connector takes: the label is its external reference, never the address.
        const shape = sourceAccountOf(work);
        expect(shape).toEqual({
          id: work.id,
          connector: "google_mail",
          sourceKind: "email",
          vault: "personal",
          externalRef: "work",
          accessSyncKind: "none",
          compartments: ["employer:example"],
          markerCompartments: [],
        });
        expect(SourceAccount.safeParse(shape).success).toBe(true);
      }));

    it("the cursor is sealed, and setting null clears it", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        const stored = async (account: SourceAccountRow) =>
          one(
            await admin<{ cursor_enc: unknown; cursor_updated_at: Date | null }>(
              db,
              "select cursor_enc, cursor_updated_at from vault.source_accounts where id = $1",
              [account.id],
            ),
          );
        expect(await writer.cursor(personalMail)).toBeNull();
        expect(await stored(personalMail)).toEqual({ cursor_enc: null, cursor_updated_at: null });

        await writer.setCursor(personalMail, cursor(CANARIES.cursor));
        expect(await writer.cursor(personalMail)).toBe(CANARIES.cursor);
        // One account's cursor is not another's.
        expect(await writer.cursor(workMail)).toBeNull();
        const row = await stored(personalMail);
        expect(JSON.stringify(row.cursor_enc)).not.toContain(CANARIES.cursor);
        expect(
          opened(
            db,
            "own",
            { table: "vault.source_accounts", id: personalMail.id, column: "cursor_enc" },
            row.cursor_enc,
          ),
        ).toBe(CANARIES.cursor);
        expect(row.cursor_updated_at).not.toBeNull();

        await writer.setCursor(personalMail, null);
        expect(await writer.cursor(personalMail)).toBeNull();
        expect((await stored(personalMail)).cursor_enc).toBeNull();
      }));

    it("recordOutcome sets the outcome, the sync time and this run's skipped count", () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, workMail } = await connect(writer);
        const stored = async (account: SourceAccountRow) => {
          const row = one(
            await admin<{ last_outcome: string | null; last_sync_at: Date | null; skipped_items: number }>(
              db,
              "select last_outcome, last_sync_at, skipped_items from vault.source_accounts where id = $1",
              [account.id],
            ),
          );
          return { ...row, last_sync_at: row.last_sync_at === null ? null : iso(row.last_sync_at) };
        };
        expect(await stored(personalMail)).toEqual({ last_outcome: null, last_sync_at: null, skipped_items: 0 });

        await writer.recordOutcome(personalMail, "rate_limited", "2026-09-20T08:00:00Z", 3);
        expect(await stored(personalMail)).toEqual({
          last_outcome: "rate_limited",
          last_sync_at: iso("2026-09-20T08:00:00Z"),
          skipped_items: 3,
        });
        // The count is this run's: left out, it is 0 again.
        await writer.recordOutcome(personalMail, "ok", "2026-09-20T09:00:00Z");
        expect(await stored(personalMail)).toEqual({
          last_outcome: "ok",
          last_sync_at: iso("2026-09-20T09:00:00Z"),
          skipped_items: 0,
        });
        expect(await stored(workMail)).toEqual({ last_outcome: null, last_sync_at: null, skipped_items: 0 });
      }));

    it("withSyncLock runs one holder at a time", () =>
      withStore(({ db, writer }) =>
        withWriter(db, async (other) => {
          // While one writer holds the lock, another gets `already_running` and does not run.
          let ran = 0;
          const outer = await writer.withSyncLock(async () => {
            const inner = await other.withSyncLock(async () => {
              ran += 1;
              return "ran";
            });
            return { inner };
          });
          expect(outer).toEqual({ inner: "already_running" });
          expect(ran).toBe(0);

          // The positive control: once it is released, the same call runs.
          expect(await other.withSyncLock(async () => "ran")).toBe("ran");
          // A function that throws releases it too.
          await expect(
            writer.withSyncLock(async () => {
              throw new Error("sync failed");
            }),
          ).rejects.toThrow("sync failed");
          expect(await other.withSyncLock(async () => "ran again")).toBe("ran again");
        }),
      ));

    it("the writer reads a secret and lists secret names by prefix", () =>
      withStore(async ({ db, writer }) => {
        await insertSecret(db, "google/personal/refresh_token", CANARIES.secret);
        await insertSecret(db, "google/personal/client", "client-json-0001");
        await insertSecret(db, "google/work/refresh_token", "refresh-work-0001");

        expect(await writer.secret("google/personal/refresh_token")).toBe(CANARIES.secret);
        expect(await writer.secret("google/work/refresh_token")).toBe("refresh-work-0001");
        expect(await writer.secret("google/school/refresh_token")).toBeNull();
        expect((await writer.listSecretNames("google/personal/")).sort()).toEqual([
          "google/personal/client",
          "google/personal/refresh_token",
        ]);
        expect((await writer.listSecretNames("google/")).sort()).toEqual([
          "google/personal/client",
          "google/personal/refresh_token",
          "google/work/refresh_token",
        ]);
        expect(await writer.listSecretNames("microsoft/")).toEqual([]);
        // A prefix is text, not a pattern.
        expect(await writer.listSecretNames("%")).toEqual([]);
        expect(await writer.listSecretNames("google/_ersonal/")).toEqual([]);
      }));
  });
});

// The hex SHA-256 of a payload's bytes, from its base64 form.
function sha256OfBase64(payload: string): string {
  return createHash("sha256").update(Buffer.from(payload, "base64")).digest("hex");
}
