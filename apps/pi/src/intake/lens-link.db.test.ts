import { randomBytes } from "node:crypto";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import {
  type CaptureItem,
  type ClaimRecord,
  type EntityId,
  type EntityView,
  type FactList,
  type FactView,
  type ForgetItem,
  type MeetingItem,
  MirrorPage,
  type MomentItem,
  type PersonalLogEvent,
  type PersonalLogger,
  type RunSummary,
} from "@intelligence/contracts/personal";
import {
  EXTRACT_GENERATION,
  type ExtractDeps,
  MEETING_MIN_CHARS,
  MOMENT_MIN_CHARS,
  runExtraction,
} from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  journalPath,
  openRow,
} from "@intelligence/personal-store";
import {
  copiesOf,
  copyTestDatabase,
  createTestDatabase,
  DB_TEST_TIMEOUT,
  fingerprint,
  knownBy,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import { events, MODEL_ID, pi, quiet } from "../test-support/extract-fixtures.ts";

// Enrichment on the box through the real lanes and the real `pi`. Items are pushed as Lens pushes
// them (Reader.pushCapture) and drained by Writer.takeCapture; the extraction runs as `pi extract`
// runs it, as pi_pipeline, on the fake model, which counts its calls; the owner's commands run
// through `pi` in-process, as pi_admin. No network, no real model, no wait.
//
// One world, built once and copied for each test (copiesOf): the device `mac` (made by
// addDevice) cleared for own and employer:example, and `mac-own` for own alone; the owner's
// scope; six projects (Heron Survey with an anchor of every device kind, Kestrel with a URL
// prefix under Heron's host and a series, a closed project with an app anchor, a project named
// by a generic word, one named in three code points, and none under employer:example: L30 adds
// one); and twenty-five meetings and moments, each a case of L29. The world's extraction has run
// once with both lane switches unset, and the owner has confirmed the one title card of
// "Kestrel planning", so its belief is built. Every item ended more than a day ago, so no meeting
// waits for a calendar. Reserved domains and synthetic names only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const instant = (time: string): string => new Date(Date.parse(time)).toISOString();

const MEET = { bundle: "test.example.meet", name: "Meet" };
const HERON_APP = { bundle: "test.example.heronapp", name: "Heron" };
const CLOSED_APP = { bundle: "test.example.closedapp", name: "Closed" };
const LIFTED_APP = { bundle: "test.example.liftedapp", name: "Lifted" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const WORK_READER = { bundle: "test.example.workreader", name: "Work reader" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
const SERIES = "series-heron@example.com";
const KESTREL_SERIES = "series-kestrel@example.com";
const WORK_ACCOUNT = "quinn@work.example.com";
const OWNER_ADDRESS = "quinn@example.org";
const FILLER =
  "We went through the survey plan point by point, the sites, the dates and the crew, slowly and carefully.";
const LONG_TEXT = `${FILLER} ${FILLER} ${FILLER}`;

// Keys of their own: the ULIDs begin unlike any other file's.
let serial = 0;
const ulid = (): string => `01JQ1NKE${String((serial += 1)).padStart(18, "0")}`;
const requestId = (): string => `req-lens-link-${randomBytes(6).toString("hex")}`;

const meeting = (start: number, over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: `meeting:${ulid()}`,
  revision: 0,
  startedAt: local(start),
  endedAt: local(start + 30 * MINUTE),
  app: MEET,
  title: "Catch-up",
  consent: true,
  mode: "call",
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
  ...over,
});
const moment = (start: number, thread: string, over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: `moment:${ulid()}`,
  revision: 0,
  observedAt: local(start),
  endedAt: local(start + 5 * MINUTE),
  app: READER,
  entity: "doc",
  thread,
  participants: [],
  text: "The plan, second draft.",
  read: "ax",
  ...over,
});

// The world's items, by name. Each comment is what the link should be after the world's run.
const ITEMS = {
  // Meetings.
  MTG_APP: meeting(-50 * HOUR, {
    app: HERON_APP,
    title: "Design review",
    segments: Array.from({ length: 8 }, (_, n) => ({
      speaker: null,
      fromMs: n * 20_000,
      toMs: n * 20_000 + 19_000,
      channel: "mixed" as const,
      text: FILLER,
    })),
  }), // anchor: Heron's app; long enough for the lane's call
  MTG_BROWSER: meeting(-49 * HOUR, { app: CHROME, host: "heron.example.org", title: "Kestrel notes" }), // anchor: Heron's host, outranking the title
  MTG_SERIES: meeting(-48 * HOUR, {
    title: "Planning",
    calendar: {
      start: local(-48 * HOUR),
      end: local(-48 * HOUR + 30 * MINUTE),
      title: "Planning",
      uid: SERIES,
      attendees: [],
    },
  }), // anchor: Heron's series
  MTG_SPECIFIC: meeting(-47 * HOUR, {
    app: HERON_APP,
    title: "Planning",
    calendar: { start: local(-47 * HOUR), end: local(-47 * HOUR + 30 * MINUTE), uid: SERIES, attendees: [] },
  }), // anchor: the series, not the app
  MTG_TITLE: meeting(-46 * HOUR, { title: "Kestrel planning" }), // title: Kestrel
  MTG_CALTITLE: meeting(-45 * HOUR, {
    title: "Weekly",
    calendar: {
      start: local(-45 * HOUR),
      end: local(-45 * HOUR + 30 * MINUTE),
      title: "Heron Survey review",
      attendees: [],
    },
  }), // title: Heron, "Weekly" being generic
  MTG_INSIDE: meeting(-44 * HOUR, { title: "Kestrels and herons" }), // none: a name inside a word
  MTG_TWO: meeting(-43 * HOUR, { title: "Heron Survey and Kestrel" }), // none: two projects named
  MTG_SHORT: meeting(-42 * HOUR, { title: "Ash notes" }), // none: a name under 4 code points
  MTG_CLOSED: meeting(-41 * HOUR, { app: CLOSED_APP, title: "Osprey Survey wrap-up" }), // none: a closed project's anchor and name
  MTG_LIFTED: meeting(-40 * HOUR, { app: LIFTED_APP, title: "Lifted call" }), // none: a lifted anchor
  MTG_AMBIG: meeting(-39 * HOUR, {
    app: HERON_APP,
    title: "Kestrel sync",
    calendar: {
      start: local(-39 * HOUR),
      end: local(-39 * HOUR + 30 * MINUTE),
      title: "Kestrel sync",
      uid: KESTREL_SERIES,
      attendees: [],
    },
  }), // none: two projects' anchors, not even by title
  // Moments, each on a thread of its own, so each is a group of its own.
  MOM_HOST: moment(-38 * HOUR, "host", { url: "https://heron.example.org/notes" }), // anchor: Heron's host
  MOM_URL: moment(-37 * HOUR, "url", { url: "https://wiki.example.org/teams/heron/plan" }), // anchor: Heron's URL prefix
  MOM_INSIDE: moment(-36 * HOUR, "inside", { url: "https://wiki.example.org/teams/heronry/plan" }), // none: inside a segment
  MOM_REPO: moment(-35 * HOUR, "repo", { repository: "git.example.org/quinn/heron" }), // anchor: Heron's repository, from the field
  MOM_FORGE: moment(-34 * HOUR, "forge", { app: HERON_APP, url: "https://git.example.org/quinn/heron/pull/3" }), // anchor: the repository, from the forge page, not the app
  MOM_DOC: moment(-33 * HOUR, "doc", { document: "~/test/heron/plan.md" }), // anchor: the document itself, not its folder
  MOM_FILE: moment(-32 * HOUR, "file", { document: "~/test/heron/notes/plan.md" }), // anchor: the folder
  MOM_AMBIG: moment(-31 * HOUR, "ambig", { url: "https://heron.example.org/kestrel/board" }), // none: Heron's host and Kestrel's prefix
  MOM_TITLE: moment(-30 * HOUR, "Kestrel", { window: "Kestrel planning", text: "Kestrel planning notes." }), // none: never by title
  // The moment lane asks only a chat with turns, so the one it asks is one.
  MOM_LONG: moment(-29 * HOUR, "long", {
    entity: "chat",
    url: "https://heron.example.org/long",
    text: LONG_TEXT,
    turns: [{ from: 0, to: LONG_TEXT.length, speaker: "owner" }],
  }), // anchor: Heron's host; long enough for the lane's call
  MOM_SHARED: moment(-28 * HOUR, "shared", { url: "https://heron.example.org/wharf/plan" }), // anchor: Heron's host (L30 adds an employer prefix over it)
  MOM_EMPLOYER: moment(-27 * HOUR, "employer", {
    app: WORK_READER,
    url: "https://heron.example.org/wharf/plan",
    account: WORK_ACCOUNT,
  }), // none: under employer:example, no project there
} as const;
type Name = keyof typeof ITEMS;
const NAMES = Object.keys(ITEMS) as Name[];
const MEETING_NAMES = NAMES.filter((name) => ITEMS[name].kind === "meeting");
const MOMENT_NAMES = NAMES.filter((name) => ITEMS[name].kind === "moment");

type ProjectName = "heron" | "kestrel" | "osprey" | "weekly" | "ash";
type AnchorName =
  | "app"
  | "lifted"
  | "host"
  | "url"
  | "repo"
  | "folder"
  | "file"
  | "series"
  | "kestrelUrl"
  | "kestrelSeries"
  | "ospreyApp";
type Built = {
  evidence: Record<Name, string>;
  capture: Record<Name, string>;
  projects: Record<ProjectName, EntityId>;
  anchors: Record<AnchorName, string>;
  captureToken: string;
  mirror: { mac: { id: string; token: string }; macOwn: { id: string; token: string } };
  clients: { own: string; wide: string; nowork: string };
  titleCard: string;
};
let built: Built | undefined;
const b = (): Built => {
  if (built === undefined) throw new Error("the world is not built");
  return built;
};

// What the link of each item is after the world's run: a project and, for an anchor, its anchor.
type Expected =
  | { type: "capture.anchor"; project: ProjectName; anchor: AnchorName }
  | { type: "capture.project"; project: ProjectName }
  | null;
const EXPECTED: Record<Name, Expected> = {
  MTG_APP: { type: "capture.anchor", project: "heron", anchor: "app" },
  MTG_BROWSER: { type: "capture.anchor", project: "heron", anchor: "host" },
  MTG_SERIES: { type: "capture.anchor", project: "heron", anchor: "series" },
  MTG_SPECIFIC: { type: "capture.anchor", project: "heron", anchor: "series" },
  MTG_TITLE: { type: "capture.project", project: "kestrel" },
  MTG_CALTITLE: { type: "capture.project", project: "heron" },
  MTG_INSIDE: null,
  MTG_TWO: null,
  MTG_SHORT: null,
  MTG_CLOSED: null,
  MTG_LIFTED: null,
  MTG_AMBIG: null,
  MOM_HOST: { type: "capture.anchor", project: "heron", anchor: "host" },
  MOM_URL: { type: "capture.anchor", project: "heron", anchor: "url" },
  MOM_INSIDE: null,
  MOM_REPO: { type: "capture.anchor", project: "heron", anchor: "repo" },
  MOM_FORGE: { type: "capture.anchor", project: "heron", anchor: "repo" },
  MOM_DOC: { type: "capture.anchor", project: "heron", anchor: "file" },
  MOM_FILE: { type: "capture.anchor", project: "heron", anchor: "folder" },
  MOM_AMBIG: null,
  MOM_TITLE: null,
  MOM_LONG: { type: "capture.anchor", project: "heron", anchor: "host" },
  MOM_SHARED: { type: "capture.anchor", project: "heron", anchor: "host" },
  MOM_EMPLOYER: null,
};
type Link = { type: string; project: string; anchor: string | null } | null;
const expectedLink = (name: Name): Link => {
  const expected = EXPECTED[name];
  if (expected === null) return null;
  return {
    type: expected.type,
    project: b().projects[expected.project],
    anchor: expected.type === "capture.anchor" ? b().anchors[expected.anchor] : null,
  };
};

// ---------------------------------------------------------------------------------------------
// Helpers over a database
// ---------------------------------------------------------------------------------------------

const admin = <Row = Record<string, unknown>>(db: TestDatabase, sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const adminEnv = (db: TestDatabase): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: db.urls.admin,
  PI_KEY_FILE: db.keyFile,
});
const one = <Row>(rows: Row[]): Row => {
  expect(rows).toHaveLength(1);
  return rows[0] as Row;
};

async function insertScope(
  db: TestDatabase,
  match: "bundle" | "host",
  value: string,
  compartment: string,
  kinds: string[],
  account?: string,
): Promise<void> {
  const id = `csr_${ulid()}`;
  const sealed = (column: string, text: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, text);
  await admin(
    db,
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      match,
      fingerprint(db.keys, "capture_scope", value),
      sealed("value_enc", value),
      account === undefined ? null : fingerprint(db.keys, "capture_scope", account),
      account === undefined ? null : sealed("account_enc", account),
      compartment,
      kinds,
    ],
  );
}

let batches = 0;
async function push(db: TestDatabase, items: (CaptureItem | ForgetItem)[]): Promise<void> {
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const answer = await reader.pushCapture(b().captureToken, {
      batch: `pi-lens-link-${String((batches += 1)).padStart(4, "0")}`,
      items: items as CaptureItem[],
    });
    // An ack may also carry `erased` (capture-erasure.db.test.ts pins it).
    expect(answer).toEqual({
      ok: true,
      value: expect.objectContaining({ items: items.map((item) => ({ key: item.key, outcome: "accepted" })) }),
    });
  } finally {
    await reader.close();
  }
}
async function drain(db: TestDatabase): Promise<void> {
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet, journal: journalPath(db.keyFile) });
  try {
    expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  } finally {
    await writer.close();
  }
}
async function withAdmin<T>(
  db: TestDatabase,
  fn: (owner: Admin) => Promise<T>,
  journal = journalPath(db.keyFile),
): Promise<T> {
  const owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet, journal });
  try {
    return await fn(owner);
  } finally {
    await owner.close();
  }
}

const captureOf = async (
  db: TestDatabase,
  item: { key: string },
): Promise<{ id: string; evidence_id: string; compartments: string[] } | undefined> =>
  (
    await admin<{ id: string; evidence_id: string; compartments: string[] }>(
      db,
      "select id, evidence_id, compartments from knowledge.captures where capture_key = $1",
      [item.key],
    )
  )[0];

function recorder(): { log: PersonalLogger; lines: PersonalLogEvent[] } {
  const lines: PersonalLogEvent[] = [];
  const keep = (event: PersonalLogEvent): void => void lines.push(event);
  return { log: { info: keep, warn: keep, error: keep }, lines };
}

// The extraction, as `pi extract` runs it: both lane switches as given, the fake model answering
// every capture item with no claim and recording each evidence id it is asked.
async function extract(
  db: TestDatabase,
  options: { meetings?: boolean; moments?: boolean; generation?: number; outputs?: boolean; log?: PersonalLogger } = {},
): Promise<{ asked: string[]; summary: RunSummary }> {
  const ids = (await admin<{ evidence_id: string }>(db, "select evidence_id from knowledge.captures")).map(
    (row) => row.evidence_id,
  );
  const outputs =
    options.outputs === false ? {} : Object.fromEntries(ids.map((id) => [id, { claims: [], narrowing: "none" }]));
  const asked: string[] = [];
  const fake = fakeModelClient(outputs, asked);
  const model: ExtractDeps["model"] = {
    complete: (request: ModelRequest): Promise<ModelResponse> => fake.complete(request),
    embed: (request) => fake.embed(request),
  };
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    const summary = await runExtraction({
      store: pipeline,
      model,
      modelId: MODEL_ID,
      log: options.log ?? quiet,
      now: () => new Date(T),
      compartments: ["own", "employer:example"],
      ...(options.generation === undefined ? {} : { generation: options.generation }),
      ...(options.meetings === true ? { meetings: true as const } : {}),
      // Continuous groups: this file's items were pushed after its pinned clock, which the batched
      // mode would not take yet (pipeline-moments.db.test.ts and moments.test.ts test that mode).
      ...(options.moments === true ? { moments: true as const, momentsContinuous: true as const } : {}),
    });
    if (summary === "already_running") throw new Error("the extract lock was held");
    return { asked, summary };
  } finally {
    await pipeline.close();
  }
}

// The link claims of an item's current revision, opened as pi_admin.
type LinkRow = { id: string; type: string; fact_key_fp: string; compartments: string[]; record: ClaimRecord };
async function linkRows(db: TestDatabase, item: { key: string }): Promise<LinkRow[]> {
  const rows = await admin<{
    id: string;
    type: string;
    fact_key_fp: string;
    compartments: string[];
    content_enc: unknown;
  }>(
    db,
    `select k.id, k.type, k.fact_key_fp, k.compartments, k.content_enc from knowledge.claims k join knowledge.captures c on c.evidence_id = k.evidence_id
      where c.capture_key = $1 and k.type in ('capture.anchor', 'capture.project') order by k.id`,
    [item.key],
  );
  return rows.map((row) => ({
    ...row,
    record: JSON.parse(
      openRow(
        db.keys,
        row.compartments[0] ?? "own",
        { table: "knowledge.claims", id: row.id, column: "content_enc" },
        row.content_enc as never,
      ),
    ) as ClaimRecord,
  }));
}
// The item's link: at most one per item revision.
async function linkOf(db: TestDatabase, item: { key: string }): Promise<Link> {
  const rows = await linkRows(db, item);
  expect(rows.length, item.key).toBeLessThanOrEqual(1);
  const row = rows[0];
  if (row === undefined) return null;
  const anchor = row.record.claim.content.fields.anchor;
  return {
    type: row.type,
    project: row.record.claim.content.subject,
    anchor: typeof anchor === "string" ? anchor : null,
  };
}
async function linksOf(db: TestDatabase): Promise<Record<Name, Link>> {
  const links = {} as Record<Name, Link>;
  for (const name of NAMES) links[name] = await linkOf(db, ITEMS[name]);
  return links;
}
const expectedLinks = (): Record<Name, Link> =>
  Object.fromEntries(NAMES.map((name) => [name, expectedLink(name)])) as Record<Name, Link>;

async function statusOf(db: TestDatabase, evidenceId: string): Promise<{ status: string; code?: string } | undefined> {
  const [row] = await admin<{ facts_enc: unknown; compartments: string[] }>(
    db,
    "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
    [evidenceId],
  );
  return row === undefined
    ? undefined
    : JSON.parse(
        openRow(
          db.keys,
          row.compartments[0] ?? "own",
          { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
          row.facts_enc as never,
        ),
      );
}
const waitingOf = async (db: TestDatabase, item: { key: string }): Promise<boolean | undefined> =>
  (
    await admin<{ waiting: boolean }>(
      db,
      "select p.waiting from vault.pipeline_items p join knowledge.captures c on c.evidence_id = p.evidence_id where c.capture_key = $1",
      [item.key],
    )
  )[0]?.waiting;

type CardRow = { id: string; request_id: string; target_kind: string; created_by: string; compartments: string[] };
const titleCards = (db: TestDatabase): Promise<CardRow[]> =>
  admin<CardRow>(
    db,
    "select id, request_id, target_kind, created_by, compartments from ledger.cards where kind = 'agent_claim' order by created_at, id",
  );
// The title card's request id: the agent_claim fingerprint of `capture` and the fact key.
const titleKeyOf = (db: TestDatabase, factKeyFp: string): string =>
  fingerprint(db.keys, "agent_claim", `capture\n${factKeyFp}`);
// Beliefs resting on these claims, in every audience, or in one when it is named: each computed
// when asked, on the database's clock, under each clearance a client or the owner reads with, as
// the pipeline's sweep computes them; each named by its audience and fact key.
// This world has two: [own] and the wide client's.
const WIDE_AUDIENCE = ["employer:example", "own"];
const beliefsOn = async (db: TestDatabase, claimIds: string[], audience?: string[]): Promise<string[]> => {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    const built = await pipeline.sweepBeliefs(["capture.anchor", "capture.project"]);
    return built
      .filter((one) => audience === undefined || one.audience.join("\n") === audience.join("\n"))
      .flatMap((one) =>
        one.records
          .filter((record) => record.belief.support.some((id) => claimIds.includes(fingerprint(db.keys, "claim", id))))
          .map((record) => `${one.audience.join(",")} ${record.factKeyFp}`),
      )
      .sort();
  } finally {
    await pipeline.close();
  }
};

// Reads as a client, with the clock pinned: T, unless a test moves it on to make a mirror pass due.
const clock = { at: T };
async function withReader<T>(
  db: TestDatabase,
  fn: (reader: ReturnType<typeof createReader>) => Promise<T>,
): Promise<T> {
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet, now: () => new Date(clock.at) });
  try {
    return await fn(reader);
  } finally {
    await reader.close();
  }
}
const factsOf = (db: TestDatabase, token: string, args: { type?: string; entity?: string } = {}): Promise<FactList> =>
  withReader(db, async (reader) => {
    const answer = await reader.findFacts(token, { limit: 50, ...args } as never);
    if (!answer.ok) throw new Error(`find_facts answered ${answer.code}`);
    return answer.value;
  });
// The world's rows are written after its pinned date: a belief computed at read counts them once
// they are known by the reader's date.
const entityOf = async (db: TestDatabase, token: string, id: string): Promise<EntityView | null> => {
  await knownBy(db, new Date(clock.at));
  return withReader(db, async (reader) => {
    const answer = await reader.getEntity(token, { id } as never);
    return answer.ok ? answer.value : null;
  });
};
async function mirrorPass(
  db: TestDatabase,
  token: string,
  cursor: string | null = null,
): Promise<{ pages: MirrorPage[]; cursor: string }> {
  return withReader(db, async (reader) => {
    const pages: MirrorPage[] = [];
    let next = cursor;
    // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
    for (let n = 0; n < 2_000; n += 1) {
      const answer = await reader.syncMirror(token, { templates: ["lens_mirror@1"], cursor: next } as never);
      if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
      const page = MirrorPage.parse(answer.value);
      pages.push(page);
      next = page.cursor;
      if (page.passComplete) return { pages, cursor: next };
    }
    throw new Error("no pass completed");
  });
}
const entries = (pages: MirrorPage[]) => pages.flatMap((page) => page.entries);
const masked = (pages: MirrorPage[]) => pages.map((page) => ({ ...page, cursor: "mcr" }));
const liveEntriesOn = async (db: TestDatabase, client: string, evidenceId: string): Promise<string[]> =>
  (
    await admin<{ id: string }>(
      db,
      "select id from ledger.mirror_entries where client_id = $1 and ended_at is null and $2 = any(evidence_ids) order by id",
      [client, evidenceId],
    )
  ).map((row) => row.id);
async function nextPage(db: TestDatabase, token: string, cursor: string): Promise<MirrorPage> {
  return withReader(db, async (reader) => {
    const answer = await reader.syncMirror(token, { templates: ["lens_mirror@1"], cursor } as never);
    if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
    return MirrorPage.parse(answer.value);
  });
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

const world = copiesOf(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const evidence = {} as Record<Name, string>;
  const capture = {} as Record<Name, string>;
  const state = await withAdmin(db, async (owner) => {
    // The owner's entity, which a box has once its owner's address is known: both lanes open an
    // item with it.
    await owner.accounts.addOwnerAddress(OWNER_ADDRESS, "own");
    const { capture: captureToken } = await owner.lens.addDevice("mac", {
      compartments: ["own", "employer:example"],
      views: ["self", "people", "work"],
    });
    const macToken = await owner.lens.rotateDevice("mac", "mirror");
    await owner.lens.addDevice("mac-own", { compartments: ["own"], views: ["self", "people", "work"] });
    const macOwnToken = await owner.lens.rotateDevice("mac-own", "mirror");
    const clientId = async (name: string): Promise<string> =>
      one(await admin<{ id: string }>(db, "select id from policy.clients where name = $1", [name])).id;
    const reading = {
      runtime: "local" as const,
      vendorRetention: "none" as const,
      tools: ["get_self", "search", "get_entity", "find_facts", "build_context_pack", "get_commitments"],
    };
    const clients = {
      own: (
        await owner.clients.addClient({
          ...reading,
          name: "link-own",
          compartments: ["own"],
          views: ["self", "people", "work"],
        } as never)
      ).token,
      wide: (
        await owner.clients.addClient({
          ...reading,
          name: "link-wide",
          compartments: ["own", "employer:example"],
          views: ["self", "people", "work"],
        } as never)
      ).token,
      nowork: (
        await owner.clients.addClient({
          ...reading,
          name: "link-nowork",
          compartments: ["own", "employer:example"],
          views: ["self", "people"],
        } as never)
      ).token,
    };
    for (const bundle of [MEET.bundle, CLOSED_APP.bundle, LIFTED_APP.bundle])
      await insertScope(db, "bundle", bundle, "own", ["meeting"]);
    await insertScope(db, "bundle", HERON_APP.bundle, "own", ["meeting", "moment"]);
    await insertScope(db, "bundle", READER.bundle, "own", ["moment"]);
    // The employer moment shares Heron's host with own moments, so its rule names its account, and a
    // rule with an account wins over one without.
    await insertScope(db, "host", "heron.example.org", "own", ["meeting", "moment"]);
    await insertScope(db, "host", "wiki.example.org", "own", ["moment"]);
    await insertScope(db, "host", "git.example.org", "own", ["moment"]);
    await insertScope(db, "host", "heron.example.org", "employer:example", ["moment"], WORK_ACCOUNT);
    await insertScope(db, "bundle", WORK_READER.bundle, "employer:example", ["moment"]);

    const add = (name: string) => owner.projects.add(name, { requestId: requestId() });
    const projects: Record<ProjectName, EntityId> = {
      heron: await add("Heron Survey"),
      kestrel: await add("Kestrel"),
      osprey: await add("Osprey Survey"),
      weekly: await add("Weekly"),
      ash: await add("Ash"),
    };
    const anchor = (
      project: EntityId,
      kind: "app" | "host" | "url_prefix" | "repository" | "document",
      value: string,
    ) => owner.projects.anchor(project, { kind, value }, { requestId: requestId() });
    const anchors = {
      app: await anchor(projects.heron, "app", HERON_APP.bundle),
      lifted: await anchor(projects.heron, "app", LIFTED_APP.bundle),
      host: await anchor(projects.heron, "host", "heron.example.org"),
      url: await anchor(projects.heron, "url_prefix", "https://wiki.example.org/teams/heron"),
      repo: await anchor(projects.heron, "repository", "git.example.org/quinn/heron"),
      folder: await anchor(projects.heron, "document", "~/test/heron"),
      file: await anchor(projects.heron, "document", "~/test/heron/plan.md"),
      kestrelUrl: await anchor(projects.kestrel, "url_prefix", "https://heron.example.org/kestrel"),
      ospreyApp: await anchor(projects.osprey, "app", CLOSED_APP.bundle),
    };
    expect(await owner.projects.unanchor(anchors.lifted, { requestId: requestId() })).toBe(true);
    expect(await owner.projects.close(projects.osprey, { requestId: requestId() })).toBe(true);
    return {
      captureToken,
      projects,
      anchors,
      clients,
      mirror: {
        mac: { id: await clientId("mac"), token: macToken },
        macOwn: { id: await clientId("mac-own"), token: macOwnToken },
      },
    };
  });
  built = { ...state, evidence, capture, anchors: { ...state.anchors, series: "", kestrelSeries: "" }, titleCard: "" };

  await push(
    db,
    NAMES.map((name) => ITEMS[name]),
  );
  await drain(db);
  for (const name of NAMES) {
    const row = await captureOf(db, ITEMS[name]);
    if (row === undefined) throw new Error(`${name} was not stored`);
    evidence[name] = row.evidence_id;
    capture[name] = row.id;
  }
  // The labels the cases rest on: every item under own, but the employer moment.
  for (const name of NAMES)
    expect((await captureOf(db, ITEMS[name]))?.compartments, name).toEqual(
      name === "MOM_EMPLOYER" ? ["employer:example"] : ["own"],
    );
  // The two series anchors, each named by a stored meeting.
  await withAdmin(db, async (owner) => {
    built = {
      ...b(),
      anchors: {
        ...b().anchors,
        series: await owner.projects.anchor(
          b().projects.heron,
          { seriesOf: capture.MTG_SERIES as never },
          { requestId: requestId() },
        ),
        kestrelSeries: await owner.projects.anchor(
          b().projects.kestrel,
          { seriesOf: capture.MTG_AMBIG as never },
          { requestId: requestId() },
        ),
      },
    };
  });

  // The world's run, both switches unset; then the owner confirms "Kestrel planning"'s card and
  // the next run builds its belief.
  await extract(db);
  const [title] = await linkRows(db, ITEMS.MTG_TITLE);
  if (title === undefined) throw new Error("no title link for the world's titled meeting");
  const card = (await titleCards(db)).find((row) => row.request_id === titleKeyOf(db, title.fact_key_fp));
  if (card === undefined) throw new Error("no card for the world's title link");
  await withAdmin(db, (owner) =>
    owner.cards.decide({ cards: [card.id as never], answer: "confirm", requestId: requestId() }),
  );
  await extract(db);
  built = { ...b(), titleCard: card.id };
  return db;
});

afterAll(async () => {
  await world.drop();
}, DB_TEST_TIMEOUT);

// A copy of the world for one test, dropped after it.
async function withWorld(fn: (db: TestDatabase) => Promise<void>): Promise<void> {
  clock.at = T;
  const db = await world.copy();
  try {
    await fn(db);
  } finally {
    await db.drop();
  }
}

// ---------------------------------------------------------------------------------------------
// L29: the link rules through both lanes
// ---------------------------------------------------------------------------------------------

describe("L29: the link rules, on the box, through both lanes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("L29: an app, a host on a moment and on a browser meeting, a URL prefix at a segment boundary and not inside a segment, a repository from a moment's field and from a forge page, a document and a file under an anchored folder, and a meeting's series each link their items", () =>
    withWorld(async (db) => {
      const links = await linksOf(db);
      for (const name of [
        "MTG_APP",
        "MOM_HOST",
        "MTG_BROWSER",
        "MOM_URL",
        "MOM_REPO",
        "MOM_FORGE",
        "MOM_DOC",
        "MOM_FILE",
        "MTG_SERIES",
      ] as const)
        expect(links[name], name).toEqual(expectedLink(name));
      // The refusal beside its control: a URL prefix inside a segment links nothing.
      expect(links.MOM_INSIDE).toBeNull();
    }));

  it("L29: the most specific anchor of the one project is named", () =>
    withWorld(async (db) => {
      const links = await linksOf(db);
      // The series over the app; the repository over the app; the file over its folder.
      expect(links.MTG_SPECIFIC).toEqual({
        type: "capture.anchor",
        project: b().projects.heron,
        anchor: b().anchors.series,
      });
      expect(links.MOM_FORGE).toEqual({
        type: "capture.anchor",
        project: b().projects.heron,
        anchor: b().anchors.repo,
      });
      expect(links.MOM_DOC).toEqual({ type: "capture.anchor", project: b().projects.heron, anchor: b().anchors.file });
      // The controls: each less specific anchor names the items only it matches.
      expect(links.MTG_APP?.anchor).toBe(b().anchors.app);
      expect(links.MOM_FILE?.anchor).toBe(b().anchors.folder);
    }));

  it("L29: the anchors of two candidate projects link nothing, not even by title", () =>
    withWorld(async (db) => {
      // Heron's host and Kestrel's prefix under it; Heron's app and Kestrel's series, the title naming Kestrel.
      expect(await linkOf(db, ITEMS.MOM_AMBIG)).toBeNull();
      expect(await linkOf(db, ITEMS.MTG_AMBIG)).toBeNull();
      // The control: Heron's host alone links the moment beside it.
      expect(await linkOf(db, ITEMS.MOM_HOST)).toEqual(expectedLink("MOM_HOST"));
    }));

  it("L29: a closed project's anchors and a lifted anchor match nothing", () =>
    withWorld(async (db) => {
      expect(await linkOf(db, ITEMS.MTG_CLOSED)).toBeNull();
      expect(await linkOf(db, ITEMS.MTG_LIFTED)).toBeNull();
      // No link anywhere names the closed project or the lifted anchor.
      const all = JSON.stringify(await linksOf(db));
      expect(all).not.toContain(b().projects.osprey);
      expect(all).not.toContain(b().anchors.lifted);
      expect(all).not.toContain(b().anchors.ospreyApp);
      // The control: the live app anchor of the active project links its meeting.
      expect(await linkOf(db, ITEMS.MTG_APP)).toEqual(expectedLink("MTG_APP"));
    }));

  it("L29: a meeting no anchor matches is linked by one project's name as a whole phrase in its title or calendar title", () =>
    withWorld(async (db) => {
      expect(await linkOf(db, ITEMS.MTG_TITLE)).toEqual({
        type: "capture.project",
        project: b().projects.kestrel,
        anchor: null,
      });
      // By its calendar entry's title; its own title "Weekly" names the project on the generic list.
      expect(await linkOf(db, ITEMS.MTG_CALTITLE)).toEqual({
        type: "capture.project",
        project: b().projects.heron,
        anchor: null,
      });
      // A meeting an anchor matches is linked by the anchor, whatever its title names.
      expect(await linkOf(db, ITEMS.MTG_BROWSER)).toEqual(expectedLink("MTG_BROWSER"));
    }));

  it("L29: a name inside a word, under 4 code points or on the generic list, and two projects named, link nothing", () =>
    withWorld(async (db) => {
      for (const name of ["MTG_INSIDE", "MTG_SHORT", "MTG_TWO"] as const)
        expect(await linkOf(db, ITEMS[name]), name).toBeNull();
      // The project named by a generic word, and the one named in three code points, are never linked.
      const all = JSON.stringify(await linksOf(db));
      expect(all).not.toContain(b().projects.weekly);
      expect(all).not.toContain(b().projects.ash);
    }));

  it("L29: a moment is never linked by title", () =>
    withWorld(async (db) => {
      expect(await linkOf(db, ITEMS.MOM_TITLE)).toBeNull();
      for (const name of MOMENT_NAMES) expect((await linkOf(db, ITEMS[name]))?.type, name).not.toBe("capture.project");
    }));

  it("L29: with both lane switches unset and set, each item's link is the same and the link step makes no model call", () =>
    withWorld(async (db) => {
      const off = await linksOf(db);
      expect(off).toEqual(expectedLinks());
      // Every capture item was committed with the switches unset, each with its link.
      for (const name of NAMES)
        expect(await statusOf(db, b().evidence[name]), name).toMatchObject({
          status: "skipped",
          code: "not_extracted",
        });
      const { asked } = await extract(db, { meetings: true, moments: true });
      // The lanes' own calls alone: the one meeting and the one moment long enough to send.
      expect([...asked].sort()).toEqual([b().evidence.MTG_APP, b().evidence.MOM_LONG].sort());
      expect(await linksOf(db)).toEqual(off);
    }));
});

describe("the link step", { timeout: DB_TEST_TIMEOUT }, () => {
  it("No model. Rules suffice: every item is committed again with its link, and with a model that answers nothing no call is made", () =>
    withWorld(async (db) => {
      const before = await linksOf(db);
      // A raised generation makes every item due again; the fake model knows no item.
      const { asked } = await extract(db, { generation: EXTRACT_GENERATION + 1, outputs: false });
      expect(asked).toEqual([]);
      expect(await linksOf(db)).toEqual(before);
      // Each item was committed again under the raised generation.
      for (const name of NAMES) {
        expect(
          one(
            await admin<{ g: number }>(
              db,
              "select extractor_generation as g from vault.pipeline_items where evidence_id = $1",
              [b().evidence[name]],
            ),
          ).g,
          name,
        ).toBe(EXTRACT_GENERATION + 1);
      }
    }));

  it("Where it runs: the link step. In pi extract, as pi_pipeline, under the extract lock: an item is committed with its link, and no link is made while another run holds the lock", () =>
    withWorld(async (db) => {
      // Each link sits beside the item's status row, committed not_extracted with the switches unset.
      for (const name of NAMES) {
        const status = await statusOf(db, b().evidence[name]);
        expect(status, name).toMatchObject({ status: "skipped", code: "not_extracted" });
      }
      // A new revision of an item, drained, and a run while another holds the lock: nothing made.
      await push(db, [{ ...ITEMS.MOM_HOST, revision: 1 }]);
      await drain(db);
      expect(await linkOf(db, ITEMS.MOM_HOST)).toBeNull();
      const holder = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
      try {
        const held = await holder.withExtractLock(async () => {
          const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
          try {
            return await runExtraction({
              store: pipeline,
              model: fakeModelClient({}),
              modelId: MODEL_ID,
              log: quiet,
              now: () => new Date(T),
              compartments: ["own", "employer:example"],
            });
          } finally {
            await pipeline.close();
          }
        });
        expect(held).toBe("already_running");
      } finally {
        await holder.close();
      }
      expect(await linkOf(db, ITEMS.MOM_HOST)).toBeNull();
      // The control: the next run, the lock free, links it.
      await extract(db);
      expect(await linkOf(db, ITEMS.MOM_HOST)).toEqual(expectedLink("MOM_HOST"));
    }));

  it("Claims, beliefs and the owner's confirmation. A link is one claim of origin source, from the item's evidence, under its label, its subject the project, valid from the item's start, and its fact key held across revisions", () =>
    withWorld(async (db) => {
      for (const name of NAMES) {
        const expected = expectedLink(name);
        const rows = await linkRows(db, ITEMS[name]);
        if (expected === null) {
          expect(rows, name).toEqual([]);
          continue;
        }
        const row = one(rows);
        const item = ITEMS[name];
        const label = (await captureOf(db, item))?.compartments;
        expect(row.compartments, name).toEqual(label);
        expect(row.record.origin, name).toBe("source");
        expect(row.record.claim.label.compartments, name).toEqual(label);
        expect(row.record.claim.primaryEvidenceId, name).toBe(b().evidence[name]);
        expect(
          row.record.claim.evidence.map((one_) => one_.evidenceId),
          name,
        ).toEqual([b().evidence[name]]);
        expect(row.record.claim.content.subject, name).toBe(expected.project);
        expect(instant(row.record.claim.validFrom), name).toBe(
          instant(item.kind === "meeting" ? item.startedAt : item.observedAt),
        );
        expect(row.record.claim.content.fields, name).toEqual(
          expected.type === "capture.anchor" ? { anchor: expected.anchor } : {},
        );
      }
      // The fact key is the type, the project and the capture key: a new revision keeps it.
      const [before] = await linkRows(db, ITEMS.MOM_HOST);
      await push(db, [{ ...ITEMS.MOM_HOST, revision: 1, text: "The plan, third draft." }]);
      await drain(db);
      await extract(db);
      const [after] = await linkRows(db, ITEMS.MOM_HOST);
      expect(after?.id).not.toBe(before?.id);
      expect(after?.fact_key_fp).toBe(before?.fact_key_fp);
      // Two items linked to one project by one anchor hold two fact keys.
      const [other] = await linkRows(db, ITEMS.MOM_LONG);
      expect(other?.fact_key_fp).not.toBe(after?.fact_key_fp);
    }));

  it("the captures_linked log line holds counts and no canary", () =>
    withWorld(async (db) => {
      const { log, lines } = recorder();
      await extract(db, { generation: EXTRACT_GENERATION + 1, log });
      const linked = lines.filter((line) => line.event === "captures_linked");
      expect(linked.length).toBeGreaterThan(0);
      const totals = new Map<string, number>();
      for (const line of linked) {
        expect(
          Object.keys(line).every((key) => ["event", "ids", "counts"].includes(key)),
          JSON.stringify(Object.keys(line)),
        ).toBe(true);
        const counts = (line as { counts?: Record<string, unknown> }).counts ?? {};
        expect(Object.keys(counts)).toHaveLength(3);
        for (const [key, value] of Object.entries(counts)) {
          expect(Number.isInteger(value) && (value as number) >= 0, key).toBe(true);
          totals.set(key, (totals.get(key) ?? 0) + (value as number));
        }
        for (const value of Object.values((line as { ids?: Record<string, unknown> }).ids ?? {}))
          expect(String(value)).toMatch(/^([a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{64})$/);
      }
      // Twelve anchor links, two title links, and the items left unlinked as ambiguous: the two
      // whose anchors met two projects, and, if the line counts it so, the meeting naming two.
      const sorted = [...totals.values()].sort((x, y) => x - y);
      expect([JSON.stringify([2, 2, 12]), JSON.stringify([2, 3, 12])]).toContain(JSON.stringify(sorted));
      // No title, name, host, URL, path or bundle in any line.
      const text = JSON.stringify(linked);
      for (const needle of [
        "Heron",
        "heron",
        "Kestrel",
        "kestrel",
        "planning",
        "example.org",
        "~/test",
        "test.example",
        SERIES,
        "Weekly",
        "Osprey",
      ])
        expect(text, needle).not.toContain(needle);
    }));
});

// ---------------------------------------------------------------------------------------------
// L30: labels and invariant 6
// ---------------------------------------------------------------------------------------------

// What L30 adds to a copy of the world: an employer:example project with a URL prefix under
// Heron's host, which the own moment MOM_SHARED and the employer moment both meet, and a run.
async function addWorkProject(db: TestDatabase): Promise<{ project: EntityId; anchor: string }> {
  const added = await withAdmin(db, async (owner) => {
    const project = await owner.projects.add("Wharf Ledger", {
      compartment: "employer:example",
      requestId: requestId(),
    });
    const anchor = await owner.projects.anchor(
      project,
      { kind: "url_prefix", value: "https://heron.example.org/wharf" },
      { requestId: requestId() },
    );
    return { project, anchor };
  });
  await extract(db);
  return added;
}

describe("L30: labels and invariant 6", { timeout: DB_TEST_TIMEOUT }, () => {
  it("L30: a link claim carries the item's label", () =>
    withWorld(async (db) => {
      const work = await addWorkProject(db);
      expect(await linkOf(db, ITEMS.MOM_EMPLOYER)).toEqual({
        type: "capture.anchor",
        project: work.project,
        anchor: work.anchor,
      });
      for (const name of NAMES) {
        const label = (await captureOf(db, ITEMS[name]))?.compartments;
        for (const row of await linkRows(db, ITEMS[name])) {
          expect(row.compartments, name).toEqual(label);
          expect(row.record.claim.label.compartments, name).toEqual(label);
        }
      }
      expect((await linkRows(db, ITEMS.MOM_EMPLOYER))[0]?.compartments).toEqual(["employer:example"]);
    }));

  it("L30: an own item is never linked to an employer:example project", () =>
    withWorld(async (db) => {
      const work = await addWorkProject(db);
      for (const name of NAMES.filter((one_) => one_ !== "MOM_EMPLOYER"))
        expect((await linkOf(db, ITEMS[name]))?.project, name).not.toBe(work.project);
      // The own moment the employer prefix also matches keeps its own project's link, unambiguous.
      expect(await linkOf(db, ITEMS.MOM_SHARED)).toEqual(expectedLink("MOM_SHARED"));
      // The control: the employer moment, under the project's label, is linked to it.
      expect((await linkOf(db, ITEMS.MOM_EMPLOYER))?.project).toBe(work.project);
    }));

  it("L30: an employer:example project's anchor that also matches an own item changes nothing: the item's link and every client's results equal a store without that project, hash included", async () => {
    clock.at = T;
    const without = await world.copy();
    const withWork = await world.copy();
    try {
      await extract(without);
      const work = await addWorkProject(withWork);
      expect(await linkOf(withWork, ITEMS.MOM_SHARED)).toEqual(await linkOf(without, ITEMS.MOM_SHARED));
      expect(await linksOf(withWork)).toEqual({
        ...(await linksOf(without)),
        MOM_EMPLOYER: { type: "capture.anchor", project: work.project, anchor: work.anchor },
      });
      // The own client's reads, and the own mirror's pages, hash included, are those of the store without it.
      const own = b().clients.own;
      for (const args of [{}, { type: "capture" }, { type: "capture.anchor" }]) {
        // find_facts takes no project entity; get_entity covers a project
        expect(await factsOf(withWork, own, args), JSON.stringify(args)).toEqual(await factsOf(without, own, args));
      }
      expect(await entityOf(withWork, own, b().projects.heron)).toEqual(
        await entityOf(without, own, b().projects.heron),
      );
      const plain = await mirrorPass(without, b().mirror.macOwn.token);
      const hidden = await mirrorPass(withWork, b().mirror.macOwn.token);
      expect(masked(hidden.pages)).toEqual(masked(plain.pages));
      expect(JSON.stringify(hidden.pages)).not.toContain(work.project);
      // The control: the wider client's results do differ, and hold the project's link.
      const wide = b().clients.wide;
      expect(await factsOf(withWork, wide, { type: "capture.anchor" })).not.toEqual(
        await factsOf(without, wide, { type: "capture.anchor" }),
      );
      expect(JSON.stringify((await mirrorPass(withWork, b().mirror.mac.token)).pages)).toContain(work.project);
    } finally {
      await withWork.drop();
      await without.drop();
    }
  });

  it("L30: a client not cleared for the item, or without the work view, gets no link", () =>
    withWorld(async (db) => {
      const work = await addWorkProject(db);
      const linked = (list: FactList) => list.facts.filter((fact) => fact.capture === b().capture.MOM_EMPLOYER);
      // Not cleared for employer:example: none of the employer moment's link.
      expect(linked(await factsOf(db, b().clients.own, { type: "capture.anchor" }))).toEqual([]);
      expect(linked(await factsOf(db, b().clients.own))).toEqual([]);
      // Cleared, but without the work view: no link at all. find_facts is the work view's tool
      // (TOOL_VIEW), so such a client is refused it outright, and reads no fact, link or other.
      const refused = await withReader(db, (reader) =>
        reader.findFacts(b().clients.nowork, { limit: 50, type: "capture" } as never),
      );
      expect(refused).toMatchObject({ ok: false, code: "not_permitted" });
      // The control: cleared and with the work view, it is served.
      const wide = linked(await factsOf(db, b().clients.wide, { type: "capture.anchor" }));
      expect(wide).toHaveLength(1);
      expect(wide[0]).toMatchObject({
        type: "capture.anchor",
        subject: { id: work.project },
        fields: { anchor: work.anchor },
      });
    }));
});

// ---------------------------------------------------------------------------------------------
// L31: the title card
// ---------------------------------------------------------------------------------------------

describe("L31: the title card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("L31: a title link is a capture.project claim and one agent_claim card showing the meeting's title and start and the project's name", () =>
    withWorld(async (db) => {
      const cards = await titleCards(db);
      // One for each title link, and none for the anchor links.
      expect(cards).toHaveLength(2);
      for (const [name, project] of [
        ["MTG_TITLE", "Kestrel"],
        ["MTG_CALTITLE", "Heron Survey"],
      ] as const) {
        const row = one(await linkRows(db, ITEMS[name]));
        expect(row.type, name).toBe("capture.project");
        const card = cards.find((one_) => one_.request_id === titleKeyOf(db, row.fact_key_fp));
        expect(card, name).toMatchObject({ target_kind: "claim", created_by: "system:extract", compartments: ["own"] });
        const lines = (await withAdmin(db, (owner) => owner.cards.card(card?.id as never)))?.lines ?? [];
        const item = ITEMS[name];
        const shown =
          item.kind === "meeting"
            ? [item.title, item.calendar?.title].filter((title): title is string => title !== undefined)
            : [];
        expect(
          lines.some((line) => line.from === "source" && shown.some((title) => line.text.includes(title))),
          name,
        ).toBe(true);
        // The start as Lens sent it or as an instant, with or without its milliseconds.
        const starts = [item.startedAt, instant(item.startedAt), instant(item.startedAt).replace(".000Z", "Z")];
        expect(
          lines.some((line) => line.from === "source" && starts.some((start) => line.text.includes(start))),
          name,
        ).toBe(true);
        expect(
          lines.some((line) => line.from === "code" && line.text.includes(project)),
          name,
        ).toBe(true);
        // The title is the source's, never shown as code.
        expect(
          lines.some((line) => line.from === "code" && shown.some((title) => line.text.includes(title))),
          name,
        ).toBe(false);
      }
    }));

  it("L31: unconfirmed it is in no belief, and find_facts, compiled facts and the mirror's facts section serve none of it", () =>
    withWorld(async (db) => {
      const row = one(await linkRows(db, ITEMS.MTG_CALTITLE));
      expect(await beliefsOn(db, [row.id])).toEqual([]);
      const titled = (facts: FactView[]) =>
        facts.filter((fact) => fact.type === "capture.project" || fact.capture === b().capture.MTG_CALTITLE);
      for (const args of [{}, { type: "capture" }, { type: "capture.project" }]) {
        // find_facts takes no project entity; get_entity covers a project
        expect(titled((await factsOf(db, b().clients.wide, args)).facts), JSON.stringify(args)).toEqual([]);
      }
      const heron = await entityOf(db, b().clients.wide, b().projects.heron);
      expect(heron).not.toBeNull();
      expect(titled(heron!.facts!.claims ?? [])).toEqual([]);
      expect(heron!.facts!.beliefs.filter((belief) => belief.kind === "capture_project")).toEqual([]);
      const pass = await mirrorPass(db, b().mirror.mac.token);
      const all = entries(pass.pages);
      expect(all.filter((entry) => entry.section === "facts" && entry.fact.type === "capture.project")).toEqual([]);
      expect(
        JSON.stringify(all.filter((entry) => entry.section === "facts" || entry.section === "beliefs")),
      ).not.toContain(b().capture.MTG_CALTITLE);
      // The control: the anchor links are served as facts there.
      expect(
        all.some(
          (entry) =>
            entry.section === "facts" &&
            entry.fact.type === "capture.anchor" &&
            entry.fact.capture === b().capture.MOM_HOST,
        ),
      ).toBe(true);
    }));

  it("L31: confirmed, its capture_project belief is built and served, citing it", () =>
    withWorld(async (db) => {
      const row = one(await linkRows(db, ITEMS.MTG_TITLE));
      expect(await beliefsOn(db, [row.id], WIDE_AUDIENCE)).toHaveLength(1);
      const kestrel = await entityOf(db, b().clients.wide, b().projects.kestrel);
      expect(kestrel).not.toBeNull();
      const beliefs = kestrel!.facts!.beliefs.filter((belief) => belief.kind === "capture_project");
      expect(beliefs).toHaveLength(1);
      expect(beliefs[0]?.cites.map((cite) => [cite.type, cite.capture])).toEqual([
        ["capture.project", b().capture.MTG_TITLE],
      ]);
      // Still never a fact, confirmed or not.
      expect((await factsOf(db, b().clients.wide, { type: "capture.project" })).facts).toEqual([]);
      const pass = await mirrorPass(db, b().mirror.mac.token);
      const served = entries(pass.pages).filter(
        (entry) => entry.section === "beliefs" && entry.belief.kind === "capture_project",
      );
      expect(served).toHaveLength(1);
      expect(JSON.stringify(served)).toContain(b().capture.MTG_TITLE);
      expect(
        entries(pass.pages).filter((entry) => entry.section === "facts" && entry.fact.type === "capture.project"),
      ).toEqual([]);
    }));

  it("L31: rejected, never", () =>
    withWorld(async (db) => {
      const row = one(await linkRows(db, ITEMS.MTG_CALTITLE));
      const card = (await titleCards(db)).find((one_) => one_.request_id === titleKeyOf(db, row.fact_key_fp));
      await withAdmin(db, (owner) =>
        owner.cards.decide({ cards: [card?.id as never], answer: "reject", requestId: requestId() }),
      );
      await extract(db);
      await extract(db, { generation: EXTRACT_GENERATION + 1 });
      const after = one(await linkRows(db, ITEMS.MTG_CALTITLE));
      expect(await beliefsOn(db, [row.id, after.id])).toEqual([]);
      expect(
        (await entityOf(db, b().clients.wide, b().projects.heron))!.facts!.beliefs.filter(
          (belief) => belief.kind === "capture_project",
        ),
      ).toEqual([]);
      // The control: the confirmed one beside it still builds.
      expect(await beliefsOn(db, [one(await linkRows(db, ITEMS.MTG_TITLE)).id], WIDE_AUDIENCE)).toHaveLength(1);
    }));

  it("L31: a raised generation and a new revision raise no second card, and a confirmation holds across both", () =>
    withWorld(async (db) => {
      const cards = await titleCards(db);
      const first = one(await linkRows(db, ITEMS.MTG_TITLE));
      await extract(db, { generation: EXTRACT_GENERATION + 1 });
      const raised = one(await linkRows(db, ITEMS.MTG_TITLE));
      expect(raised.fact_key_fp).toBe(first.fact_key_fp);
      expect(await titleCards(db)).toEqual(cards);
      expect(await beliefsOn(db, [raised.id], WIDE_AUDIENCE)).toHaveLength(1);

      await push(db, [
        {
          ...ITEMS.MTG_TITLE,
          revision: 1,
          segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we begin?" }],
        },
      ]);
      await drain(db);
      await extract(db, { generation: EXTRACT_GENERATION + 1 });
      const revised = one(await linkRows(db, ITEMS.MTG_TITLE));
      expect(revised.id).not.toBe(raised.id);
      expect(revised.fact_key_fp).toBe(first.fact_key_fp);
      expect(await titleCards(db)).toEqual(cards);
      expect(await beliefsOn(db, [revised.id], WIDE_AUDIENCE)).toHaveLength(1);
      const kestrel = await entityOf(db, b().clients.wide, b().projects.kestrel);
      const current = (await captureOf(db, ITEMS.MTG_TITLE))?.id;
      expect(
        kestrel!
          .facts!.beliefs.filter((belief) => belief.kind === "capture_project")
          .map((belief) => belief.cites.map((cite) => cite.capture)),
      ).toEqual([[current]]);
    }));

  it("L31: an anchor link raises no card and find_facts serves it with provenance source and the item's cap_ id", () =>
    withWorld(async (db) => {
      const keys = new Set((await titleCards(db)).map((card) => card.request_id));
      for (const name of NAMES) {
        for (const row of await linkRows(db, ITEMS[name]))
          expect(keys.has(titleKeyOf(db, row.fact_key_fp)), name).toBe(row.type === "capture.project");
      }
      const served = (await factsOf(db, b().clients.wide, { type: "capture.anchor" })).facts;
      const host = served.filter((fact) => fact.capture === b().capture.MOM_HOST);
      expect(host).toHaveLength(1);
      expect(host[0]).toMatchObject({
        type: "capture.anchor",
        capture: b().capture.MOM_HOST,
        segment: null,
        message: null,
        document: null,
        page: null,
        provenance: "source",
        agentReported: false,
        fields: { anchor: b().anchors.host },
        subject: { id: b().projects.heron, kind: "project" },
      });
      // By the parent too, and every anchor link of the world is there.
      const byParent = (await factsOf(db, b().clients.wide, { type: "capture" })).facts.filter(
        (fact) => fact.type === "capture.anchor",
      );
      const anchored = NAMES.filter((name) => EXPECTED[name]?.type === "capture.anchor").map(
        (name) => b().capture[name],
      );
      expect(new Set(byParent.map((fact) => fact.capture))).toEqual(new Set(anchored));
    }));
});

// ---------------------------------------------------------------------------------------------
// L32: deletion and the owner's changes
// ---------------------------------------------------------------------------------------------

const forgetOf = (keys: string[]): ForgetItem => ({ kind: "forget", key: `forget:${ulid()}`, keys }) as ForgetItem;

describe("L32: deletion and the owner's changes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("L32: pi erase item cap_, a forget applied by pi erase settle, a restore's replay and a new revision each remove the item's link and its belief in that transaction, and the next sync_mirror call removes their entries first", async () => {
    clock.at = T;
    const box = await world.copy();
    let dump: TestDatabase | undefined;
    try {
      const mac = b().mirror.mac;
      const removed = (page: MirrorPage) => page.removals.map((removal) => removal.projection);
      const gone = async (db: TestDatabase, ids: string[]) =>
        admin(db, "select id from knowledge.claims where id = any($1)", [ids]);
      let cursor = (await mirrorPass(box, mac.token)).cursor;

      // A new revision of "Kestrel planning": its confirmed link and its belief go with the
      // earlier revision, in the drain's transaction, before any run.
      const first = one(await linkRows(box, ITEMS.MTG_TITLE));
      expect(await beliefsOn(box, [first.id], WIDE_AUDIENCE)).toHaveLength(1);
      const onFirst = await liveEntriesOn(box, mac.id, b().evidence.MTG_TITLE);
      expect(onFirst.length).toBeGreaterThan(0);
      await push(box, [
        {
          ...ITEMS.MTG_TITLE,
          revision: 1,
          segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we begin?" }],
        },
      ]);
      await drain(box);
      expect(await gone(box, [first.id])).toEqual([]);
      expect(await beliefsOn(box, [first.id])).toEqual([]);
      const afterRevision = await nextPage(box, mac.token, cursor);
      expect(removed(afterRevision)).toEqual(expect.arrayContaining(onFirst));
      // The lane links the new revision under the same fact key, and the confirmation holds.
      await extract(box);
      const second = one(await linkRows(box, ITEMS.MTG_TITLE));
      expect(second.fact_key_fp).toBe(first.fact_key_fp);
      expect(await beliefsOn(box, [second.id], WIDE_AUDIENCE)).toHaveLength(1);
      // The next pass, once due, serves the new revision's entries.
      clock.at = T + 2 * HOUR;
      cursor = (await mirrorPass(box, mac.token, afterRevision.cursor)).cursor;

      // pi erase item: the link and its belief again, and the entries resting on them.
      const current = await captureOf(box, ITEMS.MTG_TITLE);
      const onSecond = await liveEntriesOn(box, mac.id, current?.evidence_id ?? "");
      expect(onSecond.length).toBeGreaterThan(0);
      const erased = await pi(["erase", "item", current?.id ?? ""], adminEnv(box));
      expect(erased.exit, erased.stderr).toBe(0);
      expect(await gone(box, [second.id])).toEqual([]);
      expect(await beliefsOn(box, [second.id])).toEqual([]);
      const afterErase = await nextPage(box, mac.token, cursor);
      expect(removed(afterErase)).toEqual(expect.arrayContaining(onSecond));

      // A forget from the Mac, settled by pi erase settle; the dump is taken before it settles.
      const hostLink = one(await linkRows(box, ITEMS.MOM_HOST));
      const onHost = await liveEntriesOn(box, mac.id, b().evidence.MOM_HOST);
      expect(onHost.length).toBeGreaterThan(0);
      await push(box, [forgetOf([ITEMS.MOM_HOST.key])]);
      dump = await copyTestDatabase(box);
      const settled = await pi(["erase", "settle"], adminEnv(box));
      expect(settled.exit, settled.stderr).toBe(0);
      expect(JSON.parse(settled.stdout)).toMatchObject({ settled: 1, failed: 0 });
      expect(await gone(box, [hostLink.id])).toEqual([]);
      const afterForget = await nextPage(box, mac.token, afterErase.cursor);
      expect(removed(afterForget)).toEqual(expect.arrayContaining(onHost));

      // The box restored from the dump, beside the journal it kept: the replay removes the link again.
      expect(one(await linkRows(dump, ITEMS.MOM_HOST)).id).toBe(hostLink.id);
      expect(await withAdmin(dump, (owner) => owner.erasure.replayErasures(), journalPath(box.keyFile))).toMatchObject({
        applied: 1,
      });
      expect(await gone(dump, [hostLink.id, second.id])).toEqual([]);
      expect(await beliefsOn(dump, [first.id, second.id])).toEqual([]);

      // The control: an item none of these touched keeps its link.
      expect(await linkOf(box, ITEMS.MOM_LONG)).toEqual(expectedLink("MOM_LONG"));
    } finally {
      await dump?.drop();
      await box.drop();
    }
  });

  it("L32: pi project anchor of a device anchor links, after the next pi extract, exactly the matching items within the project's compartments, and leaves an item that now meets two projects' anchors with no link", () =>
    withWorld(async (db) => {
      const before = await linksOf(db);
      const teams = await pi(
        ["project", "anchor", b().projects.kestrel, "--url", "https://wiki.example.org/teams"],
        adminEnv(db),
      );
      expect(teams.exit, teams.stderr).toBe(0);
      const anchor = teams.stdout.trim();
      expect(anchor).toMatch(/^pan_/);
      const wharf = await pi(
        ["project", "anchor", b().projects.kestrel, "--url", "https://heron.example.org/wharf"],
        adminEnv(db),
      );
      expect(wharf.exit, wharf.stderr).toBe(0);
      // The matching items within the project's compartments are set waiting; nothing else is.
      for (const name of NAMES) {
        const expected = ["MOM_URL", "MOM_INSIDE", "MOM_SHARED"].includes(name);
        expect(await waitingOf(db, ITEMS[name]), name).toBe(expected);
      }
      await extract(db);
      const after = await linksOf(db);
      // MOM_INSIDE meets Kestrel's prefix alone; MOM_URL and MOM_SHARED now meet two projects'.
      expect(after.MOM_INSIDE).toEqual({ type: "capture.anchor", project: b().projects.kestrel, anchor });
      expect(after.MOM_URL).toBeNull();
      expect(after.MOM_SHARED).toBeNull();
      // The employer moment, outside the project's compartments, is untouched; so is every other item.
      expect(after).toEqual({ ...before, MOM_INSIDE: after.MOM_INSIDE, MOM_URL: null, MOM_SHARED: null });
      expect(after.MOM_EMPLOYER).toBeNull();
    }));

  it("L32: pi project unanchor removes the links resting on the anchor, and the next run links each of those items by another live anchor or its title", () =>
    withWorld(async (db) => {
      const before = await linksOf(db);
      const lifted = await pi(["project", "unanchor", b().anchors.host], adminEnv(db));
      expect(lifted.exit, lifted.stderr).toBe(0);
      // At once, before any run: the links resting on the anchor are gone, and nothing else.
      const resting = NAMES.filter((name) => before[name]?.anchor === b().anchors.host);
      expect(resting.sort()).toEqual(["MOM_HOST", "MOM_LONG", "MOM_SHARED", "MTG_BROWSER"].sort());
      const now = await linksOf(db);
      for (const name of NAMES) expect(now[name], name).toEqual(resting.includes(name) ? null : before[name]);
      await extract(db);
      const after = await linksOf(db);
      // The browser meeting by its title, the moment under Kestrel's prefix by that live anchor.
      expect(after.MTG_BROWSER).toEqual({ type: "capture.project", project: b().projects.kestrel, anchor: null });
      expect(after.MOM_AMBIG).toEqual({
        type: "capture.anchor",
        project: b().projects.kestrel,
        anchor: b().anchors.kestrelUrl,
      });
      for (const name of ["MOM_HOST", "MOM_LONG", "MOM_SHARED"] as const) expect(after[name], name).toBeNull();
      expect(after.MOM_URL).toEqual(before.MOM_URL);
    }));

  it("L32: both answer extract_running while a run holds the lock", () =>
    withWorld(async (db) => {
      const count = async () =>
        (
          await admin<{ n: number }>(
            db,
            "select (select count(*) from knowledge.owner_decisions) + (select count(*) from knowledge.project_anchors where lifted_at is null) as n",
          )
        )[0]?.n;
      const before = { count: await count(), links: await linksOf(db) };
      const holder = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
      try {
        const ran = await holder.withExtractLock(async () => {
          for (const argv of [
            ["project", "anchor", b().projects.kestrel, "--host", "kestrel.example.org"],
            ["project", "unanchor", b().anchors.host],
          ]) {
            const result = await pi(argv, adminEnv(db));
            expect(result.exit, argv.join(" ")).toBe(1);
            expect(events(result.stderr), argv.join(" ")).toContainEqual({
              event: "command_failed",
              code: "extract_running",
            });
          }
          return "held";
        });
        expect(ran).toBe("held");
      } finally {
        await holder.close();
      }
      expect({ count: await count(), links: await linksOf(db) }).toEqual(before);
      // The control: with the lock free, both are taken.
      expect(
        (await pi(["project", "anchor", b().projects.kestrel, "--host", "kestrel.example.org"], adminEnv(db))).exit,
      ).toBe(0);
      expect((await pi(["project", "unanchor", b().anchors.host], adminEnv(db))).exit).toBe(0);
    }));

  it("L32: neither leads to a model call for an item with a saved call or with none", () =>
    withWorld(async (db) => {
      // The lanes' first run saves the calls of the long meeting and the long moment.
      const first = await extract(db, { meetings: true, moments: true });
      expect([...first.asked].sort()).toEqual([b().evidence.MTG_APP, b().evidence.MOM_LONG].sort());
      expect((await pi(["project", "unanchor", b().anchors.host], adminEnv(db))).exit).toBe(0);
      expect(await waitingOf(db, ITEMS.MOM_LONG)).toBe(true);
      expect((await extract(db, { meetings: true, moments: true })).asked).toEqual([]);
      const again = await pi(["project", "anchor", b().projects.heron, "--host", "heron.example.org"], adminEnv(db));
      expect(again.exit, again.stderr).toBe(0);
      expect(await waitingOf(db, ITEMS.MOM_LONG)).toBe(true);
      expect((await extract(db, { meetings: true, moments: true })).asked).toEqual([]);
      // And with the switches unset, an item with no saved call makes none either.
      expect((await pi(["project", "anchor", b().projects.heron, "--app", MEET.bundle], adminEnv(db))).exit).toBe(0);
      expect((await extract(db)).asked).toEqual([]);
      // The links are the anchors' again.
      expect((await linkOf(db, ITEMS.MOM_LONG))?.project).toBe(b().projects.heron);
    }));

  it("L32: a link to a project closed since goes when its item is committed again", () =>
    withWorld(async (db) => {
      const closed = await pi(["project", "close", b().projects.heron], adminEnv(db));
      expect(closed.exit, closed.stderr).toBe(0);
      // Closing removes nothing: the link stands.
      expect(await linkOf(db, ITEMS.MOM_HOST)).toEqual(expectedLink("MOM_HOST"));
      await extract(db);
      expect(await linkOf(db, ITEMS.MOM_HOST)).toEqual(expectedLink("MOM_HOST"));
      // Committed again, as a new revision, it is linked to an active project only.
      await push(db, [{ ...ITEMS.MOM_HOST, revision: 1 }]);
      await drain(db);
      await extract(db);
      expect(await linkOf(db, ITEMS.MOM_HOST)).toBeNull();
      // The control: the item under Kestrel's prefix and Heron's host is now Kestrel's alone once committed again.
      await push(db, [{ ...ITEMS.MOM_AMBIG, revision: 1 }]);
      await drain(db);
      await extract(db);
      expect(await linkOf(db, ITEMS.MOM_AMBIG)).toEqual({
        type: "capture.anchor",
        project: b().projects.kestrel,
        anchor: b().anchors.kestrelUrl,
      });
    }));
});

// MEETING_MIN_CHARS and MOMENT_MIN_CHARS are what make the two long items the lanes' calls.
it("the world's long meeting and long moment are the only items long enough for the lanes", () => {
  const meetingChars = (item: MeetingItem) =>
    item.segments.reduce((total, segment) => total + [...segment.text].length + 1, 0);
  for (const name of MEETING_NAMES)
    expect(meetingChars(ITEMS[name] as MeetingItem) >= MEETING_MIN_CHARS, name).toBe(name === "MTG_APP");
  for (const name of MOMENT_NAMES)
    expect([...(ITEMS[name] as MomentItem).text].length >= MOMENT_MIN_CHARS, name).toBe(name === "MOM_LONG");
});
