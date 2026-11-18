import type { Claim } from "@intelligence/contracts";
import {
  AgentRecordId,
  type ClaimRecord,
  type ClientId,
  DocumentId,
  type EntityId,
  type EventId,
  MessageId,
  PersonalReadTool,
  type ReadOutcome,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { isUnbuiltRead } from "../admin/clients/admin-clients.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { OWNER } from "../test-support/cast.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import type { Reader } from "./read.ts";

// What every read tool records as read, on one fixture rich enough to reach each part of its read
// set: mail, meetings, documents, the owner's lines, a role naming an organization (whoOf's
// organization names, which reach the log by the call's own context), commitments, a goal, a
// project, an agent's records, and enough lines that a card and a page are cut to size. The whole
// answer is pinned in read-log-sets.snap, per ask, as stable words for the ids: forgetting and
// exposure read these rows, so a part of a read set left out would under-log and pass every other
// test (invariant 10), and a set that follows a row the viewer cannot see breaks invariant 6. Three
// clients ask the same questions: one cleared for both compartments, one for `own` alone, and the
// agent whose own records are there to read back.

const WIDE = ["employer:example", "own"];
// A long line, so that the pages that fit themselves to a size have something to cut.
const LONG = "a long stated line ".repeat(110);

type Ids = {
  blake: EntityId;
  organization: EntityId;
  project: EntityId;
  message: MessageId;
  event: EventId;
  document: DocumentId;
  template: DocumentId;
  fact: string;
  belief: string;
  record: AgentRecordId;
};

type Spec = {
  key: string;
  type: string;
  subject: string;
  subjectKind: "owner" | "person";
  entities?: string[];
  evidence: { id: string; compartment: string };
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values?: Record<string, unknown>;
  belief: boolean;
  // Whose word it is: its subject's own (the default), or a third party's, which a commitment's
  // belief does not count.
  basis?: "explicit_self" | "third_party";
};

let store: TestStore;
let ids: Ids;
let specs: Spec[] = [];
let writerToken: string;

// A time of its own for each claim, so that a cut by recency keeps the same lines on every run.
const at = (n: number): string => new Date(Date.parse("2026-03-01T09:00:00.000Z") + n * 60_000).toISOString();

function recordOf(spec: Spec, n: number): ClaimRecord {
  const base = claimRecord(spec.evidence.id, spec.evidence.compartment, spec.subject, {
    n,
    type: spec.type,
    factKey: spec.key,
    validFrom: at(n),
    entities: spec.entities ?? [],
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      evidence: [{ evidenceId: spec.evidence.id, span: "subject:chars:0-6" }],
      // The subject's own word, which the belief computed at read counts.
      assertedBy: spec.subject,
      basis: spec.basis ?? "explicit_self",
      content: { ...base.claim.content, type: spec.type, fields: spec.fields },
    } as Claim,
    subjectKind: spec.subjectKind,
    fieldKinds: spec.fieldKinds,
  } as unknown as ClaimRecord;
}

async function seedClaims(): Promise<void> {
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const records = specs.map((spec, index) => ({ spec, record: recordOf(spec, index + 1) }));
    const byItem = new Map<string, ClaimRecord[]>();
    for (const { record } of records) {
      const item = record.claim.primaryEvidenceId as string;
      byItem.set(item, [...(byItem.get(item) ?? []), record]);
    }
    for (const [evidence, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidence as never, claims))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  await knownBy(store.db, store.now);
}

// One document under a root, ingested as sync ingests one.
async function seedDocument(
  one: { id: string; name: string; root: string; modified: string; text: string },
  account: Awaited<ReturnType<TestStore["writer"]["ensureSourceAccount"]>>,
): Promise<void> {
  const doc: DriveFile = {
    id: one.id,
    name: one.name,
    mimeType: "application/vnd.google-apps.document",
    createdTime: "2026-01-01T00:00:00.000Z",
    modifiedTime: one.modified,
    parent: one.root,
    root: one.root,
    ownedByMe: true,
    modifiedByMe: true,
    canDownload: true,
  };
  const raw = driveItem(doc, { blocks: [{ kind: "paragraph", text: one.text }] }, null, {
    sourceAccount: account.id,
    changeKind: "backfill",
    ownerAddress: OWNER.personal,
  });
  if ((await store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))) !== "stored")
    throw new Error("the document was not stored");
}

// Every read tool the store serves, and where its arguments reach another part of its read set, an
// ask for that part.
type Ask = {
  ask: string;
  tool: PersonalReadTool;
  call: (reader: Reader, token: string) => Promise<ReadOutcome<unknown>>;
};
const asks = (): Ask[] => [
  { ask: "get_self", tool: "get_self", call: (r, t) => r.getSelf(t) },
  { ask: "get_self history", tool: "get_self", call: (r, t) => r.getSelf(t, { history: true }) },
  { ask: "get_self work", tool: "get_self", call: (r, t) => r.getSelf(t, { work: true }) },
  { ask: "get_self moves", tool: "get_self", call: (r, t) => r.getSelf(t, { moves: true }) },
  { ask: "get_self domain", tool: "get_self", call: (r, t) => r.getSelf(t, { domain: "health" }) },
  { ask: "search", tool: "search", call: (r, t) => r.search(t, { query: "blake" }) },
  { ask: "get_entity person", tool: "get_entity", call: (r, t) => r.getEntity(t, { id: ids.blake }) },
  { ask: "get_entity organization", tool: "get_entity", call: (r, t) => r.getEntity(t, { id: ids.organization }) },
  { ask: "get_entity project", tool: "get_entity", call: (r, t) => r.getEntity(t, { id: ids.project }) },
  { ask: "get_timeline", tool: "get_timeline", call: (r, t) => r.getTimeline(t, { id: ids.blake }) },
  { ask: "find_messages", tool: "find_messages", call: (r, t) => r.findMessages(t, {}) },
  { ask: "read_message", tool: "read_message", call: (r, t) => r.readMessage(t, { id: ids.message }) },
  { ask: "read_item", tool: "read_item", call: (r, t) => r.readItem(t, { message: ids.message }) },
  { ask: "find_facts type", tool: "find_facts", call: (r, t) => r.findFacts(t, { type: "commitment" }) },
  { ask: "find_facts role", tool: "find_facts", call: (r, t) => r.findFacts(t, { type: "role" }) },
  { ask: "find_facts entity", tool: "find_facts", call: (r, t) => r.findFacts(t, { entity: ids.blake }) },
  { ask: "find_facts belief", tool: "find_facts", call: (r, t) => r.findFacts(t, { belief: ids.belief }) },
  { ask: "get_evidence_span", tool: "get_evidence_span", call: (r, t) => r.getEvidenceSpan(t, { fact: ids.fact }) },
  { ask: "get_commitments", tool: "get_commitments", call: (r, t) => r.getCommitments(t, {}) },
  { ask: "get_commitments with", tool: "get_commitments", call: (r, t) => r.getCommitments(t, { with: ids.blake }) },
  { ask: "get_beliefs", tool: "get_beliefs", call: (r, t) => r.getBeliefs(t, { state: "any" }) },
  { ask: "get_beliefs entity", tool: "get_beliefs", call: (r, t) => r.getBeliefs(t, { entity: ids.blake }) },
  { ask: "get_open_items", tool: "get_open_items", call: (r, t) => r.getOpenItems(t, {}) },
  { ask: "get_changes", tool: "get_changes", call: (r, t) => r.getChanges(t, {}) },
  {
    ask: "build_context_pack agent_bootstrap",
    tool: "build_context_pack",
    call: (r, t) => r.buildContextPack(t, { purpose: "agent_bootstrap" }),
  },
  {
    ask: "build_context_pack person_brief",
    tool: "build_context_pack",
    call: (r, t) => r.buildContextPack(t, { purpose: "person_brief", entity: ids.blake }),
  },
  {
    ask: "build_context_pack meeting_prep",
    tool: "build_context_pack",
    call: (r, t) => r.buildContextPack(t, { purpose: "meeting_prep", event: ids.event }),
  },
  { ask: "context task", tool: "context", call: (r, t) => r.context(t, { task: "plan the week" }) },
  {
    ask: "context entity",
    tool: "context",
    call: (r, t) => r.context(t, { task: "follow up with blake", entity: ids.blake }),
  },
  {
    ask: "context event",
    tool: "context",
    call: (r, t) => r.context(t, { task: "prepare for the meeting", event: ids.event }),
  },
  { ask: "sync_memory", tool: "sync_memory", call: (r, t) => r.syncMemory(t, { have: [], canDelete: true }) },
  { ask: "find_documents", tool: "find_documents", call: (r, t) => r.findDocuments(t, {}) },
  { ask: "get_document", tool: "get_document", call: (r, t) => r.getDocument(t, { id: ids.document }) },
  { ask: "fetch_template", tool: "fetch_template", call: (r, t) => r.fetchTemplate(t, { document: ids.template }) },
  { ask: "find_paths", tool: "find_paths", call: (r, t) => r.findPaths(t, { target: ids.blake }) },
  { ask: "list_goals", tool: "list_goals", call: (r, t) => r.listGoals(t, {}) },
  { ask: "record_reads", tool: "record_reads", call: (r, t) => r.recordReads(t, {}) },
  { ask: "read_record", tool: "read_record", call: (r, t) => r.readRecord(t, { record: ids.record }) },
  { ask: "find_records", tool: "find_records", call: (r, t) => r.findRecords(t, {}) },
  { ask: "list_people", tool: "list_people", call: (r, t) => r.listPeople(t, {}) },
  { ask: "about person", tool: "about", call: (r, t) => r.about(t, { subject: { id: ids.blake } }) },
  { ask: "about organization", tool: "about", call: (r, t) => r.about(t, { subject: { id: ids.organization } }) },
  { ask: "about name", tool: "about", call: (r, t) => r.about(t, { subject: { name: "Blake Canary-Both" } }) },
  { ask: "get_suggestions", tool: "get_suggestions", call: (r, t) => r.getSuggestions(t, { state: "any" }) },
];

type LogRow = {
  tool: string;
  bound: string[];
  shown: string[];
  fact_key_fps: string[];
  goals: string[];
  lessons: string[];
};

// Stable words for ids that differ on every run: an item by its kind, compartment and time; a fact
// key by the key this file gave it or, for one it did not, by its claim's type; a record and a goal
// by their order.
async function wordsOf(): Promise<(id: string) => string> {
  const words = new Map<string, string>();
  const stamp = (column: string): string => `to_char(${column} at time zone 'UTC', 'MM-DD"T"HH24:MI')`;
  const items = await queryAs<{ id: string; word: string }>(
    store.db.urls.admin,
    `select m.evidence_id as id, 'message ' || m.compartments[1] || ' ' || ${stamp("m.sent_at")} as word from knowledge.messages m
     union all select e.evidence_id, 'event ' || e.compartments[1] || ' ' || ${stamp("e.occurred_at")} from knowledge.events e
     union all select d.evidence_id, 'document ' || d.compartments[1] || ' ' || ${stamp("i.observed_at")} from knowledge.documents d join vault.evidence_items i on i.id = d.evidence_id`,
  );
  for (const row of items) words.set(row.id, row.word);
  for (const row of await queryAs<{ fact_key_fp: string; type: string }>(
    store.db.urls.admin,
    "select distinct fact_key_fp, type from knowledge.claims",
  ))
    words.set(row.fact_key_fp, `fact ${row.type}`);
  for (const spec of specs) words.set(fingerprint(store.db.keys, "fact", spec.key), `fact ${spec.key}`);
  (await queryAs<{ id: string }>(store.db.urls.admin, "select id from ledger.agent_writes order by id")).forEach(
    (row, index) => {
      words.set(row.id, `record ${index + 1}`);
    },
  );
  (
    await queryAs<{ goal_id: string; fact_key_fp: string }>(
      store.db.urls.admin,
      "select goal_id, fact_key_fp from knowledge.goal_ids order by created_at, goal_id",
    )
  ).forEach((row, index) => {
    words.set(row.goal_id, `goal ${index + 1}`);
    words.set(row.fact_key_fp, `fact goal ${index + 1}`);
  });
  return (id) => {
    const word = words.get(id);
    if (word === undefined) throw new Error(`no word for a read log id starting ${id.slice(0, 4)}`);
    return word;
  };
}

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "agent:sets-writer"] });
  const world = await seedWorld(store.writer, store.admin);
  const owner = world.ownerEntity();
  const blake = world.entityOf(WORLD.both.address);
  const messages = await queryAs<{ evidence_id: string; compartment: string; id: string }>(
    store.db.urls.admin,
    "select evidence_id, compartments[1] as compartment, id from knowledge.messages order by sent_at, id",
  );
  const own = messages.filter((one) => one.compartment === "own");
  const work = messages.filter((one) => one.compartment === "employer:example");
  const pick = (list: typeof messages, index: number) => {
    const one = list[index % list.length] as (typeof messages)[number];
    return { id: one.evidence_id, compartment: one.compartment };
  };
  const [domain] = await queryAs<{ entity_id: EntityId }>(
    store.db.urls.admin,
    "select entity_id from knowledge.domains where domain_fp = $1",
    [fingerprint(store.db.keys, "domain", "example.com")],
  );
  if (domain === undefined) throw new Error("the world holds no organization");
  const organization = domain.entity_id;
  const project = await store.admin.projects.add("Lighthouse", { requestId: "req-sets-project" });
  specs = [
    {
      key: "c-own",
      type: "commitment",
      subject: owner,
      subjectKind: "owner",
      entities: [blake],
      evidence: pick(own, 0),
      fields: { what: "send the plan", counterparty: blake, due: "2026-03-12" },
      fieldKinds: { what: "text", counterparty: "entity", due: "date" },
      values: { counterparty: blake, due: "2026-03-12" },
      belief: true,
    },
    {
      key: "c-work",
      type: "commitment",
      subject: blake,
      subjectKind: "person",
      entities: [blake, owner],
      evidence: pick(work, 0),
      fields: { what: "review the draft", counterparty: owner },
      fieldKinds: { what: "text", counterparty: "entity" },
      values: { counterparty: owner },
      belief: true,
    },
    // A commitment in no belief: read by the tools that read claims alone.
    {
      key: "c-loose",
      type: "commitment",
      subject: owner,
      subjectKind: "owner",
      evidence: pick(own, 1),
      fields: { what: "call the bank" },
      fieldKinds: { what: "text" },
      belief: false,
      basis: "third_party",
    },
    // The role that names the organization: its name reaches the log by the call's context.
    {
      key: "r-blake",
      type: "role",
      subject: blake,
      subjectKind: "person",
      entities: [blake, organization],
      evidence: pick(work, 1),
      fields: { title: "Lead", organization, organization_name: "Canary Works" },
      fieldKinds: { title: "text", organization: "entity", organization_name: "text" },
      values: { organization },
      belief: true,
    },
    {
      key: "a-blake",
      type: "affiliation",
      subject: blake,
      subjectKind: "person",
      entities: [blake, organization],
      evidence: pick(own, 2),
      fields: { relation: "employee", organization, organization_name: "Canary Works" },
      fieldKinds: { relation: "enum", organization: "entity", organization_name: "text" },
      values: { relation: "employee", organization },
      belief: true,
    },
    // The owner's own lines, long and many, so a page fits itself to its size.
    ...Array.from(
      { length: 40 },
      (_, index): Spec => ({
        key: `p-${index.toString().padStart(2, "0")}`,
        type: "preference",
        subject: owner,
        subjectKind: "owner",
        evidence: pick(index % 2 === 0 ? own : work, index),
        fields: { what: `${LONG} ${index}`, polarity: "prefers" },
        fieldKinds: { what: "text", polarity: "enum" },
        values: { polarity: "prefers" },
        belief: true,
      }),
    ),
    {
      key: "g-owner",
      type: "goal",
      subject: owner,
      subjectKind: "owner",
      evidence: pick(own, 3),
      fields: { what: "finish the survey" },
      fieldKinds: { what: "text" },
      belief: true,
    },
    // More lines of a person than a card holds, so the card cuts and narrows its read set.
    ...Array.from(
      { length: 30 },
      (_, index): Spec => ({
        key: `n-${index.toString().padStart(2, "0")}`,
        type: "need",
        subject: blake,
        subjectKind: "person",
        entities: [blake],
        evidence: pick(index % 2 === 0 ? work : own, index + 2),
        fields: { what: `a need of ${index}` },
        fieldKinds: { what: "text" },
        belief: true,
      }),
    ),
  ];
  await seedClaims();
  const drive = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
  await store.admin.drive.addRoot("personal", "fldSetsRoot0001", "extract");
  await seedDocument(
    {
      id: "1SetsDoc0001",
      name: "A plan",
      root: "fldSetsRoot0001",
      modified: "2026-01-02T00:00:00.000Z",
      text: "A plan.",
    },
    drive,
  );
  await store.admin.drive.addRoot("personal", "fldSetsTmpl0001", "reference");
  await seedDocument(
    {
      id: "1SetsTmpl0001",
      name: "A letter",
      root: "fldSetsTmpl0001",
      modified: "2026-01-03T00:00:00.000Z",
      text: "Dear {{first name:text}}.",
    },
    drive,
  );
  await store.admin.work.addGoal("Ship the review.", "own", { requestId: "req-sets-goal" });
  // A record to read back, written by another client under its own compartment.
  const registrar = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
  const writer = await registrar.clients.addClient(
    registration("sets-writer", ["own", "employer:example", "agent:sets-writer"], {
      tools: ["record", "find_documents"] as never,
      views: ["self", "people", "work"] as never,
    }),
  );
  writerToken = writer.token;
  const record = outcomeValue(
    await store.reader.record(writer.token, { kind: "note", body: "a note on the plan", requestId: "req-sets-note" }),
  );
  outcomeValue(
    await store.reader.record(writer.token, {
      kind: "finding",
      body: "a finding on the plan",
      requestId: "req-sets-finding",
      project: project as never,
    }),
  );
  const document = outcomeValue(await store.reader.findDocuments(writer.token, { reference: false })).documents[0]?.id;
  const template = outcomeValue(await store.reader.findDocuments(writer.token, { reference: true })).documents[0]?.id;
  const [event] = await queryAs<{ id: EventId }>(
    store.db.urls.admin,
    "select id from knowledge.events where compartments = '{own}' order by occurred_at limit 1",
  );
  const [fact] = await queryAs<{ id: string }>(
    store.db.urls.admin,
    "select id from knowledge.claims where fact_key_fp = $1",
    [fingerprint(store.db.keys, "fact", "c-own")],
  );
  if (own[0] === undefined || event === undefined || fact === undefined) throw new Error("the world is short");
  if (document === undefined || template === undefined) throw new Error("the world holds no document");
  ids = {
    blake: blake as EntityId,
    organization,
    project: project as unknown as EntityId,
    message: MessageId.parse(own[0].id),
    event: event.id,
    document: DocumentId.parse(document),
    template: DocumentId.parse(template),
    fact: fact.id,
    belief: fingerprint(store.db.keys, "fact", "c-own"),
    record: AgentRecordId.parse(record.recordId),
  };
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

// A client's answers to every ask: its tools set to every served read tool, as pi_admin.
async function setsOf(name: string, given?: string): Promise<Record<string, unknown>> {
  const token =
    given ??
    (
      await store.admin.clients.addClient(
        registration(name, name === "sets-own" ? ["own"] : WIDE, {
          tools: ["get_self"] as never,
          views: ["self", "people", "work"] as never,
        }),
      )
    ).token;
  const id = (await store.admin.clients.listClients()).find((one) => one.name === name)?.id as ClientId;
  await queryAs(store.db.urls.admin, "update policy.clients set tools = tools || $2::text[] where id = $1", [
    id,
    PersonalReadTool.options.filter((tool) => !isUnbuiltRead(tool)),
  ]);
  const rowsOf = (): Promise<LogRow[]> =>
    queryAs<LogRow>(
      store.db.urls.admin,
      "select tool, bound, shown, fact_key_fps, goals, lessons from ledger.read_log where client_id = $1 order by id",
      [id],
    );
  const sets: Record<string, unknown> = {};
  for (const one of asks()) {
    const before = (await rowsOf()).length;
    const outcome = await one.call(store.reader, token);
    const rows = (await rowsOf()).slice(before);
    if (!outcome.ok) {
      sets[one.ask] = outcome.code;
      expect(rows, one.ask).toEqual([]);
      continue;
    }
    for (const row of rows) expect(row.tool, one.ask).toBe(one.tool);
    const word = await wordsOf();
    const words = (list: (row: LogRow) => string[]): string[] => [...new Set(rows.flatMap(list))].map(word).sort();
    sets[one.ask] = {
      bound: words((row) => row.bound),
      shown: words((row) => row.shown),
      factKeyFps: words((row) => row.fact_key_fps),
      goals: words((row) => row.goals),
      lessons: words((row) => row.lessons),
    };
  }
  return sets;
}

describe("what each read tool records as read", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("asks every served read tool", () => {
    const asked = new Set<string>(asks().map((one) => one.tool));
    // sync_mirror is not registered by default: it serves a device's captures, none here, and its
    // rows are lens/mirror's own test's.
    expect(PersonalReadTool.options.filter((tool) => !isUnbuiltRead(tool) && !asked.has(tool))).toEqual([]);
  });

  it("records these sets, for each of three clients", async () => {
    const sets = {
      both: await setsOf("sets-both"),
      own: await setsOf("sets-own"),
      writer: await setsOf("sets-writer", writerToken),
    };
    await expect(`${JSON.stringify(sets, null, 1)}\n`).toMatchFileSnapshot("read-log-sets.snap");
  });
});
