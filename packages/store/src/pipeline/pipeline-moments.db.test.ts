import { randomBytes } from "node:crypto";
import type { EvidenceId, ModelCallRecord, Timestamp } from "@intelligence/contracts";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type DueCapture,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  type DocBody,
  type DriveFile,
  deriveItem,
  driveItem,
  type ItemContext,
} from "@intelligence/personal-core/items";
import { activityTable } from "@intelligence/personal-core/lens";
import { afterAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealRow } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { insertScopeRule as insertScope, type ScopeRule } from "../test-support/lens-setup.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { createPipeline, type Pipeline } from "./pipeline.ts";

// The store's pipeline side of the moment lane. Called through createPipeline as pi_pipeline. No
// model is called and nothing of @intelligence/personal-extract is imported.
//
// One world for the file, built once and copied for each test (copiesOf): one device registered by
// hand as pipeline-captures.db.test.ts registers it, five scope rules, one Google Doc stored under a
// Drive root of the personal label, and moments and a block day pushed through Reader.pushCapture
// and taken by Writer.takeCapture. Every time is written with the Mac's offset of -05:00, on local
// days four and three days before now. `settledBefore` is the tests' own, so the settle rule is
// read against it and not against the clock. Every refusal has its positive control.

const TIMEOUT = 240_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
// The n-th local day of the world, and a local time on it as Lens writes one, and as UTC.
const dayOf = (n: number): string => new Date(T - 4 * DAY + n * DAY - 5 * HOUR).toISOString().slice(0, 10);
const local = (n: number, hhmm: string): string => `${dayOf(n)}T${hhmm}:00-05:00`;
const utc = (n: number, hhmm: string): Timestamp => new Date(Date.parse(local(n, hhmm))).toISOString() as Timestamp;
// Later than every moment of the world: every group settled.
const SETTLED = utc(2, "23:59");
const GENERATION = 1;

type Channel = { id: string; name: string; token: string };
type Device = { capture: Channel; accounts: { meetings: string; activity: string; blocks: string } };

async function addDevice(db: TestDatabase, name: string): Promise<Device> {
  const channel = (client: string): Channel => ({
    id: testId("cli"),
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const capture = channel(`${name}-capture`);
  const mirror = channel(name);
  const device: Device = {
    capture,
    accounts: { meetings: testId("acc"), activity: testId("acc"), blocks: testId("acc") },
  };
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      capture.id,
      capture.name,
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      mirror.id,
      mirror.name,
      sha256Hex(mirror.token),
      ["own", "employer:example"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      name,
      capture.id,
      mirror.id,
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

const CHAT = { bundle: "test.example.chat", name: "Chat" };
const NOTES = { bundle: "test.example.notes", name: "Notes" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const RULES: ScopeRule[] = [
  { match: "bundle", value: CHAT.bundle, compartment: "own", kinds: ["moment"] },
  { match: "bundle", value: NOTES.bundle, compartment: "own", kinds: ["moment"] },
  { match: "host", value: "docs.google.com", account: OWNER.personal, compartment: "own", kinds: ["moment"] },
  { match: "host", value: "docs.google.com", account: OWNER.work, compartment: "employer:example", kinds: ["moment"] },
  { match: "host", value: "wiki.example.org", compartment: "own", kinds: ["block"] },
];

// The Drive root and the one stored Google Doc, as documents.db.test.ts writes them.
const FOLDER = "fldMomentLaneRoot0001";
const STORED_FILE = "docMomentLaneStored0001";
const OTHER_FILE = "docMomentLaneOther00001";
const docUrl = (fileId: string): string => `https://docs.google.com/document/d/${fileId}/edit`;
const STORED_DOC: DriveFile = {
  id: STORED_FILE,
  name: "Kitchen plans",
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00Z",
  modifiedTime: "2026-09-02T09:00:00Z",
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal, name: OWNER.name },
  canDownload: true,
};
const DOC_BODY: DocBody = {
  blocks: [
    { kind: "heading", level: 1, text: "Kitchen" },
    { kind: "paragraph", text: "The tiles are ordered for Friday." },
  ],
};

let keys = 0;
const keyOf = <K extends "moment" | "block" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JPMMNTS${String((keys += 1)).padStart(17, "0")}`;

const TEXT =
  "We went over the kitchen order line by line, the tiles, the paint and the new shelves, and agreed to check the colours again once the samples arrive at the house next week.";
const moment = (observedAt: string, over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt,
  endedAt: observedAt,
  app: CHAT,
  entity: "chat",
  participants: [],
  text: TEXT,
  read: "ax",
  ...over,
});
const docMoment = (observedAt: string, fileId: string, account: string): MomentItem =>
  moment(observedAt, { app: CHROME, entity: "doc", url: docUrl(fileId), account, window: "Kitchen plans" });

// The world's moments, by name. K: one thread of three; S: two whose first is settled long before
// the second; B: K's thread in another app; N: two with no thread; BIG: fourteen of one thread;
// LATE: one thread either side of local midnight, on one UTC day; EVE: one thread on one local day,
// either side of UTC midnight; DOC_*: three doc moments; SOLO: one alone.
const M = {
  K1: moment(local(0, "09:00"), { thread: "Kitchen" }),
  K2: moment(local(0, "09:10"), { thread: "Kitchen" }),
  K3: moment(local(0, "09:20"), { thread: "Kitchen" }),
  S1: moment(local(0, "10:00"), { thread: "Garden" }),
  S2: moment(local(0, "11:00"), { thread: "Garden" }),
  B1: moment(local(0, "09:05"), { app: NOTES, thread: "Kitchen" }),
  N1: moment(local(0, "12:00")),
  N2: moment(local(0, "12:05")),
  LATE1: moment(local(0, "23:30"), { thread: "Late" }),
  LATE2: moment(local(1, "00:30"), { thread: "Late" }),
  EVE1: moment(local(0, "18:30"), { thread: "Evening" }),
  EVE2: moment(local(0, "19:30"), { thread: "Evening" }),
  DOC_STORED: docMoment(local(0, "14:00"), STORED_FILE, OWNER.personal),
  DOC_WORK: docMoment(local(0, "14:10"), STORED_FILE, OWNER.work),
  DOC_OTHER: docMoment(local(0, "14:20"), OTHER_FILE, OWNER.personal),
  SOLO: moment(local(0, "15:00"), { thread: "Solo" }),
};
const BIG: MomentItem[] = Array.from({ length: 14 }, (_, n) =>
  moment(local(0, `13:${String(n).padStart(2, "0")}`), { thread: "Rota" }),
);
const BLOCK_DAY: BlockItem = {
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: dayOf(0),
  blocks: [
    {
      start: local(0, "16:00"),
      end: local(0, "16:30"),
      minutes: 30,
      app: { bundle: "test.example.reader", name: "Reader" },
      host: "wiki.example.org",
    },
  ],
};
type Name = keyof typeof M;

type Built = { evidence: Record<Name, EvidenceId>; big: EvidenceId[]; block: EvidenceId; device: Device };
let built: Built | undefined;
const base = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const evidenceOf = async (db: TestDatabase, key: string): Promise<EvidenceId> =>
  one(
    await admin<{ evidence_id: EvidenceId }>(db, "select evidence_id from knowledge.captures where capture_key = $1", [
      key,
    ]),
  ).evidence_id;

let batches = 0;
const batch = (): string => `pipeline-moments-${String((batches += 1)).padStart(4, "0")}`;

async function push(reader: Reader, device: Device, items: CaptureItem[]): Promise<void> {
  const answer = await reader.pushCapture(device.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}

async function storeDocument(db: TestDatabase, writer: Writer): Promise<void> {
  const rootId = testId("drt");
  await admin(
    db,
    "insert into policy.drive_roots (id, label, kind, root_fp, mode, created_at, root_enc) values ($1, 'personal', 'folder', $2, 'extract', $3, $4)",
    [
      rootId,
      fingerprint(db.keys, "source_id", FOLDER),
      "2026-09-01T00:00:00Z",
      sealRow(db.keys, "own", { table: "policy.drive_roots", id: rootId, column: "root_enc" }, FOLDER),
    ],
  );
  const account = await writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
  const raw = driveItem(STORED_DOC, DOC_BODY, null, {
    sourceAccount: account.id,
    changeKind: "backfill",
    ownerAddress: OWNER.personal,
  });
  expect(await writer.ingestItem(account, raw, (ctx: ItemContext) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe(
    "stored",
  );
}

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  try {
    await connect(writer);
    const device = await addDevice(db, "mac");
    for (const rule of RULES) await insertScope(db, rule);
    await storeDocument(db, writer);
    await push(reader, device, [...Object.values(M), ...BIG, BLOCK_DAY]);
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const evidence = {} as Built["evidence"];
    for (const name of Object.keys(M) as Name[]) evidence[name] = await evidenceOf(db, M[name].key);
    const big: EvidenceId[] = [];
    for (const item of BIG) big.push(await evidenceOf(db, item.key));
    const block = one(
      await admin<{ evidence_id: EvidenceId }>(db, "select evidence_id from knowledge.captures where kind = 'block'"),
    ).evidence_id;
    // The world is as these tests read it: the work doc moment under its rule's label, the rest
    // under `own`; the stored document under `own`.
    const labels = await admin<{ capture_key: string; compartments: string[] }>(
      db,
      "select capture_key, compartments from knowledge.captures where kind = 'moment'",
    );
    for (const row of labels)
      expect(row.compartments, row.capture_key).toEqual(
        row.capture_key === M.DOC_WORK.key ? ["employer:example"] : ["own"],
      );
    expect(
      one(
        await admin<{ compartments: string[] }>(db, "select compartments from knowledge.documents where file_fp = $1", [
          fingerprint(db.keys, "source_id", STORED_FILE),
        ]),
      ).compartments,
    ).toEqual(["own"]);
    built = { evidence, big, block, device };
  } finally {
    await reader.close();
    await writer.close();
  }
  return db;
});

afterAll(async () => {
  await world.drop();
}, TIMEOUT);

type Copy = { db: TestDatabase; pipeline: Pipeline; built: Built };

async function withWorld(fn: (copy: Copy) => Promise<void>): Promise<void> {
  const db = await world.copy();
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    await fn({ db, pipeline, built: base() });
  } finally {
    await pipeline.close();
    await db.drop();
  }
}

const groupsOf = (
  pipeline: Pipeline,
  options: {
    settledBefore?: Timestamp;
    switchedOn?: boolean;
    generation?: number;
    compartments?: string[];
    limit?: number;
    after?: { observedAt: Timestamp; evidenceId: EvidenceId };
  } = {},
): Promise<DueCapture[]> =>
  pipeline.dueCaptures("moment", options.limit ?? 100, options.generation ?? GENERATION, {
    switchedOn: options.switchedOn ?? true,
    settledBefore: options.settledBefore ?? SETTLED,
    ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
    ...(options.after === undefined ? {} : { after: options.after }),
  });
// Each group's moments, by evidence id, in the order given.
const members = (groups: DueCapture[]): EvidenceId[][] =>
  groups.map((group) => (group.moments ?? []).map((one_) => one_.evidenceId));
const groupHolding = (groups: DueCapture[], id: EvidenceId): EvidenceId[] | undefined =>
  members(groups).find((ids) => ids.includes(id));
const everyMember = (groups: DueCapture[]): EvidenceId[] => members(groups).flat();

describe("dueCaptures for moments: groups", { timeout: TIMEOUT }, () => {
  it("a moment group is due only when its latest moment is two hours old", () =>
    withWorld(async ({ pipeline, built }) => {
      const { S1, S2, K1, K2, K3 } = built.evidence;
      // Settled at a minute before S2: the first of the pair is old enough, the group is not.
      const before = await groupsOf(pipeline, { settledBefore: utc(0, "10:59") });
      expect(everyMember(before)).not.toContain(S1);
      expect(everyMember(before)).not.toContain(S2);
      // The positive control: K's group, whose latest is 09:20, is.
      expect(groupHolding(before, K1)).toEqual([K1, K2, K3]);
      // At S2's own time the group is due, whole, with S2 as its latest.
      const at = await groupsOf(pipeline, { settledBefore: utc(0, "11:00") });
      expect(groupHolding(at, S1)).toEqual([S1, S2]);
      const group = at.find((one_) => one_.moments?.some((member) => member.evidenceId === S1));
      expect(group).toMatchObject({
        evidenceId: S2,
        observedAt: utc(0, "11:00"),
        compartments: ["own"],
        attempts: 0,
        override: false,
      });
      expect(group?.moments?.map((member) => member.observedAt)).toEqual([utc(0, "10:00"), utc(0, "11:00")]);
    }));

  it("a group holds one bundle, one thread and one local_day, at most 12 moments", () =>
    withWorld(async ({ pipeline, built }) => {
      const { K1, K2, K3, B1, N1, N2, DOC_STORED, DOC_WORK, DOC_OTHER, SOLO } = built.evidence;
      const groups = await groupsOf(pipeline);
      // One thread of one app on one day: one group, earliest first.
      expect(groupHolding(groups, K1)).toEqual([K1, K2, K3]);
      // The same thread in another app is another group.
      expect(groupHolding(groups, B1)).toEqual([B1]);
      // No thread is one value: the two thread-less chat moments of the day are one group.
      expect(groupHolding(groups, N1)).toEqual([N1, N2]);
      // Fourteen of one thread: twelve, then two, in observed order.
      expect(groupHolding(groups, built.big[0] as EvidenceId)).toEqual(built.big.slice(0, 12));
      expect(groupHolding(groups, built.big[13] as EvidenceId)).toEqual(built.big.slice(12));
      // The label is part of the group: the work doc moment is alone, the two own ones together.
      expect(groupHolding(groups, DOC_STORED)).toEqual([DOC_STORED, DOC_OTHER]);
      expect(groupHolding(groups, DOC_WORK)).toEqual([DOC_WORK]);
      expect(groupHolding(groups, SOLO)).toEqual([SOLO]);
      for (const group of groups) {
        const list = group.moments ?? [];
        expect(list.length).toBeGreaterThanOrEqual(1);
        expect(list.length).toBeLessThanOrEqual(12);
        // The group's own fields are its latest moment's; every moment shares its label.
        expect(group.evidenceId).toBe(list.at(-1)?.evidenceId);
        for (const member of list) expect(member.compartments).toEqual(group.compartments);
      }
      // Every moment is in exactly one group, and the block day in none.
      const all = everyMember(groups);
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual([...Object.values(built.evidence), ...built.big].sort());
      // Newest latest moment first.
      const leads = groups.map((group) => Date.parse(group.observedAt));
      expect(leads).toEqual([...leads].sort((a, b) => b - a));
    }));

  // A moment is the text new since the thread's last, so the lane reads a thread
  // as its group; `--capture` names one moment and takes the group that holds it.
  it("pi extract --capture: `only` is the group that holds that moment, and a group not yet settled is none", () =>
    withWorld(async ({ pipeline, built }) => {
      const { K1, K2, K3, S1, S2, SOLO } = built.evidence;
      const only = (id: EvidenceId, settledBefore: Timestamp = SETTLED) =>
        pipeline.dueCaptures("moment", 50, GENERATION, { switchedOn: true, settledBefore, only: id });
      // K2 is due in K's group of three; named, the same group, and nothing else.
      expect(groupHolding(await groupsOf(pipeline), K2)).toEqual([K1, K2, K3]);
      expect(members(await only(K2))).toEqual([[K1, K2, K3]]);
      // A moment alone in its group is that group.
      expect(members(await only(SOLO))).toEqual([[SOLO]]);
      // S's group at 11:00 is not settled a minute before: none, by either of its moments; at its own time, whole.
      expect(await only(S1, utc(0, "10:59"))).toEqual([]);
      expect(members(await only(S1, utc(0, "11:00")))).toEqual([[S1, S2]]);
      expect(members(await only(S2, utc(0, "11:00")))).toEqual([[S1, S2]]);
    }));

  // A `--capture` may have saved a call of the named moment alone, and the regroup by saved calls
  // would keep it a group of its own; `only` is not regrouped.
  it("pi extract --capture: a moment once asked alone still takes its whole thread; a plain run keeps the saved group", () =>
    withWorld(async ({ pipeline, built }) => {
      const { K1, K2, K3 } = built.evidence;
      await saveGroupCall(pipeline, [K2], 7);
      const only = (id: EvidenceId) =>
        pipeline.dueCaptures("moment", 50, GENERATION, { switchedOn: true, settledBefore: SETTLED, only: id });
      expect(members(await only(K2))).toEqual([[K1, K2, K3]]);
      // The positive control: a plain run regroups by the saved call, so K2 is its own group.
      expect(groupHolding(await groupsOf(pipeline), K2)).toEqual([K2]);
    }));

  it("two moments of one thread at 23:30 and 00:30 local time are two groups, whatever their UTC days", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const { LATE1, LATE2, EVE1, EVE2 } = built.evidence;
      // The world is as the test says: LATE's two on one UTC day and two local days; EVE's two on
      // two UTC days and one local day.
      expect(utc(0, "23:30").slice(0, 10)).toBe(utc(1, "00:30").slice(0, 10));
      expect(utc(0, "18:30").slice(0, 10)).not.toBe(utc(0, "19:30").slice(0, 10));
      const days = await admin<{ capture_key: string; local_day: string }>(
        db,
        "select capture_key, local_day::text as local_day from knowledge.captures where capture_key = any($1)",
        [[M.LATE1.key, M.LATE2.key, M.EVE1.key, M.EVE2.key]],
      );
      const dayOfKey = (key: string) => days.find((row) => row.capture_key === key)?.local_day;
      expect([dayOfKey(M.LATE1.key), dayOfKey(M.LATE2.key)]).toEqual([dayOf(0), dayOf(1)]);
      expect([dayOfKey(M.EVE1.key), dayOfKey(M.EVE2.key)]).toEqual([dayOf(0), dayOf(0)]);
      const groups = await groupsOf(pipeline);
      expect(groupHolding(groups, LATE1)).toEqual([LATE1]);
      expect(groupHolding(groups, LATE2)).toEqual([LATE2]);
      // The positive control: one local day is one group across UTC midnight.
      expect(groupHolding(groups, EVE1)).toEqual([EVE1, EVE2]);
    }));

  it("limit and after page whole groups, newest latest moment first; compartments keeps only groups within it", () =>
    withWorld(async ({ pipeline, built }) => {
      const all = await groupsOf(pipeline);
      const paged: DueCapture[] = [];
      let after: { observedAt: Timestamp; evidenceId: EvidenceId } | undefined;
      for (;;) {
        const page = await groupsOf(pipeline, { limit: 3, ...(after === undefined ? {} : { after }) });
        expect(page.length).toBeLessThanOrEqual(3);
        if (page.length === 0) break;
        paged.push(...page);
        const last = page.at(-1) as DueCapture;
        after = { observedAt: last.observedAt, evidenceId: last.evidenceId };
      }
      expect(members(paged)).toEqual(members(all));
      const own = await groupsOf(pipeline, { compartments: ["own"] });
      expect(everyMember(own)).not.toContain(built.evidence.DOC_WORK);
      expect(members(own)).toEqual(members(all).filter((ids) => !ids.includes(built.evidence.DOC_WORK)));
    }));

  it("a page reads its local days newest first, a few at a time: across many days limit and after still page every group, newest latest moment first", () =>
    withWorld(async ({ db, pipeline, built }) => {
      // Two threads on each of the eight local days before the world's, one either side of UTC
      // midnight (20:30 at -05:00 is the next UTC day), each moment a group of its own.
      const older: MomentItem[] = [];
      for (let n = -8; n < 0; n += 1)
        for (const hhmm of ["08:00", "20:30"]) older.push(moment(local(n, hhmm), { thread: `Day ${n} ${hhmm}` }));
      const log = eventLogger();
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
      try {
        await push(reader, built.device, older);
        expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
      } finally {
        await reader.close();
        await writer.close();
      }
      const all = await groupsOf(pipeline);
      expect(everyMember(all)).toHaveLength(Object.keys(M).length + BIG.length + older.length);
      const leads = all.map((group) => Date.parse(group.observedAt));
      expect(leads).toEqual([...leads].sort((a, b) => b - a));
      // The oldest day's two come last, the later one first.
      expect(all.slice(-2).map((group) => group.observedAt)).toEqual([utc(-8, "20:30"), utc(-8, "08:00")]);
      for (const limit of [1, 2, 5]) {
        const paged: DueCapture[] = [];
        let after: { observedAt: Timestamp; evidenceId: EvidenceId } | undefined;
        for (;;) {
          const page = await groupsOf(pipeline, { limit, ...(after === undefined ? {} : { after }) });
          expect(page.length).toBeLessThanOrEqual(limit);
          if (page.length === 0) break;
          paged.push(...page);
          const last = page.at(-1) as DueCapture;
          after = { observedAt: last.observedAt, evidenceId: last.evidenceId };
        }
        expect(members(paged), `limit ${limit}`).toEqual(members(all));
      }
    }));

  it("a source thread's due moments of seven local days are one group, the eighth day back another; --capture and paging take the window whole", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
      const id = testId("csr");
      await admin(
        db,
        "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, 'bundle', $2, $3, 'own', '{moment}', 'imessage')",
        [
          id,
          fingerprint(db.keys, "capture_scope", MESSAGES.bundle),
          sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, MESSAGES.bundle),
        ],
      );
      const line = "ok i will bring the long ladder over on saturday morning";
      const session = (n: number, threadKey: string): MomentItem =>
        moment(local(n, "08:00"), {
          app: MESSAGES,
          participants: [{ handle: "+15555550501" }],
          text: line,
          read: "db",
          turns: [{ from: 0, to: line.length, speaker: "participant", participant: 0, at: local(n, "08:00") }],
          source: "imessage",
          threadKey,
        });
      const X = "chat:01JPMMNTS0000000000000000X";
      const sessions = {
        now: session(0, X),
        sixBack: session(-6, X),
        sevenBack: session(-7, X),
        other: session(0, "chat:01JPMMNTS0000000000000000Y"),
      };
      // A screen chat between X's two windows, so a page's cursor falls between them.
      const between = moment(local(-3, "08:00"), { thread: "Between" });
      const log = eventLogger();
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
      try {
        await push(reader, built.device, [...Object.values(sessions), between]);
        expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
      } finally {
        await reader.close();
        await writer.close();
      }
      const ids = {
        now: await evidenceOf(db, sessions.now.key),
        sixBack: await evidenceOf(db, sessions.sixBack.key),
        sevenBack: await evidenceOf(db, sessions.sevenBack.key),
        other: await evidenceOf(db, sessions.other.key),
      };
      const all = await groupsOf(pipeline);
      expect(groupHolding(all, ids.now)).toEqual([ids.sixBack, ids.now]);
      expect(groupHolding(all, ids.sevenBack)).toEqual([ids.sevenBack]);
      expect(groupHolding(all, ids.other)).toEqual([ids.other]);
      // The positive control: the world's screen chats are still one local day a group.
      expect(groupHolding(all, built.evidence.LATE1)).toEqual([built.evidence.LATE1]);
      // `--capture` of the window's older moment takes the window whole.
      expect(
        members(
          await pipeline.dueCaptures("moment", 50, GENERATION, {
            switchedOn: true,
            settledBefore: SETTLED,
            only: ids.sixBack,
          }),
        ),
      ).toEqual([[ids.sixBack, ids.now]]);
      expect(
        members(
          await pipeline.dueCaptures("moment", 50, GENERATION, {
            switchedOn: true,
            settledBefore: SETTLED,
            only: ids.sevenBack,
          }),
        ),
      ).toEqual([[ids.sevenBack]]);
      expect(groupHolding(all, await evidenceOf(db, between.key))).toEqual([await evidenceOf(db, between.key)]);
      // A page of one group at a time still holds each window whole, though X's newer window is
      // above a cursor that has passed the screen chat between them.
      for (const limit of [1, 3]) {
        const paged: DueCapture[] = [];
        let after: { observedAt: Timestamp; evidenceId: EvidenceId } | undefined;
        for (;;) {
          const page = await groupsOf(pipeline, { limit, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          paged.push(...page);
          const last = page.at(-1) as DueCapture;
          after = { observedAt: last.observedAt, evidenceId: last.evidenceId };
        }
        expect(members(paged), `limit ${limit}`).toEqual(members(all));
      }
    }));

  it("a time_block is never due", () =>
    withWorld(async ({ pipeline, built }) => {
      for (const generation of [1, 2]) {
        for (const switchedOn of [true, false]) {
          const moments = everyMember(await groupsOf(pipeline, { generation, switchedOn }));
          expect(moments, `${generation} ${switchedOn}`).not.toContain(built.block);
          // The positive control: the moments are.
          expect(moments, `${generation} ${switchedOn}`).toContain(built.evidence.SOLO);
          const meetings = await pipeline.dueCaptures("meeting", 100, generation, { switchedOn });
          expect(meetings.map((one_) => one_.evidenceId)).not.toContain(built.block);
          // And no moment is in the meeting lane.
          expect(meetings.map((one_) => one_.evidenceId)).not.toContain(built.evidence.SOLO);
        }
      }
    }));

  it("with PI_EXTRACT_MOMENTS unset a moment is committed not_extracted; it is not due while the lane is off and is due again once it is on", () =>
    withWorld(async ({ pipeline, built }) => {
      const { SOLO, B1 } = built.evidence;
      // Before any commit, the switch moves nothing: the moment is due, to be committed.
      expect(groupHolding(await groupsOf(pipeline, { switchedOn: false }), SOLO)).toEqual([SOLO]);
      expect(
        await pipeline.commit(batchOf(SOLO, [], { lane: "moment", status: "skipped", code: "not_extracted" })),
      ).toBe("committed");
      expect(await pipeline.commit(batchOf(B1, [], { lane: "moment", status: "done" }))).toBe("committed");
      const off = everyMember(await groupsOf(pipeline, { switchedOn: false }));
      expect(off).not.toContain(SOLO);
      expect(off).not.toContain(B1);
      // The lane on: the not_extracted moment is due again; the done one is not.
      const on = await groupsOf(pipeline, { switchedOn: true });
      expect(groupHolding(on, SOLO)).toEqual([SOLO]);
      expect(everyMember(on)).not.toContain(B1);
      // Another generation makes both due, with the lane off as on.
      for (const switchedOn of [false, true]) {
        const regenerated = everyMember(await groupsOf(pipeline, { switchedOn, generation: 2 }));
        expect(regenerated).toContain(SOLO);
        expect(regenerated).toContain(B1);
      }
    }));

  it("a moment call without settledBefore is refused before any read", () =>
    withWorld(async ({ pipeline }) => {
      await expect(pipeline.dueCaptures("moment", 10, GENERATION, { switchedOn: true })).rejects.toThrow();
    }));
});

describe("openMoment", { timeout: TIMEOUT }, () => {
  it("lists the projects within its label only when asked, and a project's status from a chat commits on the project", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
      try {
        const project = await admin.projects.add("Canary Alder Kiln", { requestId: testId("req") });
        const hidden = await admin.projects.add("Canary Other Label", {
          compartment: "employer:example",
          requestId: testId("req"),
        });
        const { K1 } = built.evidence;
        expect((await pipeline.openMoment(K1))?.projects).toBeUndefined();
        const opened = await pipeline.openMoment(K1, { projects: true });
        expect(opened?.projects).toEqual([{ project, name: "Canary Alder Kiln", anchored: false, vetoed: false }]);
        expect(opened?.projects?.map((one) => one.project)).not.toContain(hidden);
        const record = claimRecord(K1, opened?.context.compartments as string[], project, {
          type: "project.status",
          entities: [project],
          basis: "third_party",
        });
        const asProject = { ...record, subjectKind: "project", lane: "moment" } as typeof record;
        expect(await pipeline.commit(batchOf(K1, [asProject], { lane: "moment", status: "done" }))).toBe("committed");
        expect(
          await queryAs(
            db.urls.admin,
            "select c.type from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id where c.evidence_id = $1 and n.entity_id = $2",
            [K1, project],
          ),
        ).toEqual([{ type: "project.status" }]);
      } finally {
        await admin.close();
      }
    }));

  it("opens a moment: its stored item, its capture row and facts, and its context under its label", () =>
    withWorld(async ({ pipeline, built }) => {
      const opened = await pipeline.openMoment(built.evidence.K1);
      expect(opened).not.toBeNull();
      expect(opened?.item).toEqual(M.K1);
      expect(opened?.capture).toMatchObject({
        key: M.K1.key,
        revision: 0,
        observedAt: utc(0, "09:00"),
        storedDocument: false,
        facts: { kind: "moment", entity: "chat", thread: "Kitchen", counts: { chars: [...TEXT].length } },
      });
      expect(opened?.capture.id).toMatch(/^cap_/);
      expect(opened?.context).toMatchObject({ evidenceId: built.evidence.K1, revision: 0, compartments: ["own"] });
      expect(opened?.context.ownerAddresses).toEqual([OWNER.personal]);
    }));

  it("storedDocument is true for a doc moment of a Google Doc stored under a label within the moment's, and false otherwise", () =>
    withWorld(async ({ pipeline, built }) => {
      expect((await pipeline.openMoment(built.evidence.DOC_STORED))?.capture.storedDocument).toBe(true);
      // The same document seen under the work label: the own document is outside its label, so it
      // changes nothing the work label's viewers see (invariant 6).
      expect((await pipeline.openMoment(built.evidence.DOC_WORK))?.capture.storedDocument).toBe(false);
      // A Google Doc that is not stored.
      expect((await pipeline.openMoment(built.evidence.DOC_OTHER))?.capture.storedDocument).toBe(false);
    }));

  it("is null for an evidence id that names nothing and for a block day; openCapture is null for a moment", () =>
    withWorld(async ({ pipeline, built }) => {
      expect(await pipeline.openMoment("f".repeat(64) as EvidenceId)).toBeNull();
      expect(await pipeline.openMoment(built.block)).toBeNull();
      expect(await pipeline.openCapture(built.evidence.K1)).toBeNull();
      // The positive control.
      expect(await pipeline.openMoment(built.evidence.SOLO)).not.toBeNull();
    }));
});

// A group's saved call, keyed under its first moment, as the shared replay saves one; `n` makes its
// input hash its own.
const groupCall = (evidenceId: EvidenceId, n: number): ModelCallRecord =>
  ({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_moment",
      promptVersion: "1",
      inputHash: String(n).repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  }) as unknown as ModelCallRecord;

// What a run leaves for a group asked once: each moment opened, then the call saved with them all.
async function saveGroupCall(pipeline: Pipeline, moments: EvidenceId[], n: number): Promise<void> {
  for (const id of moments) expect(await pipeline.openMoment(id)).not.toBeNull();
  await pipeline.calls("configured/model", moments).save(groupCall(moments[0] as EvidenceId, n));
}
const callsUnder = async (db: TestDatabase, lead: EvidenceId): Promise<number> =>
  one(await admin<{ n: number }>(db, "select count(*)::int as n from vault.model_calls where evidence_id = $1", [lead]))
    .n;
const membersUnder = async (db: TestDatabase, lead: EvidenceId): Promise<EvidenceId[]> =>
  (
    await admin<{ evidence_id: EvidenceId }>(
      db,
      "select m.evidence_id from vault.model_call_members m join vault.model_calls c on c.id = m.call_id where c.evidence_id = $1 order by m.evidence_id",
      [lead],
    )
  ).map((row) => row.evidence_id);
const captureIdOf = async (db: TestDatabase, key: string): Promise<CaptureId> =>
  one(await admin<{ id: CaptureId }>(db, "select id from knowledge.captures where capture_key = $1", [key])).id;

describe("a moment group's saved call", { timeout: TIMEOUT }, () => {
  it("is saved with every moment it was asked for, under its label; a call of one item has no members; a member gone since its open leaves the call unsaved", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const { K1, K2, K3, S1, S2, SOLO } = built.evidence;
      await saveGroupCall(pipeline, [K1, K2, K3], 1);
      expect(await callsUnder(db, K1)).toBe(1);
      expect(await membersUnder(db, K1)).toEqual([K1, K2, K3].sort());
      expect(await admin(db, "select distinct compartments from vault.model_call_members")).toEqual([
        { compartments: ["own"] },
      ]);
      // A call of one item, saved as before: no member row.
      expect(await pipeline.openMoment(SOLO)).not.toBeNull();
      await pipeline.calls("configured/model").save(groupCall(SOLO, 2));
      expect(await callsUnder(db, SOLO)).toBe(1);
      expect(await membersUnder(db, SOLO)).toEqual([]);
      // S2 erased after both were opened: the call could no longer be found by S2, so it is not saved.
      for (const id of [S1, S2]) expect(await pipeline.openMoment(id)).not.toBeNull();
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        await owner.erasure.eraseItem(
          { kind: "capture", id: await captureIdOf(db, M.S2.key) },
          { requestId: testId("req") },
        );
      } finally {
        await owner.close();
      }
      await pipeline.calls("configured/model", [S1, S2]).save(groupCall(S1, 3));
      expect(await callsUnder(db, S1)).toBe(0);
    }));

  it("forgetting, erasing or revising the second moment of a group removes the group's saved call; removing a moment of another group leaves it", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const { K1, K2, K3, S1, S2, N1, N2, EVE1, EVE2 } = built.evidence;
      await saveGroupCall(pipeline, [K1, K2, K3], 1);
      await saveGroupCall(pipeline, [S1, S2], 2);
      await saveGroupCall(pipeline, [N1, N2], 3);
      await saveGroupCall(pipeline, [EVE1, EVE2], 4);
      for (const lead of [K1, S1, N1, EVE1]) expect(await callsUnder(db, lead), lead).toBe(1);
      const log = eventLogger();
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
      const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
      try {
        // Forgotten on the Mac: K2's forget, settled.
        await push(reader, built.device, [{ kind: "forget", key: keyOf("forget"), keys: [M.K2.key] }]);
        expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
        expect(await callsUnder(db, K1)).toBe(0);
        expect(
          await admin(db, "select call_id from vault.model_call_members where evidence_id = any($1)", [[K1, K3]]),
        ).toEqual([]);
        // The control: the other groups' calls stay.
        for (const lead of [S1, N1, EVE1]) expect(await callsUnder(db, lead), lead).toBe(1);

        // Erased by the owner: S2.
        await owner.erasure.eraseItem(
          { kind: "capture", id: await captureIdOf(db, M.S2.key) },
          { requestId: testId("req") },
        );
        expect(await callsUnder(db, S1)).toBe(0);
        for (const lead of [N1, EVE1]) expect(await callsUnder(db, lead), lead).toBe(1);

        // A new revision of N2: the earlier revision's group call goes with it.
        await push(reader, built.device, [
          { ...M.N2, revision: 1, text: `${TEXT} The shelves were left for another day.` },
        ]);
        expect(await writer.takeCapture()).toMatchObject({ replaced: 1, failed: 0 });
        expect(await callsUnder(db, N1)).toBe(0);

        // The control: EVE's call, whose moments were left alone, stays with both its members.
        expect(await callsUnder(db, EVE1)).toBe(1);
        expect(await membersUnder(db, EVE1)).toEqual([EVE1, EVE2].sort());
      } finally {
        await owner.close();
        await reader.close();
        await writer.close();
      }
    }));
});

describe("the batched moment mode, and pi lens time", { timeout: TIMEOUT }, () => {
  // The world's moments' first pushes, and the owner's zone set as `pi owner timezone` sets it.
  const pushedRange = async (db: TestDatabase): Promise<{ first: number; last: number }> => {
    const [row] = await admin<{ first: Date; last: Date }>(
      db,
      "select min(first_pushed_at) as first, max(first_pushed_at) as last from knowledge.captures where kind = 'moment'",
    );
    return { first: (row as { first: Date }).first.getTime(), last: (row as { last: Date }).last.getTime() };
  };
  const batched = (pipeline: Pipeline, at: number): Promise<DueCapture[]> =>
    pipeline.dueCaptures("moment", 100, GENERATION, {
      switchedOn: true,
      batchedAt: new Date(at).toISOString() as Timestamp,
    });

  it("a run takes the moments pushed by the cutoff, a thread's day whole past MOMENT_GROUP_MAX, with no settle", () =>
    withWorld(async ({ pipeline, built, db }) => {
      const { first, last } = await pushedRange(db);
      // A run 13 hours on: its cutoff is after every push. BIG's fourteen are one group, where the
      // continuous mode makes twelve and two.
      const later = await batched(pipeline, last + 13 * HOUR);
      expect(groupHolding(later, built.big[0] as EvidenceId)?.length).toBe(14);
      expect(new Set(everyMember(later))).toEqual(new Set([...Object.values(built.evidence), ...built.big]));
      const continuous = await groupsOf(pipeline);
      expect(groupHolding(continuous, built.big[0] as EvidenceId)?.length).toBe(12);
      // A run 13 hours before the first push: nothing was pushed by its cutoff.
      expect(await batched(pipeline, first - 13 * HOUR)).toEqual([]);
    }));

  it("the cutoff is the owner's zone's 00:00 or 12:00, read from policy.owner_settings", () =>
    withWorld(async ({ pipeline, db }) => {
      const { first, last } = await pushedRange(db);
      const { momentBatchCutoff } = await import("@intelligence/personal-core/lens");
      // A run time at which Chicago's cutoff and UTC's fall either side of the pushes.
      let at: number | undefined;
      for (let t = last; t < last + DAY && at === undefined; t += 10 * MINUTE) {
        const chicago = momentBatchCutoff(new Date(t), "America/Chicago").getTime();
        const utcCut = momentBatchCutoff(new Date(t), null).getTime();
        if ((chicago >= last && utcCut < first) || (chicago < first && utcCut >= last)) at = t;
      }
      if (at === undefined) throw new Error("no run time splits the zones");
      const chicagoTakes = momentBatchCutoff(new Date(at), "America/Chicago").getTime() >= last;
      expect((await batched(pipeline, at)).length > 0).toBe(!chicagoTakes);
      await admin(db, "update policy.owner_settings set time_zone = 'America/Chicago'");
      expect((await batched(pipeline, at)).length > 0).toBe(chicagoTakes);
    }));

  it("a page pushed after the cutoff is due at once, in a group of its own, and a chat moment pushed with it waits", () =>
    withWorld(async ({ pipeline, built, db }) => {
      const log = eventLogger();
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
      try {
        const page = moment(local(1, "10:00"), {
          entity: "page",
          url: "https://news.example.org/alpha",
          text: "Alpha launches | News Example",
          thread: "Reading",
        });
        const chat = moment(local(1, "10:05"), { thread: "Reading" });
        // A page's URL is matched by host rules alone.
        await insertScope(db, { match: "host", value: "news.example.org", compartment: "own", kinds: ["moment"] });
        await push(reader, built.device, [page, chat]);
        expect(await writer.takeCapture()).toMatchObject({ taken: 2, failed: 0, waiting: 0 });
        // A run now: its cutoff, the last 00:00 or 12:00 UTC, is before these two pushes.
        const runAt = Date.now();
        const [pageId, chatId] = [await evidenceOf(db, page.key), await evidenceOf(db, chat.key)];
        const { momentBatchCutoff } = await import("@intelligence/personal-core/lens");
        const pushedAt = one(
          await admin<{ at: Date }>(
            db,
            "select min(first_pushed_at) as at from knowledge.captures where capture_key = any($1)",
            [[page.key, chat.key]],
          ),
        ).at.getTime();
        expect(momentBatchCutoff(new Date(runAt), null).getTime()).toBeLessThan(pushedAt);
        const groups = await batched(pipeline, runAt);
        expect(groupHolding(groups, pageId)).toEqual([pageId]);
        expect(everyMember(groups)).not.toContain(chatId);
      } finally {
        await reader.close();
        await writer.close();
      }
    }));

  it("pi lens time: a day's minutes by category, from the stored blocks and the table, as pi_admin", () =>
    withWorld(async ({ db }) => {
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: recordingLogger().log,
        journal: journalPath(db.keyFile),
      });
      try {
        // The world's one block is the reader on wiki.example.org, which no row of the table names.
        const [day, ...rest] = await owner.lens.activity({ from: dayOf(-1), to: dayOf(1) });
        expect(rest).toEqual([]);
        expect(day).toEqual({
          day: dayOf(0),
          version: activityTable().version,
          minutes: {
            coding: 0,
            writing: 0,
            communication: 0,
            meetings: 0,
            research: 0,
            design: 0,
            media: 0,
            admin: 0,
            other: 30,
          },
          total: 30,
        });
        // With no `from`, the seven days to `to`.
        expect((await owner.lens.activity({ to: dayOf(3) })).map((one_) => one_.day)).toEqual([dayOf(0)]);
        // A range without it is empty.
        expect(await owner.lens.activity({ from: dayOf(1), to: dayOf(2) })).toEqual([]);
      } finally {
        await owner.close();
      }
    }));
});
