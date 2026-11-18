import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId, Mention, ModelCallRecord } from "@intelligence/contracts";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type CaptureMention,
  type ClaimRecord,
  type DueCapture,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { fakeLens } from "@intelligence/personal-core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder } from "../core/seal.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session, sqlState } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent, ingestMail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { insertScopeRule as insertScope } from "../test-support/lens-setup.ts";
import { batchOf, countOf, rowsOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { createPipeline, type Pipeline } from "./pipeline.ts";

// Both functions are called through createPipeline as pi_pipeline. No model is called and nothing of
// @intelligence/personal-extract is imported.
//
// One world for the file, built once and copied for each test (copiesOf): the owner's two labels,
// one device registered by hand as capture-drain.db.test.ts registers it, the world's scope, one
// accepted work event, and eight capture items pushed through Reader.pushCapture and taken by
// Writer.takeCapture: five meetings under `own` (two of them starting at the same instant), one
// meeting linked to the work event and so labelled {employer:example, own}, one meeting carrying
// `restricted:health`, a moment and a block day. Every item ended over 24 hours ago, so no meeting
// waits for a calendar. Every refusal has its positive control.

const TIMEOUT = 240_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The real clock, to the minute, as the drain reads it.
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
// A time `offset` from T as Lens writes one, with the Mac's local offset of -05:00.
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();
const at = (time: string): number => Date.parse(time);

type Channel = { id: string; name: string; token: string };
type Device = {
  name: string;
  capture: Channel;
  mirror: Channel;
  accounts: { meetings: string; activity: string; blocks: string };
};

// A device as `pi lens add NAME` makes it, by hand, as capture-drain.db.test.ts makes it.
async function addDevice(db: TestDatabase, name: string): Promise<Device> {
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
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      device.capture.id,
      device.capture.name,
      sha256Hex(device.capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      device.mirror.id,
      device.mirror.name,
      sha256Hex(device.mirror.token),
      ["own", "employer:example"],
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

// The world's scope; the meeting app is the one its rule puts under `own`.
const lens = fakeLens({ now: new Date(T - 3 * DAY) });
const meetRule = lens.scope.find(
  (rule) => rule.match === "bundle" && rule.compartment === "own" && rule.kinds.includes("meeting"),
);
if (meetRule === undefined) throw new Error("the world's scope has no own meeting app");
const MEET = { bundle: meetRule.value, name: "Meet" };
const READER = { bundle: "test.example.reader", name: "Reader" };

// The people of these tests, on reserved domains.
const DEVON: CaptureMention = { name: "Devon Marsh", address: "devon.marsh@example.org" };
const ROBIN: CaptureMention = { name: "Robin Vale", address: "robin.vale@example.org" };

// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block">(kind: K): `${K}:${string}` =>
  `${kind}:01JPCAPTS${String((keys += 1)).padStart(17, "0")}`;
let batches = 0;
const batch = (): string => `pipeline-captures-${String((batches += 1)).padStart(4, "0")}`;

const meeting = (startOffset: number, minutes: number, over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(startOffset),
  endedAt: local(startOffset + minutes * MINUTE),
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

// The world's items. Their starts, newest first: A, the restricted R, M (a moment), L (linked),
// K (a block day), the tie B and C, and D. D starts last of the meetings and ends after every
// other, so an order by end, by push or by drain is not the order by observed_at.
const ITEMS = {
  A: meeting(-40 * HOUR, 30),
  R: meeting(-42 * HOUR, 30, {
    segments: [
      { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "How did it go at the clinic?" },
      { speaker: "S2", fromMs: 20_000, toMs: 40_000, channel: "output", text: "The diagnosis came back fine." },
    ],
  }),
  L: meeting(-45 * HOUR + 5 * MINUTE, 55, {
    title: "Rota review",
    speakers: [
      { label: "S1", owner: true, mention: { address: OWNER.work } },
      { label: "S2", owner: false, mention: DEVON },
    ],
    calendar: { start: local(-45 * HOUR), end: local(-44 * HOUR), title: "Rota review", attendees: [DEVON] },
  }),
  B: meeting(-50 * HOUR, 30),
  C: meeting(-50 * HOUR, 30, { title: "Kitchen planning, second room" }),
  D: meeting(-51 * HOUR, 12 * 60, { title: "Long workshop" }),
};
const MOMENT: MomentItem = {
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-43 * HOUR),
  endedAt: local(-43 * HOUR + 5 * MINUTE),
  app: READER,
  url: "https://wiki.example.org/teams/alpha/plan",
  window: "Alpha plan",
  entity: "doc",
  thread: "Alpha plan",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
};
const BLOCK_DAY: BlockItem = {
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: local(-48 * HOUR).slice(0, 10),
  blocks: [
    {
      start: local(-48 * HOUR),
      end: local(-48 * HOUR + 30 * MINUTE),
      minutes: 30,
      app: READER,
      host: "wiki.example.org",
    },
  ],
};
type Name = keyof typeof ITEMS;

// The work label's event the linked meeting overlaps: the owner accepting, Devon organizing.
const LINKED_EVENT = event({
  event: {
    id: "evpipecaptures01",
    status: "confirmed",
    etag: '"etag-evpipecaptures01"',
    updated: utc(-3 * DAY),
    summary: "Rota review",
    start: { dateTime: utc(-45 * HOUR) },
    end: { dateTime: utc(-44 * HOUR) },
    organizer: { email: DEVON.address ?? "" },
    attendees: [
      { email: OWNER.work, self: true, responseStatus: "accepted" },
      { email: DEVON.address ?? "", displayName: DEVON.name ?? "", responseStatus: "accepted" },
    ],
  },
  title: "Rota review",
  startsAt: utc(-45 * HOUR),
  endsAt: utc(-44 * HOUR),
  allDay: false,
});

// What the build leaves for the tests: ids are the same in every copy.
type Built = {
  device: Device;
  accounts: Accounts;
  evidence: Record<Name | "M" | "K", EvidenceId>;
  captureIds: Record<Name, CaptureId>;
  owner: string;
  devon: string;
  eventId: string;
};
let built: Built | undefined;
const base = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const keyFp = (db: TestDatabase, value: string): string => fingerprint(db.keys, "source_id", value);
const evidenceRows = (db: TestDatabase, account: string, sourceKey: string) =>
  admin<{ id: EvidenceId; revision: number; payload_state: string }>(
    db,
    "select id, revision, payload_state from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision",
    [account, keyFp(db, sourceKey)],
  );
const latestEvidence = async (db: TestDatabase, account: string, sourceKey: string): Promise<EvidenceId> => {
  const rows = await evidenceRows(db, account, sourceKey);
  const last = rows.at(-1);
  if (last === undefined) throw new Error("no evidence for the key");
  return last.id;
};

async function push(reader: Reader, device: Device, items: CaptureItem[]): Promise<void> {
  const answer = await reader.pushCapture(device.capture.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).not.toBe("refused");
}

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"], restricted: ["health"] });
  await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  try {
    const accounts = await connect(writer);
    const device = await addDevice(db, "mac");
    for (const rule of lens.scope) await insertScope(db, rule);
    expect(await ingestEvent(writer, accounts.workCalendar, LINKED_EVENT)).toBe("stored");
    // Pushed in an order unlike their starts.
    await push(reader, device, [ITEMS.D, ITEMS.C, ITEMS.B, ITEMS.R, BLOCK_DAY, ITEMS.L, MOMENT, ITEMS.A]);
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const evidence = {} as Built["evidence"];
    const captureIds = {} as Built["captureIds"];
    for (const name of Object.keys(ITEMS) as Name[]) {
      evidence[name] = await latestEvidence(db, device.accounts.meetings, ITEMS[name].key);
      captureIds[name] = one(
        await admin<{ id: CaptureId }>(db, "select id from knowledge.captures where capture_key = $1", [
          ITEMS[name].key,
        ]),
      ).id;
    }
    evidence.M = await latestEvidence(db, device.accounts.activity, MOMENT.key);
    evidence.K = await latestEvidence(db, device.accounts.blocks, `${BLOCK_DAY.key}#own`);
    const owner = one(await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'")).id;
    const eventId = one(
      await admin<{ id: string }>(
        db,
        "select event_id as id from knowledge.event_details where account_id = $1 and starts_at = $2",
        [accounts.workCalendar.id, utc(-45 * HOUR)],
      ),
    ).id;
    const devon = one(
      await admin<{ entity_id: string }>(db, "select entity_id from knowledge.event_participants where event_id = $1", [
        eventId,
      ]),
    ).entity_id;
    // The world is as these tests read it: L linked and labelled by its event, R restricted.
    const labels = await admin<{ capture_key: string; compartments: string[]; event_id: string | null }>(
      db,
      "select capture_key, compartments, event_id from knowledge.captures",
    );
    const labelOf = (key: string) => labels.find((row) => row.capture_key === key);
    expect(labelOf(ITEMS.L.key)).toMatchObject({ compartments: ["employer:example", "own"], event_id: eventId });
    expect(labelOf(ITEMS.R.key)?.compartments).toEqual(["own", "restricted:health"]);
    for (const name of ["A", "B", "C", "D"] as const)
      expect(labelOf(ITEMS[name].key), name).toMatchObject({ compartments: ["own"], event_id: null });
    built = { device, accounts, evidence, captureIds, owner, devon, eventId };
  } finally {
    await reader.close();
    await writer.close();
  }
  return db;
});

afterAll(async () => {
  await world.drop();
}, TIMEOUT);

type Copy = { db: TestDatabase; writer: Writer; reader: Reader; pipeline: Pipeline; built: Built };

// A copy of the world with a writer, a reader and a Pipeline as pi_pipeline on it, dropped after.
async function withWorld(fn: (copy: Copy) => Promise<void>): Promise<void> {
  const db = await world.copy();
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    await fn({ db, writer, reader, pipeline, built: base() });
  } finally {
    await pipeline.close();
    await reader.close();
    await writer.close();
    await db.drop();
  }
}

// Every meeting the pipeline may read, in the due order: newest observed_at first, the tie B and C
// by evidence id in byte order (hex, so a plain sort), then D. R is restricted and never in it.
const order = (built: Built): EvidenceId[] => [
  built.evidence.A,
  built.evidence.L,
  ...[built.evidence.B, built.evidence.C].sort(),
  built.evidence.D,
];

const dueIds = async (
  pipeline: Pipeline,
  options: { switchedOn?: boolean; generation?: number; compartments?: string[]; limit?: number } = {},
): Promise<EvidenceId[]> =>
  (
    await pipeline.dueCaptures("meeting", options.limit ?? 50, options.generation ?? 1, {
      switchedOn: options.switchedOn ?? true,
      ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
    })
  ).map((one_) => one_.evidenceId);

// One plan claim of a meeting under `own`, citing a segment, as the lane would commit it.
function planRecord(evidenceId: string, owner: string, n = 1): ClaimRecord {
  const claim = {
    id: `${evidenceId.slice(0, 60)}${String(n).padStart(4, "0")}`,
    content: {
      type: "plan",
      subject: owner,
      fields: { what: "Order the tiles.", when: local(-39 * HOUR).slice(0, 10) },
    },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: utc(-40 * HOUR),
    evidence: [{ evidenceId, span: "seg:0-32" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: ["own"], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: `plan ${evidenceId} ${n}`,
    lane: "meeting",
    fieldKinds: { what: "text", when: "date" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// A saved call for the meeting, as the shared replay saves one.
const savedCall = (evidenceId: string): ModelCallRecord =>
  ({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_meeting",
      promptVersion: "1",
      inputHash: "a".repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  }) as unknown as ModelCallRecord;

// The extracted rows of one evidence row, by table.
async function extractedOf(db: TestDatabase, evidenceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["knowledge.claims", "vault.model_calls", "vault.pipeline_items", "vault.unmapped_claims"])
    counts[table] = await countOf(db, table, "evidence_id = $1", [evidenceId]);
  return counts;
}
const NOTHING = {
  "knowledge.claims": 0,
  "vault.model_calls": 0,
  "vault.pipeline_items": 0,
  "vault.unmapped_claims": 0,
};
const EXTRACTED = { ...NOTHING, "knowledge.claims": 1, "vault.model_calls": 1, "vault.pipeline_items": 1 };

// Opens an own meeting, saves one call and commits one claim for it: what a run leaves for it.
async function extracted(copy: Copy, evidenceId: EvidenceId): Promise<void> {
  expect(await copy.pipeline.openCapture(evidenceId)).not.toBeNull();
  await copy.pipeline.calls("configured/model").save(savedCall(evidenceId));
  expect(
    await copy.pipeline.commit(
      batchOf(evidenceId, [planRecord(evidenceId, copy.built.owner)], { lane: "meeting", groups: 1, leftOut: 0 }),
    ),
  ).toBe("committed");
}

const address = (value: string): Mention =>
  ({ key: { kind: "address", value }, observedAt: utc(-40 * HOUR) }) as Mention;

describe("dueCaptures: which meetings are due", { timeout: TIMEOUT }, () => {
  it("meetings are due by observed_at, newest first, the evidence id breaking a tie; each as DueCapture with its whole label", () =>
    withWorld(async ({ pipeline, built }) => {
      const due = await pipeline.dueCaptures("meeting", 50, 1, { switchedOn: true });
      expect(due.map((one_) => one_.evidenceId)).toEqual(order(built));
      const byId = new Map<string, DueCapture>(due.map((one_) => [one_.evidenceId, one_]));
      for (const name of ["A", "B", "C", "D", "L"] as const) {
        const item = byId.get(built.evidence[name]);
        expect(item, name).toEqual({
          evidenceId: built.evidence[name],
          compartments: name === "L" ? ["employer:example", "own"] : ["own"],
          observedAt: expect.any(String),
          attempts: 0,
          override: false,
        });
        // observed_at is the meeting's startedAt, whatever form the instant is written in.
        expect(at(item?.observedAt ?? ""), name).toBe(at(ITEMS[name].startedAt));
      }
      // The tie is a tie: B and C start at the same instant.
      expect(at(ITEMS.B.startedAt)).toBe(at(ITEMS.C.startedAt));
    }));

  it("a time block is never due, nor a moment, in the meeting lane; nor is a message", () =>
    withWorld(async ({ pipeline, writer, built }) => {
      await ingestMail(writer, built.accounts.personalMail, MAIL.canary);
      const message = evidenceIdOf(built.accounts.personalMail, mailSourceId(MAIL.canary)) as EvidenceId;
      for (const generation of [1, 2]) {
        for (const switchedOn of [true, false]) {
          const due = await dueIds(pipeline, { generation, switchedOn });
          expect(due, `${generation} ${switchedOn}`).not.toContain(built.evidence.K);
          expect(due, `${generation} ${switchedOn}`).not.toContain(built.evidence.M);
          expect(due, `${generation} ${switchedOn}`).not.toContain(message);
          // The positive control: the meetings are.
          expect(due, `${generation} ${switchedOn}`).toEqual(order(built));
        }
      }
      // The message is due in the mail lane.
      expect((await pipeline.due(10, 1)).map((one_) => one_.evidenceId)).toEqual([message]);
    }));

  it("with the lane off a meeting not yet committed is due, to be committed not_extracted; once so committed it is not due while the lane is off, and is due again once it is on", () =>
    withWorld(async ({ pipeline, built }) => {
      const { A, B, C, D, L } = built.evidence;
      // Before any commit, the lane's switch moves nothing: every meeting is due, to be committed.
      expect(await dueIds(pipeline, { switchedOn: false })).toEqual(order(built));
      // A and B committed skipped not_extracted, with the lane named either way; C skipped
      // too_short; D done. L is left alone.
      expect(await pipeline.commit(batchOf(A, [], { lane: "meeting", status: "skipped", code: "not_extracted" }))).toBe(
        "committed",
      );
      expect(await pipeline.commit(batchOf(B, [], { lane: "skip", status: "skipped", code: "not_extracted" }))).toBe(
        "committed",
      );
      expect(await pipeline.commit(batchOf(C, [], { lane: "skip", status: "skipped", code: "too_short" }))).toBe(
        "committed",
      );
      expect(await pipeline.commit(batchOf(D, [], { lane: "meeting", status: "done" }))).toBe("committed");
      // The lane off: only the meeting never committed is due.
      expect(await dueIds(pipeline, { switchedOn: false })).toEqual([L]);
      // The lane on: the two not_extracted are due again, in the due order; too_short and done are not.
      expect(await dueIds(pipeline, { switchedOn: true })).toEqual(order(built).filter((id) => [A, B, L].includes(id)));
      // Another generation makes every one due, with the lane off as on (as `due`'s rows are).
      expect(await dueIds(pipeline, { switchedOn: false, generation: 2 })).toEqual(order(built));
      expect(await dueIds(pipeline, { switchedOn: true, generation: 2 })).toEqual(order(built));
    }));

  it("a meeting is due as due's rows are: waiting is due with its attempts, and a withheld one is not due at another generation", () =>
    withWorld(async ({ pipeline, built }) => {
      const { A, B, D } = built.evidence;
      expect(await pipeline.commit(batchOf(A, [], { lane: "meeting", status: "done" }))).toBe("committed");
      expect(await pipeline.commit(batchOf(B, [], { lane: "meeting", status: "withheld", code: "sensitive" }))).toBe(
        "committed",
      );
      expect(await pipeline.commit(batchOf(D, [], { lane: "meeting", status: "done" }))).toBe("committed");
      expect(await dueIds(pipeline)).not.toContain(A);
      // A set waiting with one attempt counted: due again, with its attempt.
      await pipeline.defer(A, 1, { code: "model_unavailable", lane: "meeting" });
      await pipeline.countAttempt([A], 1);
      const due = await pipeline.dueCaptures("meeting", 50, 1, { switchedOn: true });
      expect(due.find((one_) => one_.evidenceId === A)).toMatchObject({ evidenceId: A, attempts: 1, override: false });
      // The withheld meeting waits for the owner's retry, even at another generation; the done
      // one, the positive control, is due there.
      const later = await dueIds(pipeline, { generation: 2 });
      expect(later).not.toContain(B);
      expect(later).toContain(D);
      expect(await dueIds(pipeline)).not.toContain(B);
    }));

  it("compartments keeps only meetings whose whole label is within it, and after takes up past the last of a page, through the tie", () =>
    withWorld(async ({ pipeline, built }) => {
      const all = order(built);
      expect(await dueIds(pipeline, { compartments: ["own"] })).toEqual(all.filter((id) => id !== built.evidence.L));
      // L's label is {employer:example, own}: not within either compartment alone.
      expect(await dueIds(pipeline, { compartments: ["employer:example"] })).toEqual([]);
      // The positive control: within both, every meeting.
      expect(await dueIds(pipeline, { compartments: ["employer:example", "own"] })).toEqual(all);
      // Paging one at a time, each page after the last of the one before, gives the whole order.
      const paged: EvidenceId[] = [];
      let after: DueCapture | undefined;
      for (let page = 0; page <= all.length; page += 1) {
        const got: DueCapture[] = await pipeline.dueCaptures("meeting", 1, 1, {
          switchedOn: true,
          ...(after === undefined ? {} : { after: { observedAt: after.observedAt, evidenceId: after.evidenceId } }),
        });
        if (got.length === 0) break;
        expect(got).toHaveLength(1);
        after = got[0];
        paged.push(got[0]?.evidenceId as EvidenceId);
      }
      expect(paged).toEqual(all);
      // A page of two, then the rest after its last, within `own`.
      const own = all.filter((id) => id !== built.evidence.L);
      const first = await pipeline.dueCaptures("meeting", 2, 1, { switchedOn: true, compartments: ["own"] });
      expect(first.map((one_) => one_.evidenceId)).toEqual(own.slice(0, 2));
      const last = first.at(-1) as DueCapture;
      const rest = await pipeline.dueCaptures("meeting", 50, 1, {
        switchedOn: true,
        compartments: ["own"],
        after: { observedAt: last.observedAt, evidenceId: last.evidenceId },
      });
      expect(rest.map((one_) => one_.evidenceId)).toEqual(own.slice(2));
    }));
});

describe("openCapture: one meeting opened", { timeout: TIMEOUT }, () => {
  it("opens an own meeting: its stored item, its capture row's clear columns and sealed facts, and the context under its label", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const opened = await pipeline.openCapture(built.evidence.A);
      if (opened === null) throw new Error("A did not open");
      expect(opened.item).toEqual(ITEMS.A);
      const row = one(
        await admin<{ id: string; first_pushed_at: Date; facts_enc: unknown; compartments: string[] }>(
          db,
          "select id, first_pushed_at, facts_enc, compartments from knowledge.captures where capture_key = $1",
          [ITEMS.A.key],
        ),
      );
      expect(opened.capture).toMatchObject({ id: built.captureIds.A, key: ITEMS.A.key, revision: 0, event: null });
      expect(row.id).toBe(built.captureIds.A);
      expect(at(opened.capture.startedAt)).toBe(at(ITEMS.A.startedAt));
      expect(at(opened.capture.endedAt)).toBe(at(ITEMS.A.endedAt));
      expect(at(opened.capture.firstPushedAt)).toBe(row.first_pushed_at.getTime());
      // The facts are the row's sealed CaptureFacts' meeting fields.
      const sealed = JSON.parse(
        openUnder(
          db.keys,
          row.compartments,
          { table: "knowledge.captures", id: row.id, column: "facts_enc" },
          row.facts_enc as never,
        ),
      ) as Record<string, unknown>;
      const facts = {
        kind: sealed.kind,
        title: sealed.title,
        consent: sealed.consent,
        mode: sealed.mode,
        calendar: sealed.calendar,
        speakers: sealed.speakers,
        linked: sealed.linked,
      };
      expect(facts).toMatchObject({
        kind: "meeting",
        title: ITEMS.A.title,
        consent: true,
        mode: "call",
        calendar: null,
        linked: null,
      });
      expect(opened.capture.facts).toMatchObject(facts);
      expect(opened.context).toMatchObject({
        evidenceId: built.evidence.A,
        revision: 0,
        compartments: ["own"],
        ownerAddresses: [OWNER.personal],
        ownerEntity: built.owner,
      });
      // The identity port answers under the meeting's label: the owner, and not Devon, whose
      // account is under employer:example only.
      expect(await opened.context.identity.resolve(address(OWNER.personal), "personal", "r" as never)).toEqual({
        outcome: "linked",
        entity: built.owner,
        epoch: 0,
      });
      expect(opened.kindOf(built.owner as never)).toBe("owner");
      expect(await opened.context.identity.resolve(address(DEVON.address ?? ""), "personal", "r" as never)).toEqual({
        outcome: "not_a_person",
      });
      expect(opened.kindOf(built.devon as never)).toBeUndefined();
    }));

  it("opens the linked meeting under its whole label, with its event and the drain's answer of the event's owner-backing and each speaker's participant", () =>
    withWorld(async ({ db, pipeline, built }) => {
      const opened = await pipeline.openCapture(built.evidence.L);
      if (opened === null) throw new Error("L did not open");
      expect(opened.item).toEqual(ITEMS.L);
      expect(opened.capture).toMatchObject({
        id: built.captureIds.L,
        key: ITEMS.L.key,
        revision: 0,
        event: built.eventId,
      });
      expect(opened.capture.facts).toMatchObject({
        kind: "meeting",
        title: "Rota review",
        consent: true,
        mode: "call",
        calendar: { title: "Rota review", uid: null, organizer: null, attendees: [DEVON] },
        speakers: [
          { label: "S1", owner: true, mention: { address: OWNER.work } },
          { label: "S2", owner: false, mention: DEVON },
        ],
        linked: { event: built.eventId, ownerBacked: true, speakers: { S2: built.devon } },
      });
      expect(opened.context).toMatchObject({
        evidenceId: built.evidence.L,
        revision: 0,
        compartments: ["employer:example", "own"],
        ownerEntity: built.owner,
      });
      // The owner's addresses under labels within its label: both of the owner's.
      expect([...opened.context.ownerAddresses].sort()).toEqual([OWNER.personal, OWNER.work].sort());
      // Devon's account is under employer:example, within this label: the port links Devon.
      expect(await opened.context.identity.resolve(address(DEVON.address ?? ""), "personal", "r" as never)).toEqual({
        outcome: "linked",
        entity: built.devon,
        epoch: 0,
      });
      expect(opened.kindOf(built.devon as never)).toBe("person");
      expect(opened.kindOf(`ent_${"0".repeat(26)}` as never)).toBeUndefined();
      // Opening wrote nothing.
      expect(await countOf(db, "vault.pipeline_items")).toBe(0);
    }));

  it("is null for an evidence id that names nothing, a moment, a block day, a message, a restricted meeting and an erased one", () =>
    withWorld(async ({ db, pipeline, writer, built }) => {
      expect(await pipeline.openCapture("f".repeat(64) as EvidenceId)).toBeNull();
      expect(await pipeline.openCapture(built.evidence.M)).toBeNull();
      expect(await pipeline.openCapture(built.evidence.K)).toBeNull();
      await ingestMail(writer, built.accounts.personalMail, MAIL.canary);
      const message = evidenceIdOf(built.accounts.personalMail, mailSourceId(MAIL.canary)) as EvidenceId;
      expect(await pipeline.openCapture(message)).toBeNull();
      // The positive control: the message opens as a message.
      expect(await pipeline.open(message)).not.toBeNull();
      // R is a meeting whose capture row is restricted: nothing of it opens, and it is never due.
      expect(await pipeline.openCapture(built.evidence.R)).toBeNull();
      expect(await dueIds(pipeline)).not.toContain(built.evidence.R);
      // The positive control: an own meeting opens.
      expect(await pipeline.openCapture(built.evidence.B)).not.toBeNull();
      // An erased meeting's rows are gone: it opens as nothing, and is not due.
      const owner = createAdmin({
        url: db.urls.admin,
        keys: db.keys,
        log: eventLogger(),
        journal: journalPath(db.keyFile),
      });
      try {
        await owner.erasure.eraseItem({ kind: "capture", id: built.captureIds.A }, { requestId: testId("req") });
      } finally {
        await owner.close();
      }
      expect(await countOf(db, "vault.evidence_items", "id = $1", [built.evidence.A])).toBe(0);
      expect(await pipeline.openCapture(built.evidence.A)).toBeNull();
      expect(await dueIds(pipeline)).not.toContain(built.evidence.A);
      // The control: the meeting beside it still opens.
      expect(await pipeline.openCapture(built.evidence.B)).not.toBeNull();
    }));
});

describe("a new revision of a meeting", { timeout: TIMEOUT }, () => {
  it("a new revision's drain removes the earlier revision's claims, saved calls and status row; the earlier revision opens as nothing and the new one is due in its place", () =>
    withWorld(async (copy) => {
      const { db, pipeline, reader, writer, built } = copy;
      await extracted(copy, built.evidence.A);
      await extracted(copy, built.evidence.B);
      expect(await extractedOf(db, built.evidence.A)).toEqual(EXTRACTED);
      // Retranscribed: the same key, a higher revision.
      const next: MeetingItem = {
        ...ITEMS.A,
        revision: 1,
        segments: [
          { speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "I will order the tiles on Monday." },
        ],
      };
      await push(reader, built.device, [next]);
      expect(await writer.takeCapture()).toMatchObject({ replaced: 1, failed: 0 });
      const rows = await evidenceRows(db, built.device.accounts.meetings, ITEMS.A.key);
      expect(rows.map((row) => [row.revision, row.payload_state])).toEqual([
        [0, "expired"],
        [1, "present"],
      ]);
      const [earlier, later] = rows.map((row) => row.id) as [EvidenceId, EvidenceId];
      expect(earlier).toBe(built.evidence.A);
      expect(await extractedOf(db, earlier)).toEqual(NOTHING);
      expect(await extractedOf(db, later)).toEqual(NOTHING);
      // The positive control: the meeting left alone keeps what was extracted from it.
      expect(await extractedOf(db, built.evidence.B)).toEqual(EXTRACTED);
      // The earlier revision's blob is gone: it opens as nothing; the new one opens as revision 1.
      expect(await pipeline.openCapture(earlier)).toBeNull();
      const opened = await pipeline.openCapture(later);
      expect(opened?.item).toEqual(next);
      expect(opened?.capture).toMatchObject({ id: built.captureIds.A, key: ITEMS.A.key, revision: 1 });
      expect(opened?.context).toMatchObject({ evidenceId: later, revision: 1 });
      // Due in the earlier revision's place, which is due no more; B, committed, is not due.
      expect(await dueIds(pipeline)).toEqual(
        order(built)
          .map((id) => (id === earlier ? later : id))
          .filter((id) => id !== built.evidence.B),
      );
      // A commit of the earlier revision by a pipeline that never opened it writes nothing.
      const fresh = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        expect(await fresh.commit(batchOf(earlier, [], { lane: "meeting" }))).toBe("superseded");
      } finally {
        await fresh.close();
      }
      expect(await extractedOf(db, earlier)).toEqual(NOTHING);
    }));
});

describe("the pipeline role and knowledge.captures", { timeout: TIMEOUT }, () => {
  it("pi_pipeline reads a capture row's clear columns and no restricted row, and writes none", () =>
    withWorld(async ({ db, built }) => {
      const clear =
        "id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day, compartments, match_fps";
      const seen = await queryAs<{ id: string; compartments: string[] }>(
        db.urls.pipeline,
        `select ${clear} from knowledge.captures order by id`,
      );
      const everything = await admin<{ id: string; compartments: string[] }>(
        db,
        "select id, compartments from knowledge.captures order by id",
      );
      const restricted = everything.filter((row) =>
        row.compartments.some((compartment) => compartment.startsWith("restricted:")),
      );
      expect(restricted.map((row) => row.id)).toEqual([built.captureIds.R]);
      // Every row but the restricted one: the five meetings, L, the moment and the block day's split.
      expect(seen.map((row) => row.id)).toEqual(
        everything.filter((row) => row.id !== built.captureIds.R).map((row) => row.id),
      );
      expect(seen).toHaveLength(7);
      expect(seen.map((row) => row.id)).toContain(built.captureIds.L);
      expect(await sqlState(() => queryAs(db.urls.pipeline, "update knowledge.captures set revision = revision"))).toBe(
        "42501",
      );
      expect(await sqlState(() => queryAs(db.urls.pipeline, "delete from knowledge.captures"))).toBe("42501");
      // The positive control: the admin reads the restricted row.
      expect(await countOf(db, "knowledge.captures", "id = $1", [built.captureIds.R])).toBe(1);
      expect(await rowsOf(db, "select id from knowledge.captures where id = $1", [built.captureIds.R])).toHaveLength(1);
    }));
});
