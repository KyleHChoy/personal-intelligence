import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CardId,
  ErasureReport,
  type MessageId,
  PersonalLogEvent,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import type { GmailMessage } from "@intelligence/personal-core/items";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import {
  applyMigrations,
  createAdmin,
  createWriter,
  journalPath,
  readJournal,
  type Writer,
} from "@intelligence/personal-store";
import {
  createTestDatabase,
  dropDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runSync } from "../intake/sync.ts";
import { failed } from "../test-support/run-pi.ts";
import { mcpBatch as mcp, spawnPi as pi } from "../test-support/spawn-pi.ts";

// The erasure's gate tests X1 to X7, through the real `pi` process, a real Postgres with the
// production roles, and the fakes of the synthetic world for Google. Only sync runs in-process,
// because the fakes live in this process; `pi sync --reset gmail` is `runSync` with `reset:
// ["gmail"]`. The tests run in order and share one store: each step builds on the one before. A
// restore is a database copied with `create database ... template` and the role URLs pointed at the
// copy. The two holds of a restore (the sync hold file, the read hold) are the image's, and its
// smoke test proves them.

const HOUR = 3_600_000;
const LONG = 300_000;

type Env = Record<string, string>;
type Store = Pick<TestDatabase, "name" | "urls" | "keys" | "keyFile">;

const REPLAY = failed("erasure_replay_needed", "run pi erase replay (pia on the box)");
const SYNC_RUNNING = failed("sync_running", "a sync is running; hold it with the sync-hold file and try again");

// A copy of the store, as a backup restored is: made from it as a template, with the database
// privileges a migration run gives (they belong to the database, and a template does not carry them).
let copies = 0;
async function copyOf(source: Store): Promise<Store> {
  copies += 1;
  const name = `${source.name}_c${copies}`;
  const server = source.urls.bootstrap.replace(new RegExp(`/${source.name}$`), "/postgres");
  await queryAs(server, `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(source.name)}`);
  const at = (url: string): string => url.replace(new RegExp(`/${source.name}$`), `/${name}`);
  const urls = {
    bootstrap: at(source.urls.bootstrap),
    admin: at(source.urls.admin),
    writer: at(source.urls.writer),
    reader: at(source.urls.reader),
    pipeline: at(source.urls.pipeline),
    work: at(source.urls.work),
    proxy: at(source.urls.proxy),
    restricted: at(source.urls.restricted),
  };
  await applyMigrations(urls.bootstrap);
  return { name, urls, keys: source.keys, keyFile: source.keyFile };
}
const dropCopy = (store: Store): Promise<void> => dropDatabase(store.name);

// A message of the test's own, on reserved domains, `hoursAgo` before now.
function message(
  now: Date,
  id: string,
  from: string,
  to: string,
  hoursAgo: number,
  more: { cc?: string; subject?: string; text?: string; labels?: string[] } = {},
): GmailMessage {
  const internalDate = Math.floor(now.getTime() / 1000) * 1000 - hoursAgo * HOUR;
  return {
    id,
    threadId: id,
    internalDate,
    labelIds: more.labels ?? ["INBOX"],
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      ...(more.cc === undefined ? [] : [{ name: "Cc", value: more.cc }]),
      { name: "Date", value: new Date(internalDate - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Subject", value: more.subject ?? "An erasure gate test" },
      { name: "Message-ID", value: `<${id}@id.example.com>` },
    ],
    ...(more.text === undefined ? {} : { text: more.text }),
  };
}

// Until a real process waits on a lock in the store: a lock asked for and not granted.
async function waitingOnLock(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await queryAs<{ n: number }>(
      store.urls.bootstrap,
      "select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.datname = current_database()",
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no erasure waited on the lock");
}

// A connection that holds a lock until `release`.
async function holding(
  url: string,
  statements: string[],
  values: unknown[][] = [],
): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const [index, sql] of statements.entries()) await client.query(sql, values[index]);
  return {
    release: async () => {
      await client.query("commit").catch(() => {});
      await client.end();
    },
  };
}

// An id's 26 characters, in the ULID alphabet.
const ulid = (): string =>
  Array.from(randomBytes(26), (byte) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[byte % 32]).join("");

const CANARY_SUBJECT = "canary-erase-subject-7a1c";
const CANARY_BODY = "canary-erase-body-7a1c, never to be found again";
const TAMSIN = "tamsin.gone@example.org";
const NEVER = "una.later@example.org";

describe("pi erase, end to end: X1 to X7", () => {
  const now = new Date();
  const w = world({ now });
  const [personal] = w.accounts;
  if (personal === undefined) throw new Error("the world has two accounts");
  const sources = fakeSources(w);
  const [personalSource] = sources;
  if (personalSource === undefined) throw new Error("the world has two accounts");
  const gmail = personalSource.gmail;
  const owner = personal.address;

  // The canary message X1 erases; Tamsin's two messages, one each way, for X2; and the
  // messages X3, X4, X6 and X7 erase or delete.
  const CANARY = message(now, "19e1000000000001", `Rosa Erasable <rosa.erasable@example.org>`, owner, 30, {
    subject: CANARY_SUBJECT,
    text: CANARY_BODY,
  });
  gmail.add(CANARY);
  gmail.add(message(now, "19e1000000000002", `Tamsin Gone <${TAMSIN}>`, owner, 29));
  gmail.add(message(now, "19e1000000000003", owner, `Tamsin Gone <${TAMSIN}>`, 28, { labels: ["SENT"] }));
  const AFTER_RESTORE = message(now, "19e1000000000004", `Una Later <${NEVER}>`, owner, 27);
  gmail.add(AFTER_RESTORE);
  const KILLED = message(now, "19e1000000000005", "Kit Killed <kit.killed@example.org>", owner, 26);
  gmail.add(KILLED);
  const HELD = message(now, "19e1000000000006", "Hal Held <hal.held@example.org>", owner, 25);
  gmail.add(HELD);
  const SOURCE_DELETED = message(now, "19e1000000000007", "Dee Deleted <dee.deleted@example.org>", owner, 24, {
    subject: "canary-source-deleted-3b9e",
  });
  gmail.add(SOURCE_DELETED);

  const events: PersonalLogEvent[] = [];
  const record = (one: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(one));
  const log: PersonalLogger = { info: record, warn: record, error: record };

  let folder = "";
  let made: TestDatabase | undefined;
  let store: Store;
  const restored: Store[] = [];
  let writer: Writer | undefined;
  let token = "";

  const adminEnv = (): Env => ({ PI_DATABASE_URL_ADMIN: store.urls.admin, PI_KEY_FILE: store.keyFile });
  const readerEnv = (): Env => ({
    PI_DATABASE_URL_READER: store.urls.reader,
    PI_KEY_FILE: store.keyFile,
    PI_CLIENT_TOKEN: token,
  });
  const writerEnv = (): Env => ({ PI_DATABASE_URL_WRITER: store.urls.writer, PI_KEY_FILE: store.keyFile });
  const openWriter = (): Writer => (writer = createWriter({ url: store.urls.writer, keys: store.keys, log }));
  const closeWriter = async (): Promise<void> => {
    await writer?.close();
    writer = undefined;
  };
  const sync = async (reset: "gmail"[] = []): Promise<void> => {
    const result = await runSync({ writer: writer ?? openWriter(), sources, log, now, reset });
    expect(
      result.outcomes.every((one) => one.outcome === "ok"),
      JSON.stringify(result.outcomes),
    ).toBe(true);
  };
  const rows = <Row>(text: string, values?: unknown[]): Promise<Row[]> => queryAs<Row>(store.urls.admin, text, values);
  const itemFp = (one: GmailMessage): string => fingerprint(store.keys, "source_id", `gmail-id:${one.id}`);
  const evidenceOf = async (one: GmailMessage): Promise<string[]> =>
    (await rows<{ id: string }>("select id from vault.evidence_items where source_item_fp = $1", [itemFp(one)])).map(
      (row) => row.id,
    );
  const messageIdOf = async (one: GmailMessage): Promise<MessageId> =>
    ((
      await rows<{ id: string }>(
        "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
        [itemFp(one)],
      )
    )[0]?.id ?? "") as MessageId;
  const where = (hits: { table: string; column: string }[]): string[] =>
    hits.map((hit) => `${hit.table}.${hit.column}`).sort();
  const erase = async (argv: string[]): Promise<ErasureReport> => {
    const result = await pi(["erase", ...argv], adminEnv());
    expect(result, argv.join(" ")).toMatchObject({ exit: 0, stderr: "" });
    return ErasureReport.parse(JSON.parse(result.stdout));
  };
  const cardCiting = async (id: MessageId): Promise<CardId> => {
    const admin = createAdmin({ url: store.urls.admin, keys: store.keys, log });
    try {
      const card = `crd_${ulid()}` as CardId;
      await admin.cards.raiseCard({
        id: card,
        requestId: `gate-${card.slice(4)}`,
        kind: "notice",
        author: "system:test",
        options: ["acknowledge"],
        target: null,
        refs: [{ kind: "message", id }],
        compartments: ["own"],
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: null,
        run: null,
        body: "canary-card-body-5d2f",
        bodyFrom: "code",
      });
      return card;
    } finally {
      await admin.close();
    }
  };

  // X1, for one erased message: its text in no column; its source fingerprint in no row but its
  // removed-evidence row; its evidence ids in no row but that one and the lists of what a client
  // was given; and its message id in no row but the ids a tainted row keeps of what it was about.
  const x1 = async (
    erased: GmailMessage,
    ids: { evidence: string[]; message: string },
    texts: string[],
  ): Promise<void> => {
    expect(await evidenceOf(erased)).toEqual([]);
    expect(where(await scanForPlaintext(store.urls.admin, texts))).toEqual([]);
    expect(where(await scanForPlaintext(store.urls.admin, [itemFp(erased)]))).toEqual([
      "knowledge.removed_evidence.source_item_fp",
    ]);
    for (const id of ids.evidence) {
      // FE0: the exposure record keeps the ids it was given, as the read log does: the reader here
      // is recorded `unknown`, so its read is an exposure.
      const allowed = [
        "knowledge.removed_evidence.evidence_ids",
        "ledger.read_log.bound",
        "ledger.read_log.shown",
        "ledger.agent_writes.cites",
        "ledger.exposures.ref",
      ];
      for (const hit of where(await scanForPlaintext(store.urls.admin, [id]))) expect(allowed, hit).toContain(hit);
      expect(where(await scanForPlaintext(store.urls.admin, [id]))).toContain(
        "knowledge.removed_evidence.evidence_ids",
      );
    }
    const allowed = [
      "ledger.context_packs.item_ids",
      "ledger.basis.ref_id",
      "ledger.cards.target_id",
      "knowledge.owner_decisions.target_id",
    ];
    for (const hit of where(await scanForPlaintext(store.urls.admin, [ids.message])))
      expect(allowed, hit).toContain(hit);
  };

  // X2, for Tamsin: the address fingerprint in no row of any table but the suppressions (the
  // test finds the tables from the catalogue), and `search` finds nothing.
  const x2 = async (): Promise<void> => {
    expect(where(await scanForPlaintext(store.urls.admin, [fingerprint(store.keys, "address", TAMSIN)]))).toEqual([
      "knowledge.suppressions.value_fp",
    ]);
    expect(where(await scanForPlaintext(store.urls.admin, [TAMSIN, "tamsin gone"]))).toEqual([]);
    const searched = await mcp(readerEnv(), [
      { method: "tools/call", params: { name: "search", arguments: { query: TAMSIN } } },
    ]);
    expect(searched.exit).toBe(0);
    expect((searched.replies[0]?.result?.structuredContent as { results: unknown[] } | undefined)?.results).toEqual([]);
  };

  let canary = { evidence: [] as string[], message: "" };
  let card: CardId = "" as CardId;

  afterAll(async () => {
    await closeWriter();
    for (const copy of restored) await dropCopy(copy).catch(() => {});
    await made?.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it(
    "the store holds the world, a client has read the canary message, and a card cites it",
    async () => {
      folder = await mkdtemp(join(tmpdir(), "pi-erase-e2e-"));
      const keyFile = join(folder, "keys.json");
      expect(await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).toEqual({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      made = await createTestDatabase({ keyFile });
      store = made;
      await sync();
      expect(await pi(["erase", "replay"], adminEnv())).toEqual({
        exit: 0,
        stdout: `${JSON.stringify({ applied: 0, journalled: 0 })}\n`,
        stderr: "",
      });
      const added = await pi(
        [
          "clients",
          "add",
          "gate-reader",
          "--broad",
          "--views",
          "self,people",
          "--tools",
          "get_self,search,get_entity,find_messages,read_message",
        ],
        adminEnv(),
      );
      expect(added.exit).toBe(0);
      token = added.stdout.trim();
      canary = { evidence: await evidenceOf(CANARY), message: await messageIdOf(CANARY) };
      expect(canary.evidence).toHaveLength(1);
      // Read by id, so the read log binds its evidence id.
      const read = await mcp(readerEnv(), [
        { method: "tools/call", params: { name: "read_message", arguments: { id: canary.message } } },
      ]);
      expect(read.replies[0]?.result?.isError).not.toBe(true);
      card = await cardCiting(canary.message as MessageId);
      // The positive control of X1's scan: the canary's text is stored, sealed, and its
      // fingerprint and evidence id are in more rows than the ones allowed after the erasure.
      expect(where(await scanForPlaintext(store.urls.admin, [itemFp(CANARY)]))).toContain(
        "vault.evidence_items.source_item_fp",
      );
      expect(where(await scanForPlaintext(store.urls.admin, [canary.message]))).toContain("knowledge.messages.id");
    },
    LONG,
  );

  it(
    "X5: an erased message taints the card that cited it, and the card's body is gone",
    async () => {
      const report = await erase(["item", canary.message]);
      expect(report).toMatchObject({ items: 1, people: 0, taintedRows: 1, exposedClients: 1 });
      expect(
        await rows(
          "select tainted_at is not null as tainted, body_enc is null as emptied from ledger.cards where id = $1",
          [card],
        ),
      ).toEqual([{ tainted: true, emptied: true }]);
      expect(where(await scanForPlaintext(store.urls.admin, ["canary-card-body-5d2f"]))).toEqual([]);
    },
    LONG,
  );

  it(
    "X1: an erased message is in no column of any table, and no sync brings it back",
    async () => {
      await x1(CANARY, canary, [CANARY_SUBJECT, CANARY_BODY]);
      await sync();
      await x1(CANARY, canary, [CANARY_SUBJECT, CANARY_BODY]);
      await sync(["gmail"]);
      await x1(CANARY, canary, [CANARY_SUBJECT, CANARY_BODY]);
      expect(events.filter((one) => one.event === "items_not_stored").some((one) => one.counts?.removed === 1)).toBe(
        true,
      );
    },
    LONG,
  );

  it(
    "X2: an erased person is in no row, and comes back in none",
    async () => {
      const person =
        (
          await rows<{ entity_id: string }>("select entity_id from knowledge.accounts where value_fp = $1", [
            fingerprint(store.keys, "address", TAMSIN),
          ])
        )[0]?.entity_id ?? "";
      const report = await erase(["person", person]);
      expect(report).toMatchObject({ items: 2, people: 1, suppressed: 1 });
      await x2();
      // A new message from Tamsin is not stored; one that copies Tamsin is, and derives no row
      // for Tamsin; one the owner sends to Tamsin writes no recipient row for Tamsin.
      const fromTamsin = message(now, "19e1000000000011", `Tamsin Gone <${TAMSIN}>`, owner, 12);
      gmail.add(fromTamsin);
      gmail.add(
        message(now, "19e1000000000012", "Cass Copier <cass.copier@example.org>", owner, 11, {
          cc: `Tamsin Gone <${TAMSIN}>`,
        }),
      );
      gmail.add(message(now, "19e1000000000013", owner, `Tamsin Gone <${TAMSIN}>`, 10, { labels: ["SENT"] }));
      await sync();
      expect(await evidenceOf(fromTamsin)).toEqual([]);
      expect(
        await rows("select 1 from vault.evidence_items where source_item_fp = $1", [
          fingerprint(store.keys, "source_id", "gmail-id:19e1000000000012"),
        ]),
      ).toHaveLength(1);
      await x2();
      await sync(["gmail"]);
      await x2();
    },
    LONG,
  );

  it(
    "X3: after a restore, nothing reads until the erasures are replayed",
    async () => {
      const una = { evidence: await evidenceOf(AFTER_RESTORE), message: await messageIdOf(AFTER_RESTORE) };
      // The backup, taken with nothing connected to the store.
      await closeWriter();
      const backup = await copyOf(store);
      restored.push(backup);
      // An erasure after the backup.
      expect((await erase(["item", una.message])).items).toBe(1);
      // The database put back.
      store = backup;
      expect(await pi(["sync"], writerEnv())).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
      expect(
        await mcp(readerEnv(), [{ method: "tools/call", params: { name: "get_self", arguments: {} } }]),
      ).toMatchObject({ exit: 1, replies: [], stderr: REPLAY });
      expect(await pi(["erase", "list"], adminEnv())).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
      expect(await evidenceOf(AFTER_RESTORE)).toHaveLength(1);
      expect(await pi(["erase", "replay"], adminEnv())).toEqual({
        exit: 0,
        stdout: `${JSON.stringify({ applied: 1, journalled: 0 })}\n`,
        stderr: "",
      });
      expect((await pi(["erase", "list"], adminEnv())).exit).toBe(0);
      await x1(AFTER_RESTORE, una, ["una later"]);
      await x2();
      await sync(["gmail"]);
      await x1(AFTER_RESTORE, una, ["una later"]);
      await x2();
    },
    LONG,
  );

  it(
    "X4: an erasure killed after its journal line and before its commit is finished by replay",
    async () => {
      const kit = { evidence: await evidenceOf(KILLED), message: await messageIdOf(KILLED) };
      const asOwner = (sql: string) =>
        holding(store.urls.bootstrap, ["set role pi_owner", sql]).then(async (held) => {
          await held.release();
        });
      // A check the test adds fails the erasure's last insert.
      await asOwner("alter table knowledge.removed_evidence add constraint test_kill check (false) not valid");
      const before = (await readJournal(journalPath(store.keyFile))).seq;
      expect(await pi(["erase", "item", kit.message], adminEnv())).toMatchObject({ exit: 1, stdout: "" });
      await asOwner("alter table knowledge.removed_evidence drop constraint test_kill");
      expect((await readJournal(journalPath(store.keyFile))).seq).toBe(before + 1);
      expect(await evidenceOf(KILLED)).toHaveLength(1);
      expect(await pi(["erase", "list"], adminEnv())).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
      expect(await pi(["erase", "replay"], adminEnv())).toEqual({
        exit: 0,
        stdout: `${JSON.stringify({ applied: 1, journalled: 0 })}\n`,
        stderr: "",
      });
      await x1(KILLED, kit, ["kit killed"]);
    },
    LONG,
  );

  it(
    "X6: an erasure and a sync never interleave",
    async () => {
      const journal = journalPath(store.keyFile);
      const hal = await messageIdOf(HELD);
      // An erasure started while a sync holds the lock exits 1 with sync_running and leaves no
      // journal line.
      const before = (await readJournal(journal)).seq;
      const syncing = await holding(store.urls.writer, [
        "select pg_advisory_lock(hashtext('intelligence personal sync'))",
      ]);
      expect(await pi(["erase", "item", hal], adminEnv())).toEqual({ exit: 1, stdout: "", stderr: SYNC_RUNNING });
      await syncing.release();
      expect((await readJournal(journal)).seq).toBe(before);

      // A sync started while an erasure's transaction is open answers already_running; a second
      // erasure started then exits 1 with sync_running and leaves no journal line, and run again
      // after the first commits takes the next sequence number.
      const rowLock = await holding(
        store.urls.admin,
        ["begin", "select 1 from knowledge.messages where id = $1 for update"],
        [[], [hal]],
      );
      const first = pi(["erase", "item", hal], adminEnv());
      await waitingOnLock(store);
      expect(await (writer ?? openWriter()).withSyncLock(async () => "ran")).toBe("already_running");
      const other = await messageIdOf(SOURCE_DELETED);
      expect(await pi(["erase", "item", other], adminEnv())).toEqual({ exit: 1, stdout: "", stderr: SYNC_RUNNING });
      expect((await readJournal(journal)).seq).toBe(before);
      await rowLock.release();
      expect((await first).exit).toBe(0);
      expect((await readJournal(journal)).seq).toBe(before + 1);
      // The sync runs once the erasure has committed.
      expect(await (writer ?? openWriter()).withSyncLock(async () => "ran")).toBe("ran");
    },
    LONG,
  );

  it(
    "X7: after a restore, an item the source deleted since the backup is gone before the read hold is lifted",
    async () => {
      const dee = await messageIdOf(SOURCE_DELETED);
      const deeCard = await cardCiting(dee);
      await closeWriter();
      const backup = await copyOf(store);
      restored.push(backup);
      // The source deletes the message after the backup was taken.
      gmail.deletePermanently(SOURCE_DELETED.id);
      store = backup;
      // The restored store still holds it.
      expect(await evidenceOf(SOURCE_DELETED)).toHaveLength(1);
      // The replay, then one full sync, and nothing read in between: no `pi mcp` is started.
      expect((await pi(["erase", "replay"], adminEnv())).exit).toBe(0);
      await sync(["gmail"]);
      expect(await evidenceOf(SOURCE_DELETED)).toEqual([]);
      expect(where(await scanForPlaintext(store.urls.admin, ["canary-source-deleted-3b9e"]))).toEqual([]);
      expect(
        await rows(
          "select tainted_at is not null as tainted, body_enc is null as emptied from ledger.cards where id = $1",
          [deeCard],
        ),
      ).toEqual([{ tainted: true, emptied: true }]);
    },
    LONG,
  );
});
