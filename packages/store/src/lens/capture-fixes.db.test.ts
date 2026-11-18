import { randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type CaptureMention,
  type CardId,
  type EntityId,
  type ErasureId,
  type ForgetItem,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  type NewCard,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath, readJournal } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { eventLogger } from "../test-support/recording.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// One database for the file, with `own` and `employer:example`, and a rule for `employer:absent`, a
// compartment the key file lacks. Every item is over a day old and no Google label is connected, so
// no meeting waits for a calendar.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();
const SYNC = "select pg_advisory_lock(hashtext('intelligence personal sync'))";

type Channel = { id: string; name: string; token: string };
type Device = {
  name: string;
  capture: Channel;
  mirror: Channel;
  accounts: { meetings: string; activity: string; blocks: string };
};

let db: TestDatabase;
let writer: Writer;
let reader: Reader;
let owner: Admin;
let accounts: Accounts;
let mac: Device;
const log = eventLogger();

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const count = async (table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values)).n;

// As pi_owner through the bootstrap's membership, committed, the table's forced row level
// security lifted for the statement where `unforce` names it.
async function asOwner(sql: string, values: unknown[] = [], unforce?: string): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    if (unforce !== undefined) await query(`alter table ${unforce} no force row level security`);
    await query(sql, values);
    if (unforce !== undefined) await query(`alter table ${unforce} force row level security`);
    await query("commit");
  });
}

// A device as `pi lens add NAME` makes it, by hand; `without` leaves out one of its accounts.
async function addDevice(name: string, without?: "blocks"): Promise<Device> {
  const channel = (client: string): Channel => ({
    id: testId("cli"),
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const device: Device = {
    name,
    capture: channel(`${name}-capture`),
    mirror: channel(name),
    accounts: { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc") },
  };
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insert, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insert, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      name,
      device.capture.id,
      device.mirror.id,
    ]);
    for (const [id, connector, kind] of [
      [device.accounts.meetings, "lens_meetings", "transcript"],
      [device.accounts.activity, "lens_activity", "screen_activity"],
      ...(without === "blocks" ? [] : [[device.accounts.blocks, "lens_blocks", "time_block"] as const]),
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
        [id, `device:${name}`, connector, kind],
      );
    }
    await query("commit");
  });
  return device;
}

async function insertScope(rule: {
  match: "bundle" | "host";
  value: string;
  compartment: string;
  kinds: string[];
}): Promise<void> {
  const id = testId("csr");
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6)",
    [
      id,
      rule.match,
      fingerprint(db.keys, "capture_scope", rule.value),
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, rule.value),
      rule.compartment,
      rule.kinds,
    ],
  );
}

let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JFXMND${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const batch = (): string => `fixes-batch-${String((batches += 1)).padStart(4, "0")}`;
const DEVON: CaptureMention = { name: "Devon Fixmend", address: "devon.fixmend@example.org" };
const ROBIN: CaptureMention = { name: "Robin Fixkept", address: "robin.fixkept@example.org" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const MEET = { bundle: "test.example.meet", name: "Meet" };
const ABSENT = { bundle: "test.example.absent", name: "Absent" };
const ABSENT_MEET = { bundle: "test.example.absentmeet", name: "Absent Meet" };
const UNSCOPED = { bundle: "test.example.unscoped", name: "Unscoped" };
const ULID = "01JFXMNDSYSTEM000000000000";

const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-30 * HOUR),
  endedAt: local(-30 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  window: "Alpha plan",
  entity: "chat",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
  ...over,
});
const absentMoment = (): MomentItem => {
  const item = moment({ app: ABSENT, text: "Under a key the file lacks." });
  delete (item as { url?: string }).url;
  return item;
};
const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(-30 * HOUR),
  endedAt: local(-30 * HOUR + 30 * MINUTE),
  app: MEET,
  title: "Kitchen planning",
  consent: true,
  mode: "call",
  speakers: [
    { label: "S1", owner: true, mention: { address: OWNER.personal } },
    { label: "S2", owner: false, mention: ROBIN },
  ],
  segments: [{ speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: "The cabinets come on Tuesday." }],
  ...over,
});
const forget = (named: string[]): ForgetItem => ({ kind: "forget", key: keyOf("forget"), keys: named });

async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  const answer = await reader.pushCapture(device.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}

const keyFp = (value: string): string => fingerprint(db.keys, "source_id", value);
const captureOf = async (key: string) =>
  one(
    await admin<{ id: string; evidence_id: string; event_id: string | null }>(
      "select id, evidence_id, event_id from knowledge.captures where capture_key = $1",
      [key],
    ),
  );
const capturesOf = (key: string): Promise<number> => count("knowledge.captures", "capture_key = $1", [key]);
const inboxOf = async (key: string, device: Device = mac) =>
  one(
    await admin<{ id: string; body: boolean; taken: boolean; refused_code: string | null }>(
      "select id, body_enc is not null as body, taken_at is not null as taken, refused_code from ledger.capture_inbox where client_id = $1 and source_key_fp = $2",
      [device.capture.id, keyFp(key)],
    ),
  );
const itemEncText = async (evidenceId: string): Promise<string> => {
  const row = one(
    await admin<{ compartments: string[]; item_enc: unknown }>(
      "select compartments, item_enc from vault.evidence_items where id = $1",
      [evidenceId],
    ),
  );
  return openUnder(
    db.keys,
    row.compartments,
    { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
    row.item_enc as never,
  );
};

// An inbox row written straight as pi_owner, the item sealed under `own` and bound to its row.
async function insertInbox(item: CaptureItem, device: Device = mac): Promise<string> {
  const id = testId("cin");
  const json = canonicalJson(item);
  const sessionId = one(
    await admin<{ session_id: string }>(
      "select session_id from ledger.capture_inbox where client_id = $1 order by received_at limit 1",
      [device.capture.id],
    ),
  ).session_id;
  await asOwner(
    `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, scope_fps, content_fp, body_bytes, received_at, compartments, body_enc)
     values ($1, $2, $3, 'direct-batch', $4, $5, $6, '{}', $7, $8, now(), '{own}', $9)`,
    [
      id,
      device.capture.id,
      sessionId,
      keyFp(item.key),
      item.kind === "forget" ? 0 : item.revision,
      item.kind,
      fingerprint(db.keys, "content_hash", sha256Hex(json)),
      Buffer.byteLength(json, "utf8"),
      JSON.stringify(sealRow(db.keys, "own", { table: "ledger.capture_inbox", id, column: "body_enc" }, json)),
    ],
  );
  return id;
}

// A notice card resting on a capture by its cap_ id alone: a basis row with no evidence id.
async function cardOn(capture: string): Promise<CardId> {
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
    body: "a card about a capture",
    bodyFrom: "code",
  } as NewCard);
  await asOwner(
    "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments) values ('card', $1, 'capture', $2, null, 'source', false, '{own}')",
    [card, capture],
    "ledger.basis",
  );
  return card;
}

const DEVON_EVENT = event({
  event: {
    id: "evfixmenddevon1",
    status: "confirmed",
    etag: '"etag-evfixmenddevon1"',
    updated: utc(-40 * HOUR),
    summary: "Planning",
    start: { dateTime: utc(-30 * HOUR) },
    end: { dateTime: utc(-29 * HOUR) },
    organizer: { email: OWNER.personal, self: true },
    attendees: [
      { email: OWNER.personal, self: true, responseStatus: "accepted" },
      { email: DEVON.address ?? "", displayName: DEVON.name ?? "", responseStatus: "accepted" },
    ],
  },
  title: "Planning",
  startsAt: utc(-30 * HOUR),
  endsAt: utc(-29 * HOUR),
  allDay: false,
});

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  accounts = await connect(writer);
  mac = await addDevice("mac");
  await insertScope({ match: "host", value: "wiki.example.org", compartment: "own", kinds: ["moment"] });
  await insertScope({
    match: "host",
    value: "wiki.employer-example.test",
    compartment: "employer:example",
    kinds: ["moment"],
  });
  await insertScope({ match: "bundle", value: MEET.bundle, compartment: "own", kinds: ["meeting"] });
  await insertScope({ match: "bundle", value: ABSENT.bundle, compartment: "employer:absent", kinds: ["moment"] });
  await insertScope({ match: "bundle", value: ABSENT_MEET.bundle, compartment: "employer:absent", kinds: ["meeting"] });
  await ingestEvent(writer, accounts.personalCalendar, DEVON_EVENT);
}, TIMEOUT);

afterEach(async () => {
  // Nothing a test left waiting reaches the next one's counts.
  await admin("delete from ledger.capture_inbox where taken_at is null");
});

afterAll(async () => {
  await owner?.close();
  await reader?.close();
  await writer?.close();
  await db?.drop();
});

describe("the drain", { timeout: TIMEOUT }, () => {
  it("a row that waits is paged past, so limit counts the rows taken and a newer row is taken", async () => {
    const [lacking, fine] = [absentMoment(), moment()];
    await push([lacking]);
    await push([fine]);
    expect(await writer.takeCapture(1)).toMatchObject({ taken: 1, waiting: 1, failed: 0 });
    expect(await capturesOf(fine.key)).toBe(1);
    expect(await inboxOf(lacking.key)).toMatchObject({ body: true, taken: false, refused_code: null });
  });

  it("a later part of a series waits while its first part waits in the inbox, and a series whose first part is taken is taken whole", async () => {
    const first = meeting({ app: ABSENT_MEET });
    const waiting: MeetingItem = { ...first, series: first.key, part: 1 };
    const later = meeting({
      startedAt: local(-30 * HOUR + 30 * MINUTE),
      endedAt: local(-29 * HOUR),
      series: first.key,
      part: 2,
    });
    await push([waiting]);
    await push([later]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 0, waiting: 2, failed: 0 });
    expect(await capturesOf(later.key)).toBe(0);
    expect(await inboxOf(later.key)).toMatchObject({ body: true, taken: false });
    // The control: a series whose first part is taken.
    const head = meeting();
    const opening: MeetingItem = { ...head, series: head.key, part: 1 };
    const next = meeting({
      startedAt: local(-30 * HOUR + 30 * MINUTE),
      endedAt: local(-29 * HOUR),
      series: head.key,
      part: 2,
    });
    await push([opening]);
    await push([next]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 2, failed: 0 });
    expect(await capturesOf(next.key)).toBe(1);
  });

  it("a block day none of whose blocks is in scope counts out_of_scope once per block", async () => {
    await push([moment()]);
    const block = (from: number): BlockItem["blocks"][number] => ({
      start: local(from),
      end: local(from + 30 * MINUTE),
      minutes: 30,
      app: UNSCOPED,
    });
    const day: BlockItem = {
      kind: "block",
      key: keyOf("block"),
      revision: 0,
      day: local(-2 * DAY).slice(0, 10),
      blocks: [block(-2 * DAY), block(-2 * DAY + HOUR)],
    };
    await insertInbox(day);
    const counts = await writer.takeCapture();
    expect(counts.dropped.out_of_scope).toBe(2);
    expect(counts.taken).toBe(1);
    expect(await capturesOf(day.key)).toBe(0);
  });

  it("a meeting whose calendar UID holds a system id is dropped system_ids", async () => {
    const tripped = meeting({
      calendar: { start: local(-30 * HOUR), end: local(-29 * HOUR), uid: `ent_${ULID}@example.org`, attendees: [] },
    });
    const clean = meeting({
      calendar: { start: local(-30 * HOUR), end: local(-29 * HOUR), uid: "series-fixmend@example.org", attendees: [] },
    });
    await push([tripped, clean]);
    const counts = await writer.takeCapture();
    expect(counts.dropped.system_ids).toBe(1);
    expect(counts.taken).toBe(1);
    expect(await capturesOf(tripped.key)).toBe(0);
    expect(await capturesOf(clean.key)).toBe(1);
  });

  it("a new revision keeps the item's cap_ id, and pi erase item cap_ still reaches it", async () => {
    const first = moment();
    await push([first]);
    await writer.takeCapture();
    const before = await captureOf(first.key);
    await push([{ ...first, revision: 1, text: "The alpha plan, final." }]);
    expect(await writer.takeCapture()).toMatchObject({ replaced: 1, failed: 0 });
    const after = await captureOf(first.key);
    expect(after.id).toBe(before.id);
    expect(after.evidence_id).not.toBe(before.evidence_id);
    expect(
      (await owner.erasure.eraseItem({ kind: "capture", id: before.id as CaptureId }, { requestId: testId("req") }))
        .items,
    ).toBe(1);
    expect(await capturesOf(first.key)).toBe(0);
  });
});

describe("the erasure", { timeout: TIMEOUT }, () => {
  it("a ledger row citing a capture by its cap_ id alone is counted by a dry run and tainted by the erasure", async () => {
    const item = moment();
    await push([item]);
    await writer.takeCapture();
    const { id } = await captureOf(item.key);
    const card = await cardOn(id);
    const dry = await owner.erasure.eraseItem(
      { kind: "capture", id: id as CaptureId },
      { requestId: testId("req"), dryRun: true },
    );
    expect(dry.taintedRows).toBeGreaterThanOrEqual(1);
    expect(
      one(
        await admin<{ tainted: boolean }>("select tainted_at is not null as tainted from ledger.cards where id = $1", [
          card,
        ]),
      ).tainted,
    ).toBe(false);
    await owner.erasure.eraseItem({ kind: "capture", id: id as CaptureId }, { requestId: testId("req") });
    expect(
      one(
        await admin<{ tainted: boolean }>("select tainted_at is not null as tainted from ledger.cards where id = $1", [
          card,
        ]),
      ).tainted,
    ).toBe(true);
  });

  it("a person's erasure that a capture item's key would stop refuses keys_missing before its journal line, dry or not, and with the key it clears facts_enc and item_enc", async () => {
    const [mine, work] = [
      moment({ participants: [DEVON, ROBIN] }),
      moment({ url: "https://wiki.employer-example.test/teams/alpha", participants: [DEVON, ROBIN] }),
    ];
    await push([mine, work]);
    expect(await writer.takeCapture()).toMatchObject({ taken: 2, failed: 0 });
    const devon = one(
      await admin<{ entity_id: string }>("select distinct entity_id from knowledge.accounts where value_fp = $1", [
        fingerprint(db.keys, "address", DEVON.address ?? ""),
      ]),
    ).entity_id as EntityId;
    const lacking = createAdmin({
      url: db.urls.admin,
      keys: {
        ...db.keys,
        compartments: new Map([...db.keys.compartments].filter(([name]) => name !== "employer:example")),
      },
      log,
      journal: journalPath(db.keyFile),
    });
    const seq = (await readJournal(journalPath(db.keyFile))).seq;
    try {
      await expect(
        lacking.erasure.erasePerson(devon, { requestId: testId("req"), dryRun: true }),
      ).rejects.toMatchObject({
        code: "keys_missing",
      });
      await expect(lacking.erasure.erasePerson(devon, { requestId: testId("req") })).rejects.toMatchObject({
        code: "keys_missing",
      });
    } finally {
      await lacking.close();
    }
    expect((await readJournal(journalPath(db.keyFile))).seq).toBe(seq);
    expect(await count("knowledge.entities", "id = $1", [devon])).toBe(1);

    // The control: with every key, the hook clears both sealed copies of the facts.
    const report = await owner.erasure.erasePerson(devon, { requestId: testId("req") });
    expect(report.more.captures).toBe(2);
    for (const item of [mine, work]) {
      const after = await itemEncText((await captureOf(item.key)).evidence_id);
      for (const gone of [DEVON.address ?? "", DEVON.name ?? ""])
        expect(after, `${item.key} ${gone}`).not.toContain(gone);
      expect(after, item.key).toContain(ROBIN.address);
    }
  });
});

describe("settleForgets", { timeout: TIMEOUT }, () => {
  it("a forget whose content does not match leaves the queue for good, counted failed and logged by its row id", async () => {
    const item = moment();
    await push([item]);
    await writer.takeCapture();
    const notice = forget([item.key]);
    await push([notice]);
    const row = await inboxOf(notice.key);
    await asOwner(
      "update ledger.capture_inbox set content_fp = $2 where id = $1",
      [row.id, fingerprint(db.keys, "content_hash", sha256Hex("another body"))],
      "ledger.capture_inbox",
    );
    expect(await owner.lens.settleForgets()).toEqual({ settled: 0, alreadyRemoved: 0, failed: 1 });
    expect(await inboxOf(notice.key)).toEqual({ id: row.id, body: false, taken: true, refused_code: null });
    expect(log.events.filter((one_) => one_.event === "forget_refused").at(-1)).toEqual({
      event: "forget_refused",
      ids: { inbox: row.id },
      code: "content_mismatch",
    });
    // Nothing of it applied, and it is not tried again.
    expect(await capturesOf(item.key)).toBe(1);
    expect(await owner.lens.settleForgets()).toEqual({ settled: 0, alreadyRemoved: 0, failed: 0 });
  });

  it("a forget waiting on an account its device lacks is paged past, and holds back no newer forget", async () => {
    const partial = await addDevice("partial", "blocks");
    const item = moment();
    await push([item]);
    await writer.takeCapture();
    const stuck = forget([keyOf("block")]);
    await push([stuck], partial);
    await push([forget([item.key])]);
    expect(await owner.lens.settleForgets(1)).toEqual({ settled: 1, alreadyRemoved: 0, failed: 0 });
    expect(await capturesOf(item.key)).toBe(0);
    expect(await inboxOf(stuck.key, partial)).toMatchObject({ body: true, taken: false });
  });

  it("alreadyRemoved counts each pair already removed", async () => {
    const [left, right] = [moment(), moment()];
    await push([left, right]);
    await writer.takeCapture();
    for (const item of [left, right])
      await owner.erasure.eraseItem(
        { kind: "capture", id: (await captureOf(item.key)).id as CaptureId },
        { requestId: testId("req") },
      );
    await push([forget([left.key, right.key])]);
    expect(await owner.lens.settleForgets()).toEqual({ settled: 0, alreadyRemoved: 2, failed: 0 });
  });

  it("settle takes the sync lock with no forget waiting", async () => {
    const client = new pg.Client({ connectionString: db.urls.writer });
    await client.connect();
    try {
      await client.query(SYNC);
      await expect(owner.lens.settleForgets()).rejects.toMatchObject({ code: "sync_running" });
    } finally {
      await client.end();
    }
    expect(await owner.lens.settleForgets()).toEqual({ settled: 0, alreadyRemoved: 0, failed: 0 });
  });

  it("a forget's erasure is never lifted", async () => {
    const [forgotten, erased] = [moment(), moment()];
    await push([forgotten, erased]);
    await writer.takeCapture();
    await push([forget([forgotten.key])]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1 });
    const id = one(
      await admin<{ id: string }>(
        "select id from knowledge.erasures where kind = 'device_forget' order by journal_seq desc limit 1",
      ),
    ).id as ErasureId;
    await expect(owner.erasure.liftErasure(id, { requestId: testId("req") })).rejects.toMatchObject({
      code: "not_permitted",
    });
    expect(await count("knowledge.removed_evidence", "erasure_id = $1", [id])).toBe(1);
    // The control: the owner's own erasure lifts.
    const report = await owner.erasure.eraseItem(
      { kind: "capture", id: (await captureOf(erased.key)).id as CaptureId },
      { requestId: testId("req") },
    );
    expect(await owner.erasure.liftErasure(report.erasure as ErasureId, { requestId: testId("req") })).toBe(true);
  });
});
