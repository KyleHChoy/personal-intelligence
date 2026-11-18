import { createHash, randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  CaptureWork,
  type CardId,
  CUT_NO_APP,
  type EntityId,
  type ForgetItem,
  MIRROR_QUOTA,
  type MomentItem,
  type NewCard,
  QUOTA_DEFAULTS,
  TASK_FUTURE_MS,
  type TaskItem,
  WORK_CATCH_UP,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { activityTable, attributeCheck, captureWorkOf, lineCount } from "@intelligence/personal-core/lens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { titleFpsMemo } from "../core/capture-pages.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import type { CaptureCounts } from "../lens/capture-drain.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { storeSeeder } from "../test-support/world.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// The drain's half of work time. The drain seals each stored block day split, moment and task's own
// fields in knowledge.captures.work_enc (core's captureWorkOf, under the row's label, bound to its
// row as facts_enc is); a block day's cut entries take their scope rule's compartment; tasks come
// behind the device's switch, as the owner's word only; a block day that grows taints nothing; and
// the catch-up fills rows stored before work time was captured from their blobs and current facts,
// oldest first. One database for the file, with `own` and `employer:example`; the device `mac` made
// by hand with its four source accounts, and a second device `pad` for the task count. Reserved
// domains, test bundles and `~/test` paths only; every refusal has its control. No model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The real clock, to the minute, so the database's clock and the items' agree.
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
// A time `offset` from T, as Lens writes one: with the Mac's local offset of -05:00.
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (at: number): string => new Date(at).toISOString();
// Noon UTC of the day `back` days before today's: a task event's day whatever the zone's offset.
const noonBack = (back: number): number => Math.floor(T / DAY) * DAY - back * DAY + 12 * HOUR;

const EDIT = { bundle: "test.example.edit", name: "Edit" };
const WORK = { bundle: "test.example.work", name: "Work" };
const BROWSE = { bundle: "test.example.browse", name: "Browse" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const UNSCOPED = { bundle: "test.example.unscoped", name: "Unscoped" };
// A coding editor in the category table, so a block's category word is not the default.
const EDITOR = { bundle: "com.microsoft.VSCode", name: "Editor" };
const DOCS_HOST = "docs.example.org";

// The strings no work_enc may hold: accounts, addresses and mentions, and a title canary.
const BLOCK_ACCOUNT = "kestrel.block@example.org";
const CUT_ACCOUNT = "kestrel.cut@example.org";
const MOMENT_ACCOUNT = "kestrel.chat@example.org";
const DEVON = { name: "Devon Harborly", address: "devon.harborly@example.org" };
const ROBIN = { name: "Robin Keelson", address: "robin.keelson@example.org" };
const CANARY = "canary-wtd-title heron lamp 5c1e";
const TABLE = activityTable();

type Device = {
  name: string;
  capture: string;
  token: string;
  accounts: { blocks: string; activity: string; tasks: string };
};
type CaptureRow = {
  id: string;
  evidence_id: string;
  capture_key: string;
  revision: number;
  kind: string;
  started_at: Date;
  ended_at: Date;
  minutes: string | null;
  compartments: string[];
  work_enc: unknown;
  facts_enc: unknown;
};

let store: TestStore;
let writer: Writer;
let owner: Admin;
let mac: Device;
let pad: Device;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, sql, values);

// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "moment" | "block" | "task" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JWT1${String((keys += 1)).padStart(20, "0")}`;
let batches = 0;
const batch = (): string => `work-drain-${String((batches += 1)).padStart(4, "0")}`;

// A device as `pi lens add NAME` makes it from WT1.3 on, by hand: its capture and mirror clients,
// its policy.lens_devices row, and its four source accounts, `lens_tasks` among them.
async function addDevice(name: string): Promise<Device> {
  const capture = { id: testId("cli"), token: `pit_test-${name}-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await admin(insert, [
    capture.id,
    `${name}-capture`,
    sha256Hex(capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirror,
    name,
    sha256Hex(`pit_test-${name}-${randomBytes(8).toString("hex")}`),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
    name,
    capture.id,
    mirror,
  ]);
  const accounts = { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc"), tasks: testId("acc") };
  for (const [id, connector, kind] of [
    [accounts.meetings, "lens_meetings", "transcript"],
    [accounts.activity, "lens_activity", "screen_activity"],
    [accounts.blocks, "lens_blocks", "time_block"],
    [accounts.tasks, "lens_tasks", "owner_task"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
      [id, `device:${name}`, connector, kind],
    );
  }
  return {
    name,
    capture: capture.id,
    token: capture.token,
    accounts: { blocks: accounts.blocks, activity: accounts.activity, tasks: accounts.tasks },
  };
}

type Outcome = { key: string; outcome: string; code?: string | undefined };
async function pushed(items: CaptureItem[], device: Device = mac): Promise<Outcome[]> {
  const answer = await store.reader.pushCapture(device.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  return answer.ok ? answer.value.items : [];
}
async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  for (const item of await pushed(items, device))
    expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}
const drain = (): Promise<CaptureCounts> => writer.takeCapture();

const rowsOf = (key: string): Promise<CaptureRow[]> =>
  admin<CaptureRow>(
    `select id, evidence_id, capture_key, revision, kind, started_at, ended_at, minutes::text as minutes, compartments, work_enc, facts_enc
     from knowledge.captures where capture_key = $1 order by compartments`,
    [key],
  );
const rowOf = async (key: string): Promise<CaptureRow> => one(await rowsOf(key));
// A split of a block day by its compartment.
const splitOf = async (key: string, compartment: string): Promise<CaptureRow> =>
  one((await rowsOf(key)).filter((row) => row.compartments.join(",") === compartment));

// The row's work_enc, opened as facts_enc is: under the row's label, bound to its row and column.
const workOf = (row: CaptureRow): unknown => {
  if (row.work_enc === null) return null;
  return JSON.parse(
    openUnder(
      store.db.keys,
      row.compartments,
      { table: "knowledge.captures", id: row.id, column: "work_enc" },
      row.work_enc as never,
    ),
  );
};
const workText = (row: CaptureRow): string => JSON.stringify(workOf(row));
const factsText = (row: CaptureRow): string =>
  openUnder(
    store.db.keys,
    row.compartments,
    { table: "knowledge.captures", id: row.id, column: "facts_enc" },
    row.facts_enc as never,
  );

// The evidence row and its blob, as the block and moment tests read them.
const keyFp = (value: string): string => fingerprint(store.db.keys, "source_id", value);
const evidenceOf = async (account: string, sourceItem: string) =>
  one(
    await admin<{ id: string; source_kind: string; compartments: string[]; blob_ref: string | null }>(
      "select id, source_kind, compartments, blob_ref from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 and payload_state = 'present'",
      [account, keyFp(sourceItem)],
    ),
  );
async function blobText(account: string, sourceItem: string): Promise<string> {
  const row = await evidenceOf(account, sourceItem);
  const blob = one(
    await admin<{ envelope: unknown }>("select envelope from vault.evidence_blobs where blob_ref = $1", [row.blob_ref]),
  );
  return Buffer.from(
    openUnder(
      store.db.keys,
      row.compartments,
      { table: "vault.evidence_blobs", id: row.blob_ref ?? "", column: "envelope" },
      blob.envelope as never,
    ),
    "base64",
  ).toString("utf8");
}

const tally = (counts: Record<string, number> | undefined): number =>
  Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0);

// Items of these tests.
type Block = BlockItem["blocks"][number];
const block = (
  app: { bundle: string; name: string },
  from: number,
  minutes: number,
  more: Partial<Block> = {},
): Block => ({
  start: local(from),
  end: local(from + minutes * MINUTE),
  minutes,
  app,
  ...more,
});
const blockDay = (blocks: Block[], over: Partial<BlockItem> = {}): BlockItem => ({
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: local(blocks[0] === undefined ? -2 * DAY : Date.parse(blocks[0].start) - T).slice(0, 10),
  blocks,
  ...over,
});
const moment = (from: number, over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(from),
  endedAt: local(from + 2 * MINUTE),
  app: CHAT,
  window: "Harbor planning",
  account: MOMENT_ACCOUNT,
  entity: "chat",
  thread: "Harbor planning",
  participants: [DEVON, ROBIN],
  text: "The rota moves to Thursday.\n--\nBring the second lamp 2\n\n",
  read: "ax",
  ...over,
});
const task = (events: TaskItem["events"], over: Partial<TaskItem> = {}): TaskItem => ({
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title: "Call the harbor office back",
  project: "Harbor",
  events,
  ...over,
});
const created = (at: number): TaskItem["events"][number] => ({ kind: "created", at: utc(at) });

// What the drain seals for one stored item, by core's own function: titles as their `anchor`-kind
// fingerprints, with each title's name fingerprints, as capture-pages' titleSeal gives them.
const titles = {
  fp: (key: string): string => fingerprint(store.db.keys, "anchor", key),
  names: (title: string): string[] => titleFpsMemo(store.db.keys)(title),
};
const blockWork = (day: BlockItem, blocks: Block[], cut: NonNullable<BlockItem["cut"]> = []) =>
  captureWorkOf({ ...day, blocks, cut }, { table: TABLE, titles }).work;
const momentWork = (item: MomentItem) =>
  captureWorkOf(item, { table: TABLE, facts: { bundle: item.app.bundle, thread: item.thread ?? null }, titles }).work;
const taskWork = (item: TaskItem) => captureWorkOf(item, { table: TABLE }).work;

async function cardOn(row: CaptureRow): Promise<CardId> {
  const card = testId("crd") as CardId;
  await owner.cards.raiseCard({
    id: card,
    requestId: testId("req"),
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target: null,
    refs: [],
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a card about a block day",
    bodyFrom: "code",
  } as NewCard);
  await session(store.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query("alter table ledger.basis no force row level security");
    await query(
      "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments) values ('card', $1, 'capture', $2, $3, 'source', false, '{own}')",
      [card, row.id, row.evidence_id],
    );
    await query("alter table ledger.basis force row level security");
    await query("commit");
  });
  return card;
}
const tainted = async (card: CardId): Promise<boolean> =>
  one(
    await admin<{ tainted: boolean }>("select tainted_at is not null as tainted from ledger.basis where row_id = $1", [
      card,
    ]),
  ).tainted;

// An inbox row written straight as pi_owner, as an item past the push's own checks would leave it:
// sealed under `own`, bound to its row, its fingerprints as the push computes them.
async function insertInbox(item: TaskItem, device: Device = mac): Promise<string> {
  const id = testId("cin");
  const json = canonicalJson(item);
  const sha = createHash("sha256").update(json, "utf8").digest("hex");
  const sessionId = one(
    await admin<{ session_id: string }>(
      "select session_id from ledger.capture_inbox where client_id = $1 order by received_at limit 1",
      [device.capture],
    ),
  ).session_id;
  await session(store.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(
      `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, scope_fps, content_fp, body_bytes, received_at, compartments, body_enc)
       values ($1, $2, $3, 'direct-batch', $4, $5, 'task', '{}', $6, $7, now(), '{own}', $8)`,
      [
        id,
        device.capture,
        sessionId,
        keyFp(item.key),
        item.revision,
        fingerprint(store.db.keys, "content_hash", sha),
        Buffer.byteLength(json, "utf8"),
        JSON.stringify(sealRow(store.db.keys, "own", { table: "ledger.capture_inbox", id, column: "body_enc" }, json)),
      ],
    );
    await query("commit");
  });
  return id;
}

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"], writer: false });
  // The writer and the owner's admin with the erasure journal, as `pi sync` and `pi erase` run them.
  writer = createWriter({
    url: store.db.urls.writer,
    keys: store.db.keys,
    log: store.log,
    journal: journalPath(store.db.keyFile),
  });
  owner = createAdmin({
    url: store.db.urls.admin,
    keys: store.db.keys,
    log: store.log,
    journal: journalPath(store.db.keyFile),
  });
  // The owner's accounts, so the owner entity exists and a moment's mentions resolve.
  await connect(writer);
  mac = await addDevice("mac");
  pad = await addDevice("pad");
  await store.admin.lens.addScope({ match: "bundle", value: EDIT.bundle, compartment: "own", kinds: ["block"] });
  await store.admin.lens.addScope({ match: "bundle", value: EDITOR.bundle, compartment: "own", kinds: ["block"] });
  await store.admin.lens.addScope({
    match: "bundle",
    value: WORK.bundle,
    compartment: "employer:example",
    kinds: ["block"],
  });
  await store.admin.lens.addScope({ match: "host", value: DOCS_HOST, compartment: "own", kinds: ["block"] });
  await store.admin.lens.addScope({ match: "bundle", value: CHAT.bundle, compartment: "own", kinds: ["moment"] });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await owner?.close();
  await writer?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("work_enc at drain", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  // One editor block with every attribute kind: a strong repository and document, a weak folder in
  // the title, a weak prompt mention; and one block whose two attributes fail the check.
  const TITLE = "harbor — Editor";
  const kept = block(EDITOR, -40 * HOUR, 25, {
    title: TITLE,
    repository: { value: "forge.example.org/kestrel/harbor-tools", method: "git_remote", v: 1 },
    document: {
      value: "~/test/harbor/notes.md",
      method: "ax_document",
      ref: "moment:01JWT1000000000000000000ZZ",
      v: 2,
    },
    folder: { value: "~/test/harbor", method: "window_title_path", v: 1 },
  });
  const mentioned = block(EDITOR, -40 * HOUR + 30 * MINUTE, 10, {
    title: TITLE,
    repository: { value: "forge.example.org/kestrel/other-tools", method: "prompt_mention", v: 1 },
  });
  const refusing = block(EDITOR, -40 * HOUR + 45 * MINUTE, 5, {
    title: TITLE,
    // Not a whole segment of the title, and a document too short to be anything but generic.
    folder: { value: "~/test/lantern", method: "window_title_path", v: 1 },
    document: { value: "~/Documents", method: "ax_document", v: 1 },
  });
  const plain = block(EDIT, -40 * HOUR + 55 * MINUTE, 5, { title: "Scratch" });

  it("the box checks every attribute: a good one of each method is kept with its method and no version or ref, and a failing one is left out of work_enc and counted attribute_refused by method; the block keeps its time", async () => {
    // The fixture says what it means to: core's check keeps and refuses these.
    expect(attributeCheck("folder", { value: "~/test/harbor", method: "window_title_path" }, TITLE)).toBe(true);
    expect(attributeCheck("folder", { value: "~/test/lantern", method: "window_title_path" }, TITLE)).toBe(false);
    expect(attributeCheck("document", { value: "~/Documents", method: "ax_document" }, TITLE)).toBe(false);
    const day = blockDay([kept, mentioned, refusing, plain]);
    await push([day]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    expect(counts.attributeRefused).toMatchObject({ window_title_path: 1, ax_document: 1 });
    expect(tally(counts.attributeRefused)).toBe(2);
    const work = workOf(await splitOf(day.key, "own"));
    expect(CaptureWork.parse(work)).toEqual(work);
    expect(work).toEqual(blockWork(day, [kept, mentioned, refusing, plain]));
    const blocks = (work as Extract<CaptureWork, { kind: "block" }>).blocks;
    expect(blocks.map((one_) => one_.minutes)).toEqual([25, 10, 5, 5]);
    expect(blocks[0]).toMatchObject({
      repository: { value: "forge.example.org/kestrel/harbor-tools", method: "git_remote" },
      document: { value: "~/test/harbor/notes.md", method: "ax_document" },
      folder: { value: "~/test/harbor", method: "window_title_path" },
    });
    expect(blocks[0]?.document).toEqual({ value: "~/test/harbor/notes.md", method: "ax_document" });
    expect(blocks[1]?.repository).toEqual({ value: "forge.example.org/kestrel/other-tools", method: "prompt_mention" });
    // The refused attributes are absent; the block that held them keeps its time and place.
    expect(blocks[2]).toMatchObject({ minutes: 5, bundle: EDITOR.bundle });
    expect(blocks[2]?.folder).toBeUndefined();
    expect(blocks[2]?.document).toBeUndefined();
    // The control: a day whose attributes all pass refuses none.
    const clean = blockDay([
      block(EDITOR, -39 * HOUR, 10, {
        title: TITLE,
        folder: { value: "~/test/harbor", method: "window_title_path", v: 1 },
      }),
    ]);
    await push([clean]);
    const after = await drain();
    expect(after).toMatchObject({ taken: 1, failed: 0 });
    expect(tally(after.attributeRefused)).toBe(0);
    expect(workOf(await splitOf(clean.key, "own"))).toEqual(blockWork(clean, clean.blocks));
  });

  it("unattributed time keeps its place: the drain sets each block's category word from the category table over its raw fields", async () => {
    const day = blockDay([
      block(EDITOR, -38 * HOUR, 15),
      block(EDIT, -38 * HOUR + 20 * MINUTE, 15),
      block(BROWSE, -38 * HOUR + 40 * MINUTE, 15, { host: DOCS_HOST }),
    ]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const work = workOf(await splitOf(day.key, "own")) as Extract<CaptureWork, { kind: "block" }>;
    expect(work).toEqual(blockWork(day, day.blocks));
    // The editor is the table's coding word; a test bundle is the table's default, not null.
    expect(work.blocks[0]?.category).toBe("coding");
    expect(work.blocks[1]?.category).toBe("other");
    expect(work.blocks[2]).toMatchObject({ bundle: BROWSE.bundle, host: DOCS_HOST });
  });

  it("a moment's new lines are the lines of its text that hold a letter or a digit, stored with its bundle and thread from its CaptureFacts", async () => {
    const item = moment(-37 * HOUR);
    await push([item]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const work = workOf(await rowOf(item.key));
    expect(work).toEqual({
      kind: "moment",
      bundle: CHAT.bundle,
      thread: "Harbor planning",
      lines: lineCount(item.text),
      threadFps: ["title:harbor", "title:harbor planning"].map(titles.fp),
    });
    expect(work).toEqual(momentWork(item));
    expect(lineCount(item.text)).toBe(2);
    // A moment with no thread seals a null one.
    const bare = moment(-37 * HOUR + 10 * MINUTE, { thread: undefined, text: "One line." });
    delete (bare as { thread?: string }).thread;
    await push([bare]);
    await drain();
    expect(workOf(await rowOf(bare.key))).toEqual({ kind: "moment", bundle: CHAT.bundle, thread: null, lines: 1 });
  });

  it("no work_enc holds an account, address or mention: neither a block's account nor a moment's account or participants", async () => {
    const day = blockDay([block(EDIT, -37 * HOUR + 30 * MINUTE, 10, { account: BLOCK_ACCOUNT })]);
    const item = moment(-37 * HOUR + 45 * MINUTE, { thread: "Rota check" });
    await push([day, item]);
    expect(await drain()).toMatchObject({ taken: 2, failed: 0 });
    const rows = await admin<CaptureRow>(
      "select id, evidence_id, capture_key, revision, kind, started_at, ended_at, null as minutes, compartments, work_enc, facts_enc from knowledge.captures where work_enc is not null",
    );
    expect(rows.map((row) => row.capture_key)).toEqual(expect.arrayContaining([day.key, item.key]));
    for (const row of rows) {
      const text = workText(row);
      for (const gone of [
        BLOCK_ACCOUNT,
        CUT_ACCOUNT,
        MOMENT_ACCOUNT,
        DEVON.address,
        DEVON.name,
        ROBIN.address,
        ROBIN.name,
      ])
        expect(text, `${row.capture_key} ${gone}`).not.toContain(gone);
    }
    // The control: the moment's own facts hold its account and participants, and the block's blob its account.
    const facts = factsText(await rowOf(item.key));
    expect(facts).toContain(MOMENT_ACCOUNT);
    expect(facts).toContain(DEVON.address);
    expect(await blobText(mac.accounts.blocks, `${day.key}#own`)).toContain(BLOCK_ACCOUNT);
  });

  it("WT14: a canary in a block title reaches no work_enc, and is in the block's own evidence", async () => {
    const day = blockDay([block(EDIT, -37 * HOUR + 50 * MINUTE, 5, { title: CANARY })]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    expect(workOf(await splitOf(day.key, "own"))).toEqual(blockWork(day, day.blocks));
    const rows = await admin<CaptureRow>(
      "select id, evidence_id, capture_key, revision, kind, started_at, ended_at, null as minutes, compartments, work_enc, facts_enc from knowledge.captures where work_enc is not null",
    );
    for (const row of rows) expect(workText(row), row.capture_key).not.toContain(CANARY);
    // The control: the title reached the block's blob.
    expect(await blobText(mac.accounts.blocks, `${day.key}#own`)).toContain(CANARY);
  });
});

describe("a block day's cut", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a cut entry takes its scope rule's compartment and one no rule admits is dropped; each split's work_enc.cut holds that split's totals", async () => {
    const own = block(EDIT, -36 * HOUR, 20, { account: BLOCK_ACCOUNT });
    const work = block(WORK, -36 * HOUR + 30 * MINUTE, 20);
    const browse = block(BROWSE, -36 * HOUR + 60 * MINUTE, 10, { host: DOCS_HOST });
    const cut = [
      { app: EDIT.bundle, account: CUT_ACCOUNT, blocks: 3, minutes: 4.5 },
      { app: BROWSE.bundle, host: DOCS_HOST, blocks: 1, minutes: 2 },
      { app: WORK.bundle, blocks: 2, minutes: 6 },
      { app: UNSCOPED.bundle, blocks: 7, minutes: 9 },
    ];
    const day = blockDay([own, work, browse], { cut });
    await push([day]);
    expect(await drain()).toMatchObject({ failed: 0 });
    const ownSplit = await splitOf(day.key, "own");
    const workSplit = await splitOf(day.key, "employer:example");
    expect(workOf(ownSplit)).toEqual(blockWork(day, [own, browse], [cut[0], cut[1]] as typeof cut));
    expect(workOf(workSplit)).toEqual(blockWork(day, [work], [cut[2]] as typeof cut));
    expect((workOf(ownSplit) as Extract<CaptureWork, { kind: "block" }>).cut).toEqual({ blocks: 4, minutes: 6.5 });
    // An own split never holds an employer's cuts, nor the dropped entry's.
    expect((workOf(workSplit) as Extract<CaptureWork, { kind: "block" }>).cut).toEqual({ blocks: 2, minutes: 6 });
    // No cut's account crosses.
    expect(workText(ownSplit)).not.toContain(CUT_ACCOUNT);
    // The control: a block day with no cut seals a cut of zero.
    const none = blockDay([block(EDIT, -35 * HOUR, 5)]);
    await push([none]);
    await drain();
    expect((workOf(await splitOf(none.key, "own")) as Extract<CaptureWork, { kind: "block" }>).cut).toEqual({
      blocks: 0,
      minutes: 0,
    });
  });

  it("an entry no rule could admit is unfiled on the first split, by reason, with every compartment it could be under, and stays out of the blob; an ordinary entry no rule admits is still dropped", async () => {
    const own = block(EDIT, -33 * HOUR, 20);
    const cut = [
      { app: "com.google.Chrome", host: "docs.google.com", blocks: 2, minutes: 40.5 },
      { app: "com.google.Chrome", blocks: 1, minutes: 5 },
      { app: CUT_NO_APP, blocks: 1, minutes: 3 },
      { app: UNSCOPED.bundle, blocks: 7, minutes: 9 },
    ];
    const day = blockDay([own], { cut });
    await push([day]);
    expect(await drain()).toMatchObject({ failed: 0, dropped: { cut_dropped: 1 } });
    const split = await splitOf(day.key, "own");
    const work = workOf(split) as Extract<CaptureWork, { kind: "block" }>;
    expect(work.cut).toEqual({
      blocks: 0,
      minutes: 0,
      unfiled: {
        among: ["employer:example", "own"],
        reasons: {
          no_account: { blocks: 2, minutes: 40.5 },
          no_host: { blocks: 1, minutes: 5 },
          no_app: { blocks: 1, minutes: 3 },
        },
      },
    });
    expect(await blobText(mac.accounts.blocks, `${day.key}#own`)).not.toContain("docs.google.com");
  });

  it("a day whose entries are all filed has no unfiled count, and a docs block with its account is stored under the rule naming it", async () => {
    await store.admin.lens.addScope({
      match: "host",
      value: "docs.google.com",
      account: BLOCK_ACCOUNT,
      compartment: "employer:example",
      kinds: ["block"],
    });
    const docs = block({ bundle: "at.studio.AsideBrowser", name: "Aside" }, -32 * HOUR, 20, {
      host: "docs.google.com",
      account: BLOCK_ACCOUNT,
    });
    const day = blockDay([docs]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const split = await splitOf(day.key, "employer:example");
    expect(split.compartments).toEqual(["employer:example"]);
    expect((workOf(split) as Extract<CaptureWork, { kind: "block" }>).cut.unfiled).toBeUndefined();
  });
});

describe("a block day that grows", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a block day that grows taints nothing; one that drops a block, or changes one, taints what cited the earlier revision", async () => {
    const first = block(EDIT, -34 * HOUR, 20, {
      title: "Morning",
      repository: { value: "forge.example.org/kestrel/harbor-tools", method: "git_remote", v: 1 },
    });
    const second = block(EDIT, -34 * HOUR + 30 * MINUTE, 10, { title: "Afternoon" });
    const noon = blockDay([first]);
    await push([noon]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const noonRow = await splitOf(noon.key, "own");
    const readNoon = await cardOn(noonRow);

    // The midnight revision holds every block of the noon one, and one more.
    const midnight: BlockItem = { ...noon, revision: 1, blocks: [first, second] };
    await push([midnight]);
    expect(await drain()).toMatchObject({
      replaced: 1,
      failed: 0,
      blockRevisions: { grown: 1, changed: 0, tainted: 0 },
    });
    expect(await tainted(readNoon)).toBe(false);
    const midnightRow = await splitOf(noon.key, "own");
    expect(midnightRow).toMatchObject({ id: noonRow.id, revision: 1 });
    expect(midnightRow.evidence_id).not.toBe(noonRow.evidence_id);
    expect(workOf(midnightRow)).toEqual(blockWork(midnight, [first, second]));

    // The control: a revision that drops a block taints what read the one before.
    const readMidnight = await cardOn(midnightRow);
    const dropped: BlockItem = { ...noon, revision: 2, blocks: [second] };
    await push([dropped]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0, blockRevisions: { grown: 0, changed: 1 } });
    expect(await tainted(readMidnight)).toBe(true);
    expect(workOf(await splitOf(noon.key, "own"))).toEqual(blockWork(dropped, [second]));

    // And one that changes a block, its start and end kept, taints too.
    const readDropped = await cardOn(await splitOf(noon.key, "own"));
    const changed: BlockItem = { ...noon, revision: 3, blocks: [{ ...second, minutes: 9.5 }] };
    await push([changed]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(readDropped)).toBe(true);
  });
});

describe("today's block day each hour", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("hourly revisions whose tail grew taint nothing across more than two revisions, and a change before the tail still does", async () => {
    const settled = block(EDIT, -30 * HOUR, 20, {
      title: "Morning",
      repository: { value: "forge.example.org/kestrel/harbor-tools", method: "git_remote", v: 1 },
    });
    const tail = block(EDIT, -30 * HOUR + 30 * MINUTE, 10, { title: "On screen" });
    const hour1 = blockDay([settled, tail]);
    await push([hour1]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const read1 = await cardOn(await splitOf(hour1.key, "own"));

    // The block on screen at the hour ran on, under a new longest window.
    const grown = block(EDIT, -30 * HOUR + 30 * MINUTE, 50, { title: "Longer window" });
    const hour2: BlockItem = { ...hour1, revision: 1, blocks: [settled, grown] };
    await push([hour2]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(read1)).toBe(false);
    const read2 = await cardOn(await splitOf(hour1.key, "own"));

    // The third revision, whose earlier revisions have lost their blobs, with a later block, and
    // a moment's key that came for an attribute.
    const late = block(EDIT, -30 * HOUR + 90 * MINUTE, 5, { title: "Short visit" });
    const withRef = { ...settled, repository: { ...settled.repository, ref: keyOf("moment") } } as Block;
    const hour3: BlockItem = { ...hour1, revision: 2, blocks: [withRef, grown, late] };
    await push([hour3]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(read2)).toBe(false);
    const read3 = await cardOn(await splitOf(hour1.key, "own"));

    // A short visit at the tail folds into the block that reaches past it.
    const folded = block(EDIT, -30 * HOUR + 30 * MINUTE, 80, { title: "Longer window" });
    const hour4: BlockItem = { ...hour1, revision: 3, blocks: [withRef, folded] };
    await push([hour4]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(read3)).toBe(false);
    expect(await splitOf(hour1.key, "own")).toMatchObject({ revision: 3 });

    // The control: a block before the tail changed taints, whatever the tail did.
    const read4 = await cardOn(await splitOf(hour1.key, "own"));
    const hour5: BlockItem = { ...hour1, revision: 4, blocks: [{ ...withRef, title: "Renamed" }, folded] };
    await push([hour5]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(read4)).toBe(true);

    // And so does a tail that shrank.
    const read5 = await cardOn(await splitOf(hour1.key, "own"));
    const shrunk = block(EDIT, -30 * HOUR + 30 * MINUTE, 70, { title: "Longer window" });
    const hour6: BlockItem = { ...hour1, revision: 5, blocks: [{ ...withRef, title: "Renamed" }, shrunk] };
    await push([hour6]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect(await tainted(read5)).toBe(true);

    // A fold that loses minutes, or that takes another app's place, is no growth.
    const earliest = block(EDIT, -28 * HOUR, 20, { title: "First" });
    const short = block(EDIT, -28 * HOUR + 20 * MINUTE, 15, { title: "Second" });
    const two = blockDay([earliest, short]);
    await push([two]);
    await drain();
    const readTwo = await cardOn(await splitOf(two.key, "own"));
    const lost = { ...block(EDIT, -28 * HOUR, 25, { title: "First" }), end: short.end };
    await push([{ ...two, revision: 1, blocks: [lost] }]);
    await drain();
    expect(await tainted(readTwo)).toBe(true);
    const readLost = await cardOn(await splitOf(two.key, "own"));
    const elsewhere = block(EDITOR, -28 * HOUR, 40, { title: "First" });
    await push([{ ...two, revision: 2, blocks: [elsewhere] }]);
    await drain();
    expect(await tainted(readLost)).toBe(true);
  });
});

describe("the owner's tasks", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a device's tasks are refused out_of_scope at push unless the owner's switch is on, and taken once it is", async () => {
    const early = task([created(T - 3 * HOUR)]);
    expect(await pushed([early])).toEqual([{ key: early.key, outcome: "refused", code: "out_of_scope" }]);
    expect(await drain()).toMatchObject({ taken: 0, failed: 0 });
    expect(await rowsOf(early.key)).toEqual([]);
    // The control: with `pi lens tasks mac on` the same task is accepted and stored.
    await owner.lens.setDeviceTasks("mac", true);
    expect(one(await admin<{ tasks: boolean }>("select tasks from policy.lens_devices where name = 'mac'"))).toEqual({
      tasks: true,
    });
    expect(await pushed([early])).toEqual([{ key: early.key, outcome: "accepted" }]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    expect(await rowsOf(early.key)).toHaveLength(1);
  });

  it("a task is the owner's word only from the owner's own gesture: one without byOwner true is dropped not_owner at drain, and one with it is stored", async () => {
    const absent = task([created(T - 3 * HOUR)]);
    delete (absent as { byOwner?: boolean }).byOwner;
    const unmarked = task([created(T - 3 * HOUR)], { byOwner: false });
    const marked = task([created(T - 3 * HOUR)]);
    await push([absent, unmarked, marked]);
    const counts = await drain();
    expect(counts.dropped.not_owner).toBe(2);
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    expect(await rowsOf(absent.key)).toEqual([]);
    expect(await rowsOf(unmarked.key)).toEqual([]);
    expect(await rowsOf(marked.key)).toHaveLength(1);
  });

  it("a task is read from its item: stored under own, kind task, started at its created event and ended at its latest, no minutes, its fields sealed in work_enc and no text in facts_enc", async () => {
    const at = T - 5 * HOUR;
    const item = task(
      [created(at), { kind: "edited", at: utc(at + 10 * MINUTE) }, { kind: "completed", at: utc(at + 40 * MINUTE) }],
      { doneAt: utc(at + 30 * MINUTE) },
    );
    await push([item]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const row = await rowOf(item.key);
    expect(row).toMatchObject({ kind: "task", compartments: ["own"], revision: 0, minutes: null });
    expect(row.started_at.toISOString()).toBe(utc(at));
    expect(row.ended_at.toISOString()).toBe(utc(at + 40 * MINUTE));
    const work = workOf(row);
    expect(CaptureWork.parse(work)).toEqual(work);
    expect(work).toEqual(taskWork(item));
    expect(work).toEqual({
      kind: "task",
      title: item.title,
      project: "Harbor",
      events: item.events,
      doneAt: utc(at + 30 * MINUTE),
    });
    // Its facts hold no text of it.
    const facts = factsText(row);
    expect(facts).not.toContain(item.title);
    expect(facts).not.toContain("Harbor");
    // Its evidence is the device's owner_task account's, under own.
    expect(await evidenceOf(mac.accounts.tasks, item.key)).toMatchObject({
      id: row.evidence_id,
      source_kind: "owner_task",
      compartments: ["own"],
    });
  });

  it("transitions are kept apart: events out of order, or not starting with created, are dropped bad_events at drain", async () => {
    const at = T - 6 * HOUR;
    const backwards = task([created(at), { kind: "completed", at: utc(at - 10 * MINUTE) }]);
    const headless = task([
      { kind: "edited", at: utc(at) },
      { kind: "completed", at: utc(at + MINUTE) },
    ]);
    const twice = task([created(at), created(at + MINUTE)]);
    const good = task([
      created(at),
      { kind: "completed", at: utc(at + MINUTE) },
      { kind: "reopened", at: utc(at + 2 * MINUTE) },
    ]);
    // The push refuses each out-of-order task whole (WT0's contract half); the drain's own check
    // is reached by an inbox row written past the push.
    const refused = await store.reader.pushCapture(mac.token, { batch: batch(), items: [backwards] });
    expect(refused).toEqual({ ok: false, code: "invalid_request" });
    for (const item of [backwards, headless, twice, good]) await insertInbox(item);
    const counts = await drain();
    expect(counts.dropped.bad_events).toBe(3);
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    for (const item of [backwards, headless, twice]) expect(await rowsOf(item.key), item.key).toEqual([]);
    // The control: the ordered one, reopened, is stored with its events.
    expect(workOf(await rowOf(good.key))).toEqual(taskWork(good));
  });

  it("the drain drops a task future_time whose any time is more than five minutes after its push", async () => {
    const now = Date.now();
    const late = task([created(now + TASK_FUTURE_MS + 5 * MINUTE)]);
    const lateDone = task([created(now - HOUR), { kind: "completed", at: utc(now - 30 * MINUTE) }], {
      doneAt: utc(now + TASK_FUTURE_MS + 5 * MINUTE),
    });
    const lateEvent = task([created(now - HOUR), { kind: "edited", at: utc(now + TASK_FUTURE_MS + 5 * MINUTE) }]);
    // The control: a time within the five minutes, the clocks' skew, is kept.
    const near = task([created(now - HOUR), { kind: "edited", at: utc(now + TASK_FUTURE_MS - 3 * MINUTE) }]);
    await push([late, lateDone, lateEvent, near]);
    const counts = await drain();
    expect(counts.dropped.future_time).toBe(3);
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    for (const item of [late, lateDone, lateEvent]) expect(await rowsOf(item.key), item.key).toEqual([]);
    expect(workOf(await rowOf(near.key))).toEqual(taskWork(near));
  });

  it("an edit, completion or reopening is a new revision, replacing the task's row and its work_enc", async () => {
    const at = T - 7 * HOUR;
    const first = task([created(at)]);
    await push([first]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const before = await rowOf(first.key);
    const next: TaskItem = {
      ...first,
      revision: 1,
      title: "Call the harbor office back, then write it up",
      events: [
        ...first.events,
        { kind: "edited", at: utc(at + 5 * MINUTE) },
        { kind: "completed", at: utc(at + 20 * MINUTE) },
      ],
    };
    await push([next]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    const after = await rowOf(first.key);
    expect(after).toMatchObject({ id: before.id, revision: 1 });
    expect(after.evidence_id).not.toBe(before.evidence_id);
    expect(after.ended_at.toISOString()).toBe(utc(at + 20 * MINUTE));
    expect(workOf(after)).toEqual(taskWork(next));
  });

  it("a delete on the desktop sends a forget naming the key, which pi erase settle applies; pi erase item cap_ removes one too", async () => {
    const at = T - 8 * HOUR;
    const [gone, erased, kept] = [task([created(at)]), task([created(at + MINUTE)]), task([created(at + 2 * MINUTE)])];
    await push([gone, erased, kept]);
    expect(await drain()).toMatchObject({ taken: 3, failed: 0 });
    const notice: ForgetItem = { kind: "forget", key: keyOf("forget"), keys: [gone.key] };
    await push([notice]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect(await rowsOf(gone.key)).toEqual([]);
    expect(
      (
        await owner.erasure.eraseItem(
          { kind: "capture", id: (await rowOf(erased.key)).id as CaptureId },
          { requestId: testId("req") },
        )
      ).items,
    ).toBe(1);
    expect(await rowsOf(erased.key)).toEqual([]);
    // The control: the task neither named is still stored.
    expect(await rowsOf(kept.key)).toHaveLength(1);
  });

  it("a device added before 0079 lacks a lens_tasks account: its tasks are refused while the switch is off, a forget naming a task settles and makes the account, and the switch keeps it", async () => {
    const old = await addDevice("old");
    await admin("delete from vault.source_accounts where id = $1", [old.accounts.tasks]);
    const tasksAccounts = () =>
      admin<{ id: string }>(
        "select id from vault.source_accounts where label = 'device:old' and connector = 'lens_tasks'",
      );
    const early = task([created(T - 9 * HOUR)]);
    expect(await pushed([early], old)).toEqual([{ key: early.key, outcome: "refused", code: "out_of_scope" }]);
    expect(await drain()).toMatchObject({ failed: 0 });
    // A delete on the desktop of a task never stored, beside a block key: it settles, not waits.
    await push([{ kind: "forget", key: keyOf("forget"), keys: [early.key, keyOf("block")] } satisfies ForgetItem], old);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    const [made] = await tasksAccounts();
    expect(made).toBeDefined();
    expect(
      one(
        await admin<{ n: number }>(
          "select count(*)::int as n from knowledge.removed_evidence where source_account_id = $1",
          [made?.id],
        ),
      ),
    ).toEqual({ n: 1 });
    // The switch keeps the one account, and a task is then taken under it.
    await owner.lens.setDeviceTasks("old", true);
    expect(await tasksAccounts()).toEqual([made]);
    const later = task([created(T - 9 * HOUR + MINUTE)]);
    await push([later], old);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    expect(
      one(
        await admin<{ account: string }>(
          "select source_account_id as account from knowledge.captures where capture_key = $1",
          [later.key],
        ),
      ),
    ).toEqual({ account: made?.id });
    // The forgotten task stays forgotten under the account the forget made.
    await push([early], old);
    expect((await drain()).dropped).toMatchObject({ removed: 1 });
    expect(await rowsOf(early.key)).toEqual([]);
  });

  it("pi status counts each device's task events a day: the events of its stored tasks, by the day they were recorded on", async () => {
    await owner.lens.setDeviceTasks("pad", true);
    const yesterday = noonBack(1);
    const before = noonBack(2);
    const three = task([
      created(yesterday),
      { kind: "edited", at: utc(yesterday + 10 * MINUTE) },
      { kind: "completed", at: utc(yesterday + 20 * MINUTE) },
    ]);
    const single = task([created(before)]);
    // Dropped not_owner, so never counted.
    const unmarked = task([created(yesterday), { kind: "completed", at: utc(yesterday + MINUTE) }], { byOwner: false });
    await push([three, single, unmarked], pad);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 2, failed: 0 });
    const view = (await store.admin.lens.devices()).find((device) => device.name === "pad");
    const days = (view?.taskEvents ?? []).filter((one_) => one_.count > 0).sort((a, b) => a.day.localeCompare(b.day));
    expect(days).toEqual([
      { day: utc(before).slice(0, 10), count: 1 },
      { day: utc(yesterday).slice(0, 10), count: 3 },
    ]);
    // The control: the count is the device's own: mac, whose tasks are all of the last hours, counts
    // none on pad's earlier day, and counts its own.
    const macView = (await store.admin.lens.devices()).find((device) => device.name === "mac");
    expect(macView?.taskEvents?.find((one_) => one_.day === utc(before).slice(0, 10))?.count ?? 0).toBe(0);
    expect(
      tally(Object.fromEntries((macView?.taskEvents ?? []).map((one_) => [one_.day, one_.count]))),
    ).toBeGreaterThan(0);
  });
});

describe("the catch-up of rows stored before WT1", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const blank = (ids: string[]) => admin("update knowledge.captures set work_enc = null where id = any($1)", [ids]);

  it("rows stored with work_enc null are filled by catchUpWork from their blobs, at most limit a call, oldest first", async () => {
    const day = blockDay([
      block(EDITOR, -60 * HOUR, 30, {
        title: "harbor — Editor",
        folder: { value: "~/test/harbor", method: "window_title_path", v: 1 },
      }),
      block(EDIT, -60 * HOUR + 40 * MINUTE, 10),
    ]);
    const older = moment(-59 * HOUR, { text: "First line\nSecond line\nThird line" });
    const newer = moment(-58 * HOUR, { text: "Only one line" });
    // Each pushed and drained in turn, so each is older than the next by every clock it has.
    for (const item of [day, older, newer]) {
      await push([item]);
      expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    }
    const rows = [await splitOf(day.key, "own"), await rowOf(older.key), await rowOf(newer.key)];
    const sealed = rows.map((row) => workOf(row));
    expect(sealed).toEqual([blockWork(day, day.blocks), momentWork(older), momentWork(newer)]);
    await blank(rows.map((row) => row.id));
    for (const row of rows)
      expect(
        (await admin<{ work_enc: unknown }>("select work_enc from knowledge.captures where id = $1", [row.id]))[0]
          ?.work_enc,
      ).toBeNull();

    // Two a call: the block day and the older moment first.
    expect(await writer.catchUpWork(2)).toEqual({ filled: 2 });
    expect(workOf(await splitOf(day.key, "own"))).toEqual(sealed[0]);
    expect(workOf(await rowOf(older.key))).toEqual(sealed[1]);
    expect(workOf(await rowOf(newer.key))).toBeNull();
    // Then the rest, within WORK_CATCH_UP, and then nothing is left.
    const rest = await writer.catchUpWork();
    expect(rest).toEqual({ filled: 1 });
    expect(rest.filled).toBeLessThanOrEqual(WORK_CATCH_UP);
    expect(workOf(await rowOf(newer.key))).toEqual(sealed[2]);
    expect(await writer.catchUpWork()).toEqual({ filled: 0 });
    // A filled row is sealed as the drain seals one: bound to its row, under its label.
    expect(CaptureWork.parse(workOf(await rowOf(newer.key)))).toEqual(sealed[2]);
  });

  it("a person erased while a row's work_enc is null is not restored by the catch-up: a moment's bundle and thread come from its current facts", async () => {
    const item = moment(-57 * HOUR, { thread: "Lamp rota", text: "Lamp rota for the week" });
    await push([item]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const row = await rowOf(item.key);
    await blank([row.id]);
    // A moment's participant makes nobody; Devon is a person by Devon's mail, as a sync makes one.
    await storeSeeder(writer, new Date()).mail((await connect(writer)).personalMail, {
      id: "wtd-drain-devon",
      from: DEVON,
      to: [{ address: OWNER.personal, name: OWNER.name }],
      at: new Date(local(-60 * HOUR)),
      subject: "Lamp rota",
    });
    const devon = one(
      await admin<{ entity_id: string }>("select distinct entity_id from knowledge.accounts where value_fp = $1", [
        fingerprint(store.db.keys, "address", DEVON.address),
      ]),
    ).entity_id as EntityId;
    await owner.erasure.erasePerson(devon, { requestId: testId("req") });
    // The erasure cleared Devon from the row's facts and kept Robin.
    const facts = factsText(await rowOf(item.key));
    expect(facts).not.toContain(DEVON.address);
    expect(facts).toContain(ROBIN.address);

    expect(await writer.catchUpWork()).toEqual({ filled: 1 });
    const filled = await rowOf(item.key);
    expect(workOf(filled)).toEqual({
      kind: "moment",
      bundle: CHAT.bundle,
      thread: "Lamp rota",
      lines: 1,
      threadFps: ["title:lamp", "title:lamp rota"].map(titles.fp),
    });
    for (const gone of [DEVON.address, DEVON.name, ROBIN.address, ROBIN.name, MOMENT_ACCOUNT])
      expect(workText(filled), gone).not.toContain(gone);
    // The control: the vault blob keeps the original, mention and all, and the catch-up read it
    // only for the line count.
    expect(await blobText(mac.accounts.activity, item.key)).toContain(DEVON.address);
    expect(await writer.catchUpWork()).toEqual({ filled: 0 });
  });
});
