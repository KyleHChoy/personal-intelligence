import { randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureItem,
  CaptureWork,
  type EntityId,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openUnder, sealUnder } from "../core/seal.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { tampering } from "../test-support/tamper.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { capturesErasure } from "./capture-erasure.ts";

// The window title anchor, end to end in the store. Reserved domains and test bundles only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE - 6 * HOUR;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const WRITER = { bundle: "test.example.writer", name: "Writer" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const WORK = { bundle: "test.example.work", name: "Work" };
// The title canary: a block's title no sealed column, list or log may hold as text.
const CANARY = "Heron canary plan 7d2f";

let store: TestStore;
let token: string;
const P: Record<"heron" | "harbor" | "lantern", EntityId> = {} as never;
const request = () => ({ requestId: testId("req") });
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, sql, values);
const titleFp = (title: string): string => fingerprint(store.db.keys, "anchor", `title:${title}`);
// A blob's envelope swapped for another, which the database refuses outside `tampering`.
const swapBlob = (blobRef: string, envelope: unknown): Promise<unknown> =>
  tampering(store.db, () =>
    admin("update vault.evidence_blobs set envelope = $2 where blob_ref = $1", [blobRef, envelope]),
  );

let keys = 0;
const keyOf = <K extends "moment" | "block">(kind: K): `${K}:${string}` =>
  `${kind}:01JWTT${String((keys += 1)).padStart(20, "0")}`;
let batches = 0;
async function push(items: CaptureItem[]): Promise<void> {
  const answer = await store.reader.pushCapture(token, {
    batch: `window-title-${String((batches += 1)).padStart(4, "0")}`,
    items,
  });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok) for (const item of answer.value.items) expect(item.outcome, item.key).toBe("accepted");
  expect(await store.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
}

type Block = BlockItem["blocks"][number];
// `from` and `minutes` in minutes after T.
const block = (app: { bundle: string; name: string }, from: number, minutes: number, title?: string): Block => ({
  start: local(from * MINUTE),
  end: local((from + minutes) * MINUTE),
  minutes,
  app,
  ...(title === undefined ? {} : { title }),
});
const blockDay = (blocks: Block[]): BlockItem => ({
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: local(Date.parse(blocks[0]?.start ?? "") - T).slice(0, 10),
  blocks,
});
const chat = (from: number, minutes: number, thread: string): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(from * MINUTE),
  endedAt: local((from + minutes) * MINUTE),
  app: CHAT,
  window: "Chat",
  entity: "chat",
  thread,
  participants: [],
  text: "A line.",
  read: "ax",
});

type Row = { id: string; compartments: string[]; work_enc: unknown; work_titles: boolean };
const rowOf = async (key: string, compartments = ["own"]): Promise<Row> =>
  one(
    await admin<Row>(
      "select id, compartments, work_enc, work_titles from knowledge.captures where capture_key = $1 and compartments = $2",
      [key, compartments],
    ),
  );
const untitled = (work: CaptureWork): CaptureWork => {
  if (work.kind === "moment") return (({ threadFps: _fps, ...rest }) => rest)(work);
  if (work.kind !== "block") return work;
  const { titles: _titles, ...day } = work;
  return { ...day, blocks: work.blocks.map(({ titleFps: _fps, titleAt: _at, ...rest }) => rest) };
};
const resolved = (work: CaptureWork): unknown => {
  if (work.kind !== "block") return work;
  const { titles, ...day } = work;
  return {
    ...day,
    blocks: work.blocks.map(({ titleAt, ...rest }) =>
      titleAt === undefined ? rest : { ...rest, names: titles?.[titleAt] },
    ),
  };
};
const workOf = (row: Row): CaptureWork =>
  CaptureWork.parse(
    JSON.parse(
      openUnder(
        store.db.keys,
        row.compartments,
        { table: "knowledge.captures", id: row.id, column: "work_enc" },
        row.work_enc as never,
      ),
    ),
  );

const DAY = blockDay([
  block(WRITER, 0, 30, `${CANARY} — Writer`),
  block(CHAT, 60, 60, "Chat"),
  block(WORK, 150, 20, "Ledger close"),
]);
const ROTA = chat(70, 15, "harbor rota");
const SURVEY = chat(95, 10, "Lantern Survey");

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"] });
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await admin(insert, [
    capture.id,
    "mac-capture",
    sha256Hex(capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirror,
    "mac",
    sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
    ["own"],
    ["self"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ('mac', $1, $2)", [
    capture.id,
    mirror,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
    ["lens_tasks", "owner_task"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [testId("acc"), connector, kind],
    );
  }
  token = capture.token;
  await store.admin.lens.addScope({ match: "bundle", value: WRITER.bundle, compartment: "own", kinds: ["block"] });
  await store.admin.lens.addScope({
    match: "bundle",
    value: CHAT.bundle,
    compartment: "own",
    kinds: ["block", "moment"],
  });
  await store.admin.lens.addScope({
    match: "bundle",
    value: WORK.bundle,
    compartment: "employer:example",
    kinds: ["block"],
  });
  P.heron = await store.admin.projects.add("Heron", request());
  P.harbor = await store.admin.projects.add("Harbor", request());
  P.lantern = await store.admin.projects.add("Lantern", request());
  await push([DAY, ROTA, SURVEY]);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("the schema", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a window title anchor is a kind of its own with no value; every other kind keeps its rule", async () => {
    const [kind] = await admin<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'project_anchors_kind'",
    );
    for (const one_ of [
      "email_thread",
      "meeting_series",
      "app",
      "host",
      "url_prefix",
      "repository",
      "document",
      "window_title",
    ])
      expect(kind?.def).toContain(`'${one_}'`);
    const [value] = await admin<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'project_anchors_value'",
    );
    expect(value?.def).toContain("'window_title'");
    expect(value?.def).toContain("'email_thread'");
  });

  it("knowledge.captures.work_titles is false by default and no column pi_reader is granted", async () => {
    const [column] = await admin<{ data_type: string; is_nullable: string; column_default: string }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'knowledge' and table_name = 'captures' and column_name = 'work_titles'",
    );
    expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const granted = await queryAs<{ column_name: string }>(
      store.db.urls.bootstrap,
      "select column_name from information_schema.column_privileges where table_schema = 'knowledge' and table_name = 'captures' and grantee = 'pi_reader' and column_name = 'work_titles'",
    );
    expect(granted).toEqual([]);
  });

  it("knowledge.captures.work_tried_at is null until tried and not pi_reader's; serve_mirror refuses any anchor with no value", async () => {
    const [column] = await admin<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'knowledge' and table_name = 'captures' and column_name = 'work_tried_at'",
    );
    expect(column).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const granted = await queryAs<{ column_name: string }>(
      store.db.urls.bootstrap,
      "select column_name from information_schema.column_privileges where table_schema = 'knowledge' and table_name = 'captures' and grantee = 'pi_reader' and column_name = 'work_tried_at'",
    );
    expect(granted).toEqual([]);
    const [serve] = await admin<{ def: string }>("select pg_get_functiondef('policy.serve_mirror'::regproc) as def");
    expect(serve?.def).toContain("pa.value_enc is null");
    expect(serve?.def).not.toContain("pa.kind = 'email_thread'");
  });
});

describe("the anchor, as pi_admin", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("keeps the title's fingerprint alone, refuses a generic or taken title, lists no value, and lifts", async () => {
    const anchor = await store.admin.projects.anchor(
      P.heron,
      { kind: "window_title", value: "  HERON canary  plan " },
      request(),
    );
    const [row] = await admin<{ kind: string; anchor_fp: string; value_enc: unknown }>(
      "select kind, anchor_fp, value_enc from knowledge.project_anchors where id = $1",
      [anchor],
    );
    expect(row).toEqual({ kind: "window_title", anchor_fp: titleFp("heron canary plan"), value_enc: null });
    // The same title again is the same anchor; on another project it is taken.
    expect(
      await store.admin.projects.anchor(P.heron, { kind: "window_title", value: "Heron Canary Plan" }, request()),
    ).toBe(anchor);
    await expect(
      store.admin.projects.anchor(P.harbor, { kind: "window_title", value: "heron canary plan" }, request()),
    ).rejects.toMatchObject({ code: "anchor_taken" });
    for (const value of ["Claude", "New Tab", "abc"])
      await expect(
        store.admin.projects.anchor(P.harbor, { kind: "window_title", value }, request()),
        value,
      ).rejects.toMatchObject({ code: "generic_anchor" });
    const listed = await store.admin.projects.list();
    const heron = listed.find((one_) => one_.id === P.heron);
    expect(heron?.anchors).toEqual([expect.objectContaining({ id: anchor, kind: "window_title", value: null })]);
    expect(JSON.stringify(listed)).not.toMatch(/canary/i);
    // Lifted and set again, with nothing to re-check.
    expect(await store.admin.projects.unanchor(anchor, request())).toBe(true);
    expect(await store.admin.projects.unanchor(anchor, request())).toBe(false);
    await store.admin.projects.anchor(P.heron, { kind: "window_title", value: "Heron canary plan" }, request());
  });
});

describe("the anchor's lock and a closed project's title", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("sets and lifts a title anchor while an extraction holds the extract lock; a host anchor still waits for it", async () => {
    const owl = await store.admin.projects.add("Owl", request());
    await session(store.db.urls.admin, async (query) => {
      // As a run holds it, on another connection.
      await query("select pg_advisory_lock(hashtext('intelligence personal extract'))");
      try {
        const anchor = await store.admin.projects.anchor(
          owl,
          { kind: "window_title", value: "Owl field notes" },
          request(),
        );
        expect(await store.admin.projects.unanchor(anchor, request())).toBe(true);
        await expect(
          store.admin.projects.anchor(owl, { kind: "host", value: "owl.example.org" }, request()),
        ).rejects.toMatchObject({ code: "extract_running" });
      } finally {
        await query("select pg_advisory_unlock(hashtext('intelligence personal extract'))");
      }
    });
  });

  it("a closed project's live title anchor keeps its title taken, since work time still credits it; lifted, the title is free", async () => {
    const ended = await store.admin.projects.add("Ended plover", request());
    const next = await store.admin.projects.add("Next plover", request());
    const held = await store.admin.projects.anchor(ended, { kind: "window_title", value: "Plover census" }, request());
    expect(await store.admin.projects.close(ended, request())).toBe(true);
    await expect(
      store.admin.projects.anchor(next, { kind: "window_title", value: "plover census" }, request()),
    ).rejects.toMatchObject({ code: "anchor_taken" });
    expect(await store.admin.projects.unanchor(held, request())).toBe(true);
    expect(
      await store.admin.projects.anchor(next, { kind: "window_title", value: "plover census" }, request()),
    ).toMatch(/^pan_/);
  });
});

describe("the drain and the catch-up", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("seals a block's title and a moment's thread title as fingerprints, never as text, and marks the row", async () => {
    const day = await rowOf(DAY.key);
    expect(day.work_titles).toBe(true);
    const work = workOf(day);
    if (work.kind !== "block") throw new Error("a block day");
    expect(work.blocks[0]?.titleFps).toContain(titleFp("heron canary plan"));
    // The title's name fingerprints, once a day at the block's titleAt, so a
    // person's erasure judges it without the blob.
    expect(work.titles?.[work.blocks[0]?.titleAt ?? -1]).toContain(fingerprint(store.db.keys, "name", "heron canary"));
    // A window titled only with its app's name seals none.
    expect(work.blocks[1]?.titleFps).toBeUndefined();
    expect(JSON.stringify(work)).not.toMatch(/canary|heron/i);
    const moment = workOf(await rowOf(ROTA.key));
    expect(moment).toMatchObject({
      kind: "moment",
      thread: "harbor rota",
      threadFps: [titleFp("harbor"), titleFp("harbor rota")],
    });
  });

  it("refills a block day's or a moment's work_enc sealed before 0083, keeping it until then", async () => {
    const day = await rowOf(DAY.key);
    const before = workOf(day);
    if (before.kind !== "block") throw new Error("a block day");
    const older = before.blocks[0]?.category === "media" ? "admin" : "media";
    const bare = untitled(before);
    if (bare.kind !== "block") throw new Error("a block day");
    const stripped = {
      ...bare,
      blocks: bare.blocks.map((one_, at) => (at === 0 ? { ...one_, category: older } : one_)),
    };
    await admin("update knowledge.captures set work_enc = $2, work_titles = false where id = $1", [
      day.id,
      sealUnder(
        store.db.keys,
        day.compartments,
        { table: "knowledge.captures", id: day.id, column: "work_enc" },
        canonicalJson(stripped),
      ),
    ]);
    expect(workOf(await rowOf(DAY.key))).toEqual(stripped);
    expect(await store.writer.catchUpWork()).toEqual({ filled: 1 });
    const refilled = await rowOf(DAY.key);
    expect(refilled.work_titles).toBe(true);
    expect(workOf(refilled)).toEqual({
      ...before,
      blocks: before.blocks.map((one_, at) => (at === 0 ? { ...one_, category: older } : one_)),
    });
    expect(await store.writer.catchUpWork()).toEqual({ filled: 0 });
  });

  it("a row it cannot refill keeps its work_enc and is marked, so it is never chosen again", async () => {
    const day = await rowOf(DAY.key);
    const before = workOf(day);
    if (before.kind !== "block") throw new Error("a block day");
    const reseal = async (work: CaptureWork): Promise<void> => {
      const sealed = sealUnder(
        store.db.keys,
        day.compartments,
        { table: "knowledge.captures", id: day.id, column: "work_enc" },
        canonicalJson(work),
      );
      await admin("update knowledge.captures set work_enc = $2, work_titles = false where id = $1", [day.id, sealed]);
    };
    const plain = untitled(before);
    if (plain.kind !== "block") throw new Error("a block day");
    const bare = plain.blocks;
    // A sealed block is found in the blob by its start, end and app, not by its
    // place, so a day whose blocks are not the blob's in order still gains its titles.
    await reseal({ ...plain, blocks: [...bare].reverse() });
    expect(await store.writer.catchUpWork()).toEqual({ filled: 1 });
    const back = resolved(before) as { blocks: unknown[] };
    expect(resolved(workOf(await rowOf(DAY.key)))).toEqual({ ...back, blocks: [...back.blocks].reverse() });
    // Its blocks no longer the blob's: no title is added, and the row is done.
    const moved = { ...plain, blocks: bare.map((one_) => ({ ...one_, start: local(-MINUTE) })) };
    await reseal(moved);
    expect(await store.writer.catchUpWork()).toEqual({ filled: 0 });
    const after = await rowOf(DAY.key);
    expect(after.work_titles).toBe(true);
    expect(workOf(after)).toEqual(moved);
    // Restored for the read below.
    await admin("update knowledge.captures set work_enc = $2 where id = $1", [
      day.id,
      sealUnder(
        store.db.keys,
        day.compartments,
        { table: "knowledge.captures", id: day.id, column: "work_enc" },
        canonicalJson(before),
      ),
    ]);
  });
});

describe("the catch-up's limit", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("bounds the rows a run tries, not only those it fills: rows that gain no title count against it", async () => {
    // Two days whose one window shows only its app's name: neither gains a title.
    const days = [blockDay([block(CHAT, 240, 5, "Chat")]), blockDay([block(CHAT, 250, 5, "Chat")])];
    await push(days);
    const ids = await Promise.all(days.map(async (one_) => (await rowOf(one_.key)).id));
    await admin("update knowledge.captures set work_titles = false where id = any($1)", [ids]);
    const waiting = async (): Promise<number> =>
      one(
        await admin<{ count: number }>(
          "select count(*)::int as count from knowledge.captures where id = any($1) and not work_titles",
          [ids],
        ),
      ).count;
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 0 });
    expect(await waiting()).toBe(1);
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 0 });
    expect(await waiting()).toBe(0);
  });

  it("a row that cannot be filled holds back no newer one, and one whose blob does not open is not marked done", async () => {
    // Two days, pushed one after the other, so the first is the older.
    const stuck = blockDay([block(WRITER, 260, 5, "Quarry ledger notes")]);
    await push([stuck]);
    const fresh = blockDay([block(WRITER, 270, 5, "Osprey survey notes")]);
    await push([fresh]);
    const [s, f] = [await rowOf(stuck.key), await rowOf(fresh.key)];
    const reseal = (row: Row, work: unknown): Promise<unknown> =>
      admin("update knowledge.captures set work_enc = $2, work_titles = false where id = $1", [
        row.id,
        sealUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.captures", id: row.id, column: "work_enc" },
          canonicalJson(work),
        ),
      ]);
    const freshWork = workOf(f);
    if (freshWork.kind !== "block") throw new Error("a block day");
    const bare = untitled(freshWork);
    // The older one's work_enc no longer parses, so it fails each time it is tried.
    await reseal(s, { kind: "nothing" });
    await reseal(f, bare);
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 0, failed: 1 });
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 1 });
    expect(workOf(await rowOf(fresh.key))).toEqual(freshWork);
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 0, failed: 1 });
    expect((await rowOf(stuck.key)).work_titles).toBe(false);
    await admin("update knowledge.captures set work_enc = $2, work_titles = true where id = $1", [s.id, s.work_enc]);

    // The newer one's blob does not open (here, another blob's envelope under its ref): it keeps
    // its work_enc and stays unfilled, and gains its titles once the blob opens again.
    type Blob = { blob_ref: string; envelope: unknown };
    const blobOf = async (key: string): Promise<Blob> =>
      one(
        await admin<Blob>(
          "select b.blob_ref, b.envelope from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id join vault.evidence_blobs b on b.blob_ref = e.blob_ref where c.capture_key = $1",
          [key],
        ),
      );
    const [mine, other] = [await blobOf(fresh.key), await blobOf(stuck.key)];
    await swapBlob(mine.blob_ref, other.envelope);
    await reseal(f, bare);
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 0 });
    expect(await rowOf(fresh.key)).toMatchObject({ work_titles: false });
    expect(workOf(await rowOf(fresh.key))).toEqual(bare);
    await swapBlob(mine.blob_ref, mine.envelope);
    expect(await store.writer.catchUpWork(1)).toEqual({ filled: 1 });
    expect(workOf(await rowOf(fresh.key))).toEqual(freshWork);
  });
});

describe("the read, as `pi time project` reads it", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("credits a block by its own title, a chat app's block by its threads over their spans and the 10 minutes each holds after, and nothing across compartments", async () => {
    await store.admin.projects.anchor(P.harbor, { kind: "window_title", value: "harbor rota" }, request());
    await store.admin.projects.anchor(P.lantern, { kind: "window_title", value: "Lantern Survey" }, request());
    // An own project's title on the employer block: not within its label, so it credits nothing.
    await store.admin.projects.anchor(P.lantern, { kind: "window_title", value: "Ledger close" }, request());
    const minutes = async (project: EntityId): Promise<number> =>
      Math.round((await store.admin.time.project(project, 7)).time.last7);
    expect(await minutes(P.heron)).toBe(30);
    // The rota thread's 15 and its hold until the survey thread starts, 10; the survey's 10 and its 10.
    expect(await minutes(P.harbor)).toBe(25);
    expect(await minutes(P.lantern)).toBe(20);
  });
});

describe("a person's erasure reaches title fingerprints", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  const ROBIN = "Robin Vale";
  const NAMED = blockDay([
    block(WRITER, 200, 10, `Call with ${ROBIN} re harbor`),
    block(WRITER, 210, 10, "Harbor rota notes"),
  ]);
  // The moment also lists the person's address, so both of the hook's passes
  // change it, and it is counted once.
  const ROBIN_ADDRESS = "robin.vale@example.org";
  const SYNC = { ...chat(205, 5, `${ROBIN} sync`), participants: [{ address: ROBIN_ADDRESS }] };
  const titlesOf = async (): Promise<{ blocks: (string[] | undefined)[]; thread: string[] | undefined }> => {
    const day = workOf(await rowOf(NAMED.key));
    const moment = workOf(await rowOf(SYNC.key));
    return {
      blocks: day.kind === "block" ? day.blocks.map((one_) => one_.titleFps) : [],
      thread: moment.kind === "moment" ? moment.threadFps : undefined,
    };
  };

  it("drops the fingerprints of a title naming the person and keeps the others; the catch-up and a new revision never make them again", async () => {
    await push([NAMED, SYNC]);
    const before = await titlesOf();
    expect(before.blocks[0]).toContain(titleFp(`call with ${ROBIN.toLowerCase()} re harbor`));
    expect(before.blocks[1]).toContain(titleFp("harbor rota notes"));
    expect(before.thread).toContain(titleFp(`${ROBIN.toLowerCase()} sync`));

    // A day that does not name the person keeps its titles' fingerprints and is
    // not counted, even with its sealed blocks not in the blob's order.
    const other = await rowOf(DAY.key);
    const otherWork = workOf(other);
    if (otherWork.kind !== "block") throw new Error("a block day");
    const reordered = { ...otherWork, blocks: [...otherWork.blocks].reverse() };
    await admin("update knowledge.captures set work_enc = $2 where id = $1", [
      other.id,
      sealUnder(
        store.db.keys,
        other.compartments,
        { table: "knowledge.captures", id: other.id, column: "work_enc" },
        canonicalJson(reordered),
      ),
    ]);
    // The erasure reads no blob, so a day whose blob does not open (here,
    // another day's envelope under its ref) keeps its titles' fingerprints too.
    type Blob = { blob_ref: string; envelope: unknown };
    const blobOf = async (key: string): Promise<Blob> =>
      one(
        await admin<Blob>(
          "select b.blob_ref, b.envelope from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id join vault.evidence_blobs b on b.blob_ref = e.blob_ref where c.capture_key = $1 and c.compartments = '{own}'",
          [key],
        ),
      );
    const [mine, theirs] = [await blobOf(DAY.key), await blobOf(NAMED.key)];
    await swapBlob(mine.blob_ref, theirs.envelope);

    const erased = {
      evidenceIds: [],
      refs: [],
      addressFps: [fingerprint(store.db.keys, "address", ROBIN_ADDRESS)],
      nameFps: [fingerprint(store.db.keys, "name", ROBIN)],
      sources: [],
      records: [],
      recordEvidenceIds: [],
      erasureId: null,
      factKeyFps: [],
      claimKeys: [],
      claimIds: [],
    };
    // In one transaction, as an erasure runs: the capture rewrite's setting lasts only inside one.
    await session(store.db.urls.admin, async (query) => {
      await query("begin");
      expect(await capturesErasure.run(query, erased, { dryRun: true, now: new Date(), keys: store.db.keys })).toBe(2);
      expect(await capturesErasure.run(query, erased, { dryRun: false, now: new Date(), keys: store.db.keys })).toBe(2);
      await query("commit");
    });
    expect(workOf(await rowOf(DAY.key))).toEqual(reordered);
    await swapBlob(mine.blob_ref, mine.envelope);
    const after = await titlesOf();
    expect(after.blocks).toEqual([undefined, before.blocks[1]]);
    expect(after.thread).toBeUndefined();
    expect(workOf(await rowOf(SYNC.key))).toMatchObject({ kind: "moment", thread: `${ROBIN} sync` });

    // The catch-up refills both rows from the blob and the facts, which still name the person.
    for (const key of [NAMED.key, SYNC.key]) {
      const row = await rowOf(key);
      await admin("update knowledge.captures set work_enc = $2, work_titles = false where id = $1", [
        row.id,
        sealUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.captures", id: row.id, column: "work_enc" },
          canonicalJson(untitled(workOf(row))),
        ),
      ]);
    }
    // Invariant 10: the erasure's suppression, as erasePerson writes it, under
    // the ledger taint lock it holds alone until it commits. A catch-up run meanwhile waits for it,
    // so it never seals a title the erasure's hook has already passed over.
    const ruling = testId("rul");
    const erasure = testId("ers");
    const at = new Date().toISOString();
    let caught: Promise<{ filled: number; failed?: number }> | undefined;
    let settled = false;
    await session(store.db.urls.admin, async (query) => {
      await query("begin");
      await query("select pg_advisory_xact_lock(hashtext('intelligence personal ledger taint'))");
      await query(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')",
        [ruling, testId("req"), at],
      );
      await query(
        "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', (select coalesce(max(journal_seq), 0) + 1 from knowledge.erasures), $3, 0, 1, 0, '{own}')",
        [erasure, ruling, at],
      );
      await query(
        "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')",
        [testId("sup"), erasure, erased.nameFps[0], at],
      );
      caught = store.writer.catchUpWork();
      void caught.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false);
      await query("commit");
    });
    expect(await caught).toEqual({ filled: 1 });
    expect(await titlesOf()).toEqual(after);
    // A new revision of the day, drained after the erasure.
    await push([{ ...NAMED, revision: 1 }]);
    expect((await titlesOf()).blocks).toEqual([undefined, before.blocks[1]]);
  });
});

describe("a title is judged on all its words", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("a title that names the person after its fortieth word loses its fingerprints at the erasure, and a new revision makes none", async () => {
    const WREN = "Wren Halloway";
    const long = `${Array.from({ length: 40 }, (_, n) => `w${n}`).join(" ")} ${WREN}`;
    const LONG = blockDay([block(WRITER, 300, 10, long), block(WRITER, 310, 10, "Plover rota notes")]);
    const fpsOf = async (): Promise<(string[] | undefined)[]> => {
      const day = workOf(await rowOf(LONG.key));
      return day.kind === "block" ? day.blocks.map((one_) => one_.titleFps) : [];
    };
    await push([LONG]);
    const before = await fpsOf();
    expect(before[0]).toContain(titleFp(long.toLowerCase()));
    expect(before[1]).toContain(titleFp("plover rota notes"));

    const erased = {
      evidenceIds: [],
      refs: [],
      addressFps: [],
      nameFps: [fingerprint(store.db.keys, "name", WREN)],
      sources: [],
      records: [],
      recordEvidenceIds: [],
      erasureId: null,
      factKeyFps: [],
      claimKeys: [],
      claimIds: [],
    };
    await session(store.db.urls.admin, async (query) => {
      expect(await capturesErasure.run(query, erased, { dryRun: false, now: new Date(), keys: store.db.keys })).toBe(1);
    });
    expect(await fpsOf()).toEqual([undefined, before[1]]);

    // With the person's name suppressed, as erasePerson leaves it, a new revision seals none.
    const ruling = testId("rul");
    const erasure = testId("ers");
    const at = new Date().toISOString();
    await admin(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')",
      [ruling, testId("req"), at],
    );
    await admin(
      "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', (select coalesce(max(journal_seq), 0) + 1 from knowledge.erasures), $3, 0, 1, 0, '{own}')",
      [erasure, ruling, at],
    );
    await admin(
      "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')",
      [testId("sup"), erasure, erased.nameFps[0], at],
    );
    await push([{ ...LONG, revision: 1 }]);
    expect(await fpsOf()).toEqual([undefined, before[1]]);
  });
});
