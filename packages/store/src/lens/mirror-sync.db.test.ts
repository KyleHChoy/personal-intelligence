import { copyFile } from "node:fs/promises";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  type ClaimRecord,
  type MessageId,
  MIRROR_BUILD_PER_CALL,
  MIRROR_SECTION_VIEW,
  MIRROR_TEMPLATES,
  type MirrorEntry,
  MirrorPage,
  type MirrorSection,
  type MirrorTemplate,
  type MomentItem,
  PersonalLogEvent,
  type PersonalView,
  SourceAccountId,
  type SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import { mirrorEntryValues } from "@intelligence/personal-core/lens";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { beliefIdOf } from "../read/computed-beliefs.ts";
import { Reader } from "../read/read.ts";
import { hashFingerprint, sha256Hex, testId } from "../test-support/clients.ts";
import {
  type CommitmentSpec,
  commitClaims,
  type Message,
  type Records,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { asClaimsOwner, session } from "../test-support/connections.ts";
import {
  copiesOf,
  copyTestDatabase,
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "../test-support/database.ts";
import { type MailFixture, mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingPool } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import type { TestStore } from "../test-support/store.ts";
import { storeSeeder } from "../test-support/world.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// Reader.syncMirror's rules, written from the spec alone. The gate tests that erase, reconcile or
// compare stores are mirror-gate.db.test.ts's; the REST answers and the owner commands are
// apps/pi/src/intake/lens-mirror.db.test.ts's.
//
// One world is built once, through the writer, the pipeline and addDevice, and copied for each test
// (copiesOf). Its times are the real clock's at load, so the database's clock (which stamps a
// cursor's completed_at) and the reader's agree; the reader's clock is injected and pinned, and a
// test moves it past PI_MIRROR_PASS_SECONDS or PI_MIRROR_REBUILD_HOURS instead of waiting. No real
// wait anywhere. Reserved domains, synthetic names.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

// "A quiet pass's openings are counted on the store's open function" (the plan, "How the tests
// run"): every call into seal.ts's open functions from any module of the store is counted: the
// kernel's `open`, `openAt` (which the deprecated forwarders call) and the old `openRow` and
// `openUnder`. A call inside seal.ts (`open` to `openAt`) bypasses the mock, so none counts twice.
const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock("../core/seal.ts", async (original) => {
  const actual = await original<typeof import("../core/seal.ts")>();
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      opened.count += 1;
      return fn(...args);
    };
  return {
    ...actual,
    open: counted(actual.open as (...args: unknown[]) => string | null),
    openAt: counted(actual.openAt as (...args: unknown[]) => string | null),
    openRow: counted(actual.openRow),
    openUnder: counted(actual.openUnder),
  };
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const at = (days: number, hours = 0): Date => new Date(T + days * DAY + hours * HOUR);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const PASS_SECONDS = 3_600;
const REBUILD_HOURS = 24;
const PAGE_BYTES = 262_144;
const SECTIONS: readonly MirrorSection[] = ["entities", "beliefs", "facts", "events", "captures"];
const T1 = MIRROR_TEMPLATES.find((one) => one.name === "lens_mirror@1") as MirrorTemplate;
const NEVER_ISSUED = "mcr_01JZZZZZZZZZZZZZZZZZZZZZZZ";
const STALE = { ok: false, code: "stale_cursor" };

// A version of the test's own: lens_mirror@1's sections and members, with some members or caps
// changed.
const version = (
  name: string,
  members: Partial<MirrorTemplate["members"]> = {},
  caps: Partial<Record<MirrorSection, number>> = {},
): MirrorTemplate => ({
  name,
  sections: T1.sections.map((section) => ({ ...section, cap: caps[section.name] ?? section.cap })),
  members: { ...T1.members, ...members },
});

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

const OWNER_PERSONAL = "owner.mirror@example.com";
const OWNER_WORK = "owner.mirror@example.org";
const BLAKE = { address: "blake.mirror@example.com", name: "Blake Canary-Mirror" };
const BLAKE_AT_WORK = { address: BLAKE.address, name: "Blake Canary-Mirrorwork" };
const PAT = { address: "pat.mirror@example.com", name: "Pat Canary-Mirror" };
const WREN = { address: "wren.mirror@example.org", name: "Wren Canary-Mirror" };
// What no page holds: a message's text (its subject) and a capture item's (its sealed title).
const PAGE_CANARIES = ["canary-mirror-subject", "canary-mirror-capture", "canary-mirror-inbox"];
// What no log line holds besides: names, addresses, titles and a claim's words.
const LOG_CANARIES = [
  ...PAGE_CANARIES,
  "Canary-Mirror",
  "blake.mirror@",
  "pat.mirror@",
  "wren.mirror@",
  "canary-mirror-title",
  "canary-mirror-what",
];

type Device = {
  name: string;
  id: string;
  token: string;
  capture: { id: string; token: string };
  accounts: { meetings: string; activity: string };
};
type Capture = { id: string; evidence: string; key: string };
type Mail = Message & { fixture: MailFixture };
type World = {
  owner: string;
  blake: string;
  pat: string;
  wren: string;
  messages: Record<"ownBlake" | "ownSent" | "ownPat" | "workWren" | "workBlake", Mail>;
  events: Record<"ownPast" | "ownNext" | "ownOld" | "workPast", string>;
  specs: CommitmentSpec[];
  records: Records;
  project: string;
  anchors: { app: string; host: string; thread: string };
  mac: Device;
  wide: Device;
  captures: Record<"meetingPast" | "meetingOld" | "momentRecent" | "momentOld" | "hidden", Capture>;
};

let world: World | undefined;
const w = (): World => {
  if (world === undefined) throw new Error("the world is not built");
  return world;
};

type Person = { address: string; name?: string };
const fixtureOf = (id: string, from: Person, to: Person, when: Date, sent: boolean): MailFixture => ({
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@mail.example.com`,
  at: when.toISOString() as MailFixture["at"],
  from,
  to: [to],
  subject: `canary-mirror-subject-${id}`,
  labels: sent ? ["SENT"] : ["INBOX"],
});

async function device(
  admin: Admin,
  db: TestDatabase,
  name: string,
  compartments: string[],
  views: PersonalView[] = VIEWS,
): Promise<Device> {
  // The mirror's first token is the first rotation's.
  const tokens = {
    ...(await admin.lens.addDevice(name, { compartments, views })),
    mirror: await admin.lens.rotateDevice(name, "mirror"),
  };
  const clients = await queryAs<{ id: string; name: string }>(
    db.urls.admin,
    "select id, name from policy.clients where name in ($1, $1 || '-capture')",
    [name],
  );
  const accounts = await queryAs<{ id: string; connector: string }>(
    db.urls.admin,
    "select id, connector from vault.source_accounts where label = $1",
    [`device:${name}`],
  );
  const idOf = (client: string): string => clients.find((one) => one.name === client)?.id ?? "";
  const accountOf = (connector: string): string => accounts.find((one) => one.connector === connector)?.id ?? "";
  return {
    name,
    id: idOf(name),
    token: tokens.mirror,
    capture: { id: idOf(`${name}-capture`), token: tokens.capture },
    accounts: { meetings: accountOf("lens_meetings"), activity: accountOf("lens_activity") },
  };
}

// A stored capture item as the drain leaves it: its evidence row of the device's account and its
// knowledge.captures row, written as pi_admin. Its sealed facts hold a title canary that no page
// may hold.
async function captureIn(
  db: TestDatabase,
  account: string,
  item: { kind: "meeting" | "moment"; from: Date; to: Date; event: string | null; compartments: string[] },
): Promise<Capture> {
  return session(db.urls.admin, async (query) => {
    const compartment = item.compartments[0] ?? "own";
    const blob = await seeder(db, query).blob(item.compartments);
    const key = `${item.kind}:${testId("k").slice(2)}`;
    const source = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(account), sourceItemId: key };
    const evidence = evidenceIdFor({ ...source, revision: 0 });
    const id = testId("cap");
    const sealed = (table: string, row: string, column: string, value: string): string =>
      JSON.stringify(sealRow(db.keys, compartment, { table, id: row, column }, value));
    await query(
      `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
         observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
       values ($1, $2, $3, $4, $5, 0, $6, $7, 'application/json', $8, 'live', '{m-owner}', false, false, 'present', $9, '{m-owner}', $10, $11::jsonb)`,
      [
        evidence,
        account,
        item.kind === "meeting" ? "transcript" : "screen_activity",
        fingerprint(db.keys, "source_id", key),
        fingerprint(db.keys, "revision_tag", `h:${key}`),
        evidenceIdFor({ ...source, revision: 1 }),
        hashFingerprint(db.keys, "content_hash", sha256Hex(`mirror capture ${key}`)),
        item.from.toISOString(),
        item.compartments,
        blob,
        sealed("vault.evidence_items", evidence, "item_enc", JSON.stringify({ sourceItemId: key, markers: [] })),
      ],
    );
    await query(
      `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, event_id, first_pushed_at, local_day, facts_enc, compartments)
       values ($1, $2, $3, $4, 0, $5, $6, $7, $8, $7, $9, $10::jsonb, $11)`,
      [
        id,
        evidence,
        account,
        key,
        item.kind,
        item.from.toISOString(),
        item.to.toISOString(),
        item.event,
        dayOf(item.from),
        sealed(
          "knowledge.captures",
          id,
          "facts_enc",
          JSON.stringify({ title: "canary-mirror-capture-title", app: { bundle: "test.example.meet", name: "Meet" } }),
        ),
        item.compartments,
      ],
    );
    return { id, evidence, key };
  });
}

const asStore = (db: TestDatabase): TestStore => ({ db }) as unknown as TestStore;

// The owner's personal label under `own` and work label under employer:example, seeded through
// the writer relative to the real clock: Blake (both labels), Pat (own only), Wren (work only);
// a meeting with Blake two days ago, one in three days and one 200 days ago (outside the events
// window), and a work meeting with Wren. Commitments on four messages, with each audience's
// beliefs. A project with an app anchor, a host anchor and a thread anchor, and a work project.
// Two devices, `mac` cleared for own and `mac-wide` for own and employer:example. Five capture
// items: two own meetings (one 200 days old), two own moments (one 100 days old) and a work
// meeting.
async function build(): Promise<TestDatabase> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  try {
    const admin = new Admin({
      pool: adminPool,
      keys: db.keys,
      log,
      now: () => new Date(T),
      journal: journalPath(db.keyFile),
    });
    const seed = storeSeeder(writer, new Date(T));
    const personal = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER_PERSONAL);
    const personalCalendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER_PERSONAL);
    const work = await writer.ensureSourceAccount("work", "google_mail", "employer:example", OWNER_WORK);
    const workCalendar = await writer.ensureSourceAccount("work", "google_calendar", "employer:example", OWNER_WORK);
    // Each message by its day: one a day, so a message is found again by its day and label.
    const mails = {
      ownBlake: { days: -5, account: personal, from: BLAKE, to: { address: OWNER_PERSONAL }, sent: false },
      ownSent: { days: -4, account: personal, from: { address: OWNER_PERSONAL }, to: BLAKE, sent: true },
      ownPat: { days: -3, account: personal, from: PAT, to: { address: OWNER_PERSONAL }, sent: false },
      workWren: { days: -7, account: work, from: WREN, to: { address: OWNER_WORK }, sent: false },
      workBlake: { days: -1, account: work, from: BLAKE_AT_WORK, to: { address: OWNER_WORK }, sent: false },
    };
    const fixtures = Object.fromEntries(
      Object.entries(mails).map(([name, one]) => [
        name,
        fixtureOf(`mirror-${name}`, one.from, one.to, at(one.days), one.sent),
      ]),
    ) as Record<keyof typeof mails, MailFixture>;
    for (const [name, one] of Object.entries(mails)) {
      await seed.mail(one.account, {
        id: `mirror-${name}`,
        from: one.from,
        to: [one.to],
        at: at(one.days),
        subject: `canary-mirror-subject-mirror-${name}`,
        sent: one.sent,
      });
    }
    const event = (id: string, start: Date, organizer: string, attendees: Person[]) => ({
      id,
      title: `canary-mirror-title-${id}`,
      start,
      end: new Date(start.getTime() + HOUR),
      organizer: { address: organizer },
      attendees,
    });
    await seed.event(personalCalendar, event("mirror-own-past", at(-2), OWNER_PERSONAL, [{ address: BLAKE.address }]));
    await seed.event(personalCalendar, event("mirror-own-next", at(3), OWNER_PERSONAL, [{ address: BLAKE.address }]));
    await seed.event(personalCalendar, event("mirror-own-old", at(-200), OWNER_PERSONAL, [{ address: PAT.address }]));
    await seed.event(workCalendar, event("mirror-work-past", at(-2, 3), OWNER_WORK, [WREN]));

    const owner = seed.ownerEntity();
    const blake = seed.entityOf(BLAKE.address);
    const pat = seed.entityOf(PAT.address);
    const wren = seed.entityOf(WREN.address);
    const stored = await worldMessages(asStore(db));
    const mail = (name: keyof typeof mails, compartment: string): Mail => {
      const found = stored.find(
        (one) => one.compartment === compartment && Math.round((Date.parse(one.sentAt) - T) / DAY) === mails[name].days,
      );
      if (found === undefined) throw new Error(`no ${compartment} message ${name}`);
      return { ...found, fixture: fixtures[name] };
    };
    const messages = {
      ownBlake: mail("ownBlake", "own"),
      ownSent: mail("ownSent", "own"),
      ownPat: mail("ownPat", "own"),
      workWren: mail("workWren", "employer:example"),
      workBlake: mail("workBlake", "employer:example"),
    };
    const due = dayOf(at(10));
    const specs: CommitmentSpec[] = [
      {
        key: "mirror-blake-owner",
        subject: blake,
        counterparty: owner,
        due,
        claims: [{ message: messages.ownBlake, what: "canary-mirror-what-blake" }],
      },
      {
        key: "mirror-owner-blake",
        subject: owner,
        counterparty: blake,
        due,
        claims: [{ message: messages.ownSent, what: "canary-mirror-what-owner" }],
      },
      {
        key: "mirror-pat-owner",
        subject: pat,
        counterparty: owner,
        claims: [{ message: messages.ownPat, what: "canary-mirror-what-pat" }],
      },
      {
        key: "mirror-wren-owner",
        subject: wren,
        counterparty: owner,
        due,
        claims: [{ message: messages.workWren, what: "canary-mirror-what-wren" }],
      },
    ];
    // The project and its anchors come before the claims: anchoring a thread deletes its items'
    // claims and the beliefs on them and replays only a saved call, and these hand-committed claims
    // have none.
    const request = () => ({ requestId: testId("req") });
    const project = await admin.projects.add("canary-mirror-project", request());
    const anchors = {
      app: await admin.projects.anchor(project, { kind: "app", value: "test.Example.Notes" }, request()),
      host: await admin.projects.anchor(project, { kind: "host", value: "Plans.Example.com." }, request()),
      thread: await admin.projects.anchor(project, messages.ownBlake.id as MessageId, request()),
    };
    const records = await commitClaims(asStore(db), owner, specs);
    await knownBy(db, new Date(T));

    const workProject = await admin.projects.add("canary-mirror-work-project", {
      compartment: "employer:example",
      ...request(),
    });
    await admin.projects.anchor(workProject, { kind: "app", value: "test.example.worknotes" }, request());

    const mac = await device(admin, db, "mac", OWN);
    const wide = await device(admin, db, "mac-wide", BOTH);
    const eventAt = async (start: Date): Promise<string> =>
      (
        await queryAs<{ event_id: string }>(
          db.urls.admin,
          "select event_id from knowledge.event_details where starts_at = $1",
          [start.toISOString()],
        )
      )[0]?.event_id ?? "";
    const events = {
      ownPast: await eventAt(at(-2)),
      ownNext: await eventAt(at(3)),
      ownOld: await eventAt(at(-200)),
      workPast: await eventAt(at(-2, 3)),
    };
    const captures = {
      meetingPast: await captureIn(db, mac.accounts.meetings, {
        kind: "meeting",
        from: at(-2),
        to: at(-2, 1),
        event: events.ownPast,
        compartments: OWN,
      }),
      meetingOld: await captureIn(db, mac.accounts.meetings, {
        kind: "meeting",
        from: at(-200),
        to: at(-200, 1),
        event: null,
        compartments: OWN,
      }),
      momentRecent: await captureIn(db, mac.accounts.activity, {
        kind: "moment",
        from: at(-1),
        to: at(-1, 0.1),
        event: null,
        compartments: OWN,
      }),
      momentOld: await captureIn(db, mac.accounts.activity, {
        kind: "moment",
        from: at(-100),
        to: at(-100, 0.1),
        event: null,
        compartments: OWN,
      }),
      hidden: await captureIn(db, mac.accounts.meetings, {
        kind: "meeting",
        from: at(-2, 3),
        to: at(-2, 4),
        event: events.workPast,
        compartments: ["employer:example"],
      }),
    };
    world = { owner, blake, pat, wren, messages, events, specs, records, project, anchors, mac, wide, captures };
    return db;
  } finally {
    await writer.close();
    await adminPool.end();
  }
}

const copies = copiesOf(build);
afterAll(() => copies.drop());

// ---------------------------------------------------------------------------------------------
// A test's stack, on its own copy
// ---------------------------------------------------------------------------------------------

type Stack = {
  db: TestDatabase;
  log: ReturnType<typeof eventLogger>;
  clock: { at: number };
  admin: Admin;
  readerPool: pg.Pool;
  writer(): Writer;
  sql<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

function stackOn(db: TestDatabase): Stack {
  const log = eventLogger();
  const clock = { at: T };
  const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: 3 });
  closers.push(
    () => adminPool.end(),
    () => readerPool.end(),
  );
  let writer: Writer | undefined;
  return {
    db,
    log,
    clock,
    admin: new Admin({
      pool: adminPool,
      keys: db.keys,
      log,
      now: () => new Date(clock.at),
      journal: journalPath(db.keyFile),
    }),
    readerPool,
    writer() {
      if (writer === undefined) {
        const made = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
        closers.push(() => made.close());
        writer = made;
      }
      return writer;
    },
    sql: (text, values) => queryAs(db.urls.admin, text, values),
  };
}

async function stack(): Promise<Stack> {
  const db = await copies.copy();
  closers.push(() => db.drop());
  return stackOn(db);
}

// The reader, with the options this file assumes it takes (see the header).
type MirrorReaderOptions = ConstructorParameters<typeof Reader>[0] & { mirrorTemplates?: readonly MirrorTemplate[] };
function readerOf(
  s: Stack,
  options: {
    templates?: readonly MirrorTemplate[];
    now?: () => Date;
    record?: Parameters<typeof recordingPool>[1];
  } = {},
) {
  const recorded = recordingPool(s.readerPool, options.record);
  const given: MirrorReaderOptions = {
    pool: recorded.pool,
    keys: s.db.keys,
    log: s.log,
    now: options.now ?? (() => new Date(s.clock.at)),
    ...(options.templates === undefined ? {} : { mirrorTemplates: options.templates }),
  };
  return {
    reader: new Reader(given as ConstructorParameters<typeof Reader>[0]),
    statements: recorded.statements,
    held: recorded.held,
  };
}

type Call = { cursor: string | null; templates?: string[]; limit?: number; erasedDone?: string[] };
const argsOf = (call: Call): SyncMirrorArgs =>
  ({
    templates: call.templates ?? [T1.name],
    cursor: call.cursor,
    ...(call.limit === undefined ? {} : { limit: call.limit }),
    ...(call.erasedDone === undefined ? {} : { erasedDone: call.erasedDone }),
  }) as SyncMirrorArgs;
// A page under lens_mirror@1, parsed by the strict contract.
const page = async (reader: Reader, token: string, call: Call): Promise<MirrorPage> => {
  const answer = await reader.syncMirror(token, argsOf(call));
  if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
  return MirrorPage.parse(answer.value);
};
// A page under a test version, as built (its template is not one of MIRROR_TEMPLATES).
const rawPage = async (reader: Reader, token: string, call: Call): Promise<MirrorPage> => {
  const answer = await reader.syncMirror(token, argsOf(call));
  if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
  return answer.value;
};

type Pass = { pages: MirrorPage[]; cursor: string };
// Calls from `cursor` until a page completes the pass. The first call must start a pass or
// continue one: a null cursor, a cursor mid-pass, or a completed pass's cursor once the clock is
// past PI_MIRROR_PASS_SECONDS.
async function fullPass(
  reader: Reader,
  token: string,
  cursor: string | null,
  more: Omit<Call, "cursor"> = {},
  read = page,
  // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
  most = 2_000,
): Promise<Pass> {
  const pages: MirrorPage[] = [];
  let next = cursor;
  for (let n = 0; n < most; n += 1) {
    const one = await read(reader, token, { ...more, cursor: next });
    pages.push(one);
    next = one.cursor;
    if (one.passComplete) return { pages, cursor: next };
  }
  throw new Error(`no pass completed in ${most} calls`);
}

const entriesOf = (pages: readonly MirrorPage[]): MirrorEntry[] => pages.flatMap((one) => one.entries);
const idsOf = (pages: readonly MirrorPage[]): string[] => entriesOf(pages).map((entry) => entry.stamp.projection);
const removedOf = (pages: readonly MirrorPage[]) => pages.flatMap((one) => one.removals);
const inSection = (pages: readonly MirrorPage[], section: MirrorSection): MirrorEntry[] =>
  entriesOf(pages).filter((entry) => entry.section === section);
const pagesOf = (pages: readonly MirrorPage[], section: MirrorSection): MirrorPage[] =>
  pages.filter((one) => one.entries.some((entry) => entry.section === section));
// A page with its cursor's id left out: the one field two stores can never share (a fresh ULID).
const masked = (pages: readonly MirrorPage[]) => pages.map((one) => ({ ...one, cursor: "mcr" }));

// The clock moved past the client's last completed pass by PI_MIRROR_PASS_SECONDS, and past its
// latest rebuild by PI_MIRROR_REBUILD_HOURS when asked.
async function due(s: Stack, client: string, options: { rebuild?: boolean } = {}): Promise<void> {
  const [row] = await s.sql<{ completed: Date | null; rebuilt: Date | null }>(
    "select max(completed_at) as completed, max(rebuilt_at) as rebuilt from ledger.mirror_cursors where client_id = $1",
    [client],
  );
  const completed = row?.completed;
  if (completed === null || completed === undefined) throw new Error("no completed pass");
  const after = completed.getTime() + PASS_SECONDS * 1000 + 1000;
  const rebuilt = options.rebuild === true ? (row?.rebuilt ?? completed).getTime() + REBUILD_HOURS * HOUR + 1000 : 0;
  s.clock.at = Math.max(s.clock.at, after, rebuilt);
}

type Row = {
  id: string;
  section: MirrorSection;
  entry_key: string;
  audience: string[];
  template: string;
  fact_key_fp: string | null;
  sent_state: string;
  confirmed_state: string | null;
  ended_at: Date | null;
  reason: string | null;
  tainted_at: Date | null;
  evidence_ids: string[];
  entity_ids: string[];
};
const rowsOf = (s: Stack, client: string): Promise<Row[]> =>
  s.sql<Row>(
    "select id, section, entry_key, audience, template, fact_key_fp, sent_state, confirmed_state, ended_at, reason, tainted_at, evidence_ids, entity_ids from ledger.mirror_entries where client_id = $1 order by id",
    [client],
  );
const liveOf = async (s: Stack, client: string): Promise<Row[]> =>
  (await rowsOf(s, client)).filter((row) => row.ended_at === null);
const count = async (s: Stack, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  (await s.sql<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values))[0]?.n ?? -1;
// What a call wrote of the mirror's two tables: each one's rows and its newest xmin.
const mirrorState = async (s: Stack): Promise<{ entries: string; cursors: string }> => {
  const [row] = await s.sql<{ entries: string; cursors: string }>(
    `select (select count(*) || ' ' || coalesce(max(xmin::text::bigint), 0) from ledger.mirror_entries) as entries,
            (select count(*) || ' ' || coalesce(max(xmin::text::bigint), 0) from ledger.mirror_cursors) as cursors`,
  );
  return { entries: row?.entries ?? "", cursors: row?.cursors ?? "" };
};
// A statement that reads a source row or the mirror's state.
const READS = /knowledge\.|projections\.|vault\.|serve_mirror|mirror_cursor|mirror_tokens/;
const SERVE = (text: string): boolean => /serve_mirror\s*\(/.test(text);

const projectionOf = (
  s: Stack,
  client: string,
  audience: readonly string[],
  template: string,
  section: MirrorSection,
  key: string,
): string =>
  `mir_${fingerprint(s.db.keys, "mirror_projection", [client, [...audience].sort().join(","), template, section, key].join("\n")).slice(0, 40)}`;

// A commitment claim as the extraction would commit it (commitment-fixtures' own form), with a
// number of its own so its id is new on its item.
function commitmentRecord(
  message: Message,
  subject: string,
  counterparty: string,
  key: string,
  what: string,
  n: number,
): ClaimRecord {
  const owner = w().owner;
  const base = claimRecord(message.evidenceId, message.compartment, subject, {
    n,
    factKey: key,
    validFrom: message.sentAt,
    entities: [subject, counterparty].filter((id) => id !== owner),
  });
  return {
    ...base,
    claim: { ...base.claim, content: { ...base.claim.content, fields: { counterparty, what } } },
    subjectKind: subject === owner ? "owner" : "person",
    fieldKinds: { counterparty: "entity", what: "text" },
  } as unknown as ClaimRecord;
}

// An item's claims committed again with `added`: the claims it holds keep their ids.
async function commitOn(s: Stack, message: Message, added: ClaimRecord[]): Promise<void> {
  const kept = [...w().records.values()]
    .flat()
    .filter((record) => record.claim.primaryEvidenceId === message.evidenceId);
  const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: s.log });
  try {
    expect(await pipeline.commit(batchOf(message.evidenceId, [...kept, ...added]))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  await knownBy(s.db, new Date(T));
}

// Every Who-shaped object in a value: an id, a kind, a name and an address.
function whos(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(whos);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const here = "id" in record && "kind" in record && "name" in record && "address" in record ? [record] : [];
  return [...here, ...Object.values(record).flatMap(whos)];
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe("Reader.syncMirror's rules", () => {
  it("sync_mirror serves the mirror client, under its own token, one template version", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, w().mac.token, null);
    for (const one of pages) expect(one.template).toBe("lens_mirror@1");
    // The five sections in order, each read in its key order.
    const order = entriesOf(pages).map((entry) => SECTIONS.indexOf(entry.section));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(entriesOf(pages).map((entry) => entry.section))).toEqual(new Set(SECTIONS));
    const rows = await liveOf(s, w().mac.id);
    for (const section of SECTIONS) {
      const keys = inSection(pages, section).map(
        (entry) => rows.find((row) => row.id === entry.stamp.projection)?.entry_key ?? "",
      );
      expect(keys, section).toEqual([...keys].sort(byCodePoint));
    }
    // events: 180 days either side of the call, so the meeting 200 days ago is not served, and
    // the work meeting is not the own client's.
    expect(
      inSection(pages, "events")
        .map((entry) => (entry.section === "events" ? entry.event.id : ""))
        .sort(),
    ).toEqual([w().events.ownPast, w().events.ownNext].sort());
    // Every Who keeps only its entity id; an entity has no mail and no meetings (the strict shape).
    expect(whos(entriesOf(pages)).length).toBeGreaterThan(0);
    for (const who of whos(entriesOf(pages)))
      expect({ name: who.name, address: who.address }).toEqual({ name: null, address: null });
    for (const entry of inSection(pages, "entities")) {
      for (const field of ["mail", "lastMeeting", "nextMeeting"])
        expect(entry.section === "entities" ? entry.entity : {}).not.toHaveProperty(field);
    }
    // A section whose view the client lacks is empty: a device with `self` alone gets only the
    // owner's beliefs, which `self` covers.
    const blind = await device(s.admin, s.db, "mac-self", OWN, ["self"]);
    const narrow = await fullPass(reader, blind.token, null);
    for (const section of ["entities", "events", "captures"] as const)
      expect(inSection(narrow.pages, section), section).toEqual([]);
    if (MIRROR_SECTION_VIEW.facts !== "self") expect(inSection(narrow.pages, "facts")).toEqual([]);
    expect(inSection(narrow.pages, "beliefs").length).toBeGreaterThan(0);
    for (const entry of inSection(narrow.pages, "beliefs"))
      expect(entry.section === "beliefs" ? entry.belief.subject.id : "").toBe(w().owner);
  });

  it("every entry carries memory-adapters's stamp", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, w().mac.token, null);
    const rows = await liveOf(s, w().mac.id);
    const claims = await s.sql<{ id: string; evidence_id: string; fact_key_fp: string }>(
      "select id, evidence_id, fact_key_fp from knowledge.claims",
    );
    expect(entriesOf(pages).length).toBe(rows.length);
    for (const entry of entriesOf(pages)) {
      const row = rows.find((one) => one.id === entry.stamp.projection);
      expect(row, entry.stamp.projection).toBeDefined();
      if (row === undefined) continue;
      // mir_ and 40 characters of the keyed fingerprint of the five values, one per line.
      expect(entry.stamp.projection).toBe(
        projectionOf(s, w().mac.id, OWN, "lens_mirror@1", entry.section, row.entry_key),
      );
      expect(row).toMatchObject({ section: entry.section, audience: OWN, template: "lens_mirror@1" });
      // The state is the SHA-256 of mirrorEntryValues.
      expect(entry.stamp.state).toBe(sha256Hex(mirrorEntryValues(entry)));
      expect(row.sent_state).toBe(entry.stamp.state);
      // The key by section, and `fact` exactly for a belief or a fact.
      switch (entry.section) {
        case "entities":
          expect(row.entry_key).toBe(entry.entity.id);
          break;
        case "beliefs":
          expect(row.entry_key).toMatch(/^blf_[0-9a-f]{40}$/);
          expect(entry.stamp.fact).toBe(entry.belief.fact);
          break;
        case "facts": {
          // Its claim's evidence id and fact key, never its claim id.
          const claim = claims.find((one) => one.id === entry.fact.id);
          expect(row.entry_key).toBe(`${claim?.evidence_id}:${claim?.fact_key_fp}`);
          expect(entry.stamp.fact).toBe(claim?.fact_key_fp);
          break;
        }
        case "events":
          expect(row.entry_key).toBe(entry.event.id);
          break;
        case "captures":
          expect(row.entry_key).toBe(entry.capture.capture);
          break;
      }
      if (entry.section !== "beliefs" && entry.section !== "facts") expect(entry.stamp.fact).toBeNull();
      expect(row.fact_key_fp).toBe(entry.stamp.fact);
    }
    // The control: the wider client's ids for the same keys are other ids (its id and audience
    // are in the fingerprint).
    const wider = await fullPass(reader, w().wide.token, null);
    expect(idsOf(wider.pages).filter((id) => idsOf(pages).includes(id))).toEqual([]);
  });

  it("the read is in passes", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const baseline = await fullPass(reader, w().mac.token, null);
    // The 60 percent stop, on the reader's clock: a clock that moves an hour at each reading
    // stops every build early, and the pass still completes with every entry.
    const hurried = await device(s.admin, s.db, "mac-hurried", OWN);
    let ticks = 0;
    const fast = readerOf(s, { now: () => new Date(T + (ticks += 1) * HOUR) });
    const stopped = await fullPass(fast.reader, hurried.token, null);
    expect(entriesOf(stopped.pages)).toHaveLength(entriesOf(baseline.pages).length);
    expect(stopped.pages.length).toBeGreaterThan(baseline.pages.length);
    // 130 claims more on one own message: the facts section is over one call's build, so its
    // 133 facts take more than one call, each building at most MIRROR_BUILD_PER_CALL.
    const many = Array.from({ length: 130 }, (_, n) =>
      commitmentRecord(
        w().messages.ownPat,
        w().owner,
        w().pat,
        `mirror-many-${n}`,
        `canary-mirror-many-${n}`,
        1000 + n,
      ),
    );
    await commitOn(s, w().messages.ownPat, many);
    const { pages } = await fullPass(reader, w().mac.token, null);
    for (const one of pages) expect(one.entries.length).toBeLessThanOrEqual(MIRROR_BUILD_PER_CALL);
    expect(inSection(pages, "facts")).toHaveLength(133);
    const factPages = pagesOf(pages, "facts");
    expect(factPages.length).toBeGreaterThanOrEqual(2);
    expect(factPages[0]?.passComplete).toBe(false);
    // `limit` bounds a page's entries and its removals.
    const capped = await device(s.admin, s.db, "mac-capped", OWN);
    const small = await fullPass(reader, capped.token, null, { limit: 7 });
    for (const one of small.pages) {
      expect(one.entries.length).toBeLessThanOrEqual(7);
      expect(one.removals.length).toBeLessThanOrEqual(7);
    }
    expect(idsOf(small.pages)).toHaveLength(idsOf(pages).length);
  });

  it("the cursor is a ledger.mirror_cursors row the server issued", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await page(reader, w().mac.token, { cursor: null });
    expect(first.entries.length).toBeGreaterThan(0);
    expect(await count(s, "ledger.mirror_cursors", "id = $1 and client_id = $2", [first.cursor, w().mac.id])).toBe(1);
    // Before the next call nothing is confirmed; the latest cursor confirms its page.
    const sent = new Set<string>(first.entries.map((entry) => entry.stamp.projection));
    for (const row of await rowsOf(s, w().mac.id)) if (sent.has(row.id)) expect(row.confirmed_state).toBeNull();
    const second = await page(reader, w().mac.token, { cursor: first.cursor });
    for (const row of await rowsOf(s, w().mac.id))
      if (sent.has(row.id)) expect(row.confirmed_state).toBe(row.sent_state);
    // Any other cursor is stale_cursor and writes nothing: one never issued, and another
    // client's. The control: the other client's own call writes.
    const before = await mirrorState(s);
    expect(await reader.syncMirror(w().mac.token, argsOf({ cursor: NEVER_ISSUED }))).toEqual(STALE);
    expect(await mirrorState(s)).toEqual(before);
    const theirs = await page(reader, w().wide.token, { cursor: null });
    const afterTheirs = await mirrorState(s);
    expect(afterTheirs).not.toEqual(before);
    expect(await reader.syncMirror(w().mac.token, argsOf({ cursor: theirs.cursor }))).toEqual(STALE);
    expect(await mirrorState(s)).toEqual(afterTheirs);
    // A null cursor clears every confirmed state, and the pass it starts sends every visible entry.
    const rest = await fullPass(reader, w().mac.token, second.cursor);
    const all = [...first.entries, ...second.entries, ...entriesOf(rest.pages)].map((entry) => entry.stamp.projection);
    const again = await fullPass(reader, w().mac.token, null);
    expect(idsOf(again.pages).sort()).toEqual([...all].sort());
    expect(removedOf(again.pages)).toEqual([]);
  });

  it("a row that leaves the client's view is ended without marking every row a pass sees", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, w().mac.token, null);
    // Between passes: removals and erased keys only, and the pass does not move.
    const between = await page(reader, w().mac.token, { cursor: first.cursor });
    expect(between.entries).toEqual([]);
    expect(between.pass).toBe(first.pages[0]?.pass);
    // A quiet pass writes no mirror row: no column is written for every row a pass sees.
    const quietFrom = await mirrorState(s);
    await due(s, w().mac.id);
    const quiet = await fullPass(reader, w().mac.token, between.cursor);
    expect(quiet.pages[0]?.pass).toBe((first.pages[0]?.pass ?? 0) + 1);
    expect(entriesOf(quiet.pages)).toEqual([]);
    expect((await mirrorState(s)).entries).toBe(quietFrom.entries);
    // A hold touches no row's time: the next pass ends the held message's facts withdrawn, and
    // only those, in its range; a call before the next pass sends nothing of it.
    await s.sql("update knowledge.messages set held = true where evidence_id = $1", [w().messages.ownPat.evidenceId]);
    const held = (await liveOf(s, w().mac.id)).filter(
      (row) => row.section === "facts" && row.entry_key.startsWith(`${w().messages.ownPat.evidenceId}:`),
    );
    expect(held.length).toBeGreaterThan(0);
    const early = await page(reader, w().mac.token, { cursor: quiet.cursor });
    expect(early.removals).toEqual([]);
    await due(s, w().mac.id);
    const next = await fullPass(reader, w().mac.token, early.cursor);
    const drained = await page(reader, w().mac.token, { cursor: next.cursor });
    const removals = removedOf([...next.pages, drained]);
    expect(removals.map((one) => one.projection).sort()).toEqual(held.map((row) => row.id).sort());
    for (const one of removals) expect(one.reason).toBe("withdrawn");
    expect(
      (await rowsOf(s, w().mac.id))
        .filter((row) => row.ended_at !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual(held.map((row) => row.id).sort());
    expect((await liveOf(s, w().mac.id)).length).toBe(idsOf(first.pages).length - held.length);
  });

  it("a section over its cap serves its entries in key order up to the cap", async () => {
    const s = await stack();
    const { reader } = readerOf(s, { templates: [version("lens_mirror@1", {}, { beliefs: 2 })] });
    const first = await fullPass(reader, w().mac.token, null);
    const beliefs = inSection(first.pages, "beliefs");
    expect(beliefs).toHaveLength(2);
    expect(pagesOf(first.pages, "beliefs")[0]?.truncated).toBe(true);
    // The first two of the audience's three, in key order: the ids of the beliefs of own's three
    // commitments, computed under the client's clearance.
    const idOf = (key: string): string => beliefIdOf(s.db.keys, fingerprint(s.db.keys, "fact", key), OWN);
    const keys = ["mirror-blake-owner", "mirror-owner-blake", "mirror-pat-owner"].map(idOf).sort();
    const rows = await liveOf(s, w().mac.id);
    expect(beliefs.map((entry) => rows.find((row) => row.id === entry.stamp.projection)?.entry_key)).toEqual(
      keys.slice(0, 2),
    );
    // A belief whose id sorts first pushes the second out: it is ended dropped, never withdrawn. Its
    // fact key is the first whose computed id sorts before the others, committed on Pat's message
    // beside Pat's own claim (a commit replaces an item's claims).
    let n = 0;
    while (idOf(`mirror-first-belief-${n}`) >= (keys[0] ?? "")) n += 1;
    const pat = w().specs.find((one) => one.key === "mirror-pat-owner") as CommitmentSpec;
    await commitClaims(asStore(s.db), w().owner, [
      pat,
      {
        ...pat,
        key: `mirror-first-belief-${n}`,
        claims: [{ message: w().messages.ownPat, what: "canary-mirror-first" }],
      },
    ]);
    await knownBy(s.db, new Date(T));
    await due(s, w().mac.id);
    const second = await fullPass(reader, w().mac.token, first.cursor);
    const drained = await page(reader, w().mac.token, { cursor: second.cursor });
    const cut = rows.find((row) => row.entry_key === keys[1]);
    expect(pagesOf(second.pages, "beliefs")[0]?.truncated).toBe(true);
    expect(removedOf([...second.pages, drained]).filter((one) => one.projection === cut?.id)).toEqual([
      { projection: cut?.id, reason: "dropped", at: expect.any(String) },
    ]);
    expect((await rowsOf(s, w().mac.id)).find((row) => row.id === cut?.id)?.reason).toBe("dropped");
  });

  it("policy.serve_mirror is the one writer of ledger.mirror_entries and ledger.mirror_cursors", async () => {
    const s = await stack();
    const plain = readerOf(s);
    // A belief's claim replaced between the reader's read and its serve_mirror call fails the call
    // with unavailable, and the call writes nothing.
    const first = await page(plain.reader, w().mac.token, { cursor: null });
    const racing = readerOf(s, { record: { holdWhen: SERVE } });
    const call = racing.reader.syncMirror(w().mac.token, argsOf({ cursor: first.cursor }));
    await racing.held.reached;
    const before = await mirrorState(s);
    // The item is extracted again, Pat's commitment in other words: the claim the call read is
    // gone, so serve_mirror refuses the support it was given.
    const patMail = w().messages.ownPat;
    const replaced = new Set(w().records.get("mirror-pat-owner") ?? []);
    const kept = [...w().records.values()]
      .flat()
      .filter((record) => record.claim.primaryEvidenceId === patMail.evidenceId && !replaced.has(record));
    const again = commitmentRecord(
      patMail,
      w().pat,
      w().owner,
      "mirror-pat-owner",
      "canary-mirror-what-pat-again",
      3000,
    );
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: s.log });
    try {
      expect(await pipeline.commit(batchOf(patMail.evidenceId, [...kept, again]))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    racing.held.release();
    expect(await call).toEqual({ ok: false, code: "unavailable" });
    expect(await mirrorState(s)).toEqual(before);
    // Known by the world's date once the held call is done: moving it makes a policy, which waits on
    // every open transaction that read the table.
    await knownBy(s.db, new Date(T));
    // The next call reads the belief as it is, and serves it.
    const next = await page(plain.reader, w().mac.token, { cursor: first.cursor });
    const fact = fingerprint(s.db.keys, "fact", "mirror-pat-owner");
    expect(next.entries.map((entry) => entry.stamp.fact)).toContain(fact);
    // Its evidence ids are found by the server from the rows it names.
    const passed = await fullPass(plain.reader, w().mac.token, next.cursor);
    const pat = (await liveOf(s, w().mac.id)).filter(
      (row) => row.section === "facts" && row.entry_key.startsWith(`${w().messages.ownPat.evidenceId}:`),
    );
    expect(pat).toHaveLength(1);
    expect(pat[0]?.evidence_ids).toContain(w().messages.ownPat.evidenceId);
    // A row ended whose entry is visible again is live again under the same id, sent whole.
    await s.sql("update knowledge.messages set held = true where evidence_id = $1", [w().messages.ownPat.evidenceId]);
    await due(s, w().mac.id);
    const away = await fullPass(plain.reader, w().mac.token, passed.cursor);
    const gone = await page(plain.reader, w().mac.token, { cursor: away.cursor });
    expect(removedOf([...away.pages, gone]).map((one) => one.projection)).toContain(pat[0]?.id);
    await s.sql("update knowledge.messages set held = false where evidence_id = $1", [w().messages.ownPat.evidenceId]);
    await due(s, w().mac.id);
    const back = await fullPass(plain.reader, w().mac.token, gone.cursor);
    expect(idsOf(back.pages)).toContain(pat[0]?.id);
    expect((await rowsOf(s, w().mac.id)).find((row) => row.id === pat[0]?.id)?.ended_at).toBeNull();
  });

  it("every call that sends entries writes its read set through policy.log_read", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages, cursor } = await fullPass(reader, w().mac.token, null);
    const between = await page(reader, w().mac.token, { cursor });
    expect(between.entries).toEqual([]);
    const logged = await s.sql<{ tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1",
      [w().mac.id],
    );
    // One row for each call that sent entries, none for the call that sent none.
    expect(logged).toHaveLength(pages.filter((one) => one.entries.length > 0).length);
    for (const row of logged) expect({ tool: row.tool, bound: row.bound }).toEqual({ tool: "sync_mirror", bound: [] });
    const rows = await liveOf(s, w().mac.id);
    expect(new Set(logged.flatMap((row) => row.shown))).toEqual(new Set(rows.flatMap((row) => row.evidence_ids)));
    expect(new Set(logged.flatMap((row) => row.fact_key_fps))).toEqual(
      new Set(entriesOf(pages).flatMap((entry) => (entry.stamp.fact === null ? [] : [entry.stamp.fact]))),
    );
    // The client is recorded `none`: no exposure row; one call row for each call.
    expect(await count(s, "ledger.exposures", "recipient = $1", [w().mac.id])).toBe(0);
    expect(await s.sql("select distinct tool, outcome from policy.calls where client_id = $1", [w().mac.id])).toEqual([
      { tool: "sync_mirror", outcome: "ok" },
    ]);
    expect(await count(s, "policy.calls", "client_id = $1", [w().mac.id])).toBe(pages.length + 1);
  });

  it("the mirror client's read quota is MIRROR_QUOTA, set at registration", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    expect(
      await s.sql(
        "select max_items_day::int, max_chars_day::int, max_rows_day::int, max_calls_minute::int from policy.clients where id = $1",
        [w().mac.id],
      ),
    ).toEqual([{ max_items_day: 300, max_chars_day: 100_000_000, max_rows_day: 1_000_000, max_calls_minute: 120 }]);
    // A full pass, its characters on its call rows; then a text tool given to the client reads
    // its first item: the syncs left its items room.
    const { pages } = await fullPass(reader, w().mac.token, null);
    expect(
      Number(
        (
          await s.sql<{ n: string }>(
            "select coalesce(sum(chars), 0)::text as n from policy.calls where client_id = $1",
            [w().mac.id],
          )
        )[0]?.n,
      ),
    ).toBeGreaterThan(0);
    await s.sql("update policy.clients set tools = '{sync_mirror,read_message}' where id = $1", [w().mac.id]);
    expect((await reader.readMessage(w().mac.token, { id: w().messages.ownBlake.id as MessageId })).ok).toBe(true);
    // Past maxRowsDay: refused rate_limited, and the call writes no mirror row.
    await s.sql("update policy.clients set max_rows_day = $2 where id = $1", [w().mac.id, entriesOf(pages).length]);
    const before = await mirrorState(s);
    expect(await reader.syncMirror(w().mac.token, argsOf({ cursor: null }))).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(await mirrorState(s)).toEqual(before);
    // Past maxCallsMinute, for a client whose rows are not spent: the second call of the minute.
    await s.sql("update policy.clients set max_calls_minute = 1 where id = $1", [w().wide.id]);
    expect((await reader.syncMirror(w().wide.token, argsOf({ cursor: null }))).ok).toBe(true);
    expect(await reader.syncMirror(w().wide.token, argsOf({ cursor: null }))).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });

  it("a mirror page holds every source value as the read tool's shape holds it, normalized by R60: under untrusted", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, w().wide.token, null);
    const text = JSON.stringify(pages);
    // No text of a message (its subject) or a capture item (its sealed title).
    for (const canary of PAGE_CANARIES) expect(text, canary).not.toContain(canary);
    // A claim's words, as find_facts serves them, under `untrusted` only.
    const words = "canary-mirror-what-blake";
    expect(text).toContain(JSON.stringify({ untrusted: words }));
    expect(text.split(words).length).toBe(text.split(JSON.stringify({ untrusted: words })).length);
  });

  it("invariant 6", async () => {
    // One store where only the own client syncs; one where the wider client has synced, and a
    // third device has pushed to the inbox and synced its own mirror, before the own client.
    const lone = await stack();
    const alone = await fullPass(readerOf(lone).reader, w().mac.token, null);
    const busy = await stack();
    const busyReader = readerOf(busy).reader;
    await fullPass(busyReader, w().wide.token, null);
    const other = await device(busy.admin, busy.db, "mac-other", OWN);
    await busy.admin.lens.addScope({ match: "host", value: "wiki.example.org", compartment: "own", kinds: ["moment"] });
    const pushed = {
      kind: "moment",
      key: `moment:${testId("k").slice(2)}`,
      revision: 0,
      observedAt: at(-1).toISOString(),
      endedAt: at(-1, 0.1).toISOString(),
      app: { bundle: "test.example.reader", name: "Reader" },
      url: "https://wiki.example.org/teams/alpha/plan",
      window: "Alpha plan",
      entity: "chat",
      participants: [],
      text: "canary-mirror-inbox-text",
      read: "ax",
    } as unknown as MomentItem;
    expect(
      (await busyReader.pushCapture(other.capture.token, { batch: "mirror-r72-batch-0001", items: [pushed] })).ok,
    ).toBe(true);
    expect(await count(busy, "ledger.capture_inbox")).toBeGreaterThan(0);
    await fullPass(busyReader, other.token, null);
    const crowded = await fullPass(busyReader, w().mac.token, null);
    // No entry, removal, count, order, truncated, passComplete or hash moves.
    expect(masked(crowded.pages)).toEqual(masked(alone.pages));
    // The control: the wider client sees the work rows the own client does not.
    const wide = await fullPass(busyReader, w().wide.token, null);
    expect(JSON.stringify(wide.pages)).toContain(w().events.workPast);
    expect(JSON.stringify(alone.pages)).not.toContain(w().events.workPast);
  });

  it("a removal's reason is withdrawn for an erasure, a deletion and a narrowing alike, and a veto closes the belief it serves", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const client = w().wide;
    const first = await fullPass(reader, client.token, null);
    const rows = await liveOf(s, client.id);
    const factOn = (evidence: string): Row | undefined =>
      rows.find((row) => row.section === "facts" && row.entry_key.startsWith(`${evidence}:`));
    const beliefOf = (key: string): Row | undefined =>
      rows.find((row) => row.section === "beliefs" && row.fact_key_fp === fingerprint(s.db.keys, "fact", key));
    // An erasure of one message, a deletion of another, a veto of a third fact key, and a
    // narrowing of what the client sees that leaves its audience as it is: a held message.
    const erased = factOn(w().messages.ownBlake.evidenceId);
    const deleted = factOn(w().messages.ownSent.evidenceId);
    const vetoed = beliefOf("mirror-pat-owner");
    const narrowed = factOn(w().messages.workWren.evidenceId);
    expect([erased, deleted, vetoed, narrowed].every((row) => row !== undefined)).toBe(true);
    await s.admin.erasure.eraseItem(
      { kind: "message", id: w().messages.ownBlake.id as MessageId },
      { requestId: testId("req") },
    );
    const personal = await s.writer().ensureSourceAccount("personal", "google_mail", "own", OWNER_PERSONAL);
    await s.writer().applyDeletion(personal, {
      sourceAccount: personal.id,
      sourceItemId: mailSourceId(w().messages.ownSent.fixture),
      deletedAt: new Date(T).toISOString(),
    } as never);
    const patClaim =
      (
        await s.sql<{ id: string }>("select id from knowledge.claims where evidence_id = $1", [
          w().messages.ownPat.evidenceId,
        ])
      )[0]?.id ?? "";
    await s.admin.facts.vetoFact(patClaim as never, { requestId: testId("req") });
    await s.sql("update knowledge.messages set held = true where evidence_id = $1", [w().messages.workWren.evidenceId]);
    await due(s, client.id);
    const second = await fullPass(reader, client.token, first.cursor);
    const drained = await page(reader, client.token, { cursor: second.cursor });
    const removals = removedOf([...second.pages, drained]);
    for (const row of [erased, deleted, narrowed]) expect(removals.map((one) => one.projection)).toContain(row?.id);
    // A veto closes a belief computed at read, which the client still sees: served again, closed,
    // under its id, never removed.
    expect(removals.map((one) => one.projection)).not.toContain(vetoed?.id);
    expect(
      inSection([...second.pages, drained], "beliefs").find((entry) => entry.stamp.projection === vetoed?.id),
    ).toMatchObject({ belief: { status: "closed" } });
    expect(new Set(removals.map((one) => one.reason))).toEqual(new Set(["withdrawn"]));
    // The control: a change of the client's audience is the one cause told apart, `replaced`.
    await s.sql("update policy.clients set compartments = $2 where id = $1", [client.id, OWN]);
    const narrower = await page(reader, client.token, { cursor: drained.cursor });
    expect(narrower.removals.length).toBeGreaterThan(0);
    expect(new Set(narrower.removals.map((one) => one.reason))).toEqual(new Set(["replaced"]));
  });

  it("both tools have rows in DEADLINE_MS: a call cancelled at its deadline rolls back, answers unavailable, and its cursor does not move", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await page(reader, w().mac.token, { cursor: null });
    const racing = readerOf(s, { record: { holdWhen: SERVE } });
    const controller = new AbortController();
    const before = await mirrorState(s);
    const call = racing.reader.syncMirror(w().mac.token, argsOf({ cursor: first.cursor }), {
      signal: controller.signal,
    });
    await racing.held.reached;
    controller.abort();
    racing.held.release();
    expect(await call).toEqual({ ok: false, code: "unavailable" });
    expect(await mirrorState(s)).toEqual(before);
    // The control: the same cursor, presented again, continues the pass.
    const next = await page(reader, w().mac.token, { cursor: first.cursor });
    expect(next.entries.length).toBeGreaterThan(0);
    expect(next.cursor).not.toBe(first.cursor);
  });

  it("a client in session mode gets unavailable before any read and no mirror row is written; switched back to stable, its next call continues from its cursor", async () => {
    const s = await stack();
    const plain = readerOf(s);
    const first = await page(plain.reader, w().mac.token, { cursor: null });
    await s.sql("update policy.clients set id_mode = 'session' where id = $1", [w().mac.id]);
    const before = await mirrorState(s);
    const watched = readerOf(s);
    expect(await watched.reader.syncMirror(w().mac.token, argsOf({ cursor: first.cursor }))).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(watched.statements.filter((text) => READS.test(text))).toEqual([]);
    expect(await mirrorState(s)).toEqual(before);
    // The control: stable again, the next call continues the pass from the cursor it holds.
    await s.sql("update policy.clients set id_mode = 'stable' where id = $1", [w().mac.id]);
    const next = await page(plain.reader, w().mac.token, { cursor: first.cursor });
    expect(next.pass).toBe(first.pass);
    expect(next.entries.length).toBeGreaterThan(0);
    expect(next.entries.every((entry) => entry.section !== "entities")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// L12, L21, L24, L36, and a page's bounds and its log line
// ---------------------------------------------------------------------------------------------

describe("the reader's gate tests", () => {
  it("the cursor before the latest re-sends that page's unconfirmed entries and nothing confirmed; an older one is stale_cursor", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const one = await page(reader, w().mac.token, { cursor: null });
    const two = await page(reader, w().mac.token, { cursor: one.cursor });
    const three = await page(reader, w().mac.token, { cursor: two.cursor });
    expect(three.entries.length).toBeGreaterThan(0);
    // `three` is lost: the Mac presents `two`'s cursor, now the one before the latest. The same
    // range is read again and its unconfirmed entries sent again, and nothing of `one` or `two`.
    const again = await page(reader, w().mac.token, { cursor: two.cursor });
    expect(again.entries.map((entry) => entry.stamp.projection)).toEqual(
      three.entries.map((entry) => entry.stamp.projection),
    );
    const confirmed = new Set([...one.entries, ...two.entries].map((entry) => entry.stamp.projection));
    expect(again.entries.filter((entry) => confirmed.has(entry.stamp.projection))).toEqual([]);
    // `one`'s cursor is neither the latest nor the one before it.
    const before = await mirrorState(s);
    expect(await reader.syncMirror(w().mac.token, argsOf({ cursor: one.cursor }))).toEqual(STALE);
    expect(await mirrorState(s)).toEqual(before);
    // The control: the latest continues.
    expect((await reader.syncMirror(w().mac.token, argsOf({ cursor: again.cursor }))).ok).toBe(true);
  });

  it("a raised extractor generation keeps every fact's projection id and serves each as an update, with no removal", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, w().mac.token, null);
    const facts = inSection(first.pages, "facts");
    expect(facts).toHaveLength(3);
    // Every item's claims again at generation 2: new claim ids on the same keys, and the beliefs
    // rebuilt on them.
    const raised: Records = new Map(
      [...w().records].map(([key, records]) => [
        key,
        records.map(
          (record) =>
            ({
              ...record,
              claim: { ...record.claim, id: `${record.claim.id.slice(0, 60)}0002`, extractorGeneration: 2 },
            }) as ClaimRecord,
        ),
      ]),
    );
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: s.log });
    try {
      for (const records of raised.values())
        expect(
          await pipeline.commit(batchOf(records[0]?.claim.primaryEvidenceId ?? "", records, { generation: 2 })),
        ).toBe("committed");
    } finally {
      await pipeline.close();
    }
    await knownBy(s.db, new Date(T));
    await due(s, w().mac.id);
    const second = await fullPass(reader, w().mac.token, first.cursor);
    const drained = await page(reader, w().mac.token, { cursor: second.cursor });
    expect(removedOf([...second.pages, drained])).toEqual([]);
    const updated = inSection(second.pages, "facts");
    expect(updated.map((entry) => entry.stamp.projection).sort()).toEqual(
      facts.map((entry) => entry.stamp.projection).sort(),
    );
    for (const entry of updated) {
      const old = facts.find((one) => one.stamp.projection === entry.stamp.projection);
      expect(entry.stamp.state).not.toBe(old?.stamp.state);
      expect(entry.section === "facts" ? entry.fact.id : "").not.toBe(old?.section === "facts" ? old.fact.id : "");
    }
  });

  it("a quiet pass opens no sealed column", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    opened.count = 0;
    const first = await fullPass(reader, w().mac.token, null);
    // The control: the first pass opens what it builds.
    expect(opened.count).toBeGreaterThan(0);
    const between = await page(reader, w().mac.token, { cursor: first.cursor });
    await due(s, w().mac.id);
    opened.count = 0;
    const quiet = await fullPass(reader, w().mac.token, between.cursor);
    expect(entriesOf(quiet.pages)).toEqual([]);
    expect(opened.count).toBe(0);
  });

  it("the daily rebuild pass serves an entry a source token missed", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, w().mac.token, null);
    const between = await page(reader, w().mac.token, { cursor: first.cursor });
    // A claim's sealed content changes, its row's clear columns do not: a gap in the token, which
    // a belief's and a fact's are both built from (the stored row's sealed value it once changed is
    // gone).
    const fact = fingerprint(s.db.keys, "fact", "mirror-blake-owner");
    const [claim] = await s.sql<{ id: string; content_enc: unknown }>(
      "select id, content_enc from knowledge.claims where fact_key_fp = $1 order by id limit 1",
      [fact],
    );
    if (claim === undefined) throw new Error("no claim");
    const ref = { table: "knowledge.claims", id: claim.id, column: "content_enc" };
    const record = JSON.parse(openRow(s.db.keys, "own", ref, claim.content_enc as never)) as {
      claim: { content: { fields: Record<string, unknown> } };
      fieldKinds: Record<string, string>;
    };
    const moved = {
      ...record,
      claim: {
        ...record.claim,
        content: { ...record.claim.content, fields: { ...record.claim.content.fields, due: dayOf(at(30)) } },
      },
      fieldKinds: { ...record.fieldKinds, due: "date" },
    };
    await asClaimsOwner(s.db, (query) =>
      query("update knowledge.claims set content_enc = $2::jsonb where id = $1", [
        claim.id,
        JSON.stringify(sealRow(s.db.keys, "own", ref, JSON.stringify(moved))),
      ]),
    );
    const served = inSection(first.pages, "beliefs").find((entry) => entry.stamp.fact === fact);
    expect(served).toBeDefined();
    const servedFact = inSection(first.pages, "facts").find((entry) => entry.stamp.fact === fact);
    expect(servedFact).toBeDefined();
    // An hourly pass does not see it.
    await due(s, w().mac.id);
    const hourly = await fullPass(reader, w().mac.token, between.cursor);
    expect(idsOf(hourly.pages)).not.toContain(served?.stamp.projection);
    expect(idsOf(hourly.pages)).not.toContain(servedFact?.stamp.projection);
    // The daily pass ignores tokens, and serves the belief under the same id with its new state, and
    // the fact read from the same claim, and only them: every other built state equals the one
    // confirmed. Its first call presents the hourly pass's last cursor, which confirms that page and
    // starts the rebuild pass in the same call; a separate confirming call at this clock would
    // itself start a pass that reads tokens.
    await due(s, w().mac.id, { rebuild: true });
    const daily = await fullPass(reader, w().mac.token, hourly.cursor);
    expect(idsOf(daily.pages).sort()).toEqual([served?.stamp.projection, servedFact?.stamp.projection].sort());
    const rebuilt = entriesOf(daily.pages).find((entry) => entry.stamp.projection === served?.stamp.projection);
    expect(rebuilt?.stamp.state).not.toBe(served?.stamp.state);
  });

  it("after a wipe and a null cursor every visible entry is sent again", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, w().mac.token, null);
    await page(reader, w().mac.token, { cursor: first.cursor });
    const wiped = await fullPass(reader, w().mac.token, null);
    expect(entriesOf(wiped.pages)).toEqual(entriesOf(first.pages));
    expect(removedOf(wiped.pages)).toEqual([]);
  });

  it("after a database restore the Mac's cursor is stale_cursor, and the rebuilt mirror holds nothing erased after the dump", async () => {
    const live = await copies.copy();
    closers.push(() => live.drop());
    const log = eventLogger();
    const open = (db: TestDatabase) => {
      const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
      const readerPool = new pg.Pool({ connectionString: db.urls.reader, max: 2 });
      const end = async (): Promise<void> => {
        await adminPool.end();
        await readerPool.end();
      };
      return {
        admin: new Admin({
          pool: adminPool,
          keys: db.keys,
          log,
          now: () => new Date(T),
          journal: journalPath(db.keyFile),
        }),
        reader: new Reader({ pool: readerPool, keys: db.keys, log, now: () => new Date(T) }),
        end,
      };
    };
    const before = open(live);
    const first = await fullPass(before.reader, w().mac.token, null);
    expect(JSON.stringify(first.pages)).toContain("canary-mirror-what-blake");
    await before.end();
    // The dump: a copy of the database as it is now, with its journal.
    const dump = await copyTestDatabase(live);
    closers.push(() => dump.drop());
    // After the dump: a call more, and an erasure.
    const after = open(live);
    closers.push(after.end);
    const later = await page(after.reader, w().mac.token, { cursor: first.cursor });
    await after.admin.erasure.eraseItem(
      { kind: "message", id: w().messages.ownBlake.id as MessageId },
      { requestId: testId("req") },
    );
    // The restore: the dump's rows and the live journal, replayed before the first read.
    await copyFile(journalPath(live.keyFile), journalPath(dump.keyFile));
    const restored = open(dump);
    closers.push(restored.end);
    expect((await restored.admin.erasure.replayErasures()).applied).toBeGreaterThan(0);
    expect(await restored.reader.syncMirror(w().mac.token, argsOf({ cursor: later.cursor }))).toEqual(STALE);
    // Lens wipes and starts from null: the rebuilt mirror holds nothing of the erased message.
    const rebuilt = await fullPass(restored.reader, w().mac.token, null);
    expect(JSON.stringify(rebuilt.pages)).not.toContain("canary-mirror-what-blake");
    const evidence = w().messages.ownBlake.evidenceId;
    const rows = await queryAs<{ entry_key: string; evidence_ids: string[] }>(
      dump.urls.admin,
      "select entry_key, evidence_ids from ledger.mirror_entries where client_id = $1 and ended_at is null",
      [w().mac.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entry_key.startsWith(`${evidence}:`)).toBe(false);
      expect(row.evidence_ids).not.toContain(evidence);
    }
  });

  it("a call listing only versions the server does not know answers unsupported_template before any read and writes no row", async () => {
    const s = await stack();
    const watched = readerOf(s);
    const before = await mirrorState(s);
    expect(
      await watched.reader.syncMirror(
        w().mac.token,
        argsOf({ cursor: null, templates: ["lens_mirror@9", "lens_mirror@10"] }),
      ),
    ).toEqual({ ok: false, code: "unsupported_template" });
    expect(watched.statements.filter((text) => READS.test(text))).toEqual([]);
    expect(await mirrorState(s)).toEqual(before);
    // The control: lens_mirror@1 is served.
    expect((await watched.reader.syncMirror(w().mac.token, argsOf({ cursor: null }))).ok).toBe(true);
  });

  it("a call listing lens_mirror@1 and a version the server does not know is served lens_mirror@1, and of two known versions the higher is served", async () => {
    const s = await stack();
    expect(
      (await page(readerOf(s).reader, w().mac.token, { cursor: null, templates: ["lens_mirror@7", "lens_mirror@1"] }))
        .template,
    ).toBe("lens_mirror@1");
    // By its number, not its text: @10 is higher than @2.
    const known = readerOf(s, { templates: [T1, version("lens_mirror@2"), version("lens_mirror@10")] });
    expect(
      (
        await rawPage(known.reader, w().wide.token, {
          cursor: null,
          templates: ["lens_mirror@2", "lens_mirror@10", "lens_mirror@1"],
        })
      ).template,
    ).toBe("lens_mirror@10");
    expect(new Set((await liveOf(s, w().wide.id)).map((row) => row.template))).toEqual(new Set(["lens_mirror@10"]));
  });

  it("a fact, a belief, an entity, a capture item and a project's anchor whose type or kind the chosen version does not list are in none of the client's pages, and the same store without them serves the same pages, hash included", async () => {
    // The test version lists no organization, no commitment belief, no plan fact, no moment
    // and no host anchor.
    const fewer = version("lens_mirror@1", {
      entityKinds: ["person", "project"],
      beliefKinds: T1.members.beliefKinds.filter((kind) => kind !== "commitment"),
      factTypes: T1.members.factTypes.filter((type) => type !== "plan"),
      captureKinds: ["meeting"],
      anchorKinds: T1.members.anchorKinds.filter((kind) => kind !== "host"),
    });
    // With them: the world's commitment beliefs, moments and host anchor, and an organization and
    // a plan claim beside Pat's commitment.
    const withThem = await stack();
    const organization = await session(withThem.db.urls.admin, async (query) => {
      const seed = seeder(withThem.db, query);
      const id = await seed.entity("organization");
      await seed.domain(OWN, id);
      return id;
    });
    const base = commitmentRecord(w().messages.ownPat, w().pat, w().owner, "mirror-pat-plan", "", 2000);
    const plan = {
      ...base,
      claim: {
        ...base.claim,
        content: { type: "plan", subject: w().pat, fields: { what: "canary-mirror-plan", when: dayOf(at(5)) } },
      },
      fieldKinds: { what: "text", when: "date" },
    } as unknown as ClaimRecord;
    await commitOn(withThem, w().messages.ownPat, [plan]);
    // Without them: no moment, no host anchor and no belief (every belief of the world is a
    // commitment), and no organization or plan claim.
    const without = await stack();
    await without.sql("delete from knowledge.captures where kind = 'moment'");
    await without.sql("delete from knowledge.project_anchors where id = $1", [w().anchors.host]);
    const a = await fullPass(readerOf(withThem, { templates: [fewer] }).reader, w().mac.token, null);
    const b = await fullPass(readerOf(without, { templates: [fewer] }).reader, w().mac.token, null);
    expect(masked(a.pages)).toEqual(masked(b.pages));
    const text = JSON.stringify(a.pages);
    for (const id of [organization, w().anchors.host, w().captures.momentRecent.id, "canary-mirror-plan"])
      expect(text, id).not.toContain(id);
    expect(inSection(a.pages, "beliefs")).toEqual([]);
    // The control: under lens_mirror@1 itself each of them is served.
    const full = await fullPass(readerOf(withThem).reader, w().mac.token, null);
    const served = JSON.stringify(full.pages);
    for (const id of [organization, w().anchors.host, w().captures.momentRecent.id, "canary-mirror-plan"])
      expect(served, id).toContain(id);
    expect(inSection(full.pages, "beliefs").length).toBeGreaterThan(0);
  });

  it("an entry served under one version whose member the next chosen version does not list is ended before any entry of that version is sent", async () => {
    const s = await stack();
    const first = await fullPass(readerOf(s).reader, w().mac.token, null);
    const moment = (await liveOf(s, w().mac.id)).find((row) => row.entry_key === w().captures.momentRecent.id);
    expect(moment).toBeDefined();
    // Lens and the server gain lens_mirror@2, which lists no moment.
    const templates = ["lens_mirror@1", "lens_mirror@2"];
    const next = readerOf(s, { templates: [T1, version("lens_mirror@2", { captureKinds: ["meeting"] })] });
    const switched = await rawPage(next.reader, w().mac.token, { cursor: first.cursor, templates });
    expect(switched.entries).toEqual([]);
    expect(switched.removals.map((one) => one.projection)).toContain(moment?.id);
    await due(s, w().mac.id);
    const pass = await fullPass(next.reader, w().mac.token, switched.cursor, { templates }, rawPage);
    expect(JSON.stringify(pass.pages)).not.toContain(w().captures.momentRecent.id);
    // The control: its meetings are served.
    expect(JSON.stringify(pass.pages)).toContain(w().captures.meetingPast.id);
  });

  it("a change of the chosen version ends every row of the earlier one replaced before any entry, and the following pass completes", async () => {
    const s = await stack();
    const first = await fullPass(readerOf(s).reader, w().mac.token, null);
    const earlier = (await liveOf(s, w().mac.id)).map((row) => row.id);
    const templates = ["lens_mirror@1", "lens_mirror@2"];
    const next = readerOf(s, { templates: [T1, version("lens_mirror@2")] });
    // The cursor holds no template: the cursor of the @1 pass is presented when @2 is chosen.
    const switched = await rawPage(next.reader, w().mac.token, { cursor: first.cursor, templates });
    expect(switched.template).toBe("lens_mirror@2");
    expect(switched.entries).toEqual([]);
    expect(switched.removals.map((one) => one.projection).sort()).toEqual([...earlier].sort());
    for (const one of switched.removals) expect(one.reason).toBe("replaced");
    await due(s, w().mac.id);
    const pass = await fullPass(next.reader, w().mac.token, switched.cursor, { templates }, rawPage);
    expect(pass.pages.at(-1)?.passComplete).toBe(true);
    const live = await liveOf(s, w().mac.id);
    expect(live).toHaveLength(earlier.length);
    expect(new Set(live.map((row) => row.template))).toEqual(new Set(["lens_mirror@2"]));
    expect(live.map((row) => row.id).filter((id) => earlier.includes(id))).toEqual([]);
  });

  it("a page is at most 262 144 bytes of JSON and its section caps hold", async () => {
    const s = await stack();
    // 100 facts of 6 000 characters each: one call's build (MIRROR_BUILD_PER_CALL, 50) is over a
    // page's bytes.
    const long = Array.from({ length: 100 }, (_, n) =>
      commitmentRecord(
        w().messages.ownPat,
        w().owner,
        w().pat,
        `mirror-long-${n}`,
        `canary-mirror-long-${n}-${"x".repeat(6000)}`,
        3000 + n,
      ),
    );
    await commitOn(s, w().messages.ownPat, long);
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, w().mac.token, null);
    for (const one of pages) expect(Buffer.byteLength(JSON.stringify(one), "utf8")).toBeLessThanOrEqual(PAGE_BYTES);
    expect(inSection(pages, "facts")).toHaveLength(103);
    // Cut by its bytes, not its build: a facts page of fewer than MIRROR_BUILD_PER_CALL entries,
    // and another facts page after it.
    const factPages = pagesOf(pages, "facts");
    expect(factPages.length).toBeGreaterThanOrEqual(2);
    expect(factPages[0]?.entries.length).toBeLessThan(MIRROR_BUILD_PER_CALL);
    for (const section of T1.sections) expect(inSection(pages, section.name).length).toBeLessThanOrEqual(section.cap);
  });

  it("the mirror_served log line holds counts and the pass and no canary", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const from = s.log.events.length;
    const { pages } = await fullPass(reader, w().wide.token, null);
    const lines = s.log.events.slice(from).filter((event) => event.event === "mirror_served");
    expect(lines).toHaveLength(pages.length);
    for (const [n, line] of lines.entries()) {
      const one = pages[n];
      expect(PersonalLogEvent.parse(line)).toEqual(line);
      expect(line.counts).toEqual({
        entries: one?.entries.length,
        removals: one?.removals.length,
        erased: one?.captureErased.length,
        pass: one?.pass,
        pass_complete: one?.passComplete === true ? 1 : 0,
      });
      const text = JSON.stringify(line);
      for (const canary of LOG_CANARIES) expect(text, canary).not.toContain(canary);
      for (const id of [w().blake, w().pat, w().messages.ownBlake.id, w().captures.meetingPast.id])
        expect(text).not.toContain(id);
    }
  });
});
