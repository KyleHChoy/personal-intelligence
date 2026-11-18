import type { Claim, EvidenceId } from "@intelligence/contracts";
import type {
  CaptureId,
  CaptureItem,
  CaptureMention,
  ClaimRecord,
  FactList,
  MeetingItem,
} from "@intelligence/contracts/personal";
import { fakeLens } from "@intelligence/personal-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { openUnder, sealRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createReader, type Reader } from "../read/read.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { addMacDevice } from "../test-support/lens-setup.ts";
import { batchOf, countOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// A meeting's participants as the reader serves them. A meeting is pushed and drained as Lens and
// `pi sync` would, linked to a work event and so labelled {employer:example, own}; its
// capture.person claim is committed through the Pipeline as the meeting lane would hand it over, by
// code. No model is called and nothing of @intelligence/personal-extract is imported. Reserved
// domains only.

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
const DEVON: CaptureMention = { name: "Devon Marsh", address: "devon.marsh@example.org" };
const LINE = "I will send the rota by Friday.";

const LINKED: MeetingItem = {
  kind: "meeting",
  key: "meeting:01JRCAPPPK0000000000000001",
  revision: 0,
  startedAt: local(-45 * HOUR + 5 * MINUTE),
  endedAt: local(-44 * HOUR),
  app: { bundle: meetRule.value, name: "Meet" },
  title: "Rota review",
  consent: true,
  mode: "call",
  calendar: { start: local(-45 * HOUR), end: local(-44 * HOUR), title: "Rota review", attendees: [DEVON] },
  speakers: [
    { label: "S1", owner: true, mention: { address: OWNER.work } },
    { label: "S2", owner: false, mention: DEVON },
  ],
  segments: [
    { speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: "Can you take the weekend slots this time?" },
    { speaker: "S1", fromMs: 20_000, toMs: 40_000, channel: "input", text: LINE },
  ],
};
const LINKED_EVENT = event({
  event: {
    id: "evlensparticip01",
    status: "confirmed",
    etag: '"etag-evlensparticip01"',
    updated: utc(-3 * DAY),
    summary: "Rota review",
    start: { dateTime: utc(-45 * HOUR) },
    end: { dateTime: utc(-44 * HOUR) },
    organizer: { email: DEVON.address ?? "" },
    attendees: [
      { email: OWNER.work, self: true, responseStatus: "accepted" },
      { email: DEVON.address ?? "", displayName: DEVON.name ?? "", responseStatus: "accepted" },
    ],
  },
  title: "Rota review",
  startsAt: utc(-45 * HOUR),
  endsAt: utc(-44 * HOUR),
  allDay: false,
});

type World = {
  db: TestDatabase;
  reader: Reader;
  writer: Writer;
  token: string;
  evidence: EvidenceId;
  capture: CaptureId;
  owner: string;
  devon: string;
  eventId: string;
  claim: string;
  wide: Client;
  own: Client;
};
let w: World;

// Devon's capture.person claim, as the lane makes it by code: origin source, the meeting's label,
// basis third party, the meeting's start, citing the meeting and no span.
function participantRecord(evidence: string, devon: string): ClaimRecord {
  const claim = {
    id: `${evidence.slice(0, 60)}0002`,
    content: { type: "capture.person", subject: devon, fields: { role: "speaker" } },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: new Date(Date.parse(LINKED.startedAt)).toISOString(),
    evidence: [{ evidenceId: evidence, span: "capture:participants" }],
    primaryEvidenceId: evidence,
    label: { compartments: WIDE, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "lens-participants-1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "person",
    disclosure: ["third_party"],
    factKey: `capture.person ${devon} ${LINKED.key}`,
    lane: "meeting",
    fieldKinds: { role: "enum" },
    entities: [devon],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// An address of a person under one label, by hand as pi_admin.
async function addAccount(entity: string, address: string, compartments: string[]): Promise<void> {
  const id = testId("adr");
  await queryAs(
    w.db.urls.admin,
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
    [
      id,
      entity,
      fingerprint(w.db.keys, "address", address),
      fingerprint(w.db.keys, "domain", address.slice(address.indexOf("@") + 1)),
      sealRow(w.db.keys, compartments[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, address),
      compartments,
    ],
  );
}

// A meeting's knowledge.captures row, its facts opened under its label.
async function sealedFacts(key: string): Promise<{
  compartments: string[];
  facts: { linked: { event: string; speakers: Record<string, string> } | null; pushedAt?: string };
}> {
  const row = one(
    await queryAs<{ id: string; facts_enc: unknown; compartments: string[] }>(
      w.db.urls.admin,
      "select id, facts_enc, compartments from knowledge.captures where capture_key = $1",
      [key],
    ),
  );
  return {
    compartments: row.compartments,
    facts: JSON.parse(
      openUnder(
        w.db.keys,
        row.compartments,
        { table: "knowledge.captures", id: row.id, column: "facts_enc" },
        row.facts_enc as never,
      ),
    ),
  };
}

// Each revision's push of a key: its inbox rows' received_at, by revision.
const pushesOf = async (key: string): Promise<string[]> =>
  (
    await queryAs<{ received_at: Date }>(
      w.db.urls.admin,
      "select received_at from ledger.capture_inbox where source_key_fp = $1 order by revision",
      [fingerprint(w.db.keys, "source_id", key)],
    )
  ).map((row) => row.received_at.toISOString());

const facts = async (client: Client, args: Parameters<Reader["findFacts"]>[1] = {}): Promise<FactList> =>
  outcomeValue(await w.reader.findFacts(client.token, args));
let before: FactList;

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example", "employer:other"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const accounts = await connect(writer);
  const token = await addMacDevice(db, meetRule.value);
  expect(await ingestEvent(writer, accounts.workCalendar, LINKED_EVENT)).toBe("stored");
  const answer = await reader.pushCapture(token, { batch: "lens-participants-0001", items: [LINKED as CaptureItem] });
  expect(answer.ok).toBe(true);
  expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  const row = one(
    await queryAs<{ id: CaptureId; evidence_id: EvidenceId; event_id: string }>(
      db.urls.admin,
      "select id, evidence_id, event_id from knowledge.captures where capture_key = $1",
      [LINKED.key],
    ),
  );
  const owner = one(
    await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  const devon = one(
    await queryAs<{ entity_id: string }>(
      db.urls.admin,
      "select entity_id from knowledge.event_participants where event_id = $1",
      [row.event_id],
    ),
  ).entity_id;
  const wide = await insertReader({ db } as never, "wide-participants", WIDE, { tools: TOOLS, views: VIEWS });
  const own = await insertReader({ db } as never, "own-participants", ["own"], { tools: TOOLS, views: VIEWS });
  w = {
    db,
    reader,
    writer,
    token,
    evidence: row.evidence_id,
    capture: row.id,
    owner,
    devon,
    eventId: row.event_id,
    claim: "",
    wide,
    own,
  };
  before = await facts(own);
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    const record = participantRecord(row.evidence_id, devon);
    expect(
      await pipeline.commit(
        batchOf(row.evidence_id, [record], { lane: "skip", status: "skipped", code: "not_extracted" }),
      ),
    ).toBe("committed");
    w.claim = record.claim.id;
  } finally {
    await pipeline.close();
  }
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

// Runs before the erasure below, which removes Devon's accounts.
describe("the drain's speakers", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the drain seals the revision's own push time in a meeting's facts, its inbox row's received_at", async () => {
    const [pushed] = await pushesOf(LINKED.key);
    expect(pushed).toBeDefined();
    expect((await sealedFacts(LINKED.key)).facts.pushedAt).toBe(pushed);
  });

  it("a speaker whose address the event's participant holds only under a compartment outside the meeting's label resolves to nobody; under the label it resolves", async () => {
    const alt = "devon.alt@example.org";
    await addAccount(w.devon, alt, ["employer:other"]);
    const item: MeetingItem = {
      ...LINKED,
      key: "meeting:01JRCAPPPK0000000000000002",
      speakers: [...LINKED.speakers, { label: "S3", owner: false, mention: { address: alt } }],
    };
    expect(
      (await w.reader.pushCapture(w.token, { batch: "lens-participants-0002", items: [item as CaptureItem] })).ok,
    ).toBe(true);
    expect(await w.writer.takeCapture()).toMatchObject({ taken: 1, failed: 0, waiting: 0 });
    const outside = await sealedFacts(item.key);
    expect(outside.compartments).toEqual(WIDE);
    expect(outside.facts.linked).toMatchObject({ event: w.eventId, speakers: { S2: w.devon } });
    expect(outside.facts.linked?.speakers).not.toHaveProperty("S3");
    // The control: the same address under the meeting's label, and the next revision resolves S3.
    await addAccount(w.devon, alt, ["employer:example"]);
    expect(
      (
        await w.reader.pushCapture(w.token, {
          batch: "lens-participants-0003",
          items: [{ ...item, revision: 1 } as CaptureItem],
        })
      ).ok,
    ).toBe(true);
    expect(await w.writer.takeCapture()).toMatchObject({ replaced: 1, failed: 0, waiting: 0 });
    const next = await sealedFacts(item.key);
    expect(next.facts.linked?.speakers).toEqual({ S2: w.devon, S3: w.devon });
    const pushes = await pushesOf(item.key);
    expect(pushes).toHaveLength(2);
    expect(next.facts.pushedAt).toBe(pushes[1]);
    const first = one(
      await queryAs<{ first_pushed_at: Date }>(
        w.db.urls.admin,
        "select first_pushed_at from knowledge.captures where capture_key = $1",
        [item.key],
      ),
    ).first_pushed_at;
    expect(first.toISOString()).toBe(pushes[0]);
  });
});

describe("a meeting's participants as find_facts serves them", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a capture.person fact names its meeting's cap_ id and no segment, by its type and by the parent capture", async () => {
    for (const type of ["capture.person", "capture"] as const) {
      const found = (await facts(w.wide, { type })).facts;
      expect(found, type).toHaveLength(1);
      expect(found[0], type).toMatchObject({
        type: "capture.person",
        capture: w.capture,
        segment: null,
        message: null,
        document: null,
        passage: null,
        page: null,
        basis: "third_party",
        statedBy: null,
        provenance: "source",
        agentReported: false,
        fields: { role: "speaker" },
      });
      expect(found[0]?.subject, type).toMatchObject({ id: w.devon, kind: "person" });
    }
    // The positive control of the type filter: a commitment filter finds none of them.
    expect((await facts(w.wide, { type: "commitment" })).facts).toEqual([]);
  });

  it("a client not cleared for the meeting's label gets none, and its results equal a store without the meeting", async () => {
    const after = await facts(w.own);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(w.capture);
    expect((await facts(w.own, { type: "capture" })).facts).toEqual([]);
  });

  it("a person's erasure removes their capture.person claim", async () => {
    expect(await countOf(w.db, "knowledge.claims", "evidence_id = $1 and type = 'capture.person'", [w.evidence])).toBe(
      1,
    );
    const owner = createAdmin({
      url: w.db.urls.admin,
      keys: w.db.keys,
      log: eventLogger(),
      journal: journalPath(w.db.keyFile),
    });
    try {
      await owner.erasure.erasePerson(w.devon as never, { requestId: testId("req") });
    } finally {
      await owner.close();
    }
    expect(await countOf(w.db, "knowledge.claims", "evidence_id = $1 and type = 'capture.person'", [w.evidence])).toBe(
      0,
    );
    expect((await facts(w.wide, { type: "capture" })).facts).toEqual([]);
  });
});
