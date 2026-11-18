import { randomBytes } from "node:crypto";
import type { BeliefStatus, StatementKind } from "@intelligence/contracts";
import {
  type BlockItem,
  type CaptureItem,
  type ClaimRecord,
  type CommitmentItem,
  type CommitmentList,
  type ContextPack,
  type EntityId,
  type FactId,
  type MessageId,
  MIRROR_QUOTA,
  type MomentItem,
  type PackItem,
  QUOTA_DEFAULTS,
  type SelfView,
  type TaskItem,
  type TimelineEntry,
  type TimelineView,
  WORK_NOW_TOKENS,
  type WorkNow,
} from "@intelligence/contracts/personal";
import type { WorkRequest, WorkViews } from "@intelligence/personal-core/lens";
import { PACK_TEMPLATES } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureCounts } from "../lens/capture-drain.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { boundWork } from "../read/read-self-fit.ts";
import { type Accounts, connect, OWNER, QUENTIN } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool, recordingStatements } from "../test-support/recording.ts";
import { snapshot } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { outcomeValue } from "../test-support/values.ts";
import { type StoreSeeder, storeSeeder } from "../test-support/world.ts";

// Work time served through the reader's existing tools. get_self's `work`, agent_bootstrap@8's work
// item, get_timeline and get_entity for a project, and get_commitments' done times and advisory
// worked-on minutes (and the packs' commitments through commitmentsOf).
//
// One store for the file, with `own` and `employer:example`, its clock pinned, so a tool's answer
// and reader.workViews (the store's own computation of every view under a token) are read at one
// instant: each tool's work-time value is checked against workViews for the same token, and the
// figures that follow from the world alone are checked by hand. The world is built as Lens and the
// box build it: the device `mac` registered by hand with its four source accounts, block days,
// moments and tasks pushed through push_capture and drained by takeCapture (which seals their
// work_enc), a project made and anchored by the owner's admin, mail through the writer, and
// commitments as claims committed through the Pipeline with their beliefs written as the belief
// rebuild writes them (two of them written straight as pi_admin, for a support the caller cannot
// read whole). Reserved domains, test bundles and `forge.example.org` repositories only. No model
// is called.

// Above SLOW_DB_TEST_TIMEOUT (test-support/timeouts.ts): the world is built through Lens's own
// capture path before any test.
const TIMEOUT = 900_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The real clock to the minute, pinned for the reader and the admin, so the database's own clock
// (the push's and the drain's) runs just after it.
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const NOW = new Date(T);
const ago = (ms: number): number => T - ms;
const utc = (at: number): string => new Date(at).toISOString();
// A time as Lens writes one: with the Mac's local offset of -05:00.
const local = (at: number): string => `${new Date(at - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const same = (a: string | null | undefined, b: number): boolean => a !== null && a !== undefined && Date.parse(a) === b;

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const EMPLOYER = ["employer:example"];
const ALL_VIEWS = ["self", "people", "work"];
// list_goals with the work view: the owner's goals in get_self's head.
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_facts",
  "get_commitments",
  "build_context_pack",
  "list_goals",
];

// A coding editor in the category table, so a block's category is coding.
const EDITOR = { bundle: "com.microsoft.VSCode", name: "Editor" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const WORK = { bundle: "test.example.work", name: "Work" };
const WORK_CHAT = { bundle: "test.example.workchat", name: "Work chat" };
const HARBOR_REPO = "forge.example.org/kestrel/harbor-tools";
const LANTERN_REPO = "forge.example.org/kestrel/lantern-ops";
const GOAL = "Ship the harbor survey.";
const OLD_TITLE = "Call him back tomorrow";

type Client = { id: string; name: string; token: string; compartments: string[] };
type Device = { name: string; token: string };

let store: TestStore;
let seed: StoreSeeder;
let accounts: Accounts;
let mac: Device;
let owner: string;
let quentin: EntityId;
let harbor: EntityId;
let own: Client;
let wide: Client;
let noWork: Client;
let employerOnly: Client;
// Quentin's timeline before any block, moment or task was stored.
let personBefore: TimelineView;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, sql, values);

let serial = 0;
const requestId = (): string => `req-wtv-views-${(serial += 1)}-${randomBytes(4).toString("hex")}`;
// Keys of their own: the ULIDs here begin unlike any other file's.
let keys = 0;
const keyOf = <K extends "moment" | "block" | "task">(kind: K): `${K}:${string}` =>
  `${kind}:01JWT3${String((keys += 1)).padStart(20, "0")}`;
let batches = 0;
const batch = (): string => `work-views-${String((batches += 1)).padStart(4, "0")}`;

// A client cleared for `clearance` with the views given, its read quotas wide enough for the file.
async function addClient(name: string, clearance: string[], views: string[]): Promise<Client> {
  const client = {
    id: testId("cli"),
    name,
    token: `pit_test-${name}-${randomBytes(8).toString("hex")}`,
    compartments: clearance,
  };
  await admin(
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, max_items_day, max_rows_day, max_calls_minute)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, 100000, 1000000, 600)`,
    [client.id, name, sha256Hex(client.token), clearance, views, TOOLS],
  );
  return client;
}

// A device as `pi lens add NAME` makes it, by hand: its capture and mirror clients,
// its policy.lens_devices row and its four source accounts, `lens_tasks` among them; then its
// task switch on, as `pi lens tasks NAME on` sets it.
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
    OWN,
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirror,
    name,
    sha256Hex(`pit_test-${name}-${randomBytes(8).toString("hex")}`),
    OWN,
    ALL_VIEWS,
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
  if (answer.ok)
    for (const item of answer.value.items) expect(item.outcome, `${item.key} ${item.code ?? ""}`).toBe("accepted");
}
async function drain(): Promise<CaptureCounts> {
  const counts = await store.writer.takeCapture();
  expect(counts).toMatchObject({ failed: 0, waiting: 0 });
  return counts;
}
const captureOf = async (key: string) =>
  one(
    await admin<{ id: string; evidence_id: string }>(
      "select id, evidence_id from knowledge.captures where capture_key = $1",
      [key],
    ),
  );

// Items of these tests.
type Block = BlockItem["blocks"][number];
const block = (
  app: { bundle: string; name: string },
  from: number,
  minutes: number,
  more: Partial<Block> = {},
): Block => ({ start: local(from), end: local(from + minutes * MINUTE), minutes, app, ...more });
const strong = (value: string): Block["repository"] => ({ value, method: "git_remote", v: 1 });
// One block day per local day the blocks start on, as Lens sends them.
function blockDays(blocks: Block[]): BlockItem[] {
  const days = new Map<string, Block[]>();
  for (const one of blocks) days.set(one.start.slice(0, 10), [...(days.get(one.start.slice(0, 10)) ?? []), one]);
  return [...days].map(([day, list]) => ({ kind: "block", key: keyOf("block"), revision: 0, day, blocks: list }));
}
const moment = (app: { bundle: string; name: string }, from: number, text: string): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(from),
  endedAt: local(from + 2 * MINUTE),
  app,
  window: "Harbor planning",
  entity: "chat",
  thread: "Harbor planning",
  participants: [],
  text,
  read: "ax",
});
const task = (title: string, events: TaskItem["events"], project?: string): TaskItem => ({
  kind: "task",
  key: keyOf("task"),
  revision: 0,
  byOwner: true,
  title,
  ...(project === undefined ? {} : { project }),
  events,
});
const event = (kind: TaskItem["events"][number]["kind"], at: number): TaskItem["events"][number] => ({
  kind,
  at: utc(at),
});

// The world's blocks: four on the anchored repository (strong, by git_remote), one editor block
// with no attribute, and one on a repository no `own` project anchors; three old editor blocks for
// the months-apart commitments, one between their windows.
const B1 = { at: ago(29 * HOUR), minutes: 40 };
const B2 = { at: ago(27 * HOUR), minutes: 35 };
const B3 = { at: ago(4 * HOUR), minutes: 45 };
const B4 = { at: ago(110 * MINUTE), minutes: 15 };
const HARBOR_MINUTES = B1.minutes + B2.minutes + B3.minutes + B4.minutes;
const OLD_IN_FIRST = ago(100 * DAY - HOUR);
const OLD_IN_SECOND = ago(59 * DAY);
const OLD_BETWEEN = ago(80 * DAY);

// The world's tasks, typed with the project's name or none.
const TK1 = task(
  "Draft the harbor notes",
  [event("created", ago(30 * HOUR)), event("completed", ago(2 * HOUR))],
  "Harbor tools",
);
const TK2 = task("Review the dock plan", [event("created", ago(20 * HOUR))], "Harbor tools");
const TK3 = task("Water the plants", [event("created", ago(5 * HOUR))]);
const TK4 = task(
  "Fix the pier survey",
  [event("created", ago(10 * HOUR)), event("completed", ago(9 * HOUR)), event("reopened", ago(8 * HOUR))],
  "Harbor tools",
);
// Created forty days ago and never changed, its title as the owner wrote it.
const TK_OLD = task(OLD_TITLE, [event("created", ago(40 * DAY))], "Harbor tools");

// The moments: one ended thirteen minutes ago (`current`), and one the C_MOMENT commitment's
// reversal comes from.
const CURRENT = moment(CHAT, ago(15 * MINUTE), "Looking at the dock plan now.");
const CLOSING_MOMENT = moment(CHAT, ago(6 * HOUR), "Sent it over to Quentin.");

// ---------------------------------------------------------------------------------------------
// Commitments: claims through the Pipeline, beliefs as the belief rebuild writes them.

type Source = {
  evidence: string;
  at: number;
  compartment: string;
  lane: "correspondence" | "moment";
  message?: MessageId;
};
type Spec = {
  key: string;
  status: BeliefStatus;
  due?: string;
  // `until`: the claim's end, which a belief computed after it reads as expired.
  claims: { source: Source; kind: StatementKind; what: string; until?: number }[];
};

let claimSerial = 0;
// The claim the extraction would commit for one statement of a commitment the owner owes Quentin.
function commitmentClaim(spec: Spec, one: Spec["claims"][number]): ClaimRecord {
  claimSerial += 1;
  const base = claimRecord(one.source.evidence, one.source.compartment, owner, {
    n: 9000 + claimSerial,
    factKey: spec.key,
    validFrom: utc(one.source.at),
    entities: [quentin],
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      content: {
        ...base.claim.content,
        fields: { counterparty: quentin, what: one.what, ...(spec.due === undefined ? {} : { due: spec.due }) },
      },
      statementKind: one.kind,
      ...(one.until === undefined ? {} : { validTo: utc(one.until) }),
    },
    subjectKind: "owner",
    fieldKinds: { counterparty: "entity", what: "text", due: "date" },
  } as unknown as ClaimRecord;
}

// The commitments' facts, by key, once seeded.
const facts = new Map<string, string>();
const factOf = (key: string): string => {
  const fact = facts.get(key);
  if (fact === undefined) throw new Error(`no commitment ${key}`);
  return fact;
};
// Each commitment's sources, by key, for the expectations.
const sources = new Map<string, Source[]>();
const sourceOf = (key: string, index: number): Source => {
  const found = sources.get(key)?.[index];
  if (found === undefined) throw new Error(`no source ${index} of ${key}`);
  return found;
};

// ---------------------------------------------------------------------------------------------
// Reads.

const viewsOf = async (client: Client, request: WorkRequest, reader: Reader = store.reader): Promise<WorkViews> => {
  const views = await reader.workViews(client.token, request);
  if (views === null) throw new Error(`no client for ${client.name}`);
  return views;
};
const selfOf = async (client: Client, reader: Reader = store.reader): Promise<SelfView> =>
  outcomeValue(await reader.getSelf(client.token));
const commitmentsOf = async (client: Client, reader: Reader = store.reader): Promise<CommitmentList> =>
  outcomeValue(await reader.getCommitments(client.token, { state: "any", limit: 50 }));
const byKey = (list: CommitmentList, key: string): CommitmentItem => {
  const found = list.commitments.find((item) => item.belief.fact === factOf(key));
  if (found === undefined) throw new Error(`no commitment ${key} in the answer`);
  return found;
};
const timelineArgs = (days: number) => ({ id: harbor, from: utc(ago(days * DAY)), to: utc(T) });
const timelineRequest = (days: number): WorkRequest => ({
  view: "timeline",
  project: harbor,
  from: ago(days * DAY),
  to: T,
});
const workEntries = (view: TimelineView): TimelineEntry[] =>
  view.entries.filter((entry) => entry.kind === "work_session" || entry.kind === "task");
const workItems = (pack: ContextPack): Extract<PackItem, { kind: "work" }>[] =>
  pack.items.filter((item): item is Extract<PackItem, { kind: "work" }> => item.kind === "work");
const bootstrap = async (client: Client, reader: Reader = store.reader): Promise<ContextPack> =>
  outcomeValue(await reader.buildContextPack(client.token, { purpose: "agent_bootstrap" }));

// The latest read log row of a client's call of `tool`.
const readLogOf = async (client: Client, tool: string): Promise<{ shown: string[]; bound: string[] }> =>
  one(
    await admin<{ shown: string[]; bound: string[] }>(
      "select shown, bound from ledger.read_log where client_id = $1 and tool = $2 order by id desc limit 1",
      [client.id, tool],
    ),
  );

// A reader on a recording pool over the store's reader pool, at the store's clock or another.
function recordingReader(now: Date = NOW) {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: [...recorded.statements] };
  };
  return { reader, during };
}
const captureReads = (statements: string[]): number => statements.filter((text) => /\bwork_enc\b/.test(text)).length;
// The live device anchors a work-time read gathers. A project's page reads its anchored threads in its
// own mail and people statements (read-project-page.ts), which take no part in crediting time.
const anchorReads = (statements: string[]): number =>
  statements.filter((text) => /a\.anchor_fp, a\.value_enc[\s\S]*knowledge\.project_anchors/.test(text)).length;
const READ_SCHEMAS = /^(knowledge|projections|vault|queue)\./;

// What a read changed: tables with a row added, changed or removed (snapshot is by row and xmin).
const changedTables = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [
    ...new Set([
      ...[...after].filter(([key, xmin]) => before.get(key) !== xmin).map(([key]) => key.split(" ")[0] ?? key),
      ...[...before.keys()].filter((key) => !after.has(key)).map((key) => key.split(" ")[0] ?? key),
    ]),
  ].sort();

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"], now: NOW });
  accounts = await connect(store.writer);
  seed = storeSeeder(store.writer, NOW);

  // Mail between the owner and Quentin. Thread H is the one the project is anchored to, so its
  // claims are bound to the project and its commitments have the project as their target.
  const ownMail = { address: OWNER.personal, name: OWNER.name };
  const workMail = { address: OWNER.work, name: OWNER.name };
  const mails: { key: string; at: number; sent: boolean; thread: string; work?: true }[] = [
    // The employer's first, so the entity the identity port last gave Quentin's address is the
    // one the owner's own mail resolved.
    { key: "w1", at: ago(68 * HOUR), sent: true, thread: "W", work: true },
    { key: "w2", at: ago(65 * HOUR), sent: true, thread: "W", work: true },
    { key: "m1", at: ago(50 * HOUR), sent: false, thread: "H" },
    { key: "m2", at: ago(90 * MINUTE), sent: true, thread: "H" },
    { key: "m3", at: ago(40 * HOUR), sent: true, thread: "R" },
    { key: "m4", at: ago(45 * HOUR), sent: true, thread: "R" },
    { key: "m5", at: ago(60 * HOUR), sent: true, thread: "R" },
    { key: "m6", at: ago(59 * HOUR), sent: true, thread: "R" },
    { key: "m7", at: ago(40 * DAY), sent: true, thread: "R" },
    { key: "m8", at: ago(35 * DAY), sent: true, thread: "R" },
    { key: "m9", at: ago(70 * HOUR), sent: true, thread: "R" },
    { key: "m10", at: ago(69 * HOUR), sent: true, thread: "R" },
    { key: "m11", at: ago(100 * DAY), sent: false, thread: "H" },
    { key: "m12", at: ago(99 * DAY), sent: true, thread: "H" },
    { key: "m13", at: ago(60 * DAY), sent: false, thread: "H" },
    { key: "m14", at: ago(58 * DAY), sent: true, thread: "H" },
    { key: "m15", at: ago(30 * HOUR), sent: true, thread: "R" },
    { key: "m16", at: ago(66 * HOUR), sent: true, thread: "R" },
    { key: "h1", at: ago(67 * HOUR), sent: true, thread: "R" },
    { key: "h2", at: ago(64 * HOUR), sent: true, thread: "R" },
  ];
  for (const mail of mails) {
    const me = mail.work === true ? workMail : ownMail;
    await seed.mail(mail.work === true ? accounts.workMail : accounts.personalMail, {
      id: `wtv-views-${mail.key}`,
      from: mail.sent ? me : QUENTIN,
      to: [mail.sent ? QUENTIN : me],
      at: new Date(mail.at),
      subject: `Harbor thread ${mail.thread}`,
      sent: mail.sent,
      thread: `wtv-views-thread-${mail.thread}`,
    });
  }
  owner = seed.ownerEntity();
  quentin = seed.entityOf(QUENTIN.address);
  const stored = await worldMessages(store);
  const messageAt = (key: string): Message => {
    const at = mails.find((one) => one.key === key)?.at;
    const found = stored.find((one) => Date.parse(one.sentAt) === at);
    if (found === undefined) throw new Error(`no stored message ${key}`);
    return found;
  };
  const mailSource = (key: string): Source => {
    const message = messageAt(key);
    return {
      evidence: message.evidenceId,
      at: Date.parse(message.sentAt),
      compartment: message.compartment,
      lane: "correspondence",
      message: message.id as MessageId,
    };
  };

  // The device and its scope; the project, its repository anchor and its thread anchor.
  mac = await addDevice("mac");
  await store.admin.lens.addScope({ match: "bundle", value: EDITOR.bundle, compartment: "own", kinds: ["block"] });
  await store.admin.lens.addScope({ match: "bundle", value: CHAT.bundle, compartment: "own", kinds: ["moment"] });
  harbor = await store.admin.projects.add("Harbor tools", { requestId: requestId() });
  await store.admin.projects.anchor(harbor, { kind: "repository", value: HARBOR_REPO }, { requestId: requestId() });
  await store.admin.projects.anchor(harbor, messageAt("m1").id as MessageId, { requestId: requestId() });

  // The moment a commitment is said closed in, stored before its claim is committed.
  await push([CLOSING_MOMENT]);
  await drain();
  const closing = await captureOf(CLOSING_MOMENT.key);
  const momentSource: Source = {
    evidence: closing.evidence_id,
    at: Date.parse(CLOSING_MOMENT.observedAt),
    compartment: "own",
    lane: "moment",
  };

  const specs: Spec[] = [
    {
      key: "c-mail",
      status: "closed",
      claims: [
        { source: mailSource("m1"), kind: "stated_fact", what: "Send the harbor notes" },
        { source: mailSource("m2"), kind: "reversal", what: "Sent the harbor notes" },
      ],
    },
    {
      key: "c-moment",
      status: "closed",
      claims: [
        { source: mailSource("m3"), kind: "stated_fact", what: "Send the pier photos" },
        { source: momentSource, kind: "reversal", what: "Sent the pier photos" },
      ],
    },
    {
      key: "c-retired",
      status: "closed",
      claims: [{ source: mailSource("m4"), kind: "stated_fact", what: "Book the survey boat" }],
    },
    {
      key: "c-expired",
      status: "expired",
      claims: [
        { source: mailSource("m5"), kind: "reversal", what: "Cannot send the tide table" },
        { source: mailSource("m6"), kind: "stated_fact", what: "Send the tide table", until: ago(30 * HOUR) },
      ],
    },
    // Its first claim is no reversal: the belief computed over a reversal and a later proposal is
    // closed.
    {
      key: "c-lapsed",
      status: "active",
      claims: [
        { source: mailSource("m7"), kind: "stated_fact", what: "Meet for coffee soon" },
        { source: mailSource("m8"), kind: "proposal", what: "Meet for coffee" },
      ],
    },
    // Closed months apart, both on the project, for the matcher's union of windows.
    {
      key: "c-old-first",
      status: "closed",
      claims: [
        { source: mailSource("m11"), kind: "stated_fact", what: "Send the spring survey" },
        { source: mailSource("m12"), kind: "reversal", what: "Sent the spring survey" },
      ],
    },
    {
      key: "c-old-second",
      status: "closed",
      claims: [
        { source: mailSource("m13"), kind: "stated_fact", what: "Send the summer survey" },
        { source: mailSource("m14"), kind: "reversal", what: "Sent the summer survey" },
      ],
    },
    // Open: nothing closed it.
    {
      key: "c-open",
      status: "active",
      due: utc(T + 3 * DAY).slice(0, 10),
      claims: [{ source: mailSource("m15"), kind: "stated_fact", what: "Send the dock plan" }],
    },
  ];
  const hidden: Spec[] = [
    {
      key: "c-hidden-latest",
      status: "closed",
      claims: [
        { source: mailSource("m9"), kind: "stated_fact", what: "Send the berth list" },
        { source: mailSource("m10"), kind: "reversal", what: "Sent the berth list" },
        { source: mailSource("h1"), kind: "reversal", what: "Sent the berth list again" },
      ],
    },
    {
      key: "c-hidden-none",
      status: "closed",
      claims: [
        { source: mailSource("m16"), kind: "stated_fact", what: "Send the crane quote" },
        { source: mailSource("h2"), kind: "reversal", what: "Sent the crane quote" },
      ],
    },
  ];
  const records = new Map(
    [...specs, ...hidden].map((spec) => [spec.key, spec.claims.map((claim) => commitmentClaim(spec, claim))]),
  );
  for (const spec of [...specs, ...hidden])
    sources.set(
      spec.key,
      spec.claims.map((claim) => claim.source),
    );
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, { lane: Source["lane"]; claims: ClaimRecord[] }>();
    for (const spec of [...specs, ...hidden]) {
      spec.claims.forEach((claim, index) => {
        const record = records.get(spec.key)?.[index];
        if (record === undefined) return;
        const entry = byItem.get(claim.source.evidence) ?? { lane: claim.source.lane, claims: [] };
        byItem.set(claim.source.evidence, { ...entry, claims: [...entry.claims, record] });
      });
    }
    for (const [evidence, entry] of byItem)
      expect(await pipeline.commit(batchOf(evidence, entry.claims, { lane: entry.lane }))).toBe("committed");
    // The retire, as `pi self retire` makes it: the belief it closes is computed when asked.
    const retired = records.get("c-retired")?.[0];
    if (retired === undefined) throw new Error("no retired claim");
    await store.admin.facts.retireFact(fingerprint(store.db.keys, "claim", retired.claim.id) as FactId, {
      requestId: requestId(),
    });
  } finally {
    await pipeline.close();
  }
  // No code path leaves a claim of a held message, so the hold is made by hand, as pi_admin.
  await admin("update knowledge.messages set held = true where id = any($1)", [
    ["h1", "h2"].map((key) => messageAt(key).id),
  ]);
  await knownBy(store.db, NOW);
  for (const spec of [...specs, ...hidden]) facts.set(spec.key, fingerprint(store.db.keys, "fact", spec.key));

  own = await addClient("wtv-own", OWN, ALL_VIEWS);
  wide = await addClient("wtv-wide", WIDE, ALL_VIEWS);
  noWork = await addClient("wtv-no-work", OWN, ["self", "people"]);
  employerOnly = await addClient("wtv-employer", EMPLOYER, ALL_VIEWS);
  personBefore = outcomeValue(
    await store.reader.getTimeline(own.token, { id: quentin, from: utc(ago(120 * DAY)), to: utc(T) }),
  );

  // The capture: block days, the current moment and the tasks.
  const blocks = [
    block(EDITOR, B1.at, B1.minutes, { title: "harbor-tools — Editor", repository: strong(HARBOR_REPO) }),
    block(EDITOR, B2.at, B2.minutes, { title: "harbor-tools — Editor", repository: strong(HARBOR_REPO) }),
    block(EDITOR, ago(5 * HOUR), 15, { title: "lantern-ops — Editor", repository: strong(LANTERN_REPO) }),
    block(EDITOR, B3.at, B3.minutes, { title: "harbor-tools — Editor", repository: strong(HARBOR_REPO) }),
    block(EDITOR, ago(3 * HOUR), 20, { title: "Scratch" }),
    block(EDITOR, B4.at, B4.minutes, { title: "harbor-tools — Editor", repository: strong(HARBOR_REPO) }),
    block(EDITOR, OLD_IN_FIRST, 20, { title: "Scratch" }),
    block(EDITOR, OLD_BETWEEN, 20, { title: "Scratch" }),
    block(EDITOR, OLD_IN_SECOND, 20, { title: "Scratch" }),
  ];
  await push([...blockDays(blocks), CURRENT]);
  await push([TK1, TK2, TK3, TK4, TK_OLD]);
  await drain();
  await store.admin.work.addGoal(GOAL, "own", { requestId: requestId() });
  await knownBy(store.db, NOW);
}, TIMEOUT);

afterAll(async () => {
  await store?.close();
}, TIMEOUT);

describe("get_self's work", { timeout: TIMEOUT }, () => {
  it("get_self's work is served for a client holding the Self and Work views, as the store computes it; otherwise absent", async () => {
    const self = await selfOf(own);
    const views = await viewsOf(own, { view: "now" });
    expect(views.now).toBeDefined();
    // The page holds it as the page cuts it, and `work` asks for it whole.
    expect(self.work).toEqual(boundWork(views.now as WorkNow));
    expect(outcomeValue(await store.reader.getSelf(own.token, { work: true })).work).toEqual(
      (await viewsOf(own, { view: "now", whole: true })).now,
    );
    // The world reaches every list: current from the moment of thirteen minutes ago, focus on the
    // project, two half-days with their coverage, and today's and yesterday's deep-work days.
    const work = self.work as WorkNow;
    expect(work.asOf).toBe(utc(T));
    expect(work.current).not.toBeNull();
    expect(work.focus.length).toBeGreaterThan(0);
    expect(work.focus.some((one) => "project" in one.target && one.target.project.id === harbor)).toBe(true);
    expect(work.halfDays).toHaveLength(2);
    expect(work.deepWork).toHaveLength(2);
    // Without the Work view: no work at all, and the rest of the head unchanged.
    const without = await selfOf(noWork);
    expect(without.work).toBeUndefined();
    expect("work" in without).toBe(false);
    expect(without.addresses).toEqual(self.addresses);
  });

  it("the owner's stated goals stay in get_self's head, apart from observed work", async () => {
    const self = await selfOf(own);
    expect((self.goals ?? []).map((goal) => goal.statement.untrusted)).toContain(GOAL);
    expect(JSON.stringify(self.work)).not.toContain(GOAL);
    // The control: the work view does hold the owner's observed activity (focus, never cut).
    expect(JSON.stringify(self.work?.focus)).toContain("Harbor tools");
  });

  it("current is the latest moment or meeting that ended within thirty minutes, and none later", async () => {
    expect((await selfOf(own)).work?.current).not.toBeNull();
    // The same store read forty-five minutes later: the moment ended fifty-eight minutes before.
    const later = new Date(T + 45 * MINUTE);
    const { reader } = recordingReader(later);
    const work = (await selfOf(own, reader)).work;
    expect(work?.current).toBeNull();
    expect(work).toEqual(boundWork((await viewsOf(own, { view: "now" }, reader)).now as WorkNow));
  });

  it("get_self's work keeps within its bound of about 2 500 tokens", async () => {
    const work = (await selfOf(own)).work;
    expect(new TextEncoder().encode(JSON.stringify(work)).length / 4).toBeLessThanOrEqual(WORK_NOW_TOKENS);
  });

  it("tasks are served to a client cleared for own: a task created forty days ago and never changed is open, its title as the owner wrote it", async () => {
    const { reader } = recordingReader(new Date(T + 2 * DAY));
    const work = (await selfOf(own, reader)).work as WorkNow;
    expect(work).toEqual(boundWork((await viewsOf(own, { view: "now" }, reader)).now as WorkNow));
    const titles = work.openTasks.map((one) => one.title.untrusted);
    expect(titles).toContain(OLD_TITLE);
    expect(titles).toContain("Review the dock plan");
    // A reopened task is open again, and a completed one is not.
    expect(titles).toContain("Fix the pier survey");
    expect(titles).not.toContain("Draft the harbor notes");
    const old = work.openTasks.find((one) => one.title.untrusted === OLD_TITLE);
    expect(old).toMatchObject({
      title: { untrusted: OLD_TITLE },
      completionRecordedAt: null,
      doneAt: null,
      reopened: 0,
    });
    expect(old?.project?.id).toBe(harbor);
    expect(same(old?.createdAt, ago(40 * DAY))).toBe(true);
    // A client cleared for employer:example alone is served work, but no task of the owner's.
    const elsewhere = (await selfOf(employerOnly, reader)).work as WorkNow;
    expect(elsewhere).toBeDefined();
    expect(elsewhere.openTasks).toEqual([]);
    expect(elsewhere.changes.filter((one) => one.task !== undefined)).toEqual([]);
    expect(JSON.stringify(elsewhere)).not.toContain(OLD_TITLE);
    expect(elsewhere).toEqual((await viewsOf(employerOnly, { view: "now" }, reader)).now);
    // And on the project's timeline, as the owner wrote it.
    const timeline = outcomeValue(await store.reader.getTimeline(own.token, timelineArgs(60)));
    const created = workEntries(timeline).find(
      (entry) => entry.kind === "task" && entry.task.title.untrusted === OLD_TITLE,
    );
    expect(created).toMatchObject({ kind: "task", change: "created", task: { title: { untrusted: OLD_TITLE } } });
  });

  it("get_self's read log holds the capture items' evidence ids it used", async () => {
    await selfOf(own);
    const { shown } = await readLogOf(own, "get_self");
    const used = (await viewsOf(own, { view: "now" })).shown;
    expect(used.length).toBeGreaterThan(0);
    for (const evidence of used) expect(shown).toContain(evidence);
    // The control: a client without the Work view used none, and its log holds none of them.
    await selfOf(noWork);
    const other = await admin<{ shown: string[] }>(
      "select shown from ledger.read_log where client_id = $1 and tool = 'get_self'",
      [noWork.id],
    );
    for (const row of other) for (const evidence of used) expect(row.shown).not.toContain(evidence);
  });
});

describe("agent_bootstrap@8", { timeout: TIMEOUT }, () => {
  it("agent_bootstrap@8 gains a work section holding get_self's work, under the same views; @7 is unchanged", async () => {
    const pack = await bootstrap(own);
    // The current template, agent_bootstrap@10, keeps @8's sections and adds an unreported section.
    expect(pack.template).toBe("agent_bootstrap@16");
    const items = workItems(pack);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "work", section: "work", kind: "work" });
    expect(items[0]?.work).toEqual((await viewsOf(own, { view: "now" })).now);
    expect(boundWork(items[0]?.work as WorkNow)).toEqual((await selfOf(own)).work);
    // Without the Work view: no work item.
    const without = await bootstrap(noWork);
    expect(workItems(without)).toEqual([]);
    expect(without.items.some((item) => item.section === "work")).toBe(false);
    // @7 is as it was, and @8 is @7 with the work section last.
    const sections = (version: number) =>
      PACK_TEMPLATES.find((one) => one.purpose === "agent_bootstrap" && one.version === version)?.sections.map(
        (one) => one.name,
      );
    expect(sections(7)).toEqual([
      "guide",
      "owner",
      "handoff",
      "upcoming",
      "commitments",
      "facts",
      "preferences",
      "contacts",
      "notes",
    ]);
    expect(sections(8)).toEqual([...(sections(7) ?? []), "work"]);
  });

  it("the pack's read log holds the capture items' evidence ids its work item used", async () => {
    await bootstrap(own);
    const { shown } = await readLogOf(own, "build_context_pack");
    const used = (await viewsOf(own, { view: "now" })).shown;
    for (const evidence of used) expect(shown).toContain(evidence);
  });
});

describe("a project's timeline and card", { timeout: TIMEOUT }, () => {
  it("get_timeline with a project's id lists its work sessions and task transitions, newest first, as the store computes them", async () => {
    const view = outcomeValue(await store.reader.getTimeline(own.token, timelineArgs(3)));
    const computed = (await viewsOf(own, timelineRequest(3))).timeline;
    expect(computed).toBeDefined();
    const entries = workEntries(view);
    const sessions = entries.flatMap((entry) => (entry.kind === "work_session" ? [entry.session] : []));
    const changes = entries.flatMap((entry) =>
      entry.kind === "task" ? [{ at: entry.at, change: entry.change, task: entry.task }] : [],
    );
    expect(new Set(sessions.map((one) => JSON.stringify(one)))).toEqual(
      new Set(computed?.sessions.map((one) => JSON.stringify(one))),
    );
    expect(new Set(changes.map((one) => JSON.stringify(one)))).toEqual(
      new Set(computed?.tasks.map((one) => JSON.stringify(one))),
    );
    // A session is placed at its own time.
    for (const entry of entries)
      if (entry.kind === "work_session") expect([entry.session.start, entry.session.end]).toContain(entry.at);
    // Newest first, over every kind.
    const times = view.entries.map((entry) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The world's figures: the four anchored blocks are four sessions on the project (each gap is
    // over ten minutes); the project's tasks' transitions are there (an edit is none), and the
    // task with no project is not.
    expect(sessions).toHaveLength(4);
    expect(
      sessions.every((one) => "project" in one.target && one.target.project.id === harbor && one.basis === "anchor"),
    ).toBe(true);
    expect(sessions.map((one) => one.minutes).sort((a, b) => a - b)).toEqual([
      B4.minutes,
      B2.minutes,
      B1.minutes,
      B3.minutes,
    ]);
    const titled = changes.map((one) => `${one.task.title.untrusted} ${one.change}`).sort();
    expect(titled).toEqual(
      [
        "Draft the harbor notes completed",
        "Draft the harbor notes created",
        "Fix the pier survey completed",
        "Fix the pier survey created",
        "Fix the pier survey reopened",
        "Review the dock plan created",
      ].sort(),
    );
  });

  it("a person's timeline is unchanged: no session and no task, whatever capture is stored", async () => {
    const view = outcomeValue(
      await store.reader.getTimeline(own.token, { id: quentin, from: utc(ago(120 * DAY)), to: utc(T) }),
    );
    expect(workEntries(view)).toEqual([]);
    expect(view).toEqual(personBefore);
    // The control: the owner's timeline is not empty.
    expect(view.entries.length).toBeGreaterThan(0);
  });

  it("a project's card carries its time, as the store computes it, with partial false below the bound", async () => {
    const card = outcomeValue(await store.reader.getEntity(own.token, { id: harbor }));
    const computed = (await viewsOf(own, { view: "project", project: harbor, days: 30 })).project;
    expect(card.time).toBeDefined();
    expect(card.time).toEqual(computed?.time);
    // The world's figures: every anchored block is in the last seven days; the project's open
    // tasks are the dock plan, the reopened survey and the forty-day-old call; one done in thirty.
    expect(card.time).toMatchObject({
      last7: HARBOR_MINUTES,
      last30: HARBOR_MINUTES,
      openTasks: 3,
      done30: 1,
      partial: false,
    });
    expect(card.time?.lastSession).toMatchObject({ basis: "anchor", minutes: B4.minutes });
    expect(same(card.time?.lastSession?.start, B4.at)).toBe(true);
    expect(same(card.time?.lastSession?.end, B4.at + B4.minutes * MINUTE)).toBe(true);
  });

  it("time is a project's alone: a person's card carries none", async () => {
    const card = outcomeValue(await store.reader.getEntity(own.token, { id: quentin }));
    expect(card.time).toBeUndefined();
  });

  it("the project's card and timeline log the capture items' evidence ids they used", async () => {
    await store.reader.getEntity(own.token, { id: harbor });
    const card = await readLogOf(own, "get_entity");
    for (const evidence of (await viewsOf(own, { view: "project", project: harbor, days: 30 })).shown)
      expect(card.shown).toContain(evidence);
    await store.reader.getTimeline(own.token, timelineArgs(3));
    const timeline = await readLogOf(own, "get_timeline");
    const used = (await viewsOf(own, timelineRequest(3))).shown;
    expect(used.length).toBeGreaterThan(0);
    for (const evidence of used) expect(timeline.shown).toContain(evidence);
  });
});

describe("done times and the advisory matcher", { timeout: TIMEOUT }, () => {
  it("a commitment closed by a reversal in mail has closedAt and doneAt its sent time and doneBy its message", async () => {
    const item = byKey(await commitmentsOf(own), "c-mail");
    const reversal = sourceOf("c-mail", 1);
    expect(item.belief.status).toBe("closed");
    expect(same(item.closedAt, reversal.at)).toBe(true);
    expect(same(item.doneAt, reversal.at)).toBe(true);
    expect(item.doneBy).toEqual({ message: reversal.message });
  });

  it("a commitment said closed in a moment has closedAt and no doneAt or doneBy", async () => {
    const item = byKey(await commitmentsOf(own), "c-moment");
    expect(same(item.closedAt, sourceOf("c-moment", 1).at)).toBe(true);
    expect(item.doneAt).toBeNull();
    expect(item.doneBy).toBeNull();
  });

  it("retired, lapsed and expired commitments have neither closedAt nor doneAt, whatever claims they hold", async () => {
    const list = await commitmentsOf(own);
    for (const key of ["c-retired", "c-lapsed", "c-expired"]) {
      const item = byKey(list, key);
      expect(item.closedAt, key).toBeNull();
      expect(item.doneAt, key).toBeNull();
      expect(item.doneBy, key).toBeNull();
      expect(item.workedOn, key).toBeNull();
    }
    expect(byKey(list, "c-expired").belief.status).toBe("expired");
    // The lapsed one is a courtesy no longer open: get_commitments' open list leaves it out.
    const open = outcomeValue(await store.reader.getCommitments(own.token, {}));
    expect(open.commitments.map((one) => one.belief.fact)).not.toContain(factOf("c-lapsed"));
    // The control: an open commitment has them null too, and serves them.
    const item = byKey(list, "c-open");
    expect(item).toMatchObject({ closedAt: null, doneAt: null, doneBy: null, workedOn: null });
  });

  it("a client that cannot read the closing claim gets the latest reversal it can read, or null", async () => {
    const list = await commitmentsOf(own);
    // The latest reversal is in held mail; the latest the own caller can read is the owner's other mail.
    const latest = byKey(list, "c-hidden-latest");
    const readable = sourceOf("c-hidden-latest", 1);
    expect(same(latest.closedAt, readable.at)).toBe(true);
    expect(same(latest.doneAt, readable.at)).toBe(true);
    expect(latest.doneBy).toEqual({ message: readable.message });
    // Its only reversal is in held mail: none it can read.
    const none = byKey(list, "c-hidden-none");
    expect(none.belief.status).toBe("closed");
    expect(none).toMatchObject({ closedAt: null, doneAt: null, doneBy: null });
  });

  it("the matcher is advisory: worked-on minutes on the commitment's project from the latest close on it before its done time", async () => {
    const item = byKey(await commitmentsOf(own), "c-mail");
    const done = sourceOf("c-mail", 1).at;
    // s is the latest of its start (fifty hours before), fourteen days before c and the latest
    // close on the project before c: the harbor notes task, completed two hours before now. In
    // [s, c] the project has one anchored block, of fifteen minutes. Open on the project then: the
    // dock plan, the reopened survey and the forty-day-old call, counted in shared.
    expect(item.workedOn).toEqual({
      rule: "match@1",
      advisory: true,
      minutes: B4.minutes,
      sessions: 1,
      from: utc(ago(2 * HOUR)),
      to: utc(done),
      shared: 3,
      partial: false,
    });
  });

  it("a commitment's targets are its claims' bound projects and its capture items' projects, and nothing else: none, no worked-on minutes", async () => {
    const list = await commitmentsOf(own);
    // Its mail is on an unanchored thread and its moment is linked to no project.
    expect(byKey(list, "c-moment").workedOn).toBeNull();
    expect(byKey(list, "c-hidden-latest").workedOn).toBeNull();
    // The control: on the anchored thread, months ago, with no credited minute in its window.
    expect(byKey(list, "c-old-second").workedOn).toEqual({
      rule: "match@1",
      advisory: true,
      minutes: 0,
      sessions: 0,
      from: utc(ago(60 * DAY)),
      to: utc(ago(58 * DAY)),
      shared: 0,
      partial: false,
    });
  });

  it("a call that serves several commitments gathers once, over the union of their windows and never their hull", async () => {
    const { reader } = recordingReader();
    const counted = await recordingStatements(() => reader.getCommitments(own.token, { state: "any", limit: 50 }));
    expect(counted.result.ok).toBe(true);
    const gathering = counted.statements.filter((one) => /\bwork_enc\b/.test(one.text));
    expect(gathering.length).toBeGreaterThan(0);
    expect(gathering.length).toBeLessThanOrEqual(2);
    expect(counted.statements.filter((one) => /knowledge\.project_anchors/.test(one.text)).length).toBeLessThanOrEqual(
      1,
    );
    // Every row the gathering brought back is a task (gathered whole) or a row inside some closed
    // commitment's last fourteen days: none from between the old windows, which the hull holds.
    const windows = [ago(90 * MINUTE), ago(99 * DAY), ago(58 * DAY)].map((c) => [utc(c - 14 * DAY), utc(c)] as const);
    const within = async (spans: readonly (readonly [string, string])[]): Promise<number> =>
      one(
        await admin<{ n: number }>(
          `select count(*)::int as n from knowledge.captures c where c.kind <> 'task' and c.compartments <@ '{own}'
             and exists (select 1 from unnest($1::timestamptz[], $2::timestamptz[]) as w (f, t) where c.ended_at >= w.f and c.started_at < w.t)`,
          [spans.map((span) => span[0]), spans.map((span) => span[1])],
        ),
      ).n;
    const tasks = one(
      await admin<{ n: number }>(
        "select count(*)::int as n from knowledge.captures where kind = 'task' and compartments <@ '{own}'",
      ),
    ).n;
    const returned = gathering.reduce((sum, one) => sum + one.rows, 0);
    expect(returned).toBeLessThanOrEqual(tasks + (await within(windows)));
    // The control: the hull from the first window to the last holds a row the windows do not.
    expect(await within([[utc(ago(113 * DAY)), utc(ago(90 * MINUTE))]])).toBeGreaterThan(await within(windows));
  });

  it("nothing closes anything else: a read with done times and worked-on minutes changes no knowledge, belief, card or ledger row of the owner's", async () => {
    const before = await snapshot(store.db);
    const statuses = (await commitmentsOf(own)).commitments
      .map((one) => `${one.belief.fact} ${one.belief.status}`)
      .sort();
    await selfOf(own);
    await store.reader.getEntity(own.token, { id: harbor });
    await store.reader.getTimeline(own.token, timelineArgs(3));
    await bootstrap(own);
    const changed = changedTables(before, await snapshot(store.db));
    expect(changed.filter((table) => READ_SCHEMAS.test(table))).toEqual([]);
    expect(changed).not.toContain("ledger.cards");
    expect(changed).not.toContain("ledger.basis");
    // No status moved.
    expect(
      (await commitmentsOf(own)).commitments.map((one) => `${one.belief.fact} ${one.belief.status}`).sort(),
    ).toEqual(statuses);
    // The control: the read did log itself.
    expect(changed).toContain("ledger.read_log");
  });

  it("meeting_prep and person_brief carry the done times through commitmentsOf: person_brief's open commitment has them null", async () => {
    const pack = outcomeValue(
      await store.reader.buildContextPack(own.token, { purpose: "person_brief", entity: quentin }),
    );
    const items = pack.items.filter(
      (item): item is Extract<PackItem, { kind: "commitment" }> => item.kind === "commitment",
    );
    expect(items.map((item) => item.commitment.belief.fact)).toContain(factOf("c-open"));
    for (const item of items) {
      expect(item.commitment).toHaveProperty("closedAt", null);
      expect(item.commitment).toHaveProperty("doneAt", null);
      expect(item.commitment).toHaveProperty("doneBy", null);
      expect(item.commitment).toHaveProperty("workedOn", null);
    }
    // And agent_bootstrap's commitments section, through the same function.
    const bootstrapped = (await bootstrap(own)).items.filter(
      (item): item is Extract<PackItem, { kind: "commitment" }> => item.kind === "commitment",
    );
    expect(bootstrapped.length).toBeGreaterThan(0);
    for (const item of bootstrapped) expect(item.commitment).toHaveProperty("closedAt", null);
  });
});

describe("the statement count", { timeout: TIMEOUT }, () => {
  it("each work-time read issues one statement per kind of input, whatever its window's length", async () => {
    const { reader, during } = recordingReader();
    const short = await during(() => reader.getTimeline(own.token, timelineArgs(1)));
    const long = await during(() => reader.getTimeline(own.token, timelineArgs(60)));
    expect(short.answer.ok && long.answer.ok).toBe(true);
    expect(captureReads(short.statements)).toBeGreaterThan(0);
    expect(captureReads(long.statements)).toBe(captureReads(short.statements));
    expect(anchorReads(short.statements)).toBeGreaterThan(0);
    expect(anchorReads(long.statements)).toBe(anchorReads(short.statements));
    const calls: [string, () => Promise<{ ok: boolean }>][] = [
      ["get_self", () => reader.getSelf(own.token)],
      ["get_entity", () => reader.getEntity(own.token, { id: harbor })],
      ["get_timeline", () => reader.getTimeline(own.token, timelineArgs(60))],
      ["build_context_pack", () => reader.buildContextPack(own.token, { purpose: "agent_bootstrap" })],
      ["get_commitments", () => reader.getCommitments(own.token, { state: "any", limit: 50 })],
    ];
    for (const [name, call] of calls) {
      const { answer, statements } = await during(call);
      expect(answer.ok, name).toBe(true);
      // Task rows and every other capture row: one statement each, at most; the anchors one.
      expect(captureReads(statements), name).toBeGreaterThan(0);
      expect(captureReads(statements), name).toBeLessThanOrEqual(2);
      expect(anchorReads(statements), name).toBeLessThanOrEqual(1);
    }
    // The control: a read that serves no work time gathers none.
    const plain = await during(() => reader.getSelf(noWork.token));
    expect(captureReads(plain.statements)).toBe(0);
  });
});

describe("labels (WT8's view half; R17)", { timeout: TIMEOUT }, () => {
  it("an own client's work, project card and timeline are byte for byte those of the store without employer:example rows and projects; the wider client's differ", async () => {
    const reads = async (client: Client) => ({
      work: JSON.stringify((await selfOf(client)).work),
      card: JSON.stringify(outcomeValue(await store.reader.getEntity(client.token, { id: harbor }))),
      timeline: JSON.stringify(outcomeValue(await store.reader.getTimeline(client.token, timelineArgs(3)))),
    });
    const before = { own: await reads(own), wide: await reads(wide) };

    // The employer's: its scope, a project anchored to its repository, a block inside the gap
    // between two of the project's blocks, one overlapping a project block (a second device), and
    // a moment ended four minutes ago.
    await store.admin.lens.addScope({
      match: "bundle",
      value: WORK.bundle,
      compartment: "employer:example",
      kinds: ["block"],
    });
    await store.admin.lens.addScope({
      match: "bundle",
      value: WORK_CHAT.bundle,
      compartment: "employer:example",
      kinds: ["moment"],
    });
    const lantern = await store.admin.projects.add("Lantern ops", {
      compartment: "employer:example",
      requestId: requestId(),
    });
    await store.admin.projects.anchor(lantern, { kind: "repository", value: LANTERN_REPO }, { requestId: requestId() });
    const employerBlocks = [
      block(WORK, ago(28 * HOUR + 10 * MINUTE), 20, { title: "lantern-ops — Work", repository: strong(LANTERN_REPO) }),
      block(WORK, ago(3 * HOUR + 50 * MINUTE), 10, { title: "lantern-ops — Work", repository: strong(LANTERN_REPO) }),
    ];
    await push([...blockDays(employerBlocks), moment(WORK_CHAT, ago(6 * MINUTE), "The lantern rota is out.")]);
    await drain();

    const after = { own: await reads(own), wide: await reads(wide) };
    expect(after.own).toEqual(before.own);
    // The positive control: the wider client sees the employer's moment as current, and loses to
    // the overlapping block ten minutes of the project's.
    expect(after.wide.work).not.toEqual(before.wide.work);
    expect(after.wide.card).not.toEqual(before.wide.card);
    expect(after.wide.timeline).not.toEqual(before.wide.timeline);
    // An own block is never credited to an employer project: the lantern repository's own block
    // stays unattributed for the wider client, and the project has its two blocks' minutes alone.
    const card = outcomeValue(await store.reader.getEntity(wide.token, { id: lantern }));
    expect(card.time).toMatchObject({ last7: 30, last30: 30 });
    expect(card.time).toEqual((await viewsOf(wide, { view: "project", project: lantern, days: 30 })).project?.time);
    // The own client cannot see the project at all.
    expect(await store.reader.getEntity(own.token, { id: lantern })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("an unfiled cut", { timeout: TIMEOUT }, () => {
  it("a day's cut no rule could file is served to a caller cleared for every compartment it could be under, and changes nothing for another", async () => {
    // 14:00 UTC, the same date in UTC and on the Mac's clock, whatever the hour the file runs.
    const from = Math.floor(ago(12 * DAY) / DAY) * DAY + 14 * HOUR;
    const day = blockDays([block(EDITOR, from, 20, { title: "Scratch" })]).map((one) => ({
      ...one,
      cut: [{ app: "com.google.Chrome", host: "docs.google.com", blocks: 2, minutes: 40 }],
    }));
    const date = day[0]?.day ?? "";
    const before = JSON.stringify((await viewsOf(own, { view: "day", day: date })).day);
    await push(day);
    await drain();
    const after = (await viewsOf(own, { view: "day", day: date })).day;
    expect(after?.halfDays.some((half) => half.coverage.dayCutMinutes > 0)).toBe(false);
    expect(JSON.stringify(after)).not.toContain("no_account");
    expect(before).not.toEqual(JSON.stringify(after));
    const seen = (await viewsOf(wide, { view: "day", day: date })).day;
    for (const half of seen?.halfDays ?? [])
      expect(half.coverage).toMatchObject({
        dayCutBlocks: 2,
        dayCutMinutes: 40,
        dayCutReasons: { no_account: { blocks: 2, minutes: 40 } },
      });
    expect(seen?.deepWork.complete).toBe(false);
    // The owner's terminal sees it too.
    const admin = await store.admin.time.day(date);
    expect(admin.halfDays[0]?.coverage.dayCutMinutes).toBe(40);
  });
});
