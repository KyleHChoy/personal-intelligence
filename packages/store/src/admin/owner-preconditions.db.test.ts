import type { RawItem } from "@intelligence/contracts";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  calendarItem,
  deriveItem,
  type GmailMessage,
  gmailItem,
  isConditional,
  isDraft,
  isJunk,
  ownerSent,
} from "@intelligence/personal-core/items";
import { type World, world } from "@intelligence/personal-core/testing";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openUnder, sealUnder } from "../core/seal.ts";
import { insertClient } from "../test-support/clients.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { type Store, withDatabase, withStore } from "../test-support/store.ts";
import type { Writer } from "../write/writer.ts";

// What the owner surface's foundation assumes of the stages it builds on. Each test fails with a
// plain name when one of them does not hold.

const TIMEOUT = 180_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");

// A message the owner's personal account sent with Auto-Submitted: auto-replied: an automatic
// reply, which stage 1 marks bulk.
const AUTO_REPLY_ID = "a0000000000000auto";
function autoReply(w: World): GmailMessage {
  const personal = w.accounts.find((account) => account.label === "personal");
  if (personal === undefined) throw new Error("the world has a personal account");
  const at = NOW.getTime() - 2 * 86_400_000;
  return {
    id: AUTO_REPLY_ID,
    threadId: AUTO_REPLY_ID,
    internalDate: at,
    labelIds: ["SENT"],
    headers: [
      { name: "From", value: `Owner <${personal.address}>` },
      { name: "To", value: "Someone Else <someone.else@example.com>" },
      { name: "Subject", value: "Out of office" },
      { name: "Date", value: new Date(at - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Message-ID", value: "<auto-reply-0001@quinn.test>" },
      { name: "Auto-Submitted", value: "auto-replied" },
    ],
    text: "I am away until Monday.\r\n",
  };
}

// The world, and the automatic reply, stored as `pi sync` stores them: what the owner sent
// first, drafts and junk left out, a conditional message only when the owner wrote to its
// sender or posted in its thread, and an item the writer refuses for good skipped.
async function ingestWorld(writer: Writer, w: World): Promise<void> {
  for (const account of w.accounts) {
    const mail = await writer.ensureSourceAccount(account.label, "google_mail", account.compartment, account.address);
    const calendar = await writer.ensureSourceAccount(
      account.label,
      "google_calendar",
      account.compartment,
      account.address,
    );
    const raws = account.messages.map((message) =>
      gmailItem(message, { sourceAccount: mail.id, changeKind: "backfill" }),
    );
    for (const raw of [...raws.filter(ownerSent), ...raws.filter((one) => !ownerSent(one))]) {
      if (isDraft(raw) || isJunk(raw)) continue;
      if (isConditional(raw)) {
        const wrote = await writer.ownerWrote(mail, {
          ...(raw.sender === undefined ? {} : { sender: raw.sender }),
          ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
        });
        if (!wrote.sender && !wrote.thread) continue;
      }
      await ingest(writer, mail, raw);
    }
    for (const event of account.events) {
      const item = calendarItem(event, { sourceAccount: calendar.id, changeKind: "backfill", now: w.now });
      if ("payload" in item) await ingest(writer, calendar, item);
    }
  }
}

async function ingest(writer: Writer, account: Parameters<Writer["ingestItem"]>[0], raw: RawItem): Promise<void> {
  try {
    await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
  } catch (error) {
    // The item `pi sync` skips as refused for good.
    if (typeof (error as { code?: unknown }).code !== "string") throw error;
  }
}

async function withWorld<T>(fn: (store: Store, w: World) => Promise<T>): Promise<T> {
  return withStore(async (store) => {
    const w = world({ now: NOW });
    const personal = w.accounts.find((account) => account.label === "personal");
    personal?.messages.push(autoReply(w));
    await ingestWorld(store.writer, w);
    return fn(store, w);
  });
}

const evidenceOf = (store: Store, sourceItemId: string) =>
  queryAs<{ id: string; sender_member: string | null; system_originated: boolean; answers_system: boolean }>(
    store.db.urls.admin,
    "select id, sender_member, system_originated, answers_system from vault.evidence_items where source_item_fp = $1 order by revision desc limit 1",
    [fingerprint(store.db.keys, "source_id", sourceItemId)],
  );

const NINE = [
  "knowledge.messages",
  "knowledge.events",
  "knowledge.event_details",
  "knowledge.event_participants",
  "knowledge.interaction_log",
  "knowledge.accounts",
  "knowledge.domains",
  "knowledge.entities",
  "vault.evidence_items",
];

describe("what the owner foundation builds on", { timeout: TIMEOUT }, () => {
  it("the ledger schema exists, with usage for the admin, the writer and the reader", () =>
    withDatabase(async (db) => {
      const rows = await queryAs<{ role: string; usage: boolean }>(
        db.urls.admin,
        `select r as role, has_schema_privilege(r, 'ledger', 'USAGE') as usage from unnest(array['pi_admin', 'pi_writer', 'pi_reader']) as r`,
      );
      expect(rows).toEqual([
        { role: "pi_admin", usage: true },
        { role: "pi_writer", usage: true },
        { role: "pi_reader", usage: true },
      ]);
    }));

  it("sealUnder and openUnder are exported, and a list of two compartments seals the same whichever order it is given in", () =>
    withDatabase(
      async (db) => {
        const at = { table: "ledger.cards", id: "crd_01J00000000000000000000000", column: "body_enc" };
        const sealed = sealUnder(db.keys, ["own", "employer:example"], at, "a card's text");
        expect(openUnder(db.keys, ["employer:example", "own"], at, sealed)).toBe("a card's text");
      },
      { compartments: ["own", "employer:example"] },
    ));

  it("every stored message of the world has a messages row with a direction, a bulk mark, a held mark, a thread fingerprint, a sender fingerprint and a sender domain fingerprint, a bulk one included", () =>
    withWorld(async ({ db }) => {
      const rows = await queryAs<{ evidence: number; messages: number; bulk: number; incomplete: number }>(
        db.urls.admin,
        `select (select count(*)::int from vault.evidence_items where source_kind = 'email') as evidence,
           (select count(*)::int from knowledge.messages) as messages,
           (select count(*)::int from knowledge.messages where bulk) as bulk,
           (select count(*)::int from knowledge.messages
            where direction is null or bulk is null or held is null or thread_fp is null or sender_fp is null or sender_domain_fp is null) as incomplete`,
      );
      const counts = one(rows);
      expect(counts.messages).toBeGreaterThan(0);
      expect(counts.messages).toBe(counts.evidence);
      expect(counts.bulk).toBeGreaterThan(0);
      expect(counts.incomplete).toBe(0);
    }));

  it("a held message is returned to pi_reader by no statement, and to pi_admin by the same statement", () =>
    withWorld(async (store) => {
      const client = await insertClient(store.db, "precondition-reader", ["own", "employer:example"]);
      const statement = "select count(*)::int as n from knowledge.messages where held";
      expect(one(await queryAs<{ n: number }>(store.db.urls.admin, statement)).n).toBeGreaterThan(0);
      expect(one(await readAs(store.db, client.token, (query) => query<{ n: number }>(statement))).n).toBe(0);
      // The reader sees the rest of the mail under the same token.
      expect(
        one(
          await readAs(store.db, client.token, (query) =>
            query<{ n: number }>("select count(*)::int as n from knowledge.messages"),
          ),
        ).n,
      ).toBeGreaterThan(0);
    }));

  it("every evidence row has system_originated and answers_system, both false in the world", () =>
    withWorld(async ({ db }) => {
      const rows = await queryAs<{ total: number; marked: number }>(
        db.urls.admin,
        "select count(*)::int as total, count(*) filter (where system_originated or answers_system)::int as marked from vault.evidence_items",
      );
      expect(one(rows).total).toBeGreaterThan(0);
      expect(one(rows).marked).toBe(0);
    }));

  it("a stored message the owner's account sent with Auto-Submitted: auto-replied has bulk true", () =>
    withWorld(async (store) => {
      const evidence = one(await evidenceOf(store, `gmail-id:${AUTO_REPLY_ID}`));
      const message = one(
        await queryAs<{ direction: string; bulk: boolean }>(
          store.db.urls.admin,
          "select direction, bulk from knowledge.messages where evidence_id = $1",
          [evidence.id],
        ),
      );
      expect(message).toEqual({ direction: "outbound", bulk: true });
    }));

  it("the evidence row of an event the owner organized has the owner as its sender member, and one the owner was only invited to has none", () =>
    withWorld(async (store) => {
      expect(one(await evidenceOf(store, "evt-work-canary")).sender_member).toBe("m-owner");
      expect(one(await evidenceOf(store, "evt-work-review")).sender_member).toBeNull();
    }));

  // Later migrations add one policy here: pi_owner_update on knowledge.messages and vault.evidence_items, for
  // vault.mark_recovery and policy.request_restriction; and pi_owner_insert on vault.evidence_items, for
  // policy.write_typed_claims alone, which writes a typed finding's evidence row at its write because the
  // claims it inserts must name one and pi_reader holds no right in `vault`. Nothing else.
  it("pi_owner has no policy on knowledge.messages, events, event_details, event_participants, interaction_log, accounts, domains, entities or vault.evidence_items but the one pi_owner_select 0006 makes, the pi_owner_update later migrations add on messages and evidence items, and the typed writes' pi_owner_insert on evidence items", () =>
    withDatabase(async (db) => {
      const rows = await queryAs<{ table: string; name: string }>(
        db.urls.admin,
        `select schemaname || '.' || tablename as "table", policyname as name from pg_policies
         where 'pi_owner' = any (roles) and schemaname || '.' || tablename = any ($1) order by 1, 2`,
        [NINE],
      );
      const updated = ["knowledge.messages", "vault.evidence_items"];
      const inserted = ["knowledge.entities", "vault.evidence_items"];
      for (const row of rows) {
        const expected =
          row.name === "pi_owner_update" && updated.includes(row.table)
            ? "pi_owner_update"
            : row.name === "pi_owner_insert" && inserted.includes(row.table)
              ? "pi_owner_insert"
              : "pi_owner_select";
        expect(row.name, row.table).toBe(expected);
      }
      expect(rows.filter((row) => row.name === "pi_owner_update").map((row) => row.table)).toEqual(updated);
      expect(rows.filter((row) => row.name === "pi_owner_insert").map((row) => row.table)).toEqual(inserted);
    }));

  it("knowledge.messages.sender_fp and knowledge.accounts.value_fp of one address are equal, and sender_domain_fp equals the domain row's domain_fp", () =>
    withWorld(async (store, w) => {
      const address = fingerprint(store.db.keys, "address", w.handles.topContactAddress);
      const counts = one(
        await queryAs<{ messages: number; accounts: number; domains: number }>(
          store.db.urls.admin,
          `select (select count(*)::int from knowledge.messages where sender_fp = $1) as messages,
             (select count(*)::int from knowledge.accounts where value_fp = $1) as accounts,
             (select count(*)::int from knowledge.messages m join knowledge.domains d on d.domain_fp = m.sender_domain_fp) as domains`,
          [address],
        ),
      );
      expect(counts.messages).toBeGreaterThan(0);
      expect(counts.accounts).toBeGreaterThan(0);
      expect(counts.domains).toBeGreaterThan(0);
    }));
});
