import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawItem } from "@intelligence/contracts";
import { type ClaimRecord, isCoded } from "@intelligence/contracts/personal";
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
import { correspondentsOf, HIDDEN_ONLY, hiddenWorld, type World, world } from "@intelligence/personal-core/testing";
import pg from "pg";
import { Admin } from "../admin/admin.ts";
import { MAX_COMPARTMENTS } from "../admin/admin-base.ts";
import { parseDatabaseUrl } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { migrationsHash } from "../core/migrate.ts";
import { sealUnder } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { session } from "./connections.ts";
import { copyTestDatabase, createTestDatabase, queryAs, serverUrl, type TestDatabase } from "./database.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";
import { outcomeValue, registration } from "./values.ts";

// Invariant 6's world pair for the reader. One database: the base world is stored through the
// writer and the pipeline, a viewer cleared for `own` alone is registered, and later its hidden
// twin's rows (hiddenWorld, under employer:example only) are added to the same database, through
// the same writer and pipeline, with claims a second clearance reads and the agent records of a
// client cleared for both. The two worlds are one database before and after, not two databases:
// entity ids are random (ids.ts) and several of the viewer's orders end in an entity id, so two
// databases of one world would not answer alike, and no renaming of ids can mend an order. Before
// and after, every row the viewer can see is the same row.

const ID = /\b[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g;
// A reply as compared with `other`, the reply it is compared with: an id both hold is one row in
// each and stays as it is, so two such rows that swap places compare unequal; an id only it holds
// (one a call mints, or the hidden or absent id asked) is renamed by order of first appearance;
// each time is made one.
export const normal = (reply: string, other: string): string => {
  const theirs = new Set(other.match(ID) ?? []);
  const seen = new Map<string, string>();
  return reply
    .replace(ID, (id) => {
      if (theirs.has(id)) return id;
      if (!seen.has(id)) seen.set(id, `id${seen.size + 1}`);
      return seen.get(id) as string;
    })
    .replace(TIME, "time");
};

export const INV6_NOW = new Date("2026-06-15T12:00:00.000Z");
export const HIDDEN = "employer:example";
// The client cleared for both compartments, whose agent records are under its own as well.
const WIDE = "alpha";
const RECORDS_PER_DAY = 200;
const INV6_COMPARTMENTS = ["own", HIDDEN, `agent:${WIDE}`];
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
  "build_context_pack",
  "get_commitments",
  "get_open_items",
];
const VIEWS = ["self", "people", "work"];
// The asks a transcript runs at once, and the reader's connections.
export const AT_ONCE = 6;
// The writers and pipelines that build a template's hidden twin at once (openInv6): its items
// are independent once the warm-up has made every person, domain and account (ingestWorld).
// Each item waits mostly on its round trips, so more builders than cores still gain.
const BUILDERS = 16;
// The visible facts of the base world: claims on this many of its own messages.
const VISIBLE_FACTS = 12;
// Every client's daily read budgets, set by the owner at registration: the most the bounds allow
// (ClientQuota), as read-gate.db.test.ts gives its clients. The same in both worlds, whose asks are the same,
// so no ask is refused by a quota in one and not in the other. The minute budget is lifted past its bound
// below.
const BUDGET = { maxItemsDay: 100_000, maxCharsDay: 100_000_000, maxRowsDay: 1_000_000, maxCallsMinute: 600 };

// One phase of a slow run, timed, its seconds written to stderr: a label and a number, nothing else.
export async function timed<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    process.stderr.write(`inv6 phase: ${phase} ${((performance.now() - start) / 1000).toFixed(1)} s\n`);
  }
}

export type Inv6 = {
  store: TestStore;
  base: World;
  owner: string;
  // The viewer's token: a client cleared for `own` alone, with every read tool.
  viewer: string;
  // The token of a client cleared for own and employer:example, with record.
  wide: string;
  // The token of a client cleared for ten compartments, none of them employer:example: a smaller
  // clearance to time the cap's cost against (capTimings).
  ten: string;
  cap: string;
  pipeline: Pipeline;
  close(): Promise<void>;
};

// The world, stored as `pi sync` stores it (as owner-preconditions.db.test.ts does): what the
// owner sent first, drafts and junk left out, a conditional message only when the owner wrote to
// its sender or in its thread, an item the writer refuses for good skipped. With `only`, just
// the items whose Gmail or Calendar id it holds.
// With more than one writer, each kind of item in turn (what the owner sent, the rest, the
// meetings) is shared among them, each item in its own transaction as one writer stores it:
// the first `warm` items of each kind one at a time, so that every person, domain and account
// row is made by one transaction and no two make the same one, and the rest at once. The rows
// are those one writer stores; only their ids, which are random, and their order on disk differ.
async function ingestWorld(writers: readonly Writer[], w: World, only?: ReadonlySet<string>, warm = 0): Promise<void> {
  const [writer] = writers;
  if (writer === undefined) throw new Error("ingestWorld: no writer");
  for (const account of w.accounts) {
    const mail = await writer.ensureSourceAccount(account.label, "google_mail", account.compartment, account.address);
    const calendar = await writer.ensureSourceAccount(
      account.label,
      "google_calendar",
      account.compartment,
      account.address,
    );
    const messages = account.messages.filter((message: GmailMessage) => only === undefined || only.has(message.id));
    const raws = messages
      .map((message) => gmailItem(message, { sourceAccount: mail.id, changeKind: "backfill" }))
      .filter((raw) => !isDraft(raw) && !isJunk(raw));
    const message = async (one: Writer, raw: RawItem): Promise<void> => {
      if (isConditional(raw)) {
        const wrote = await one.ownerWrote(mail, {
          ...(raw.sender === undefined ? {} : { sender: raw.sender }),
          ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
        });
        if (!wrote.sender && !wrote.thread) return;
      }
      await ingest(one, mail, raw);
    };
    await inTurn(writers, raws.filter(ownerSent), warm, message);
    await inTurn(
      writers,
      raws.filter((one) => !ownerSent(one)),
      warm,
      message,
    );
    const items = account.events
      .filter((event) => only === undefined || only.has(event.id))
      .map((event) => calendarItem(event, { sourceAccount: calendar.id, changeKind: "backfill", now: w.now }));
    await inTurn(writers, items, warm, async (one, item) => {
      if ("payload" in item) await ingest(one, calendar, item);
    });
  }
}

// Each item, in order: the first `warm` by the first worker alone, then the rest by every
// worker, each taking the next item when it is free. With one worker, every item in order.
async function inTurn<W, T>(
  workers: readonly W[],
  items: readonly T[],
  warm: number,
  each: (worker: W, item: T) => Promise<void>,
): Promise<void> {
  const [first] = workers;
  if (first === undefined) return;
  let next = workers.length === 1 ? items.length : Math.min(warm, items.length);
  for (const item of items.slice(0, next)) await each(first, item);
  await Promise.all(
    workers.map(async (worker) => {
      for (let at = next++; at < items.length; at = next++) await each(worker, items[at] as T);
    }),
  );
}

async function ingest(writer: Writer, account: Parameters<Writer["ingestItem"]>[0], raw: RawItem): Promise<void> {
  try {
    await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
  } catch (error) {
    if (!isCoded(error)) throw error;
  }
}

export const admin = <Row>(s: Inv6 | TestStore, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(("store" in s ? s.store : s).db.urls.admin, text, values);

// The messages of one label that a viewer of it could be shown, oldest first: their ids and evidence.
const messagesUnder = (s: Inv6, compartment: string) =>
  admin<{ id: string; evidence_id: string }>(
    s,
    "select id, evidence_id from knowledge.messages where compartments = $1::text[] and not held order by sent_at, id",
    [[compartment]],
  );

// The people a viewer cleared for `own` sees: each with an account under `own`.
export const visiblePeople = (s: Inv6) =>
  admin<{ id: string }>(
    s,
    `select distinct a.entity_id as id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
     where e.kind = 'person' and a.compartments <@ '{own}'::text[] order by 1`,
  ).then((rows) => rows.map((row) => row.id));

// Commitments under `compartment`, one on each message given, naming the people given in turn
// (claim_entities); a belief of each is computed when asked. Each commit is its own transaction,
// shared among the pipelines given (the world's own first) as inTurn shares items.
async function commitFacts(
  s: Inv6,
  messages: { evidence_id: string }[],
  compartment: string,
  people: string[],
  tag: string,
  pipelines: readonly Pipeline[] = [s.pipeline],
): Promise<void> {
  const records = messages.map((message, index) => {
    const person = people[index % people.length];
    return claimRecord(message.evidence_id, compartment, s.owner, {
      factKey: `k-${tag}-${index}`,
      entities: person === undefined ? [] : [person],
      validFrom: new Date(INV6_NOW.getTime() - (index + 1) * 3_600_000).toISOString(),
    });
  });
  await inTurn(pipelines, [...records.keys()], 0, async (pipeline, index) => {
    const evidence = (messages[index] as { evidence_id: string }).evidence_id;
    if ((await pipeline.commit(batchOf(evidence, [records[index] as ClaimRecord]))) !== "committed")
      throw new Error("a commit was refused");
  });
}

// The base world, stored, with its visible facts, the viewer and the wide client; with `hidden`,
// with addHidden's twin of that many rows per table added as well. Each is built once and kept as
// a template database (worldTemplate), and this is a copy of it, so its ids, tokens and rows are
// those of every other copy: the base world's asks are asked of the hidden world's copy alike.
export async function openInv6(hidden = 0): Promise<Inv6> {
  const base = await worldTemplate("base", async () => {
    const db = await createTestDatabase({ compartments: INV6_COMPARTMENTS });
    try {
      return { db, made: await timed("build base", () => populate(db)) };
    } catch (error) {
      await db.drop().catch(() => {});
      throw error;
    }
  });
  const source =
    hidden === 0
      ? base
      : await worldTemplate(`hidden${hidden}`, async () => {
          const db = await copyTestDatabase(base.db);
          const s = inv6On(db, base.made);
          try {
            await timed(`build hidden${hidden}`, () => addHidden(s, hidden, BUILDERS));
            await s.end();
            return { db, made: base.made };
          } catch (error) {
            await s.close().catch(() => {});
            throw error;
          }
        });
  return inv6On(await copyTestDatabase(source.db), source.made);
}

// What a world's build made that its rows do not say: the clients' tokens and the owner's id.
type Made = { owner: string; viewer: string; wide: string; ten: string; cap: string };

// A world on a database: the store as openStore opens one, and the pipeline. `end` closes every
// connection and keeps the database; `close` drops it too.
function inv6On(db: TestDatabase, made: Made): Inv6 & { end(): Promise<void> } {
  const log = eventLogger();
  const clock = { now: () => INV6_NOW };
  // A connection timeout, so a client that was never released fails the next call and does not hang it.
  const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2, connectionTimeoutMillis: 20_000 });
  const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: AT_ONCE, connectionTimeoutMillis: 20_000 });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  const end = async (): Promise<void> => {
    for (const one of [() => pipeline.close(), () => writer.close(), () => readerPool.end(), () => adminPool.end()])
      await one().catch(() => {});
  };
  const store: TestStore = {
    db,
    log,
    now: INV6_NOW,
    adminPool,
    readerPool,
    admin: new Admin({ pool: adminPool, keys: db.keys, log, ...clock }),
    reader: new Reader({ pool: readerPool, keys: db.keys, log, ...clock }),
    writer,
    close: async () => {
      await end();
      await db.drop();
    },
  };
  return { store, base: world({ now: INV6_NOW }), ...made, pipeline, close: store.close, end };
}

// The base world's rows: the world through the writer, the three clients, the visible facts.
async function populate(db: TestDatabase): Promise<Made> {
  const s = inv6On(db, { owner: "", viewer: "", wide: "", ten: "", cap: "" });
  try {
    await ingestWorld([s.store.writer], s.base);
    const [owner] = await admin<{ id: string }>(s, "select id from knowledge.entities where kind = 'owner'");
    if (owner === undefined) throw new Error("the world has no owner");
    // An admin that may register a client with record.
    const registrar = new Admin({ pool: s.store.adminPool, keys: db.keys, log: s.store.log, recordEnabled: true });
    const { token: viewer } = await registrar.clients.addClient(
      registration("viewer", ["own"], { tools: TOOLS as never, views: VIEWS as never, quota: BUDGET }),
    );
    const { token: wide } = await registrar.clients.addClient(
      registration(WIDE, ["own", HIDDEN], {
        tools: [...TOOLS, "record"] as never,
        views: VIEWS as never,
        quota: BUDGET,
      }),
    );
    // The two cleared for many compartments: own, the wide client's, and agents' that hold nothing.
    const cleared = (n: number) => [
      "own",
      `agent:${WIDE}`,
      ...Array.from({ length: n - 2 }, (_, index) => `agent:c${index + 1}`),
    ];
    const { token: ten } = await registrar.clients.addClient(
      registration("ten", cleared(10), { tools: TOOLS as never, views: VIEWS as never, quota: BUDGET }),
    );
    const { token: cap } = await registrar.clients.addClient(
      registration("cap", cleared(MAX_COMPARTMENTS), { tools: TOOLS as never, views: VIEWS as never, quota: BUDGET }),
    );
    // A transcript sends thousands of asks a minute, past the most max_calls_minute may be, so in
    // this test database only, which is dropped after it, the check is dropped and every client's
    // minute budget lifted, once, before either world is asked anything: the same for both worlds.
    await session(db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query("alter table policy.clients drop constraint clients_max_calls_minute");
      await query("alter table policy.clients no force row level security");
      await query("update policy.clients set max_calls_minute = 1000000000");
      await query("alter table policy.clients force row level security");
    });
    const made = { owner: owner.id, viewer, wide, ten, cap };
    Object.assign(s, made);
    const own = (await messagesUnder(s, "own")).slice(0, VISIBLE_FACTS);
    await commitFacts(s, own, "own", await visiblePeople(s), "own");
    await settle(s);
    return made;
  } finally {
    await s.end();
  }
}

// ---------------------------------------------------------------------------------------------
// The worlds kept as template databases
// ---------------------------------------------------------------------------------------------

// A world's template, pi_wld_<time, base 36>_<16 hex>_<label>, where the hex is of the
// migrations (migrationsHash, as database.ts keys its migrated template) and of the code that
// builds the world: this file and the synthetic world's. Its key file and what its build made are
// kept beside it, in WORLDS. Writer, pipeline or derive code that changes the rows a world holds
// without a migration does not change the key: such a change is seen once the next migration
// lands, or at once by dropping the templates (or WORLDS).
const WORLDS = join(tmpdir(), "pi-hidden-rows-worlds");
const WORLD = /^pi_wld_([0-9a-z]+)_([0-9a-f]{16})_([a-z0-9]+)$/;
const HOUR_MS = 60 * 60 * 1000;
const WORLD_CODE = [
  "./hidden-rows-world.ts",
  "../../../core/src/test-support/world.ts",
  "../../../core/src/test-support/hidden-world.ts",
  "../../../core/src/test-support/people.ts",
  "../../../core/src/test-support/gmail.ts",
  "../../../core/src/test-support/calendar.ts",
];

async function worldKey(): Promise<string> {
  const hash = createHash("sha256").update(await migrationsHash());
  for (const file of WORLD_CODE) hash.update(await readFile(new URL(file, import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

type Template = { db: TestDatabase; made: Made };
const templates = new Map<string, Promise<Template>>();

// The template of one world, found or built once per process, one build at a time across runs
// under a lock. `build` returns its database with every connection closed; it is renamed to the
// template. Another key's template over an hour old is dropped, with its folder.
function worldTemplate(label: string, build: () => Promise<Template>): Promise<Template> {
  let found = templates.get(label);
  if (found === undefined) {
    found = findOrBuild(label, build);
    templates.set(label, found);
    found.catch(() => templates.delete(label));
  }
  return found;
}

async function findOrBuild(label: string, build: () => Promise<Template>): Promise<Template> {
  const key = await worldKey();
  const server = serverUrl();
  const client = new pg.Client({ connectionString: parseDatabaseUrl(server).href });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('intelligence personal inv6 worlds'))");
    const { rows } = await client.query<{ name: string }>(
      "select datname as name from pg_database where datname like 'pi\\_wld\\_%'",
    );
    let name: string | undefined;
    for (const row of rows) {
      const parts = WORLD.exec(row.name);
      if (parts?.[1] === undefined) continue;
      if (parts[2] === key && parts[3] === label) name = row.name;
      else if (parts[2] !== key && Date.now() - Number.parseInt(parts[1], 36) > HOUR_MS) {
        await client.query(`drop database if exists ${pg.escapeIdentifier(row.name)}`).catch(() => {});
        await rm(join(WORLDS, row.name), { recursive: true, force: true });
      }
    }
    if (name !== undefined) {
      const kept = await readFile(join(WORLDS, name, "made.json"), "utf8").catch(() => undefined);
      if (kept !== undefined) return { db: templateDb(server, name), made: JSON.parse(kept) as Made };
      // Its folder is gone (a cleared temporary folder): built again.
      await client.query(`drop database if exists ${pg.escapeIdentifier(name)}`);
    }
    const built = await build();
    const template = `pi_wld_${Date.now().toString(36)}_${key}_${label}`;
    try {
      await mkdir(join(WORLDS, template), { recursive: true });
      await copyFile(built.db.keyFile, join(WORLDS, template, "keys.json"));
      await client.query(
        `alter database ${pg.escapeIdentifier(built.db.name)} rename to ${pg.escapeIdentifier(template)}`,
      );
      await writeFile(join(WORLDS, template, "made.json"), JSON.stringify(built.made));
    } catch (error) {
      await built.db.drop().catch(() => {});
      throw error;
    } finally {
      // The build's own key folder; the database is the template's now.
      await built.db.drop().catch(() => {});
    }
    return { db: templateDb(server, template), made: built.made };
  } finally {
    await client.end();
  }
}

// A template as copyTestDatabase reads a source: its name and its key file. It is never opened.
const templateDb = (server: string, name: string): TestDatabase => ({
  name,
  urls: { bootstrap: server.replace(/\/postgres$/, `/${name}`) } as TestDatabase["urls"],
  keys: undefined as never,
  keyFile: join(WORLDS, name, "keys.json"),
  drop: async () => {},
});

// What the hidden twin added, for the asks only it can be asked.
export type HiddenAdded = { messages: string[]; events: string[]; entities: string[] };

// The hidden twin's rows, under employer:example only: its mail and meetings through the
// writer, a commitment on each new message naming a person the viewer sees, a belief of each
// for the audience of both compartments, and `perTable` agent records of the wide client. With
// `builders` above one, that many writers store the items and that many pipelines commit the
// facts at once (ingestWorld, commitFacts). The twin names each of its people within its first
// that many items of each kind (hiddenWorld), so those go first, one at a time.
export async function addHidden(s: Inv6, perTable: number, builders = 1): Promise<HiddenAdded> {
  const before = {
    messages: new Set((await admin<{ id: string }>(s, "select id from knowledge.messages")).map((row) => row.id)),
    events: new Set((await admin<{ id: string }>(s, "select id from knowledge.events")).map((row) => row.id)),
    entities: new Set((await admin<{ id: string }>(s, "select id from knowledge.entities")).map((row) => row.id)),
  };
  const twin = hiddenWorld(s.base, { compartment: HIDDEN, perTable });
  const added = new Set<string>();
  for (const [index, account] of twin.accounts.entries()) {
    const was = s.base.accounts[index];
    for (const message of account.messages.slice(was?.messages.length ?? 0)) added.add(message.id);
    for (const event of account.events.slice(was?.events.length ?? 0)) added.add(event.id);
  }
  const writers = [
    s.store.writer,
    ...Array.from({ length: builders - 1 }, () =>
      createWriter({ url: s.store.db.urls.writer, keys: s.store.db.keys, log: s.store.log }),
    ),
  ];
  const pipelines = [
    s.pipeline,
    ...Array.from({ length: builders - 1 }, () =>
      createPipeline({ url: s.store.db.urls.pipeline, keys: s.store.db.keys, log: recordingLogger().log }),
    ),
  ];
  let messages: { id: string; evidence_id: string }[];
  try {
    const people = correspondentsOf(s.base).length + HIDDEN_ONLY.length;
    await timed(`hidden${perTable} ingest`, () => ingestWorld(writers, twin, added, people));
    messages = (await messagesUnder(s, HIDDEN)).filter((row) => !before.messages.has(row.id));
    const visible = await visiblePeople(s);
    await timed(`hidden${perTable} facts`, () => commitFacts(s, messages, HIDDEN, visible, "hidden", pipelines));
  } finally {
    for (const one of [...writers.slice(1), ...pipelines.slice(1)]) await one.close().catch(() => {});
  }
  const recordsStart = performance.now();
  // A client may append 200 records in 24 hours: the first through the reader, the rest as
  // append_record stores them, written as pi_owner under the first's session, client and label,
  // each sealed as the reader seals one, and dated a day back so they leave the client its limit
  // (the transcript test records 20 more).
  const throughReader = Math.min(perTable, RECORDS_PER_DAY - 20);
  for (let k = 0; k < throughReader; k += 1) {
    outcomeValue(
      await s.store.reader.record(s.wide, {
        kind: k % 2 === 0 ? "note" : "finding",
        body: `Hidden record ${k}.`,
        requestId: `inv6-hidden-${String(k).padStart(8, "0")}`,
      }),
    );
  }
  if (perTable > throughReader) {
    const [first] = await admin<{
      client_id: string;
      client_name: string;
      session_id: string;
      compartments: string[];
      writer_views: string[];
    }>(
      s.store,
      "select client_id, client_name, session_id, compartments, writer_views from ledger.agent_writes where request_id = $1",
      ["inv6-hidden-00000000"],
    );
    if (first === undefined) throw new Error("the wide client's first record is not stored");
    await session(s.store.db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      for (let k = throughReader; k < perTable; k += 1) {
        const id = newId("rec");
        const body = `Hidden record ${k}.`;
        await query(
          `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc, created_at)
           values ($1, $2, $3, $4, $5, 'record', $6, $7, $8, $9, $10, '{}', $11, now() - interval '25 hours')`,
          [
            id,
            first.client_id,
            first.client_name,
            first.session_id,
            `inv6-hidden-${String(k).padStart(8, "0")}`,
            k % 2 === 0 ? "note" : "finding",
            first.compartments,
            first.writer_views,
            fingerprint(s.store.db.keys, "content_hash", createHash("sha256").update(body, "utf8").digest("hex")),
            fingerprint(s.store.db.keys, "cites", ""),
            JSON.stringify(
              sealUnder(
                s.store.db.keys,
                first.compartments,
                { table: "ledger.agent_writes", id, column: "body_enc" },
                body,
              ),
            ),
          ],
        );
      }
      await query("commit");
    });
  }
  process.stderr.write(
    `inv6 phase: hidden${perTable} records ${((performance.now() - recordsStart) / 1000).toFixed(1)} s\n`,
  );
  await timed(`hidden${perTable} settle`, () => settle(s));
  return {
    messages: messages.map((row) => row.id),
    events: (await admin<{ id: string }>(s, "select id from knowledge.events order by id"))
      .map((row) => row.id)
      .filter((id) => !before.events.has(id)),
    entities: (
      await admin<{ id: string }>(
        s,
        "select id from knowledge.entities where kind in ('person', 'organization') order by id",
      )
    )
      .map((row) => row.id)
      .filter((id) => !before.entities.has(id)),
  };
}

// Statistics and visibility bits brought up to date, so the planner and the buffers see the
// rows as they are. The tables' owner runs it.
export async function settle(s: Inv6): Promise<void> {
  await session(s.store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("vacuum (analyze)");
  });
}
