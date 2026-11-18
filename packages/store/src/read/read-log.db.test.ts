import {
  type AboutView,
  AgentRecordId,
  type BeliefList,
  type ClientId,
  type CommitmentList,
  type ContextPack,
  type ContextView,
  DocumentId,
  type EntityId,
  type EvidenceSpan,
  type FactList,
  type GoalList,
  type MemoryProjection,
  MessageId,
  type OpenItems,
  type PathList,
  PersonalReadTool,
  type ReadOutcome,
  type SelfView,
  type SessionId,
  type TimelineView,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isUnbuiltRead, type UnbuiltReadTool } from "../admin/clients/admin-clients.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Ctx, Found } from "../core/read-ctx.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { OWNER } from "../test-support/cast.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { insideHold, recordingLogger, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY, outcomeValue, registration, UNKNOWN_TOKEN } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// The reader logs what every ok call read, from Reader.#read, under the client's one session. Every
// refusal has its positive control.

// get_self's work can be replaced for one test, to stand for a work function that asks for the
// session itself (as the context pack does) or returns a read set of a chosen size.
type SelfBody = (ctx: Ctx, now: Date) => Promise<Found<SelfView>>;
const override: { body: SelfBody | null } = { body: null };
vi.mock("./read-tools-self.ts", async (original) => {
  const real = await original<typeof import("./read-tools-self.ts")>();
  return {
    ...real,
    GET_SELF_TOOL: {
      ...real.GET_SELF_TOOL,
      work: (ctx: Ctx, _args: unknown, _client: unknown, env: { now: () => Date }) =>
        (override.body ?? real.getSelf)(ctx, env.now()),
    },
  };
});

const OPEN_SESSION = /^select policy\.open_session\(\$1\)$/;
// The sixth argument is the goals the call returned.
const LOG_READ = /^select policy\.log_read\(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)$/;
const LOG_CALL = /log_call\s*\(/i;
const ALL = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
  "get_evidence_span",
  "read_item",
];
// find_facts is a tool of the work view.
const VIEWS = ["self", "people", "work"];
const MISSING_MESSAGE = MessageId.parse(`msg_${"0".repeat(26)}`);
const MISSING_DOCUMENT = DocumentId.parse(`doc_${"0".repeat(26)}`);

// The calls made of each read tool: one that ends ok on the seeded world and, where the tool has
// them, one that ends invalid_request and one that ends not_found. Every tool has an ok call. A
// tool with no case does not compile.
type Ids = { entity: EntityId; message: MessageId; document: DocumentId; template: DocumentId; fact: string };
type Call = (reader: Reader, token: string, ids: Ids) => Promise<ReadOutcome<unknown>>;
type Case = { ok: Call; invalid?: Call; notFound?: Call };
// Read tools not yet built are not registered (UNBUILT_READ_TOOLS). read_record and find_records need
// a record the client can read, and this world's clients write none:
// agent-project-findings.db.test.ts pins their read log rows through the writer's read receipt.
type Served = Exclude<PersonalReadTool, UnbuiltReadTool | "read_record" | "find_records">;
const SERVED = PersonalReadTool.options.filter(
  (tool): tool is Served => !isUnbuiltRead(tool) && tool !== "read_record" && tool !== "find_records",
);
const CASES: Record<Served, Case> = {
  get_self: { ok: (reader, token) => reader.getSelf(token) },
  search: {
    ok: (reader, token) => reader.search(token, { query: "blake" }),
    invalid: (reader, token) => reader.search(token, { query: "" }),
  },
  get_entity: {
    ok: (reader, token, ids) => reader.getEntity(token, { id: ids.entity }),
    invalid: (reader, token) => reader.getEntity(token, { id: "ent_bad" as EntityId }),
    notFound: (reader, token) => reader.getEntity(token, { id: MISSING_ENTITY }),
  },
  get_timeline: {
    ok: (reader, token, ids) => reader.getTimeline(token, { id: ids.entity }),
    invalid: (reader, token) => reader.getTimeline(token, { id: "ent_bad" as EntityId }),
    notFound: (reader, token) => reader.getTimeline(token, { id: MISSING_ENTITY }),
  },
  find_messages: {
    ok: (reader, token) => reader.findMessages(token, {}),
    invalid: (reader, token) => reader.findMessages(token, { sender: "not a sender" }),
    notFound: (reader, token) => reader.findMessages(token, { entity: MISSING_ENTITY }),
  },
  read_message: {
    ok: (reader, token, ids) => reader.readMessage(token, { id: ids.message }),
    invalid: (reader, token) => reader.readMessage(token, { id: "msg_bad" as MessageId }),
    notFound: (reader, token) => reader.readMessage(token, { id: MISSING_MESSAGE }),
  },
  find_facts: { ok: (reader, token) => reader.findFacts(token, { type: "commitment" }) },
  build_context_pack: { ok: (reader, token) => reader.buildContextPack(token, { purpose: "agent_bootstrap" }) },
  get_commitments: { ok: (reader, token) => reader.getCommitments(token, {}) },
  get_open_items: { ok: (reader, token) => reader.getOpenItems(token, {}) },
  get_changes: { ok: (reader, token) => reader.getChanges(token, {}) },
  sync_memory: { ok: (reader, token) => reader.syncMemory(token, { have: [], canDelete: true }) },
  find_documents: { ok: (reader, token) => reader.findDocuments(token, {}) },
  get_document: {
    ok: (reader, token, ids) => reader.getDocument(token, { id: ids.document }),
    invalid: (reader, token) => reader.getDocument(token, { id: "doc_bad" as DocumentId }),
    notFound: (reader, token) => reader.getDocument(token, { id: MISSING_DOCUMENT }),
  },
  get_evidence_span: {
    ok: (reader, token, ids) => reader.getEvidenceSpan(token, { fact: ids.fact }),
    invalid: (reader, token) => reader.getEvidenceSpan(token, { fact: "A".repeat(64) }),
    notFound: (reader, token) => reader.getEvidenceSpan(token, { fact: "f".repeat(64) }),
  },
  read_item: {
    ok: (reader, token, ids) => reader.readItem(token, { message: ids.message }),
    invalid: (reader, token, ids) => reader.readItem(token, { message: ids.message, limit: 21 }),
    notFound: (reader, token) => reader.readItem(token, { message: MISSING_MESSAGE }),
  },
  // Blake wrote to the owner and was written to: one path, the own tie alone.
  find_paths: {
    ok: (reader, token, ids) => reader.findPaths(token, { target: ids.entity }),
    invalid: (reader, token) => reader.findPaths(token, { target: "ent_bad" as EntityId }),
    notFound: (reader, token) => reader.findPaths(token, { target: MISSING_ENTITY }),
  },
  get_beliefs: { ok: (reader, token) => reader.getBeliefs(token, { state: "any" }) },
  // The one goal the world is given below.
  list_goals: {
    ok: (reader, token) => reader.listGoals(token, {}),
    invalid: (reader, token) => reader.listGoals(token, { status: "open" as never }),
  },
  // The one document under a reference root.
  fetch_template: {
    ok: (reader, token, ids) => reader.fetchTemplate(token, { document: ids.template }),
    invalid: (reader, token) => reader.fetchTemplate(token, { document: "doc_bad" as DocumentId }),
    notFound: (reader, token) => reader.fetchTemplate(token, { document: MISSING_DOCUMENT }),
  },
  // The world's people and their commitments.
  context: {
    ok: (reader, token, ids) => reader.context(token, { task: "follow up with blake", entity: ids.entity }),
    invalid: (reader, token) => reader.context(token, { task: "" }),
    notFound: (reader, token) => reader.context(token, { task: "follow up", entity: MISSING_ENTITY }),
  },
  // The caller's own records, none on this client; a record not its own is not_found.
  record_reads: {
    ok: (reader, token) => reader.recordReads(token, {}),
    invalid: (reader, token) => reader.recordReads(token, { record: "rec_bad" as AgentRecordId }),
    notFound: (reader, token) => reader.recordReads(token, { record: AgentRecordId.parse(`rec_${"0".repeat(26)}`) }),
  },
  // The caller's audience's people, rebuilding here (no build ran).
  list_people: {
    ok: (reader, token) => reader.listPeople(token, {}),
    invalid: (reader, token) => reader.listPeople(token, { limit: 0 }),
  },
  // The world's person, the whole picture; a subject no one visible matches is not_found (its
  // refusal, subject_unknown).
  about: {
    ok: (reader, token, ids) => reader.about(token, { subject: { id: ids.entity } }),
    invalid: (reader, token) => reader.about(token, { subject: { name: "" } }),
    notFound: (reader, token) => reader.about(token, { subject: { id: MISSING_ENTITY } }),
  },
  // The caller's own settled records, none on this client.
  get_suggestions: {
    ok: (reader, token) => reader.getSuggestions(token, { state: "any" }),
    invalid: (reader, token) => reader.getSuggestions(token, { limit: 0 }),
  },
};
// The tools whose statements this file holds to a shape: the six the read log was built over. A
// tool added since has its statements held by its own test.
const RECORDED: readonly PersonalReadTool[] = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
];
const ADDED: readonly PersonalReadTool[] = SERVED.filter((tool) => !RECORDED.includes(tool));
// Which list each tool's items go in. read_item binds a message whose text it
// served and shows one with none; the world's messages have no text, so it shows them all.
const BOUND: readonly PersonalReadTool[] = [
  "read_message",
  "find_facts",
  "get_commitments",
  "get_document",
  "get_evidence_span",
  "get_beliefs",
  "fetch_template",
];

// What every call opens with, in this order, before any statement of its tool: the transaction, the
// token, the client it names and, for a call that goes on to read, the read allowance.
const BEGIN = /^BEGIN ISOLATION LEVEL REPEATABLE READ$/;
const TOKEN = /^select set_config\('pi\.client_token', /;
const CLIENT = /^select id, name, compartments, views, tools from policy\.current_client\(\)$/;
const ALLOWANCE = /^select policy\.read_allowance\(\$1\)$/;
const COMMIT = /^\s*commit\b/i;
// A statement that reads and writes nothing: a tool's own are all of this form.
const READS = /^\s*(select|with)\b/i;
// A call of a function of the store's schemas, by its qualified name.
const STORE_FUNCTION = /\b((?:policy|ledger|knowledge|vault|projections|queue)\.[a-z_][a-z0-9_]*)\s*\(/gi;
// A statement the old pin would have refused among a tool's own: a select that writes.
const WRITES = "select policy.log_read($1, $2, $3::text[], $4::text[], '{}')";
// What a call that reads nothing sends, whatever its tool: the head and its one call row, the row
// with its reason. A not_found call adds the allowance and the one lookup that
// found nothing. No session is opened and no read is logged.
const REFUSAL: Readonly<Record<string, readonly RegExp[]>> = {
  unauthorized: [BEGIN, TOKEN, CLIENT, COMMIT],
  not_permitted: [BEGIN, TOKEN, CLIENT, LOG_CALL, COMMIT],
  invalid_request: [BEGIN, TOKEN, CLIENT, LOG_CALL, COMMIT],
  not_found: [BEGIN, TOKEN, CLIENT, ALLOWANCE, READS, LOG_CALL, COMMIT],
};
function expectForms(statements: string[], forms: readonly RegExp[], where: string): void {
  expect(statements.length, where).toBe(forms.length);
  for (const [at, form] of forms.entries()) expect(statements[at], `${where}, statement ${at}`).toMatch(form);
}

let store: TestStore;
let ids: Ids;
let serial = 0;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW });
  const world = await seedWorld(store.writer, store.admin);
  await seedFacts(world.ownerEntity());
  const { token } = await store.admin.clients.addClient(
    registration("seeding", ["own", "employer:example"], { tools: [...ALL] as never, views: VIEWS as never }),
  );
  const message = outcomeValue(await store.reader.findMessages(token, {})).messages[0]?.id as MessageId | undefined;
  if (message === undefined) throw new Error("the world holds no message");
  const fact = (
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.claims where fact_key_fp = $1", [
      fingerprint(store.db.keys, "fact", "k-log-own"),
    ])
  )[0]?.id;
  if (fact === undefined) throw new Error("the world holds no fact");
  // One document of the personal label's Drive, ingested as sync ingests one.
  const drive = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
  await store.admin.drive.addRoot("personal", "fldReadLogRoot0001", "extract");
  const doc: DriveFile = {
    id: "1ReadLogDoc0001",
    name: "Read log plan",
    mimeType: "application/vnd.google-apps.document",
    createdTime: "2026-01-01T00:00:00.000Z",
    modifiedTime: "2026-01-02T00:00:00.000Z",
    parent: "fldReadLogRoot0001",
    root: "fldReadLogRoot0001",
    ownedByMe: true,
    modifiedByMe: true,
    canDownload: true,
  };
  const raw = driveItem(doc, { blocks: [{ kind: "paragraph", text: "A plan." }] }, null, {
    sourceAccount: drive.id,
    changeKind: "backfill",
    ownerAddress: OWNER.personal,
  });
  if ((await store.writer.ingestItem(drive, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))) !== "stored")
    throw new Error("the document was not stored");
  // One under a reference root, for fetch_template.
  await store.admin.drive.addRoot("personal", "fldReadLogTmpl0001", "reference");
  const template = {
    ...doc,
    id: "1ReadLogTmpl0001",
    name: "Read log letter",
    parent: "fldReadLogTmpl0001",
    root: "fldReadLogTmpl0001",
  };
  const rawTemplate = driveItem(
    template,
    { blocks: [{ kind: "paragraph", text: "Dear {{first name:text}}." }] },
    null,
    { sourceAccount: drive.id, changeKind: "backfill", ownerAddress: OWNER.personal },
  );
  if (
    (await store.writer.ingestItem(drive, rawTemplate, (ctx) => deriveItem(rawTemplate, ctx, PERSONAL_LIMITS))) !==
    "stored"
  )
    throw new Error("the template was not stored");
  const { token: docs } = await store.admin.clients.addClient(
    registration("seeding-docs", ["own"], { tools: ["find_documents"] as never, views: ["work"] as never }),
  );
  const document = outcomeValue(await store.reader.findDocuments(docs, { reference: false })).documents[0]?.id as
    | DocumentId
    | undefined;
  const templateId = outcomeValue(await store.reader.findDocuments(docs, { reference: true })).documents[0]?.id as
    | DocumentId
    | undefined;
  if (document === undefined || templateId === undefined) throw new Error("the world holds no document");
  // One goal, so list_goals has a row to return.
  await store.admin.work.addGoal("Ship the review.", "own", { requestId: "req-read-log-goal" });
  ids = { entity: world.entityOf(WORLD.both.address), message, document, template: templateId, fact };
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

beforeEach(() => {
  override.body = null;
});

// A new client cleared for both compartments with every tool, and its id.
async function newClient(tools: string[] = ALL): Promise<{ token: string; id: ClientId }> {
  serial += 1;
  const name = `log-client-${serial}`;
  const { token } = await store.admin.clients.addClient(
    registration(name, ["own", "employer:example"], { tools: tools as never, views: VIEWS as never }),
  );
  const id = (await store.admin.clients.listClients()).find((one) => one.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id: id as ClientId };
}

// Two commitments, each on a message of its own compartment, committed through the Pipeline as
// the extraction would, and a belief for the first, so that find_facts has facts to return.
async function seedFacts(owner: string): Promise<void> {
  const messages = await queryAs<{ evidence_id: string; compartment: string }>(
    store.db.urls.admin,
    "select distinct on (compartments[1]) evidence_id, compartments[1] as compartment from knowledge.messages order by compartments[1], sent_at, id",
  );
  expect(messages.map((row) => row.compartment)).toEqual(["employer:example", "own"]);
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const records = [];
    for (const { evidence_id, compartment } of messages) {
      // Each cites its message's subject, which the world's messages have, so get_evidence_span
      // has a passage to serve; and is a whole commitment, its counterparty the owner, as
      // get_beliefs compiles it.
      // Said before the reader's clock, so the belief computed from it holds.
      const base = claimRecord(evidence_id, compartment, owner, {
        factKey: `k-log-${compartment}`,
        validFrom: new Date(WORLD_NOW.getTime() - 86_400_000).toISOString(),
      });
      const record = {
        ...base,
        claim: {
          ...base.claim,
          evidence: [{ evidenceId: evidence_id, span: "subject:chars:0-6" }],
          content: { ...base.claim.content, fields: { ...base.claim.content.fields, counterparty: owner } },
        },
        fieldKinds: { ...base.fieldKinds, counterparty: "entity" },
      } as unknown as typeof base;
      records.push(record);
      expect(await pipeline.commit(batchOf(evidence_id, [record]))).toBe("committed");
    }
  } finally {
    await pipeline.close();
  }
  await knownBy(store.db, store.now);
}

// A reader of its own on a recording pool: its own sessions, and the statements of one call.
function recordingReader(options?: { rejectWhen?: (text: string) => boolean }) {
  const recorded = recordingPool(store.readerPool, options);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: insideHold([...recorded.statements]) };
  };
  return { reader, during };
}

type LogRow = { session_id: string; tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] };
const readLogOf = (client: ClientId): Promise<LogRow[]> =>
  queryAs<LogRow>(
    store.db.urls.admin,
    "select session_id, tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
    [client],
  );
const sessionsOf = (client: ClientId): Promise<{ id: string }[]> =>
  queryAs(store.db.urls.admin, "select id from ledger.sessions where client_id = $1 order by id", [client]);

// The evidence ids of every message and event id anywhere in a value, looked up as pi_admin.
async function evidenceIn(value: unknown): Promise<string[]> {
  const found = [...new Set(JSON.stringify(value).match(/\b(?:msg|evt|doc)_[0-9A-HJKMNP-TV-Z]{26}\b/g) ?? [])];
  if (found.length === 0) return [];
  const rows = await queryAs<{ id: string; evidence_id: string }>(
    store.db.urls.admin,
    "select id, evidence_id from knowledge.messages where id = any($1) union all select id, evidence_id from knowledge.events where id = any($1) union all select id, evidence_id from knowledge.documents where id = any($1)",
    [found],
  );
  expect(rows.map((row) => row.id).sort()).toEqual(found.sort());
  return [...new Set(rows.map((row) => row.evidence_id))].sort();
}

// The evidence ids of the claims a projection's entries' beliefs rest on, looked up as pi_admin:
// every claim of each entry's fact key within the client's clearance (no claim here supersedes another).
async function entryEvidence(value: MemoryProjection): Promise<string[]> {
  const rows = await queryAs<{ evidence_id: string }>(
    store.db.urls.admin,
    `select distinct c.evidence_id from knowledge.claims c
     where c.compartments <@ $1 and c.fact_key_fp = any ($2) order by c.evidence_id`,
    [["employer:example", "own"], value.entries.map((entry) => entry.stamp.fact)],
  );
  return rows.map((row) => row.evidence_id);
}

// The evidence ids of about's cited claims, its beliefs' and its claims' in no belief, looked up
// as pi_admin from the claim ids it cites (`fact`, a stored claim id).
async function citedEvidence(view: AboutView): Promise<string[]> {
  const facts = [
    ...view.beliefs.flatMap((one) => one.support.map((claim) => claim.fact)),
    ...view.claims.map((one) => one.fact),
  ];
  const rows = await queryAs<{ evidence_id: string }>(
    store.db.urls.admin,
    "select distinct evidence_id from knowledge.claims where id = any ($1) order by evidence_id",
    [facts],
  );
  return rows.map((row) => row.evidence_id);
}

// The fact key fingerprints of a page of facts, looked up as pi_admin.
async function factKeysOf(list: FactList): Promise<string[]> {
  expect(list.facts.length).toBeGreaterThan(0);
  const rows = await queryAs<{ fact_key_fp: string }>(
    store.db.urls.admin,
    "select distinct fact_key_fp from knowledge.claims where id = any($1) order by fact_key_fp",
    [list.facts.map((fact) => fact.id)],
  );
  expect(rows.length).toBeGreaterThan(0);
  return rows.map((row) => row.fact_key_fp);
}

// The fact key fingerprints a tool's value carries, by the tool's own shape.
async function factKeysIn(tool: PersonalReadTool, value: unknown): Promise<string[]> {
  if (tool === "find_facts") return factKeysOf(value as FactList);
  if (tool === "get_commitments") {
    const facts = (value as CommitmentList).commitments.map((one) => one.belief.fact);
    expect(facts.length, tool).toBeGreaterThan(0);
    return facts.sort();
  }
  if (tool === "get_evidence_span")
    return factKeysOf({ facts: [{ id: (value as EvidenceSpan).fact }], more: false } as unknown as FactList);
  // get_self's lines, the owner's own beliefs; this world's are commitments,
  // which the page leaves to get_commitments, so none (read-self-facts.db.test.ts logs some).
  if (tool === "get_self")
    return ((value as SelfView).sections ?? []).flatMap((one) => one.lines.map((line) => line.fact)).sort();
  if (tool === "get_beliefs") {
    const facts = (value as BeliefList).beliefs.map((one) => one.fact);
    expect(facts.length, tool).toBeGreaterThan(0);
    return facts.sort();
  }
  // The timeline's facts, as find_facts' (none name the entity in this world).
  if (tool === "get_timeline") {
    const facts = (value as TimelineView).entries.flatMap((entry) => (entry.kind === "fact" ? [entry.fact] : []));
    return facts.length === 0 ? [] : factKeysOf({ facts, more: false });
  }
  // list_goals' goals are beliefs, so its row names each goal's fact
  // key: a goal the owner set by its goal id's latest key, one they only stated by the key it is listed by.
  if (tool === "list_goals") {
    const goals = (value as GoalList).goals;
    const rows = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select distinct on (goal_id) fact_key_fp from knowledge.goal_ids where goal_id = any($1) order by goal_id, created_at desc",
      [goals.map((one) => one.id).filter((id) => id.startsWith("gol_"))],
    );
    return [
      ...new Set([
        ...rows.map((row) => row.fact_key_fp),
        ...goals.map((one) => one.id).filter((id) => /^[0-9a-f]{64}$/.test(id)),
      ]),
    ].sort();
  }
  if (tool === "sync_memory") {
    const facts = (value as MemoryProjection).entries.map((entry) => entry.stamp.fact);
    expect(facts.length, tool).toBeGreaterThan(0);
    return facts.sort();
  }
  // find_paths: the fact key of each belief a hop cites, by its facts.
  if (tool === "find_paths") {
    const facts = (value as PathList).paths.flatMap((path) => path.hops.flatMap((hop) => hop.facts));
    if (facts.length === 0) return [];
    const rows = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select distinct fact_key_fp from knowledge.claims where id = any($1) order by fact_key_fp",
      [facts],
    );
    return rows.map((row) => row.fact_key_fp);
  }
  if (tool === "get_open_items")
    return (value as OpenItems).items
      .flatMap((one) => (one.source.kind === "commitment" ? [one.source.id] : []))
      .sort();
  // context's lines, its people's lines, its commitments and its open items' facts.
  if (tool === "context") {
    const view = value as ContextView;
    return [
      ...new Set(
        [...view.sections.flatMap((one) => one.lines), ...view.people.flatMap((one) => one.lines)]
          .map((line) => line.fact)
          .concat(view.commitments.map((one) => one.belief.fact))
          .concat(
            (view.openItems?.items ?? []).flatMap((one) => (one.source.kind === "commitment" ? [one.source.id] : [])),
          ),
      ),
    ].sort();
  }
  // about's beliefs, and the fact keys of its claims in no belief.
  if (tool === "about") {
    const view = value as AboutView;
    const claims =
      view.claims.length === 0
        ? []
        : await factKeysOf({ facts: view.claims.map((one) => ({ id: one.fact })), more: false } as unknown as FactList);
    return [...new Set([...view.beliefs.map((one) => one.factKey), ...claims])].sort();
  }
  if (tool === "build_context_pack") {
    const facts = (value as ContextPack).items.flatMap((item) =>
      item.kind === "commitment" || item.kind === "belief" ? [item.id] : [],
    );
    expect(facts.length, tool).toBeGreaterThan(0);
    return facts.sort();
  }
  return [];
}

describe("the read log", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the read log covers every tool", async () => {
    const client = await newClient();
    // The added tools go in by an update as pi_admin, not through the admin's registration.
    await queryAs(store.db.urls.admin, "update policy.clients set tools = tools || $2::text[] where id = $1", [
      client.id,
      ADDED,
    ]);
    const { reader } = recordingReader();
    for (const tool of SERVED) {
      const one = CASES[tool];
      // A tool added later with no case fails here.
      expect(one, tool).toBeDefined();
      const logged = (await readLogOf(client.id)).length;
      const outcome = await one.ok(reader, client.token, ids);
      expect(outcome.ok, tool).toBe(true);
      const value = outcomeValue(outcome);
      const rows = (await readLogOf(client.id)).slice(logged);
      expect(rows.length, tool).toBe(1);
      const row = rows[0] as LogRow;
      expect(row.tool, tool).toBe(tool);
      // get_changes serves what `next` does, by what its own test holds (agent-seam.db.test.ts).
      if (tool === "get_changes") continue;
      // sync_memory is A13's exception: a MemoryEntry carries no message or event id, so `shown` is
      // the union of the served entries' evidence ids, those of the claims their beliefs rest on,
      // and `bound` is empty. about cites claims by their evidence ids too, besides the ids of its
      // meetings and messages.
      const expected =
        tool === "sync_memory"
          ? await entryEvidence(value as MemoryProjection)
          : tool === "about"
            ? [...new Set([...(await evidenceIn(value)), ...(await citedEvidence(value as AboutView))])].sort()
            : await evidenceIn(value);
      expect([...new Set([...row.bound, ...row.shown])].sort(), tool).toEqual(expected);
      // Each id is in the list BOUND names for that tool, bound or shown, and not in the other. get_self has
      // both: its meetings are shown, and its lines' cited messages bound, since their phrases were
      // opened; a line names no message, and this world's owner has no line.
      if (tool === "get_self") {
        const self = value as SelfView;
        expect([...row.bound].sort(), tool).toEqual([]);
        expect([...row.shown].sort(), tool).toEqual(await evidenceIn(self.upcoming));
      } else if (tool === "get_timeline") {
        // A fact's message is bound, as find_facts', and mail and meetings shown.
        const entries = (value as TimelineView).entries;
        expect([...row.bound].sort(), tool).toEqual(await evidenceIn(entries.filter((entry) => entry.kind === "fact")));
        expect([...row.shown].sort(), tool).toEqual(await evidenceIn(entries.filter((entry) => entry.kind !== "fact")));
      } else if (tool === "get_open_items") {
        // A fact's message is bound, as find_facts'; a calendar event's shown.
        const { items } = value as OpenItems;
        expect([...row.bound].sort(), tool).toEqual(
          await evidenceIn(items.filter((one) => one.source.kind !== "calendar")),
        );
        expect([...row.shown].sort(), tool).toEqual(
          await evidenceIn(items.filter((one) => one.source.kind === "calendar")),
        );
      } else if (tool === "context") {
        // An open item's message is bound, as a commitment's; its meetings' events shown.
        const context = value as { openItems?: unknown };
        expect([...row.bound].sort(), tool).toEqual(await evidenceIn(context.openItems));
      } else if (BOUND.includes(tool)) expect(row.shown, tool).toEqual([]);
      else expect(row.bound, tool).toEqual([]);
      // The fact key fingerprint of every fact returned: find_facts' facts, get_commitments'
      // commitments, a version 2 pack's commitment items and get_self's stated beliefs; none for
      // any other tool.
      expect([...row.fact_key_fps].sort(), tool).toEqual(await factKeysIn(tool, value));
      // Not vacuous: every tool but search returned something by id on this world; find_paths
      // returns entities and fact ids, and no evidence id, so its path is the proof.
      if (tool === "find_paths") expect((value as PathList).paths.length, tool).toBeGreaterThan(0);
      // A goal is no evidence: list_goals' row names nothing, so its goals are the proof.
      else if (tool === "list_goals") expect((value as GoalList).goals.length, tool).toBeGreaterThan(0);
      // record_reads shows the caller's own records alone, by id, and no evidence: its row names
      // nothing, and its own test (record-reads.db.test.ts) is the proof. get_suggestions the same:
      // the caller's own settled records, none here, and its own test
      // (suggestions-settled.db.test.ts) is the proof. list_people names no evidence, and no warmth
      // build ran here (the audience is rebuilding): read-warmth.db.test.ts is the proof.
      else if (tool !== "search" && tool !== "record_reads" && tool !== "get_suggestions" && tool !== "list_people")
        expect(expected.length, tool).toBeGreaterThan(0);
    }
  });

  it("the first ok call of a client opens one session and later calls reuse it", async () => {
    const client = await newClient();
    const { reader, during } = recordingReader();
    const first = await during(() => reader.search(client.token, { query: "blake" }));
    expect(first.statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    for (let n = 0; n < 2; n += 1) {
      const later = await during(() => reader.getSelf(client.token));
      expect(later.answer.ok).toBe(true);
      expect(later.statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(0);
    }
    const sessions = await sessionsOf(client.id);
    expect(sessions).toHaveLength(1);
    expect(reader.sessions.of(client.id)).toBe(sessions[0]?.id);
    expect((await readLogOf(client.id)).map((row) => row.session_id)).toEqual([
      sessions[0]?.id,
      sessions[0]?.id,
      sessions[0]?.id,
    ]);
  });

  it("ctx.session() asked twice in one transaction opens one session", async () => {
    const client = await newClient();
    const seen: SessionId[] = [];
    const real = (await vi.importActual<typeof import("./read-tools-self.ts")>("./read-tools-self.ts")).getSelf;
    override.body = async (ctx, now) => {
      seen.push(await ctx.session(), await ctx.session());
      return real(ctx, now);
    };
    const { reader, during } = recordingReader();
    const { answer, statements } = await during(() => reader.getSelf(client.token));
    expect(answer.ok).toBe(true);
    expect(statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    expect(seen[0]).toBe(seen[1]);
    expect((await sessionsOf(client.id)).map((row) => row.id)).toEqual([seen[0]]);
  });

  it("a work function that asks for the session on a client's first call opens it in its own transaction, and the read is logged under it", async () => {
    const client = await newClient();
    const seen: SessionId[] = [];
    const real = (await vi.importActual<typeof import("./read-tools-self.ts")>("./read-tools-self.ts")).getSelf;
    override.body = async (ctx, now) => {
      seen.push(await ctx.session());
      return real(ctx, now);
    };
    const { reader, during } = recordingReader();
    const { statements } = await during(() => reader.getSelf(client.token));
    // Opened inside the call's transaction, before the tool's first query, and only once.
    const opened = statements.findIndex((text) => OPEN_SESSION.test(text));
    const firstRead = statements.findIndex((text) => /knowledge\./.test(text));
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThan(firstRead);
    expect(statements[0]).toMatch(/^\s*begin\b/i);
    expect(statements.at(-1)).toMatch(/^\s*commit\b/i);
    expect(statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    expect((await readLogOf(client.id)).map((row) => row.session_id)).toEqual([seen[0]]);
  });

  it("first calls of one client that run at once all answer, and later calls use one session", async () => {
    const client = await newClient();
    const { reader } = recordingReader();
    const answers = await Promise.all([
      reader.getSelf(client.token),
      reader.search(client.token, { query: "blake" }),
      reader.getEntity(client.token, { id: ids.entity }),
      reader.getTimeline(client.token, { id: ids.entity }),
    ]);
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, true]);
    const remembered = reader.sessions.of(client.id);
    expect((await sessionsOf(client.id)).map((row) => row.id)).toContain(remembered);
    expect((await reader.search(client.token, { query: "blake" })).ok).toBe(true);
    expect((await readLogOf(client.id)).at(-1)?.session_id).toBe(remembered);
  });

  it("two readers on one database are two sessions for one client", async () => {
    const client = await newClient();
    const one = recordingReader().reader;
    const two = recordingReader().reader;
    expect((await one.search(client.token, { query: "blake" })).ok).toBe(true);
    expect((await two.search(client.token, { query: "blake" })).ok).toBe(true);
    const sessions = await sessionsOf(client.id);
    expect(sessions).toHaveLength(2);
    expect(new Set([one.sessions.of(client.id), two.sessions.of(client.id)])).toEqual(
      new Set(sessions.map((row) => row.id)),
    );
  });

  it("an unauthorized call, client() and a refused call open no session and log no read", async () => {
    const client = await newClient(["search"]);
    const { reader } = recordingReader();
    expect(await reader.getSelf(UNKNOWN_TOKEN)).toEqual({ ok: false, code: "unauthorized" });
    expect((await reader.client(client.token))?.id).toBe(client.id);
    expect(await reader.refused(client.token, "search")).toEqual({ ok: false, code: "invalid_request" });
    expect(await reader.getSelf(client.token)).toEqual({ ok: false, code: "not_permitted" });
    expect(await reader.search(client.token, { query: "" })).toEqual({ ok: false, code: "invalid_request" });
    expect(await sessionsOf(client.id)).toEqual([]);
    expect(await readLogOf(client.id)).toEqual([]);
    expect(reader.sessions.of(client.id)).toBeUndefined();
    // The control: an ok call by the same client opens one and logs its read.
    expect((await reader.search(client.token, { query: "blake" })).ok).toBe(true);
    expect(await sessionsOf(client.id)).toHaveLength(1);
    expect(await readLogOf(client.id)).toHaveLength(1);
  });

  it("a not_found call logs no read and opens no session", async () => {
    const client = await newClient();
    const { reader } = recordingReader();
    expect(await reader.getEntity(client.token, { id: MISSING_ENTITY })).toEqual({ ok: false, code: "not_found" });
    expect(await reader.readMessage(client.token, { id: MISSING_MESSAGE })).toEqual({ ok: false, code: "not_found" });
    expect(await sessionsOf(client.id)).toEqual([]);
    expect(await readLogOf(client.id)).toEqual([]);
    expect((await reader.getEntity(client.token, { id: ids.entity })).ok).toBe(true);
    expect(await readLogOf(client.id)).toHaveLength(1);
  });

  it("a session is not remembered when its transaction rolled back", async () => {
    const client = await newClient();
    const failing = { on: true };
    const { reader, during } = recordingReader({ rejectWhen: (text) => failing.on && LOG_CALL.test(text) });
    const failed = await during(() => reader.search(client.token, { query: "blake" }));
    expect(failed.answer).toEqual({ ok: false, code: "unavailable" });
    // It had opened one, in the transaction that rolled back.
    expect(failed.statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    expect(reader.sessions.of(client.id)).toBeUndefined();
    expect(await sessionsOf(client.id)).toEqual([]);
    failing.on = false;
    const next = await during(() => reader.search(client.token, { query: "blake" }));
    expect(next.answer.ok).toBe(true);
    expect(next.statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    expect(await sessionsOf(client.id)).toHaveLength(1);
  });

  it("an ok call opens with the client and its allowance, sends only reads of its tool's, then open_session on a client's first call, then log_read, then log_call", async () => {
    const client = await newClient();
    for (const tool of RECORDED) {
      const ok = CASES[tool as Served].ok;
      const { reader, during } = recordingReader();
      // The first call: open_session and log_read before log_call and the commit.
      const first = await during(() => ok(reader, client.token, ids));
      expect(first.answer.ok, tool).toBe(true);
      expectForms(first.statements.slice(0, 4), [BEGIN, TOKEN, CLIENT, ALLOWANCE], `${tool} head`);
      expectForms(first.statements.slice(-4), [OPEN_SESSION, LOG_READ, LOG_CALL, COMMIT], `${tool} tail`);
      // Between them the tool's own statements, each a read: the session, the read log and the
      // call row are written once each, at the end, and nothing else is written.
      const own = first.statements.slice(4, -4);
      expect(own.length, tool).toBeGreaterThan(0);
      for (const text of own) {
        expect(text, tool).toMatch(READS);
        for (const write of [OPEN_SESSION, LOG_READ, LOG_CALL]) expect(text, tool).not.toMatch(write);
      }
      // A statement that starts with `select` may still call a function that writes. So every
      // function of the store's schemas a tool's own statements call is one the database holds as
      // stable or immutable, which can write nothing: the functions that write (the session, the
      // read log, the call log) are the head's and the tail's alone.
      const called = [
        ...new Set(own.flatMap((text) => [...text.matchAll(STORE_FUNCTION)].map((match) => match[1] ?? ""))),
      ];
      const held = await queryAs<{ name: string; writes: boolean }>(
        store.db.urls.admin,
        `select n.nspname || '.' || p.proname as name, bool_or(p.provolatile = 'v') as writes
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname || '.' || p.proname = any($1) group by 1`,
        [called],
      );
      // A name that is no function is a table or a view, read by a statement that is a read.
      expect(
        held.filter((one) => one.writes).map((one) => one.name),
        tool,
      ).toEqual([]);
      // The control: the reading finds the calls a tool makes, and a writing function fails it.
      expect([...WRITES.matchAll(STORE_FUNCTION)].map((match) => match[1])).toEqual(["policy.log_read"]);
      // A later call: the same statements, but for open_session.
      const later = await during(() => ok(reader, client.token, ids));
      expect(later.answer.ok, tool).toBe(true);
      expect(later.statements, tool).toEqual(first.statements.filter((text) => !OPEN_SESSION.test(text)));
    }
  });

  it("a refused, an invalid and a not_found call send the head and one call row, the same whatever the tool, and nothing of the tool's but a not_found's one lookup", async () => {
    const full = await newClient();
    const narrow = await newClient(["get_entity"]);
    const sent: Record<string, string[]> = {};
    for (const tool of RECORDED) {
      const one = CASES[tool as Served];
      const ok = one.ok;
      const cases: [string, Call, string][] = [["unauthorized", ok, UNKNOWN_TOKEN]];
      // narrow holds get_entity alone: for get_entity, its refusal is that of search.
      const searchOk = CASES.search.ok as Call;
      cases.push(["not_permitted", tool === "get_entity" ? searchOk : ok, narrow.token]);
      if (one.invalid !== undefined) cases.push(["invalid_request", one.invalid, full.token]);
      if (one.notFound !== undefined) cases.push(["not_found", one.notFound, full.token]);
      for (const [outcome, call, token] of cases) {
        const { reader, during } = recordingReader();
        const { answer, statements } = await during(() => call(reader, token, ids));
        expect(answer, `${tool} ${outcome}`).toEqual({ ok: false, code: outcome });
        expectForms(statements, REFUSAL[outcome] ?? [], `${tool} ${outcome}`);
        // A not_found's lookup is its tool's; every other refusal is one text for every tool.
        if (outcome === "not_found") continue;
        sent[outcome] ??= statements;
        expect(statements, `${tool} ${outcome}`).toEqual(sent[outcome]);
      }
    }
    expect(Object.keys(sent).sort()).toEqual(["invalid_request", "not_permitted", "unauthorized"]);
    expect(await readLogOf(full.id)).toEqual([]);
    expect(await readLogOf(narrow.id)).toEqual([]);
  });

  it("find_facts, which once had no statements, opens and reuses the session, logs its read before log_call, and is refused as every tool is", async () => {
    const full = await newClient();
    const narrow = await newClient(["get_entity"]);
    const { reader, during } = recordingReader();
    // The first ok call: open_session, then log_read, then log_call and the commit.
    const first = await during(() => reader.findFacts(full.token, { type: "commitment" }));
    expect(outcomeValue(first.answer).facts.length).toBeGreaterThan(0);
    expect(first.statements.at(-4)).toMatch(OPEN_SESSION);
    expect(first.statements.at(-3)).toMatch(LOG_READ);
    expect(first.statements.at(-2)).toMatch(LOG_CALL);
    expect(first.statements.filter((text) => OPEN_SESSION.test(text))).toHaveLength(1);
    expect(first.statements.at(-1)).toMatch(/^\s*commit\b/i);
    // A later call: the same statements, but for open_session.
    const later = await during(() => reader.findFacts(full.token, { type: "commitment" }));
    expect(later.statements).toEqual(first.statements.filter((text) => !OPEN_SESSION.test(text)));
    const sessions = await sessionsOf(full.id);
    expect(sessions).toHaveLength(1);
    expect((await readLogOf(full.id)).map((row) => [row.session_id, row.tool])).toEqual([
      [sessions[0]?.id, "find_facts"],
      [sessions[0]?.id, "find_facts"],
    ]);
    // Each refusal sends what every tool's same refusal sends: the shared path of #read, and for
    // not_found the one entity check, which takes a project's id too.
    const refusals: [string, () => Promise<ReadOutcome<unknown>>][] = [
      ["unauthorized", () => reader.findFacts(UNKNOWN_TOKEN, {})],
      ["not_permitted", () => reader.findFacts(narrow.token, {})],
      ["invalid_request", () => reader.findFacts(full.token, { limit: 0 })],
      ["not_found", () => reader.findFacts(full.token, { entity: MISSING_ENTITY })],
    ];
    for (const [outcome, call] of refusals) {
      const { answer, statements } = await during(call);
      expect(answer, outcome).toEqual({ ok: false, code: outcome });
      expectForms(statements, REFUSAL[outcome] ?? [], outcome);
      if (outcome === "not_found")
        expect(statements[4]).toMatch(
          /from knowledge\.entities e\s+where e\.id = \$1 and e\.kind in \('person', 'organization', 'project'\)/,
        );
    }
    expect(await readLogOf(full.id)).toHaveLength(2);
    expect(await readLogOf(narrow.id)).toEqual([]);
    expect(await sessionsOf(narrow.id)).toEqual([]);
  });

  it("search logs three empty lists", async () => {
    const client = await newClient();
    const { reader } = recordingReader();
    expect(outcomeValue(await reader.search(client.token, { query: "blake" })).results.length).toBeGreaterThan(0);
    expect(await readLogOf(client.id)).toEqual([
      { session_id: expect.stringMatching(/^ses_/), tool: "search", bound: [], shown: [], fact_key_fps: [] },
    ]);
  });

  it("read_message logs its message as bound, and find_messages logs its summaries as shown", async () => {
    const client = await newClient();
    const { reader } = recordingReader();
    const found = outcomeValue(await reader.findMessages(client.token, {}));
    const read = outcomeValue(await reader.readMessage(client.token, { id: ids.message }));
    const evidenceOf = async (messageIds: string[]): Promise<string[]> =>
      (
        await queryAs<{ evidence_id: string }>(
          store.db.urls.admin,
          "select evidence_id from knowledge.messages where id = any($1) order by evidence_id",
          [messageIds],
        )
      ).map((row) => row.evidence_id);
    const [findRow, readRow] = await readLogOf(client.id);
    expect(found.messages.length).toBeGreaterThan(1);
    expect([...(findRow?.shown ?? [])].sort()).toEqual(await evidenceOf(found.messages.map((one) => one.id)));
    expect(findRow?.bound).toEqual([]);
    expect(readRow?.bound).toEqual(await evidenceOf([read.id]));
    expect(readRow?.shown).toEqual([]);
  });

  it("a read set of 1 001 items is logged as two rows", async () => {
    const client = await newClient();
    const items = Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, "0"));
    const real = (await vi.importActual<typeof import("./read-tools-self.ts")>("./read-tools-self.ts")).getSelf;
    override.body = async (ctx, now) => ({
      ...(await real(ctx, now)),
      read: { bound: [], shown: items, factKeyFps: [] },
    });
    const { reader } = recordingReader();
    expect((await reader.getSelf(client.token)).ok).toBe(true);
    const rows = await readLogOf(client.id);
    expect(rows.map((row) => row.shown.length)).toEqual([1000, 1]);
    expect(rows.flatMap((row) => row.shown)).toEqual(items);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(1);
    // One call, one call-log row.
    expect(
      await queryAs(store.db.urls.admin, "select tool, outcome from policy.calls where client_id = $1", [client.id]),
    ).toEqual([{ tool: "get_self", outcome: "ok" }]);
  });

  it("a read log failure answers unavailable and returns no value", async () => {
    const client = await newClient();
    const failing = { on: true };
    const { reader } = recordingReader({ rejectWhen: (text) => failing.on && LOG_READ.test(text) });
    const events = store.log.events.length;
    expect(await reader.getSelf(client.token)).toEqual({ ok: false, code: "unavailable" });
    expect(store.log.events.slice(events)).toEqual([{ event: "read_failed", code: "unavailable" }]);
    expect(await readLogOf(client.id)).toEqual([]);
    expect(await sessionsOf(client.id)).toEqual([]);
    expect(
      await queryAs(store.db.urls.admin, "select tool from policy.calls where client_id = $1", [client.id]),
    ).toEqual([]);
    // The control: the same call with the log working.
    failing.on = false;
    expect((await reader.getSelf(client.token)).ok).toBe(true);
    expect(await readLogOf(client.id)).toHaveLength(1);
  });
});
