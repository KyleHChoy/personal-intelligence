import { randomBytes } from "node:crypto";
import {
  type BlockItem,
  type CaptureId,
  type CaptureItem,
  type DeepWorkDay,
  type EntityId,
  type HalfDay,
  type MeetingItem,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  type TaskItem,
  type WorkTarget,
} from "@intelligence/contracts/personal";
import type { WorkRequest, WorkViews } from "@intelligence/personal-core/lens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { createReader, type Reader } from "../read/read.ts";
import { connect } from "../test-support/cast.ts";
import { insertClient, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { linkCapture } from "../test-support/lens-setup.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { journalPath } from "./journal.ts";

// Labels and invariant 6 for work time. Nothing a viewer cannot see changes anything the viewer
// sees: an `own` client's views (the half-days, sessions, deep-work day, a project's time and
// timeline, worked-on minutes, coverage and `shown`) are byte for byte those of the same store
// before any `employer:example` row or project existed, while a client cleared for the employer
// sees them change (the positive control). The employer's rows sit where they could leak: a block
// inside a project's tolerated excursion, one inside a carry, one beside a visible meeting, and a
// project anchored to a repository an own block also names, so an own block is never credited to an
// employer project.
//
// One database, `own` and `employer:example`; a Lens device made by hand with its four source
// accounts, scope rules by `addScope`, items by `pushCapture` and `takeCapture`, projects and
// anchors by the owner's commands, and the link step's capture.anchor claim committed through the
// Pipeline. The world is read twice in beforeAll, before and after the employer's rows; the tests
// compare. The reader that reads is pinned to NOW; pushes go through an unpinned one. UTC; the
// owner sets no zone. Reserved domains and test bundles, and the category table's product bundle
// ids where a category must be a word. No model is called.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date("2026-04-08T13:00:00.000Z");
const FD = "2026-04-07";
const at = (time: string): string => `${FD}T${time}:00.000Z`;

const VSCODE = { bundle: "com.microsoft.VSCode", name: "Editor" };
const CLAUDE = { bundle: "com.anthropic.claudefordesktop", name: "Claude" };
const TERM = { bundle: "test.example.term", name: "Term" };
const CALL = { bundle: "test.example.call", name: "Call" };
const WORK = { bundle: "test.example.work", name: "Work" };
const HARBOR_REPO = "forge.example.org/kestrel/harbor";
const LEDGER_REPO = "forge.example.org/kestrel/ledger";
const SERIES = "series-lantern-labels@example.org";

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
let token: string;
let own: TestClient;
let wide: TestClient;
const P = {} as Record<"harbor" | "lantern" | "ledger", EntityId>;
const names = new Map<string, string>();

const admin = <R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(store.db.urls.admin, sql, values);
const request = () => ({ requestId: `req-wtl-labels-${randomBytes(6).toString("hex")}` });

let keys = 0;
const keyOf = <K extends "meeting" | "block" | "task" | "moment">(kind: K): `${K}:${string}` =>
  `${kind}:01JWT2B${String((keys += 1)).padStart(19, "0")}`;
let batches = 0;
const batch = (): string => `work-labels-${String((batches += 1)).padStart(4, "0")}`;

// A device as `pi lens add mac` makes it from WT1.3 on, by hand, with its four source accounts.
async function addDevice(name: string): Promise<string> {
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
  return capture.token;
}

async function push(items: CaptureItem[]): Promise<void> {
  const answer = await pusher.pushCapture(token, { batch: batch(), items });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  for (const item of answer.ok ? answer.value.items : [])
    expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
  expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
}

const rowOf = async (key: string): Promise<Row> =>
  one(
    await admin<Row>(
      "select id, evidence_id, kind, revision, started_at, compartments from knowledge.captures where capture_key = $1",
      [key],
    ),
  );

const linkTo = async (key: string, project: EntityId, anchor: string): Promise<void> =>
  linkCapture(pipeline, await rowOf(key), key, project, anchor);

type Block = BlockItem["blocks"][number];
const on = (
  app: { bundle: string; name: string },
  from: string,
  to: string,
  minutes: number,
  more: Partial<Block> = {},
): Block => ({ start: at(from), end: at(to), minutes, app, ...more });
const repo = (value: string) => ({ value, method: "git_remote" as const, v: 1 });
const MM: MeetingItem = {
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: at("14:00"),
  endedAt: at("14:30"),
  app: CALL,
  title: "Lantern review",
  consent: true,
  mode: "call",
  calendar: { start: at("14:00"), end: at("14:30"), uid: SERIES, attendees: [] },
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
};
// The own day: Harbor's editor with a four-minute gap, then Harbor around Claude's six minutes
// and a three-minute gap (a carry), then an own terminal on the repository the employer's project
// will anchor.
const OWN_DAY: BlockItem = {
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: FD,
  blocks: [
    on(VSCODE, "09:00", "09:20", 20, { repository: repo(HARBOR_REPO) }),
    on(VSCODE, "09:24", "09:50", 26, { repository: repo(HARBOR_REPO) }),
    on(VSCODE, "10:00", "10:15", 15, { repository: repo(HARBOR_REPO) }),
    on(CLAUDE, "10:15", "10:21", 6),
    on(VSCODE, "10:24", "10:40", 16, { repository: repo(HARBOR_REPO) }),
    on(TERM, "11:00", "11:30", 30, { repository: repo(LEDGER_REPO) }),
  ],
};
// The employer's split of the same day, as its own item: W1 inside Harbor's excursion, on the
// repository Ledger is anchored to; W2 inside the carry; W3 beside the own meeting; and its cut.
const EMPLOYER_DAY: BlockItem = {
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: FD,
  blocks: [
    on(WORK, "09:20", "09:24", 4, { repository: repo(LEDGER_REPO) }),
    on(WORK, "10:21", "10:24", 3),
    on(WORK, "14:10", "14:20", 10),
  ],
  cut: [{ app: WORK.bundle, blocks: 2, minutes: 6 }],
};
const done: TaskItem = {
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title: "Ship the harbor fix",
  project: "Harbor",
  events: [
    { kind: "created", at: at("08:00") },
    { kind: "completed", at: at("11:00") },
  ],
};
const ledgerTask: TaskItem = {
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title: "Read the ledger notes",
  project: "Ledger",
  events: [{ kind: "created", at: at("08:30") }],
};

// Every view a client is served, as the wire sees it.
const REQUESTS = (): Record<string, WorkRequest> => ({
  now: { view: "now" },
  day: { view: "day", day: FD },
  project: { view: "project", project: P.harbor, days: 30 },
  timeline: { view: "timeline", project: P.harbor, from: Date.parse(at("00:00")), to: Date.parse(at("00:00")) + DAY },
  lantern: { view: "timeline", project: P.lantern, from: Date.parse(at("00:00")), to: Date.parse(at("00:00")) + DAY },
});
type Read = Record<string, WorkViews>;
async function readAll(client: TestClient): Promise<Read> {
  const read: Read = {};
  for (const [name, wanted] of Object.entries(REQUESTS())) {
    const views = await store.reader.workViews(client.token, wanted);
    if (views === null) throw new Error("no current client");
    read[name] = views;
  }
  return read;
}
const json = (read: Read): Record<string, string> =>
  Object.fromEntries(Object.entries(read).map(([name, views]) => [name, JSON.stringify(views)]));

let before: { own: Read; wide: Read };
let after: { own: Read; wide: Read };

const halvesOf = (read: Read): { am: HalfDay; pm: HalfDay; deep: DeepWorkDay } => {
  const day = read.day?.day;
  const [am, pm] = day?.halfDays ?? [];
  if (day === undefined || am === undefined || pm === undefined) throw new Error("no day view");
  return { am, pm, deep: day.deepWork };
};
const nameOf = (target: WorkTarget): string =>
  "project" in target
    ? (names.get(target.project.id) ?? target.project.id)
    : `${target.where.kind}:${target.where.value.untrusted}`;
const targetsOf = (half: HalfDay): Record<string, number> =>
  Object.fromEntries(half.targets.map((one_) => [nameOf(one_.target), one_.minutes]));

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"], now: NOW, writer: false });
  const journal = journalPath(store.db.keyFile);
  pusher = createReader({ url: store.db.urls.reader, keys: store.db.keys, log: store.log });
  writer = createWriter({ url: store.db.urls.writer, keys: store.db.keys, log: store.log, journal });
  owner = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: store.log, journal });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  await connect(writer);
  token = await addDevice("mac");
  await owner.lens.setDeviceTasks("mac", true);
  own = await insertClient(store.db, "desk-own", ["own"]);
  wide = await insertClient(store.db, "desk-wide", ["own", "employer:example"]);
  for (const app of [VSCODE, CLAUDE, TERM])
    await owner.lens.addScope({ match: "bundle", value: app.bundle, compartment: "own", kinds: ["block"] });
  await owner.lens.addScope({ match: "bundle", value: CALL.bundle, compartment: "own", kinds: ["block", "meeting"] });
  await owner.lens.addScope({ match: "bundle", value: WORK.bundle, compartment: "employer:example", kinds: ["block"] });

  // The world without the employer: own rows, own projects and anchors, the meeting's link.
  P.harbor = await owner.projects.add("Harbor", request());
  P.lantern = await owner.projects.add("Lantern", request());
  names.set(P.harbor, "Harbor").set(P.lantern, "Lantern");
  await owner.projects.anchor(P.harbor, { kind: "repository", value: HARBOR_REPO }, request());
  await push([MM]);
  const series = await owner.projects.anchor(P.lantern, { seriesOf: (await rowOf(MM.key)).id as CaptureId }, request());
  await linkTo(MM.key, P.lantern, series);
  await push([OWN_DAY, done, ledgerTask]);
  before = { own: await readAll(own), wide: await readAll(wide) };

  // The employer's project, its anchor on the repository an own block names, and its rows.
  P.ledger = await owner.projects.add("Ledger", { compartment: "employer:example", ...request() });
  names.set(P.ledger, "Ledger");
  await owner.projects.anchor(P.ledger, { kind: "repository", value: LEDGER_REPO }, request());
  await push([EMPLOYER_DAY]);
  expect((await rowOf(EMPLOYER_DAY.key)).compartments).toEqual(["employer:example"]);
  after = { own: await readAll(own), wide: await readAll(wide) };
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await owner?.close();
  await writer?.close();
  await pusher?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("labels and invariant 6", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("labels and invariant 6: an own client's half-days, sessions, deep-work day, project time, timelines, coverage, worked-on minutes and shown are byte for byte those of the store before any employer:example row or project existed; the wider client's differ", async () => {
    expect(json(after.own)).toEqual(json(before.own));
    // The positive control: the wider client sees the employer's rows, in the day and its record.
    expect(json(after.wide).day).not.toEqual(json(before.wide).day);
    expect(json(after.wide).now).not.toEqual(json(before.wide).now);
    const employer = await rowOf(EMPLOYER_DAY.key);
    expect(after.wide.day?.shown).toContain(employer.evidence_id);
    expect(after.own.day?.shown).not.toContain(employer.evidence_id);
    // Before the employer existed, the two clients were served the same.
    expect(json(before.wide)).toEqual(json(before.own));
  });

  it("an employer split's cuts reach no own caller, and reach the wider client on both halves of the day", () => {
    const mine = halvesOf(after.own);
    const theirs = halvesOf(after.wide);
    for (const half of [mine.am, mine.pm]) expect(half.coverage).toMatchObject({ dayCutBlocks: 0, dayCutMinutes: 0 });
    for (const half of [theirs.am, theirs.pm])
      expect(half.coverage).toMatchObject({ dayCutBlocks: 2, dayCutMinutes: 6 });
  });
});

describe("crediting within the label", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("every project a credit names has compartments within the block's: an own block on the employer project's repository is never credited to it, and the employer's block on it is (the control)", () => {
    const theirs = halvesOf(after.wide);
    const credited = targetsOf(theirs.am);
    expect(credited.Ledger).toBeCloseTo(4, 5);
    expect(credited[`repository:${LEDGER_REPO}`]).toBeCloseTo(30, 5);
    expect(targetsOf(halvesOf(after.own).am)).toEqual({
      Harbor: 77,
      [`repository:${LEDGER_REPO}`]: 30,
      "app:com.anthropic.claudefordesktop": 6,
    });
    // The wider client's Harbor time is the own client's: the employer's blocks sit in Harbor's gaps.
    expect(credited.Harbor).toBeCloseTo(77, 5);
  });

  it("a task's project links within its label only: an own task naming the employer's project stays unlinked, even for the wider client", async () => {
    const task = (await rowOf(ledgerTask.key)).id;
    for (const read of [after.own, after.wide]) {
      const view = read.now?.now?.openTasks.find((one_) => one_.capture === task);
      expect(view?.title).toEqual({ untrusted: ledgerTask.title });
      expect(view?.project).toBeNull();
    }
    // The control: the own task naming Harbor links.
    const harbor = (await rowOf(done.key)).id;
    expect(after.own.project?.project?.tasks.find((one_) => one_.capture === harbor)?.project).toMatchObject({
      id: P.harbor,
    });
  });

  it("a block outside the caller's clearance never takes minutes from a meeting the caller can see", () => {
    expect(targetsOf(halvesOf(after.own).pm)).toEqual({ Lantern: 30 });
    expect(halvesOf(after.own).pm.coverage.observedMinutes).toBeCloseTo(30, 5);
    // The control: for the wider client the employer's block covers ten of the meeting's minutes,
    // and reads no meeting outside its own label.
    expect(targetsOf(halvesOf(after.wide).pm)).toEqual({ Lantern: 20, "app:test.example.work": 10 });
    expect(halvesOf(after.wide).pm.coverage.observedMinutes).toBeCloseTo(30, 5);
  });
});

describe("deep work under labels", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("hidden rows inside a carry or an excursion change nothing an own client sees: two Harbor sessions, the carry kept and no interruption; the wider client sees the employer's block interrupt and the carry broken", () => {
    const mine = halvesOf(after.own).deep;
    expect(mine.sessions).toEqual([
      {
        target: { project: expect.objectContaining({ id: P.harbor }) },
        start: at("09:00"),
        end: at("09:50"),
        minutes: 46,
        carriedMinutes: 0,
        interruptions: 0,
        interruptedMinutes: 0,
      },
      {
        target: { project: expect.objectContaining({ id: P.harbor }) },
        start: at("10:00"),
        end: at("10:40"),
        minutes: 37,
        carriedMinutes: 6,
        interruptions: 0,
        interruptedMinutes: 0,
      },
    ]);
    expect(mine.interruptions).toEqual([]);
    expect([mine.meetingMinutes, mine.deepMinutes, mine.switchingMinutes, mine.switches]).toEqual([30, 83, 30, 0]);
    expect(mine.coverage.observedMinutes).toBeCloseTo(143, 5);
    // The control.
    const theirs = halvesOf(after.wide).deep;
    expect(theirs.sessions).toEqual([
      {
        target: { project: expect.objectContaining({ id: P.harbor }) },
        start: at("09:00"),
        end: at("09:50"),
        minutes: 46,
        carriedMinutes: 0,
        interruptions: 1,
        interruptedMinutes: 4,
      },
    ]);
    expect(theirs.interruptions).toEqual([{ category: "other", count: 1, minutes: 4 }]);
    // 143, the employer's 4, 3 and 10, less the 10 its block takes from the meeting's own time.
    expect(theirs.coverage.observedMinutes).toBeCloseTo(150, 5);
    expect(theirs.meetingMinutes).toBeCloseTo(20, 5);
    expect(theirs.meetingMinutes + theirs.deepMinutes + theirs.switchingMinutes).toBeCloseTo(
      theirs.coverage.observedMinutes,
      5,
    );
  });

  it("worked-on minutes are computed from what the caller can see: the own task's 77 minutes on Harbor in one session, the same for both clients", async () => {
    const harbor = (await rowOf(done.key)).id;
    for (const read of [after.own, after.wide]) {
      const view = read.project?.project?.tasks.find((one_) => one_.capture === harbor);
      expect(view?.workedOn).toEqual({
        rule: "match@1",
        advisory: true,
        minutes: 77,
        sessions: 1,
        from: at("08:00"),
        to: at("11:00"),
        shared: 0,
        partial: false,
      });
    }
  });
});

describe("an agent app's moment, wider than its block", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("credits its own span for a client the token returned it to, and changes nothing for one it did not", async () => {
    const AGENT = { bundle: "test.example.agent", name: "Agent" };
    await owner.lens.addScope({
      match: "bundle",
      value: AGENT.bundle,
      compartment: "own",
      kinds: ["moment", "block"],
      agentApp: true,
      client: wide.name,
    });
    const anchor = await owner.projects.anchor(
      P.harbor,
      { kind: "url_prefix", value: "https://agent.example.org/g/harbor" },
      request(),
    );
    const timeOf = async (client: TestClient) =>
      (await store.reader.workViews(client.token, { view: "project", project: P.harbor, days: 30 }))?.project?.time;
    const was = { own: await timeOf(own), wide: await timeOf(wide) };
    const chat: MomentItem = {
      kind: "moment",
      key: keyOf("moment"),
      revision: 0,
      observedAt: at("21:05"),
      endedAt: at("21:15"),
      app: AGENT,
      window: "Harbor plan",
      entity: "chat",
      thread: "Harbor plan",
      participants: [],
      text: "The harbor plan, second draft.",
      read: "ax",
    };
    const day: BlockItem = {
      kind: "block",
      key: keyOf("block"),
      revision: 0,
      day: FD,
      blocks: [on(AGENT, "21:00", "21:30", 30)],
    };
    await push([day, chat]);
    expect((await rowOf(day.key)).compartments).toEqual(["own"]);
    expect((await rowOf(chat.key)).compartments).toEqual(["employer:example", "own"]);
    await linkTo(chat.key, P.harbor, anchor);

    const now = { own: await timeOf(own), wide: await timeOf(wide) };
    // The moment's 10 minutes and the 10 its thread holds after it, to 21:25.
    expect(now.wide?.last30).toBeCloseTo((was.wide?.last30 ?? 0) + 20, 5);
    expect(now.own).toEqual(was.own);
  });
});
