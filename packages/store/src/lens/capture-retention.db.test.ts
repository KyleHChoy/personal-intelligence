import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  type BlockItem,
  type CaptureItem,
  ErasureJournalEntry,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath, readJournal } from "../core/journal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { refusedWith } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// Nothing expires before the owner writes a rule; `pi retain adopt` writes the capture defaults
// (moments 90 days, blocks 400, transcripts kept), each a decision and a journal line; the sync's
// expiry ages what a rule has passed, keeping its evidence row as its record and writing no
// erasure, no removed-evidence row and nothing for the Mac; a key retention expired is never stored
// again. Every class but the three is refused `not_supported`. Reserved domains and test bundles
// only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (ago: number): string => `${new Date(NOW - ago - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const BUNDLE = "test.example.notes";

let db: TestDatabase;
let admin: Admin;
let writer: Writer;
let reader: Reader;
let token: string;
let batches = 0;

const moment = (n: number, ago: number): MomentItem => ({
  kind: "moment",
  key: `moment:01JS${String(n).padStart(22, "0")}`,
  revision: 0,
  observedAt: local(ago),
  endedAt: local(ago - 30_000),
  app: { bundle: BUNDLE, name: "Notes" },
  window: "Notes",
  entity: "doc",
  participants: [],
  text: "The venue is booked for the second week; the rota is the open question.",
  read: "ax",
});
const blockDay = (n: number, ago: number): BlockItem => ({
  kind: "block",
  key: `block:01JS${String(n).padStart(22, "0")}`,
  revision: 0,
  day: local(ago).slice(0, 10),
  blocks: [
    {
      start: local(ago),
      end: local(ago - 20 * MINUTE),
      minutes: 20,
      app: { bundle: BUNDLE, name: "Notes" },
      title: "Notes",
    },
  ],
});
const meeting = (n: number, ago: number): MeetingItem => ({
  kind: "meeting",
  key: `meeting:01JS${String(n).padStart(22, "0")}`,
  revision: 0,
  startedAt: local(ago),
  endedAt: local(ago - 20 * MINUTE),
  app: { bundle: BUNDLE, name: "Notes" },
  title: "Rota",
  consent: true,
  mode: "room",
  speakers: [{ label: "S1", owner: true }],
  segments: [{ speaker: "S1", fromMs: 0, toMs: 10_000, channel: "input", text: "The rota is the open question." }],
});

const OLD_MOMENT = moment(1, 100 * DAY);
const NEW_MOMENT = moment(2, 10 * DAY);
const OLD_DAY = blockDay(3, 100 * DAY);
const OLD_MEETING = meeting(4, 500 * DAY);

const rows = <T>(sql: string, values?: unknown[]) => queryAs<T>(db.urls.admin, sql, values);
const count = async (sql: string, values?: unknown[]): Promise<number> =>
  Number((await rows<{ n: string }>(`select count(*)::text as n from (${sql}) q`, values))[0]?.n ?? 0);
const captureOf = async (key: string) =>
  (
    await rows<{ id: string; evidence_id: string }>(
      "select id, evidence_id from knowledge.captures where capture_key = $1",
      [key],
    )
  )[0];
async function push(items: CaptureItem[]): Promise<void> {
  batches += 1;
  const answer = await reader.pushCapture(token, {
    batch: `capture-retention-${String(batches).padStart(4, "0")}`,
    items,
  });
  expect(answer.ok).toBe(true);
}

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  admin = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await rows(insert, [
    capture.id,
    "mac-capture",
    sha256Hex(capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await rows(insert, [
    mirror,
    "mac",
    sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
    ["own"],
    ["self"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await rows("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ('mac', $1, $2)", [
    capture.id,
    mirror,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    await rows(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [testId("acc"), connector, kind],
    );
  }
  token = capture.token;
  await admin.lens.addScope({
    match: "bundle",
    value: BUNDLE,
    compartment: "own",
    kinds: ["meeting", "moment", "block"],
  });
  await push([OLD_MOMENT, NEW_MOMENT, OLD_DAY, OLD_MEETING]);
  expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
  expect(await count("select 1 from knowledge.captures")).toBe(4);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await admin?.close();
  await reader?.close();
  await writer?.close();
  await db?.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("capture retention: the rules", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("before any rule nothing expires; the plan counts what the defaults would take, and says so", async () => {
    expect(await writer.expireCapture(new Date(NOW))).toEqual({ expired: {}, failed: 0 });
    expect(await count("select 1 from knowledge.captures")).toBe(4);
    const plan = await admin.retention.plan();
    expect(plan.against).toBe("defaults");
    expect(plan.counts.map(({ class: kind, due }) => [kind, due])).toEqual([["capture_moment", 1]]);
  });

  it("a class whose expiry is not built is refused not_supported, and an account that is no device's account of the class not_found", async () => {
    for (const kind of ["mail_held", "mail_automated", "ledger_read_log", "document"] as const) {
      expect(
        await refusedWith(() =>
          admin.retention.setRetention({ class: kind, days: 7, account: null }, { requestId: `0123-refused-${kind}` }),
        ),
      ).toEqual({ name: "AdminError", code: "not_supported" });
    }
    const [blocks] = await rows<{ id: string }>("select id from vault.source_accounts where connector = 'lens_blocks'");
    expect(
      await refusedWith(() =>
        admin.retention.setRetention(
          { class: "capture_moment", days: 7, account: blocks?.id as never },
          { requestId: "0123-refused-account" },
        ),
      ),
    ).toEqual({ name: "AdminError", code: "not_found" });
    expect(await count("select 1 from policy.retention_rules")).toBe(0);
  });

  it("adopt writes the three defaults, each one owner decision and one journal line, and again writes nothing", async () => {
    const before = (await readJournal(journalPath(db.keyFile))).seq;
    const ids = await admin.retention.adoptRetention({ requestId: "0123-adopt" });
    expect(ids).toHaveLength(3);
    // Again, under another request id as the command makes one: every class is ruled, so nothing.
    expect(await admin.retention.adoptRetention({ requestId: "0123-adopt-again" })).toEqual([]);
    const listed = await admin.retention.listRetention();
    expect(listed.map((rule) => [rule.class, rule.account, rule.days])).toEqual([
      ["capture_block", null, 400],
      ["capture_moment", null, 90],
      ["capture_transcript", null, null],
    ]);
    expect(await count("select 1 from knowledge.owner_decisions where kind = 'retention_rule'")).toBe(3);
    const journal = await readJournal(journalPath(db.keyFile));
    expect(journal.seq).toBe(before + 3);
    const lines = journal.entries.slice(-3);
    for (const line of lines) expect(ErasureJournalEntry.safeParse(line).success).toBe(true);
    expect(lines.map((line) => ("retention" in line ? line.retention : null)).sort()).toEqual([...ids].sort());
    expect(await admin.erasure.level()).toBe("level");
  });
});

describe("capture retention: expiry is ageing", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the sync's expiry ages the moment past 90 days and keeps the newer one, the 100-day block and the transcript", async () => {
    const old = await captureOf(OLD_MOMENT.key);
    expect(await writer.expireCapture(new Date(NOW))).toEqual({ expired: { capture_moment: 1 }, failed: 0 });
    // Its capture row and everything derived are gone; its evidence row stays, expired, its blob gone.
    expect(await captureOf(OLD_MOMENT.key)).toBeUndefined();
    const [evidence] = await rows<{ payload_state: string; blob_ref: string | null; expired_at: Date | null }>(
      "select payload_state, blob_ref, expired_at from vault.evidence_items where id = $1",
      [old?.evidence_id],
    );
    expect(evidence).toMatchObject({ payload_state: "expired", blob_ref: null });
    expect(evidence?.expired_at).toBeInstanceOf(Date);
    for (const key of [NEW_MOMENT.key, OLD_DAY.key, OLD_MEETING.key]) expect(await captureOf(key), key).toBeDefined();
    // Ageing, not erasure: no removed-evidence row, no erasure, nothing to send back to the Mac.
    expect(await count("select 1 from knowledge.removed_evidence")).toBe(0);
    expect(await count("select 1 from knowledge.erasures")).toBe(0);
    expect(await count("select 1 from ledger.capture_erasures")).toBe(0);
    // A second run finds nothing more.
    expect(await writer.expireCapture(new Date(NOW))).toEqual({ expired: {}, failed: 0 });
  });

  it("a key retention expired is never stored again: a new revision of it is dropped expired at drain", async () => {
    await push([{ ...OLD_MOMENT, revision: 1, text: `${OLD_MOMENT.text} Edited.` }]);
    expect((await writer.takeCapture()).dropped).toMatchObject({ expired: 1 });
    expect(await captureOf(OLD_MOMENT.key)).toBeUndefined();
    expect(await count("select 1 from ledger.capture_inbox where refused_code = 'expired'")).toBe(1);
  });

  it("a block day whose split expired is never stored again, though a new revision would split it under another compartment", async () => {
    const day = blockDay(5, 120 * DAY);
    await push([day]);
    expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
    // Blocks keep 400 days by the defaults: one for its account at 110 days ages it, and not the
    // 100-day block.
    const [blocks] = await rows<{ id: string }>("select id from vault.source_accounts where connector = 'lens_blocks'");
    await admin.retention.setRetention(
      { class: "capture_block", days: 110, account: blocks?.id as never },
      { requestId: "0123-blocks-110" },
    );
    expect(await writer.expireCapture(new Date(NOW))).toEqual({ expired: { capture_block: 1 }, failed: 0 });
    expect(await captureOf(day.key)).toBeUndefined();
    expect(await captureOf(OLD_DAY.key)).toBeDefined();
    // The app is now an employer's; the next revision's blocks would split under employer:example.
    await admin.lens.addScope({
      match: "bundle",
      value: "test.example.work",
      compartment: "employer:example",
      kinds: ["block"],
    });
    await push([
      {
        ...day,
        revision: 1,
        blocks: day.blocks.map((block) => ({ ...block, app: { bundle: "test.example.work", name: "Work" } })),
      },
    ]);
    expect((await writer.takeCapture()).dropped).toMatchObject({ expired: 1 });
    expect(await captureOf(day.key)).toBeUndefined();
  });

  it("adopt after the owner's own rule keeps the owner's rule", async () => {
    await admin.retention.setRetention(
      { class: "capture_moment", days: null, account: null },
      { requestId: "0123-moments-kept" },
    );
    expect(await admin.retention.adoptRetention({ requestId: "0123-adopt-third" })).toEqual([]);
    expect(
      (await admin.retention.listRetention()).find((rule) => rule.class === "capture_moment" && rule.account === null)
        ?.days,
    ).toBeNull();
  });

  it("a rule for one account wins over the class's, and pi retain run expires what it makes due", async () => {
    const [blocks] = await rows<{ id: string }>("select id from vault.source_accounts where connector = 'lens_blocks'");
    await admin.retention.setRetention(
      { class: "capture_block", days: 30, account: blocks?.id as never },
      { requestId: "0123-blocks-30" },
    );
    const run = await admin.retention.runRetention();
    expect(run).toEqual({ against: "rules", counts: [{ class: "capture_block", account: blocks?.id, due: 1 }] });
    expect(await captureOf(OLD_DAY.key)).toBeUndefined();
    expect(await captureOf(NEW_MOMENT.key)).toBeDefined();
    // The transcript is kept, at any age.
    expect(await captureOf(OLD_MEETING.key)).toBeDefined();
  });
});

describe("capture retention: the journal", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a store restored to before a rule is behind its journal, and replay writes the rule again with its id and number", async () => {
    const [rule] = await rows<{ id: string; journal_seq: string; class: string; days: number | null }>(
      "select id, journal_seq::text, class, days from policy.retention_rules order by journal_seq desc limit 1",
    );
    // The restore, as pi_owner through the bootstrap: the latest rule's row gone, as in a dump from before it.
    await session(db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query("alter table policy.retention_rules no force row level security");
      await query("delete from policy.retention_rules where id = $1", [rule?.id]);
      await query("alter table policy.retention_rules force row level security");
    });
    expect(await admin.erasure.level()).toBe("behind");
    expect(await admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
    expect(
      await rows("select id, journal_seq::text, class, days from policy.retention_rules where id = $1", [rule?.id]),
    ).toEqual([rule]);
    expect(
      await count("select 1 from knowledge.owner_decisions where request_id = $1", [
        `replay_retention_${rule?.id.slice(4)}`,
      ]),
    ).toBe(1);
    expect(await admin.erasure.level()).toBe("level");
    expect(await admin.erasure.replayErasures()).toEqual({ applied: 0, journalled: 0 });
  });

  it("a journal lost is written again from the rules the store holds", async () => {
    const kept = await readJournal(journalPath(db.keyFile));
    await rm(journalPath(db.keyFile));
    expect(await admin.erasure.replayErasures()).toEqual({ applied: 0, journalled: kept.entries.length });
    expect((await readJournal(journalPath(db.keyFile))).entries).toEqual(kept.entries);
    expect(await admin.erasure.level()).toBe("level");
  });
});
