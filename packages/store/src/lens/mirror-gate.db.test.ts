import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  BELIEF_TYPES,
  type CaptureId,
  type ClaimRecord,
  type EntityId,
  ErasureReport,
  type MessageId,
  MIRROR_TEMPLATES,
  type MirrorCapture,
  type MirrorEntry,
  MirrorPage,
  type MirrorSection,
  type MirrorTemplate,
  type PersonalView,
  type RulingId,
  SourceAccountId,
  type SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
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
import { session } from "../test-support/connections.ts";
import {
  copiesOf,
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "../test-support/database.ts";
import { type MailFixture, mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, beliefsComputed, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingPool } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import type { TestStore } from "../test-support/store.ts";
import { storeSeeder } from "../test-support/world.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// The mirror's gate tests that erase, reconcile and compare stores, written from the spec alone.
//
// Two worlds, each built once and copied for each test (copiesOf). The base world holds the
// owner's `own` label alone, its commitments, beliefs, project and capture items, and three
// devices; the full world is a copy of the base with the employer:example rows added through the
// same writer and pipeline: a work label, a work commitment and the wide audience's beliefs, a
// work project and a work meeting. So the base and the full world share every id, key and client
// (L10's "two stores built from one seed"), and the clock is pinned to the time they were built
// at. No real wait anywhere. Reserved domains, synthetic names.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const at = (days: number, hours = 0): Date => new Date(T + days * DAY + hours * HOUR);
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const CLEARED = ["declassified", "own"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const PASS_SECONDS = 3_600;
const T1 = MIRROR_TEMPLATES.find((one) => one.name === "lens_mirror@1") as MirrorTemplate;

const OWNER_PERSONAL = "owner.gate@example.com";
const OWNER_WORK = "owner.gate@example.org";
const BLAKE = { address: "blake.gate@example.com", name: "Blake Canary-Gate" };
const BLAKE_AT_WORK = { address: BLAKE.address, name: "Blake Canary-Gatework" };
const PAT = { address: "pat.gate@example.com", name: "Pat Canary-Gate" };
const WREN = { address: "wren.gate@example.org", name: "Wren Canary-Gate" };

type Person = { address: string; name?: string };
type Device = { name: string; id: string; token: string; accounts: { meetings: string; activity: string } };
type Capture = { id: string; evidence: string; key: string };
type Mail = Message & { fixture: MailFixture };
type Base = {
  owner: string;
  blake: string;
  pat: string;
  messages: Record<"ownBlake" | "ownSent" | "ownPat", Mail>;
  events: Record<"ownPast" | "ownNext", string>;
  specs: CommitmentSpec[];
  records: Records;
  project: string;
  anchors: { app: string; host: string; thread: string };
  mac: Device;
  wide: Device;
  cleared: Device;
  captures: Record<"meetingPast" | "meetingOld" | "momentRecent" | "momentOld", Capture>;
};
type Work = {
  wren: string;
  workWren: Mail;
  workPast: string;
  specs: CommitmentSpec[];
  records: Records;
  project: string;
  anchor: string;
  hidden: Capture;
};

let base: Base | undefined;
let work: Work | undefined;
const b = (): Base => {
  if (base === undefined) throw new Error("the base world is not built");
  return base;
};
const wk = (): Work => {
  if (work === undefined) throw new Error("the full world is not built");
  return work;
};

const fixtureOf = (id: string, from: Person, to: Person, when: Date, sent: boolean): MailFixture => ({
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@mail.example.com`,
  at: when.toISOString() as MailFixture["at"],
  from,
  to: [to],
  subject: `canary-gate-subject-${id}`,
  labels: sent ? ["SENT"] : ["INBOX"],
});
const asStore = (db: TestDatabase): TestStore => ({ db }) as unknown as TestStore;
const request = () => ({ requestId: testId("req") });

async function device(admin: Admin, db: TestDatabase, name: string, compartments: string[]): Promise<Device> {
  await admin.lens.addDevice(name, { compartments, views: VIEWS });
  // The mirror's first token is the first rotation's.
  const tokens = { mirror: await admin.lens.rotateDevice(name, "mirror") };
  const [client] = await queryAs<{ id: string }>(db.urls.admin, "select id from policy.clients where name = $1", [
    name,
  ]);
  const accounts = await queryAs<{ id: string; connector: string }>(
    db.urls.admin,
    "select id, connector from vault.source_accounts where label = $1",
    [`device:${name}`],
  );
  const accountOf = (connector: string): string => accounts.find((one) => one.connector === connector)?.id ?? "";
  return {
    name,
    id: client?.id ?? "",
    token: tokens.mirror,
    accounts: { meetings: accountOf("lens_meetings"), activity: accountOf("lens_activity") },
  };
}

// A stored capture item as the drain leaves it, written as pi_admin.
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
        hashFingerprint(db.keys, "content_hash", sha256Hex(`gate capture ${key}`)),
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
        sealed("knowledge.captures", id, "facts_enc", JSON.stringify({ title: "canary-gate-capture-title" })),
        item.compartments,
      ],
    );
    return { id, evidence, key };
  });
}

const messageOn = async (db: TestDatabase, days: number, compartment: string, fixture: MailFixture): Promise<Mail> => {
  const found = (await worldMessages(asStore(db))).find(
    (one) => one.compartment === compartment && Math.round((Date.parse(one.sentAt) - T) / DAY) === days,
  );
  if (found === undefined) throw new Error(`no ${compartment} message on day ${days}`);
  return { ...found, fixture };
};
const eventAt = async (db: TestDatabase, start: Date): Promise<string> =>
  (
    await queryAs<{ event_id: string }>(
      db.urls.admin,
      "select event_id from knowledge.event_details where starts_at = $1",
      [start.toISOString()],
    )
  )[0]?.event_id ?? "";
const meeting = (id: string, start: Date, organizer: string, attendees: Person[]) => ({
  id,
  title: `canary-gate-title-${id}`,
  start,
  end: new Date(start.getTime() + HOUR),
  organizer: { address: organizer },
  attendees,
});

// Opens a writer and an admin on a database, runs `fn`, and closes both.
async function withOwner<T>(db: TestDatabase, fn: (writer: Writer, admin: Admin) => Promise<T>): Promise<T> {
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  try {
    return await fn(
      writer,
      new Admin({ pool, keys: db.keys, log, now: () => new Date(T), journal: journalPath(db.keyFile) }),
    );
  } finally {
    await writer.close();
    await pool.end();
  }
}

// The base world: the owner's `own` label, Blake and Pat, a past and a coming meeting with Blake,
// three commitments and each device audience's beliefs of them, a project with an app, a host and a
// thread anchor, three devices (own; own and employer:example; own and declassified) and four
// capture items (a meeting two days ago linked to its event, a meeting 200 days ago, a moment a
// day ago and one 100 days ago).
async function buildBase(): Promise<TestDatabase> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example", "declassified"] });
  return withOwner(db, async (writer, admin) => {
    const seed = storeSeeder(writer, new Date(T));
    const personal = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER_PERSONAL);
    const calendar = await writer.ensureSourceAccount("personal", "google_calendar", "own", OWNER_PERSONAL);
    const mails = {
      ownBlake: { days: -5, from: BLAKE, to: { address: OWNER_PERSONAL }, sent: false },
      ownSent: { days: -4, from: { address: OWNER_PERSONAL }, to: BLAKE, sent: true },
      ownPat: { days: -3, from: PAT, to: { address: OWNER_PERSONAL }, sent: false },
    };
    for (const [name, one] of Object.entries(mails))
      await seed.mail(personal, {
        id: `gate-${name}`,
        from: one.from,
        to: [one.to],
        at: at(one.days),
        subject: `canary-gate-subject-gate-${name}`,
        sent: one.sent,
      });
    await seed.event(calendar, meeting("gate-own-past", at(-2), OWNER_PERSONAL, [{ address: BLAKE.address }]));
    await seed.event(calendar, meeting("gate-own-next", at(3), OWNER_PERSONAL, [{ address: BLAKE.address }]));
    const owner = seed.ownerEntity();
    const blake = seed.entityOf(BLAKE.address);
    const pat = seed.entityOf(PAT.address);
    const messages = {
      ownBlake: await messageOn(
        db,
        -5,
        "own",
        fixtureOf("gate-ownBlake", mails.ownBlake.from, mails.ownBlake.to, at(-5), false),
      ),
      ownSent: await messageOn(
        db,
        -4,
        "own",
        fixtureOf("gate-ownSent", mails.ownSent.from, mails.ownSent.to, at(-4), true),
      ),
      ownPat: await messageOn(
        db,
        -3,
        "own",
        fixtureOf("gate-ownPat", mails.ownPat.from, mails.ownPat.to, at(-3), false),
      ),
    };
    const due = dayOf(at(10));
    const specs: CommitmentSpec[] = [
      {
        key: "gate-blake-owner",
        subject: blake,
        counterparty: owner,
        due,
        claims: [{ message: messages.ownBlake, what: "canary-gate-what-blake" }],
      },
      {
        key: "gate-owner-blake",
        subject: owner,
        counterparty: blake,
        due,
        claims: [{ message: messages.ownSent, what: "canary-gate-what-owner" }],
      },
      {
        key: "gate-pat-owner",
        subject: pat,
        counterparty: owner,
        claims: [{ message: messages.ownPat, what: "canary-gate-what-pat" }],
      },
    ];
    // The project and its anchors come before the claims: anchoring a thread deletes its items'
    // claims and the beliefs on them and replays only a saved call, and these hand-committed claims
    // have none.
    const project = await admin.projects.add("canary-gate-project", request());
    const anchors = {
      app: await admin.projects.anchor(project, { kind: "app", value: "test.Example.Notes" }, request()),
      host: await admin.projects.anchor(project, { kind: "host", value: "Plans.Example.com." }, request()),
      thread: await admin.projects.anchor(project, messages.ownBlake.id as MessageId, request()),
    };
    const records = await commitClaims(asStore(db), owner, specs);
    await knownBy(db, new Date(T));
    // Each device's audience has its beliefs: own, own with employer:example, own with declassified.
    const mac = await device(admin, db, "mac", OWN);
    const wide = await device(admin, db, "mac-wide", BOTH);
    const cleared = await device(admin, db, "mac-cleared", CLEARED);
    const events = { ownPast: await eventAt(db, at(-2)), ownNext: await eventAt(db, at(3)) };
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
    };
    base = { owner, blake, pat, messages, events, specs, records, project, anchors, mac, wide, cleared, captures };
    return db;
  });
}

// An employer:example project with a device anchor, and a work meeting stored as a capture item:
// what L33 adds to a store, and the full world holds.
async function addHiddenProject(
  db: TestDatabase,
  event: string | null,
): Promise<{ project: string; anchor: string; hidden: Capture }> {
  return withOwner(db, async (_writer, admin) => {
    const project = await admin.projects.add("canary-gate-work-project", {
      compartment: "employer:example",
      ...request(),
    });
    const anchor = await admin.projects.anchor(project, { kind: "app", value: "test.example.worknotes" }, request());
    const hidden = await captureIn(db, b().mac.accounts.meetings, {
      kind: "meeting",
      from: at(-2, 3),
      to: at(-2, 4),
      event,
      compartments: ["employer:example"],
    });
    return { project, anchor, hidden };
  });
}

// The full world: the base and the employer:example rows. Blake writes from work too, Wren only
// there; a work meeting with Wren; Wren's commitment, and the wide audience's beliefs again with
// it; the work project and the work meeting's capture item.
async function buildFull(): Promise<TestDatabase> {
  const db = await bases.copy();
  const added = await withOwner(db, async (writer) => {
    const seed = storeSeeder(writer, new Date(T));
    const mailbox = await writer.ensureSourceAccount("work", "google_mail", "employer:example", OWNER_WORK);
    const calendar = await writer.ensureSourceAccount("work", "google_calendar", "employer:example", OWNER_WORK);
    await seed.mail(mailbox, {
      id: "gate-workWren",
      from: WREN,
      to: [{ address: OWNER_WORK }],
      at: at(-7),
      subject: "canary-gate-subject-gate-workWren",
    });
    await seed.mail(mailbox, {
      id: "gate-workBlake",
      from: BLAKE_AT_WORK,
      to: [{ address: OWNER_WORK }],
      at: at(-1),
      subject: "canary-gate-subject-gate-workBlake",
    });
    await seed.event(calendar, meeting("gate-work-past", at(-2, 3), OWNER_WORK, [WREN]));
    const wren = seed.entityOf(WREN.address);
    const workWren = await messageOn(
      db,
      -7,
      "employer:example",
      fixtureOf("gate-workWren", WREN, { address: OWNER_WORK }, at(-7), false),
    );
    const specs: CommitmentSpec[] = [
      {
        key: "gate-wren-owner",
        subject: wren,
        counterparty: b().owner,
        due: dayOf(at(10)),
        claims: [{ message: workWren, what: "canary-gate-what-wren" }],
      },
    ];
    const records = await commitClaims(asStore(db), b().owner, specs);
    await knownBy(db, new Date(T));
    return { wren, workWren, specs, records, workPast: await eventAt(db, at(-2, 3)) };
  });
  const hidden = await addHiddenProject(db, added.workPast);
  work = { ...added, ...hidden };
  return db;
}

const bases = copiesOf(buildBase);
const fulls = copiesOf(buildFull);
afterAll(async () => {
  await fulls.drop();
  await bases.drop();
});

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

async function stack(which: "base" | "full" = "full"): Promise<Stack> {
  const db = await (which === "base" ? bases : fulls).copy();
  closers.push(() => db.drop());
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

function readerOf(s: Stack, options: { pool?: pg.Pool; record?: Parameters<typeof recordingPool>[1] } = {}) {
  const recorded = recordingPool(options.pool ?? s.readerPool, options.record);
  const reader = new Reader({ pool: recorded.pool, keys: s.db.keys, log: s.log, now: () => new Date(s.clock.at) });
  return { reader, statements: recorded.statements, held: recorded.held };
}

type Call = { cursor: string | null; limit?: number; erasedDone?: string[] };
const argsOf = (call: Call): SyncMirrorArgs =>
  ({
    templates: [T1.name],
    cursor: call.cursor,
    ...(call.limit === undefined ? {} : { limit: call.limit }),
    ...(call.erasedDone === undefined ? {} : { erasedDone: call.erasedDone }),
  }) as SyncMirrorArgs;
const page = async (reader: Reader, token: string, call: Call): Promise<MirrorPage> => {
  const answer = await reader.syncMirror(token, argsOf(call));
  if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
  return MirrorPage.parse(answer.value);
};
type Pass = { pages: MirrorPage[]; cursor: string };
async function fullPass(
  reader: Reader,
  token: string,
  cursor: string | null,
  more: Omit<Call, "cursor"> = {},
): Promise<Pass> {
  const pages: MirrorPage[] = [];
  let next = cursor;
  // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
  for (let n = 0; n < 2_000; n += 1) {
    const one = await page(reader, token, { ...more, cursor: next });
    pages.push(one);
    next = one.cursor;
    if (one.passComplete) return { pages, cursor: next };
  }
  throw new Error("no pass completed");
}
const entriesOf = (pages: readonly MirrorPage[]): MirrorEntry[] => pages.flatMap((one) => one.entries);
const idsOf = (pages: readonly MirrorPage[]): string[] => entriesOf(pages).map((entry) => entry.stamp.projection);
const removedOf = (pages: readonly MirrorPage[]) => pages.flatMap((one) => one.removals);
const inSection = (pages: readonly MirrorPage[], section: MirrorSection): MirrorEntry[] =>
  entriesOf(pages).filter((entry) => entry.section === section);
const masked = (pages: readonly MirrorPage[]) => pages.map((one) => ({ ...one, cursor: "mcr" }));

async function due(s: Stack, client: string): Promise<void> {
  const [row] = await s.sql<{ completed: Date | null }>(
    "select max(completed_at) as completed from ledger.mirror_cursors where client_id = $1",
    [client],
  );
  if (row?.completed === null || row?.completed === undefined) throw new Error("no completed pass");
  s.clock.at = Math.max(s.clock.at, row.completed.getTime() + PASS_SECONDS * 1000 + 1000);
}

type Row = {
  id: string;
  section: MirrorSection;
  entry_key: string;
  ended_at: Date | null;
  reason: string | null;
  tainted_at: Date | null;
  last_sent_at: Date | null;
  evidence_ids: string[];
  entity_ids: string[];
};
const rowsOf = (s: Stack, client: string): Promise<Row[]> =>
  s.sql<Row>(
    "select id, section, entry_key, ended_at, reason, tainted_at, last_sent_at, evidence_ids, entity_ids from ledger.mirror_entries where client_id = $1 order by id",
    [client],
  );
const liveOf = async (s: Stack, client: string): Promise<Row[]> =>
  (await rowsOf(s, client)).filter((row) => row.ended_at === null);
const count = async (s: Stack, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  (await s.sql<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, values))[0]?.n ?? -1;
const mirrorState = async (s: Stack): Promise<string> =>
  (
    await s.sql<{ line: string }>(
      `select (select count(*) || ' ' || coalesce(max(xmin::text::bigint), 0) from ledger.mirror_entries) || ' ' ||
              (select count(*) || ' ' || coalesce(max(xmin::text::bigint), 0) from ledger.mirror_cursors) || ' ' ||
              (select count(*) || ' ' || coalesce(max(xmin::text::bigint), 0) from ledger.erasure_exposures) as line`,
    )
  )[0]?.line ?? "";
const SERVE = (text: string): boolean => /serve_mirror\s*\(/.test(text);
const linksOf = (s: Stack, erasure: string | null): Promise<{ mirror_entry_id: string }[]> =>
  s.sql<{ mirror_entry_id: string }>(
    "select mirror_entry_id from ledger.erasure_exposures where erasure_id = $1 and mirror_entry_id is not null order by mirror_entry_id",
    [erasure],
  );

// The Mac's mirror: each page applied, removals first, as Lens applies it, held by entry key
// through the server's rows for the client.
async function keysOf(s: Stack, client: string, passes: readonly MirrorPage[][]): Promise<string[]> {
  const held = new Set<string>();
  for (const pages of passes) {
    for (const one of pages) {
      for (const removal of one.removals) held.delete(removal.projection);
      for (const entry of one.entries) held.add(entry.stamp.projection);
    }
  }
  const rows = await rowsOf(s, client);
  return [...held]
    .map((id) => `${rows.find((row) => row.id === id)?.section}/${rows.find((row) => row.id === id)?.entry_key}`)
    .sort();
}

describe("deletion and erasure reaching the Mac", () => {
  it("an erasure of a capture item, and of a person, ends the mirror rows resting on them in the erasure's transaction", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    await fullPass(reader, b().mac.token, null);
    const before = await rowsOf(s, b().mac.id);
    const onCapture = before.filter((row) => row.evidence_ids.includes(b().captures.momentRecent.evidence));
    const onPat = before.filter((row) => row.entity_ids.includes(b().pat));
    expect(onCapture.map((row) => row.entry_key)).toEqual([b().captures.momentRecent.id]);
    expect(onPat.length).toBeGreaterThan(0);
    // No mirror call between the erasure and these reads: the rows are ended by the erasure.
    await s.admin.erasure.eraseItem({ kind: "capture", id: b().captures.momentRecent.id as CaptureId }, request());
    await s.admin.erasure.erasePerson(b().pat as EntityId, request());
    const after = await rowsOf(s, b().mac.id);
    for (const row of [...onCapture, ...onPat]) {
      expect(after.find((one) => one.id === row.id)).toMatchObject({
        reason: "withdrawn",
        evidence_ids: [],
        ended_at: expect.any(Date),
        tainted_at: expect.any(Date),
      });
    }
    // The control: a row resting on neither is live and untouched.
    const kept = before.filter((row) => !onCapture.includes(row) && !onPat.includes(row));
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) expect(after.find((one) => one.id === row.id)).toEqual(row);
  });

  it("the next call, mid-pass or after it, sends their removals and the capture keys before any entry, again until confirmed", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    // Mid-pass: two calls in, a capture item and a person are erased.
    const one = await page(reader, b().mac.token, { cursor: null });
    const two = await page(reader, b().mac.token, { cursor: one.cursor });
    const served = new Set<string>([...one.entries, ...two.entries].map((entry) => entry.stamp.projection));
    await s.admin.erasure.eraseItem({ kind: "capture", id: b().captures.meetingPast.id as CaptureId }, request());
    await s.admin.erasure.erasePerson(b().pat as EntityId, request());
    const onPat = (await rowsOf(s, b().mac.id))
      .filter((row) => row.tainted_at !== null && served.has(row.id))
      .map((row) => row.id);
    expect(onPat.length).toBeGreaterThan(0);
    const three = await page(reader, b().mac.token, { cursor: two.cursor });
    expect(three.removals.map((removal) => removal.projection).sort()).toEqual([...onPat].sort());
    expect(three.captureErased).toEqual([b().captures.meetingPast.key]);
    expect(three.entries.length).toBeGreaterThan(0);
    // Again until confirmed: the page is lost, the cursor before it presented, and both come
    // again; the next cursor confirms the removals, and the key stays until erasedDone lists it.
    const lost = await page(reader, b().mac.token, { cursor: two.cursor });
    expect(lost.removals.map((removal) => removal.projection).sort()).toEqual([...onPat].sort());
    expect(lost.captureErased).toEqual([b().captures.meetingPast.key]);
    const four = await page(reader, b().mac.token, { cursor: lost.cursor });
    expect(four.removals).toEqual([]);
    expect(four.captureErased).toEqual([b().captures.meetingPast.key]);
    const five = await page(reader, b().mac.token, { cursor: four.cursor, erasedDone: [b().captures.meetingPast.key] });
    expect(five.captureErased).toEqual([]);
    // After the pass: an erasure's removal and key come in the next call, between passes.
    const done = five.passComplete ? { cursor: five.cursor } : await fullPass(reader, b().mac.token, five.cursor);
    const moment = (await liveOf(s, b().mac.id)).find((row) => row.entry_key === b().captures.momentRecent.id);
    expect(moment).toBeDefined();
    await s.admin.erasure.eraseItem({ kind: "capture", id: b().captures.momentRecent.id as CaptureId }, request());
    const next = await page(reader, b().mac.token, { cursor: done.cursor });
    expect(next.removals.map((removal) => removal.projection)).toEqual([moment?.id]);
    expect(next.captureErased).toEqual([b().captures.momentRecent.key]);
    expect(next.entries).toEqual([]);
  });

  it("an erasure committed while a mirror call is between its read and its write ends the rows that call wrote, and the next call sends their removals first", async () => {
    const s = await stack();
    const plain = readerOf(s);
    const first = await page(plain.reader, b().mac.token, { cursor: null });
    // The second call reads the beliefs, then waits before serve_mirror; Pat's erasure is begun
    // on its own connection and commits after the call's write.
    const racing = readerOf(s, { record: { holdWhen: SERVE } });
    const call = racing.reader.syncMirror(b().mac.token, argsOf({ cursor: first.cursor }));
    await racing.held.reached;
    const erasing = s.admin.erasure.erasePerson(b().pat as EntityId, request());
    racing.held.release();
    const answer = await call;
    await erasing;
    expect(answer.ok).toBe(true);
    const written = answer.ok
      ? MirrorPage.parse(answer.value).entries.filter((entry) => entry.section === "beliefs")
      : [];
    const rows = await rowsOf(s, b().mac.id);
    const pat = rows.filter(
      (row) =>
        row.section === "beliefs" &&
        written.some((entry) => entry.stamp.projection === row.id) &&
        row.tainted_at !== null,
    );
    expect(pat.length).toBeGreaterThan(0);
    for (const row of pat)
      expect(row.tainted_at?.getTime()).toBeGreaterThanOrEqual(row.last_sent_at?.getTime() ?? Infinity);
    const next = await page(plain.reader, b().mac.token, { cursor: answer.ok ? answer.value.cursor : null });
    for (const row of pat) expect(next.removals.map((removal) => removal.projection)).toContain(row.id);
  });

  it("a tainted row is a removal", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const pass = await fullPass(reader, b().mac.token, null);
    const resting = (await liveOf(s, b().mac.id)).filter((row) =>
      row.evidence_ids.includes(b().messages.ownPat.evidenceId),
    );
    expect(resting.length).toBeGreaterThan(0);
    // A deletion at the source ends and taints them in its own transaction.
    const personal = await s.writer().ensureSourceAccount("personal", "google_mail", "own", OWNER_PERSONAL);
    await s.writer().applyDeletion(personal, {
      sourceAccount: personal.id,
      sourceItemId: mailSourceId(b().messages.ownPat.fixture),
      deletedAt: new Date(T).toISOString(),
    } as never);
    const after = await rowsOf(s, b().mac.id);
    for (const row of resting)
      expect(after.find((one) => one.id === row.id)).toMatchObject({
        reason: "withdrawn",
        evidence_ids: [],
        tainted_at: expect.any(Date),
        ended_at: expect.any(Date),
      });
    expect(after.filter((row) => row.tainted_at !== null)).toHaveLength(resting.length);
    // The next call sends the removals first, whatever the pass: here between passes.
    const next = await page(reader, b().mac.token, { cursor: pass.cursor });
    expect(next.removals.map((removal) => removal.projection).sort()).toEqual(resting.map((row) => row.id).sort());
    expect(next.entries).toEqual([]);
  });

  it("the ERASURE_HOOKS row mirror taints every row whose entity_ids hold an erased person", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    await fullPass(reader, b().mac.token, null);
    await fullPass(reader, b().wide.token, null);
    const before = [...(await rowsOf(s, b().mac.id)), ...(await rowsOf(s, b().wide.id))];
    const naming = before.filter((row) => row.entity_ids.includes(b().blake));
    expect(new Set(naming.map((row) => row.section)).size).toBeGreaterThan(1);
    const report = ErasureReport.parse(await s.admin.erasure.erasePerson(b().blake as EntityId, request()));
    const after = [...(await rowsOf(s, b().mac.id)), ...(await rowsOf(s, b().wide.id))];
    for (const row of naming)
      expect(after.find((one) => one.id === row.id)).toMatchObject({
        tainted_at: expect.any(Date),
        ended_at: expect.any(Date),
        evidence_ids: [],
      });
    // And none of the rows that neither name Blake nor rest on Blake's items: Pat's, the project's
    // and the capture items'.
    const untouched = before.filter(
      (row) =>
        row.entity_ids.includes(b().pat) ||
        row.entry_key === b().project ||
        (row.section === "captures" && row.entry_key !== b().captures.meetingPast.id),
    );
    expect(untouched.length).toBeGreaterThan(0);
    for (const row of untouched) expect(after.find((one) => one.id === row.id)?.tainted_at).toBeNull();
    // Linked, one link for each row it reached, and both mirror clients counted.
    const links = (await linksOf(s, report.erasure)).map((link) => link.mirror_entry_id);
    expect(links).toEqual(expect.arrayContaining(naming.map((row) => row.id)));
    for (const id of links) expect(after.find((one) => one.id === id)?.tainted_at).not.toBeNull();
    expect(report.more.mirror).toBe(2);
  });

  it("every entry sent is in the read log with its evidence ids and fact keys, and none is in ledger.exposures", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, b().wide.token, null);
    const logged = await s.sql<{ shown: string[]; fact_key_fps: string[] }>(
      "select shown, fact_key_fps from ledger.read_log where client_id = $1 and tool = 'sync_mirror'",
      [b().wide.id],
    );
    const rows = await liveOf(s, b().wide.id);
    for (const entry of entriesOf(pages)) {
      const row = rows.find((one) => one.id === entry.stamp.projection);
      for (const evidence of row?.evidence_ids ?? [])
        expect(
          logged.some((one) => one.shown.includes(evidence)),
          evidence,
        ).toBe(true);
      if (entry.stamp.fact !== null)
        expect(logged.some((one) => one.fact_key_fps.includes(entry.stamp.fact ?? ""))).toBe(true);
    }
    expect(logged.flatMap((one) => one.shown)).toContain(wk().workWren.evidenceId);
    expect(await count(s, "ledger.exposures", "recipient = $1", [b().wide.id])).toBe(0);
  });

  it("an erasure of an item, and of a person, that reaches a mirror row links it in ledger.erasure_exposures and counts the client in more.mirror, also when the item had left the entry's support", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, b().mac.token, null);
    const fact = fingerprint(s.db.keys, "fact", "gate-owner-blake");
    const belief = (await liveOf(s, b().mac.id)).find(
      (row) => row.section === "beliefs" && row.evidence_ids.includes(b().messages.ownSent.evidenceId),
    );
    expect(belief).toBeDefined();
    // The owner's commitment to Blake comes to rest on another message: a claim of its fact key
    // on Blake's, and the sent message's claim of it taken back by its item's next commit, so the
    // belief computed under `own` rests on Blake's alone.
    const moved = commitmentRecord(
      b().messages.ownBlake,
      b().owner,
      b().blake,
      "gate-owner-blake",
      "canary-gate-what-moved",
      500,
    );
    const kept = (b().records.get("gate-blake-owner") ?? []).filter(
      (record) => record.claim.primaryEvidenceId === b().messages.ownBlake.evidenceId,
    );
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: s.log });
    try {
      expect(await pipeline.commit(batchOf(b().messages.ownBlake.evidenceId, [...kept, moved]))).toBe("committed");
      const sent = b().messages.ownSent.evidenceId;
      const others = [...b().records.values()]
        .flat()
        .filter((record) => record.claim.primaryEvidenceId === sent && record.factKey !== "gate-owner-blake");
      expect(await pipeline.commit(batchOf(sent, others))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    await knownBy(s.db, new Date(T));
    await due(s, b().mac.id);
    await fullPass(reader, b().mac.token, first.cursor);
    const row = (await rowsOf(s, b().mac.id)).find((one) => one.id === belief?.id);
    expect(row?.ended_at).toBeNull();
    expect(row?.evidence_ids).toEqual(
      expect.arrayContaining([b().messages.ownSent.evidenceId, b().messages.ownBlake.evidenceId]),
    );
    expect(
      (await beliefsComputed(s.db, OWN, BELIEF_TYPES, new Date(T).toISOString())).find((one) => one.factKeyFp === fact)
        ?.belief.support,
    ).toEqual([moved.claim.id]);
    // The message it left is erased: the row is reached all the same, linked and counted.
    const report = ErasureReport.parse(
      await s.admin.erasure.eraseItem({ kind: "message", id: b().messages.ownSent.id as MessageId }, request()),
    );
    expect((await linksOf(s, report.erasure)).map((link) => link.mirror_entry_id)).toContain(belief?.id);
    expect(report.more.mirror).toBe(1);
    // A person's erasure is linked to the rows naming them the same way.
    const pat = (await liveOf(s, b().mac.id)).filter((one) => one.entity_ids.includes(b().pat)).map((one) => one.id);
    expect(pat.length).toBeGreaterThan(0);
    const person = ErasureReport.parse(await s.admin.erasure.erasePerson(b().pat as EntityId, request()));
    expect((await linksOf(s, person.erasure)).map((link) => link.mirror_entry_id)).toEqual(expect.arrayContaining(pat));
    expect(person.more.mirror).toBe(1);
  });

  it("a dry run counts and writes nothing", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    await fullPass(reader, b().mac.token, null);
    await fullPass(reader, b().wide.token, null);
    const before = await mirrorState(s);
    const dry = await s.admin.erasure.erasePerson(b().blake as EntityId, { ...request(), dryRun: true });
    expect(dry.more.mirror).toBe(2);
    expect(await mirrorState(s)).toBe(before);
    expect(await count(s, "ledger.mirror_entries", "tainted_at is not null")).toBe(0);
    // The control: the erasure itself counts the same and writes.
    const real = await s.admin.erasure.erasePerson(b().blake as EntityId, request());
    expect(real.more.mirror).toBe(2);
    expect(await mirrorState(s)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// L10, L11, L20: invariant 6, reconcile and forgery
// ---------------------------------------------------------------------------------------------

// A pool whose serve_mirror call carries one entry more than the reader built, and whose errors
// are kept by their SQLSTATE: a forged section row (L20).
function forging(pool: pg.Pool, forged: Record<string, unknown>): { pool: pg.Pool; codes: string[] } {
  const codes: string[] = [];
  const entriesAt = (values: unknown[]): number =>
    values.findIndex((value) => {
      const parsed: unknown = typeof value === "string" && value.startsWith("[") ? JSON.parse(value) : value;
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((one) => typeof one === "object" && one !== null && "key" in one && "token" in one)
      );
    });
  const forge = (values: unknown[]): unknown[] => {
    const at = entriesAt(values);
    if (at < 0) throw new Error("no entries argument to forge");
    const given = values[at];
    const entries = (typeof given === "string" ? JSON.parse(given) : given) as { key: string }[];
    const keys = entries.map((entry) => entry.key);
    const found = values.findIndex((value) => Array.isArray(value) && keys.every((key) => value.includes(key)));
    const out = [...values];
    out[at] = typeof given === "string" ? JSON.stringify([...entries, forged]) : [...entries, forged];
    if (found >= 0) out[found] = [...(values[found] as string[]), forged.key];
    return out;
  };
  const run = (target: pg.PoolClient | pg.Pool, args: unknown[]): unknown => {
    const [text, values] = args as [unknown, unknown];
    const sql = typeof text === "string" ? text : ((text as { text?: string }).text ?? "");
    const given = SERVE(sql) && Array.isArray(values) ? [sql, forge(values)] : args;
    const sent = (target.query as (...a: unknown[]) => Promise<unknown>).apply(target, given);
    return sent.catch((error: unknown) => {
      codes.push((error as { code?: string }).code ?? "");
      throw error;
    });
  };
  const wrapped = new Proxy(pool, {
    get: (target, property) => {
      if (property === "query") return (...args: unknown[]) => run(target, args);
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get: (inner, key) => {
              if (key === "query") return (...args: unknown[]) => run(inner, args);
              const value: unknown = Reflect.get(inner, key, inner);
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(inner) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { pool: wrapped, codes };
}

// The client's id fingerprint of a key, as the store computes it.
const projectionOf = (
  s: Stack,
  client: string,
  audience: readonly string[],
  section: MirrorSection,
  key: string,
): string =>
  `mir_${fingerprint(s.db.keys, "mirror_projection", [client, [...audience].sort().join(","), T1.name, section, key].join("\n")).slice(0, 40)}`;

function commitmentRecord(
  message: Message,
  subject: string,
  counterparty: string,
  key: string,
  what: string,
  n: number,
): ClaimRecord {
  const owner = b().owner;
  const made = claimRecord(message.evidenceId, message.compartment, subject, {
    n,
    factKey: key,
    validFrom: message.sentAt,
    entities: [subject, counterparty].filter((id) => id !== owner),
  });
  return {
    ...made,
    claim: { ...made.claim, content: { ...made.claim.content, fields: { counterparty, what } } },
    subjectKind: subject === owner ? "owner" : "person",
    fieldKinds: { counterparty: "entity", what: "text" },
  } as unknown as ClaimRecord;
}

describe("invariant 6, reconcile and forgery", () => {
  it("the own-only client's pages are byte for byte those of a store without employer:example rows, hash included, and the wider client's differ", async () => {
    const without = await stack("base");
    const withRows = await stack("full");
    const plain = await fullPass(readerOf(without).reader, b().mac.token, null);
    const hidden = await fullPass(readerOf(withRows).reader, b().mac.token, null);
    expect(masked(hidden.pages)).toEqual(masked(plain.pages));
    for (const id of [wk().wren, wk().workWren.evidenceId, wk().workPast, wk().project, wk().hidden.id])
      expect(JSON.stringify(hidden.pages)).not.toContain(id);
    // The control: the wider client's pages do differ between the two stores.
    const widePlain = await fullPass(readerOf(without).reader, b().wide.token, null);
    const wideHidden = await fullPass(readerOf(withRows).reader, b().wide.token, null);
    expect(masked(wideHidden.pages)).not.toEqual(masked(widePlain.pages));
    for (const id of [wk().wren, wk().workPast, wk().hidden.id]) expect(JSON.stringify(wideHidden.pages)).toContain(id);
  });

  it("after a declassification is revoked, a veto, a hold and an entity merge, a completed pass sends a removal for every entry the client no longer sees, and nothing else changes", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const client = b().cleared;
    // The work commitment is declassified before the first pass: the client cleared for
    // `declassified` may see it.
    const workClaim =
      (
        await s.sql<{ id: string }>("select id from knowledge.claims where evidence_id = $1", [
          wk().workWren.evidenceId,
        ])
      )[0]?.id ?? "";
    const declassification = await s.admin.releases.declassify(workClaim as never, request());
    const first = await fullPass(reader, client.token, null);
    const settled = await page(reader, client.token, { cursor: first.cursor });
    const held = await keysOf(s, client.id, [first.pages, [settled]]);
    // The four changes, none of which touches a row's time.
    await s.admin.releases.revokeDeclassified(declassification as RulingId, request());
    const patClaim =
      (
        await s.sql<{ id: string }>("select id from knowledge.claims where evidence_id = $1", [
          b().messages.ownPat.evidenceId,
        ])
      )[0]?.id ?? "";
    await s.admin.facts.vetoFact(patClaim as never, request());
    await s.sql("update knowledge.messages set held = true where evidence_id = $1", [b().messages.ownSent.evidenceId]);
    await s.admin.identity.linkPeople(b().blake as EntityId, b().pat as EntityId, "same", request());
    await due(s, client.id);
    const second = await fullPass(reader, client.token, settled.cursor);
    const drained = await page(reader, client.token, { cursor: second.cursor });
    // What a fresh device of the same clearance sees now is what the Mac holds after the pass.
    const fresh = await device(s.admin, s.db, "mac-fresh", CLEARED);
    const truth = await keysOf(s, fresh.id, [(await fullPass(reader, fresh.token, null)).pages]);
    const mirror = await keysOf(s, client.id, [first.pages, [settled], second.pages, [drained]]);
    expect(mirror).toEqual(truth);
    // A removal for every entry it no longer sees, and for nothing it still sees.
    const gone = held.filter((key) => !truth.includes(key));
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.some((key) => key.startsWith(`facts/${b().messages.ownSent.evidenceId}:`))).toBe(true);
    // A veto closes a belief computed at read, which the client still sees: its entry is served again,
    // closed, under its id, and no belief entry is removed.
    expect(gone.some((key) => key.startsWith("beliefs/"))).toBe(false);
    const vetoed = fingerprint(s.db.keys, "fact", "gate-pat-owner");
    expect(inSection([...second.pages, drained], "beliefs").find((entry) => entry.stamp.fact === vetoed)).toMatchObject(
      { belief: { status: "closed" } },
    );
    const rows = await rowsOf(s, client.id);
    const removed = removedOf([...second.pages, drained]).map((removal) => {
      const row = rows.find((one) => one.id === removal.projection);
      return `${row?.section}/${row?.entry_key}`;
    });
    expect([...removed].sort()).toEqual(gone);
    for (const removal of removedOf([...second.pages, drained])) expect(removal.reason).toBe("withdrawn");
    // Every entry still seen keeps its id: none is served under a new one.
    expect(idsOf(second.pages).filter((id) => !idsOf([...first.pages, settled]).includes(id))).toEqual([]);
  });

  it("a forged section row naming a belief of another audience, or a claim outside the clearance, fails the call with 42501 and writes nothing", async () => {
    const s = await stack();
    const plain = readerOf(s);
    // A belief computed for the wide clearance, under `own`: an entry names its support, and this one's
    // is the work claim, outside the client's clearance.
    const workFact = fingerprint(s.db.keys, "fact", "gate-wren-owner");
    const [work] = await s.sql<{ id: string }>("select id from knowledge.claims where fact_key_fp = $1 order by id", [
      workFact,
    ]);
    const wideBelief = beliefIdOf(s.db.keys, workFact, BOTH);
    const forgedBelief = {
      id: projectionOf(s, b().mac.id, OWN, "beliefs", wideBelief),
      key: wideBelief,
      fact_key_fp: workFact,
      evidence_ids: [wk().workWren.evidenceId],
      entity_ids: [wk().wren],
      anchor_ids: [],
      compartments: OWN,
      state: sha256Hex("gate forged belief state"),
      token: sha256Hex("gate forged belief token"),
      support_ids: [work?.id ?? ""],
    };
    const forgedClaim = {
      id: projectionOf(s, b().mac.id, OWN, "facts", `${wk().workWren.evidenceId}:${workFact}`),
      key: `${wk().workWren.evidenceId}:${workFact}`,
      fact_key_fp: workFact,
      evidence_ids: [wk().workWren.evidenceId],
      entity_ids: [wk().wren],
      anchor_ids: [],
      compartments: ["employer:example"],
      state: sha256Hex("gate forged claim state"),
      token: sha256Hex("gate forged claim token"),
    };
    const entities = await page(plain.reader, b().mac.token, { cursor: null });
    // The beliefs call, with the forged belief: 42501, unavailable, nothing written.
    const beliefs = forging(s.readerPool, forgedBelief);
    const before = await mirrorState(s);
    expect(
      await readerOf(s, { pool: beliefs.pool }).reader.syncMirror(b().mac.token, argsOf({ cursor: entities.cursor })),
    ).toEqual({ ok: false, code: "unavailable" });
    expect(beliefs.codes).toContain("42501");
    expect(await mirrorState(s)).toBe(before);
    // The control: the same call unforged.
    const served = await page(plain.reader, b().mac.token, { cursor: entities.cursor });
    expect(served.entries.some((entry) => entry.section === "beliefs")).toBe(true);
    // The facts call, with the forged claim: the same.
    const claims = forging(s.readerPool, forgedClaim);
    const later = await mirrorState(s);
    expect(
      await readerOf(s, { pool: claims.pool }).reader.syncMirror(b().mac.token, argsOf({ cursor: served.cursor })),
    ).toEqual({ ok: false, code: "unavailable" });
    expect(claims.codes).toContain("42501");
    expect(await mirrorState(s)).toBe(later);
    expect(
      (await page(plain.reader, b().mac.token, { cursor: served.cursor })).entries.some(
        (entry) => entry.section === "facts",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// L33: the captures section and the anchors
// ---------------------------------------------------------------------------------------------

describe("the captures section and a project's anchors", () => {
  it("the captures section lists exactly the visible meetings, and the visible moments of the last 90 days, each with its cap_ id, key, kind, times and event and nothing else", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const { pages } = await fullPass(reader, b().mac.token, null);
    const served = inSection(pages, "captures").map((entry) => (entry.section === "captures" ? entry.capture : null));
    const expected = (capture: Capture, kind: MirrorCapture["kind"], from: Date, to: Date, event: string | null) => ({
      capture: capture.id,
      key: capture.key,
      revision: 0,
      kind,
      startedAt: from.getTime(),
      endedAt: to.getTime(),
      event,
    });
    const { meetingPast, meetingOld, momentRecent } = b().captures;
    // In cap_ id order; the moment 100 days old and the work meeting are not served.
    expect(
      served.map((one) =>
        one === null
          ? null
          : {
              ...one,
              startedAt: Date.parse(one.startedAt),
              endedAt: one.endedAt === null ? null : Date.parse(one.endedAt),
            },
      ),
    ).toEqual(
      [
        expected(meetingPast, "meeting", at(-2), at(-2, 1), b().events.ownPast),
        expected(meetingOld, "meeting", at(-200), at(-200, 1), null),
        expected(momentRecent, "moment", at(-1), at(-1, 0.1), null),
      ].sort((x, y) => (x.capture < y.capture ? -1 : 1)),
    );
    // Nothing else: the strict MirrorCapture has no other field, and no title is sent.
    for (const one of served)
      expect(Object.keys(one ?? {}).sort()).toEqual([
        "capture",
        "endedAt",
        "event",
        "key",
        "kind",
        "revision",
        "startedAt",
      ]);
    expect(JSON.stringify(pages)).not.toContain("canary-gate-capture-title");
    // The control: the wider client also sees the work meeting.
    const wide = await fullPass(reader, b().wide.token, null);
    expect(
      inSection(wide.pages, "captures").map((entry) => (entry.section === "captures" ? entry.capture.capture : "")),
    ).toContain(wk().hidden.id);
  });

  it("a project's entry carries its live device anchors at their normal forms and no thread anchor, and a lifted anchor re-serves it", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    const first = await fullPass(reader, b().mac.token, null);
    const project = inSection(first.pages, "entities").find(
      (entry) => entry.section === "entities" && entry.entity.id === b().project,
    );
    const anchors = project?.section === "entities" ? project.entity.anchors : undefined;
    expect(anchors).toEqual(
      [
        { id: b().anchors.app, kind: "app", value: { untrusted: "test.example.notes" } },
        { id: b().anchors.host, kind: "host", value: { untrusted: "plans.example.com" } },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(JSON.stringify(first.pages)).not.toContain(b().anchors.thread);
    // Lifted, the host anchor leaves the entry, which is served again under the same id.
    const between = await page(reader, b().mac.token, { cursor: first.cursor });
    expect(await s.admin.projects.unanchor(b().anchors.host, request())).toBe(true);
    await due(s, b().mac.id);
    const second = await fullPass(reader, b().mac.token, between.cursor);
    const again = inSection(second.pages, "entities").find(
      (entry) => entry.stamp.projection === project?.stamp.projection,
    );
    expect(again?.section === "entities" ? again.entity.anchors : undefined).toEqual([
      { id: b().anchors.app, kind: "app", value: { untrusted: "test.example.notes" } },
    ]);
    expect(removedOf(second.pages)).toEqual([]);
  });

  it("an own-only client's pages are byte for byte those of a store without employer:example rows and projects, hash included", async () => {
    // The base world, and the base world with a work project, its anchor and a work meeting.
    const without = await stack("base");
    const withProject = await stack("base");
    const added = await addHiddenProject(withProject.db, null);
    const plain = await fullPass(readerOf(without).reader, b().mac.token, null);
    const hidden = await fullPass(readerOf(withProject).reader, b().mac.token, null);
    expect(masked(hidden.pages)).toEqual(masked(plain.pages));
    for (const id of [added.project, added.anchor, added.hidden.id])
      expect(JSON.stringify(hidden.pages)).not.toContain(id);
    // The control: the wider client sees them.
    const wide = await fullPass(readerOf(withProject).reader, b().wide.token, null);
    for (const id of [added.project, added.anchor, added.hidden.id]) expect(JSON.stringify(wide.pages)).toContain(id);
  });

  it("an erasure removals a captures entry before any entry", async () => {
    const s = await stack();
    const { reader } = readerOf(s);
    await fullPass(reader, b().mac.token, null);
    const moment = (await liveOf(s, b().mac.id)).find((row) => row.entry_key === b().captures.momentRecent.id);
    expect(moment).toBeDefined();
    // After a wipe, mid-pass: the next page's removals hold the entry, its entries come after.
    const wiped = await page(reader, b().mac.token, { cursor: null });
    await s.admin.erasure.eraseItem({ kind: "capture", id: b().captures.momentRecent.id as CaptureId }, request());
    const next = await page(reader, b().mac.token, { cursor: wiped.cursor });
    expect(next.removals.map((removal) => removal.projection)).toEqual([moment?.id]);
    expect(next.captureErased).toEqual([b().captures.momentRecent.key]);
    expect(next.entries.length).toBeGreaterThan(0);
    expect(Object.keys(next).indexOf("removals")).toBeLessThan(Object.keys(next).indexOf("entries"));
  });
});
