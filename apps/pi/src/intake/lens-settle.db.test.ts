import { createHash, randomBytes } from "node:crypto";
import {
  type CaptureItem,
  type ErasureJournalEntry,
  type ForgetItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import {
  appendJournal,
  createReader,
  createWriter,
  journalPath,
  readJournal,
  type Writer,
} from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quiet } from "../test-support/extract-fixtures.ts";
import { pi } from "../test-support/sync-db-fixtures.ts";

// `pi erase settle [--limit N]` and `pi erase item cap_...` through the real `pi`. One database for
// the file; the device is registered by hand as addDevice makes it, its scope by hand as pi_admin;
// items reach the vault through Reader.pushCapture and Writer.takeCapture. The journal-ahead test
// runs last: it leaves the journal ahead.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const SYNC = "select pg_advisory_lock(hashtext('intelligence personal sync'))";

type Channel = { id: string; token: string };
type Device = { capture: Channel; mirror: Channel };

let db: TestDatabase;
let writer: Writer;
let mac: Device;
const env = (): Record<string, string> => ({ PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile });
const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const rowId = (prefix: string): string => `${prefix}_01JPSETT${randomBytes(9).toString("hex").toUpperCase()}`;

async function addDevice(name: string): Promise<Device> {
  const device: Device = {
    capture: { id: rowId("cli"), token: `pit_test-${name}-capture-${randomBytes(8).toString("hex")}` },
    mirror: { id: rowId("cli"), token: `pit_test-${name}-${randomBytes(8).toString("hex")}` },
  };
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await admin(insert, [
    device.capture.id,
    `${name}-capture`,
    sha256Hex(device.capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    device.mirror.id,
    name,
    sha256Hex(device.mirror.token),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
    name,
    device.capture.id,
    device.mirror.id,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
      [rowId("acc"), `device:${name}`, connector, kind],
    );
  }
  return device;
}

let keys = 0;
const keyOf = <K extends "moment" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JPSETT${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const moment = (): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + 5 * MINUTE),
  app: { bundle: "test.example.reader", name: "Reader" },
  url: "https://wiki.example.org/teams/alpha/plan",
  entity: "doc",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
});
const forget = (named: string[]): ForgetItem => ({ kind: "forget", key: keyOf("forget"), keys: named });

async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const answer = await reader.pushCapture(device.capture.token, {
      batch: `pi-settle-batch-${String((batches += 1)).padStart(4, "0")}`,
      items,
    });
    expect(answer).toEqual({
      ok: true,
      value: expect.objectContaining({ items: items.map((item) => ({ key: item.key, outcome: "accepted" })) }),
    });
  } finally {
    await reader.close();
  }
}
// Items pushed and drained into the vault.
async function storedItems(n: number, device: Device = mac): Promise<MomentItem[]> {
  const items = Array.from({ length: n }, moment);
  await push(items, device);
  expect(await writer.takeCapture()).toMatchObject({ taken: n, failed: 0 });
  return items;
}
const stored = async (item: CaptureItem): Promise<boolean> =>
  (await admin("select 1 from knowledge.captures where capture_key = $1", [item.key])).length > 0;
const lastLine = (stderr: string): unknown =>
  JSON.parse(
    stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .at(-1) ?? "null",
  );

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet, journal: journalPath(db.keyFile) });
  mac = await addDevice("mac");
  const id = rowId("csr");
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds) values ($1, 'host', $2, $3, 'own', '{moment}')",
    [
      id,
      fingerprint(db.keys, "capture_scope", "wiki.example.org"),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, "wiki.example.org"),
    ],
  );
}, TIMEOUT);

afterAll(async () => {
  await writer?.close();
  await db?.drop();
});

describe("pi erase settle", { timeout: TIMEOUT }, () => {
  it("pi erase settle applies the forgets and prints counts: settled, already removed, failed", async () => {
    const [item] = await storedItems(1);
    await push([forget([item?.key ?? ""])]);
    const result = await pi(["erase", "settle"], env());
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ settled: 1, alreadyRemoved: 0, failed: 0 });
    expect(await stored(item as MomentItem)).toBe(false);
    expect(await admin("select kind, ruling_id from knowledge.erasures")).toEqual([
      { kind: "device_forget", ruling_id: null },
    ]);
    // Nothing left: a second run settles none.
    expect(JSON.parse((await pi(["erase", "settle"], env())).stdout)).toEqual({
      settled: 0,
      alreadyRemoved: 0,
      failed: 0,
    });
  });

  it("pi erase settle --limit N settles at most N forgets, oldest first", async () => {
    const [first, second] = await storedItems(2);
    await push([forget([first?.key ?? ""])]);
    await push([forget([second?.key ?? ""])]);
    const one = await pi(["erase", "settle", "--limit", "1"], env());
    expect(one.exit, one.stderr).toBe(0);
    expect(JSON.parse(one.stdout)).toEqual({ settled: 1, alreadyRemoved: 0, failed: 0 });
    expect([await stored(first as MomentItem), await stored(second as MomentItem)]).toEqual([false, true]);
    expect(JSON.parse((await pi(["erase", "settle", "--limit", "1"], env())).stdout)).toEqual({
      settled: 1,
      alreadyRemoved: 0,
      failed: 0,
    });
    expect(await stored(second as MomentItem)).toBe(false);
  });

  it("the forgets of a revoked device are still settled", async () => {
    const gone = await addDevice("gone");
    const [item] = await storedItems(1, gone);
    await push([forget([item?.key ?? ""])], gone);
    await admin("update policy.clients set status = 'revoked', revoked_at = now() where id = any($1)", [
      [gone.capture.id, gone.mirror.id],
    ]);
    const result = await pi(["erase", "settle"], env());
    expect(JSON.parse(result.stdout)).toMatchObject({ settled: 1, failed: 0 });
    expect(await stored(item as MomentItem)).toBe(false);
  });

  it("R32, owner-surface: pi erase settle exits 1 with sync_running while a sync holds the lock, and the next run takes the forget", async () => {
    const [item] = await storedItems(1);
    await push([forget([item?.key ?? ""])]);
    const client = new pg.Client({ connectionString: db.urls.writer });
    await client.connect();
    try {
      await client.query(SYNC);
      const held = await pi(["erase", "settle"], env());
      expect(held.exit).toBe(1);
      expect(lastLine(held.stderr)).toEqual({ event: "command_failed", code: "sync_running" });
      expect(await stored(item as MomentItem)).toBe(true);
    } finally {
      await client.end();
    }
    expect(JSON.parse((await pi(["erase", "settle"], env())).stdout)).toMatchObject({ settled: 1, failed: 0 });
    expect(await stored(item as MomentItem)).toBe(false);
  });

  it("pi erase item cap_... erases one capture item through owner-surface's eraseItem, and its key goes back to the Mac", async () => {
    const [item] = await storedItems(1);
    const capture =
      (await admin<{ id: string }>("select id from knowledge.captures where capture_key = $1", [item?.key]))[0]?.id ??
      "";
    expect(capture).toMatch(/^cap_/);
    const result = await pi(["erase", "item", capture], env());
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ items: 1, people: 0 });
    expect(await stored(item as MomentItem)).toBe(false);
    expect(
      await admin("select client_id, capture_key from ledger.capture_erasures where capture_key = $1", [item?.key]),
    ).toEqual([{ client_id: mac.mirror.id, capture_key: item?.key }]);
  });

  it("pi erase settle refuses with erasure_replay_needed when the journal is ahead", async () => {
    const [item] = await storedItems(1);
    await push([forget([item?.key ?? ""])]);
    const journal = journalPath(db.keyFile);
    const { seq } = await readJournal(journal);
    // An erasure the journal holds and the database lacks, as a restore leaves it.
    await appendJournal(journal, {
      seq: seq + 1,
      erasure: rowId("ers"),
      kind: "item",
      items: [],
      suppress: [],
    } as unknown as ErasureJournalEntry);
    const ahead = await pi(["erase", "settle"], env());
    expect(ahead.exit).toBe(1);
    expect(lastLine(ahead.stderr)).toEqual({ event: "command_failed", code: "erasure_replay_needed" });
    expect(await stored(item as MomentItem)).toBe(true);
  });
});
