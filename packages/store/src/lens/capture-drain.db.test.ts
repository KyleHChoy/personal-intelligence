import { randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureItem,
  type CaptureMention,
  type ForgetItem,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { captureBlock, captureFacts, captureMatchKeys } from "@intelligence/personal-core/lens";
import { fakeLens, type LensWorld } from "@intelligence/personal-core/testing";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow, sealUnder } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { insertClient, insertSecret, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import {
  copyTestDatabase,
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { eventLogger } from "../test-support/recording.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import type { CaptureCounts } from "./capture-drain.ts";

// Writer.takeCapture, the drain of Lens's inbox. One database for the file, with `own`,
// `employer:example` and the restricted category `health` on with its key, so the
// restricted-category screen runs. The device is registered by hand as `pi lens add` makes it, and
// the scope written by hand as pi_admin stores it. Events are stored through the writer from
// hand-written calendar fixtures. Times are the real clock's, so the database's clock and the
// items' agree: a meeting ended over 24 hours ago never waits. Every refusal has its control in the
// same test.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The real clock, to the minute.
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
// A time `offset` from T, written as Lens writes one: with the Mac's local offset of -05:00.
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();

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
let accounts: Accounts;
let lens: LensWorld;
let mac: Device;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const count = async (table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values)).n;

// As pi_owner through the bootstrap's membership, committed: what no runtime role may do. The
// table's forced row level security is lifted for the statement where `unforce` names it.
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

// A device as `pi lens add NAME` makes it, by hand: the capture client, the mirror client (here
// cleared for both compartments, which no label may take from, L3), the policy.lens_devices row and
// the three source accounts device:NAME.
async function addDevice(
  name: string,
  mirrorCompartments = ["own", "employer:example"],
  target: TestDatabase = db,
): Promise<Device> {
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
  const insertClient_ = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(target.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient_, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient_, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      mirrorCompartments,
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
      [device.accounts.blocks, "lens_blocks", "time_block"],
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

// `source` marks a source rule.
type Rule = {
  match: "bundle" | "host";
  value: string;
  account?: string;
  compartment: string;
  kinds: ("meeting" | "moment" | "block")[];
  source?: "imessage";
};
async function insertScope(rule: Rule, target: TestDatabase = db): Promise<void> {
  const id = testId("csr");
  const fp = (value: string) => fingerprint(target.keys, "capture_scope", value);
  const sealed = (column: string, value: string) =>
    sealRow(target.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await queryAs(
    target.urls.admin,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds, source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      rule.match,
      fp(rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : fp(rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
      rule.source ?? null,
    ],
  );
}

// The people and apps of these tests, on reserved domains.
const DEVON: CaptureMention = { name: "Devon Marsh", address: "devon.marsh@example.org" };
const ROBIN: CaptureMention = { name: "Robin Vale", address: "robin.vale@example.org" };
const QUILL = "quill.stranger@example.net";
const ALT_WORK = "odalys.alt@employer-example.test";
const MEET = { bundle: "test.example.meet", name: "Meet" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const SAFARI = { bundle: "com.apple.Safari", name: "Safari" };
const ABSENT = { bundle: "test.example.absent", name: "Absent" };

// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JDRAWN${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const batch = (): string => `drain-batch-${String((batches += 1)).padStart(4, "0")}`;

const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  window: "Alpha plan",
  entity: "doc",
  thread: "Alpha plan",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
  ...over,
});
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
  segments: [
    { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "I will order the tiles tomorrow." },
    { speaker: "S2", fromMs: 20_000, toMs: 40_000, channel: "output", text: "The cabinets come on Tuesday." },
  ],
  ...over,
});
const blockDay = (blocks: BlockItem["blocks"], over: Partial<BlockItem> = {}): BlockItem => ({
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: local(-2 * DAY).slice(0, 10),
  blocks,
  ...over,
});
const block = (
  app: { bundle: string; name: string },
  more: { host?: string; account?: string; title?: string; from?: number; minutes?: number } = {},
): BlockItem["blocks"][number] => {
  const from = more.from ?? -2 * DAY;
  const minutes = more.minutes ?? 30;
  return {
    start: local(from),
    end: local(from + minutes * MINUTE),
    minutes,
    app,
    ...(more.title === undefined ? {} : { title: more.title }),
    ...(more.host === undefined ? {} : { host: more.host }),
    ...(more.account === undefined ? {} : { account: more.account }),
  };
};

async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  const answer = await reader.pushCapture(device.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).not.toBe("refused");
}

// Every connected label's calendar synced, ok, at `at`; then the drain.
async function calendarsAt(at: Date, only?: string): Promise<void> {
  for (const account of [accounts.personalCalendar, accounts.workCalendar]) {
    if (only === undefined || account.label === only)
      await writer.recordOutcome(account, "ok", at.toISOString() as never);
  }
}
async function drain(limit?: number): Promise<CaptureCounts> {
  await calendarsAt(new Date());
  return limit === undefined ? writer.takeCapture() : writer.takeCapture(limit);
}

// The (account kind) of an item's evidence.
const accountFor = (item: CaptureItem, device: Device = mac): string =>
  item.kind === "meeting"
    ? device.accounts.meetings
    : item.kind === "moment"
      ? device.accounts.activity
      : device.accounts.blocks;
const keyFp = (value: string): string => fingerprint(db.keys, "source_id", value);

type EvidenceRow = {
  id: string;
  source_account_id: string;
  source_kind: string;
  source_item_fp: string;
  revision: number;
  observed_at: Date;
  media_type: string;
  change_kind: string;
  participant_members: string[];
  system_originated: boolean;
  answers_system: boolean;
  compartments: string[];
  readers: string[];
  payload_state: string;
  blob_ref: string | null;
  item_enc: unknown;
};
const evidenceOf = (account: string, fp: string): Promise<EvidenceRow[]> =>
  admin<EvidenceRow>(
    `select id, source_account_id, source_kind, source_item_fp, revision, observed_at, media_type, change_kind, participant_members, system_originated, answers_system,
            compartments, readers, payload_state, blob_ref, item_enc from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision`,
    [account, fp],
  );
const evidenceFor = (item: CaptureItem, device: Device = mac): Promise<EvidenceRow[]> =>
  evidenceOf(accountFor(item, device), keyFp(item.key));

type CaptureRow = {
  id: string;
  evidence_id: string;
  source_account_id: string;
  capture_key: string;
  revision: number;
  kind: string;
  started_at: Date;
  ended_at: Date;
  event_id: string | null;
  first_pushed_at: Date;
  local_day: string;
  minutes: string | null;
  bundle_fp: string | null;
  host_fp: string | null;
  account_fp: string | null;
  thread_fp: string | null;
  match_fps: string[];
  facts_enc: unknown;
  compartments: string[];
};
const capturesOf = (key: string): Promise<CaptureRow[]> =>
  admin<CaptureRow>(
    `select id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day::text as local_day, minutes::text as minutes,
            bundle_fp, host_fp, account_fp, thread_fp, match_fps, facts_enc, compartments from knowledge.captures where capture_key = $1 order by compartments`,
    [key],
  );
const captureOf = async (item: CaptureItem): Promise<CaptureRow> => one(await capturesOf(item.key));

const factsOf = (row: CaptureRow): unknown =>
  JSON.parse(
    openUnder(
      db.keys,
      row.compartments,
      { table: "knowledge.captures", id: row.id, column: "facts_enc" },
      row.facts_enc as never,
    ),
  );
const itemEncOf = (row: EvidenceRow): unknown =>
  JSON.parse(
    openUnder(
      db.keys,
      row.compartments,
      { table: "vault.evidence_items", id: row.id, column: "item_enc" },
      row.item_enc as never,
    ),
  );
async function blobOf(row: EvidenceRow): Promise<string> {
  const blob = one(
    await admin<{ envelope: unknown }>("select envelope from vault.evidence_blobs where blob_ref = $1", [row.blob_ref]),
  );
  // The blob is sealed as base64, the repository's form for a raw payload (RawItem.payload).
  const sealed = openUnder(
    db.keys,
    row.compartments,
    { table: "vault.evidence_blobs", id: row.blob_ref ?? "", column: "envelope" },
    blob.envelope as never,
  );
  return Buffer.from(sealed, "base64").toString("utf8");
}
const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

type InboxRow = {
  id: string;
  kind: string;
  body: boolean;
  evidence_id: string | null;
  refused_code: string | null;
  taken_at: Date | null;
  received_at: Date;
};
const inboxOf = (item: CaptureItem, device: Device = mac): Promise<InboxRow[]> =>
  admin<InboxRow>(
    "select id, kind, body_enc is not null as body, evidence_id, refused_code, taken_at, received_at from ledger.capture_inbox where client_id = $1 and source_key_fp = $2 order by revision",
    [device.capture.id, keyFp(item.key)],
  );
// A meeting's facts carry its revision's push, its inbox row's received_at.
const pushedAtOf = async (item: CaptureItem): Promise<string> =>
  (await inboxOf(item)).at(-1)?.received_at.toISOString() ?? "";

// An inbox row written straight as pi_owner, as a race or a pruned row would leave it: the item
// sealed under `own`, bound to its row, its fingerprints as the push computes them.
async function insertInbox(
  item: CaptureItem,
  options: { receivedAt?: string; scopeFps?: string[] } = {},
  device: Device = mac,
): Promise<string> {
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
     values ($1, $2, $3, 'direct-batch', $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), '{own}', $11)`,
    [
      id,
      device.capture.id,
      sessionId,
      keyFp(item.key),
      item.kind === "forget" ? 0 : item.revision,
      item.kind,
      options.scopeFps ?? [],
      fingerprint(db.keys, "content_hash", sha256Hex(json)),
      Buffer.byteLength(json, "utf8"),
      options.receivedAt ?? null,
      JSON.stringify(sealRow(db.keys, "own", { table: "ledger.capture_inbox", id, column: "body_enc" }, json)),
    ],
  );
  return id;
}

// A claim on an item's evidence, as extraction would write it, by hand as pi_admin.
async function claimOn(evidenceId: string): Promise<string> {
  const id = sha256Hex(`drain claim ${evidenceId} ${randomBytes(4).toString("hex")}`);
  const row = one(
    await admin<{ compartments: string[] }>("select compartments from vault.evidence_items where id = $1", [
      evidenceId,
    ]),
  );
  await admin(
    `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
     select $1, e.id, 'commitment', now(), $3, 1, e.readers, $4::jsonb, e.compartments from vault.evidence_items e where e.id = $2`,
    [id, evidenceId, fingerprint(db.keys, "fact", `fact ${id}`), JSON.stringify(openableClaim(row.compartments, id))],
  );
  return id;
}
const openableClaim = (compartments: string[], id: string) => {
  // Sealed as one compartment's envelope when the label has one, else under the whole label.
  const at = { table: "knowledge.claims", id, column: "content_enc" };
  return compartments.length === 1
    ? sealRow(db.keys, compartments[0] ?? "own", at, "{}")
    : sealRowUnder(compartments, at);
};
const sealRowUnder = (compartments: string[], at: { table: string; id: string; column: string }) =>
  sealUnder(db.keys, compartments, at, "{}");

// Calendar events of the work label (employer:example), each as the calendar connector hands it.
const calendarEvent = (
  id: string,
  from: number,
  to: number,
  attendees: { email: string; displayName?: string; responseStatus?: "accepted" | "needsAction"; self?: boolean }[],
  organizer: { email: string; self?: boolean },
) =>
  event({
    event: {
      id,
      status: "confirmed",
      etag: `"etag-${id}"`,
      updated: utc(-3 * DAY),
      summary: `Event ${id}`,
      start: { dateTime: utc(from) },
      end: { dateTime: utc(to) },
      organizer,
      attendees,
    },
    title: `Event ${id}`,
    startsAt: utc(from),
    endsAt: utc(to),
    allDay: false,
  });
const ME_ACCEPTED = { email: OWNER.work, self: true, responseStatus: "accepted" as const };
// The linked meeting's event: an hour three hours ago, the owner accepting, Devon organizing.
const LINKED_EVENT = calendarEvent(
  "evdrainlinked01",
  -3 * HOUR,
  -2 * HOUR,
  [ME_ACCEPTED, { email: DEVON.address ?? "", displayName: DEVON.name ?? "", responseStatus: "accepted" }],
  { email: DEVON.address ?? "" },
);
// An accepted event that shares no one with the forged meetings.
const OTHER_EVENT = calendarEvent(
  "evdrainother001",
  -8 * HOUR,
  -7 * HOUR,
  [ME_ACCEPTED, { email: QUILL, responseStatus: "accepted" }],
  { email: QUILL },
);
const eventIdAt = async (from: number): Promise<string> =>
  one(
    await admin<{ id: string }>(
      "select event_id as id from knowledge.event_details where account_id = $1 and starts_at = $2",
      [accounts.workCalendar.id, utc(from)],
    ),
  ).id;

// The captures, the counts and the stored scope of these tests.
beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"], restricted: ["health"] });
  await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log: eventLogger(), journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log: eventLogger() });
  accounts = await connect(writer);
  // Both labels connected, as `pi google connect` leaves them.
  for (const label of ["personal", "work"]) {
    await insertSecret(
      db,
      `google/${label}/client`,
      JSON.stringify({
        clientId: "sentinel-client-id",
        clientSecret: "sentinel-client-secret",
        compartment: label === "work" ? "employer:example" : "own",
      }),
    );
    await insertSecret(db, `google/${label}/refresh_token`, `sentinel-refresh-${label}`);
  }
  // The world's device at a `now` three days back, so all its items are over.
  lens = fakeLens({ now: new Date(T - 3 * DAY) });
  mac = await addDevice("mac");
  for (const rule of lens.scope) await insertScope(rule);
  for (const rule of [
    {
      match: "host",
      value: "mail.google.com",
      account: OWNER.work,
      compartment: "employer:example",
      kinds: ["moment"],
    },
    { match: "host", value: "mail.google.com", account: ALT_WORK, compartment: "employer:example", kinds: ["moment"] },
    { match: "bundle", value: ABSENT.bundle, compartment: "employer:absent", kinds: ["moment"] },
  ] satisfies Rule[]) {
    await insertScope(rule);
  }
  await ingestEvent(writer, accounts.workCalendar, LINKED_EVENT);
  await ingestEvent(writer, accounts.workCalendar, OTHER_EVENT);
}, TIMEOUT);

afterEach(async () => {
  // Nothing a test left waiting reaches the next one's counts.
  await admin("delete from ledger.capture_inbox where evidence_id is null and taken_at is null");
});

afterAll(async () => {
  await reader?.close();
  await writer?.close();
  await db?.drop();
});

const world = <K extends keyof LensWorld["handles"]>(handle: K): MeetingItem | MomentItem => {
  const found = [...lens.meetings, ...lens.moments].find((item) => item.key === lens.handles[handle]);
  if (found === undefined) throw new Error(`no item ${handle}`);
  return { ...structuredClone(found), key: keyOf(found.kind) } as MeetingItem | MomentItem;
};

describe("Writer.takeCapture: what it takes", { timeout: TIMEOUT }, () => {
  it("takeCapture selects inbox rows of kinds meeting, moment and block with a body, no evidence_id and no refused_code, oldest first, at most limit", async () => {
    const items = [
      moment(),
      moment({ text: "The alpha plan, third draft." }),
      moment({ text: "The alpha plan, fourth draft." }),
    ];
    for (const item of items) await push([item]);
    const first = await drain(2);
    expect(first).toMatchObject({ taken: 2, failed: 0 });
    // Oldest first: the two pushed first are stored, the third waits for the next run.
    expect(await Promise.all(items.map(async (item) => (await evidenceFor(item)).length))).toEqual([1, 1, 0]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    expect((await evidenceFor(items[2] as MomentItem)).length).toBe(1);
  });

  it("the drain takes no forget", async () => {
    const item = moment();
    const forget: ForgetItem = { kind: "forget", key: keyOf("forget"), keys: [item.key] };
    await push([item]);
    await push([forget]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0, waiting: 0 });
    // The forget is untouched: its body is there and nothing took it. The moment it names is stored.
    expect(await inboxOf(forget)).toMatchObject([
      { kind: "forget", body: true, taken_at: null, evidence_id: null, refused_code: null },
    ]);
    expect((await evidenceFor(item)).length).toBe(1);
  });

  it("a meeting waits until a calendar sync of every connected label has completed after its end, and at most 24 hours", async () => {
    const recent = meeting({ startedAt: local(-90 * MINUTE), endedAt: local(-60 * MINUTE) });
    const old = meeting({ startedAt: local(-26 * HOUR), endedAt: local(-25 * HOUR) });
    await push([recent, old]);
    // Both calendars last completed before either ended: the old one, past 24 hours, is taken.
    await calendarsAt(new Date(T - 26 * HOUR));
    expect(await writer.takeCapture()).toMatchObject({ taken: 1, waiting: 1, failed: 0 });
    expect((await evidenceFor(old)).length).toBe(1);
    expect((await evidenceFor(recent)).length).toBe(0);
    // One label's calendar completed after its end, the other's not: it still waits.
    await calendarsAt(new Date(T - 2 * HOUR));
    await calendarsAt(new Date(Date.now()), "personal");
    expect(await writer.takeCapture()).toMatchObject({ taken: 0, waiting: 1 });
    expect(await inboxOf(recent)).toMatchObject([{ body: true, evidence_id: null }]);
    // Every connected label's calendar completed after it ended: taken.
    await calendarsAt(new Date(Date.now()));
    expect(await writer.takeCapture()).toMatchObject({ taken: 1, waiting: 0 });
    expect((await evidenceFor(recent)).length).toBe(1);
  });

  it("a row whose key the key file lacks waits and holds back no other", async () => {
    // A rule for a compartment the key file does not hold, as a restore that lost a key leaves it.
    const lacking = moment({ app: ABSENT, url: undefined, text: "Under a key the file lacks." });
    delete (lacking as { url?: string }).url;
    const fine = moment();
    await push([lacking, fine]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, waiting: 1, failed: 0 });
    expect((await evidenceFor(lacking)).length).toBe(0);
    expect(await inboxOf(lacking)).toMatchObject([{ body: true, evidence_id: null, refused_code: null }]);
    expect((await evidenceFor(fine)).length).toBe(1);
    // It waits again at the next run, and is counted again.
    expect(await drain()).toMatchObject({ taken: 0, waiting: 1 });
  });

  it("a row whose transaction fails is counted failed and the drain goes on", async () => {
    // The database refuses one row's capture row: a check only its day trips.
    const refused = moment({ observedAt: "2001-02-03T10:00:00-05:00", endedAt: "2001-02-03T10:05:00-05:00" });
    const fine = moment();
    await push([refused, fine]);
    await asOwner(
      "alter table knowledge.captures add constraint test_refuses_one check (local_day <> '2001-02-03') not valid",
    );
    try {
      const counts = await drain();
      expect(counts).toMatchObject({ taken: 1, failed: 1 });
      // Rolled back whole: no evidence, no blob, no capture row; the inbox row still waits.
      expect((await evidenceFor(refused)).length).toBe(0);
      expect(await capturesOf(refused.key)).toEqual([]);
      expect(await inboxOf(refused)).toMatchObject([
        { body: true, evidence_id: null, refused_code: null, taken_at: null },
      ]);
      expect((await evidenceFor(fine)).length).toBe(1);
    } finally {
      await asOwner("alter table knowledge.captures drop constraint test_refuses_one");
    }
    // The next run tries it again.
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    expect((await evidenceFor(refused)).length).toBe(1);
  });

  it("a push whose evidence row exists after its inbox row is pruned is replayed at drain", async () => {
    const item = moment();
    await push([item]);
    expect(await drain()).toMatchObject({ taken: 1 });
    // The inbox row pruned, as 30 days after its taking; the same key and revision pushed again.
    await admin("delete from ledger.capture_inbox where client_id = $1 and source_key_fp = $2", [
      mac.capture.id,
      keyFp(item.key),
    ]);
    await push([item]);
    const counts = await drain();
    expect(counts.failed).toBe(0);
    expect((await evidenceFor(item)).length).toBe(1);
    expect(await capturesOf(item.key)).toHaveLength(1);
    // The row is done with, not left waiting: its body is gone.
    expect(await inboxOf(item)).toMatchObject([{ body: false }]);
  });

  it("inbox rows keep their fingerprints for 30 days after they are taken, then are deleted by the drain", async () => {
    const [kept, pruned] = [moment(), moment()];
    await push([kept, pruned]);
    await drain();
    // Each row's body is null from the moment it is taken.
    expect((await inboxOf(kept))[0]).toMatchObject({ body: false });
    // Their takings moved back as pi_owner: pi_admin's update reaches a forget's row alone, so as
    // pi_admin these would change no row.
    await asOwner(
      "update ledger.capture_inbox set taken_at = now() - interval '29 days' where source_key_fp = $1",
      [keyFp(kept.key)],
      "ledger.capture_inbox",
    );
    await asOwner(
      "update ledger.capture_inbox set taken_at = now() - interval '31 days' where source_key_fp = $1",
      [keyFp(pruned.key)],
      "ledger.capture_inbox",
    );
    await drain();
    expect(await inboxOf(kept)).toHaveLength(1);
    expect(await inboxOf(pruned)).toEqual([]);
    // What was stored stays.
    expect((await evidenceFor(pruned)).length).toBe(1);
  });
});

describe("Writer.takeCapture: what it stores", { timeout: TIMEOUT }, () => {
  it("the evidence row has the device's source account of the kind, the key's fingerprint, the item's revision and time, application/json, live, the owner alone, the label and the sealed CaptureFacts; the blob is captureBlock(item) under the whole label", async () => {
    const item = moment();
    const talk = meeting();
    await push([item, talk]);
    expect(await drain()).toMatchObject({ taken: 2, failed: 0 });
    for (const [one_, kind, observed] of [
      [item, "screen_activity", item.observedAt],
      [talk, "transcript", talk.startedAt],
    ] as const) {
      const row = one(await evidenceFor(one_));
      expect(row).toMatchObject({
        source_account_id: accountFor(one_),
        source_kind: kind,
        source_item_fp: keyFp(one_.key),
        revision: 0,
        media_type: "application/json",
        change_kind: "live",
        participant_members: ["m-owner"],
        system_originated: false,
        answers_system: false,
        compartments: ["own"],
        readers: ["m-owner"],
        payload_state: "present",
      });
      expect(row.source_item_fp).toMatch(/^[0-9a-f]{64}$/);
      expect(row.observed_at.getTime()).toBe(Date.parse(observed));
      expect(itemEncOf(row)).toEqual(
        captureFacts(one_, {
          linkedEvent: null,
          ...(one_.kind === "meeting" || one_.kind === "moment" ? { pushedAt: await pushedAtOf(one_) } : {}),
        }),
      );
      expect(await blobOf(row)).toBe(decoded(captureBlock(one_)));
      // The inbox row: its evidence, its time, and no body.
      expect(await inboxOf(one_)).toMatchObject([{ evidence_id: row.id, body: false, refused_code: null }]);
      expect((await inboxOf(one_))[0]?.taken_at).not.toBeNull();
    }
  });

  it("knowledge.captures holds one row for each stored item, citing its latest revision, with its kind, times, key, label and sealed CaptureFacts, and no text", async () => {
    const item = moment();
    await push([item]);
    await drain();
    const row = await captureOf(item);
    const evidence = one(await evidenceFor(item));
    expect(row).toMatchObject({
      evidence_id: evidence.id,
      source_account_id: mac.accounts.activity,
      capture_key: item.key,
      revision: 0,
      kind: "moment",
      event_id: null,
      minutes: null,
      compartments: ["own"],
    });
    expect(row.id).toMatch(/^cap_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.started_at.getTime()).toBe(Date.parse(item.observedAt));
    expect(row.ended_at.getTime()).toBe(Date.parse(item.endedAt));
    for (const fp of [row.bundle_fp, row.host_fp, row.thread_fp]) expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // No account on the item, so no account fingerprint.
    expect(row.account_fp).toBeNull();
    expect(factsOf(row)).toEqual(captureFacts(item, { linkedEvent: null, pushedAt: await pushedAtOf(item) }));
    expect(JSON.stringify(factsOf(row))).not.toContain(item.text);
  });

  it("first_pushed_at is the earliest push of the key and a later revision leaves it", async () => {
    const first = moment();
    // Its first push, a day ago, as an earlier sync's inbox row would hold it.
    await push([moment({ text: "a row only for the session" })]);
    await insertInbox(first, {
      receivedAt: utc(-DAY),
      scopeFps: [
        fingerprint(db.keys, "capture_scope", READER.bundle),
        fingerprint(db.keys, "capture_scope", "wiki.example.org"),
      ],
    });
    await drain();
    expect((await captureOf(first)).first_pushed_at.getTime()).toBe(T - DAY);
    const next: MomentItem = { ...first, revision: 1, text: "The alpha plan, revised." };
    await push([next]);
    expect(await drain()).toMatchObject({ replaced: 1 });
    const row = await captureOf(next);
    expect(row.revision).toBe(1);
    expect(row.first_pushed_at.getTime()).toBe(T - DAY);
  });

  it("local_day is the date of the item's own time as written, so a moment at 23:30 at an offset of -05:00 has that day, not the next", async () => {
    const late = moment({ observedAt: "2026-10-04T23:30:00-05:00", endedAt: "2026-10-04T23:35:00-05:00" });
    const talk = meeting({ startedAt: "2026-10-03T22:45:00-05:00", endedAt: "2026-10-03T23:15:00-05:00" });
    const day = blockDay([block(READER, { host: "wiki.example.org" })], { day: "2026-10-02" });
    await push([late, talk, day]);
    await drain();
    expect((await captureOf(late)).local_day).toBe("2026-10-04");
    expect((await captureOf(talk)).local_day).toBe("2026-10-03");
    expect((await captureOf(day)).local_day).toBe("2026-10-02");
  });

  it("a stored meeting's and moment's match_fps are exactly the anchor fingerprints of captureMatchKeys of the item, and a block day's are empty", async () => {
    const doc = moment({
      url: "https://wiki.example.org/teams/alpha/plan",
      document: "~/Projects/alpha/plan.md",
      repository: "git.example.org/alpha/plan",
    });
    const talk = meeting({
      host: "meet.example.org",
      calendar: { start: local(-30 * HOUR), end: local(-29 * HOUR), uid: "series-0001@example.org", attendees: [] },
    });
    // The host rule a browser meeting matches.
    await insertScope({ match: "host", value: "meet.example.org", compartment: "own", kinds: ["meeting"] });
    // A block's attributes add no stored key.
    const day = blockDay([
      {
        ...block(READER, { host: "wiki.example.org" }),
        repository: { value: "git.example.org/alpha/plan", method: "git_remote", v: 1 },
        folder: { value: "~/Projects/alpha", method: "ax_document", v: 1 },
      },
    ]);
    await push([doc, talk, day]);
    await drain();
    const anchors = (item: MeetingItem | MomentItem): string[] =>
      captureMatchKeys(item)
        .map((key) => fingerprint(db.keys, "anchor", key))
        .sort();
    expect(anchors(doc).length).toBeGreaterThan(4);
    expect([...(await captureOf(doc)).match_fps].sort()).toEqual(anchors(doc));
    expect([...(await captureOf(talk)).match_fps].sort()).toEqual(anchors(talk));
    expect((await captureOf(day)).match_fps).toEqual([]);
  });

  it("a capture item creates no entity, account, alias, interaction or event row", async () => {
    const tables = [
      "knowledge.entities",
      "knowledge.accounts",
      "knowledge.aliases",
      "knowledge.interaction_log",
      "knowledge.events",
      "knowledge.event_participants",
    ];
    const before = await Promise.all(tables.map((table) => count(table)));
    const stranger: CaptureMention = { name: "Nobody Seenbefore", address: "nobody.seenbefore@example.net" };
    await push([
      meeting({
        speakers: [
          { label: "S1", owner: true, mention: { address: OWNER.personal } },
          { label: "S2", owner: false, mention: stranger },
        ],
        calendar: { start: local(-30 * HOUR), end: local(-29 * HOUR), organizer: stranger, attendees: [stranger] },
      }),
      moment({ participants: [stranger, { handle: "never-seen" }] }),
    ]);
    expect(await drain()).toMatchObject({ taken: 2 });
    expect(await Promise.all(tables.map((table) => count(table)))).toEqual(before);
  });

  it("a higher revision replaces, expires the earlier blob, and removes its claims", async () => {
    const first = moment();
    await push([first]);
    await drain();
    const earlier = one(await evidenceFor(first));
    const claim = await claimOn(earlier.id);
    const next: MomentItem = { ...first, revision: 1, text: "The alpha plan, final." };
    await push([next]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    const rows = await evidenceFor(next);
    expect(
      rows.map((row) => ({ revision: row.revision, state: row.payload_state, blob: row.blob_ref !== null })),
    ).toEqual([
      { revision: 0, state: "expired", blob: false },
      { revision: 1, state: "present", blob: true },
    ]);
    expect(await count("vault.evidence_blobs", "blob_ref = $1", [earlier.blob_ref])).toBe(0);
    expect(await count("knowledge.claims", "id = $1", [claim])).toBe(0);
    const row = await captureOf(next);
    expect(row).toMatchObject({ revision: 1, evidence_id: rows[1]?.id });
    expect(await blobOf(rows[1] as EvidenceRow)).toBe(decoded(captureBlock(next)));
  });
});

describe("Writer.takeCapture: the label", { timeout: TIMEOUT }, () => {
  it("a moment in scope under own is stored {own} whatever the mirror client's clearance", async () => {
    // The device's mirror client is cleared for both compartments (beforeAll); a second device's for own alone.
    const narrow = await addDevice("narrow", ["own"]);
    const [wide, small] = [moment(), moment()];
    await push([wide]);
    await push([small], narrow);
    await drain();
    expect((await captureOf(wide)).compartments).toEqual(["own"]);
    expect((await captureOf(small)).compartments).toEqual(["own"]);
    expect(one(await evidenceFor(small, narrow)).compartments).toEqual(["own"]);
    // The control: the scope rule's compartment is what moves a label.
    const work = moment({
      app: SAFARI,
      url: "https://mail.google.com/mail/u/1/inbox",
      account: ALT_WORK,
      entity: "mail",
    });
    await push([work]);
    await drain();
    expect((await captureOf(work)).compartments).toEqual(["employer:example"]);
  });

  it("a meeting linked to an employer:example event is stored {employer:example, own}", async () => {
    const linked = meeting({
      startedAt: local(-3 * HOUR + 5 * MINUTE),
      endedAt: local(-2 * HOUR),
      speakers: [
        { label: "S1", owner: true, mention: { address: OWNER.work } },
        { label: "S2", owner: false, mention: DEVON },
      ],
      calendar: { start: local(-3 * HOUR), end: local(-2 * HOUR), title: "Rota review", attendees: [DEVON] },
    });
    await push([linked]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const row = await captureOf(linked);
    expect(row.compartments).toEqual(["employer:example", "own"]);
    expect(one(await evidenceFor(linked)).compartments).toEqual(["employer:example", "own"]);
    expect(row.event_id).toBe(await eventIdAt(-3 * HOUR));
  });

  it("a moment holding an on category's term past its first 2 000 code points carries restricted:<category>", async () => {
    const filler = "plain words about the garden ".repeat(90);
    expect([...filler].length).toBeGreaterThan(2_000);
    const deep = moment({ text: `${filler}and the lab results are in` });
    const clean = moment({ text: `${filler}and the roses are in` });
    // A meeting's screen runs over meetingText, every window of it.
    const talk = meeting({
      segments: [
        { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: filler.slice(0, 2_500) },
        { speaker: "S2", fromMs: 20_000, toMs: 40_000, channel: "output", text: "The diagnosis came back fine." },
      ],
    });
    await push([deep, clean, talk]);
    expect(await drain()).toMatchObject({ taken: 3, failed: 0 });
    expect((await captureOf(deep)).compartments).toEqual(["own", "restricted:health"]);
    expect(one(await evidenceFor(deep)).compartments).toEqual(["own", "restricted:health"]);
    expect((await captureOf(talk)).compartments).toEqual(["own", "restricted:health"]);
    // The control: the same text without the term.
    expect((await captureOf(clean)).compartments).toEqual(["own"]);
  });

  it("a block day with blocks of two compartments makes two items", async () => {
    const day = structuredClone(lens.blocks[0] as BlockItem);
    day.key = keyOf("block");
    const [ownBlock, workBlock] = day.blocks;
    await push([day]);
    await drain();
    const rows = await capturesOf(day.key);
    expect(rows.map((row) => row.compartments)).toEqual([["employer:example"], ["own"]]);
    for (const [compartment, kept] of [
      ["own", ownBlock],
      ["employer:example", workBlock],
    ] as const) {
      const evidence = one(await evidenceOf(mac.accounts.blocks, keyFp(`${day.key}#${compartment}`)));
      expect(evidence).toMatchObject({ source_kind: "time_block", compartments: [compartment], revision: 0 });
      const cut: BlockItem = { ...day, blocks: [kept as BlockItem["blocks"][number]] };
      expect(await blobOf(evidence)).toBe(decoded(captureBlock(cut)));
      const row = rows.find((one_) => one_.compartments[0] === compartment) as CaptureRow;
      expect(row).toMatchObject({ kind: "block", capture_key: day.key, evidence_id: evidence.id, match_fps: [] });
      expect(Number(row.minutes)).toBe(kept?.minutes);
    }
    // No evidence under the plain key.
    expect(await evidenceOf(mac.accounts.blocks, keyFp(day.key))).toEqual([]);
  });

  it("a client cleared only for own sees none of the wider ones, and its results are those of a store without them", async () => {
    const narrow = await insertClient(db, "own-only-reader", ["own"]);
    const wide = await insertClient(db, "both-reader", ["own", "employer:example"]);
    const seen = (client: TestClient) =>
      readAs(db, client.token, (query) =>
        query<{ id: string; compartments: string[]; kind: string }>(
          "select id, compartments, kind from knowledge.captures order by id",
        ),
      );
    await push([moment()]);
    await drain();
    const [narrowBefore, wideBefore] = [await seen(narrow), await seen(wide)];
    expect(narrowBefore.length).toBeGreaterThan(0);
    // The wider items: an employer moment and an employer block split.
    const day = structuredClone(lens.blocks[0] as BlockItem);
    day.key = keyOf("block");
    await push([
      moment({ app: SAFARI, url: "https://mail.google.com/mail/u/1/inbox", account: ALT_WORK, entity: "mail" }),
      day,
    ]);
    await drain();
    const narrowAfter = await seen(narrow);
    // The own split of the block day is new to it, and nothing else.
    expect(narrowAfter.filter((row) => !narrowBefore.some((one_) => one_.id === row.id))).toEqual([
      expect.objectContaining({ compartments: ["own"], kind: "block" }),
    ]);
    expect(narrowAfter.every((row) => row.compartments.length === 1 && row.compartments[0] === "own")).toBe(true);
    // The control: the client cleared for both sees the two employer rows too.
    expect((await seen(wide)).length - wideBefore.length).toBe(3);
  });
});

describe("Writer.takeCapture: scope and drops", { timeout: TIMEOUT }, () => {
  it("an item out of scope, inserted straight into the inbox, is dropped at drain", async () => {
    // A push to own the session; the race's row is written as pi_owner.
    const fine = moment();
    await push([fine]);
    const outside = world("outOfScopeMoment") as MomentItem;
    const id = await insertInbox(outside, { scopeFps: [fingerprint(db.keys, "capture_scope", outside.app.bundle)] });
    const counts = await drain();
    expect(counts.dropped.out_of_scope).toBe(1);
    expect(counts.taken).toBe(1);
    expect((await evidenceFor(outside)).length).toBe(0);
    expect(await capturesOf(outside.key)).toEqual([]);
    expect(
      one(
        await admin<{ body: boolean; evidence_id: string | null }>(
          "select body_enc is not null as body, evidence_id from ledger.capture_inbox where id = $1",
          [id],
        ),
      ),
    ).toEqual({ body: false, evidence_id: null });
    expect((await evidenceFor(fine)).length).toBe(1);
  });

  it("with no rule nothing is stored", async () => {
    // A database of its own: an item accepted under a rule, and then every rule removed, as the
    // owner's `pi lens scope remove` would leave the scope before the next sync.
    const bare = await createTestDatabase({ compartments: ["own", "employer:example"] });
    const bareWriter = createWriter({ url: bare.urls.writer, keys: bare.keys, log: eventLogger() });
    const bareReader = createReader({ url: bare.urls.reader, keys: bare.keys, log: eventLogger() });
    try {
      const device = await addDevice("mac", ["own"], bare);
      await insertScope({ match: "host", value: "wiki.example.org", compartment: "own", kinds: ["moment"] }, bare);
      const item = moment();
      const answer = await bareReader.pushCapture(device.capture.token, { batch: batch(), items: [item] });
      expect(answer).toEqual({ ok: true, value: { items: [{ key: item.key, outcome: "accepted" }] } });
      await queryAs(bare.urls.admin, "delete from policy.capture_scope");
      const counts = await bareWriter.takeCapture();
      expect(counts).toMatchObject({ taken: 0, failed: 0 });
      expect(counts.dropped.out_of_scope).toBe(1);
      for (const table of ["vault.evidence_items", "vault.evidence_blobs", "knowledge.captures"]) {
        expect(
          one(await queryAs<{ n: number }>(bare.urls.admin, `select count(*)::int as n from ${table}`)).n,
          table,
        ).toBe(0);
      }
    } finally {
      await bareReader.close();
      await bareWriter.close();
      await bare.drop();
    }
  });

  it("a block day's blocks that no rule admits are dropped at drain, and a Gmail block with no account with them", async () => {
    const day = blockDay([
      block(READER, { host: "wiki.example.org", from: -2 * DAY }),
      block({ bundle: "test.example.games", name: "Games" }, { from: -2 * DAY + HOUR }),
      block(SAFARI, { host: "mail.google.com", from: -2 * DAY + 2 * HOUR }),
    ]);
    await push([day]);
    await drain();
    const rows = await capturesOf(day.key);
    expect(rows.map((row) => row.compartments)).toEqual([["own"]]);
    const evidence = one(await evidenceOf(mac.accounts.blocks, keyFp(`${day.key}#own`)));
    expect(await blobOf(evidence)).toBe(
      decoded(captureBlock({ ...day, blocks: [day.blocks[0] as BlockItem["blocks"][number]] })),
    );
  });

  it("a moment holding an ent_ id, an mpr_ id or a stamp, in its text, its URL path or a mention, is dropped system_ids, and one holding a recovery code is dropped recovery, each leaving no evidence row", async () => {
    const ulid = "01JDRAWNSYSTEMXDS000000000";
    const tripped = [
      moment({ text: `See ent_${ulid} for the person.` }),
      moment({ url: `https://wiki.example.org/teams/mpr_${"a1".repeat(20)}` }),
      moment({ participants: [{ name: "[pi: a stamp", address: "stamp@example.org" }] }),
      moment({ participants: [{ handle: `cap_${ulid}` }] }),
      moment({ window: `Notes on msg_${ulid}` }),
      moment({ thread: `Thread mir_${"b2".repeat(20)}` }),
      moment({ document: `~/Projects/alpha/csr_${ulid}.md` }),
      meeting({ title: `Review of hdl_${ulid}` }),
    ];
    const recovery = [
      moment({ text: "Enter the verification code 551920 to continue." }),
      moment({ url: "https://wiki.example.org/reset-your-password/start" }),
      meeting({ title: "Your magic link" }),
    ];
    const clean = moment({ text: "An ordinary page about the alpha plan." });
    await push([...tripped, ...recovery, clean]);
    const counts = await drain();
    expect(counts.dropped.system_ids).toBe(tripped.length);
    expect(counts.dropped.recovery).toBe(recovery.length);
    expect(counts.taken).toBe(1);
    for (const item of [...tripped, ...recovery]) {
      expect((await evidenceFor(item)).length, item.key).toBe(0);
      expect(await capturesOf(item.key), item.key).toEqual([]);
      expect(await inboxOf(item), item.key).toMatchObject([{ body: false, evidence_id: null }]);
    }
    // The control: the clean moment is stored.
    expect((await evidenceFor(clean)).length).toBe(1);
  });

  it("a meeting with a recovery phrase in one segment is stored with that segment blank and the rest whole, and the blank is counted", async () => {
    const talk = world("recoveryMeeting") as MeetingItem;
    await push([talk]);
    expect(await drain()).toMatchObject({ taken: 1, failed: 0 });
    const blanked: MeetingItem = {
      ...talk,
      segments: talk.segments.map((segment) =>
        segment.text.includes("one-time code") ? { ...segment, text: "" } : segment,
      ),
    };
    expect(blanked.segments.filter((segment) => segment.text === "")).toHaveLength(1);
    const evidence = one(await evidenceFor(talk));
    expect(await blobOf(evidence)).toBe(decoded(captureBlock(blanked)));
    const facts = factsOf(await captureOf(talk)) as { counts: { blanked: number; segments: number } };
    expect(facts).toEqual(captureFacts(blanked, { linkedEvent: null, pushedAt: await pushedAtOf(talk) }));
    expect(facts.counts).toMatchObject({ blanked: 1, segments: 3 });
  });

  it("a mail moment whose account is a connected Google label is dropped connected_source", async () => {
    const own = moment({
      app: SAFARI,
      url: "https://mail.google.com/mail/u/1/inbox",
      account: OWNER.work,
      entity: "mail",
      text: "The rota for next week.",
    });
    // The control: an account an employer:example rule names, and no label's.
    const other = moment({
      app: SAFARI,
      url: "https://mail.google.com/mail/u/2/inbox",
      account: ALT_WORK,
      entity: "mail",
      text: "The rota for the week after.",
    });
    await push([own, other]);
    const counts = await drain();
    expect(counts.dropped.connected_source).toBe(1);
    expect((await evidenceFor(own)).length).toBe(0);
    expect(await capturesOf(own.key)).toEqual([]);
    expect((await captureOf(other)).compartments).toEqual(["employer:example"]);
  });
});

describe("Writer.takeCapture: every meeting is admitted", { timeout: TIMEOUT }, () => {
  const ZOOM = { bundle: "us.zoom.xos", name: "Zoom" };
  const UNRULED = { bundle: "test.example.unruled-calls", name: "Unruled calls" };
  const scoped = (value: string): string => fingerprint(db.keys, "capture_scope", value);

  it("a meeting no rule names, with no account, is stored {own} with its bundle and host kept; one with an account no rule or map names likewise, its account kept; both counted", async () => {
    const bare = meeting({ app: UNRULED, host: "calls.unruled.example.net", title: "Porch repair" });
    const zoomBare = { ...(world("noAccountMeeting") as MeetingItem) };
    const stranger = meeting({ app: ZOOM, account: "stranger.account@example.net", title: "Open line" });
    await push([bare, zoomBare, stranger]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 3, failed: 0, meetingsByDefault: 3, meetingsNoAccount: 2 });
    for (const item of [bare, zoomBare, stranger])
      expect((await captureOf(item)).compartments, item.title ?? item.key).toEqual(["own"]);
    expect(await captureOf(bare)).toMatchObject({
      kind: "meeting",
      bundle_fp: scoped(UNRULED.bundle),
      host_fp: scoped("calls.unruled.example.net"),
      account_fp: null,
    });
    expect(await captureOf(zoomBare)).toMatchObject({ bundle_fp: scoped(ZOOM.bundle), account_fp: null });
    expect(await captureOf(stranger)).toMatchObject({
      bundle_fp: scoped(ZOOM.bundle),
      account_fp: scoped("stranger.account@example.net"),
    });
    expect(one(await evidenceFor(bare)).compartments).toEqual(["own"]);
  });

  it("a meeting whose account a rule names takes the rule's compartment, and one whose account the account map names takes the map's; neither is counted by default", async () => {
    const ruled = world("accountMeeting") as MeetingItem;
    const mappedAccount = "mapped.work@employer-example.test";
    const id = testId("cac");
    await admin(
      "insert into policy.capture_accounts (id, account_fp, account_enc, compartment) values ($1, $2, $3, $4)",
      [
        id,
        scoped(mappedAccount),
        sealRow(db.keys, "own", { table: "policy.capture_accounts", id, column: "account_enc" }, mappedAccount),
        "employer:example",
      ],
    );
    const mapped = meeting({ app: ZOOM, account: mappedAccount, title: "Mapped call" });
    await push([ruled, mapped]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 2, meetingsByDefault: 1 });
    expect(counts.meetingsNoAccount).toBeUndefined();
    const rule = await captureOf(ruled);
    expect(rule.compartments).toContain("employer:example");
    expect(rule.compartments).not.toContain("own");
    expect(rule.account_fp).toBe(scoped(ruled.account ?? ""));
    expect((await captureOf(mapped)).compartments).toEqual(["employer:example"]);
  });

  it("a meeting of notes alone is stored with its notes in the blob and none in its facts; notes holding a recovery phrase are blanked", async () => {
    const notes = "Agreed the porch plan; the owner orders the tiles tomorrow.";
    const noted = meeting({ segments: [], notes, title: "Porch notes" });
    const risky = meeting({ notes: "Read me the one-time code from the text.", title: "Risky notes" });
    await push([noted, risky]);
    expect(await drain()).toMatchObject({ taken: 2, failed: 0 });
    expect(await blobOf(one(await evidenceFor(noted)))).toBe(decoded(captureBlock(noted)));
    expect(JSON.stringify(factsOf(await captureOf(noted)))).not.toContain("porch plan");
    expect(await blobOf(one(await evidenceFor(risky)))).toBe(decoded(captureBlock({ ...risky, notes: "" })));
  });

  it("a meeting on a host the exclude list names is still stored; a moment there is still dropped excluded", async () => {
    const host = "excluded-room.example.net";
    const id = testId("cex");
    await admin("insert into policy.capture_excludes (id, value_fp, value_enc) values ($1, $2, $3)", [
      id,
      scoped(host),
      sealRow(db.keys, "own", { table: "policy.capture_excludes", id, column: "value_enc" }, host),
    ]);
    await insertScope({ match: "host", value: host, compartment: "own", kinds: ["moment"] });
    const room = meeting({ app: { bundle: "com.google.Chrome", name: "Chrome" }, host, title: "Excluded room" });
    const page = moment({ url: `https://${host}/notes` });
    await push([room, page]);
    const counts = await drain();
    expect(counts.taken).toBe(1);
    expect(counts.dropped.excluded).toBe(1);
    expect((await captureOf(room)).compartments).toEqual(["own"]);
    expect(await capturesOf(page.key)).toEqual([]);
  });
});

describe("Writer.takeCapture: the link", { timeout: TIMEOUT }, () => {
  it("a meeting is linked to the overlapping event sharing a participant, and its CaptureFacts hold the event's owner-backing and each speaker's participant", async () => {
    const linked = meeting({
      key: keyOf("meeting"),
      startedAt: local(-3 * HOUR + 5 * MINUTE),
      endedAt: local(-2 * HOUR),
      speakers: [
        { label: "S1", owner: true, mention: { address: OWNER.work } },
        { label: "S2", owner: false, mention: DEVON },
      ],
      calendar: { start: local(-3 * HOUR), end: local(-2 * HOUR), attendees: [DEVON] },
    });
    // The second part of its series, after the event: linked with the first part.
    const first: MeetingItem = { ...linked, series: linked.key, part: 1 };
    const second = meeting({
      startedAt: local(-2 * HOUR),
      endedAt: local(-90 * MINUTE),
      series: linked.key,
      part: 2,
      speakers: first.speakers,
      calendar: first.calendar,
    });
    await push([first]);
    await push([second]);
    expect(await drain()).toMatchObject({ taken: 2, failed: 0 });
    const eventId = await eventIdAt(-3 * HOUR);
    const devon = one(
      await admin<{ entity_id: string }>("select entity_id from knowledge.event_participants where event_id = $1", [
        eventId,
      ]),
    ).entity_id;
    const row = await captureOf(first);
    expect(row.event_id).toBe(eventId);
    expect(factsOf(row)).toEqual(
      captureFacts(first, {
        linkedEvent: { id: eventId as never, ownerBacked: true, speakers: { S2: devon as never } },
        pushedAt: await pushedAtOf(first),
      }),
    );
    const part = await captureOf(second);
    expect(part.event_id).toBe(eventId);
    expect(part.compartments).toEqual(["employer:example", "own"]);
  });

  it("a forged long meeting overlapping an accepted event with no attendee in common links to nothing", async () => {
    const strangers = {
      speakers: [
        { label: "S1", owner: true, mention: { address: OWNER.work } },
        { label: "S2", owner: false, mention: { name: "Forger", address: "forger@example.net" } },
      ],
    };
    // Three hours around the accepted event, and one exactly on it: no address in common either way.
    const long = meeting({
      startedAt: local(-9 * HOUR),
      endedAt: local(-6 * HOUR),
      ...strangers,
      calendar: { start: local(-9 * HOUR), end: local(-6 * HOUR), attendees: [{ address: "forger@example.net" }] },
    });
    const exact = meeting({ startedAt: local(-8 * HOUR), endedAt: local(-7 * HOUR), ...strangers });
    // An address that is no strict addr-spec does not match.
    const named = meeting({
      startedAt: local(-8 * HOUR),
      endedAt: local(-7 * HOUR),
      speakers: [
        { label: "S1", owner: false, mention: { address: `Quill <${QUILL}>` } },
        { label: "S2", owner: false, mention: ROBIN },
      ],
    });
    await push([long, exact, named]);
    expect(await drain()).toMatchObject({ taken: 3, failed: 0 });
    for (const item of [long, exact, named]) {
      const row = await captureOf(item);
      expect(row.event_id, item.key).toBeNull();
      expect(row.compartments, item.key).toEqual(["own"]);
      expect((factsOf(row) as { linked: unknown }).linked, item.key).toBeNull();
    }
    // The control: the same span with the event's attendee as a speaker links.
    const sharing = meeting({
      startedAt: local(-8 * HOUR),
      endedAt: local(-7 * HOUR),
      speakers: [
        { label: "S1", owner: false, mention: { address: QUILL } },
        { label: "S2", owner: false, mention: ROBIN },
      ],
    });
    await push([sharing]);
    await drain();
    expect((await captureOf(sharing)).event_id).toBe(await eventIdAt(-8 * HOUR));
  });
});

describe("Writer.takeCapture: idempotency and a kill", { timeout: TIMEOUT }, () => {
  it("a batch sent twice stores once", async () => {
    const items = [moment(), meeting()];
    await push(items);
    await push(items);
    await drain();
    await push(items);
    expect(await drain()).toMatchObject({ taken: 0, failed: 0 });
    for (const item of items) {
      expect((await evidenceFor(item)).length).toBe(1);
      expect(await capturesOf(item.key)).toHaveLength(1);
    }
  });

  it("a higher revision replaces, expires the earlier blob, and removes its claims", async () => {
    const talk = meeting();
    await push([talk]);
    await drain();
    const earlier = one(await evidenceFor(talk));
    const claims = [await claimOn(earlier.id), await claimOn(earlier.id)];
    const retranscribed: MeetingItem = {
      ...talk,
      revision: 2,
      segments: [
        { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "I will order the tiles on Monday." },
      ],
    };
    await push([retranscribed]);
    expect(await drain()).toMatchObject({ replaced: 1, failed: 0 });
    expect((await evidenceFor(talk)).map((row) => [row.revision, row.payload_state])).toEqual([
      [0, "expired"],
      [2, "present"],
    ]);
    expect(await count("knowledge.claims", "id = any($1)", [claims])).toBe(0);
    expect(await count("vault.evidence_blobs", "blob_ref = $1", [earlier.blob_ref])).toBe(0);
    expect(await capturesOf(talk.key)).toHaveLength(1);
    expect((await captureOf(talk)).revision).toBe(2);
  });

  it("a revision that no longer holds a split removes it", async () => {
    const day = structuredClone(lens.blocks[0] as BlockItem);
    day.key = keyOf("block");
    await push([day]);
    await drain();
    expect((await capturesOf(day.key)).map((row) => row.compartments)).toEqual([["employer:example"], ["own"]]);
    // The day built again: only its own block.
    const grown: BlockItem = {
      ...day,
      revision: 1,
      blocks: [{ ...(day.blocks[0] as BlockItem["blocks"][number]), minutes: 45 }],
    };
    await push([grown]);
    expect(await drain()).toMatchObject({ failed: 0 });
    const rows = await capturesOf(day.key);
    expect(rows.map((row) => [row.compartments, row.revision])).toEqual([[["own"], 1]]);
    expect(Number(rows[0]?.minutes)).toBe(45);
    // The employer split's evidence is gone as a source deletion is: nothing of it is present.
    expect(
      await count(
        "vault.evidence_items",
        "source_account_id = $1 and source_item_fp = $2 and payload_state = 'present'",
        [mac.accounts.blocks, keyFp(`${day.key}#employer:example`)],
      ),
    ).toBe(0);
    expect(
      one(
        await evidenceOf(mac.accounts.blocks, keyFp(`${day.key}#own`)).then((all) =>
          all.filter((row) => row.payload_state === "present"),
        ),
      ).revision,
    ).toBe(1);
  });

  it("a sync killed at each step of the drain and run again ends with the same rows", async () => {
    // A database of its own with the inbox filled, copied once for the uninterrupted drain and
    // once for each kill. A kill is the database refusing one step's write; the run is then
    // repeated with the refusal gone.
    const source = await createTestDatabase({ compartments: ["own", "employer:example"] });
    const items: CaptureItem[] = [moment(), meeting(), structuredClone(lens.blocks[0] as BlockItem)];
    (items[2] as BlockItem).key = keyOf("block");
    try {
      await fill(source, items);
      const KILLS: { name: string; on: string; check: string }[] = [
        { name: "the blob", on: "vault.evidence_blobs", check: "false" },
        {
          name: "the evidence row",
          on: "vault.evidence_items",
          check: "source_kind not in ('transcript', 'screen_activity', 'time_block')",
        },
        { name: "the capture row", on: "knowledge.captures", check: "false" },
        { name: "the inbox row", on: "ledger.capture_inbox", check: "evidence_id is null" },
        { name: "the second item, after the first committed", on: "knowledge.captures", check: "kind = 'moment'" },
      ];
      const expected = await drained(source, null);
      expect(expected.captures).toHaveLength(4);
      for (const kill of KILLS) expect(await drained(source, kill), kill.name).toEqual(expected);
    } finally {
      await source.drop();
    }
  });
});

// Fills `target`'s inbox with `items` pushed by a device with the world's scope, and closes
// every connection it opened, so `target` can be copied.
async function fill(target: TestDatabase, items: CaptureItem[]): Promise<void> {
  const pushing = createReader({ url: target.urls.reader, keys: target.keys, log: eventLogger() });
  try {
    const device = await addDevice("mac", ["own"], target);
    for (const rule of lens.scope) await insertScope(rule, target);
    const answer = await pushing.pushCapture(device.capture.token, { batch: batch(), items });
    expect(answer).toEqual({
      ok: true,
      value: { items: items.map((item) => ({ key: item.key, outcome: "accepted" })) },
    });
  } finally {
    await pushing.close();
  }
}

// A copy of `source` drained, once refused at `kill` and once again without it; then its rows,
// without ids, times or envelopes.
async function drained(source: TestDatabase, kill: { on: string; check: string } | null) {
  const copy = await copyTestDatabase(source);
  const drainer = createWriter({ url: copy.urls.writer, keys: copy.keys, log: eventLogger() });
  const owner = async (sql: string) =>
    session(copy.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      await query(sql);
      await query("commit");
    });
  try {
    if (kill !== null) {
      await owner(`alter table ${kill.on} add constraint test_kill check (${kill.check}) not valid`);
      const killed = await drainer.takeCapture();
      expect(killed.failed).toBeGreaterThan(0);
      await owner(`alter table ${kill.on} drop constraint test_kill`);
    }
    const counts = await drainer.takeCapture();
    expect(counts.failed).toBe(0);
    const rows = <Row>(sql: string) => queryAs<Row>(copy.urls.admin, sql);
    const evidence = await rows<{ id: string; blob_ref: string; compartments: string[] }>(
      "select id, blob_ref, compartments from vault.evidence_items where source_kind in ('transcript', 'screen_activity', 'time_block') order by source_item_fp, revision",
    );
    const blobs: string[] = [];
    for (const row of evidence) {
      const blob = one(
        await queryAs<{ envelope: unknown }>(
          copy.urls.admin,
          "select envelope from vault.evidence_blobs where blob_ref = $1",
          [row.blob_ref],
        ),
      );
      blobs.push(
        openUnder(
          copy.keys,
          row.compartments,
          { table: "vault.evidence_blobs", id: row.blob_ref, column: "envelope" },
          blob.envelope as never,
        ),
      );
    }
    return {
      evidence: await rows(
        `select source_account_id, source_kind, source_item_fp, revision, observed_at, compartments, readers, payload_state, media_type, change_kind
         from vault.evidence_items where source_kind in ('transcript', 'screen_activity', 'time_block') order by source_item_fp, revision`,
      ),
      blobs,
      blobRows: one(await rows<{ n: number }>("select count(*)::int as n from vault.evidence_blobs")).n,
      captures: await rows(
        `select source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day::text, minutes::text, bundle_fp, host_fp, account_fp, thread_fp, match_fps, compartments
         from knowledge.captures order by capture_key, compartments`,
      ),
      inbox: await rows(
        "select source_key_fp, revision, kind, refused_code, body_enc is null as bodiless, evidence_id is not null as taken, taken_at is not null as done from ledger.capture_inbox order by source_key_fp",
      ),
    };
  } finally {
    await drainer.close();
    await copy.drop();
  }
}

describe("the canaries", { timeout: TIMEOUT }, () => {
  it("a canary in a meeting's text, a moment's text, a URL, a host, a bundle id, a title, a document path, a repository, a calendar UID, a speaker's name and address is in no column of any table, nor its plain SHA-256, before and after drain", async () => {
    const C = {
      meetingText: "canary-lens-meeting-text-7c1e",
      momentText: "canary-lens-moment-text-7c1e",
      urlPath: "canary-lens-url-path-7c1e",
      host: "canary-lens-host-7c1e.example.org",
      urlHost: "canary-lens-urlhost-7c1e.example.org",
      bundle: "test.canary.lensbundle7c1e",
      title: "canary-lens-title-7c1e",
      document: "canary-lens-document-7c1e",
      repository: "canary-lens-repo-7c1e",
      uid: "canary-lens-uid-7c1e@example.org",
      speakerName: "Canarylens Speakerperson",
      speakerAddress: "canary.lens.speaker7c1e@example.org",
    };
    await insertScope({ match: "host", value: C.host, compartment: "own", kinds: ["meeting"] });
    await insertScope({ match: "host", value: C.urlHost, compartment: "own", kinds: ["moment"] });
    const app = { bundle: C.bundle, name: "Canary" };
    const talk = meeting({
      app,
      host: C.host,
      title: C.title,
      calendar: {
        start: local(-30 * HOUR),
        end: local(-29 * HOUR),
        uid: C.uid,
        attendees: [{ name: C.speakerName, address: C.speakerAddress }],
      },
      speakers: [
        { label: "S1", owner: true, mention: { address: OWNER.personal } },
        { label: "S2", owner: false, mention: { name: C.speakerName, address: C.speakerAddress } },
      ],
      segments: [
        { speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: `We said ${C.meetingText} twice.` },
      ],
    });
    const seen = moment({
      app,
      url: `https://${C.urlHost}/${C.urlPath}/notes`,
      window: C.title,
      text: `The page says ${C.momentText}.`,
      document: `~/Projects/${C.document}/notes.md`,
      repository: `git.example.org/alpha/${C.repository}`,
      participants: [{ name: C.speakerName, address: C.speakerAddress }],
    });
    const needles = Object.values(C).flatMap((value) => [value, sha256Hex(value)]);
    await push([talk, seen]);
    expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);
    expect(await drain()).toMatchObject({ taken: 2, failed: 0 });
    expect((await evidenceFor(talk)).length).toBe(1);
    expect((await evidenceFor(seen)).length).toBe(1);
    expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);
    // The control: the sealed facts do hold them.
    expect(JSON.stringify(factsOf(await captureOf(seen)))).toContain(C.urlPath);
  });
});

// The world's source moments, each under a key of its own; the source rule is added by the first
// test and stands for the rest of the file, beside the world's rules.
describe("Writer.takeCapture: source moments", { timeout: TIMEOUT }, () => {
  const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
  const source = (
    handle: "sourceMoment" | "sourceMomentLater" | "groupSourceMoment" | "messagesScreenMoment",
    over: Partial<MomentItem> = {},
  ): MomentItem => {
    const found = lens.sources.find((item) => item.key === lens.handles[handle]);
    if (found === undefined) throw new Error(`no source moment ${handle}`);
    return { ...structuredClone(found), key: keyOf("moment"), ...over };
  };
  // One message from one participant, as Lens sends a session of one line.
  const oneLine = (text: string): MomentItem => {
    const item = source("sourceMoment");
    const at = item.turns?.[0]?.at ?? item.observedAt;
    return {
      ...item,
      text,
      observedAt: at,
      endedAt: at,
      turns: [{ from: 0, to: text.length, speaker: "participant", participant: 0, at }],
    };
  };

  it("a source moment's thread is its key, so one key's two titles group and two keys' one title do not; its facts hold its source and handles", async () => {
    await insertScope({
      match: "bundle",
      value: MESSAGES.bundle,
      compartment: "own",
      kinds: ["moment"],
      source: "imessage",
    });
    const THREAD = "chat:01JDRAWNTHREADKEY000000001";
    const OTHER = "chat:01JDRAWNTHREADKEY000000002";
    const first = source("sourceMoment", { threadKey: THREAD, thread: "Climbing" });
    const renamed = source("sourceMomentLater", { threadKey: THREAD, thread: "Saturday climbing" });
    const another = source("sourceMomentLater", { threadKey: OTHER, thread: "Climbing" });
    await push([first, renamed, another]);
    expect(await drain()).toMatchObject({ taken: 3, failed: 0 });
    const [a, b, c] = [await captureOf(first), await captureOf(renamed), await captureOf(another)];
    expect(a.thread_fp).toBe(fingerprint(db.keys, "thread", THREAD));
    expect(b.thread_fp).toBe(a.thread_fp);
    expect(c.thread_fp).toBe(fingerprint(db.keys, "thread", OTHER));
    expect(c.thread_fp).not.toBe(a.thread_fp);
    // The facts seal its source and each handle as its mention; the row keeps the source in clear.
    expect(factsOf(a)).toMatchObject({
      kind: "moment",
      entity: "chat",
      source: "imessage",
      thread: "Climbing",
      participants: first.participants,
    });
    expect(first.participants).toEqual([{ handle: "+15555550101" }]);
    expect(
      await admin("select source from knowledge.captures where capture_key = any($1) order by capture_key", [
        [first.key, renamed.key, another.key],
      ]),
    ).toEqual([{ source: "imessage" }, { source: "imessage" }, { source: "imessage" }]);
    // The thread key is no title: it is in no title fingerprint and nowhere in clear.
    expect(await scanForPlaintext(db.urls.admin, [THREAD, OTHER])).toEqual([]);
  });

  it("a source moment holding a system id or a recovery marker is dropped whole, as any moment; the counts by device show it", async () => {
    const tripped = oneLine(`See ent_01JDRAWNSYSTEMXDS000000000 for the person.`);
    const marked = oneLine("Enter the verification code 551920 to continue.");
    const clean = oneLine("See you at the gym at ten, I will bring the rope.");
    await push([tripped, marked, clean]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    expect(counts.dropped).toMatchObject({ system_ids: 1, recovery: 1 });
    expect(await capturesOf(tripped.key)).toEqual([]);
    expect(await capturesOf(marked.key)).toEqual([]);
    expect(await capturesOf(clean.key)).toHaveLength(1);
    const pool = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
    try {
      const view = (await new Admin({ pool, keys: db.keys, log: eventLogger() }).lens.devices()).find(
        (one) => one.name === "mac",
      );
      const stored = await count("knowledge.captures", "source is not null and source_account_id = $1", [
        mac.accounts.activity,
      ]);
      expect(stored).toBeGreaterThanOrEqual(4);
      expect(view?.sourceMoments).toEqual({ stored, dropped: { recovery: 1, system_ids: 1 } });
    } finally {
      await pool.end();
    }
  });

  it("at drain: a Messages moment read from the screen and pushed before the screen rule is dropped out_of_scope, though a plain rule names the bundle", async () => {
    await insertScope({ match: "bundle", value: MESSAGES.bundle, compartment: "own", kinds: ["moment", "block"] });
    // A push to own the session; the old build's row is written as pi_owner.
    const fine = oneLine("Running ten minutes late, sorry.");
    await push([fine]);
    const screen = source("messagesScreenMoment");
    const id = await insertInbox(screen, { scopeFps: [fingerprint(db.keys, "capture_scope", MESSAGES.bundle)] });
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, failed: 0 });
    expect(counts.dropped.out_of_scope).toBe(1);
    expect(await capturesOf(screen.key)).toEqual([]);
    expect(
      one(
        await admin<{ code: string | null }>("select refused_code as code from ledger.capture_inbox where id = $1", [
          id,
        ]),
      ).code,
    ).toBe("out_of_scope");
    // The control: the source moment pushed beside it is stored, under the source rule alone.
    expect(await capturesOf(fine.key)).toHaveLength(1);
  });
});

describe("Writer.takeCapture: Mac contacts are not captures", { timeout: TIMEOUT }, () => {
  it("a contact row and a listing row stay untaken, with no code and their bodies, and no capture row is made", async () => {
    await queryAs(db.urls.admin, "update policy.lens_devices set contacts = true where capture_client_id = $1", [
      mac.capture.id,
    ]);
    const contact = {
      kind: "contact",
      key: "contact:01JMACCDRAWN00000000000001",
      revision: 0,
      name: "Lena Ortiz",
      phones: ["+15555550100"],
      emails: [],
    };
    const listing = { kind: "contacts", key: "contacts:01JMACCDRAWN00000000000002", revision: 0, keys: [contact.key] };
    await push([contact, listing] as unknown as CaptureItem[]);
    const before = await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from knowledge.captures");
    const counts = await drain();
    expect(counts.failed).toBe(0);
    expect(counts.dropped).not.toHaveProperty("invalid_item");
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.captures")).toEqual(before);
    const rows = await queryAs<{ kind: string; taken: boolean; code: string | null; body: boolean }>(
      db.urls.admin,
      "select kind, taken_at is not null as taken, refused_code as code, body_enc is not null as body from ledger.capture_inbox where kind in ('contact', 'contacts') and client_id = $1 order by kind",
      [mac.capture.id],
    );
    expect(rows).toEqual([
      { kind: "contact", taken: false, code: null, body: true },
      { kind: "contacts", taken: false, code: null, body: true },
    ]);
    await queryAs(db.urls.admin, "update policy.lens_devices set contacts = false where capture_client_id = $1", [
      mac.capture.id,
    ]);
  });
});
