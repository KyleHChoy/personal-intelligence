import { randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type DeepWorkDay,
  type EntityId,
  type ForgetItem,
  type HalfDay,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  type TaskItem,
  type TaskView,
  type WorkTarget,
} from "@intelligence/contracts/personal";
import type { WorkRequest, WorkViews } from "@intelligence/personal-core/lens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { createReader, type Reader } from "../read/read.ts";
import { connect } from "../test-support/cast.ts";
import { insertClient, revokeClient, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { linkCapture } from "../test-support/lens-setup.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { AdminError } from "./admin-error.ts";
import { journalPath } from "./journal.ts";

// The read-time function of work time. `Reader.workViews(token, request)` gathers, under the
// caller's token as pi_reader, the capture rows with their work_enc, the task rows whole, the
// captures' links, the live device anchors and the projects, and calls core's `workTime`;
// `Admin.timeDay` and `Admin.timeProject` do the same as pi_admin with the owner's audience.
// Nothing is written but the read log.
//
// One database for the file, with `own` and `employer:example`. The reader that reads is pinned to
// NOW; pushes go through an unpinned one, so the push's own clock checks run on the real clock.
// Times are UTC: the owner sets no zone until the last test, which sets America/Chicago for the
// daylight-time days.
//
// Reserved domains, test bundles and `~/test` paths, except product bundle ids where the activity
// category table (ontology/activity-categories.json) must give a word (a coding editor, Claude's
// app, a research reader, mail and a call app), as the drain's tests do. Every exclusion and refusal has its positive control.
// No model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date("2026-03-17T13:00:00.000Z");
const at = (day: string, time: string): string => `${day}T${time}:00.000Z`;
const ms = (iso: string): number => Date.parse(iso);

// The days of the world, each with a purpose of its own so no test's rows move another's counts.
const D = "2026-03-16";
const FOCUS = "2026-03-15"; // a focus day
const CUTS = "2026-03-11"; // a cut by compartment
const PENDING = "2026-03-05"; // a block day whose work_enc is null
const NOON = "2026-03-10"; // the noon and midnight revisions
const LATE = "2026-03-12"; // a meeting pushed before its block day
const TWO = "2026-03-13"; // two devices' blocks overlapping, a call recorded twice
const BEACON = "2026-03-03"; // an anchor set and lifted
const ERASED = "2026-02-23";
const FORGOTTEN = "2026-02-24";
const REVISED = "2026-02-25";
const TASKS = "2026-03-02"; // tasks created, no block
const SPRING = "2026-03-08"; // America/Chicago to daylight time
const FALL = "2025-11-02"; // America/Chicago from daylight time

const VSCODE = { bundle: "com.microsoft.VSCode", name: "Editor" };
const CLAUDE = { bundle: "com.anthropic.claudefordesktop", name: "Claude" };
const READER = { bundle: "com.readwise.reader", name: "Reader" };
const MAIL = { bundle: "com.apple.mail", name: "Mail" };
const FACETIME = { bundle: "com.apple.FaceTime", name: "FaceTime" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const TERM = { bundle: "test.example.term", name: "Term" };
const EDIT = { bundle: "test.example.edit", name: "Edit" };
const CALL = { bundle: "test.example.call", name: "Call" };
const WORK = { bundle: "test.example.work", name: "Work" };
const UNSCOPED = "test.example.unscoped";
const DOCS = "docs.example.org";
const HARBOR_REPO = "forge.example.org/kestrel/harbor";
const BEACON_REPO = "forge.example.org/kestrel/beacon";
const SERIES = "series-lantern-weekly@example.org";

type Device = { name: string; token: string };
type Row = {
  id: string;
  evidence_id: string;
  kind: string;
  revision: number;
  started_at: Date;
  compartments: string[];
};

let store: TestStore;
let pusher: Reader;
let writer: Writer;
let owner: Admin;
let pipeline: Pipeline;
let mac: Device;
let pad: Device;
let own: TestClient;
let wide: TestClient;
const P = {} as Record<"harbor" | "lantern" | "quay" | "wharf" | "twinA" | "twinB" | "ledger", EntityId>;
const A = {} as Record<"harbor" | "lanternSeries" | "quayUrl" | "quayDocument" | "wharf", string>;
const names = new Map<string, string>();

const admin = <R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(store.db.urls.admin, sql, values);
const request = () => ({ requestId: `req-wtr-${randomBytes(6).toString("hex")}` });

// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block" | "task" | "forget">(kind: K): `${K}:${string}` =>
  `${kind}:01JWT2R${String((keys += 1)).padStart(19, "0")}`;
let batches = 0;
const batch = (): string => `work-read-${String((batches += 1)).padStart(4, "0")}`;

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
  return { name, token: capture.token };
}

async function push(items: CaptureItem[], device: Device = mac): Promise<void> {
  const answer = await pusher.pushCapture(device.token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  for (const item of answer.ok ? answer.value.items : [])
    expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}
async function drain(): Promise<void> {
  expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
}

const rowsOf = (key: string): Promise<Row[]> =>
  admin<Row>(
    "select id, evidence_id, kind, revision, started_at, compartments from knowledge.captures where capture_key = $1 order by compartments",
    [key],
  );
const rowOf = async (key: string): Promise<Row> => one(await rowsOf(key));
const splitOf = async (key: string, compartment: string): Promise<Row> =>
  one((await rowsOf(key)).filter((row) => row.compartments.join(",") === compartment));

const linkTo = async (key: string, project: EntityId, anchor: string): Promise<void> =>
  linkCapture(pipeline, await rowOf(key), key, project, anchor);

// Items.
type Block = BlockItem["blocks"][number];
const block = (
  app: { bundle: string; name: string },
  start: string,
  end: string,
  minutes: number,
  more: Partial<Block> = {},
): Block => ({ start, end, minutes, app, ...more });
// A block of one UTC day, by its clock times.
const on = (
  day: string,
  app: { bundle: string; name: string },
  from: string,
  to: string,
  minutes: number,
  more: Partial<Block> = {},
): Block => block(app, at(day, from), at(day, to), minutes, more);
const blockDay = (day: string, blocks: Block[], over: Partial<BlockItem> = {}): BlockItem => ({
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day,
  blocks,
  ...over,
});
const strongRepo = (value: string) => ({ value, method: "git_remote" as const, v: 1 });
const meeting = (startedAt: string, endedAt: string, over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt,
  endedAt,
  app: CALL,
  title: "Lantern weekly",
  consent: true,
  mode: "call",
  calendar: { start: startedAt, end: endedAt, uid: SERIES, attendees: [] },
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
  ...over,
});
const moment = (observedAt: string, endedAt: string, over: Partial<MomentItem>): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt,
  endedAt,
  app: VSCODE,
  entity: "doc",
  participants: [],
  text: "Plan, second draft.",
  read: "ax",
  ...over,
});
const task = (title: string, events: TaskItem["events"], over: Partial<TaskItem> = {}): TaskItem => ({
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title,
  events,
  ...over,
});

// Views.
async function viewsOf(token: string, wanted: WorkRequest): Promise<WorkViews> {
  const views = await store.reader.workViews(token, wanted);
  if (views === null) throw new Error("no current client");
  return views;
}
type Day = { am: HalfDay; pm: HalfDay; deep: DeepWorkDay; shown: string[] };
async function dayOf(token: string, day: string): Promise<Day> {
  const views = await viewsOf(token, { view: "day", day });
  const halves = views.day?.halfDays ?? [];
  const [am, pm] = halves;
  if (views.day === undefined || am === undefined || pm === undefined) throw new Error("no half-days");
  expect(halves).toHaveLength(2);
  return { am, pm, deep: views.day.deepWork, shown: views.shown };
}
async function openTasksOf(token: string): Promise<TaskView[]> {
  const views = await viewsOf(token, { view: "now" });
  if (views.now === undefined) throw new Error("no now view");
  return views.now.openTasks;
}

// A target by name: a project's by its name, a place by kind and value.
const nameOf = (target: WorkTarget): string =>
  "project" in target
    ? (names.get(target.project.id) ?? target.project.id)
    : `${target.where.kind}:${target.where.value.untrusted}`;
const targetsOf = (half: HalfDay): Record<string, number> =>
  Object.fromEntries(half.targets.map((one_) => [nameOf(one_.target), one_.minutes]));
const placesOf = (half: HalfDay): Record<string, number> =>
  Object.fromEntries(half.byPlace.map((one_) => [`${one_.by}:${one_.value.untrusted}`, one_.minutes]));
const total = (values: Record<string, number>): number => Object.values(values).reduce((sum, n) => sum + n, 0);
const partitions = (half: HalfDay): void =>
  expect(total(targetsOf(half))).toBeCloseTo(half.coverage.observedMinutes, 5);

const coverage = (over: Partial<HalfDay["coverage"]>): HalfDay["coverage"] => ({
  through: null,
  observedMinutes: 0,
  creditedMinutes: 0,
  unattributedMinutes: 0,
  weakMinutes: 0,
  dayCutBlocks: 0,
  dayCutMinutes: 0,
  pendingMinutes: 0,
  partial: false,
  ...over,
});

// The world's items, kept by name.
const M1 = meeting(at(D, "10:00"), at(D, "10:40"));
const M3 = meeting(at(D, "13:00"), at(D, "14:00"));
const MO1 = moment(at(D, "11:05"), at(D, "11:15"), {
  app: CHROME,
  entity: "page",
  url: `https://${DOCS}/guide/start`,
  text: "Getting started",
});
const MO2 = moment(at(D, "11:30"), at(D, "11:40"), {
  document: "~/test/quay/plan.md",
  thread: "Quay plan",
  text: "Plan, second draft.\nOpen questions\n\n",
});
// D: B1 a strong repository anchored to Harbor; B2 the same repository from a prompt, weak; B3
// a call app during M1, linked to Lantern by its series; B4 a browser on Quay's host, with MO1
// linked to Quay by its URL prefix; B5 a strong repository anchored to Harbor and a folder
// anchored to Wharf (two projects at step 3), 10 minutes over 20, with MO2 of its app linked to
// Quay; B6 a call app during the second half of M3.
const DAY_D = blockDay(D, [
  on(D, VSCODE, "09:00", "09:30", 30, { repository: strongRepo(HARBOR_REPO) }),
  on(D, TERM, "09:30", "10:00", 30, { repository: { value: HARBOR_REPO, method: "prompt_mention", v: 1 } }),
  on(D, CALL, "10:00", "11:00", 60),
  on(D, CHROME, "11:00", "11:20", 20, { host: DOCS }),
  on(D, VSCODE, "11:20", "11:40", 10, {
    repository: strongRepo(HARBOR_REPO),
    folder: { value: "~/test/wharf", method: "ax_document", v: 1 },
  }),
  on(D, CALL, "13:30", "14:00", 30),
]);
// The focus day: the anchored editor, Claude's app and the reader in a loop; a
// four-minute mail interruption; a meeting; an hour of mail.
const DAY_FOCUS = blockDay(FOCUS, [
  on(FOCUS, VSCODE, "09:00", "09:20", 20, { repository: strongRepo(HARBOR_REPO) }),
  on(FOCUS, CLAUDE, "09:20", "09:26", 6),
  on(FOCUS, READER, "09:26", "09:30", 4),
  on(FOCUS, VSCODE, "09:30", "09:50", 20, { repository: strongRepo(HARBOR_REPO) }),
  on(FOCUS, MAIL, "09:50", "09:54", 4),
  on(FOCUS, VSCODE, "09:54", "10:10", 16, { repository: strongRepo(HARBOR_REPO) }),
  on(FOCUS, FACETIME, "10:30", "11:00", 30),
  on(FOCUS, MAIL, "11:00", "12:00", 60),
]);
const DAY_CUTS = blockDay(CUTS, [on(CUTS, TERM, "09:00", "09:30", 30), on(CUTS, WORK, "09:30", "10:00", 30)], {
  cut: [
    { app: TERM.bundle, blocks: 3, minutes: 4.5 },
    { app: WORK.bundle, blocks: 2, minutes: 6 },
    { app: UNSCOPED, blocks: 7, minutes: 9 },
  ],
});
const DAY_PENDING = blockDay(PENDING, [on(PENDING, TERM, "09:00", "09:20", 20)]);
const DAY_NOON = blockDay(NOON, [on(NOON, TERM, "08:00", "08:40", 40), on(NOON, TERM, "11:00", "11:50", 50)]);
const DAY_BEACON = blockDay(BEACON, [
  on(BEACON, VSCODE, "09:00", "09:45", 45, { repository: strongRepo(BEACON_REPO) }),
  on(BEACON, TERM, "10:00", "10:15", 15, { repository: { value: BEACON_REPO, method: "prompt_mention", v: 1 } }),
]);
const DAY_ERASED = blockDay(ERASED, [on(ERASED, TERM, "09:00", "09:30", 30)]);
const DAY_FORGOTTEN = blockDay(FORGOTTEN, [on(FORGOTTEN, TERM, "09:00", "09:20", 20)]);
const DAY_REVISED = blockDay(REVISED, [on(REVISED, TERM, "09:00", "09:30", 15)]);
// America/Chicago: on SPRING 01:30 CST to 03:30 CDT is one hour, and 11:30 to 12:30 CDT crosses
// local noon; on FALL 01:30 CDT to 01:30 CST is one hour, and 11:30 to 12:30 CST crosses noon.
const DAY_SPRING = blockDay(SPRING, [
  block(TERM, "2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z", 60),
  block(TERM, "2026-03-08T16:30:00.000Z", "2026-03-08T17:30:00.000Z", 60),
]);
const DAY_FALL = blockDay(FALL, [
  block(TERM, "2025-11-02T06:30:00.000Z", "2025-11-02T07:30:00.000Z", 60),
  block(TERM, "2025-11-02T17:30:00.000Z", "2025-11-02T18:30:00.000Z", 60),
]);

// The owner's tasks. T1 is forty days old and never changed, its project typed in lower case; T2 to
// T4 type names that must not link; T5 is completed with a stated doneAt;
const created = (iso: string): TaskItem["events"][number] => ({ kind: "created", at: iso });
const T1 = task(
  "Call him back tomorrow about the harbor survey",
  [created(new Date(NOW.getTime() - 40 * DAY).toISOString())],
  { project: "harbor" },
);
const T2 = task("Paint the harborside fence", [created(at(TASKS, "08:00"))], { project: "Harborside" });
const T3 = task("Sort the twin crates", [created(at(TASKS, "08:05"))], { project: "Twin" });
const T4 = task("Reconcile the ledger", [created(at(TASKS, "08:10"))], { project: "Ledger" });
const T5 = task("Survey the harbor wall", [created(at(D, "08:00")), { kind: "completed", at: at(D, "12:30") }], {
  project: "Harbor",
  doneAt: at(D, "12:00"),
});
const T6 = task("Book the ferry", [created(at(TASKS, "09:00"))]);

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"], now: NOW, writer: false });
  const journal = journalPath(store.db.keyFile);
  pusher = createReader({ url: store.db.urls.reader, keys: store.db.keys, log: store.log });
  writer = createWriter({ url: store.db.urls.writer, keys: store.db.keys, log: store.log, journal });
  owner = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: store.log, journal });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  await connect(writer);
  mac = await addDevice("mac");
  pad = await addDevice("pad");
  await owner.lens.setDeviceTasks("mac", true);
  own = await insertClient(store.db, "desk-own", ["own"]);
  wide = await insertClient(store.db, "desk-wide", ["own", "employer:example"]);

  for (const app of [VSCODE])
    await owner.lens.addScope({ match: "bundle", value: app.bundle, compartment: "own", kinds: ["block", "moment"] });
  for (const app of [TERM, EDIT, CLAUDE, READER, MAIL, FACETIME])
    await owner.lens.addScope({ match: "bundle", value: app.bundle, compartment: "own", kinds: ["block"] });
  await owner.lens.addScope({ match: "bundle", value: CALL.bundle, compartment: "own", kinds: ["block", "meeting"] });
  await owner.lens.addScope({ match: "bundle", value: WORK.bundle, compartment: "employer:example", kinds: ["block"] });
  await owner.lens.addScope({ match: "host", value: DOCS, compartment: "own", kinds: ["block", "moment"] });

  const project = async (key: keyof typeof P, name: string, compartment = "own"): Promise<void> => {
    P[key] = await owner.projects.add(name, { compartment, ...request() });
    names.set(P[key], name);
  };
  await project("harbor", "Harbor");
  await project("lantern", "Lantern");
  await project("quay", "Quay");
  await project("wharf", "Wharf");
  await project("twinA", "Twin");
  await project("twinB", "Twin");
  await project("ledger", "Ledger", "employer:example");
  A.harbor = await owner.projects.anchor(P.harbor, { kind: "repository", value: HARBOR_REPO }, request());
  A.quayUrl = await owner.projects.anchor(P.quay, { kind: "url_prefix", value: `https://${DOCS}/guide` }, request());
  A.quayDocument = await owner.projects.anchor(P.quay, { kind: "document", value: "~/test/quay" }, request());
  A.wharf = await owner.projects.anchor(P.wharf, { kind: "document", value: "~/test/wharf" }, request());

  // The series anchor names a stored meeting's calendar entry.
  await push([M1, M3]);
  await drain();
  A.lanternSeries = await owner.projects.anchor(
    P.lantern,
    { seriesOf: (await rowOf(M1.key)).id as CaptureId },
    request(),
  );

  await push([
    DAY_D,
    MO1,
    MO2,
    DAY_FOCUS,
    DAY_CUTS,
    DAY_PENDING,
    DAY_NOON,
    DAY_BEACON,
    DAY_ERASED,
    DAY_FORGOTTEN,
    DAY_REVISED,
    DAY_SPRING,
    DAY_FALL,
  ]);
  await push([T1, T2, T3, T4, T5, T6]);
  await drain();
  for (const item of [DAY_D, MO1, MO2, DAY_FOCUS, T1, T5]) expect(await rowsOf(item.key), item.key).not.toEqual([]);
  expect(await rowsOf(DAY_CUTS.key)).toHaveLength(2);

  // What the link step leaves: M1 and M3 by the series, MO1 by the URL prefix, MO2 by the document.
  await linkTo(M1.key, P.lantern, A.lanternSeries);
  await linkTo(M3.key, P.lantern, A.lanternSeries);
  await linkTo(MO1.key, P.quay, A.quayUrl);
  await linkTo(MO2.key, P.quay, A.quayDocument);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await owner?.close();
  await writer?.close();
  await pusher?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("work views under the token", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("every view is built from what the caller's token returns: a token with no current client gets no views", async () => {
    const gone = await insertClient(store.db, "desk-gone", ["own"]);
    expect(await store.reader.workViews(gone.token, { view: "day", day: D })).not.toBeNull();
    await revokeClient(store.db, gone);
    expect(await store.reader.workViews(gone.token, { view: "day", day: D })).toBeNull();
    expect(await store.reader.workViews("pit_test-no-such-token", { view: "now" })).toBeNull();
    // The control: a current client's read is served.
    expect((await viewsOf(own.token, { view: "day", day: D })).day?.halfDays).toHaveLength(2);
  });

  it("computed at read, stored nowhere: every work-time read leaves every table but the read log as it was, rows compared before and after, and calls no model", async () => {
    const before = await snapshot(store.db);
    await viewsOf(own.token, { view: "now" });
    await viewsOf(own.token, { view: "day", day: D });
    await viewsOf(own.token, { view: "day", day: FOCUS });
    await viewsOf(own.token, { view: "project", project: P.harbor, days: 30 });
    await viewsOf(own.token, {
      view: "timeline",
      project: P.lantern,
      from: ms(at(D, "00:00")),
      to: ms(at(D, "00:00")) + DAY,
    });
    await viewsOf(own.token, { view: "matches", commitments: [] });
    await viewsOf(wide.token, { view: "day", day: CUTS });
    await store.admin.time.day(D);
    await store.admin.time.day(null);
    await store.admin.time.project(P.harbor, 30);
    const after = await snapshot(store.db);
    const outsideReadLog = (rows: Map<string, string>): string[] =>
      lines(rows).filter((line) => !line.startsWith("ledger.read_log ") && !line.startsWith("ledger.sessions "));
    expect(outsideReadLog(after)).toEqual(outsideReadLog(before));
    // No model call, no tool call logged by the read itself.
    for (const table of [
      "vault.model_calls",
      "vault.decision_calls",
      "policy.calls",
      "knowledge.claims",
      "knowledge.beliefs",
      "knowledge.captures",
    ]) {
      expect(
        lines(after).filter((line) => line.startsWith(`${table} `)),
        table,
      ).toEqual(lines(before).filter((line) => line.startsWith(`${table} `)));
    }
    // The control: the snapshot sees a write. A new block day is a new row.
    const control = blockDay("2026-01-05", [on("2026-01-05", TERM, "09:00", "09:05", 5)]);
    await push([control]);
    await drain();
    expect(outsideReadLog(await snapshot(store.db))).not.toEqual(outsideReadLog(after));
  });
});

describe("time per project", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("intervals, at read: one interval per credited sub-span, a block's minutes spread evenly over its span, and a meeting's own time only where no block covers it", async () => {
    const { am, pm } = await dayOf(own.token, D);
    // M1 lies inside B3, so its 40 minutes are B3's and add none: 150, not 190.
    expect(am.coverage.observedMinutes).toBeCloseTo(150, 5);
    // B5 holds 10 minutes over 20: 5 credited to Quay by MO2, 5 left at its folder. Quay's other 15 are B4's:
    // MO1's 10 and the 5 its page holds after it, to the block's end.
    expect(targetsOf(am)["folder:~/test/wharf"]).toBeCloseTo(5, 5);
    expect(targetsOf(am).Quay).toBeCloseTo(20, 5);
    // M3's first half is its own, its second B6's: 60, not 90.
    expect(pm.coverage.observedMinutes).toBeCloseTo(60, 5);
    expect(targetsOf(pm)).toEqual({ Lantern: 60 });
  });

  it("who gets an instant: a linked meeting, then the block's strong anchor, then a linked moment of the same app, then none; two projects at one step make it give none and the next step is tried", async () => {
    const { am } = await dayOf(own.token, D);
    expect(targetsOf(am)).toEqual({
      Lantern: 40,
      Harbor: 30,
      Quay: 20,
      [`repository:${HARBOR_REPO}`]: 30,
      "app:test.example.call": 20,
      [`host:${DOCS}`]: 5,
      "folder:~/test/wharf": 5,
    });
    partitions(am);
    // Each session says the step that credited most of it.
    const sessions = am.sessions.map((one_) => [nameOf(one_.target), one_.minutes, one_.basis]);
    expect(sessions).toEqual([
      ["Lantern", 40, "meeting"],
      ["Harbor", 30, "anchor"],
      [`repository:${HARBOR_REPO}`, 30, "none"],
      ["app:test.example.call", 20, "none"],
      // MO1's page holds to 11:20, so its stretch and MO2's at 11:30 are one Quay session across a 10-minute
      // excursion.
      ["Quay", 20, "moment"],
      [`host:${DOCS}`, 5, "none"],
      ["folder:~/test/wharf", 5, "none"],
    ]);
    // The weak repository is a place, marked weak, and credits nothing though Harbor's anchor
    // names it; the control is B1, the same repository from its git remote, credited to Harbor.
    const weak = am.targets.find((one_) => "where" in one_.target && one_.target.where.kind === "repository");
    expect(weak?.target).toEqual({
      where: { kind: "repository", value: { untrusted: HARBOR_REPO }, strength: "weak" },
    });
    expect(am.coverage).toEqual(
      coverage({
        through: at(D, "11:40"),
        observedMinutes: 150,
        creditedMinutes: 90,
        unattributedMinutes: 60,
        weakMinutes: 30,
      }),
    );
  });

  it("a URL prefix anchor reaches a block only through a moment: the browser block on Quay's host is Quay's only where MO1 covers it or its page holds after it", async () => {
    const { am } = await dayOf(own.token, D);
    // MO1 covers 11:05 to 11:15 and its page holds to the block's end at 11:20.
    expect(targetsOf(am).Quay).toBeCloseTo(20, 5);
    expect(targetsOf(am)[`host:${DOCS}`]).toBeCloseTo(5, 5);
    const quay = am.sessions.filter((one_) => nameOf(one_.target) === "Quay");
    // One session: the 10 minutes between 11:20 and 11:30 are an excursion.
    expect(quay.map((one_) => [one_.start, one_.end])).toEqual([[at(D, "11:05"), at(D, "11:40")]]);
  });

  it("the result is a partition, also when the meeting is pushed before its block day: the hour counts once", async () => {
    const call = meeting(at(LATE, "13:00"), at(LATE, "14:00"));
    await push([call]);
    await drain();
    await linkTo(call.key, P.lantern, A.lanternSeries);
    const first = await dayOf(own.token, LATE);
    expect(first.pm.coverage.observedMinutes).toBeCloseTo(60, 5);
    expect(targetsOf(first.pm)).toEqual({ Lantern: 60 });
    await push([blockDay(LATE, [on(LATE, CALL, "13:30", "14:00", 30)])]);
    await drain();
    const second = await dayOf(own.token, LATE);
    expect(second.pm.coverage.observedMinutes).toBeCloseTo(60, 5);
    expect(targetsOf(second.pm)).toEqual({ Lantern: 60 });
    partitions(second.pm);
    expect(second.pm.coverage.through).toBe(at(LATE, "14:00"));
    // The control: before the block day nothing in the half-day was a block's.
    expect(first.pm.coverage.through).toBeNull();
  });

  it("where two devices' blocks overlap the instant is the later-started block's, and where one call is recorded twice the earlier meeting's: each instant counts once", async () => {
    const recorded = meeting(at(TWO, "15:00"), at(TWO, "15:30"));
    const again = meeting(at(TWO, "15:10"), at(TWO, "15:40"));
    await push([blockDay(TWO, [on(TWO, TERM, "09:00", "10:00", 60)]), recorded, again]);
    await push([blockDay(TWO, [on(TWO, EDIT, "09:30", "10:30", 30)])], pad);
    await drain();
    await linkTo(recorded.key, P.lantern, A.lanternSeries);
    await linkTo(again.key, P.lantern, A.lanternSeries);
    const { am, pm } = await dayOf(own.token, TWO);
    // 09:00 to 09:30 is mac's, at its 60 minutes an hour; 09:30 to 10:30 pad's, at 30 over 60.
    expect(targetsOf(am)).toEqual({ "app:test.example.term": 30, "app:test.example.edit": 30 });
    expect(am.coverage.observedMinutes).toBeCloseTo(60, 5);
    partitions(am);
    // 15:00 to 15:40 once: 40, not 60.
    expect(targetsOf(pm)).toEqual({ Lantern: 40 });
    expect(pm.coverage.observedMinutes).toBeCloseTo(40, 5);
    partitions(pm);
  });

  it("anchors and links change, time follows: a repository anchor credits exactly the matching strong blocks at the next read, with no pi extract run, and lifting it returns their time to place", async () => {
    const beacon = await owner.projects.add("Beacon", request());
    names.set(beacon, "Beacon");
    const before = await dayOf(own.token, BEACON);
    // Both blocks keep their place, the strong one's and the weak one's alike.
    expect(targetsOf(before.am)).toEqual({ [`repository:${BEACON_REPO}`]: 60 });
    expect(before.am.coverage).toMatchObject({ creditedMinutes: 0, weakMinutes: 15 });
    const anchor = await owner.projects.anchor(beacon, { kind: "repository", value: BEACON_REPO }, request());
    const anchored = await dayOf(own.token, BEACON);
    expect(targetsOf(anchored.am)).toEqual({ Beacon: 45, [`repository:${BEACON_REPO}`]: 15 });
    expect(anchored.am.coverage).toMatchObject({ observedMinutes: 60, creditedMinutes: 45, weakMinutes: 15 });
    expect(await owner.projects.unanchor(anchor, request())).toBe(true);
    const lifted = await dayOf(own.token, BEACON);
    expect(lifted.am).toEqual(before.am);
    expect(lifted.pm).toEqual(before.pm);
  });

  it("unattributed time keeps its place: grouped by its most specific place, counted under each of its places, and by its category", async () => {
    const { am, pm } = await dayOf(own.token, D);
    // A block counts under every place it has, its app and host as well as its repository.
    expect(placesOf(am)).toEqual({
      [`repository:${HARBOR_REPO}`]: 70,
      "app:test.example.call": 60,
      "app:com.microsoft.VSCode": 40,
      "app:test.example.term": 30,
      "app:com.google.Chrome": 20,
      [`host:${DOCS}`]: 20,
      "folder:~/test/wharf": 10,
    });
    expect(am.byCategory).toEqual([
      { category: "other", minutes: 110 },
      { category: "coding", minutes: 40 },
    ]);
    // A meeting's own time is the meetings category, and has no place.
    expect(pm.byCategory).toEqual([
      { category: "meetings", minutes: 30 },
      { category: "other", minutes: 30 },
    ]);
    expect(placesOf(pm)).toEqual({ "app:test.example.call": 30 });
  });

  it("deletion, nothing to cascade: after an erasure, a forget and a new revision the next read of every view follows", async () => {
    // An erasure (pi erase item).
    const erased = await splitOf(DAY_ERASED.key, "own");
    const beforeErasure = await dayOf(own.token, ERASED);
    expect(beforeErasure.am.coverage.observedMinutes).toBeCloseTo(30, 5);
    expect(beforeErasure.shown).toContain(erased.evidence_id);
    expect(
      (await owner.erasure.eraseItem({ kind: "capture", id: erased.id as CaptureId }, { requestId: testId("req") }))
        .items,
    ).toBe(1);
    const afterErasure = await dayOf(own.token, ERASED);
    expect(afterErasure.am.coverage).toEqual(coverage({}));
    expect(afterErasure.am.targets).toEqual([]);
    expect(afterErasure.shown).not.toContain(erased.evidence_id);

    // A forget, which pi erase settle applies.
    expect((await dayOf(own.token, FORGOTTEN)).am.coverage.observedMinutes).toBeCloseTo(20, 5);
    const notice: ForgetItem = { kind: "forget", key: keyOf("forget"), keys: [DAY_FORGOTTEN.key] };
    await push([notice]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    expect((await dayOf(own.token, FORGOTTEN)).am.coverage).toEqual(coverage({}));

    // A new revision replaces the row, and its minutes.
    const first = await splitOf(DAY_REVISED.key, "own");
    expect((await dayOf(own.token, REVISED)).am.coverage.observedMinutes).toBeCloseTo(15, 5);
    await push([{ ...DAY_REVISED, revision: 1, blocks: [on(REVISED, TERM, "09:00", "09:30", 25)] }]);
    await drain();
    const revised = await dayOf(own.token, REVISED);
    expect(revised.am.coverage.observedMinutes).toBeCloseTo(25, 5);
    expect(revised.shown).not.toContain(first.evidence_id);
    expect(revised.shown).toContain((await splitOf(DAY_REVISED.key, "own")).evidence_id);

    // The control: a day none of them touched reads as it did.
    expect((await dayOf(own.token, D)).am.coverage.observedMinutes).toBeCloseTo(150, 5);
  });
});

describe("the half-day record", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a view, twice a day: a half-day equals a hand count in the owner's zone, UTC while they have set none", async () => {
    const { am, pm } = await dayOf(own.token, D);
    expect([am.from, am.to, pm.from, pm.to]).toEqual([
      at(D, "00:00"),
      at(D, "12:00"),
      at(D, "12:00"),
      "2026-03-17T00:00:00.000Z",
    ]);
    expect(am.coverage).toEqual(
      coverage({
        through: at(D, "11:40"),
        observedMinutes: 150,
        creditedMinutes: 90,
        unattributedMinutes: 60,
        weakMinutes: 30,
      }),
    );
    expect(pm.coverage).toEqual(coverage({ through: at(D, "14:00"), observedMinutes: 60, creditedMinutes: 60 }));
    // The meetings that started in each half, with their project (no calendar event is stored, so
    // whatever `meeting` holds is not this test's).
    const m1 = await rowOf(M1.key);
    const m3 = await rowOf(M3.key);
    const meetingsOf = (half: HalfDay) =>
      half.meetings.map(({ capture, start, end, project }) => ({ capture, start, end, project: project?.id ?? null }));
    expect(meetingsOf(am)).toEqual([{ capture: m1.id, start: M1.startedAt, end: M1.endedAt, project: P.lantern }]);
    expect(meetingsOf(pm)).toEqual([{ capture: m3.id, start: M3.startedAt, end: M3.endedAt, project: P.lantern }]);
    // The task changes in each half: T5 created in the morning, completed in the afternoon.
    const t5 = await rowOf(T5.key);
    expect(am.tasks.map((one_) => one_.capture)).toEqual([t5.id]);
    expect(pm.tasks.map((one_) => one_.capture)).toEqual([t5.id]);
    expect(pm.sessions.map((one_) => [nameOf(one_.target), one_.minutes, one_.basis])).toEqual([
      ["Lantern", 60, "meeting"],
    ]);
    expect(am.more).toBe(false);
    partitions(am);
    partitions(pm);
  });

  it("new lines: a half-day's threads are the new lines of the moments that started in it, by app and thread", async () => {
    const { am, pm } = await dayOf(own.token, D);
    expect(am.threads).toEqual([
      { app: { untrusted: VSCODE.bundle }, thread: { untrusted: "Quay plan" }, lines: 2 },
      { app: { untrusted: CHROME.bundle }, thread: null, lines: 1 },
    ]);
    expect(pm.threads).toEqual([]);
  });

  it("fresh at noon: the noon revision makes the morning current and the midnight revision replaces it; R32: through is the latest block end the caller can see, and a day ending after it by more than ten minutes is incomplete", async () => {
    const noon = await dayOf(own.token, NOON);
    expect(noon.am.coverage).toEqual(
      coverage({ through: at(NOON, "11:50"), observedMinutes: 90, unattributedMinutes: 90 }),
    );
    expect(noon.pm.coverage).toEqual(coverage({}));
    expect(noon.deep).toMatchObject({ complete: false, coverage: { through: at(NOON, "11:50"), observedMinutes: 90 } });
    await push([
      {
        ...DAY_NOON,
        revision: 1,
        blocks: [...DAY_NOON.blocks, on(NOON, TERM, "14:00", "15:00", 60), on(NOON, TERM, "23:45", "23:55", 10)],
      },
    ]);
    await drain();
    expect(await rowsOf(DAY_NOON.key)).toHaveLength(1);
    const midnight = await dayOf(own.token, NOON);
    expect(midnight.am.coverage).toEqual(noon.am.coverage);
    expect(midnight.pm.coverage).toEqual(
      coverage({ through: at(NOON, "23:55"), observedMinutes: 70, unattributedMinutes: 70 }),
    );
    // Five minutes short of midnight is complete.
    expect(midnight.deep).toMatchObject({
      complete: true,
      coverage: { through: at(NOON, "23:55"), observedMinutes: 160 },
    });
  });

  it("coverage is visible: a day's cuts are served at the day's level by compartment, the same on both halves, and no own caller sees an employer's", async () => {
    const mine = await dayOf(own.token, CUTS);
    for (const half of [mine.am, mine.pm]) expect(half.coverage).toMatchObject({ dayCutBlocks: 3, dayCutMinutes: 4.5 });
    expect(mine.am.coverage.observedMinutes).toBeCloseTo(30, 5);
    expect(mine.pm.coverage.observedMinutes).toBe(0);
    // The control: a client cleared for the employer sees both splits' cuts, and the cut no rule
    // admits reaches no one.
    const theirs = await dayOf(wide.token, CUTS);
    for (const half of [theirs.am, theirs.pm])
      expect(half.coverage).toMatchObject({ dayCutBlocks: 5, dayCutMinutes: 10.5 });
    expect(theirs.am.coverage.observedMinutes).toBeCloseTo(60, 5);
  });

  it("a block day whose work_enc is still null counts its clear minutes as pending, on both halves, neither observed nor cut", async () => {
    const before = await dayOf(own.token, PENDING);
    expect(before.am.coverage).toEqual(
      coverage({ through: at(PENDING, "09:20"), observedMinutes: 20, unattributedMinutes: 20 }),
    );
    const row = await splitOf(DAY_PENDING.key, "own");
    await admin("update knowledge.captures set work_enc = null where id = $1", [row.id]);
    const after = await dayOf(own.token, PENDING);
    expect(after.am.coverage).toEqual(coverage({ pendingMinutes: 20 }));
    expect(after.pm.coverage).toEqual(coverage({ pendingMinutes: 20 }));
    expect(after.am.targets).toEqual([]);
  });

  it("what the record is not: no claim, belief, item or row records a half-day, session or focus", async () => {
    const count = async () =>
      one(
        await admin<{ claims: number; captures: number; kinds: string[] }>(
          `select (select count(*)::int from knowledge.claims) as claims,
             (select count(*)::int from knowledge.captures) as captures, (select coalesce(array_agg(distinct kind order by kind), '{}') from knowledge.captures) as kinds`,
        ),
      );
    const before = await count();
    for (const day of [D, FOCUS, NOON]) await dayOf(own.token, day);
    await viewsOf(own.token, { view: "now" });
    await store.admin.time.day(FOCUS);
    expect(await count()).toEqual(before);
    // Capture rows are the items Lens sent and nothing else: no digest, session or focus kind.
    for (const kind of before.kinds) expect(["block", "meeting", "moment", "task"]).toContain(kind);
  });
});

describe("the owner's tasks", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a task is read from its item: its view carries its title, typed project, recorded completion and stated doneAt from its work_enc, with advisory worked-on minutes", async () => {
    const { am } = await dayOf(own.token, D);
    const t5 = await rowOf(T5.key);
    expect(am.tasks).toEqual([
      {
        capture: t5.id,
        title: { untrusted: T5.title },
        project: expect.objectContaining({ id: P.harbor }),
        createdAt: at(D, "08:00"),
        completionRecordedAt: at(D, "12:30"),
        doneAt: at(D, "12:00"),
        reopened: 0,
        // From its creation to its stated doneAt: B1's 30 minutes on Harbor, in one session; T1
        // was open on Harbor all the while.
        workedOn: {
          rule: "match@1",
          advisory: true,
          minutes: 30,
          sessions: 1,
          from: at(D, "08:00"),
          to: at(D, "12:00"),
          shared: 1,
          partial: false,
        },
      },
    ]);
  });

  it("task rows are gathered whole: a task created forty days ago and never changed is in openTasks, its title served as written", async () => {
    const open = await openTasksOf(own.token);
    const t1 = await rowOf(T1.key);
    const view = open.find((one_) => one_.capture === t1.id);
    expect(view).toMatchObject({
      title: { untrusted: "Call him back tomorrow about the harbor survey" },
      completionRecordedAt: null,
      doneAt: null,
      reopened: 0,
      workedOn: null,
    });
    expect(view?.createdAt).toBe(new Date(NOW.getTime() - 40 * DAY).toISOString());
    // The control: the completed task is not open.
    expect(open.map((one_) => one_.capture)).not.toContain((await rowOf(T5.key)).id);
  });

  it("a task's project is a name the owner typed: linked when exactly one active project the caller can see within its label has it, in lower case; not inside a word, not with two of that name, not outside its label", async () => {
    const open = await openTasksOf(own.token);
    const ids = await Promise.all([T6, T4, T3, T2, T1].map(async (item) => (await rowOf(item.key)).id));
    // Newest created first.
    expect(open.map((one_) => one_.capture)).toEqual(ids);
    expect(open.map((one_) => one_.project?.id ?? null)).toEqual([null, null, null, null, P.harbor]);
    // Ledger is an employer project: a client cleared for it still sees the own task unlinked.
    const theirs = await openTasksOf(wide.token);
    expect(theirs.find((one_) => one_.capture === ids[1])?.project).toBeNull();
    expect(theirs.find((one_) => one_.capture === ids[4])?.project).toMatchObject({ id: P.harbor });
  });

  it("edit and forget: an edit replaces the task's row and its view; a forget removes it, and so does pi erase item", async () => {
    const t6 = await rowOf(T6.key);
    await push([
      {
        ...T6,
        revision: 1,
        title: "Book the ferry and the van",
        events: [...T6.events, { kind: "edited", at: at(TASKS, "10:00") }],
      },
    ]);
    await drain();
    const edited = (await openTasksOf(own.token)).find((one_) => one_.capture === t6.id);
    expect(edited?.title).toEqual({ untrusted: "Book the ferry and the van" });
    const notice: ForgetItem = { kind: "forget", key: keyOf("forget"), keys: [T6.key] };
    await push([notice]);
    expect(await owner.lens.settleForgets()).toMatchObject({ settled: 1, failed: 0 });
    const t2 = await rowOf(T2.key);
    expect(
      (await owner.erasure.eraseItem({ kind: "capture", id: t2.id as CaptureId }, { requestId: testId("req") })).items,
    ).toBe(1);
    const open = (await openTasksOf(own.token)).map((one_) => one_.capture);
    expect(open).not.toContain(t6.id);
    expect(open).not.toContain(t2.id);
    // The control: the tasks neither named are still served.
    expect(open).toContain((await rowOf(T1.key)).id);
    expect(open).toContain((await rowOf(T3.key)).id);
  });
});

describe("deep work and focus", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the loop is focus: the anchored editor, Claude's app and the reader on one project are one deep session, and the day's three totals sum to its observed minutes", async () => {
    const { am, deep } = await dayOf(own.token, FOCUS);
    expect(deep).toMatchObject({ rule: "deep@1", day: FOCUS, complete: false, more: false });
    expect(deep.coverage).toMatchObject({ through: at(FOCUS, "12:00"), observedMinutes: 160 });
    // Own 56 on Harbor, Claude's 6 and the reader's 4 carried between two Harbor stretches, the
    // four minutes of mail an interruption.
    expect(deep.sessions).toEqual([
      {
        target: { project: expect.objectContaining({ id: P.harbor }) },
        start: at(FOCUS, "09:00"),
        end: at(FOCUS, "10:10"),
        minutes: 66,
        carriedMinutes: 10,
        interruptions: 1,
        interruptedMinutes: 4,
      },
    ]);
    expect(deep.interruptions).toEqual([{ category: "communication", count: 1, minutes: 4 }]);
    expect([deep.meetingMinutes, deep.deepMinutes, deep.switchingMinutes]).toEqual([30, 66, 64]);
    expect(deep.meetingMinutes + deep.deepMinutes + deep.switchingMinutes).toBeCloseTo(
      deep.coverage.observedMinutes,
      5,
    );
    // Into and out of the mail stretch, and from the meeting to the hour of mail; the carry makes
    // none, and the 20 minutes before the meeting are a gap.
    expect(deep.switches).toBe(3);
    expect(deep.switchesPerHour).toBe(1.1);
    // Carrying credits nothing: Harbor's time is its own 56 minutes.
    expect(targetsOf(am).Harbor).toBeCloseTo(56, 5);
    expect(am.sessions.filter((one_) => nameOf(one_.target) === "Harbor").map((one_) => one_.minutes)).toEqual([56]);
  });
});

describe("pi time and the read log", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the owner's terminal: timeDay gives a local day's two half-days and its deep work as the owner's audience sees them, today by default", async () => {
    const focus = await store.admin.time.day(FOCUS);
    const mine = await dayOf(own.token, FOCUS);
    expect(focus).toEqual({ day: FOCUS, zone: null, halfDays: [mine.am, mine.pm], deepWork: mine.deep, proposals: [] });
    // The owner's audience holds the employer's split too: its cuts and minutes, as the wider
    // client's, not the own client's.
    const cuts = await store.admin.time.day(CUTS);
    const theirs = await dayOf(wide.token, CUTS);
    expect(cuts.halfDays).toEqual([theirs.am, theirs.pm]);
    expect(cuts.deepWork).toEqual(theirs.deep);
    expect(cuts.halfDays).not.toEqual((await viewsOf(own.token, { view: "day", day: CUTS })).day?.halfDays);
    // Today in the owner's zone (UTC unset) by the store's clock.
    expect((await store.admin.time.day(null)).day).toBe("2026-03-17");
  });

  it("timeProject gives a project's time, its sessions over the days asked and its tasks, and refuses not_found for no such project", async () => {
    const harbor = await store.admin.time.project(P.harbor, 30);
    // D's 30 minutes and the focus day's 56; the D session newest.
    expect(harbor.time).toMatchObject({ last7: 86, last30: 86, openTasks: 1, done30: 1, partial: false });
    expect(harbor.time.lastSession).toMatchObject({
      start: at(D, "09:00"),
      end: at(D, "09:30"),
      minutes: 30,
      basis: "anchor",
    });
    expect(harbor.sessions.map((one_) => [one_.start, one_.minutes])).toEqual([
      [at(D, "09:00"), 30],
      [at(FOCUS, "09:00"), 56],
    ]);
    expect(harbor.tasks.map((one_) => one_.capture)).toEqual([(await rowOf(T5.key)).id, (await rowOf(T1.key)).id]);
    // The same as a client's project view.
    expect((await viewsOf(own.token, { view: "project", project: P.harbor, days: 30 })).project).toEqual(harbor);
    // The refusal, with the control above.
    const refused = await store.admin.time.project(testId("ent"), 30).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AdminError);
    expect((refused as AdminError).code).toBe("not_found");
  });

  it("read logging: shown holds the evidence ids of the capture items the view used, and of no item outside it", async () => {
    const { shown } = await dayOf(own.token, D);
    const used = await Promise.all([
      splitOf(DAY_D.key, "own"),
      rowOf(M1.key),
      rowOf(M3.key),
      rowOf(MO1.key),
      rowOf(MO2.key),
      rowOf(T5.key),
    ]);
    expect(shown).toEqual(used.map((row) => row.evidence_id).sort());
    // The control: another day's block day and an open task are not in it.
    expect(shown).not.toContain((await splitOf(DAY_FOCUS.key, "own")).evidence_id);
    expect(shown).not.toContain((await rowOf(T1.key)).evidence_id);
  });
});

// Last: it sets the owner's zone, which every read after it would follow.
describe("the owner's zone", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("on the days the owner's zone changes to and from daylight time the morning is 11 and 13 hours, and every minute lands in exactly one half", async () => {
    expect(await owner.accounts.setTimeZone("America/Chicago")).toBe("America/Chicago");
    const spring = await dayOf(own.token, SPRING);
    expect([spring.am.from, spring.am.to, spring.pm.to]).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T17:00:00.000Z",
      "2026-03-09T05:00:00.000Z",
    ]);
    expect(ms(spring.am.to) - ms(spring.am.from)).toBe(11 * HOUR);
    // The hour through the missing one is its 60 minutes; the block across noon splits 30 and 30.
    expect(spring.am.coverage.observedMinutes).toBeCloseTo(90, 5);
    expect(spring.pm.coverage.observedMinutes).toBeCloseTo(30, 5);
    const fall = await dayOf(own.token, FALL);
    expect([fall.am.from, fall.am.to, fall.pm.to]).toEqual([
      "2025-11-02T05:00:00.000Z",
      "2025-11-02T18:00:00.000Z",
      "2025-11-03T06:00:00.000Z",
    ]);
    expect(ms(fall.am.to) - ms(fall.am.from)).toBe(13 * HOUR);
    expect(fall.am.coverage.observedMinutes).toBeCloseTo(90, 5);
    expect(fall.pm.coverage.observedMinutes).toBeCloseTo(30, 5);
    expect(fall.deep.coverage.observedMinutes).toBeCloseTo(120, 5);
    // pi time day reads the same windows, with the zone named.
    const owners = await store.admin.time.day(SPRING);
    expect(owners.zone).toBe("America/Chicago");
    expect(owners.halfDays.map((half) => [half.from, half.to])).toEqual([
      [spring.am.from, spring.am.to],
      [spring.pm.from, spring.pm.to],
    ]);
  });
});
