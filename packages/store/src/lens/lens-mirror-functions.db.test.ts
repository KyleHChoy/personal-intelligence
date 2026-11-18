import { MIRROR_TEMPLATES, type MirrorSection } from "@intelligence/contracts/personal";
import { afterAll, describe, expect, it } from "vitest";
import { RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import { insertClient, sha256Hex, testId } from "../test-support/clients.ts";
import { asClaimsOwner, one, type Query, readAs, refusal, session } from "../test-support/connections.ts";
import {
  copiesOf,
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";

// The mirror migration's five functions, called in SQL as their roles. The mirror clients and their
// sessions are hand-written inserts; the mirror rows a test plants are written as pi_owner, as the definer
// functions write them; no reader is imported. One world is built once and copied for each test. Every
// refusal has its positive control in the same test.
//
// The calls follow the reader's protocol as the spec states it: a pass starts at `entities`, with
// a null cursor or the cursor of a completed pass, and walks the five sections in order; each
// call presents the cursor the one before it was issued, and scans from where that cursor stands.
// A call that reached its section's end (last_key null) leaves its cursor at the next section's
// start, and one that stopped at a key leaves it after that key (policy.mirror_cursor's test
// states this). The entries a call hands in are among the keys it found, in its range.

const TIMEOUT = 120_000;
const OWN = ["own"];
const WORK = ["employer:example"];
// The wider clearance, sorted by code point, as an audience is.
const BOTH = ["employer:example", "own"];
const T1 = "lens_mirror@1";
// The database holds no list of versions: the reader chooses one from its own list, which a test
// may hand it (gate test L36).
const T2 = "lens_mirror@2";
const SECTIONS: readonly MirrorSection[] = ["entities", "beliefs", "facts", "events", "captures"];
const CAPS = new Map<string, number>(
  (MIRROR_TEMPLATES.find((template) => template.name === T1)?.sections ?? []).map((section) => [
    section.name,
    section.cap,
  ]),
);
const AT = "2026-09-01T00:00:00Z";
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
// A 64-character lower-case hexadecimal value, made from `seed`: states, tokens, fact keys and
// evidence ids no source holds.
const stamp = (seed: string): string => sha256Hex(`mirror ${seed}`);
const sorted = (values: readonly string[] | null | undefined): string[] => [...(values ?? [])].sort();
const momentKey = (): string => `moment:${testId("k").slice(2)}`;

// ---------------------------------------------------------------------------------------------
// The world: two mirror clients, one cleared for `own` and one for `own` and `employer:example`,
// a client without sync_mirror, and source rows of every section under each compartment.
// ---------------------------------------------------------------------------------------------

type Client = { id: string; token: string; session: string };
type Belief = { id: string; fact: string; evidence: string[]; support: string[]; compartments: string[] };
type Fact = { claim: string; evidence: string; fact: string; compartments: string[] };
type SourceEvent = { id: string; evidence: string; participants: string[]; compartments: string[] };
type Capture = { id: string; evidence: string; compartments: string[] };
type World = {
  narrow: Client;
  wide: Client;
  toolless: Client;
  // Four people under `own`, in key order, and one known only under `employer:example`.
  people: readonly [string, string, string, string];
  hiddenPerson: string;
  // A project under `own`, with a device anchor under `own` and one under `employer:example`.
  project: string;
  anchor: string;
  hiddenAnchor: string;
  // A belief of the `own` audience; one under `own` of the wider audience; one under
  // `employer:example`.
  belief: Belief;
  otherAudience: Belief;
  hiddenBelief: Belief;
  fact: Fact;
  hiddenFact: Fact;
  event: SourceEvent;
  hiddenEvent: SourceEvent;
  capture: Capture;
  hiddenCapture: Capture;
};

const seal = (db: TestDatabase, compartments: string[], table: string, id: string, column: string, value: string) =>
  sealRow(db.keys, compartments[0] ?? "own", { table, id, column }, value);

// As pi_owner, which the definer functions run as, committed.
const owner = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values: unknown[] = []): Promise<Row[]> =>
  session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    return query<Row>(text, values);
  });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// An evidence row of the compartments, on an account of its own.
async function evidenceIn(db: TestDatabase, query: Query, compartments: string[]): Promise<string> {
  const seed = seeder(db, query);
  return seed.evidence(compartments, await seed.sourceAccount(compartments), await seed.blob(compartments));
}

let claims = 0;
// A claim on an evidence row with a fact key, as the pipeline writes one: its id hashes the
// extractor generation, so a raised generation is a new id on the same key.
async function claimOn(
  db: TestDatabase,
  query: Query,
  evidenceId: string,
  factKey: string,
  compartments: string[],
  generation = 1,
): Promise<string> {
  claims += 1;
  const id = fingerprint(db.keys, "claim", sha256Hex(`mirror claim ${claims} ${evidenceId} ${generation}`));
  await query(
    `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, content_enc)
     values ($1, $2, 'commitment', $3, $4, $5, '{m-owner}', $6, $7)`,
    [
      id,
      evidenceId,
      AT,
      factKey,
      generation,
      compartments,
      seal(db, compartments, "knowledge.claims", id, "content_enc", "{}"),
    ],
  );
  return id;
}

// A belief of an audience, as the mirror serves it: its id, and its support one claim on an
// evidence row of its compartments, from which serve_mirror reads its label.
async function beliefIn(
  db: TestDatabase,
  query: Query,
  audience: string[],
  compartments: string[],
  factKey?: string,
): Promise<Belief> {
  const evidence = await evidenceIn(db, query, compartments);
  const fact = factKey ?? fingerprint(db.keys, "fact", sha256Hex(`mirror belief ${evidence}`));
  const support = await claimOn(db, query, evidence, fact, compartments);
  const id = `blf_${sha256Hex(`mirror belief ${fact} ${audience.join(",")}`).slice(0, 40)}`;
  return { id, fact, evidence: [evidence], support: [support], compartments };
}

// A live device anchor of a project, its value sealed under its compartments.
async function anchorIn(
  db: TestDatabase,
  query: Query,
  project: string,
  compartments: string[],
  kind: string,
): Promise<string> {
  const ruling = testId("rul");
  await query(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'release', 0, '{}', '{}', $3, '{own}')",
    [ruling, testId("req"), AT],
  );
  const id = testId("pan");
  await query(
    `insert into knowledge.project_anchors (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments, value_enc)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      project,
      kind,
      stamp(`anchor ${id}`),
      ruling,
      AT,
      compartments,
      seal(
        db,
        compartments,
        "knowledge.project_anchors",
        id,
        "value_enc",
        JSON.stringify({ kind, value: `test.anchor.${id}` }),
      ),
    ],
  );
  return id;
}

async function eventIn(
  db: TestDatabase,
  query: Query,
  compartments: string[],
  participants: string[],
): Promise<SourceEvent> {
  const evidence = await evidenceIn(db, query, compartments);
  const id = await seeder(db, query).event(compartments, evidence);
  for (const entity of participants) {
    await query(
      "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
      [id, entity, compartments],
    );
  }
  return { id, evidence, participants, compartments };
}

const sessionFor = async (db: TestDatabase, clientId: string, compartments: string[]): Promise<string> => {
  const id = testId("ses");
  await owner(db, "insert into ledger.sessions (id, client_id, compartments) values ($1, $2, $3)", [
    id,
    clientId,
    compartments,
  ]);
  return id;
};

async function build(db: TestDatabase): Promise<World> {
  const made = await session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const narrow = await seed.lensDevice({ mirror: OWN });
    const wide = await seed.lensDevice({ mirror: BOTH });
    const people: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const id = await seed.entity("person");
      await seed.account(OWN, id);
      people.push(id);
    }
    const [p1, p2, p3, p4] = people.sort();
    if (p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined) throw new Error("four people");
    const hiddenPerson = await seed.entity("person");
    await seed.account(WORK, hiddenPerson);
    const project = await seed.project(OWN);
    const factKey = (seedText: string) => fingerprint(db.keys, "fact", sha256Hex(`mirror fact ${seedText}`));
    const factIn = async (compartments: string[], seedText: string): Promise<Fact> => {
      const evidence = await evidenceIn(db, query, compartments);
      const fact = factKey(seedText);
      return { claim: await claimOn(db, query, evidence, fact, compartments), evidence, fact, compartments };
    };
    const captureIn = async (compartments: string[]): Promise<Capture> => {
      const stored = await seed.capture(compartments, narrow);
      return { id: stored.id, evidence: stored.evidenceId, compartments };
    };
    return {
      devices: { narrow, wide },
      people: [p1, p2, p3, p4] as const,
      hiddenPerson,
      project,
      anchor: await anchorIn(db, query, project, OWN, "app"),
      hiddenAnchor: await anchorIn(db, query, project, WORK, "host"),
      belief: await beliefIn(db, query, OWN, OWN),
      otherAudience: await beliefIn(db, query, BOTH, OWN),
      hiddenBelief: await beliefIn(db, query, BOTH, WORK),
      fact: await factIn(OWN, "visible"),
      hiddenFact: await factIn(WORK, "hidden"),
      event: await eventIn(db, query, OWN, [p1]),
      hiddenEvent: await eventIn(db, query, WORK, [hiddenPerson]),
      capture: await captureIn(OWN),
      hiddenCapture: await captureIn(WORK),
    };
  });
  const toolless = await insertClient(db, "mirror-toolless", OWN);
  const { devices, ...rest } = made;
  return {
    ...rest,
    narrow: { ...devices.narrow.mirror, session: await sessionFor(db, devices.narrow.mirror.id, OWN) },
    wide: { ...devices.wide.mirror, session: await sessionFor(db, devices.wide.mirror.id, BOTH) },
    toolless: { id: toolless.id, token: toolless.token, session: await sessionFor(db, toolless.id, OWN) },
  };
}

let world: World | undefined;
const copies = copiesOf(async () => {
  const db = await createTestDatabase();
  try {
    world = await build(db);
  } catch (error) {
    await db.drop();
    throw error;
  }
  return db;
});
afterAll(() => copies.drop());

const theWorld = (): World => {
  if (world === undefined) throw new Error("the world is built at the first copy");
  return world;
};
// A test on a copy of the world of its own, dropped when it settles.
const inCopy = (fn: (db: TestDatabase, w: World) => Promise<void>) => async (): Promise<void> => {
  const db = await copies.copy();
  try {
    await fn(db, theWorld());
  } finally {
    await db.drop();
  }
};

// ---------------------------------------------------------------------------------------------
// Entries, as the reader hands them to serve_mirror
// ---------------------------------------------------------------------------------------------

const projectionId = (
  db: TestDatabase,
  clientId: string,
  audience: readonly string[],
  template: string,
  section: MirrorSection,
  key: string,
): string =>
  `mir_${fingerprint(db.keys, "mirror_projection", [clientId, [...audience].sort().join(","), template, section, key].join("\n")).slice(0, 40)}`;

type Viewer = { db: TestDatabase; client: Client; audience: readonly string[]; template: string };
const viewer = (db: TestDatabase, client: Client, audience: readonly string[], template = T1): Viewer => ({
  db,
  client,
  audience,
  template,
});

type Entry = {
  id: string;
  key: string;
  fact_key_fp: string | null;
  evidence_ids: string[];
  entity_ids: string[];
  anchor_ids: string[];
  compartments: string[];
  state: string;
  token: string;
  support_ids?: string[];
};
// Its state and token are made from its section and key, so the same entry built twice is the
// same; a test that changes an entry's values gives it a new state.
const entry = (who: Viewer, section: MirrorSection, key: string, parts: Partial<Entry>): Entry => ({
  id: projectionId(who.db, who.client.id, who.audience, who.template, section, key),
  key,
  fact_key_fp: null,
  evidence_ids: [],
  entity_ids: [],
  anchor_ids: [],
  compartments: OWN,
  state: stamp(`state ${section} ${key}`),
  token: stamp(`token ${section} ${key}`),
  ...parts,
});
// An entity's entity id is its own; a person here has no alias, so no evidence.
const personEntry = (who: Viewer, id: string, over: Partial<Entry> = {}): Entry =>
  entry(who, "entities", id, { entity_ids: [id], ...over });
const projectEntry = (who: Viewer, w: World, anchors: string[], over: Partial<Entry> = {}): Entry =>
  entry(who, "entities", w.project, { entity_ids: [w.project], anchor_ids: anchors, ...over });
const beliefEntry = (who: Viewer, belief: Belief, over: Partial<Entry> = {}): Entry =>
  entry(who, "beliefs", belief.id, {
    fact_key_fp: belief.fact,
    evidence_ids: belief.evidence,
    support_ids: belief.support,
    compartments: belief.compartments,
    ...over,
  });
const factKeyOf = (fact: Fact): string => `${fact.evidence}:${fact.fact}`;
const factEntry = (who: Viewer, fact: Fact, over: Partial<Entry> = {}): Entry =>
  entry(who, "facts", factKeyOf(fact), {
    fact_key_fp: fact.fact,
    evidence_ids: [fact.evidence],
    compartments: fact.compartments,
    ...over,
  });
const eventEntry = (who: Viewer, event: SourceEvent, over: Partial<Entry> = {}): Entry =>
  entry(who, "events", event.id, {
    evidence_ids: [event.evidence],
    entity_ids: event.participants,
    compartments: event.compartments,
    ...over,
  });
const captureEntry = (who: Viewer, capture: Capture, over: Partial<Entry> = {}): Entry =>
  entry(who, "captures", capture.id, { evidence_ids: [capture.evidence], compartments: capture.compartments, ...over });

// ---------------------------------------------------------------------------------------------
// Calls, pages and the rows they leave
// ---------------------------------------------------------------------------------------------

const SERVE =
  "select * from policy.serve_mirror($1, $2, $3, $4::text[], $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12)";

type Answer = {
  kind: string;
  projection_id: string | null;
  entry_key: string | null;
  state: string | null;
  reason: string | null;
  ended_at: Date | null;
  capture_key: string | null;
  new_cursor_id: string | null;
  pass: number | null;
  pass_complete: boolean | null;
  truncated: boolean | null;
};
type Page = {
  rows: Answer[];
  kinds: string[];
  removals: Answer[];
  erased: string[];
  entries: Answer[];
  cursor: Answer;
};
// One call. `found` defaults to the keys of the entries built; `token` and `session` to the
// mirror's client's; the cap to the section's in lens_mirror@1.
type Call = {
  section: MirrorSection;
  after?: string | null;
  last?: string | null;
  found?: string[];
  entries?: Entry[];
  rebuild?: boolean;
  limit?: number;
  cap?: number;
  erasedDone?: string[];
  template?: string;
  session?: string;
  token?: string | null;
};

const valuesOf = (client: Client, cursor: string | null, call: Call): unknown[] => {
  const entries = call.entries ?? [];
  return [
    call.session ?? client.session,
    call.template ?? T1,
    cursor,
    call.erasedDone ?? [],
    call.section,
    call.after ?? null,
    call.last ?? null,
    call.found ?? entries.map((each) => each.key),
    JSON.stringify(entries),
    call.rebuild ?? false,
    call.limit ?? 500,
    call.cap ?? CAPS.get(call.section) ?? 1_000,
  ];
};

// Each row is one kind, every column the kind does not name null, in the order removals,
// erased keys, entries, and the cursor last.
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  removal: ["projection_id", "reason", "ended_at"],
  erased: ["capture_key"],
  entry: ["projection_id", "entry_key", "state"],
  cursor: ["new_cursor_id", "pass", "pass_complete", "truncated"],
};
const ANSWER_COLUMNS = [
  "projection_id",
  "entry_key",
  "state",
  "reason",
  "ended_at",
  "capture_key",
  "new_cursor_id",
  "pass",
  "pass_complete",
  "truncated",
];
const RANK: Readonly<Record<string, number>> = { removal: 0, erased: 1, entry: 2, cursor: 3 };
const wellFormed = (row: Answer): boolean => {
  const named = COLUMNS[row.kind];
  return (
    named !== undefined &&
    ANSWER_COLUMNS.every((column) => ((row as Record<string, unknown>)[column] !== null) === named.includes(column))
  );
};

function pageOf(rows: Answer[]): Page {
  const kinds = rows.map((row) => row.kind);
  expect(
    kinds.every((kind, index) => index === 0 || (RANK[kinds[index - 1] ?? ""] ?? 9) <= (RANK[kind] ?? -1)),
    kinds.join(" "),
  ).toBe(true);
  for (const row of rows) expect(wellFormed(row), JSON.stringify(row)).toBe(true);
  const cursor = rows.at(-1);
  if (cursor?.kind !== "cursor" || kinds.filter((kind) => kind === "cursor").length !== 1)
    throw new Error(`a page ends with its one cursor: ${kinds.join(" ")}`);
  return {
    rows,
    kinds,
    removals: rows.filter((row) => row.kind === "removal"),
    erased: rows.filter((row) => row.kind === "erased").map((row) => row.capture_key ?? ""),
    entries: rows.filter((row) => row.kind === "entry"),
    cursor,
  };
}

// A client's mirror as the reader drives it: each call presents the cursor the last one issued,
// unless it is handed another.
type Mirror = { client: Client; cursor: string | null; call(call: Call, from?: string | null): Promise<Page> };
function mirror(db: TestDatabase, client: Client): Mirror {
  const m: Mirror = {
    client,
    cursor: null,
    async call(call, from) {
      const at = from === undefined ? m.cursor : from;
      const rows = await readAs(db, call.token === undefined ? client.token : call.token, (query) =>
        query<Answer>(SERVE, valuesOf(client, at, call)),
      );
      const page = pageOf(rows);
      m.cursor = page.cursor.new_cursor_id;
      return page;
    },
  };
  return m;
}

type BySection<T> = Partial<Record<MirrorSection, T>>;
// One whole pass: each section to its end, in order, with the entries given built and the keys
// in `keep` found too (their tokens equal, so not built).
async function wholePass(
  m: Mirror,
  entries: BySection<Entry[]> = {},
  keep: BySection<string[]> = {},
  call: Partial<Call> = {},
): Promise<Page[]> {
  const pages: Page[] = [];
  for (const section of SECTIONS) {
    const built = entries[section] ?? [];
    pages.push(
      await m.call({
        ...call,
        section,
        entries: built,
        found: [...new Set([...built.map((each) => each.key), ...(keep[section] ?? [])])],
      }),
    );
  }
  return pages;
}
// The rest of a pass: each section after `after`, to its end, finding only the keys in `keep`.
async function finish(
  m: Mirror,
  after: MirrorSection,
  keep: BySection<string[]> = {},
  call: Partial<Call> = {},
): Promise<Page[]> {
  const pages: Page[] = [];
  for (const section of SECTIONS.slice(SECTIONS.indexOf(after) + 1))
    pages.push(await m.call({ ...call, section, found: keep[section] ?? [] }));
  return pages;
}

type MirrorRow = {
  id: string;
  client_id: string;
  audience: string[];
  template: string;
  section: string;
  entry_key: string;
  fact_key_fp: string | null;
  sent_state: string;
  confirmed_state: string | null;
  confirmed_token: string | null;
  evidence_ids: string[];
  entity_ids: string[];
  compartments: string[];
  first_served_at: Date;
  last_sent_at: Date;
  ended_at: Date | null;
  reason: string | null;
  end_sent_at: Date | null;
  end_confirmed_at: Date | null;
  tainted_at: Date | null;
  last_tainted_at: Date | null;
};
const rowsOf = (db: TestDatabase, clientId: string): Promise<MirrorRow[]> =>
  admin<MirrorRow>(db, "select * from ledger.mirror_entries where client_id = $1 order by id", [clientId]);
const rowOf = async (db: TestDatabase, id: string): Promise<MirrorRow> =>
  one(await admin<MirrorRow>(db, "select * from ledger.mirror_entries where id = $1", [id]));
const live = (row: MirrorRow): boolean => row.ended_at === null && row.reason === null && row.tainted_at === null;

// Every row of the mirror's tables, the erased keys and the erasure links, as one text: a refused
// call leaves it as it was.
const everything = async (db: TestDatabase): Promise<string> =>
  one(
    await admin<{ text: string }>(
      db,
      `select json_build_object(
         'entries', (select coalesce(json_agg(e order by e.id), '[]'::json) from ledger.mirror_entries e),
         'cursors', (select coalesce(json_agg(c order by c.id), '[]'::json) from ledger.mirror_cursors c),
         'erasures', (select coalesce(json_agg(x order by x.id), '[]'::json) from ledger.capture_erasures x),
         'links', (select count(*) from ledger.erasure_exposures))::text as text`,
    ),
  ).text;

// A mirror row as the definer functions leave one, planted as pi_owner. `token` makes it
// confirmed (its sent state and that token); `ended` ends it.
type Plant = {
  client: string;
  audience: readonly string[];
  section: MirrorSection;
  key: string;
  template?: string;
  evidence?: string[];
  entities?: string[];
  token?: string;
  firstServed?: string;
  ended?: { at: string; reason: "withdrawn" | "replaced" | "dropped"; sent?: string; told?: string };
};
async function plant(db: TestDatabase, row: Plant): Promise<string> {
  const template = row.template ?? T1;
  const id = projectionId(db, row.client, row.audience, template, row.section, row.key);
  const sent = stamp(`sent ${id}`);
  await owner(
    db,
    `insert into ledger.mirror_entries (id, client_id, audience, template, section, entry_key, fact_key_fp, sent_state, confirmed_state, confirmed_token,
       evidence_ids, entity_ids, compartments, first_served_at, last_sent_at, ended_at, reason, end_sent_at, end_confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '{own}', $13, $13, $14, $15, $16, $17)`,
    [
      id,
      row.client,
      [...row.audience],
      template,
      row.section,
      row.key,
      row.section === "beliefs" || row.section === "facts" ? stamp(`fact ${row.key}`) : null,
      sent,
      row.token === undefined ? null : sent,
      row.token ?? null,
      row.evidence ?? [],
      row.entities ?? [],
      row.firstServed ?? daysAgo(1),
      row.ended?.at ?? null,
      row.ended?.reason ?? null,
      row.ended?.sent ?? null,
      row.ended?.told ?? null,
    ],
  );
  return id;
}
// A key of the section's form that names no source row.
const keyIn = (section: MirrorSection): string => {
  switch (section) {
    case "entities":
      return testId("ent");
    case "events":
      return testId("evt");
    case "captures":
      return testId("cap");
    case "beliefs":
      return `blf_${stamp(testId("b")).slice(0, 40)}`;
    case "facts":
      return `${stamp(testId("e"))}:${stamp(testId("f"))}`;
  }
};

const TAINT = "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[]) as n";
const CURSOR = "select * from policy.mirror_cursor($1, $2)";
const TOKENS = "select entry_key, confirmed_token from policy.mirror_tokens($1, $2, $3, $4, $5)";
type Standing = {
  standing: string;
  pass: number | null;
  rebuild: boolean | null;
  section: string | null;
  after_key: string | null;
  completed_at: Date | null;
  rebuilt_at: Date | null;
};
const standingOf = async (db: TestDatabase, client: Client, cursor: string | null): Promise<Standing> =>
  one(await readAs(db, client.token, (query) => query<Standing>(CURSOR, [client.session, cursor])));
const tokensOf = (
  db: TestDatabase,
  client: Client,
  template: string,
  section: string,
  after: string | null,
  last: string | null,
): Promise<{ entry_key: string; confirmed_token: string }[]> =>
  readAs(db, client.token, (query) =>
    query<{ entry_key: string; confirmed_token: string }>(TOKENS, [client.session, template, section, after, last]),
  );
const STALE: Standing = {
  standing: "stale",
  pass: null,
  rebuild: null,
  section: null,
  after_key: null,
  completed_at: null,
  rebuilt_at: null,
};

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

const FUNCTIONS: Readonly<Record<string, string>> = {
  "policy.serve_mirror(text,text,text,text[],text,text,text,text[],jsonb,boolean,integer,integer)": "pi_reader",
  "policy.mirror_cursor(text,text)": "pi_reader",
  "policy.mirror_tokens(text,text,text,text,text)": "pi_reader",
  "ledger.taint_mirror_entities(text[])": "pi_admin",
  "ledger.end_mirror(text)": "pi_admin",
};

describe("the mirror's policies and grants", { timeout: TIMEOUT }, () => {
  it(
    "each mirror table holds exactly pi_admin's select and pi_owner's cells as policies, and only pi_admin holds a privilege on it, for every role",
    inCopy(async (db) => {
      const policies = await admin<{ line: string }>(
        db,
        `select tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') as line
       from pg_policies where schemaname = 'ledger' and tablename in ('mirror_entries', 'mirror_cursors')`,
      );
      expect(policies.map((row) => row.line).sort()).toEqual(
        [
          "mirror_entries pi_admin_select SELECT pi_admin true -",
          "mirror_entries pi_owner_select SELECT pi_owner true -",
          "mirror_entries pi_owner_insert INSERT pi_owner - true",
          "mirror_entries pi_owner_update UPDATE pi_owner true true",
          "mirror_entries pi_owner_delete DELETE pi_owner true -",
          // A cursor is never updated.
          "mirror_cursors pi_admin_select SELECT pi_admin true -",
          "mirror_cursors pi_owner_select SELECT pi_owner true -",
          "mirror_cursors pi_owner_insert INSERT pi_owner - true",
          "mirror_cursors pi_owner_delete DELETE pi_owner true -",
        ].sort(),
      );
      // The privileges granted, PUBLIC's included, besides the owner's own.
      const granted = await admin<{ line: string }>(
        db,
        `select c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line
       from pg_class c cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
       where c.oid in ('ledger.mirror_entries'::regclass, 'ledger.mirror_cursors'::regclass) and a.grantee <> c.relowner`,
      );
      expect(granted.map((row) => row.line).sort()).toEqual([
        "mirror_cursors pi_admin SELECT",
        "mirror_entries pi_admin SELECT",
      ]);
      expect(
        await admin(
          db,
          "select attname from pg_attribute where attrelid in ('ledger.mirror_entries'::regclass, 'ledger.mirror_cursors'::regclass) and attacl is not null",
        ),
      ).toEqual([]);
      // What each runtime role may do, by the catalogue's own answer.
      const may = await admin<{ line: string }>(
        db,
        `select r.role || ' ' || t.name || ' ' || p.privilege as line
       from unnest($1::text[]) r(role) cross join unnest(array['ledger.mirror_entries', 'ledger.mirror_cursors']) t(name)
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(privilege)
       where has_table_privilege(r.role, t.name, p.privilege)`,
        [[...RUNTIME_ROLES]],
      );
      expect(may.map((row) => row.line).sort()).toEqual([
        "pi_admin ledger.mirror_cursors SELECT",
        "pi_admin ledger.mirror_entries SELECT",
      ]);
      // The control for that reading: the owner, whose cells the policies are, holds them all.
      expect(
        one(
          await admin<{ ok: boolean }>(
            db,
            "select has_table_privilege('pi_owner', 'ledger.mirror_entries', 'UPDATE') as ok",
          ),
        ).ok,
      ).toBe(true);
    }),
  );

  it(
    "EXECUTE on the five functions: pi_reader's on serve_mirror, mirror_cursor and mirror_tokens, pi_admin's on taint_mirror_entities and end_mirror, and no other role's or PUBLIC's",
    inCopy(async (db) => {
      const may = await admin<{ line: string }>(
        db,
        `select r.role || ' ' || f.signature as line from unnest($1::text[]) r(role) cross join unnest($2::text[]) f(signature)
       where has_function_privilege(r.role, f.signature::regprocedure, 'EXECUTE')`,
        [[...RUNTIME_ROLES], Object.keys(FUNCTIONS)],
      );
      expect(may.map((row) => row.line).sort()).toEqual(
        Object.entries(FUNCTIONS)
          .map(([signature, role]) => `${role} ${signature}`)
          .sort(),
      );
      const open = await admin<{ signature: string }>(
        db,
        `select p.oid::regprocedure::text as signature from pg_proc p
       where p.oid = any ($1::regprocedure[]) and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
        [Object.keys(FUNCTIONS)],
      );
      expect(open).toEqual([]);
      // The control: the owner of all five executes each.
      for (const signature of Object.keys(FUNCTIONS)) {
        expect(
          one(
            await admin<{ ok: boolean }>(
              db,
              "select has_function_privilege('pi_owner', $1::regprocedure, 'EXECUTE') as ok",
              [signature],
            ),
          ).ok,
          signature,
        ).toBe(true);
      }
    }),
  );
});

// ---------------------------------------------------------------------------------------------
// policy.serve_mirror
// ---------------------------------------------------------------------------------------------

describe("policy.serve_mirror, who may call it", { timeout: TIMEOUT }, () => {
  it(
    "no current client, a client without sync_mirror and another client's session raise 42501, a form refused is 23514 serve_mirror_<argument>, and each writes nothing",
    inCopy(async (db, w) => {
      const m = mirror(db, w.narrow);
      const call: Call = { section: "entities", entries: [personEntry(viewer(db, w.narrow, OWN), w.people[0])] };
      const before = await everything(db);
      const refused = (over: Partial<Call>) => refusal(() => m.call({ ...call, ...over }));
      expect((await refused({ token: null }))?.code, "no client").toBe("42501");
      expect((await refused({ token: w.toolless.token, session: w.toolless.session }))?.code, "no sync_mirror").toBe(
        "42501",
      );
      expect((await refused({ session: w.wide.session }))?.code, "another client's session").toBe("42501");
      const forms: [Partial<Call>, string][] = [
        [{ limit: 0 }, "serve_mirror_removal_limit"],
        [{ limit: 501 }, "serve_mirror_removal_limit"],
        [{ section: "nope" as MirrorSection, cap: 10 }, "serve_mirror_section"],
        [{ template: "lens-mirror-1" }, "serve_mirror_template"],
      ];
      for (const [over, constraint] of forms)
        expect(await refused(over), constraint).toEqual({ code: "23514", constraint });
      expect(await everything(db)).toBe(before);
      // The control: the client's own token and session, and a limit of 500.
      const page = await m.call(call);
      expect(page.entries.map((row) => row.projection_id)).toEqual([call.entries?.[0]?.id]);
      expect(await everything(db)).not.toBe(before);
    }),
  );

  it(
    "serve_mirror called as pi_reader with a valid token, naming a belief of another audience, a claim, a captures row or a project's anchor outside the clearance, raises 42501 and writes nothing",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const refuses = async (call: Call, what: string): Promise<void> => {
        const before = await everything(db);
        expect((await refusal(() => m.call(call)))?.code, what).toBe("42501");
        expect(await everything(db), what).toBe(before);
      };
      const [p1] = w.people;
      // entities: a person known only under employer:example, and a project's anchor outside the
      // clearance on a project inside it, each beside a row the client sees.
      await refuses(
        {
          section: "entities",
          entries: [personEntry(who, p1), personEntry(who, w.hiddenPerson, { compartments: WORK })],
        },
        "an entity outside the clearance",
      );
      await refuses(
        { section: "entities", entries: [personEntry(who, p1), projectEntry(who, w, [w.anchor, w.hiddenAnchor])] },
        "a project's anchor outside the clearance",
      );
      await m.call({ section: "entities", entries: [personEntry(who, p1), projectEntry(who, w, [w.anchor])] });
      // beliefs: a belief computed at read whose support names a claim under employer:example.
      const leaked = beliefEntry(who, w.belief, { support_ids: [...w.belief.support, ...w.hiddenBelief.support] });
      await refuses({ section: "beliefs", entries: [leaked] }, "a support claim outside the clearance");
      await refuses(
        { section: "beliefs", entries: [beliefEntry(who, w.hiddenBelief)] },
        "a belief outside the clearance",
      );
      await m.call({ section: "beliefs", entries: [beliefEntry(who, w.belief)] });
      // facts: a claim outside the clearance.
      await refuses(
        { section: "facts", entries: [factEntry(who, w.fact), factEntry(who, w.hiddenFact)] },
        "a claim outside the clearance",
      );
      await m.call({ section: "facts", entries: [factEntry(who, w.fact)] });
      // events: an event outside the clearance.
      await refuses({ section: "events", entries: [eventEntry(who, w.hiddenEvent)] }, "an event outside the clearance");
      await m.call({ section: "events", entries: [eventEntry(who, w.event)] });
      // captures: a stored capture item outside the clearance.
      await refuses(
        { section: "captures", entries: [captureEntry(who, w.capture), captureEntry(who, w.hiddenCapture)] },
        "a captures row outside the clearance",
      );
      const last = await m.call({ section: "captures", entries: [captureEntry(who, w.capture)] });
      expect(last.cursor.pass_complete).toBe(true);
      // The controls wrote exactly their rows, each live.
      const rows = await rowsOf(db, w.narrow.id);
      expect(sorted(rows.map((row) => row.entry_key))).toEqual(
        sorted([p1, w.project, w.belief.id, factKeyOf(w.fact), w.event.id, w.capture.id]),
      );
      expect(rows.every(live)).toBe(true);
    }),
  );
});

describe("policy.serve_mirror, the rows it names", { timeout: TIMEOUT }, () => {
  it(
    "a row named that is gone, or whose fact key or evidence differs from what the caller read, fails the call with serve_mirror_stale and writes nothing; read as it is, it is served",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      await m.call({ section: "entities" });
      const STALE_ROW = { code: "23514", constraint: "serve_mirror_stale" };
      const stale = async (entries: Entry[], what: string): Promise<void> => {
        const before = await everything(db);
        expect(await refusal(() => m.call({ section: "beliefs", entries })), what).toEqual(STALE_ROW);
        expect(await everything(db), what).toBe(before);
      };
      await stale([beliefEntry(who, w.belief, { fact_key_fp: stamp("another fact") })], "another fact key");
      await stale([beliefEntry(who, w.belief, { evidence_ids: [w.fact.evidence] })], "other evidence");
      await stale([beliefEntry(who, w.belief, { support_ids: w.otherAudience.support })], "another key's claim");
      await stale([beliefEntry(who, w.belief, { support_ids: [] })], "no support");
      const gone: Belief = {
        id: `blf_${stamp("gone").slice(0, 40)}`,
        fact: stamp("gone fact"),
        evidence: [stamp("gone evidence")],
        support: [stamp("gone claim")],
        compartments: OWN,
      };
      await stale([beliefEntry(who, w.belief), beliefEntry(who, gone)], "a belief that is gone");
      // The control: the belief as it is.
      const served = await m.call({ section: "beliefs", entries: [beliefEntry(who, w.belief)] });
      expect(served.entries.map((row) => row.projection_id)).toEqual([beliefEntry(who, w.belief).id]);

      // A fact whose claim is gone fails the same way; as it is, it is served.
      const goneFact: Fact = { ...w.fact, fact: stamp("no such fact key") };
      const before = await everything(db);
      expect(await refusal(() => m.call({ section: "facts", entries: [factEntry(who, goneFact)] }))).toEqual(STALE_ROW);
      expect(await everything(db)).toBe(before);
      expect((await m.call({ section: "facts", entries: [factEntry(who, w.fact)] })).entries).toHaveLength(1);
    }),
  );

  it(
    "a project's entry naming one of its own live anchors with no sealed value (a window title's) fails with serve_mirror_stale and writes nothing",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const titled = await session(db.urls.admin, async (query) => {
        const ruling = testId("rul");
        await query(
          "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'release', 0, '{}', '{}', $3, '{own}')",
          [ruling, testId("req"), AT],
        );
        const id = testId("pan");
        await query(
          `insert into knowledge.project_anchors (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments) values ($1, $2, 'window_title', $3, $4, $5, $6)`,
          [id, w.project, stamp(`anchor ${id}`), ruling, AT, OWN],
        );
        return id;
      });
      const before = await everything(db);
      expect(
        await refusal(() => m.call({ section: "entities", entries: [projectEntry(who, w, [w.anchor, titled])] })),
      ).toEqual({ code: "23514", constraint: "serve_mirror_stale" });
      expect(await everything(db)).toBe(before);
      // The control: its anchor with a value alone.
      expect(
        (await m.call({ section: "entities", entries: [projectEntry(who, w, [w.anchor])] })).entries.map(
          (row) => row.projection_id,
        ),
      ).toEqual([projectEntry(who, w, [w.anchor]).id]);
    }),
  );

  it(
    "a row's evidence and entity ids are found from the rows it names, and it keeps every evidence id it rested on at any serve, so a deletion of one that has left the support still reaches it",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1] = w.people;
      await wholePass(m, {
        entities: [personEntry(who, p1), projectEntry(who, w, [w.anchor])],
        beliefs: [beliefEntry(who, w.belief)],
        facts: [factEntry(who, w.fact)],
        events: [eventEntry(who, w.event)],
        captures: [captureEntry(who, w.capture)],
      });
      const byKey = new Map((await rowsOf(db, w.narrow.id)).map((row) => [row.entry_key, row]));
      const ids = (key: string) => ({
        evidence: sorted(byKey.get(key)?.evidence_ids),
        entities: sorted(byKey.get(key)?.entity_ids),
      });
      // An entity's own id; a project's too (its anchors are not entities).
      expect(ids(p1)).toEqual({ evidence: [], entities: [p1] });
      expect(ids(w.project)).toEqual({ evidence: [], entities: [w.project] });
      // A belief's support, a claim's evidence, an event's evidence row and participants, a capture
      // item's evidence row.
      expect(ids(w.belief.id).evidence).toEqual(sorted(w.belief.evidence));
      expect(ids(factKeyOf(w.fact)).evidence).toEqual([w.fact.evidence]);
      expect(ids(w.event.id)).toEqual({ evidence: [w.event.evidence], entities: sorted(w.event.participants) });
      expect(ids(w.capture.id).evidence).toEqual([w.capture.evidence]);

      // The belief's support moves to a claim on another evidence row; the next serve reads it so.
      const [moved, claim] = await session(db.urls.admin, async (query) => {
        const evidence = await evidenceIn(db, query, OWN);
        return [evidence, await claimOn(db, query, evidence, w.belief.fact, OWN)];
      });
      const again = { evidence_ids: [moved as string], support_ids: [claim as string], state: stamp("moved") };
      await wholePass(
        m,
        { beliefs: [beliefEntry(who, w.belief, again)] },
        { entities: [p1, w.project], facts: [factKeyOf(w.fact)], events: [w.event.id], captures: [w.capture.id] },
      );
      const beliefRow = await rowOf(db, beliefEntry(who, w.belief).id);
      expect(sorted(beliefRow.evidence_ids)).toEqual(sorted([...w.belief.evidence, moved]));
      expect(live(beliefRow)).toBe(true);

      // The deletion of the evidence that left the support still reaches the row; the event's is
      // untouched.
      await queryAs(db.urls.writer, TAINT, [w.belief.evidence]);
      const tainted = await rowOf(db, beliefRow.id);
      expect({
        reason: tainted.reason,
        ended: tainted.ended_at !== null,
        tainted: tainted.tainted_at !== null,
        evidence: tainted.evidence_ids,
      }).toEqual({ reason: "withdrawn", ended: true, tainted: true, evidence: [] });
      expect(live(await rowOf(db, eventEntry(who, w.event).id))).toBe(true);
    }),
  );

  it(
    "a row ended or tainted whose entry is visible again is live under the same id, its taint kept and its confirmed state cleared, so it is sent whole",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2] = w.people;
      const first = [personEntry(who, p1), personEntry(who, p2)];
      await wholePass(m, { entities: first });
      for (const each of first)
        expect((await rowOf(db, each.id)).confirmed_state, "confirmed by the next call").toBe(each.state);

      // P1's row tainted, as an erasure of a person it names taints it.
      expect(
        one(await admin<{ n: number }>(db, "select ledger.taint_mirror_entities($1::text[]) as n", [[p1]])).n,
      ).toBe(1);
      expect((await rowOf(db, personEntry(who, p1).id)).tainted_at).not.toBeNull();

      // The next pass finds P1 and not P2: P1 is live again, and sent though its state is the one
      // it had; P2 is ended withdrawn.
      const again = await m.call({ section: "entities", found: [p1], entries: [personEntry(who, p1)] });
      expect(again.entries.map((row) => row.projection_id)).toEqual([personEntry(who, p1).id]);
      const revived = await rowOf(db, personEntry(who, p1).id);
      expect({
        live: live(revived),
        sent: revived.end_sent_at,
        told: revived.end_confirmed_at,
        confirmed: revived.confirmed_state,
        token: revived.confirmed_token,
        kept: revived.last_tainted_at !== null,
        entities: revived.entity_ids,
      }).toEqual({ live: true, sent: null, told: null, confirmed: null, token: null, kept: true, entities: [p1] });
      expect((await rowOf(db, personEntry(who, p2).id)).reason).toBe("withdrawn");
      await finish(m, "entities");

      // A pass later P2 is visible again: live under the same id, and sent whole.
      const back = await m.call({ section: "entities", found: [p1, p2], entries: [personEntry(who, p2)] });
      expect(back.entries.map((row) => row.projection_id)).toEqual([personEntry(who, p2).id]);
      const p2Row = await rowOf(db, personEntry(who, p2).id);
      expect({ live: live(p2Row), confirmed: p2Row.confirmed_state }).toEqual({ live: true, confirmed: null });
      expect((await rowsOf(db, w.narrow.id)).map((row) => row.id).sort()).toEqual(first.map((each) => each.id).sort());
    }),
  );
});

describe("policy.serve_mirror, projection ids", { timeout: TIMEOUT }, () => {
  it(
    "a raised generation keeps a fact's projection id, and its new value is served as an update, with no removal",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const before = factEntry(who, w.fact, { state: stamp("generation 1") });
      await wholePass(m, { facts: [before] });
      // The claim re-extracted under generation 2: a new claim id on the same evidence and fact key,
      // and the old one gone.
      await session(db.urls.admin, (query) => claimOn(db, query, w.fact.evidence, w.fact.fact, OWN, 2));
      // As the claims' owner: pi_admin removes no claim directly.
      await asClaimsOwner(db, (query) => query("delete from knowledge.claims where id = $1", [w.fact.claim]));
      const after = factEntry(who, w.fact, { state: stamp("generation 2") });
      expect(after.id).toBe(before.id);
      const pages = await wholePass(m, { facts: [after] });
      expect(pages.flatMap((page) => page.removals)).toEqual([]);
      const facts = pages[SECTIONS.indexOf("facts")];
      expect(facts?.entries.map((row) => [row.projection_id, row.entry_key, row.state])).toEqual([
        [before.id, factKeyOf(w.fact), after.state],
      ]);
      const rows = (await rowsOf(db, w.narrow.id)).filter((row) => row.section === "facts");
      expect(rows.map((row) => ({ id: row.id, live: live(row), sent: row.sent_state, fact: row.fact_key_fp }))).toEqual(
        [{ id: before.id, live: true, sent: after.state, fact: w.fact.fact }],
      );
    }),
  );

  it(
    "a call for a client whose audience changed first ends every live row of the old audience replaced, and then writes the new ids without a unique violation",
    inCopy(async (db, w) => {
      const narrow = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1] = w.people;
      const old = { person: personEntry(narrow, p1), belief: beliefEntry(narrow, w.belief) };
      await wholePass(m, { entities: [old.person], beliefs: [old.belief] });
      // pi clients set-compartments widens the client; its next call is in a new
      // session of the wider clearance.
      await admin(db, "update policy.clients set compartments = $2 where id = $1", [w.narrow.id, BOTH]);
      const widened = await sessionFor(db, w.narrow.id, BOTH);
      const wider = viewer(db, w.narrow, BOTH);
      const fresh = personEntry(wider, p1);
      expect(fresh.id).not.toBe(old.person.id);
      const page = await m.call({ section: "entities", session: widened, entries: [fresh] });
      // Every old row, of every section, is a removal `replaced`, before the entry under its new id.
      expect(page.removals.map((row) => [row.projection_id, row.reason]).sort()).toEqual(
        [
          [old.person.id, "replaced"],
          [old.belief.id, "replaced"],
        ].sort(),
      );
      expect(page.entries.map((row) => row.projection_id)).toEqual([fresh.id]);
      for (const id of [old.person.id, old.belief.id]) expect((await rowOf(db, id)).reason, id).toBe("replaced");
      const now = await rowOf(db, fresh.id);
      expect({ live: live(now), audience: now.audience, key: now.entry_key }).toEqual({
        live: true,
        audience: BOTH,
        key: p1,
      });
    }),
  );

  it(
    "a call under another template than the client's live rows first ends every one of them replaced, and then writes the new ids without a unique violation",
    inCopy(async (db, w) => {
      const first = viewer(db, w.narrow, OWN, T1);
      const m = mirror(db, w.narrow);
      const [p1] = w.people;
      const old = { person: personEntry(first, p1), belief: beliefEntry(first, w.belief) };
      await wholePass(m, { entities: [old.person], beliefs: [old.belief] });
      // The cursor issued under lens_mirror@1 continues its pass under the next version.
      const fresh = personEntry(viewer(db, w.narrow, OWN, T2), p1);
      expect(fresh.id).not.toBe(old.person.id);
      const page = await m.call({ section: "entities", template: T2, entries: [fresh] });
      expect(page.removals.map((row) => [row.projection_id, row.reason]).sort()).toEqual(
        [
          [old.person.id, "replaced"],
          [old.belief.id, "replaced"],
        ].sort(),
      );
      expect(page.entries.map((row) => row.projection_id)).toEqual([fresh.id]);
      for (const id of [old.person.id, old.belief.id]) expect((await rowOf(db, id)).reason, id).toBe("replaced");
      const now = await rowOf(db, fresh.id);
      expect({ live: live(now), template: now.template, key: now.entry_key }).toEqual({
        live: true,
        template: T2,
        key: p1,
      });
    }),
  );
});

describe("policy.serve_mirror, cursors and pruning", { timeout: TIMEOUT }, () => {
  it(
    "the latest cursor confirms its page: its entries' states and tokens, its removals told, and the erased keys erasedDone lists; removals come first, at most removal_limit, then erased keys",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2] = w.people;
      const sent = [personEntry(who, p1), personEntry(who, p2)];
      await m.call({ section: "entities", entries: sent });
      // Three ended rows not yet told, and erased keys of the client's and of another client's.
      const ended: string[] = [];
      for (let n = 0; n < 3; n += 1)
        ended.push(
          await plant(db, {
            client: w.narrow.id,
            audience: OWN,
            section: "captures",
            key: keyIn("captures"),
            ended: { at: daysAgo(1), reason: "withdrawn" },
          }),
        );
      const [k1, k2, k3] = [momentKey(), momentKey(), momentKey()];
      for (const [client, key] of [
        [w.narrow.id, k1],
        [w.narrow.id, k2],
        [w.wide.id, k3],
      ] as const) {
        await owner(
          db,
          "insert into ledger.capture_erasures (client_id, capture_key, erased_at, compartments) values ($1, $2, now(), '{own}')",
          [client, key],
        );
      }

      const second = await m.call({ section: "beliefs", limit: 2 });
      for (const each of sent) {
        const row = await rowOf(db, each.id);
        expect(
          { state: row.confirmed_state, token: row.confirmed_token },
          "the page the cursor followed, confirmed",
        ).toEqual({ state: each.state, token: each.token });
      }
      expect(second.removals).toHaveLength(2);
      expect(
        second.removals.every((row) => row.reason === "withdrawn" && ended.includes(row.projection_id ?? "")),
      ).toBe(true);
      expect(sorted(second.erased)).toEqual(sorted([k1, k2]));
      expect(second.entries).toEqual([]);
      const toldFirst = second.removals.map((row) => row.projection_id ?? "");
      for (const id of toldFirst) {
        const row = await rowOf(db, id);
        expect({ sent: row.end_sent_at !== null, told: row.end_confirmed_at }, "sent, not yet confirmed").toEqual({
          sent: true,
          told: null,
        });
      }

      const third = await m.call({ section: "facts", erasedDone: [k1] });
      expect(third.removals.map((row) => row.projection_id)).toEqual(ended.filter((id) => !toldFirst.includes(id)));
      expect(third.erased).toEqual([k2]);
      for (const id of toldFirst) expect((await rowOf(db, id)).end_confirmed_at, "told").not.toBeNull();
      const confirmedAt = async (key: string) =>
        one(
          await admin<{ at: Date | null }>(
            db,
            "select confirmed_at as at from ledger.capture_erasures where capture_key = $1",
            [key],
          ),
        ).at;
      expect(await confirmedAt(k1)).not.toBeNull();
      expect(await confirmedAt(k2)).toBeNull();

      const fourth = await m.call({ section: "events", erasedDone: [k2] });
      expect({ removals: fourth.removals, erased: fourth.erased }).toEqual({ removals: [], erased: [] });
      for (const id of ended) expect((await rowOf(db, id)).end_confirmed_at, id).not.toBeNull();
      expect(await confirmedAt(k2)).not.toBeNull();
      // Another client's erased key is never served to this one, nor confirmed by it.
      expect(await confirmedAt(k3)).toBeNull();
      await m.call({ section: "captures" });

      // The next pass: an entry whose state equals the confirmed one is not sent; one whose values
      // changed keeps its id and is sent with its new state.
      const changed = personEntry(who, p2, { state: stamp("p2 changed") });
      const next = await m.call({ section: "entities", entries: [personEntry(who, p1), changed] });
      expect(next.entries.map((row) => [row.projection_id, row.state])).toEqual([[sent[1]?.id, changed.state]]);
    }),
  );

  it(
    "the cursor before the latest re-reads its range and sends its unconfirmed entries again; any other cursor, another client's included, is stale_cursor and writes nothing",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2, p3, p4] = w.people;
      const [e1, e2, e3, e4] = w.people.map((id) => personEntry(who, id));
      if (e1 === undefined || e2 === undefined || e3 === undefined || e4 === undefined) throw new Error("four entries");
      await m.call({ section: "entities", last: p2, found: [p1, p2], entries: [e1, e2] });
      const c1 = m.cursor;
      const range: Call = { section: "entities", after: p2, last: p4, found: [p3, p4], entries: [e3, e4] };
      await m.call(range);
      const c2 = m.cursor;
      // c2's page was lost: the client presents c1 again, and that range is read again.
      const again = await m.call(range, c1);
      expect(again.entries.map((row) => row.projection_id).sort()).toEqual([e3.id, e4.id].sort());
      for (const each of [e3, e4])
        expect((await rowOf(db, each.id)).confirmed_state, "the lost page is not confirmed").toBeNull();
      for (const each of [e1, e2]) expect((await rowOf(db, each.id)).confirmed_state).toBe(each.state);
      await m.call({ section: "entities", after: p4, found: [] });
      for (const each of [e3, e4])
        expect((await rowOf(db, each.id)).confirmed_state, "confirmed by the page after it").toBe(each.state);

      // Older cursors, another client's latest, and an id the server never issued.
      const other = mirror(db, w.wide);
      await other.call({ section: "entities" });
      const before = await everything(db);
      for (const [cursor, what] of [
        [c1, "older"],
        [c2, "older"],
        [other.cursor, "another client's"],
        [testId("mcr"), "never issued"],
      ] as const) {
        expect(await refusal(() => m.call({ section: "beliefs" }, cursor)), what).toEqual({
          code: "23514",
          constraint: "serve_mirror_cursor",
        });
      }
      expect(await everything(db)).toBe(before);
      // The control: the latest.
      expect((await m.call({ section: "beliefs" })).cursor.new_cursor_id).not.toBeNull();
    }),
  );

  it(
    "a null cursor clears every confirmed state of the client, and of no other client, and the entries built are sent again",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const other = mirror(db, w.wide);
      const [p1, p2] = w.people;
      const sent = [personEntry(who, p1), personEntry(who, p2)];
      await m.call({ section: "entities", entries: sent });
      await m.call({ section: "beliefs" });
      await other.call({ section: "entities", entries: [personEntry(viewer(db, w.wide, BOTH), p1)] });
      await other.call({ section: "beliefs" });
      const endedConfirmed = await plant(db, {
        client: w.narrow.id,
        audience: OWN,
        section: "events",
        key: keyIn("events"),
        token: stamp("ended token"),
        ended: { at: daysAgo(2), reason: "withdrawn", sent: daysAgo(2), told: daysAgo(1) },
      });
      expect((await rowsOf(db, w.narrow.id)).every((row) => row.confirmed_state !== null)).toBe(true);

      const restart = await m.call({ section: "entities", entries: sent }, null);
      expect(restart.entries.map((row) => row.projection_id).sort()).toEqual(sent.map((each) => each.id).sort());
      const rows = await rowsOf(db, w.narrow.id);
      expect(rows.map((row) => row.id).sort()).toEqual([...sent.map((each) => each.id), endedConfirmed].sort());
      expect(rows.map((row) => [row.confirmed_state, row.confirmed_token])).toEqual(rows.map(() => [null, null]));
      // The control: the other client's rows keep theirs.
      const others = await rowsOf(db, w.wide.id);
      expect(others).toHaveLength(1);
      expect(others.every((row) => row.confirmed_state !== null && row.confirmed_token !== null)).toBe(true);
    }),
  );

  it(
    "capture_erasures rows confirmed over 30 days ago, and ended rows confirmed over 30 days ago that no erasure link names, are deleted; the client's others and another client's are kept",
    inCopy(async (db, w) => {
      // A cursor first, so the pruning call presents the latest; the rows are in a section it does
      // not scan.
      const m = mirror(db, w.narrow);
      await m.call({ section: "entities" });
      const erased = async (client: string, confirmed: string | null): Promise<string> => {
        const key = momentKey();
        await owner(
          db,
          "insert into ledger.capture_erasures (client_id, capture_key, erased_at, confirmed_at, compartments) values ($1, $2, $3, $4, '{own}')",
          [client, key, daysAgo(40), confirmed],
        );
        return key;
      };
      const oldDone = await erased(w.narrow.id, daysAgo(31));
      const recentDone = await erased(w.narrow.id, daysAgo(29));
      const pending = await erased(w.narrow.id, null);
      const othersOld = await erased(w.wide.id, daysAgo(31));
      const ended = (client: string, audience: readonly string[], told?: string) =>
        plant(db, {
          client,
          audience,
          section: "captures",
          key: keyIn("captures"),
          firstServed: daysAgo(40),
          ended: { at: daysAgo(35), reason: "withdrawn", sent: daysAgo(34), ...(told === undefined ? {} : { told }) },
        });
      const gone = await ended(w.narrow.id, OWN, daysAgo(31));
      const linked = await ended(w.narrow.id, OWN, daysAgo(31));
      const recent = await ended(w.narrow.id, OWN, daysAgo(29));
      const untold = await ended(w.narrow.id, OWN);
      const old = await plant(db, {
        client: w.narrow.id,
        audience: OWN,
        section: "captures",
        key: keyIn("captures"),
        firstServed: daysAgo(40),
        token: stamp("old live"),
      });
      const othersGone = await ended(w.wide.id, BOTH, daysAgo(31));
      await session(db.urls.admin, async (query) => {
        const erasure = String(await seeder(db, query).into("knowledge.erasures")(OWN));
        await query(
          "insert into ledger.erasure_exposures (erasure_id, mirror_entry_id, compartments) values ($1, $2, '{own}')",
          [erasure, linked],
        );
      });

      await m.call({ section: "beliefs" });
      const keys = await admin<{ client: string; key: string }>(
        db,
        "select client_id as client, capture_key as key from ledger.capture_erasures where capture_key = any ($1::text[])",
        [[oldDone, recentDone, pending, othersOld]],
      );
      expect(sorted(keys.map((row) => row.key))).toEqual(sorted([recentDone, pending, othersOld]));
      const rows = await admin<{ id: string }>(db, "select id from ledger.mirror_entries where id = any ($1::text[])", [
        [gone, linked, recent, untold, old, othersGone],
      ]);
      expect(sorted(rows.map((row) => row.id))).toEqual(sorted([linked, recent, untold, old, othersGone]));
    }),
  );
});

describe("policy.serve_mirror, what leaves the view", { timeout: TIMEOUT }, () => {
  it(
    "a live row in the scanned range and not named is ended withdrawn, and one outside the range is not; at a section's end, rows after its last key are ended the same way",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2, p3, p4] = w.people;
      const id = (person: string) => personEntry(who, person).id;
      await wholePass(m, { entities: w.people.map((person) => personEntry(who, person)) });
      const states = async () =>
        Object.fromEntries(
          await Promise.all(
            w.people.map(async (person) => [person, (await rowOf(db, id(person))).reason ?? "live"] as const),
          ),
        );
      const removals: Answer[] = [];
      removals.push(...(await m.call({ section: "entities", last: p1, found: [p1] })).removals);
      // (p1, p3] scanned and p3 not found: p3 is ended; p1 (the range starts after it) and p4 (after
      // it) are not.
      removals.push(...(await m.call({ section: "entities", after: p1, last: p3, found: [p2] })).removals);
      expect(await states()).toEqual({ [p1]: "live", [p2]: "live", [p3]: "withdrawn", [p4]: "live" });
      // The section's end, after p3: p4 is ended.
      removals.push(...(await m.call({ section: "entities", after: p3, found: [] })).removals);
      expect(await states()).toEqual({ [p1]: "live", [p2]: "live", [p3]: "withdrawn", [p4]: "withdrawn" });
      // Their removals go out in the next calls, each `withdrawn`, and none for a row still seen.
      for (const page of await finish(m, "entities")) removals.push(...page.removals);
      const told = new Map(removals.map((row) => [row.projection_id, row.reason]));
      expect([...told.keys()].sort()).toEqual([id(p3), id(p4)].sort());
      expect([...told.values()]).toEqual(["withdrawn", "withdrawn"]);
    }),
  );

  it(
    "a row cut by the cap is ended dropped, never withdrawn, the page says truncated, and an entry past the cap is not sent",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2, p3] = w.people;
      const first = await wholePass(
        m,
        { entities: [p1, p2, p3].map((person) => personEntry(who, person)) },
        {},
        { cap: 3 },
      );
      expect(first.map((page) => page.cursor.truncated)).toEqual(SECTIONS.map(() => false));
      // The next pass, with the section's cap at 2 and P1 and P3 changed: P3, the last in key order,
      // is cut.
      const changed = [
        personEntry(who, p1, { state: stamp("p1 changed") }),
        personEntry(who, p2),
        personEntry(who, p3, { state: stamp("p3 changed") }),
      ];
      const cut = await m.call({ section: "entities", entries: changed, cap: 2 });
      expect(cut.cursor.truncated).toBe(true);
      expect(cut.entries.map((row) => row.projection_id)).toEqual([changed[0]?.id]);
      const p3Row = await rowOf(db, personEntry(who, p3).id);
      expect({ reason: p3Row.reason, ended: p3Row.ended_at !== null, tainted: p3Row.tainted_at }).toEqual({
        reason: "dropped",
        ended: true,
        tainted: null,
      });
      for (const person of [p1, p2]) expect(live(await rowOf(db, personEntry(who, person).id)), person).toBe(true);
      const next = await m.call({ section: "beliefs", cap: 2 });
      const removals = [...cut.removals, ...next.removals].map((row) => [row.projection_id, row.reason]);
      expect(removals).toEqual([[p3Row.id, "dropped"]]);
    }),
  );
});

describe("policy.serve_mirror and invariant 6", { timeout: TIMEOUT }, () => {
  it("another client's mirror rows, the inbox, a belief of another audience and every hidden row change no row serve_mirror writes and nothing it answers", async () => {
    const plain = await copies.copy();
    const hidden = await copies.copy();
    try {
      const w = theWorld();
      const [p1] = w.people;
      // In one copy only. Another client's mirror rows on the same keys: a confirmed one, an
      // unconfirmed one, and one ended and not yet told, with an erased key of its own.
      const wideRows = [
        await plant(hidden, {
          client: w.wide.id,
          audience: BOTH,
          section: "entities",
          key: p1,
          token: stamp("wide token"),
          entities: [p1],
        }),
        await plant(hidden, {
          client: w.wide.id,
          audience: BOTH,
          section: "events",
          key: w.event.id,
          evidence: [w.event.evidence],
          entities: [p1],
        }),
        await plant(hidden, {
          client: w.wide.id,
          audience: BOTH,
          section: "captures",
          key: w.capture.id,
          evidence: [w.capture.evidence],
          ended: { at: daysAgo(1), reason: "withdrawn" },
        }),
        await plant(hidden, {
          client: w.wide.id,
          audience: BOTH,
          section: "beliefs",
          key: w.belief.id,
          evidence: w.belief.evidence,
          ended: { at: daysAgo(1), reason: "withdrawn" },
        }),
      ];
      await owner(
        hidden,
        "insert into ledger.capture_erasures (client_id, capture_key, erased_at, compartments) values ($1, $2, now(), '{own}')",
        [w.wide.id, momentKey()],
      );
      await session(hidden.urls.admin, async (query) => {
        const seed = seeder(hidden, query);
        // The inbox, and another device's erased key.
        await seed.into("ledger.capture_inbox")(OWN);
        await seed.into("ledger.capture_erasures")(OWN);
        // A belief of another audience on the same fact key.
        await beliefIn(hidden, query, BOTH, OWN, w.belief.fact);
        // Hidden rows on the visible ones: an employer:example account of P1, an employer:example
        // participant of the event, a claim on the fact's key under employer:example, and an
        // employer:example anchor of the project.
        await seed.account(WORK, p1);
        await query(
          "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
          [w.event.id, w.hiddenPerson, WORK],
        );
        await claimOn(hidden, query, await evidenceIn(hidden, query, WORK), w.fact.fact, WORK);
        await anchorIn(hidden, query, w.project, WORK, "repository");
      });
      const wideBefore = JSON.stringify(await rowsOf(hidden, w.wide.id));

      // The same calls in each copy: a whole pass, and one in which the project and the capture
      // item are no longer found.
      const run = async (db: TestDatabase) => {
        const who = viewer(db, w.narrow, OWN);
        const m = mirror(db, w.narrow);
        const pages = [
          ...(await wholePass(m, {
            entities: [personEntry(who, p1), projectEntry(who, w, [w.anchor])],
            beliefs: [beliefEntry(who, w.belief)],
            facts: [factEntry(who, w.fact)],
            events: [eventEntry(who, w.event)],
            captures: [captureEntry(who, w.capture)],
          })),
          ...(await wholePass(
            m,
            {},
            { entities: [p1], beliefs: [w.belief.id], facts: [factKeyOf(w.fact)], events: [w.event.id] },
          )),
        ];
        const rows = await admin<Record<string, unknown>>(
          db,
          `select id, section, entry_key, template, audience, fact_key_fp, sent_state, confirmed_state, confirmed_token,
                  array(select x from unnest(evidence_ids) x order by x collate "C") as evidence, array(select x from unnest(entity_ids) x order by x collate "C") as entities,
                  compartments, reason, ended_at is null as live, end_sent_at is null as unsent, end_confirmed_at is null as untold, tainted_at is null as clean
           from ledger.mirror_entries where client_id = $1 order by id`,
          [w.narrow.id],
        );
        // What a page answers, but the cursor's own id and the times.
        return {
          pages: pages.map((page) => page.rows.map(({ new_cursor_id: _cursor, ended_at: _at, ...rest }) => rest)),
          rows,
        };
      };
      const without = await run(plain);
      const withHidden = await run(hidden);
      expect(withHidden).toEqual(without);
      // The hidden participant, the hidden account and the other audience's rows are in no row the
      // client's mirror holds: the event's entity ids are its visible participant's.
      expect(without.rows.find((row) => row.entry_key === w.event.id)?.entities).toEqual([p1]);
      // The controls: the other client's rows are there, untouched, in the one copy and not the other.
      expect(JSON.stringify(await rowsOf(hidden, w.wide.id))).toBe(wideBefore);
      expect((await rowsOf(hidden, w.wide.id)).map((row) => row.id).sort()).toEqual([...wideRows].sort());
      expect(await rowsOf(plain, w.wide.id)).toEqual([]);
    } finally {
      await plain.drop();
      await hidden.drop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// policy.mirror_cursor and policy.mirror_tokens
// ---------------------------------------------------------------------------------------------

describe("policy.mirror_cursor and policy.mirror_tokens", { timeout: TIMEOUT }, () => {
  it(
    "mirror_cursor answers none for a null cursor, latest and prior with the cursor's pass, rebuild and position, and stale for any other; passComplete only at the last section's end",
    inCopy(async (db, w) => {
      const who = viewer(db, w.narrow, OWN);
      const m = mirror(db, w.narrow);
      const [p1, p2, p3, p4] = w.people;
      expect(await standingOf(db, w.narrow, null)).toEqual({
        standing: "none",
        pass: null,
        rebuild: null,
        section: null,
        after_key: null,
        completed_at: null,
        rebuilt_at: null,
      });

      // A pass that ignores tokens, its first call stopping after P2.
      const pages: Page[] = [];
      pages.push(
        await m.call({
          section: "entities",
          last: p2,
          found: [p1, p2],
          entries: [personEntry(who, p1), personEntry(who, p2)],
          rebuild: true,
        }),
      );
      const c1 = m.cursor;
      const pass = pages[0]?.cursor.pass ?? 0;
      expect(pass).toBeGreaterThanOrEqual(1);
      const at1 = await standingOf(db, w.narrow, c1);
      expect({ ...at1, rebuilt_at: at1.rebuilt_at !== null }).toEqual({
        standing: "latest",
        pass,
        rebuild: true,
        section: "entities",
        after_key: p2,
        completed_at: null,
        rebuilt_at: true,
      });
      pages.push(await m.call({ section: "entities", after: p2, found: [p3, p4], rebuild: true }));
      const c2 = m.cursor;
      // The section's end leaves the cursor at the next section's start.
      expect({ ...(await standingOf(db, w.narrow, c2)), rebuilt_at: null }).toEqual({
        standing: "latest",
        pass,
        rebuild: true,
        section: "beliefs",
        after_key: null,
        completed_at: null,
        rebuilt_at: null,
      });
      expect({ ...(await standingOf(db, w.narrow, c1)), rebuilt_at: null }).toEqual({
        standing: "prior",
        pass,
        rebuild: true,
        section: "entities",
        after_key: p2,
        completed_at: null,
        rebuilt_at: null,
      });
      const cursors: (string | null)[] = [c1, c2];
      for (const page of await finish(m, "entities", {}, { rebuild: true })) {
        pages.push(page);
        cursors.push(page.cursor.new_cursor_id);
      }
      expect(pages.map((page) => page.cursor.pass_complete)).toEqual([false, false, false, false, false, true]);
      expect(pages.map((page) => [page.cursor.pass, page.cursor.truncated])).toEqual(pages.map(() => [pass, false]));
      const done = await standingOf(db, w.narrow, m.cursor);
      expect({ ...done, completed_at: done.completed_at !== null, rebuilt_at: done.rebuilt_at?.getTime() }).toEqual({
        standing: "latest",
        pass,
        rebuild: true,
        section: null,
        after_key: null,
        completed_at: true,
        rebuilt_at: at1.rebuilt_at?.getTime(),
      });
      expect((await standingOf(db, w.narrow, cursors.at(-2) ?? null)).standing).toBe("prior");

      // Any other cursor: an older one, another client's, one never issued.
      const other = mirror(db, w.wide);
      await other.call({ section: "entities" });
      const before = await everything(db);
      for (const cursor of [c1, c2, cursors.at(-3) ?? null, other.cursor, testId("mcr")])
        expect(await standingOf(db, w.narrow, cursor), String(cursor)).toEqual(STALE);
      expect(await standingOf(db, w.narrow, null)).toMatchObject({
        standing: "none",
        pass: null,
        rebuild: null,
        section: null,
        after_key: null,
      });
      expect(await everything(db), "mirror_cursor writes nothing").toBe(before);

      // The next pass, which does not ignore tokens: a higher pass, still running, and the last
      // rebuild's start carried.
      const next = await m.call({ section: "entities", found: [p1, p2, p3, p4] });
      expect(next.cursor.pass ?? 0).toBeGreaterThan(pass);
      const running = await standingOf(db, w.narrow, m.cursor);
      expect({ ...running, rebuilt_at: running.rebuilt_at?.getTime() }).toEqual({
        standing: "latest",
        pass: next.cursor.pass,
        rebuild: false,
        section: "beliefs",
        after_key: null,
        completed_at: null,
        rebuilt_at: at1.rebuilt_at?.getTime(),
      });
    }),
  );

  it(
    "mirror_tokens answers, in key order, the confirmed tokens of the client's live rows under its current audience and the given template, in the section, in the range",
    inCopy(async (db, w) => {
      const [k1, k2, k3, k4, k5, k6, k7] = Array.from({ length: 7 }, () => testId("ent")).sort();
      if (
        k1 === undefined ||
        k2 === undefined ||
        k3 === undefined ||
        k4 === undefined ||
        k5 === undefined ||
        k6 === undefined ||
        k7 === undefined
      )
        throw new Error("seven keys");
      const token = (key: string) => stamp(`token of ${key}`);
      const row = (over: Partial<Plant> & { key: string }) =>
        plant(db, { client: w.narrow.id, audience: OWN, section: "entities", token: token(over.key), ...over });
      for (const key of [k1, k2, k3]) await row({ key });
      await owner(db, "update ledger.mirror_entries set confirmed_state = null, confirmed_token = null where id = $1", [
        await row({ key: k4 }),
      ]);
      await row({ key: k5, ended: { at: daysAgo(1), reason: "withdrawn" } });
      await row({ key: k6, template: T2 });
      await row({ key: k7, audience: BOTH });
      const event = keyIn("events");
      await row({ key: event, section: "events" });
      await plant(db, { client: w.wide.id, audience: BOTH, section: "entities", key: k1, token: stamp("wide's") });

      const pairs = (keys: string[]) => keys.map((key) => ({ entry_key: key, confirmed_token: token(key) }));
      const before = await everything(db);
      expect(await tokensOf(db, w.narrow, T1, "entities", null, null)).toEqual(pairs([k1, k2, k3]));
      expect(await tokensOf(db, w.narrow, T1, "entities", k1, null)).toEqual(pairs([k2, k3]));
      expect(await tokensOf(db, w.narrow, T1, "entities", null, k2)).toEqual(pairs([k1, k2]));
      expect(await tokensOf(db, w.narrow, T1, "entities", k1, k2)).toEqual(pairs([k2]));
      expect(await tokensOf(db, w.narrow, T1, "entities", k3, null)).toEqual([]);
      expect(await tokensOf(db, w.narrow, T2, "entities", null, null)).toEqual(pairs([k6]));
      expect(await tokensOf(db, w.narrow, T1, "events", null, null)).toEqual(pairs([event]));
      expect(await tokensOf(db, w.wide, T1, "entities", null, null)).toEqual([
        { entry_key: k1, confirmed_token: stamp("wide's") },
      ]);
      expect(await everything(db), "mirror_tokens writes nothing").toBe(before);
    }),
  );

  it(
    "mirror_cursor and mirror_tokens raise 42501 for no current client, a client without sync_mirror and another client's session, refuse a form 23514, and write nothing",
    inCopy(async (db, w) => {
      const calls = [
        { name: "mirror_cursor", sql: CURSOR, values: (sessionId: string) => [sessionId, null] },
        { name: "mirror_tokens", sql: TOKENS, values: (sessionId: string) => [sessionId, T1, "entities", null, null] },
      ];
      const before = await everything(db);
      for (const call of calls) {
        const run = (token: string | null, sessionId: string, values = call.values(sessionId)) =>
          refusal(() => readAs(db, token, (query) => query(call.sql, values)));
        expect((await run(null, w.narrow.session))?.code, `${call.name}: no client`).toBe("42501");
        expect((await run(w.toolless.token, w.toolless.session))?.code, `${call.name}: no sync_mirror`).toBe("42501");
        expect((await run(w.narrow.token, w.wide.session))?.code, `${call.name}: another client's session`).toBe(
          "42501",
        );
        // The control.
        expect(await run(w.narrow.token, w.narrow.session), call.name).toBeNull();
      }
      expect(
        await refusal(() => readAs(db, w.narrow.token, (query) => query(CURSOR, [w.narrow.session, "not-a-cursor"]))),
      ).toEqual({ code: "23514", constraint: "mirror_cursor_cursor_id" });
      expect(
        await refusal(() =>
          readAs(db, w.narrow.token, (query) =>
            query(TOKENS, [w.narrow.session, "not-a-template", "entities", null, null]),
          ),
        ),
      ).toEqual({
        code: "23514",
        constraint: "mirror_tokens_template",
      });
      expect(
        await refusal(() =>
          readAs(db, w.narrow.token, (query) => query(TOKENS, [w.narrow.session, T1, "nope", null, null])),
        ),
      ).toEqual({ code: "23514", constraint: "mirror_tokens_section" });
      expect(await everything(db)).toBe(before);
    }),
  );
});

// --------------------------------------------------------------------------------------------- The
// taints and the ending: ledger.taint_citing, ledger.taint_mirror_entities and ledger.end_mirror
// ---------------------------------------------------------------------------------------------

// Runs `fn` as pi_admin in a transaction that is rolled back, with the transaction's time.
const inRolledBack = (db: TestDatabase, fn: (query: Query, now: Date) => Promise<void>): Promise<void> =>
  session(db.urls.admin, async (query) => {
    await query("begin");
    try {
      await fn(query, one(await query<{ now: Date }>("select now() as now")).now);
    } finally {
      await query("rollback");
    }
  });
const byId =
  (rows: MirrorRow[]) =>
  (id: string): MirrorRow => {
    const row = rows.find((each) => each.id === id);
    if (row === undefined) throw new Error(`no mirror row ${id}`);
    return row;
  };
const taintOf = (row: MirrorRow) => ({
  ended: row.ended_at?.getTime() ?? null,
  reason: row.reason,
  tainted: row.tainted_at?.getTime() ?? null,
  last: row.last_tainted_at?.getTime() ?? null,
  evidence: row.evidence_ids,
});

describe("the mirror's taints and its ending", { timeout: TIMEOUT }, () => {
  it(
    "taint_citing ends and taints every mirror row whose evidence ids overlap, any client's, in its transaction, and the next call sends the removal first",
    inCopy(async (db, w) => {
      const m = mirror(db, w.narrow);
      await m.call({ section: "entities" });
      const [deleted, other, unrelated] = [
        stamp("deleted evidence"),
        stamp("other evidence"),
        stamp("unrelated evidence"),
      ];
      const rows = {
        live: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "captures",
          key: keyIn("captures"),
          evidence: [deleted, other],
          token: stamp("live"),
        }),
        ended: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "captures",
          key: keyIn("captures"),
          evidence: [deleted],
          ended: { at: daysAgo(2), reason: "replaced" },
        }),
        untouched: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "captures",
          key: keyIn("captures"),
          evidence: [unrelated],
        }),
        others: await plant(db, {
          client: w.wide.id,
          audience: BOTH,
          section: "captures",
          key: keyIn("captures"),
          evidence: [deleted],
        }),
      };
      const ids = Object.values(rows);
      const before = JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"));
      const endedAt = (await rowOf(db, rows.ended)).ended_at?.getTime() ?? null;
      await inRolledBack(db, async (query, now) => {
        await query(TAINT, [[deleted]]);
        const row = byId(
          await query<MirrorRow>("select * from ledger.mirror_entries where id = any ($1::text[])", [ids]),
        );
        const at = now.getTime();
        for (const id of [rows.live, rows.others])
          expect(taintOf(row(id)), id).toEqual({ ended: at, reason: "withdrawn", tainted: at, last: at, evidence: [] });
        // An ended row keeps its end and its reason, and is tainted.
        expect(taintOf(row(rows.ended))).toEqual({
          ended: endedAt,
          reason: "replaced",
          tainted: at,
          last: at,
          evidence: [],
        });
        expect(taintOf(row(rows.untouched))).toEqual({
          ended: null,
          reason: null,
          tainted: null,
          last: null,
          evidence: [unrelated],
        });
      });
      // Rolled back, the rows are as they were: the taint is the transaction's.
      expect(JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"))).toBe(before);

      // Committed, by the writer, as a deletion calls it: the next call sends the removal first.
      await queryAs(db.urls.writer, TAINT, [[deleted]]);
      const next = await m.call({ section: "beliefs" });
      expect(next.kinds[0]).toBe("removal");
      expect(next.removals.find((row) => row.projection_id === rows.live)?.reason).toBe("withdrawn");
      expect(
        next.removals.some((row) => row.projection_id === rows.untouched || row.projection_id === rows.others),
      ).toBe(false);
    }),
  );

  it(
    "taint_mirror_entities taints every row naming an erased person, any client's, and none else, in its transaction, and answers how many",
    inCopy(async (db, w) => {
      const [p1, p2] = w.people;
      const evidence = [stamp("person's evidence")];
      const rows = {
        live: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "events",
          key: keyIn("events"),
          entities: [p1, p2],
          evidence,
          token: stamp("t"),
        }),
        ended: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "events",
          key: keyIn("events"),
          entities: [p1],
          evidence,
          ended: { at: daysAgo(2), reason: "withdrawn" },
        }),
        untouched: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "events",
          key: keyIn("events"),
          entities: [p2],
          evidence,
        }),
        others: await plant(db, {
          client: w.wide.id,
          audience: BOTH,
          section: "entities",
          key: p1,
          entities: [p1],
          evidence,
        }),
      };
      const ids = Object.values(rows);
      const before = JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"));
      const endedAt = (await rowOf(db, rows.ended)).ended_at?.getTime() ?? null;
      await inRolledBack(db, async (query, now) => {
        expect(one(await query<{ n: number }>("select ledger.taint_mirror_entities($1::text[]) as n", [[p1]])).n).toBe(
          3,
        );
        const row = byId(
          await query<MirrorRow>("select * from ledger.mirror_entries where id = any ($1::text[])", [ids]),
        );
        const at = now.getTime();
        for (const id of [rows.live, rows.others])
          expect(taintOf(row(id)), id).toEqual({ ended: at, reason: "withdrawn", tainted: at, last: at, evidence: [] });
        expect(taintOf(row(rows.ended))).toEqual({
          ended: endedAt,
          reason: "withdrawn",
          tainted: at,
          last: at,
          evidence: [],
        });
        expect(taintOf(row(rows.untouched))).toEqual({
          ended: null,
          reason: null,
          tainted: null,
          last: null,
          evidence,
        });
      });
      expect(JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"))).toBe(before);
      // The control: a person no row names taints nothing.
      expect(
        one(await admin<{ n: number }>(db, "select ledger.taint_mirror_entities($1::text[]) as n", [[testId("ent")]]))
          .n,
      ).toBe(0);
      expect(JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"))).toBe(before);
    }),
  );

  it(
    "end_mirror ends every live row of the client withdrawn, in its transaction, and another client's rows and the client's ended ones are untouched",
    inCopy(async (db, w) => {
      const evidence = [stamp("kept evidence")];
      const rows = {
        first: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "entities",
          key: w.people[0],
          evidence,
          token: stamp("first"),
        }),
        second: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "events",
          key: keyIn("events"),
          evidence,
        }),
        ended: await plant(db, {
          client: w.narrow.id,
          audience: OWN,
          section: "events",
          key: keyIn("events"),
          evidence,
          ended: { at: daysAgo(2), reason: "replaced" },
        }),
        others: await plant(db, { client: w.wide.id, audience: BOTH, section: "entities", key: w.people[0], evidence }),
      };
      const ids = Object.values(rows);
      const before = JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"));
      const endedAt = (await rowOf(db, rows.ended)).ended_at?.getTime() ?? null;
      await inRolledBack(db, async (query, now) => {
        expect(one(await query<{ n: number }>("select ledger.end_mirror($1) as n", [w.narrow.id])).n).toBe(2);
        const row = byId(
          await query<MirrorRow>("select * from ledger.mirror_entries where id = any ($1::text[])", [ids]),
        );
        const at = now.getTime();
        // Ended, not tainted: its evidence is kept.
        for (const id of [rows.first, rows.second])
          expect(taintOf(row(id)), id).toEqual({ ended: at, reason: "withdrawn", tainted: null, last: null, evidence });
        expect(taintOf(row(rows.ended))).toEqual({
          ended: endedAt,
          reason: "replaced",
          tainted: null,
          last: null,
          evidence,
        });
        expect(taintOf(row(rows.others))).toEqual({ ended: null, reason: null, tainted: null, last: null, evidence });
      });
      expect(JSON.stringify(await admin(db, "select * from ledger.mirror_entries order by id"))).toBe(before);
      // The control: a client with no live row ends nothing.
      expect(one(await admin<{ n: number }>(db, "select ledger.end_mirror($1) as n", [w.toolless.id])).n).toBe(0);
    }),
  );
});
