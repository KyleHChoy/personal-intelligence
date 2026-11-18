import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceId } from "@intelligence/contracts";
import type { ErasureId, ErasureJournalEntry, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { appendJournal } from "../core/journal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect } from "../test-support/cast.ts";
import { insertClient, type TestClient, testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { memoryClient, serve, served } from "../test-support/memory-fixtures.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { withErasureHook as withHook } from "../test-support/waits.ts";
import type { ErasureHook } from "./erasure-hook.ts";
import { ERASURE_HOOKS } from "./erasure-hooks.ts";

// The erasure's half of the vendor exposure record: an erasure links the model and client exposures
// of what it erased, the facts it supported and the memory exposures its taint wrote, and the
// report counts the distinct recipients under `vendor_exposures`. Made-up values only.

const EXTRACT_MODEL = "openai/gpt-6-luna";
const DECIDE_MODEL = "typesafe/jev-1.13";
const PROMPT = "personal_correspondence";
const HOOK = "vendor_exposures";

type World = { store: TestStore; db: TestDatabase; accounts: Accounts; admin: Admin; journal: string; owner: string };

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-exposures-erase-"));
  const store = await openStore({ compartments: ["own", "employer:example"] });
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

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;
const req = (): string => testId("req");

async function messageOf(world: World, fixture: MailFixture): Promise<{ id: MessageId; evidence: string }> {
  const row = one(
    await admin<{ id: string; evidence_id: string }>(
      world.db,
      "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [world.accounts.personalMail.id, fingerprint(world.db.keys, "source_id", mailSourceId(fixture))],
    ),
  );
  return { id: row.id as MessageId, evidence: row.evidence_id };
}

// A message, a claim on it committed through the pipeline, and its exposure noted to a model as
// `pi extract` notes one; the claim's fact key fingerprint.
async function exposedMessage(
  world: World,
  fixture: MailFixture,
  models: string[] = [EXTRACT_MODEL],
): Promise<{ id: MessageId; evidence: string; fact: string }> {
  await ingestMail(world.store.writer, world.accounts.personalMail, fixture);
  const message = await messageOf(world, fixture);
  const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: world.store.log });
  try {
    expect(await pipeline.open(message.evidence as EvidenceId)).not.toBeNull();
    expect(await pipeline.commit(batchOf(message.evidence, [claimRecord(message.evidence, "own", world.owner)]))).toBe(
      "committed",
    );
    for (const model of models)
      expect(await pipeline.noteExposure(model, PROMPT, [message.evidence as EvidenceId])).toBe(1);
  } finally {
    await pipeline.close();
  }
  const fact = one(
    await admin<{ fact_key_fp: string }>(world.db, "select fact_key_fp from knowledge.claims where evidence_id = $1", [
      message.evidence,
    ]),
  ).fact_key_fp;
  return { ...message, fact };
}

// A client with a recorded vendor retention, and one read of its own, logged as the reader logs a
// tool's read set.
async function client(
  world: World,
  name: string,
  retention: "none" | "limited" | "retains" | "unknown",
): Promise<TestClient> {
  const made = await insertClient(world.db, name, ["own"]);
  // The tools these tests read with, beside insertClient's four: policy.log_read refuses a tool
  // the client does not hold.
  await admin(
    world.db,
    "update policy.clients set vendor_retention = $1, tools = tools || '{read_message,find_facts}'::text[] where id = $2",
    [retention, made.id],
  );
  return made;
}
const read = (
  world: World,
  reader: TestClient,
  set: { bound?: string[]; shown?: string[]; facts?: string[] },
  tool = "search",
): Promise<void> =>
  readAs(world.db, reader.token, async (query) => {
    const id = testId("ses");
    await query("select policy.open_session($1)", [id]);
    await query("select policy.log_read($1, $2, $3::text[], $4::text[], $5::text[])", [
      id,
      tool,
      set.bound ?? [],
      set.shown ?? [],
      set.facts ?? [],
    ]);
  });

type Link = { recipient: string; ref: string };
// By code unit, whatever the database's collation.
const sorted = (links: Link[]): Link[] =>
  [...links].sort((a, b) =>
    a.recipient === b.recipient ? (a.ref < b.ref ? -1 : 1) : a.recipient < b.recipient ? -1 : 1,
  );

// The links an erasure holds: each exposure's recipient and ref, and each memory exposure's
// client and projection.
async function linksOf(db: TestDatabase, erasure: string): Promise<Link[]> {
  return sorted(
    await admin<Link>(
      db,
      `select x.recipient, x.ref from ledger.erasure_exposures l join ledger.exposures x on x.id = l.exposure_id where l.erasure_id = $1
       union all
       select m.client_id, m.projection_id from ledger.erasure_exposures l join ledger.memory_exposures m on m.id = l.memory_exposure_id where l.erasure_id = $1`,
      [erasure],
    ),
  );
}

// Until some backend waits for the taint lock in `mode`: ExclusiveLock is an erasure waiting
// to take it alone, ShareLock a reader waiting to hold it shared.
const TAINT_KEY = "intelligence personal ledger taint";
async function waitingForTaint(db: TestDatabase, mode: "ExclusiveLock" | "ShareLock"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await admin<{ n: number }>(
      db,
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and objsubid = 1 and not granted and mode = $1
         and ((classid::bigint << 32) | objid::bigint) = hashtext($2)::bigint`,
      [mode, TAINT_KEY],
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nothing waited for the taint lock (${mode})`);
}

// Whether a promise has settled, without waiting for it.
const settled = (promise: Promise<unknown>): Promise<boolean> => {
  const done = promise.then(
    () => true,
    () => true,
  );
  return Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))]);
};

describe("the erasure's exposure links", { timeout: DB_TEST_TIMEOUT }, () => {
  it("vendor_exposures is a standing hook", () => {
    expect(ERASURE_HOOKS.map((hook) => hook.name)).toContain(HOOK);
  });

  it("erasing an item links its model and client exposures and the facts it supported; the report counts recipients", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo, [EXTRACT_MODEL, DECIDE_MODEL]);
      const kept = await client(world, "kept-reader", "retains");
      const unknown = await client(world, "unknown-reader", "unknown");
      const forgetful = await client(world, "forgetful-reader", "none");
      await read(world, kept, { bound: [solo.evidence] }, "read_message");
      await read(world, unknown, { facts: [solo.fact] }, "find_facts");
      await read(world, forgetful, { bound: [solo.evidence] }, "read_message");
      // An exposure of another item is not this erasure's.
      const other = await exposedMessage(world, MAIL.fromQuentin);
      await read(world, kept, { bound: [other.evidence] }, "read_message");

      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      // The extract model, the decide model, the retaining client and the unknown one; the client recorded none is not.
      expect(report.more[HOOK]).toBe(4);
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual(
        sorted([
          { recipient: EXTRACT_MODEL, ref: solo.evidence },
          { recipient: DECIDE_MODEL, ref: solo.evidence },
          { recipient: kept.id, ref: solo.evidence },
          { recipient: unknown.id, ref: solo.fact },
        ]),
      );
      // Each link carries its exposure's label.
      expect(
        await count(world.db, "ledger.erasure_exposures", "erasure_id = $1 and compartments = '{own}'", [
          report.erasure,
        ]),
      ).toBe(4);
    }));

  it("the hook's links commit although the erasure row is inserted after it, and an erasure that rolls back leaves none", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const quentin = await exposedMessage(world, MAIL.fromQuentin);
      // A hook after the standing ones that throws: the whole erasure rolls back.
      await expect(
        withHook({ name: "test_throws", run: () => Promise.reject(new Error("the test's hook")) }, () =>
          world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() }),
        ),
      ).rejects.toThrow();
      expect(await count(world.db, "ledger.erasure_exposures")).toBe(0);
      expect(await count(world.db, "knowledge.erasures")).toBe(0);
      // The control: the same erasure of the other message commits, with its link, once the
      // rolled-back erasure's journal line is replayed, as every erasure first needs.
      await world.admin.erasure.replayErasures();
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: quentin.id }, { requestId: req() });
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual([
        { recipient: EXTRACT_MODEL, ref: quentin.evidence },
      ]);
    }));

  it("a dry run writes nothing, and counts the memory clients the taint would reach", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const kept = await client(world, "kept-reader", "retains");
      await read(world, kept, { shown: [solo.evidence] });
      const memory = await memoryClient(world.db, "memory-reader", ["own"], { retention: "retains" });
      await serve(world.db, memory.token, { entries: [served(1, { evidence: [solo.evidence] })] });

      const dry = await world.admin.erasure.eraseItem(
        { kind: "message", id: solo.id },
        { requestId: req(), dryRun: true },
      );
      expect(dry.more[HOOK]).toBe(3);
      expect(await count(world.db, "ledger.erasure_exposures")).toBe(0);
      expect(await count(world.db, "ledger.memory_exposures")).toBe(0);
      // The erasure itself counts the same recipients.
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      expect(report.more[HOOK]).toBe(3);
    }));

  it("the memory exposures the erasure's taint wrote are linked", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo, []);
      const memory = await memoryClient(world.db, "memory-reader", ["own"], { retention: "retains" });
      await serve(world.db, memory.token, { entries: [served(1, { evidence: [solo.evidence] })] });
      // A memory exposure written before the erasure, by another taint, is not linked.
      const elsewhere = await memoryClient(world.db, "memory-elsewhere", ["own"], { retention: "retains" });
      await serve(world.db, elsewhere.token, { entries: [served(2)] });
      await queryAs(world.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [served(2).evidence[0]],
      ]);
      expect(await count(world.db, "ledger.memory_exposures")).toBe(1);

      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      const written = one(
        await admin<{ id: string; projection_id: string }>(
          world.db,
          "select id::text as id, projection_id from ledger.memory_exposures where client_id = $1",
          [memory.id],
        ),
      );
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual([
        { recipient: memory.id, ref: written.projection_id },
      ]);
      expect(report.more[HOOK]).toBe(1);
      // The owner's listing names it under the memory route, with its removal state.
      const today = one(
        await admin<{ day: string }>(world.db, "select (now() at time zone 'utc')::date::text as day"),
      ).day;
      expect((await world.admin.erasure.listExposures(report.erasure as ErasureId)).recipients).toEqual([
        {
          kind: "client",
          id: memory.id,
          route: "sync_memory",
          firstDay: today,
          lastDay: today,
          ids: 1,
          retention: "retains",
          removal: "pending",
        },
      ]);
    }));

  it("a replay keeps the links once", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const kept = await client(world, "kept-reader", "retains");
      await read(world, kept, { bound: [solo.evidence] });
      // An erasure on the journal that the database lacks, as after a restore.
      const erasure = testId("ers") as ErasureId;
      await appendJournal(world.journal, {
        seq: 1,
        erasure,
        kind: "item",
        items: [
          {
            account: world.accounts.personalMail.id,
            fp: fingerprint(world.db.keys, "source_id", mailSourceId(MAIL.solo)),
          },
        ],
        suppress: [],
      } as unknown as ErasureJournalEntry);
      expect(await world.admin.erasure.replayErasures()).toMatchObject({ applied: 1 });
      const links = await linksOf(world.db, erasure);
      expect(links.map((one) => one.recipient).sort()).toEqual([EXTRACT_MODEL, kept.id].sort());
      // The hook again, with the entry's erasure id, as a second replay would apply it: the links
      // are kept, once each, and the count is the same.
      const hook = ERASURE_HOOKS.find((one) => one.name === HOOK);
      if (hook === undefined) throw new Error("no hook");
      const again = await session(world.db.urls.admin, (query) =>
        hook.run(
          query,
          {
            evidenceIds: [solo.evidence],
            refs: [],
            addressFps: [],
            sources: [],
            records: [],
            recordEvidenceIds: [],
            erasureId: erasure,
            factKeyFps: [solo.fact],
            nameFps: [],
            claimKeys: [],
            claimIds: [],
          },
          { dryRun: false, now: new Date(), keys: world.db.keys },
        ),
      );
      expect(again).toBe(2);
      expect(await linksOf(world.db, erasure)).toEqual(links);
    }));

  // A reader holds the taint lock shared around its call,
  // so no client read in flight is missed and none that starts during an erasure sees the item.
  it("an erasure waits for a client read in flight, and then links the exposure it wrote", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const kept = await client(world, "kept-reader", "retains");
      // The read is held after its read log row, and its trigger's exposure, and before its call
      // log row and its commit.
      const recorded = recordingPool(world.store.readerPool, { holdWhen: (text) => /policy\.log_call\(/.test(text) });
      const reader = new Reader({ pool: recorded.pool, keys: world.db.keys, log: world.store.log });
      const reading = reader.readMessage(kept.token, { id: solo.id });
      await recorded.held.reached;
      expect(await count(world.db, "ledger.exposures", "recipient = $1", [kept.id])).toBe(0);

      const erasing = world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      erasing.catch(() => {});
      try {
        await waitingForTaint(world.db, "ExclusiveLock");
        expect(await settled(erasing)).toBe(false);
      } finally {
        recorded.held.release();
      }
      expect((await reading).ok).toBe(true);
      const report = await erasing;
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual(
        sorted([
          { recipient: EXTRACT_MODEL, ref: solo.evidence },
          { recipient: kept.id, ref: solo.evidence },
        ]),
      );
      expect(report.more[HOOK]).toBe(2);
    }));

  it("a client read that starts during an erasure waits for it, and finds the item erased", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const kept = await client(world, "kept-reader", "retains");
      // The erasure is held at its hooks, after it took the taint lock alone.
      let reach = (): void => {};
      let release = (): void => {};
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding: ErasureHook = {
        name: "test_holds",
        run: async () => {
          reach();
          await gate;
          return 0;
        },
      };
      const erasing = withHook(holding, async () => {
        const erased = world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
        erased.catch(() => {});
        await reached;
        const reader = new Reader({ pool: world.store.readerPool, keys: world.db.keys, log: world.store.log });
        const reading = reader.readMessage(kept.token, { id: solo.id });
        try {
          await waitingForTaint(world.db, "ShareLock");
          expect(await settled(reading)).toBe(false);
        } finally {
          release();
        }
        return { report: await erased, answer: await reading };
      });
      const { report, answer } = await erasing;
      expect(answer).toEqual({ ok: false, code: "not_found" });
      expect(await count(world.db, "ledger.exposures", "recipient = $1", [kept.id])).toBe(0);
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual([{ recipient: EXTRACT_MODEL, ref: solo.evidence }]);
    }));

  it("no removal, erasure or lift deletes an exposure row, and a lift keeps the links", () =>
    inWorld(async (world) => {
      const solo = await exposedMessage(world, MAIL.solo);
      const quentin = await exposedMessage(world, MAIL.fromQuentin);
      const kept = await client(world, "kept-reader", "retains");
      await read(world, kept, { bound: [solo.evidence, quentin.evidence] });
      const before = await admin(world.db, "select * from ledger.exposures order by id");
      expect(before).toHaveLength(4);
      // A deletion at the source.
      await world.store.writer.applyDeletion(world.accounts.personalMail, {
        sourceAccount: world.accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
        deletedAt: "2026-09-03T00:00:00Z",
      });
      const report = await world.admin.erasure.eraseItem({ kind: "message", id: solo.id }, { requestId: req() });
      const links = await linksOf(world.db, report.erasure ?? "");
      expect(await world.admin.erasure.liftErasure(report.erasure as ErasureId, { requestId: req() })).toBe(true);
      expect(await admin(world.db, "select * from ledger.exposures order by id")).toEqual(before);
      expect(await linksOf(world.db, report.erasure ?? "")).toEqual(links);
    }));
});
