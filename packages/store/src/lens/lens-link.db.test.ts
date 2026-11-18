import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId } from "@intelligence/contracts";
import {
  type CaptureItem,
  type CardId,
  type ClaimRecord,
  type EntityId,
  type LinkContext,
  type MeetingItem,
  type MessageId,
  MIRROR_QUOTA,
  MirrorPage,
  type MomentItem,
  QUOTA_DEFAULTS,
  SelfView,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { meetingText } from "@intelligence/personal-core/lens";
import { fakeLens } from "@intelligence/personal-core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealRow } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { createReader, type Reader } from "../read/read.ts";
import { asWords } from "../test-support/card-lines.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one, session } from "../test-support/connections.ts";
import { copiesOf, createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord, rowsOf, stored } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// The store's side of the link step. `linkContext` is called through createPipeline as pi_pipeline;
// the link claims are committed through the Pipeline as the lanes would hand them over, written out
// by hand (nothing of @intelligence/personal-extract is imported); the owner reads and decides the
// card as pi_admin; clients read through the Reader. The rule itself is
// packages/extract/src/link.test.ts's and the lanes are apps/pi/src/intake/lens-link.db.test.ts's.
//
// One world, built once and copied for each test (copiesOf): the owner's two labels, one accepted
// work event, a device registered by hand, the world's scope and two rules of these tests; five
// capture items pushed through Reader.pushCapture and taken by Writer.takeCapture (an own meeting
// on Heron's app, an own meeting no anchor matches, a meeting linked to the work event and so
// labelled {employer:example, own}, an own moment under Heron's URL prefix and one under none);
// a stored message; and four projects: Heron Survey (own) with an app anchor, a URL prefix, a
// thread anchor and a lifted host, Kestrel (own) with none, Wharf Ledger (employer:example) with
// an app anchor, and a closed project with a host. Reserved domains, synthetic names.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_self", "search", "get_entity", "find_facts", "build_context_pack", "get_commitments"];
const VIEWS = ["self", "people", "work"];

const lens = fakeLens({ now: new Date(T - 3 * DAY) });
const meetRule = lens.scope.find(
  (rule) => rule.match === "bundle" && rule.compartment === "own" && rule.kinds.includes("meeting"),
);
if (meetRule === undefined) throw new Error("the world's scope has no own meeting app");
const MEET = { bundle: meetRule.value, name: "Meet" };
const HERON_APP = { bundle: "test.example.heronapp", name: "Heron" };
const READER = { bundle: "test.example.linkreader", name: "Reader" };
const DEVON = { name: "Devon Marsh", address: "devon.marsh@example.org" };

let keys = 0;
const keyOf = <K extends "meeting" | "moment">(kind: K): `${K}:${string}` =>
  `${kind}:01JQ1NKS${String((keys += 1)).padStart(18, "0")}`;
const meeting = (start: number, over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(start),
  endedAt: local(start + 30 * MINUTE),
  app: MEET,
  title: "Catch-up",
  consent: true,
  mode: "call",
  speakers: [{ label: "S1", owner: true, mention: { address: OWNER.personal } }],
  segments: [{ speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "Shall we start?" }],
  ...over,
});
const moment = (start: number, thread: string, url: string): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(start),
  endedAt: local(start + 5 * MINUTE),
  app: READER,
  url,
  entity: "doc",
  thread,
  participants: [],
  text: "The plan, second draft.",
  read: "ax",
});

const ITEMS = {
  // Heron's app: its anchor matches.
  OWN_MTG: meeting(-40 * HOUR, { app: HERON_APP, title: "Heron Survey kickoff" }),
  // No anchor matches; its titles name Kestrel.
  UNMATCHED: meeting(-39 * HOUR, {
    title: "Kestrel review",
    calendar: {
      start: local(-39 * HOUR),
      end: local(-39 * HOUR + 30 * MINUTE),
      title: "Kestrel review",
      attendees: [],
    },
  }),
  // Linked to the work event, so labelled {employer:example, own}.
  LINKED: meeting(-45 * HOUR + 5 * MINUTE, {
    title: "Rota review",
    endedAt: local(-44 * HOUR),
    speakers: [
      { label: "S1", owner: true, mention: { address: OWNER.work } },
      { label: "S2", owner: false, mention: DEVON },
    ],
    segments: [
      { speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: "Can you take the weekend slots?" },
      { speaker: "S1", fromMs: 20_000, toMs: 40_000, channel: "input", text: "I will send the rota by Friday." },
    ],
    calendar: { start: local(-45 * HOUR), end: local(-44 * HOUR), title: "Rota review", attendees: [DEVON] },
  }),
  MOM: moment(-38 * HOUR, "heron", "https://wiki.example.org/teams/heron/notes"),
  MOM_NONE: moment(-37 * HOUR, "other", "https://wiki.example.org/other/page"),
};
type Name = keyof typeof ITEMS;
const NAMES = Object.keys(ITEMS) as Name[];

const LINKED_EVENT = event({
  event: {
    id: "evlenslink00001",
    status: "confirmed",
    etag: '"etag-evlenslink00001"',
    updated: utc(-3 * DAY),
    summary: "Rota review",
    start: { dateTime: utc(-45 * HOUR) },
    end: { dateTime: utc(-44 * HOUR) },
    organizer: { email: DEVON.address },
    attendees: [
      { email: OWNER.work, self: true, responseStatus: "accepted" },
      { email: DEVON.address, displayName: DEVON.name, responseStatus: "accepted" },
    ],
  },
  title: "Rota review",
  startsAt: utc(-45 * HOUR),
  endsAt: utc(-44 * HOUR),
  allDay: false,
});

type Built = {
  accounts: Accounts;
  owner: string;
  evidence: Record<Name, EvidenceId>;
  capture: Record<Name, string>;
  projects: { heron: EntityId; kestrel: EntityId; wharf: EntityId; closed: EntityId };
  anchors: { app: string; url: string; thread: string; lifted: string; wharf: string; closed: string };
  message: EvidenceId;
  captureToken: string;
  mirrorToken: string;
  clients: { wide: Client; own: Client };
  eventId: string;
};
let built: Built | undefined;
const b = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};
const request = () => ({ requestId: `req-lens-link-${randomBytes(6).toString("hex")}` });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);

// A device as `pi lens add mac` makes it, by hand, its mirror cleared for both labels.
async function addDevice(db: TestDatabase): Promise<{ capture: string; mirror: string }> {
  const capture = { id: testId("cli"), token: `pit_test-link-capture-${randomBytes(8).toString("hex")}` };
  const mirror = { id: testId("cli"), token: `pit_test-link-mirror-${randomBytes(8).toString("hex")}` };
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query(insertClient, [
      capture.id,
      "mac-capture",
      sha256Hex(capture.token),
      ["own"],
      ["self"],
      ["push_capture"],
      "device",
      ...quota(QUOTA_DEFAULTS.device),
    ]);
    await query(insertClient, [
      mirror.id,
      "mac",
      sha256Hex(mirror.token),
      WIDE,
      VIEWS,
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      "mac",
      capture.id,
      mirror.id,
    ]);
    for (const [connector, kind] of [
      ["lens_meetings", "transcript"],
      ["lens_activity", "screen_activity"],
      ["lens_blocks", "time_block"],
    ] as const) {
      await query(
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
        [testId("acc"), connector, kind],
      );
    }
    await query("commit");
  });
  return { capture: capture.token, mirror: mirror.token };
}

async function insertScope(
  db: TestDatabase,
  rule: { match: "bundle" | "host"; value: string; account?: string; compartment: string; kinds: string[] },
): Promise<void> {
  const id = testId("csr");
  const sealed = (column: string, value: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      rule.match,
      fingerprint(db.keys, "capture_scope", rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : fingerprint(db.keys, "capture_scope", rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
    ],
  );
}

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  try {
    const accounts = await connect(writer);
    const tokens = await addDevice(db);
    for (const rule of lens.scope) await insertScope(db, rule);
    await insertScope(db, { match: "bundle", value: HERON_APP.bundle, compartment: "own", kinds: ["meeting"] });
    await insertScope(db, { match: "bundle", value: READER.bundle, compartment: "own", kinds: ["moment"] });
    expect(await ingestEvent(writer, accounts.workCalendar, LINKED_EVENT)).toBe("stored");
    const message = (await stored(writer, accounts.personalMail, MAIL.solo)) as EvidenceId;
    const messageId = one(
      await admin<{ id: MessageId }>(db, "select id from knowledge.messages where evidence_id = $1", [message]),
    ).id;

    const projects = {
      heron: await owner.projects.add("Heron Survey", request()),
      kestrel: await owner.projects.add("Kestrel", request()),
      wharf: await owner.projects.add("Wharf Ledger", { compartment: "employer:example", ...request() }),
      closed: await owner.projects.add("Osprey Survey", request()),
    };
    const anchors = {
      app: await owner.projects.anchor(projects.heron, { kind: "app", value: HERON_APP.bundle }, request()),
      url: await owner.projects.anchor(
        projects.heron,
        { kind: "url_prefix", value: "https://wiki.example.org/teams/heron" },
        request(),
      ),
      thread: await owner.projects.anchor(projects.heron, messageId, request()),
      lifted: await owner.projects.anchor(projects.heron, { kind: "host", value: "lifted.example.org" }, request()),
      wharf: await owner.projects.anchor(projects.wharf, { kind: "app", value: "test.example.wharfapp" }, request()),
      closed: await owner.projects.anchor(projects.closed, { kind: "app", value: "test.example.closedapp" }, request()),
    };
    expect(await owner.projects.unanchor(anchors.lifted, request())).toBe(true);
    expect(await owner.projects.close(projects.closed, request())).toBe(true);

    const items = NAMES.map((name) => ITEMS[name]) as CaptureItem[];
    const answer = await reader.pushCapture(tokens.capture, { batch: "lens-link-store-0001", items });
    expect(answer).toEqual({
      ok: true,
      value: { items: items.map((item) => ({ key: item.key, outcome: "accepted" })) },
    });
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const evidence = {} as Record<Name, EvidenceId>;
    const capture = {} as Record<Name, string>;
    for (const name of NAMES) {
      const row = one(
        await admin<{ id: string; evidence_id: EvidenceId; compartments: string[] }>(
          db,
          "select id, evidence_id, compartments from knowledge.captures where capture_key = $1",
          [ITEMS[name].key],
        ),
      );
      expect(row.compartments, name).toEqual(name === "LINKED" ? WIDE : ["own"]);
      evidence[name] = row.evidence_id;
      capture[name] = row.id;
    }
    const eventId = one(
      await admin<{ event_id: string }>(db, "select event_id from knowledge.captures where capture_key = $1", [
        ITEMS.LINKED.key,
      ]),
    ).event_id;
    const ownerEntity = one(
      await admin<{ id: string }>(db, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    const clients = {
      wide: await insertReader({ db } as never, "link-wide", WIDE, { tools: TOOLS, views: VIEWS }),
      own: await insertReader({ db } as never, "link-own", ["own"], { tools: TOOLS, views: VIEWS }),
    };
    built = {
      accounts,
      owner: ownerEntity,
      evidence,
      capture,
      projects,
      anchors,
      message,
      captureToken: tokens.capture,
      mirrorToken: tokens.mirror,
      clients,
      eventId,
    };
  } finally {
    await owner.close();
    await reader.close();
    await writer.close();
  }
  return db;
});

afterAll(async () => {
  await world.drop();
}, DB_TEST_TIMEOUT);

type Copy = { db: TestDatabase; pipeline: Pipeline; reader: Reader; owner: Admin; writer: Writer };
async function withWorld(fn: (copy: Copy) => Promise<void>): Promise<void> {
  const db = await world.copy();
  const log = eventLogger();
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log, now: () => new Date(T) });
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  try {
    await fn({ db, pipeline, reader, owner, writer });
  } finally {
    await writer.close();
    await owner.close();
    await reader.close();
    await pipeline.close();
    await db.drop();
  }
}

const contextOf = async (copy: Copy, name: Name): Promise<LinkContext> => {
  const context = await copy.pipeline.linkContext(b().evidence[name]);
  if (context === null) throw new Error(`no link context for ${name}`);
  return context;
};
// A plan of the owner's from a meeting's first segment, as the meeting lane would commit one: the
// control that the item's own facts are served where its link is not.
function planOf(name: "UNMATCHED" | "LINKED", label: string[]): ClaimRecord {
  const made = claimRecord(b().evidence[name], label, b().owner, { n: 7, type: "plan", basis: "third_party" });
  const cited = meetingText(ITEMS[name]).spans[0];
  if (cited === undefined) throw new Error("no first segment");
  // A plan's fields as FactView holds them: `what`, and the required `when`.
  const content = {
    ...made.claim.content,
    fields: { ...made.claim.content.fields, when: ITEMS[name].startedAt.slice(0, 10) },
  };
  return {
    ...made,
    claim: {
      ...made.claim,
      content,
      evidence: [{ evidenceId: b().evidence[name], span: `seg:${cited.from}-${cited.to}` }],
    },
    fieldKinds: { ...made.fieldKinds, when: "date" },
    lane: "meeting",
  } as unknown as ClaimRecord;
}
const candidateOf = (context: LinkContext, project: string) =>
  context.candidates.find((one_) => one_.project === project);

// A link claim as a lane hands it over: origin source, the item's label, subject the project, valid
// from the item's start, its fact key the type, the project and the capture key, and for an anchor
// link the field `anchor`. `generation` tells a raised generation's claim apart.
function linkRecord(
  name: Name,
  label: string[],
  project: string,
  options: { anchor?: string; generation?: number; evidence?: string } = {},
): ClaimRecord {
  const item = ITEMS[name];
  const type = options.anchor === undefined ? "capture.project" : "capture.anchor";
  const evidence = options.evidence ?? b().evidence[name];
  const generation = options.generation ?? 1;
  const claim = {
    id: sha256(`link ${evidence} ${type} ${generation}`),
    content: { type, subject: project, fields: options.anchor === undefined ? {} : { anchor: options.anchor } },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: new Date(Date.parse(item.kind === "meeting" ? item.startedAt : item.observedAt)).toISOString(),
    evidence: [{ evidenceId: evidence, span: "capture:link" }],
    primaryEvidenceId: evidence,
    label: { compartments: label, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "lens-link-1",
    extractorGeneration: generation,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "project",
    disclosure: [],
    factKey: `${type} ${project} ${item.key}`,
    lane: item.kind,
    fieldKinds: options.anchor === undefined ? {} : { anchor: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}
const commitOf = (
  copy: Copy,
  name: Name,
  claims: ClaimRecord[],
  options: { generation?: number; evidence?: string } = {},
) =>
  copy.pipeline.commit(
    batchOf(options.evidence ?? b().evidence[name], claims, {
      lane: ITEMS[name].kind,
      status: "skipped",
      code: "not_extracted",
      generation: options.generation ?? 1,
    } as never),
  );

type CardRow = {
  id: CardId;
  request_id: string;
  target_kind: string;
  target_id: string;
  created_by: string;
  compartments: string[];
};
const cards = (db: TestDatabase) =>
  rowsOf<CardRow>(
    db,
    "select id, request_id, target_kind, target_id, created_by, compartments from ledger.cards where kind = 'agent_claim' order by created_at, id",
  );
const titleKeyOf = (db: TestDatabase, factKey: string): string =>
  fingerprint(db.keys, "agent_claim", `capture\n${fingerprint(db.keys, "fact", factKey)}`);
const heldBack = async (copy: Copy, claimId: string): Promise<boolean> =>
  !(await copy.pipeline.beliefClaims()).some((group) => group.claims.some((one_) => one_.claim.id === claimId));
const decide = (copy: Copy, card: CardId, answer: "confirm" | "reject") =>
  copy.owner.cards.decide({ cards: [card], answer, requestId: testId("req").slice(4) });

describe("linkContext", { timeout: DB_TEST_TIMEOUT }, () => {
  it("Candidates and the label. An item's candidate projects are the active projects whose compartments are within the item's compartments, each with its live device anchors", () =>
    withWorld(async (copy) => {
      const own = await contextOf(copy, "OWN_MTG");
      expect(own.compartments).toEqual(["own"]);
      expect(own.candidates.map((one_) => one_.project).sort()).toEqual(
        [b().projects.heron, b().projects.kestrel].sort(),
      );
      // Heron's live device anchors: not its thread anchor, not its lifted host.
      expect(
        candidateOf(own, b().projects.heron)
          ?.anchors.map((anchor) => [anchor.id, anchor.kind])
          .sort(),
      ).toEqual(
        [
          [b().anchors.app, "app"],
          [b().anchors.url, "url_prefix"],
        ].sort(),
      );
      expect(candidateOf(own, b().projects.kestrel)?.anchors).toEqual([]);
      // Never the closed project, and never the employer:example one for an own item.
      for (const name of ["OWN_MTG", "UNMATCHED", "MOM", "MOM_NONE"] as const) {
        const projects = (await contextOf(copy, name)).candidates.map((one_) => one_.project);
        expect(projects, name).not.toContain(b().projects.closed);
        expect(projects, name).not.toContain(b().projects.wharf);
      }
      // The control: an item labelled {employer:example, own} may be linked to either's.
      const linked = await contextOf(copy, "LINKED");
      expect(linked.compartments).toEqual(WIDE);
      expect(linked.candidates.map((one_) => one_.project).sort()).toEqual(
        [b().projects.heron, b().projects.kestrel, b().projects.wharf].sort(),
      );
      expect(candidateOf(linked, b().projects.wharf)?.anchors.map((anchor) => anchor.id)).toEqual([b().anchors.wharf]);
    }));

  it("Where it runs: the link step. linkContext answers, as pi_pipeline in one read, the item's capture row and its candidates' anchors, opening a value only for an anchor that matches and the names only for a meeting none matches", () =>
    withWorld(async (copy) => {
      for (const name of NAMES) {
        const context = await contextOf(copy, name);
        const row = one(
          await admin<{
            kind: string;
            capture_key: string;
            started_at: Date;
            compartments: string[];
            match_fps: string[];
          }>(
            copy.db,
            "select kind, capture_key, started_at, compartments, match_fps from knowledge.captures where capture_key = $1",
            [ITEMS[name].key],
          ),
        );
        expect(
          {
            kind: context.kind,
            captureKey: context.captureKey,
            startedAt: Date.parse(context.startedAt),
            compartments: context.compartments,
          },
          name,
        ).toEqual({
          kind: row.kind,
          captureKey: row.capture_key,
          startedAt: row.started_at.getTime(),
          compartments: [...row.compartments].sort(),
        });
        expect([...context.matchFps].sort(), name).toEqual([...row.match_fps].sort());
        // Each anchor's fingerprint is its row's, in clear.
        for (const candidate of context.candidates) {
          for (const anchor of candidate.anchors) {
            const stored = one(
              await admin<{ anchor_fp: string; project_id: string }>(
                copy.db,
                "select anchor_fp, project_id from knowledge.project_anchors where id = $1",
                [anchor.id],
              ),
            );
            expect(anchor.anchorFp, `${name} ${anchor.id}`).toBe(stored.anchor_fp);
            expect(stored.project_id).toBe(candidate.project);
            expect(anchor.value === null, `${name} ${anchor.id}`).toBe(!context.matchFps.includes(anchor.anchorFp));
          }
        }
      }
      // The matching anchor's normal form is opened, and no name: Heron's app on the own meeting.
      const own = await contextOf(copy, "OWN_MTG");
      expect(candidateOf(own, b().projects.heron)?.anchors.find((anchor) => anchor.id === b().anchors.app)?.value).toBe(
        HERON_APP.bundle,
      );
      expect(
        candidateOf(own, b().projects.heron)?.anchors.find((anchor) => anchor.id === b().anchors.url)?.value,
      ).toBeNull();
      expect(own.candidates.map((one_) => one_.name)).toEqual([null, null]);
      const moment = await contextOf(copy, "MOM");
      expect(
        candidateOf(moment, b().projects.heron)?.anchors.find((anchor) => anchor.id === b().anchors.url)?.value,
      ).toBe("wiki.example.org/teams/heron");
      // A meeting none of whose candidates' anchors match: every name opened, no value.
      const unmatched = await contextOf(copy, "UNMATCHED");
      expect(Object.fromEntries(unmatched.candidates.map((one_) => [one_.project, one_.name]))).toEqual({
        [b().projects.heron]: "Heron Survey",
        [b().projects.kestrel]: "Kestrel",
      });
      expect(unmatched.candidates.flatMap((one_) => one_.anchors).every((anchor) => anchor.value === null)).toBe(true);
      // A moment none matches: no name, a moment being never linked by title.
      expect((await contextOf(copy, "MOM_NONE")).candidates.map((one_) => one_.name)).toEqual([null, null]);
      // Null when the item is gone, or is no capture item.
      expect(await copy.pipeline.linkContext(`${"0".repeat(63)}1` as EvidenceId)).toBeNull();
      expect(await copy.pipeline.linkContext(b().message)).toBeNull();
      await copy.owner.erasure.eraseItem({ kind: "capture", id: b().capture.MOM_NONE as never }, request());
      expect(await copy.pipeline.linkContext(b().evidence.MOM_NONE)).toBeNull();
      // The control: the item beside it still answers.
      expect(await copy.pipeline.linkContext(b().evidence.MOM)).not.toBeNull();
    }));

  it("Invariant 6. The link step reads the item and its candidates alone: an anchor of a project outside the item's label that also matches it changes nothing", async () => {
    const plain = await world.copy();
    const hidden = await world.copy();
    const read = async (db: TestDatabase, names: Name[]) => {
      const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        return await Promise.all(names.map((name) => pipeline.linkContext(b().evidence[name])));
      } finally {
        await pipeline.close();
      }
    };
    try {
      // Wharf Ledger's anchors on the own meetings' app and on the own moment's URL.
      const owner = createAdmin({
        url: hidden.urls.admin,
        keys: hidden.keys,
        log: eventLogger(),
        journal: journalPath(hidden.keyFile),
      });
      try {
        await owner.projects.anchor(b().projects.wharf, { kind: "app", value: MEET.bundle }, request());
        await owner.projects.anchor(
          b().projects.wharf,
          { kind: "url_prefix", value: "https://wiki.example.org/teams" },
          request(),
        );
      } finally {
        await owner.close();
      }
      const own: Name[] = ["UNMATCHED", "MOM", "OWN_MTG"];
      expect(await read(hidden, own)).toEqual(await read(plain, own));
      // The names of an own meeting no own anchor matches are still opened: the hidden match blocks nothing.
      const [unmatched] = await read(hidden, ["UNMATCHED"]);
      expect(unmatched?.candidates.every((one_) => one_.name !== null)).toBe(true);
      // The control: the meeting under both labels sees Wharf Ledger's matching anchor.
      const [linkedPlain] = await read(plain, ["LINKED"]);
      const [linkedHidden] = await read(hidden, ["LINKED"]);
      expect(linkedHidden).not.toEqual(linkedPlain);
      expect(
        linkedHidden?.candidates
          .find((one_) => one_.project === b().projects.wharf)
          ?.anchors.some((anchor) => anchor.value === MEET.bundle),
      ).toBe(true);
    } finally {
      await hidden.drop();
      await plain.drop();
    }
  });
});

describe("the title card and the hold", { timeout: DB_TEST_TIMEOUT }, () => {
  it("Claims, beliefs and the owner's confirmation. A title link raises one agent_claim card keyed by capture and its fact key, and an anchor link raises none", () =>
    withWorld(async (copy) => {
      const anchored = linkRecord("OWN_MTG", ["own"], b().projects.heron, { anchor: b().anchors.app });
      expect(await commitOf(copy, "OWN_MTG", [anchored])).toBe("committed");
      expect(await cards(copy.db)).toEqual([]);
      const titled = linkRecord("UNMATCHED", ["own"], b().projects.kestrel);
      expect(await commitOf(copy, "UNMATCHED", [titled])).toBe("committed");
      const [card, ...more] = await cards(copy.db);
      expect(more).toEqual([]);
      expect(card).toMatchObject({
        request_id: titleKeyOf(copy.db, titled.factKey),
        target_kind: "claim",
        created_by: "system:extract",
        compartments: ["own"],
      });
      // It cites nothing: ledger.add_basis resolves no capture item.
      expect(
        await rowsOf(copy.db, "select ref_id from ledger.basis where row_kind = 'card' and row_id = $1", [card?.id]),
      ).toEqual([]);
      const [first] = await rowsOf<{ event: string; by: string }>(
        copy.db,
        "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id limit 1",
        [card?.id],
      );
      expect(first).toEqual({ event: "pending", by: "system:extract" });
    }));

  it("the card shows the meeting's title and start as source lines and the project's name as a code line", () =>
    withWorld(async (copy) => {
      await commitOf(copy, "UNMATCHED", [linkRecord("UNMATCHED", ["own"], b().projects.kestrel)]);
      const [card] = await cards(copy.db);
      const lines = (await copy.owner.cards.card(card?.id as CardId))?.lines ?? [];
      const start = ITEMS.UNMATCHED.startedAt;
      const starts = [
        start,
        new Date(Date.parse(start)).toISOString(),
        new Date(Date.parse(start)).toISOString().replace(".000Z", "Z"),
      ];
      expect(lines.some((line) => line.from === "source" && line.text.includes("Kestrel review"))).toBe(true);
      expect(lines.some((line) => line.from === "source" && starts.some((one_) => line.text.includes(one_)))).toBe(
        true,
      );
      expect(
        lines.some(
          (line) => line.from === "code" && line.text.includes("Kestrel") && !line.text.includes("Kestrel review"),
        ),
      ).toBe(true);
      expect(lines.some((line) => line.from === "code" && line.text.includes("Kestrel review"))).toBe(false);
      // Once its claim is gone, the card says so.
      await commitOf(copy, "UNMATCHED", [], { generation: 2 });
      expect(asWords((await copy.owner.cards.card(card?.id as CardId))?.lines ?? []).at(-1)).toEqual({
        text: "claim_removed",
        from: "code",
      });
    }));

  it("unconfirmed a title link is in no belief's claims; confirmed it is, and a raised generation and a new revision raise no second card and keep the confirmation", () =>
    withWorld(async (copy) => {
      const titled = linkRecord("UNMATCHED", ["own"], b().projects.kestrel);
      await commitOf(copy, "UNMATCHED", [titled]);
      expect(await heldBack(copy, titled.claim.id)).toBe(true);
      const [card] = await cards(copy.db);
      await decide(copy, card?.id as CardId, "confirm");
      expect(await heldBack(copy, titled.claim.id)).toBe(false);

      // A raised generation: the claim again under a new id, no second card, still confirmed.
      const raised = linkRecord("UNMATCHED", ["own"], b().projects.kestrel, { generation: 2 });
      await commitOf(copy, "UNMATCHED", [raised], { generation: 2 });
      expect((await cards(copy.db)).map((one_) => one_.id)).toEqual([card?.id]);
      expect(await heldBack(copy, raised.claim.id)).toBe(false);

      // A new revision: a new evidence row, the same fact key, no second card, still confirmed.
      const reader = createReader({ url: copy.db.urls.reader, keys: copy.db.keys, log: eventLogger() });
      try {
        const answer = await reader.pushCapture(b().captureToken, {
          batch: "lens-link-store-0002",
          items: [
            {
              ...ITEMS.UNMATCHED,
              revision: 1,
              segments: [{ speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "Shall we begin?" }],
            } as CaptureItem,
          ],
        });
        expect(answer.ok).toBe(true);
      } finally {
        await reader.close();
      }
      expect(await copy.writer.takeCapture()).toMatchObject({ replaced: 1, failed: 0 });
      const revised = one(
        await admin<{ evidence_id: string }>(
          copy.db,
          "select evidence_id from knowledge.captures where capture_key = $1",
          [ITEMS.UNMATCHED.key],
        ),
      ).evidence_id;
      expect(revised).not.toBe(b().evidence.UNMATCHED);
      const again = linkRecord("UNMATCHED", ["own"], b().projects.kestrel, { generation: 2, evidence: revised });
      await commitOf(copy, "UNMATCHED", [again], { generation: 2, evidence: revised });
      expect((await cards(copy.db)).map((one_) => one_.id)).toEqual([card?.id]);
      expect(await heldBack(copy, again.claim.id)).toBe(false);
    }));

  it("rejected, a title link is never in a belief's claims, and an anchor link never is", () =>
    withWorld(async (copy) => {
      const titled = linkRecord("UNMATCHED", ["own"], b().projects.kestrel);
      const anchored = linkRecord("OWN_MTG", ["own"], b().projects.heron, { anchor: b().anchors.app });
      await commitOf(copy, "UNMATCHED", [titled]);
      await commitOf(copy, "OWN_MTG", [anchored]);
      const [card] = await cards(copy.db);
      await decide(copy, card?.id as CardId, "reject");
      expect(await heldBack(copy, titled.claim.id)).toBe(true);
      const raised = linkRecord("UNMATCHED", ["own"], b().projects.kestrel, { generation: 2 });
      await commitOf(copy, "UNMATCHED", [raised], { generation: 2 });
      expect(await heldBack(copy, raised.claim.id)).toBe(true);
      // capture.anchor builds no belief at all.
      expect(await heldBack(copy, anchored.claim.id)).toBe(true);
    }));
});

describe("what a client sees", { timeout: DB_TEST_TIMEOUT }, () => {
  it("What a client sees. No read serves a capture.project claim but as a cite of its confirmed belief: find_facts, compiled facts and the mirror's facts section serve none of it, confirmed or not", () =>
    withWorld(async (copy) => {
      // The item's own fact beside its title link, as the control that the item's facts are served.
      const planOnItem = planOf("UNMATCHED", ["own"]);
      const titled = linkRecord("UNMATCHED", ["own"], b().projects.kestrel);
      await copy.pipeline.commit(
        batchOf(b().evidence.UNMATCHED, [planOnItem, titled], { lane: "meeting", status: "done" } as never),
      );
      const check = async () => {
        const wide = b().clients.wide.token;
        for (const args of [{}, { type: "capture" }, { type: "capture.project" }]) {
          // find_facts takes no project entity (it answers not_found); get_entity covers the project
          // below
          const facts = outcomeValue(await copy.reader.findFacts(wide, { limit: 50, ...args } as never)).facts;
          expect(
            facts.filter((fact) => fact.type === "capture.project"),
            JSON.stringify(args),
          ).toEqual([]);
        }
        const kestrel = outcomeValue(await copy.reader.getEntity(wide, { id: b().projects.kestrel } as never));
        expect(kestrel.facts!.claims.filter((fact) => fact.type === "capture.project")).toEqual([]);
        const pages: MirrorPage[] = [];
        for (let cursor: string | null = null, n = 0; n < 20; n += 1) {
          const page = MirrorPage.parse(
            outcomeValue(
              await copy.reader.syncMirror(b().mirrorToken, { templates: ["lens_mirror@1"], cursor } as never),
            ),
          );
          pages.push(page);
          cursor = page.cursor;
          if (page.passComplete) break;
        }
        expect(pages.at(-1)?.passComplete).toBe(true);
        expect(
          pages
            .flatMap((page) => page.entries)
            .filter((entry) => entry.section === "facts" && entry.fact.type === "capture.project"),
        ).toEqual([]);
        // The control: the item's plan is served, citing the item.
        const all = outcomeValue(await copy.reader.findFacts(wide, { limit: 50 } as never)).facts;
        expect(all.some((fact) => fact.type === "plan" && fact.capture === b().capture.UNMATCHED)).toBe(true);
      };
      await check();
      const [card] = await cards(copy.db);
      await decide(copy, card?.id as CardId, "confirm");
      await check();
    }));

  it("a link's claim carries the item's label: a client not cleared for the item sees none of it", () =>
    withWorld(async (copy) => {
      const planOnItem = planOf("LINKED", WIDE);
      await copy.pipeline.commit(
        batchOf(b().evidence.LINKED, [planOnItem, linkRecord("LINKED", WIDE, b().projects.wharf)], {
          lane: "meeting",
          status: "done",
        } as never),
      );
      const [row] = await rowsOf<{ compartments: string[] }>(
        copy.db,
        "select compartments from knowledge.claims where evidence_id = $1 and type = 'capture.project'",
        [b().evidence.LINKED],
      );
      expect(row?.compartments).toEqual(WIDE);
      const [card] = await cards(copy.db);
      expect(card?.compartments).toEqual(WIDE);
      // The own client sees nothing of the item; the wide client sees its plan, the control.
      const ownFacts = outcomeValue(await copy.reader.findFacts(b().clients.own.token, { limit: 50 } as never)).facts;
      expect(JSON.stringify(ownFacts)).not.toContain(b().capture.LINKED);
      const wideFacts = outcomeValue(await copy.reader.findFacts(b().clients.wide.token, { limit: 50 } as never)).facts;
      expect(wideFacts.some((fact) => fact.capture === b().capture.LINKED)).toBe(true);
    }));

  // A capture item's claim (a source moment's, as an iMessage chat's) has no message: it is opened
  // and cited when the token returns its capture row, so its line never reads "(held)" to a caller
  // who sees the item; a held message's claim is still cited as held, its words never served
  // (invariant 6).
  it("a belief on a capture item's claim renders its phrase on get_self; one on a held message's claim is still held", () =>
    withWorld(async (copy) => {
      const needOf = (evidence: string, n: number, what: string, lane: string): ClaimRecord => {
        const made = claimRecord(evidence, ["own"], b().owner, { n, type: "need", factKey: `e1-${n}` });
        return {
          ...made,
          claim: {
            ...made.claim,
            assertedBy: b().owner,
            basis: "explicit_self",
            content: { ...made.claim.content, fields: { what } },
          } as unknown as Claim,
          lane,
        } as ClaimRecord;
      };
      const captured = needOf(b().evidence.MOM, 1, "canary-e1-capture", "moment");
      const held = needOf(b().message, 2, "canary-e1-held", "correspondence");
      expect(await copy.pipeline.commit(batchOf(b().evidence.MOM, [captured], { lane: "moment" } as never))).toBe(
        "committed",
      );
      expect(await copy.pipeline.commit(batchOf(b().message, [held]))).toBe("committed");
      const fact = (n: number) => fingerprint(copy.db.keys, "fact", `e1-${n}`);
      // Each need's belief is computed at read, as of the reader's pinned date: the claims are known by it.
      await knownBy(copy.db, new Date(T));
      await admin(copy.db, "update knowledge.messages set held = true where evidence_id = $1", [b().message]);

      const view = SelfView.parse(outcomeValue(await copy.reader.getSelf(b().clients.own.token, {} as never)));
      const lines = new Map(
        (view.sections ?? []).flatMap((section) => section.lines).map((line) => [line.fact, line.line.untrusted]),
      );
      expect(lines.get(fact(1))).toBe("Need: canary-e1-capture");
      expect(lines.get(fact(2))).toBe("Need: (held)");
      expect(JSON.stringify(view)).not.toContain("canary-e1-held");
      // Its text was opened, so the read binds the capture item, so deleting the item reaches what
      // was written after the read (invariant 10); never the held message.
      const [logged] = await admin<{ bound: string[] }>(
        copy.db,
        "select bound from ledger.read_log where client_id = $1 and tool = 'get_self' order by id",
        [b().clients.own.id],
      );
      expect(logged?.bound).toContain(b().evidence.MOM);
      expect(logged?.bound).not.toContain(b().message);
    }));

  it("a link is in no pack", () =>
    withWorld(async (copy) => {
      await commitOf(copy, "LINKED", [linkRecord("LINKED", WIDE, b().projects.wharf)]);
      await commitOf(copy, "OWN_MTG", [
        linkRecord("OWN_MTG", ["own"], b().projects.heron, { anchor: b().anchors.app }),
      ]);
      const [card] = await cards(copy.db);
      await decide(copy, card?.id as CardId, "confirm");
      const wide = b().clients.wide.token;
      for (const args of [{ purpose: "meeting_prep", event: b().eventId }, { purpose: "agent_bootstrap" }]) {
        const pack = outcomeValue(await copy.reader.buildContextPack(wide, args as never));
        const text = JSON.stringify(pack);
        for (const needle of ["capture.anchor", "capture.project", "capture_project", b().anchors.app])
          expect(text, `${args.purpose} ${needle}`).not.toContain(needle);
      }
      // The control: the meeting's own pack is built, and holds its event.
      expect(
        JSON.stringify(
          outcomeValue(
            await copy.reader.buildContextPack(wide, { purpose: "meeting_prep", event: b().eventId } as never),
          ),
        ),
      ).toContain(b().eventId);
    }));
});
