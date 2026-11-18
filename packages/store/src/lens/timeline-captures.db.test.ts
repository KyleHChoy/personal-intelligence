import { randomBytes } from "node:crypto";
import type { Claim } from "@intelligence/contracts";
import {
  type CaptureItem,
  type ClaimRecord,
  type EntityId,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  type TaskItem,
  type TimelineEntry,
  type TimelineView,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, QUENTIN, RHEA } from "../test-support/cast.ts";
import { insertClient, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { storeSeeder } from "../test-support/world.ts";

// The two capture entries of get_timeline, through the reader's real tool.
//   1. Consecutive capture.anchor facts of one project and one item kind are one `anchor_run`
//      entry, with its first and last time and its count; the limit counts collapsed entries, so
//      a run is counted whole and the entries after it are read.
//   2. A meeting Lens recorded and linked to no calendar event is a `captured_meeting` entry on a
//      person's timeline (by the participant claims that name them) and on a project's (by its
//      link), with its time and its people; a meeting linked to an event stays the event's entry;
//      and nothing under a label the caller cannot see changes what it is served (invariant 6).
//
// One store for the file, with `own` and `employer:example`, its clock pinned to the real minute
// so the push's own clock checks pass. Every row reaches it by the real path: mail and an event by
// the writer, a Lens device `mac` made by hand, items pushed with pushCapture and drained, the
// project and its anchor by the owner's commands, and the claims the link step and the meeting
// lane's identity step make (`capture.anchor`, `capture.person`, in extract's form) committed
// through the Pipeline as the lanes hand them over. Reserved domains and test bundles only. No
// model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const NOW = new Date(T);
const ago = (ms: number): number => T - ms;
const utc = (at: number): string => new Date(at).toISOString();

const CHAT = { bundle: "test.example.chat", name: "Chat" };
const CALL = { bundle: "test.example.call", name: "Call" };
const WORK_CALL = { bundle: "test.example.workcall", name: "Work call" };
const HARBOR_REPO = "forge.example.org/kestrel/harbor";

type Device = { name: string; token: string };
type Row = {
  id: string;
  evidence_id: string;
  kind: "meeting" | "moment";
  revision: number;
  started_at: Date;
  compartments: string[];
};

let store: TestStore;
let pipeline: Pipeline;
let accounts: Accounts;
let mac: Device;
let own: TestClient;
let wide: TestClient;
let harbor: EntityId;
let anchor: string;
let quentin: EntityId;
let rhea: EntityId;
// Quentin's timeline to the `own` client before the employer's meeting was stored.
let quentinBefore: TimelineView;

const admin = <R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(store.db.urls.admin, sql, values);
const request = () => ({ requestId: `req-0149-${randomBytes(6).toString("hex")}` });

// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "task">(kind: K): `${K}:${string}` =>
  `${kind}:01JTMX${String((keys += 1)).padStart(20, "0")}`;
let batches = 0;
const batch = (): string => `timeline-0149-${String((batches += 1)).padStart(4, "0")}`;

// A device as `pi lens add NAME` makes it, by hand, as the work-time tests make one.
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
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
    ["lens_tasks", "owner_task"],
  ] as const) {
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
      [testId("acc"), `device:${name}`, connector, kind],
    );
  }
  await admin("update policy.lens_devices set tasks = true where name = $1", [name]);
  return { name, token: capture.token };
}

async function push(items: CaptureItem[]): Promise<void> {
  const answer = await store.reader.pushCapture(mac.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  for (const item of answer.ok ? answer.value.items : [])
    expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}
async function drain(): Promise<void> {
  expect(await store.writer.takeCapture()).toMatchObject({ failed: 0 });
}
const rowOf = async (key: string): Promise<Row> =>
  one(
    await admin<Row>(
      "select id, evidence_id, kind, revision, started_at, compartments from knowledge.captures where capture_key = $1",
      [key],
    ),
  );

// The claims one item's lane commits with it, in extract's form, the item skipped not_extracted:
// its project link and its participants. One commit an item, since a commit removes the item's
// claims it leaves out.
type Made = { link?: EntityId; people?: EntityId[] };
function claimOf(
  row: Row,
  key: string,
  type: string,
  subject: EntityId,
  fields: Record<string, string>,
  span: string,
): ClaimRecord {
  const claim = {
    id: sha256(JSON.stringify([row.evidence_id, row.revision, span, type, subject, fields, 1])),
    content: { type, subject, fields },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: row.started_at.toISOString(),
    evidence: [{ evidenceId: row.evidence_id, span }],
    primaryEvidenceId: row.evidence_id,
    label: { compartments: row.compartments, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: type === "capture.anchor" ? "lens-link-1" : "lens-participants-1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  const person = type === "capture.person";
  return {
    claim,
    subjectKind: person ? "person" : "project",
    disclosure: person ? ["third_party"] : [],
    factKey: sha256(`${type}\n${subject}\n${key}`),
    lane: row.kind,
    fieldKinds: person ? { role: "enum" } : { anchor: "type" },
    entities: [subject],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}
async function commit(key: string, made: Made): Promise<void> {
  const row = await rowOf(key);
  const records = [
    ...(made.link === undefined ? [] : [claimOf(row, key, "capture.anchor", made.link, { anchor }, "capture:link")]),
    ...(made.people ?? []).map((person) =>
      claimOf(row, key, "capture.person", person, { role: "attendee" }, "capture:participants"),
    ),
  ];
  expect(
    await pipeline.commit(
      batchOf(row.evidence_id, records, { lane: row.kind, status: "skipped", code: "not_extracted" } as never),
    ),
    key,
  ).toBe("committed");
}

// Items.
const moment = (from: number): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: utc(from),
  endedAt: utc(from + 2 * MINUTE),
  app: CHAT,
  window: "Harbor planning",
  entity: "chat",
  thread: "Harbor planning",
  participants: [],
  text: "Looking at the dock plan.",
  read: "ax",
});
const meeting = (
  from: number,
  app: { bundle: string; name: string },
  over: Partial<MeetingItem> = {},
): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: utc(from),
  endedAt: utc(from + 30 * MINUTE),
  app,
  title: "Harbor review",
  consent: true,
  mode: "call",
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
  ...over,
});
const task = (title: string, created: number): TaskItem => ({
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title,
  project: "Harbor",
  events: [{ kind: "created", at: utc(created) }],
});

// The world, newest first: X, a call linked to no event, on Harbor, with Quentin and Rhea (its
// half hour is a work session of Harbor's too); five chat moments on Harbor (run A); a task of
// Harbor; three more (run B); Y, a call linked to the
// calendar's event with Quentin, on no project; and, stored last, Z, the employer's call with
// Quentin, linked to no event.
const X = meeting(ago(3 * HOUR), CALL);
const RUN_A = [0, 5, 10, 15, 20].map((minutes) => moment(ago(4 * HOUR + minutes * MINUTE)));
const TASK = task("Draft the dock notes", ago(5 * HOUR));
const RUN_B = [moment(ago(6 * HOUR)), moment(ago(6 * HOUR + 5 * MINUTE)), moment(ago(6 * HOUR + 10 * MINUTE))];
const Y_START = ago(8 * HOUR);
const Y = meeting(Y_START, CALL, {
  title: "Lighthouse sync",
  calendar: {
    start: utc(Y_START),
    end: utc(Y_START + 30 * MINUTE),
    title: "Lighthouse sync",
    attendees: [{ name: QUENTIN.name, address: QUENTIN.address }],
  },
});
const Z = meeting(ago(9 * HOUR), WORK_CALL, { title: "Supplier call" });

// Reads.
const timelineOf = async (client: TestClient, id: EntityId, limit?: number): Promise<TimelineView> =>
  outcomeValue(
    await store.reader.getTimeline(client.token, {
      id,
      from: utc(ago(30 * 24 * HOUR)),
      to: utc(T),
      ...(limit === undefined ? {} : { limit }),
    }),
  );
const captureIdOf = async (item: { key: string }): Promise<string> => (await rowOf(item.key)).id;
// An entry as a short line: its kind and what tells it apart.
async function linesOf(view: TimelineView): Promise<string[]> {
  return view.entries.flatMap((entry: TimelineEntry): string[] => {
    switch (entry.kind) {
      case "anchor_run":
        return [`run ${entry.item} ${entry.count} ${entry.first} ${entry.at}`];
      case "captured_meeting":
        return [`captured ${entry.capture} ${entry.startsAt}`];
      case "meeting":
        return [`meeting ${entry.meeting.id}`];
      case "fact":
        return [`fact ${entry.fact.type} ${entry.fact.capture ?? ""}`];
      case "task":
        return [`task ${entry.change}`];
      default:
        return [entry.kind];
    }
  });
}

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"], now: NOW });
  accounts = await connect(store.writer);
  const seed = storeSeeder(store.writer, NOW);
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });

  // Mail with Quentin and Rhea, so each is a person the `own` client can see, and the calendar's
  // event with Quentin that Y is linked to.
  const me = { address: OWNER.personal, name: OWNER.name };
  await seed.mail(accounts.personalMail, {
    id: "t0149-q1",
    from: QUENTIN,
    to: [me],
    at: new Date(ago(50 * HOUR)),
    subject: "Harbor",
    sent: false,
  });
  await seed.mail(accounts.personalMail, {
    id: "t0149-q2",
    from: me,
    to: [QUENTIN],
    at: new Date(ago(49 * HOUR)),
    subject: "Re: Harbor",
    sent: true,
  });
  await seed.mail(accounts.personalMail, {
    id: "t0149-r1",
    from: RHEA,
    to: [me],
    at: new Date(ago(48 * HOUR)),
    subject: "Dock",
    sent: false,
  });
  await seed.event(accounts.personalCalendar, {
    id: "t0149lighthouse01",
    title: "Lighthouse sync",
    start: new Date(Y_START),
    end: new Date(Y_START + 30 * MINUTE),
    organizer: { address: OWNER.personal },
    attendees: [{ address: QUENTIN.address }],
  });
  quentin = seed.entityOf(QUENTIN.address);
  rhea = seed.entityOf(RHEA.address);

  mac = await addDevice("mac");
  await store.admin.lens.addScope({ match: "bundle", value: CHAT.bundle, compartment: "own", kinds: ["moment"] });
  await store.admin.lens.addScope({ match: "bundle", value: CALL.bundle, compartment: "own", kinds: ["meeting"] });
  await store.admin.lens.addScope({
    match: "bundle",
    value: WORK_CALL.bundle,
    compartment: "employer:example",
    kinds: ["meeting"],
  });
  harbor = await store.admin.projects.add("Harbor", request());
  anchor = await store.admin.projects.anchor(harbor, { kind: "repository", value: HARBOR_REPO }, request());

  own = await insertClient(store.db, "t0149-own", ["own"]);
  wide = await insertClient(store.db, "t0149-wide", ["own", "employer:example"]);

  await push([X, ...RUN_A, ...RUN_B, Y]);
  await push([TASK]);
  await drain();
  await commit(X.key, { link: harbor, people: [quentin, rhea] });
  for (const one_ of [...RUN_A, ...RUN_B]) await commit(one_.key, { link: harbor });
  await commit(Y.key, { people: [quentin] });
  quentinBefore = await timelineOf(own, quentin);

  await push([Z]);
  await drain();
  await commit(Z.key, { people: [quentin] });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("a meeting Lens recorded with no calendar event is a timeline meeting", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("the world: X, Z and the moments are linked to no event, and Y to the calendar's", async () => {
    const events = await admin<{ capture_key: string; linked: boolean }>(
      "select capture_key, event_id is not null as linked from knowledge.captures where kind = 'meeting' order by capture_key",
    );
    expect(Object.fromEntries(events.map((row) => [row.capture_key, row.linked]))).toEqual({
      [X.key]: false,
      [Y.key]: true,
      [Z.key]: false,
    });
  });

  it("on a person's timeline: X with its time and the people bound to it, newest first; Y stays its event's meeting, once", async () => {
    const view = await timelineOf(own, quentin);
    const x = await captureIdOf(X);
    const captured = view.entries.find((entry) => entry.kind === "captured_meeting");
    expect(captured).toEqual({
      kind: "captured_meeting",
      at: X.startedAt,
      capture: x,
      startsAt: X.startedAt,
      endsAt: X.endedAt,
      participants: [quentin, rhea].sort().map((id) => expect.objectContaining({ id, kind: "person" })),
    });
    const eventId = one(
      await admin<{ id: string }>(
        "select v.id from knowledge.events v join knowledge.captures k on k.event_id = v.id where k.capture_key = $1",
        [Y.key],
      ),
    ).id;
    expect((await linesOf(view)).filter((line) => !line.startsWith("fact "))).toEqual([
      `captured ${x} ${X.startedAt}`,
      `meeting ${eventId}`,
      "email",
      "email",
    ]);
    // The participant claims are still facts beside it, as a linked meeting's are.
    expect(await linesOf(view)).toContain(`fact capture.person ${x}`);
  });

  it("on a project's timeline: X, by its link, with its people", async () => {
    const view = await timelineOf(own, harbor);
    const x = await captureIdOf(X);
    expect(
      view.entries
        .filter((entry) => entry.kind === "captured_meeting")
        .map((entry) => entry.kind === "captured_meeting" && [entry.capture, entry.participants.map((who) => who.id)]),
    ).toEqual([[x, [quentin, rhea].sort()]]);
  });

  it("invariant 6: the employer's meeting changes nothing the own client is served, and a client cleared for it is served it", async () => {
    expect(await timelineOf(own, quentin)).toEqual(quentinBefore);
    const z = await captureIdOf(Z);
    expect((await linesOf(await timelineOf(wide, quentin))).filter((line) => line.startsWith("captured "))).toEqual([
      `captured ${await captureIdOf(X)} ${X.startedAt}`,
      `captured ${z} ${Z.startedAt}`,
    ]);
  });
});

describe("consecutive project links are one entry", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const runLine = (items: MomentItem[]): string =>
    `run moment ${items.length} ${(items.at(-1) as MomentItem).observedAt} ${(items[0] as MomentItem).observedAt}`;

  it("each run of moment links is one entry with its first and last time and its count; the task between ends a run; a captured meeting holds its own link", async () => {
    const view = await timelineOf(own, harbor);
    const x = await captureIdOf(X);
    // X's session sorts before X at their one instant: its id is its start, which sorts before cap_.
    expect(await linesOf(view)).toEqual([
      "work_session",
      `captured ${x} ${X.startedAt}`,
      runLine(RUN_A),
      "task created",
      runLine(RUN_B),
    ]);
  });

  it("the limit counts collapsed entries: a run is counted whole and the entries after it are read", async () => {
    const x = await captureIdOf(X);
    // With 4: the facts read at first (X's link and three of run A's) leave three entries, so the
    // facts are read on: run A is counted whole and the task after it is the fourth entry.
    const four = await timelineOf(own, harbor, 4);
    expect(await linesOf(four)).toEqual([
      "work_session",
      `captured ${x} ${X.startedAt}`,
      runLine(RUN_A),
      "task created",
    ]);
    // With 3: the facts read at first fill the limit but end inside run A: its count is still 5.
    const three = await timelineOf(own, harbor, 3);
    expect(await linesOf(three)).toEqual(["work_session", `captured ${x} ${X.startedAt}`, runLine(RUN_A)]);
  });
});
