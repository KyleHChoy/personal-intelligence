import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceId } from "@intelligence/contracts";
import {
  type AgentRecordArgs,
  BELIEF_TYPES,
  type CardId,
  type EntityId,
  type ErasureId,
  type ErasureJournalEntry,
  type MessageId,
  type NewCard,
  type PersonalTool,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { appendJournal, readJournal } from "../../core/journal.ts";
import type { ErasureHook } from "../../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../../erasure/erasure-hooks.ts";
import { createPipeline, type Pipeline } from "../../pipeline/pipeline.ts";
import { Reader } from "../../read/read.ts";
import { type Accounts, CANARY_PERSON, connect, OWNER, QUENTIN, SOLO } from "../../test-support/cast.ts";
import { ALL_VIEWS, insertClient, testId } from "../../test-support/clients.ts";
import { addOwnerAddressUnderived, one, readAs } from "../../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { asOwner, batchOf, beliefsComputed, claimRecord } from "../../test-support/pipeline-fixtures.ts";
import { lines, snapshot } from "../../test-support/snapshot.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { outcomeValue, registration } from "../../test-support/values.ts";
import { holdingLock as holding, outcome, pending, withErasureHook as withHook } from "../../test-support/waits.ts";
import { Admin, createAdmin } from "../admin.ts";

// The owner's erasure of an item or a person, the lift, the replay and the level. Each Admin has
// the journal of its own test folder. The tests on two connections follow
// pipeline-locks.db.test.ts: one connection holds a lock and stays open; each side's call is
// started, shown not to have settled, and awaited once the hold is released, and neither may end in
// a deadlock (40P01).

const BELIEFS = "select pg_advisory_xact_lock(hashtext('intelligence personal beliefs'))";
const SYNC = "select pg_advisory_lock(hashtext('intelligence personal sync'))";
const OWNER_PERSONAL = { address: OWNER.personal, name: OWNER.name };
const RECORDER = "alpha";
const TOOLS = ["get_self", "find_messages", "read_message", "build_context_pack", "record"] as PersonalTool[];

type World = { store: TestStore; db: TestDatabase; accounts: Accounts; admin: Admin; journal: string; owner: string };

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-erase-"));
  const store = await openStore({ compartments: ["own", "employer:example", `agent:${RECORDER}`] });
  try {
    const journal = join(dir, "keys.json.erasures");
    const accounts = await connect(store.writer);
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal,
      recordEnabled: true,
    });
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    await fn({ store, db: store.db, accounts, admin, journal, owner });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// An Admin on a pool of its own: one side of a test on two connections.
const sideOf = (world: World): Admin =>
  createAdmin({ url: world.db.urls.admin, keys: world.db.keys, log: world.store.log, journal: world.journal });

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;
const req = (): string => testId("req");

const itemFp = (db: TestDatabase, fixture: MailFixture): string =>
  fingerprint(db.keys, "source_id", mailSourceId(fixture));
async function messageOf(
  world: World,
  fixture: MailFixture,
  account = world.accounts.personalMail,
): Promise<{ id: MessageId; evidence: string }> {
  const row = one(
    await admin<{ id: string; evidence_id: string }>(
      world.db,
      "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [account.id, itemFp(world.db, fixture)],
    ),
  );
  return { id: row.id as MessageId, evidence: row.evidence_id };
}
const storedRevisions = (world: World, fixture: MailFixture, account = world.accounts.personalMail): Promise<number> =>
  count(world.db, "vault.evidence_items", "source_account_id = $1 and source_item_fp = $2", [
    account.id,
    itemFp(world.db, fixture),
  ]);
const personOf = async (world: World, address: string): Promise<EntityId> =>
  one(
    await admin<{ entity_id: string }>(
      world.db,
      "select distinct entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(world.db.keys, "address", address)],
    ),
  ).entity_id as EntityId;

// A card about a message, with a body, raised by the owner's admin.
const cardAbout = (message: MessageId, compartments = ["own"]): NewCard =>
  ({
    id: testId("crd") as CardId,
    requestId: req(),
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target: null,
    refs: [{ kind: "message", id: message }],
    compartments,
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a card about a message",
    bodyFrom: "code",
  }) as NewCard;

// A hook added for one test, taken out after it.
// What the standing hooks (ERASURE_HOOKS, as shipped) report when nothing of theirs is touched:
// each name with 0. A report's more is this and the test's own keys.
const standing = (): Record<string, number> => Object.fromEntries(ERASURE_HOOKS.map((hook) => [hook.name, 0]));

// A hook that holds the erasure's transaction open, after the removals, until it is let go.
function holdingHook(): { hook: ErasureHook; entered: Promise<void>; resume: () => void } {
  let enter: () => void = () => {};
  let resume: () => void = () => {};
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (resume = resolve));
  return {
    hook: {
      name: "test_hold",
      run: async () => {
        enter();
        await gate;
        return 0;
      },
    },
    entered,
    resume,
  };
}

// A pipeline as pi_pipeline, closed after `fn`.
async function withPipeline<T>(world: World, fn: (pipeline: Pipeline) => Promise<T>): Promise<T> {
  const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: world.store.log });
  try {
    return await fn(pipeline);
  } finally {
    await pipeline.close();
  }
}

// The canary person's five items: a message from them in each label, the owner's reply, bulk
// mail from them, and the owner's bulk mail to them. Quentin's own message stays throughout.
const FROM_CANARY_AT_WORK: MailFixture = {
  id: "gm-erase-work-0101",
  threadId: "thread-erase-work-0101",
  at: "2026-09-05T09:00:00Z",
  from: CANARY_PERSON,
  to: [{ address: OWNER.work }],
  subject: "A work note",
  labels: ["INBOX"],
};
const BULK_FROM_CANARY: MailFixture = {
  id: "gm-erase-bulk-0102",
  threadId: "thread-erase-bulk-0102",
  at: "2026-09-06T09:00:00Z",
  from: CANARY_PERSON,
  to: [OWNER_PERSONAL],
  subject: "A circular",
  labels: ["INBOX"],
  reads: "bulk",
};
const BULK_TO_CANARY: MailFixture = {
  id: "gm-erase-bulk-0103",
  threadId: "thread-erase-bulk-0103",
  at: "2026-09-07T09:00:00Z",
  from: OWNER_PERSONAL,
  to: [CANARY_PERSON],
  subject: "An automatic answer",
  labels: ["SENT"],
  reads: "bulk",
};
async function canaryWorld(world: World): Promise<EntityId> {
  const { writer } = world.store;
  for (const fixture of [MAIL.canary, MAIL.reply, BULK_FROM_CANARY, BULK_TO_CANARY, MAIL.fromQuentin])
    expect(await ingestMail(writer, world.accounts.personalMail, fixture)).toBe("stored");
  expect(await ingestMail(writer, world.accounts.workMail, FROM_CANARY_AT_WORK)).toBe("stored");
  return personOf(world, CANARY_PERSON.address);
}

describe("erasing an item", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an erased message leaves no row that cites it and no person seen only in it", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const solo = await messageOf(world, MAIL.solo);
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(report).toMatchObject({ items: 1, people: 0, suppressed: 0, taintedRows: 0, exposedClients: 0, more: {} });
      expect(report.erasure).toMatch(/^ers_/);

      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
      expect(await count(world.db, "knowledge.messages", "evidence_id = $1", [solo.evidence])).toBe(0);
      expect(await count(world.db, "vault.evidence_blobs")).toBe(1);
      expect(
        await count(world.db, "knowledge.accounts", "value_fp = $1", [
          fingerprint(world.db.keys, "address", SOLO.address),
        ]),
      ).toBe(0);
      expect(
        // erasure-proves: knowledge.domains.entity_id
        await count(world.db, "knowledge.domains", "domain_fp = $1", [
          fingerprint(world.db.keys, "domain", "one-message.test"),
        ]),
      ).toBe(0);
      // The positive control: Quentin, on Solo's message and on Quentin's own, stays.
      expect(
        await count(world.db, "knowledge.accounts", "value_fp = $1", [
          fingerprint(world.db.keys, "address", QUENTIN.address),
        ]),
      ).toBe(1);
      expect(await storedRevisions(world, MAIL.fromQuentin)).toBe(1);

      const removed = one(
        await admin<{ evidence_ids: string[]; source_item_fp: string; reason: string }>(
          world.db,
          "select evidence_ids, source_item_fp, reason from knowledge.removed_evidence",
        ),
      );
      expect(removed).toEqual({
        evidence_ids: [solo.evidence],
        source_item_fp: itemFp(world.db, MAIL.solo),
        reason: "owner_erasure",
      });
      expect(await admin(world.db, "select kind, journal_seq::int as seq, items from knowledge.erasures")).toEqual([
        { kind: "item", seq: 1, items: 1 },
      ]);
      expect(await count(world.db, "knowledge.owner_decisions", "kind = 'erase'")).toBe(1);
      expect(await readJournal(world.journal)).toEqual({
        entries: [
          {
            seq: 1,
            erasure: report.erasure,
            kind: "item",
            items: [{ account: world.accounts.personalMail.id, fp: itemFp(world.db, MAIL.solo) }],
            suppress: [],
          },
        ],
        seq: 1,
      });
      expect(await world.admin.erasure.level()).toBe("level");
      expect(
        (await world.admin.erasure.listErasures()).map((view) => ({
          id: view.id,
          kind: view.kind,
          items: view.items,
          liftedAt: view.liftedAt,
        })),
      ).toEqual([{ id: report.erasure, kind: "item", items: 1, liftedAt: null }]);
    }));

  it("a card that cited an erased message is withdrawn, tainted and has no body, and the basis holds no evidence id of it", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const { id: card } = await world.admin.cards.raiseCard(cardAbout(solo.id));
      expect(await count(world.db, "ledger.basis", "evidence_id = $1", [solo.evidence])).toBe(1);
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(report.taintedRows).toBe(1);
      const row = one(
        await admin<{ tainted: boolean; body: boolean }>(
          world.db,
          "select tainted_at is not null as tainted, body_enc is not null as body from ledger.cards where id = $1",
          [card],
        ),
      );
      expect(row).toEqual({ tainted: true, body: false });
      const state = one(
        await admin<{ event: string }>(
          world.db,
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [card],
        ),
      );
      expect(state.event).toBe("withdrawn");
      expect(await count(world.db, "ledger.basis", "evidence_id = $1", [solo.evidence])).toBe(0);
      expect(await count(world.db, "ledger.basis", "row_id = $1 and tainted_at is not null", [card])).toBe(1);
    }));

  it("an erasure leaves the erased item's evidence ids in the read log and in no ledger basis row", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const { token } = await world.admin.clients.addClient(
        registration("erasure-reader", ["own"], {
          tools: TOOLS.filter((tool) => tool !== "record"),
          views: ALL_VIEWS as never,
        }),
      );
      const reader = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
      expect((await reader.readMessage(token, { id: solo.id })).ok).toBe(true);
      await world.admin.cards.raiseCard(cardAbout(solo.id));
      expect(await count(world.db, "ledger.read_log", "$1 = any (bound)", [solo.evidence])).toBe(1);
      await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(await count(world.db, "ledger.read_log", "$1 = any (bound)", [solo.evidence])).toBe(1);
      expect(await count(world.db, "ledger.basis", "evidence_id = $1", [solo.evidence])).toBe(0);
    }));

  it("an erasure removes the agent record that rested on the item", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const { token } = await world.admin.clients.addClient(
        registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
      );
      const reader = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
      const args = {
        kind: "note",
        body: "an agent record that cites a message",
        requestId: "erase-record-0001",
        cites: [solo.id],
      } as AgentRecordArgs;
      const record = outcomeValue(await reader.record(token, args)).recordId;
      // Taken into the vault, so its own evidence row goes too.
      expect((await world.store.writer.takeRecords()).taken).toBe(1);
      const evidence = one(
        await admin<{ evidence_id: string }>(world.db, "select evidence_id from ledger.agent_writes where id = $1", [
          record,
        ]),
      ).evidence_id;
      await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(
        await admin(
          world.db,
          "select body_enc is null as emptied, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
          [record],
        ),
      ).toEqual([{ emptied: true, tainted: true }]);
      expect(await count(world.db, "vault.evidence_items", "id = $1", [evidence])).toBe(0);
    }));

  it("a dry run counts the rows resting on a removed agent record's evidence row, as the erasure taints them", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const solo = await messageOf(world, MAIL.solo);
      const { token } = await world.admin.clients.addClient(
        registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
      );
      const reader = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
      const args = {
        kind: "note",
        body: "an agent record that cites a message",
        requestId: "erase-record-0009",
        cites: [solo.id],
      } as AgentRecordArgs;
      const record = outcomeValue(await reader.record(token, args)).recordId;
      expect((await world.store.writer.takeRecords()).taken).toBe(1);
      const evidence = one(
        await admin<{ evidence_id: string }>(world.db, "select evidence_id from ledger.agent_writes where id = $1", [
          record,
        ]),
      ).evidence_id;
      // A card about another message, whose basis row is made to cite the agent record's
      // evidence row, as no function built yet writes one: only that row ties it to the erasure.
      const { id: card } = await world.admin.cards.raiseCard(cardAbout((await messageOf(world, MAIL.fromQuentin)).id));
      await asOwner(world.db, `update ledger.basis set evidence_id = '${evidence}' where row_id = '${card}'`);
      const dry = await world.admin.erasure.eraseItem(
        { kind: "message", id: solo.id },
        { requestId: req(), dryRun: true },
      );
      const real = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(real.taintedRows).toBeGreaterThanOrEqual(1);
      expect(dry.taintedRows).toBe(real.taintedRows);
      expect(
        await count(world.db, "ledger.cards", "id = $1 and tainted_at is not null and body_enc is null", [card]),
      ).toBe(1);
    }));

  it("an agent record written by a session that had read the erased message with read_message, and that does not cite it, is removed with the erasure, and one written by a session that was only shown it in a pack is not", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const { token } = await world.admin.clients.addClient(
        registration(RECORDER, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
      );
      // Each Reader is a process, and so a session of its own.
      const viaRead = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
      expect((await viaRead.readMessage(token, { id: solo.id })).ok).toBe(true);
      const read = outcomeValue(
        await viaRead.record(token, {
          kind: "note",
          body: "after reading it",
          requestId: "erase-record-0002",
        } as AgentRecordArgs),
      ).recordId;
      const viaPack = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
      expect((await viaPack.getSelf(token)).ok).toBe(true);
      // The pack's read log row, through the function the reader calls: shown, never bound.
      const sessionId = one(
        await admin<{ id: string }>(
          world.db,
          "select id from ledger.sessions order by started_at desc, id desc limit 1",
        ),
      ).id;
      await readAs(world.db, token, (query) =>
        query("select policy.log_read($1, $2, $3, $4, $5)", [sessionId, "build_context_pack", [], [solo.evidence], []]),
      );
      const shown = outcomeValue(
        await viaPack.record(token, {
          kind: "note",
          body: "after a pack showed it",
          requestId: "erase-record-0003",
        } as AgentRecordArgs),
      ).recordId;

      await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(
        one(
          await admin<{ emptied: boolean }>(
            world.db,
            "select body_enc is null as emptied from ledger.agent_writes where id = $1",
            [read],
          ),
        ).emptied,
      ).toBe(true);
      expect(
        one(
          await admin<{ emptied: boolean }>(
            world.db,
            "select body_enc is null as emptied from ledger.agent_writes where id = $1",
            [shown],
          ),
        ).emptied,
      ).toBe(false);
    }));

  it("a repeated request id erases once", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const requestId = req();
      const first = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId });
      const second = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId });
      expect(second.erasure).toBe(first.erasure);
      expect(await count(world.db, "knowledge.erasures")).toBe(1);
      expect((await readJournal(world.journal)).seq).toBe(1);
      // The positive control: another request id for a message that is gone is not_found.
      await expect(
        world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
      ).rejects.toMatchObject({ code: "not_found" });
    }));

  it("a hook added to the list runs inside the erasure's transaction, after the removal, and its count is in the report under its name; with none added the report's more holds only the standing hooks' counts", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const solo = await messageOf(world, MAIL.solo);
      const seen: { stored: number; erased: unknown }[] = [];
      const report = await withHook(
        {
          name: "test_count",
          run: async (query, erased, options) => {
            const [row] = await query<{ n: number }>(
              "select count(*)::int as n from vault.evidence_items where id = any($1)",
              [erased.evidenceIds],
            );
            seen.push({ stored: row?.n ?? -1, erased: { ...erased, dryRun: options.dryRun } });
            return 7;
          },
        },
        () => world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
      );
      expect(report.more).toEqual({ ...standing(), test_count: 7 });
      expect(seen).toEqual([
        {
          stored: 0,
          erased: {
            evidenceIds: [solo.evidence],
            refs: [{ kind: "message", id: solo.id }],
            addressFps: [],
            sources: [{ accountId: world.accounts.personalMail.id, sourceItemFp: itemFp(world.db, MAIL.solo) }],
            // FE1: the erasure's id, and what its exposure links read.
            records: [],
            recordEvidenceIds: [],
            erasureId: report.erasure,
            factKeyFps: [],
            // The keys the gone-keys rule found emptied, read once for every hook; none here.
            goneKeyFps: [],
            // The claim keys of the erased claims, for their relations; none here.
            claimKeys: [],
            // The erased claims' ids; none here.
            claimIds: [],
            // The names a person's erasure suppresses in pages; none for an item.
            nameFps: [],
            // The same-person questions and answers the erasure removed; none here.
            identityQuestions: 0,
            // The belief rulings anchored on what is erased, read before the removal; none here.
            anchoredRulings: [],
            dryRun: false,
          },
        },
      ]);
      const quentin = await messageOf(world, MAIL.fromQuentin);
      expect(
        (await world.admin.erasure.eraseItem({ kind: "message", id: quentin.id }, { requestId: req() })).more,
      ).toEqual(standing());
    }));
});

describe("erasing a person", { timeout: DB_TEST_TIMEOUT }, () => {
  it("erasing a person erases every item that names them, under both compartments, bulk mail from them and the owner's bulk mail to them included", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      expect(report).toMatchObject({ items: 5, people: 1, suppressed: 1, more: { claims_naming: 0 } });
      for (const fixture of [MAIL.canary, MAIL.reply, BULK_FROM_CANARY, BULK_TO_CANARY])
        expect(await storedRevisions(world, fixture), fixture.id).toBe(0);
      expect(await storedRevisions(world, FROM_CANARY_AT_WORK, world.accounts.workMail)).toBe(0);
      expect(await count(world.db, "knowledge.entities", "id = $1", [person])).toBe(0);
      const fp = fingerprint(world.db.keys, "address", CANARY_PERSON.address);
      expect(await count(world.db, "knowledge.accounts", "value_fp = $1", [fp])).toBe(0);
      expect(await count(world.db, "vault.sent_recipients", "address_fp = $1", [fp])).toBe(0); // erasure-proves: vault.sent_recipients.evidence_id
      // The person's name is suppressed beside the address, keyed apart from it,
      // and journalled with it; the report's count is the addresses'.
      const name = fingerprint(world.db.keys, "name", CANARY_PERSON.name ?? "");
      expect(await admin(world.db, "select kind, value_fp from knowledge.suppressions order by value_fp")).toEqual(
        [fp, name].sort().map((value_fp) => ({ kind: "address", value_fp })),
      );
      expect(await count(world.db, "knowledge.removed_evidence")).toBe(5);
      // The positive control: Quentin's own message stays.
      expect(await storedRevisions(world, MAIL.fromQuentin)).toBe(1);
      expect((await readJournal(world.journal)).entries[0]).toMatchObject({
        seq: 1,
        kind: "person",
        suppress: [fp, name].sort(),
      });
    }));

  it("a dry run writes nothing and gives the same counts", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const before = lines(await snapshot(world.db));
      const dry = await world.admin.erasure.erasePerson(person, { requestId: req(), dryRun: true });
      expect(dry.erasure).toBeNull();
      expect(lines(await snapshot(world.db))).toEqual(before);
      expect(await readJournal(world.journal)).toEqual({ entries: [], seq: 0 });
      const real = await world.admin.erasure.erasePerson(person, { requestId: req() });
      expect({ ...dry, erasure: real.erasure }).toEqual(real);
    }));

  it("erasing the owner or an organization is not_a_person", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const organization = one(
        await admin<{ entity_id: string }>(world.db, "select entity_id from knowledge.domains where domain_fp = $1", [
          fingerprint(world.db.keys, "domain", "lighthouse.test"),
        ]),
      ).entity_id;
      await expect(
        world.admin.erasure.erasePerson(world.owner as EntityId, { requestId: req() }),
      ).rejects.toMatchObject({
        code: "not_a_person",
      });
      await expect(
        world.admin.erasure.erasePerson(organization as EntityId, { requestId: req() }),
      ).rejects.toMatchObject({
        code: "not_a_person",
      });
      await expect(
        world.admin.erasure.erasePerson(testId("ent") as EntityId, { requestId: req() }),
      ).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await readJournal(world.journal)).toEqual({ entries: [], seq: 0 });
      // The positive control: Quentin is a person.
      expect(
        (
          await world.admin.erasure.erasePerson(await personOf(world, QUENTIN.address), {
            requestId: req(),
            dryRun: true,
          })
        ).people,
      ).toBe(1);
    }));

  it("erasing a person named by a claim taken from another person's message removes that claim, its entity link and its beliefs, and the entity row; the other person's message stays", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const quentin = await messageOf(world, MAIL.fromQuentin);
      const record = claimRecord(quentin.evidence, "own", world.owner, { entities: [person] });
      await withPipeline(world, async (pipeline) => {
        expect(await pipeline.open(quentin.evidence as EvidenceId)).not.toBeNull();
        expect(await pipeline.commit(batchOf(quentin.evidence, [record]))).toBe("committed");
      });
      // The beliefs `own` is given that rest on the claim: computed when asked.
      const resting = async (): Promise<string[]> =>
        (await beliefsComputed(world.db, ["own"], BELIEF_TYPES, new Date().toISOString()))
          .filter((one) => one.belief.support.includes(record.claim.id))
          .map((one) => one.factKeyFp);
      expect(await resting()).toHaveLength(1);
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      // The commit's recheck of the key the erasure empties goes too, and the recheck the claim's
      // removal wrote, naming it and its item.
      expect(report.more).toEqual({ ...standing(), claims_naming: 1, triggers: 2 });
      expect(await count(world.db, "knowledge.claims", "evidence_id = $1", [quentin.evidence])).toBe(0);
      expect(await count(world.db, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(0);
      expect(await resting()).toEqual([]);
      expect(await count(world.db, "knowledge.entities", "id = $1", [person])).toBe(0);
      expect(await storedRevisions(world, MAIL.fromQuentin)).toBe(1);
    }));

  it("a dry run counts claims_naming and removes none", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const quentin = await messageOf(world, MAIL.fromQuentin);
      await withPipeline(world, async (pipeline) => {
        expect(await pipeline.open(quentin.evidence as EvidenceId)).not.toBeNull();
        expect(
          await pipeline.commit(
            batchOf(quentin.evidence, [claimRecord(quentin.evidence, "own", world.owner, { entities: [person] })]),
          ),
        ).toBe("committed");
      });
      const dry = await world.admin.erasure.erasePerson(person, { requestId: req(), dryRun: true });
      // The commit's recheck that names the claim the erasure would remove.
      expect(dry.more).toEqual({ ...standing(), claims_naming: 1, triggers: 1 });
      expect(await count(world.db, "knowledge.claims")).toBe(1);
      expect(await count(world.db, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(1);
    }));

  it("an erasure lists the client that could have read it, and raises one notice", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const called = async (name: string, compartments: string[], call: boolean): Promise<string> => {
        const client = await insertClient(world.db, name, compartments);
        if (call) await readAs(world.db, client.token, (query) => query("select policy.log_call('search', 0, 'ok')"));
        return client.id;
      };
      const exposed = await called("erasure-own-called", ["own"], true);
      await called("erasure-work-called", ["employer:example"], true);
      await called("erasure-own-idle", ["own"], false);
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(report.exposedClients).toBe(1);
      expect(
        one(await admin<{ ids: string[] }>(world.db, "select exposed_client_ids as ids from knowledge.erasures")).ids,
      ).toEqual([exposed]);
      const cards = await admin<{ kind: string; created_by: string; body: boolean; event: string }>(
        world.db,
        `select c.kind, c.created_by, c.body_enc is not null as body,
           (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as event
         from ledger.cards c`,
      );
      expect(cards).toEqual([{ kind: "notice", created_by: "system:erase", body: false, event: "pending" }]);
      expect(await count(world.db, "ledger.basis")).toBe(0); // erasure-proves: ledger.basis.row_id
    }));
});

describe("the journal, the lift and the replay", { timeout: DB_TEST_TIMEOUT }, () => {
  // An erasure killed at its last insert by a check the test adds, after its journal line.
  const killed = async (world: World): Promise<MessageId> => {
    await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
    const solo = await messageOf(world, MAIL.solo);
    await asOwner(world.db, "alter table knowledge.removed_evidence add constraint test_kill check (false) not valid");
    await expect(
      world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    await asOwner(world.db, "alter table knowledge.removed_evidence drop constraint test_kill");
    return solo.id;
  };

  it("the journal line exists when the transaction is killed before its commit", () =>
    inWorld(async (world) => {
      await killed(world);
      expect((await readJournal(world.journal)).seq).toBe(1);
      expect(await count(world.db, "knowledge.erasures")).toBe(0);
      // Rolled back whole: the message is still there.
      expect(await storedRevisions(world, MAIL.solo)).toBe(1);
      expect(await world.admin.erasure.level()).toBe("behind");
    }));

  it("a person's line names the people it removes, and an item's names none", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const solo = await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo).then(() =>
        messageOf(world, MAIL.solo),
      );
      await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      await world.admin.erasure.erasePerson(person, { requestId: req() });
      const { entries } = await readJournal(world.journal);
      expect(entries[0]).not.toHaveProperty("entities");
      expect(entries[1]).toMatchObject({ kind: "person", entities: [person] });
    }));

  it("replay finishes an erasure killed before its commit, and a second replay changes nothing", () =>
    inWorld(async (world) => {
      await killed(world);
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
      expect(await admin(world.db, "select journal_seq::int as seq from knowledge.erasures")).toEqual([{ seq: 1 }]);
      expect(await count(world.db, "knowledge.removed_evidence")).toBe(1);
      expect(await world.admin.erasure.level()).toBe("level");
      const before = lines(await snapshot(world.db));
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 0, journalled: 0 });
      expect(lines(await snapshot(world.db))).toEqual(before);
      expect((await readJournal(world.journal)).seq).toBe(1);
    }));

  it("replay appends every erasure the journal lacks, and on a store with none creates the empty journal", () =>
    inWorld(async (world) => {
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 0, journalled: 0 });
      expect(await readJournal(world.journal, { mustExist: true })).toEqual({ entries: [], seq: 0 });
      const person = await canaryWorld(world);
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      const kept = await readJournal(world.journal);
      // The journal lost, as a volume restored without it would be.
      await rm(world.journal);
      await expect(world.admin.erasure.level()).rejects.toMatchObject({ code: "journal_refused" });
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 0, journalled: 1 });
      const rebuilt = await readJournal(world.journal);
      expect(rebuilt.seq).toBe(1);
      expect(rebuilt.entries[0]).toMatchObject({ seq: 1, erasure: report.erasure, kind: "person" });
      expect(new Set((rebuilt.entries[0] as { items: unknown[] }).items)).toEqual(
        new Set((kept.entries[0] as { items: unknown[] }).items),
      );
      expect(await world.admin.erasure.level()).toBe("level");
    }));

  it("a lift removes that erasure's suppression and removed-evidence rows and nothing else, and the next listing may store the item again", () =>
    inWorld(async (world) => {
      const person = await canaryWorld(world);
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      const id = report.erasure as ErasureId;
      expect(await world.admin.erasure.liftErasure(id, { requestId: req() })).toBe(true);
      expect(await count(world.db, "knowledge.suppressions")).toBe(0);
      expect(await count(world.db, "knowledge.removed_evidence")).toBe(0);
      expect(
        await admin(world.db, "select lift_seq::int as seq, lifted_at is not null as lifted from knowledge.erasures"),
      ).toEqual([{ seq: 2, lifted: true }]);
      const ruling = one(
        await admin<{ ruling_id: string }>(world.db, "select ruling_id from knowledge.erasures"),
      ).ruling_id;
      expect(
        await admin(world.db, "select supersedes from knowledge.owner_decisions where kind = 'erase_lift'"),
      ).toEqual([{ supersedes: ruling }]);
      expect((await readJournal(world.journal)).entries[1]).toEqual({ seq: 2, lift: id });
      // It restores no row itself.
      expect(await storedRevisions(world, MAIL.canary)).toBe(0);
      expect(await world.admin.erasure.liftErasure(id, { requestId: req() })).toBe(false);
      expect(await world.admin.erasure.liftErasure(testId("ers") as ErasureId, { requestId: req() })).toBe(false);
      expect(await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.canary)).toBe("stored");
      expect(await world.admin.erasure.level()).toBe("level");
    }));

  it("a hook that throws rolls the erasure back and leaves the journal line for replay", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      await withHook(
        {
          name: "test_throw",
          run: async () => {
            throw new Error("the test's hook");
          },
        },
        () =>
          expect(
            world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
          ).rejects.toThrow(),
      );
      expect(await count(world.db, "knowledge.erasures")).toBe(0);
      expect(await storedRevisions(world, MAIL.solo)).toBe(1);
      expect((await readJournal(world.journal)).seq).toBe(1);
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
    }));

  it("a replay whose entry fails leaves the earlier entries applied, names the sequence number and no content, and review still refuses", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const entry = (seq: number, fixture: MailFixture): ErasureJournalEntry =>
        ({
          seq,
          erasure: testId("ers"),
          kind: "item",
          items: [{ account: world.accounts.personalMail.id, fp: itemFp(world.db, fixture) }],
          suppress: [],
        }) as unknown as ErasureJournalEntry;
      const second = entry(2, MAIL.fromQuentin);
      await appendJournal(world.journal, entry(1, MAIL.solo));
      await appendJournal(world.journal, second);
      await asOwner(
        world.db,
        `alter table knowledge.removed_evidence add constraint test_kill check (source_item_fp <> '${itemFp(world.db, MAIL.fromQuentin)}') not valid`,
      );
      const error = await world.admin.erasure.replayErasures().then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error).not.toBeNull();
      expect(JSON.stringify({ message: error?.message, cause: error?.cause })).not.toMatch(/quentin|lighthouse|rota/i);
      const failed = world.store.log.events.filter((event) => event.event === "erasure_replay_failed");
      expect(failed).toEqual([
        {
          event: "erasure_replay_failed",
          ids: { erasure: (second as { erasure: string }).erasure },
          counts: { seq: 2 },
        },
      ]);
      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
      expect(await storedRevisions(world, MAIL.fromQuentin)).toBe(1);
      expect(await admin(world.db, "select journal_seq::int as seq from knowledge.erasures")).toEqual([{ seq: 1 }]);
      // Every command but the replay and status goes on refusing: the level is behind.
      expect(await world.admin.erasure.level()).toBe("behind");
    }));

  it("erasing a person who still holds an owner address neither suppresses it nor erases the owner's mail by it", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const person = await personOf(world, QUENTIN.address);
      // The address becomes the owner's while Quentin's row still holds it (no re-derive yet).
      await addOwnerAddressUnderived(world.db, QUENTIN.address, "own");
      const ownerSent: MailFixture = {
        ...MAIL.fromQuentin,
        id: "gm-erase-owner-0201",
        threadId: "thread-erase-owner-0201",
        labels: ["SENT"],
        to: [CANARY_PERSON],
      };
      expect(await ingestMail(world.store.writer, world.accounts.personalMail, ownerSent)).toBe("stored");
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      expect(report.suppressed).toBe(0);
      // Only the person's name is suppressed, never the owner's address.
      expect(await admin(world.db, "select value_fp from knowledge.suppressions")).toEqual([
        { value_fp: fingerprint(world.db.keys, "name", QUENTIN.name ?? "") },
      ]);
      expect(await storedRevisions(world, ownerSent)).toBe(1);
      // Mail from that address is still stored.
      const later: MailFixture = { ...ownerSent, id: "gm-erase-owner-0202", threadId: "thread-erase-owner-0202" };
      expect(await ingestMail(world.store.writer, world.accounts.personalMail, later)).toBe("stored");
    }));

  it("lifting one of two erasures that suppressed one address leaves it suppressed while the other stands", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const fp = fingerprint(world.db.keys, "address", QUENTIN.address);
      const first = await world.admin.erasure.erasePerson(await personOf(world, QUENTIN.address), { requestId: req() });
      // A second person entity holds the same address (as two compartments' rows of one address can).
      const second = testId("ent");
      await admin(world.db, "insert into knowledge.entities (id, kind) values ($1, 'person')", [second]);
      await admin(
        world.db,
        "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) select $1, $2, 'email', $3, $4, value_enc, '{own}' from knowledge.accounts limit 1",
        [testId("adr"), second, fp, fingerprint(world.db.keys, "domain", "lighthouse.test")],
      );
      const other = await world.admin.erasure.erasePerson(second as EntityId, { requestId: req() });
      expect(other.suppressed).toBe(1);
      expect(await world.admin.erasure.liftErasure(first.erasure as ErasureId, { requestId: req() })).toBe(true);
      expect(await count(world.db, "knowledge.suppressions", "value_fp = $1", [fp])).toBe(1);
      expect(
        await ingestMail(world.store.writer, world.accounts.personalMail, {
          ...MAIL.fromQuentin,
          id: "gm-erase-again-0203",
          threadId: "thread-erase-again-0203",
        }),
      ).toBe("suppressed");
    }));

  it("a replayed entry whose account the restored store lacks is applied, and the replay does not stick", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await appendJournal(world.journal, {
        seq: 1,
        erasure: testId("ers"),
        kind: "item",
        items: [
          { account: testId("acc"), fp: "b".repeat(64) },
          { account: world.accounts.personalMail.id, fp: itemFp(world.db, MAIL.solo) },
        ],
        suppress: [],
      } as unknown as ErasureJournalEntry);
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
      expect(await count(world.db, "knowledge.removed_evidence")).toBe(1);
      expect(await world.admin.erasure.level()).toBe("level");
    }));

  // FE0: the journal takes seal, unseal and retention entries before the steps that replay them; a
  // replay refuses one rather than pass over it.
  it("a replay meeting a seal, unseal or retention entry it cannot apply yet refuses, after applying the erasures before it", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await appendJournal(world.journal, {
        seq: 1,
        erasure: testId("ers"),
        kind: "item",
        items: [{ account: world.accounts.personalMail.id, fp: itemFp(world.db, MAIL.solo) }],
        suppress: [],
      } as unknown as ErasureJournalEntry);
      await appendJournal(world.journal, {
        seq: 2,
        seal: testId("sel"),
        kind: "domain",
        account: null,
        fp: "c".repeat(64),
      } as unknown as ErasureJournalEntry);
      await expect(world.admin.erasure.replayErasures()).rejects.toMatchObject({ code: "journal_refused" });
      // The log names the entry that stopped it, by its sequence number alone.
      expect(world.store.log.events.filter((event) => event.event === "erasure_replay_failed")).toEqual([
        { event: "erasure_replay_failed", counts: { seq: 2 } },
      ]);
      // The erasure before it was applied; the level stays behind, so every command still refuses.
      expect(await storedRevisions(world, MAIL.solo)).toBe(0);
      expect(await world.admin.erasure.level()).toBe("behind");
    }));

  it("an erasure while the sync lock is held is sync_running and leaves no journal line", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const sync = await holding(world.db.urls.writer, SYNC);
      try {
        await expect(
          world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
        ).rejects.toMatchObject({ code: "sync_running" });
        await expect(world.admin.erasure.replayErasures()).rejects.toMatchObject({ code: "sync_running" });
      } finally {
        await sync.release();
      }
      expect(await readJournal(world.journal)).toEqual({ entries: [], seq: 0 });
      expect(await storedRevisions(world, MAIL.solo)).toBe(1);
      expect(
        (await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() })).erasure,
      ).toMatch(/^ers_/);
    }));

  it("a second erasure while the first holds the sync lock is sync_running and leaves no journal line; run again after the first commits, it takes the next number", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const solo = await messageOf(world, MAIL.solo);
      const quentin = await messageOf(world, MAIL.fromQuentin);
      const other = sideOf(world);
      const hold = holdingHook();
      try {
        await withHook(hold.hook, async () => {
          const first = world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
          await hold.entered;
          await expect(
            other.erasure.eraseItem({ kind: "message", id: quentin.id }, { requestId: req() }),
          ).rejects.toMatchObject({ code: "sync_running" });
          expect((await readJournal(world.journal)).seq).toBe(1);
          hold.resume();
          expect((await first).erasure).toMatch(/^ers_/);
        });
        await other.erasure.eraseItem({ kind: "message", id: quentin.id }, { requestId: req() });
      } finally {
        await other.close();
      }
      expect(await admin(world.db, "select journal_seq::int as seq from knowledge.erasures order by 1")).toEqual([
        { seq: 1 },
        { seq: 2 },
      ]);
      expect((await readJournal(world.journal)).seq).toBe(2);
    }));
});

describe("an erasure beside other writers, on two connections", { timeout: DB_TEST_TIMEOUT }, () => {
  for (const first of ["release", "erasure"] as const) {
    it(`an erasure and a release of the same held message both finish, in either order: the ${first} first`, () =>
      inWorld(async (world) => {
        await ingestMail(world.store.writer, world.accounts.personalMail, { ...MAIL.solo, held: true });
        const solo = await messageOf(world, MAIL.solo);
        const releaser = sideOf(world);
        const eraser = sideOf(world);
        try {
          const lock = await holding(world.db.urls.admin, "select 1 from knowledge.messages where id = $1 for update", [
            solo.id,
          ]);
          const start = {
            release: () => outcome(releaser.held.releaseHeld({ id: solo.id })),
            erasure: () => outcome(eraser.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() })),
          };
          const one_ = start[first]();
          expect(await pending(one_)).toBe(true);
          const two = start[first === "release" ? "erasure" : "release"]();
          expect(await pending(two)).toBe(true);
          await lock.release();
          const [release, erasure] = first === "release" ? [await one_, await two] : [await two, await one_];
          expect(erasure).toMatchObject({ items: 1 });
          if (first === "release") {
            expect(release).toEqual({ released: 1 });
            // The release's decision survives, tainted: its target is gone.
            expect(
              await admin(
                world.db,
                "select tainted_at is not null as tainted from knowledge.owner_decisions where kind = 'release'",
              ),
            ).toEqual([{ tainted: true }]);
          } else {
            expect(release).toEqual({ rejected: "not_found" });
          }
        } finally {
          await releaser.close();
          await eraser.close();
        }
        expect(await count(world.db, "knowledge.messages", "id = $1", [solo.id])).toBe(0);
      }));
  }

  it("a commit that waited on an erasure writes nothing once the item is erased", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      await withPipeline(world, async (pipeline) => {
        // A first claim, so the commit has one to delete and takes the beliefs lock.
        expect(await pipeline.open(solo.evidence as EvidenceId)).not.toBeNull();
        expect(
          await pipeline.commit(batchOf(solo.evidence, [claimRecord(solo.evidence, "own", world.owner, { n: 1 })])),
        ).toBe("committed");
        const eraser = sideOf(world);
        try {
          const lock = await holding(world.db.urls.admin, BELIEFS);
          // The erasure holds the message and evidence rows, and waits at the beliefs lock.
          const erasure = outcome(eraser.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }));
          expect(await pending(erasure)).toBe(true);
          const commit = outcome(
            pipeline.commit(batchOf(solo.evidence, [claimRecord(solo.evidence, "own", world.owner, { n: 2 })])),
          );
          expect(await pending(commit)).toBe(true);
          await lock.release();
          expect(await erasure).toMatchObject({ items: 1 });
          expect(await commit).toBe("gone");
        } finally {
          await eraser.close();
        }
      });
      expect(await count(world.db, "knowledge.claims")).toBe(0);
      expect(await count(world.db, "vault.pipeline_items")).toBe(0);
      expect(await count(world.db, "knowledge.removed_evidence")).toBe(1);
    }));

  it("an erasure that waited on a commit removes what the commit wrote", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      await withPipeline(world, async (pipeline) => {
        expect(await pipeline.open(solo.evidence as EvidenceId)).not.toBeNull();
        expect(
          await pipeline.commit(batchOf(solo.evidence, [claimRecord(solo.evidence, "own", world.owner, { n: 1 })])),
        ).toBe("committed");
        const eraser = sideOf(world);
        try {
          const lock = await holding(world.db.urls.admin, BELIEFS);
          // The commit holds its evidence row `for share`, and waits at the beliefs lock.
          const commit = outcome(
            pipeline.commit(batchOf(solo.evidence, [claimRecord(solo.evidence, "own", world.owner, { n: 2 })])),
          );
          expect(await pending(commit)).toBe(true);
          const erasure = outcome(eraser.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }));
          expect(await pending(erasure)).toBe(true);
          await lock.release();
          expect(await commit).toBe("committed");
          expect(await erasure).toMatchObject({ items: 1 });
        } finally {
          await eraser.close();
        }
      });
      expect(await count(world.db, "knowledge.claims")).toBe(0);
    }));

  it("a ledger write started while an erasure holds the taint lock alone waits, and then finds its ref gone", () =>
    inWorld(async (world) => {
      await ingestMail(world.store.writer, world.accounts.personalMail, MAIL.solo);
      const solo = await messageOf(world, MAIL.solo);
      const raiser = sideOf(world);
      const hold = holdingHook();
      try {
        await withHook(hold.hook, async () => {
          const erasure = outcome(
            world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
          );
          await hold.entered;
          const raised = outcome(raiser.cards.raiseCard(cardAbout(solo.id)));
          expect(await pending(raised)).toBe(true);
          hold.resume();
          expect(await erasure).toMatchObject({ items: 1 });
          const answer = await raised;
          if ((answer as { rejected?: string }).rejected !== undefined)
            expect(answer).toEqual({ rejected: "not_found" });
          else expect(await count(world.db, "ledger.cards", "tainted_at is null")).toBe(0);
        });
      } finally {
        await raiser.close();
      }
      // No whole row cites the message.
      expect(await count(world.db, "ledger.basis", "ref_id = $1 and tainted_at is null", [solo.id])).toBe(0);
      expect(await count(world.db, "ledger.cards", "target_id = $1 and tainted_at is null", [solo.id])).toBe(0);
    }));

  for (const first of ["commit", "erasure"] as const) {
    it(`a commit that names a person being erased: whichever ran first, the claim never outlives the person: the ${first} first`, () =>
      inWorld(async (world) => {
        const person = await canaryWorld(world);
        const quentin = await messageOf(world, MAIL.fromQuentin);
        await withPipeline(world, async (pipeline) => {
          // Another person's item has a claim, so its commit takes the beliefs lock.
          expect(await pipeline.open(quentin.evidence as EvidenceId)).not.toBeNull();
          expect(
            await pipeline.commit(
              batchOf(quentin.evidence, [claimRecord(quentin.evidence, "own", world.owner, { n: 1 })]),
            ),
          ).toBe("committed");
          const firstClaims = await admin(world.db, "select id from knowledge.claims where evidence_id = $1", [
            quentin.evidence,
          ]);
          const eraser = sideOf(world);
          try {
            const lock = await holding(world.db.urls.admin, BELIEFS);
            const naming = batchOf(quentin.evidence, [
              claimRecord(quentin.evidence, "own", world.owner, { n: 2, entities: [person] }),
            ]);
            const start = {
              commit: () => outcome(pipeline.commit(naming)),
              erasure: () => outcome(eraser.erasure.erasePerson(person, { requestId: req() })),
            };
            const one_ = start[first]();
            expect(await pending(one_)).toBe(true);
            const two = start[first === "commit" ? "erasure" : "commit"]();
            expect(await pending(two)).toBe(true);
            await lock.release();
            const [commit, erasure] = first === "commit" ? [await one_, await two] : [await two, await one_];
            if (first === "commit") {
              expect(commit).toBe("committed");
              expect(erasure).toMatchObject({ more: { claims_naming: 1 } });
            } else {
              expect(erasure).toMatchObject({ more: { claims_naming: 0 } });
              // The foreign key, as the store answers it: the claim names a person who is gone.
              expect(commit).toEqual({ rejected: "write_refused" });
              // It wrote nothing: the item keeps the first commit's one claim.
              expect(
                await admin(world.db, "select id from knowledge.claims where evidence_id = $1", [quentin.evidence]),
              ).toEqual(firstClaims);
              // The next run's commit, naming nobody, is committed.
              expect(await pipeline.open(quentin.evidence as EvidenceId)).not.toBeNull();
              expect(
                await pipeline.commit(
                  batchOf(quentin.evidence, [claimRecord(quentin.evidence, "own", world.owner, { n: 3 })]),
                ),
              ).toBe("committed");
            }
          } finally {
            await eraser.close();
          }
        });
        expect(await count(world.db, "knowledge.claim_entities", "entity_id = $1", [person])).toBe(0);
        expect(await count(world.db, "knowledge.entities", "id = $1", [person])).toBe(0);
        expect(await storedRevisions(world, MAIL.fromQuentin)).toBe(1);
      }));
  }
});
