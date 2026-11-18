import type { Claim, EvidenceId } from "@intelligence/contracts";
import type {
  CaptureId,
  CaptureItem,
  CaptureMention,
  ClaimRecord,
  EntityId,
  EvidenceSpan,
  FactId,
  MeetingItem,
  ReadMeetingResult,
} from "@intelligence/contracts/personal";
import { meetingText } from "@intelligence/personal-core/lens";
import { fakeLens } from "@intelligence/personal-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { createWork, type Work } from "../agent-work/work.ts";
import { journalPath } from "../core/journal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { seedMeeting } from "../test-support/capture-fixtures.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { addMacDevice } from "../test-support/lens-setup.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { createReader, type Reader } from "./read.ts";

// A meeting is pushed and drained as Lens and `pi sync` would, linked to a work event and so
// labelled {employer:example, own}; its claim is committed through the Pipeline as the meeting lane
// would hand it over. A client cleared for `own` alone is told of it exactly what it is told of an
// id that names nothing (invariant 6), and after the owner erases the item, no client is told
// anything of it (invariant 10). No model is called. Reserved domains only.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();
const WIDE = ["employer:example", "own"];
const TOOLS = ["find_facts", "get_evidence_span", "get_timeline", "read_meeting"];
const VIEWS = ["self", "people", "work"];
const ABSENT = `cap_7${"Z".repeat(25)}` as CaptureId;

const lens = fakeLens({ now: new Date(T - 3 * DAY) });
const meetRule = lens.scope.find(
  (rule) => rule.match === "bundle" && rule.compartment === "own" && rule.kinds.includes("meeting"),
);
if (meetRule === undefined) throw new Error("the world's scope has no own meeting app");
const DEVON: CaptureMention = { name: "Devon Marsh", address: "devon.marsh@example.org" };
const ASK = "Can you take the weekend slots this time?";
const LINE = "I will send the rota by Friday.";
const AFTER = "Thanks, that settles it.";
const CANARY = "canary-read-meeting-commitment";

const MEETING: MeetingItem = {
  kind: "meeting",
  key: "meeting:01JRREADMEETNG000000000001",
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
    { speaker: "S2", fromMs: 0, toMs: 20_000, channel: "output", text: ASK },
    { speaker: "S1", fromMs: 20_000, toMs: 40_000, channel: "input", text: LINE },
    { speaker: "S2", fromMs: 40_000, toMs: 50_000, channel: "output", text: AFTER },
  ],
};
const MEETING_EVENT = event({
  event: {
    id: "evreadmeeting001",
    status: "confirmed",
    etag: '"etag-evreadmeeting001"',
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

// The owner's line's span, as the lane stores it: `seg:` offsets into meetingText.
const span = (() => {
  const cited = meetingText(MEETING).spans[1];
  if (cited === undefined) throw new Error("no second segment");
  return `seg:${cited.from}-${cited.to}`;
})();

type World = {
  db: TestDatabase;
  reader: Reader;
  writer: Writer;
  work: Work;
  evidence: EvidenceId;
  capture: CaptureId;
  claim: FactId;
  wide: Client;
  own: Client;
  device: string;
  devon: string;
};
let w: World;

// The owner's commitment to Devon from the meeting, as the lane would commit it: the meeting's whole
// label, citing the owner's line.
function commitmentRecord(evidence: string, owner: string, devon: string): ClaimRecord {
  const claim = {
    id: `${evidence.slice(0, 60)}0001`,
    content: { type: "commitment", subject: owner, fields: { counterparty: devon, what: `${LINE} ${CANARY}` } },
    statementKind: "stated_fact",
    basis: "explicit_self",
    assertedBy: owner,
    validFrom: new Date(Date.parse(MEETING.startedAt) + 20_000).toISOString(),
    evidence: [{ evidenceId: evidence, span }],
    primaryEvidenceId: evidence,
    label: { compartments: WIDE, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: ["third_party"],
    factKey: `meeting commitment ${evidence}`,
    lane: "meeting",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: [devon],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

const readMeeting = (client: Client, meeting: CaptureId, from?: number) =>
  w.work.readMeeting(client.token, { meeting, ...(from === undefined ? {} : { from }) });
const spanOf = (client: Client, fact: string) => w.reader.getEvidenceSpan(client.token, { fact: fact as FactId });
const readLogOf = (client: Client) =>
  queryAs<{ tool: string; bound: string[]; shown: string[] }>(
    w.db.urls.admin,
    "select tool, bound, shown from ledger.read_log where client_id = $1 order by id",
    [client.id],
  );
const value = <T>(outcome: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.value;
};

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const work = createWork({ reader, log });
  const accounts = await connect(writer);
  const token = await addMacDevice(db, meetRule.value);
  expect(await ingestEvent(writer, accounts.workCalendar, MEETING_EVENT)).toBe("stored");
  const answer = await reader.pushCapture(token, { batch: "read-meeting-0001", items: [MEETING as CaptureItem] });
  expect(answer.ok).toBe(true);
  expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  const row = one(
    await queryAs<{ id: CaptureId; evidence_id: EvidenceId; compartments: string[]; event_id: string }>(
      db.urls.admin,
      "select id, evidence_id, compartments, event_id from knowledge.captures where capture_key = $1",
      [MEETING.key],
    ),
  );
  expect(row.compartments).toEqual(WIDE);
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
  const wide = await insertReader({ db } as never, "wide-meeting", WIDE, { tools: TOOLS, views: VIEWS });
  const own = await insertReader({ db } as never, "own-meeting", ["own"], { tools: TOOLS, views: VIEWS });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  const record = commitmentRecord(row.evidence_id, owner, devon);
  try {
    expect(await pipeline.commit(batchOf(row.evidence_id, [record], { lane: "meeting", groups: 1, leftOut: 0 }))).toBe(
      "committed",
    );
  } finally {
    await pipeline.close();
  }
  const claim = one(
    await queryAs<{ id: FactId }>(db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [
      row.evidence_id,
    ]),
  ).id;
  w = {
    db,
    reader,
    writer,
    work,
    evidence: row.evidence_id,
    capture: row.id,
    claim,
    wide,
    own,
    device: token,
    devon,
  };
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("read_meeting", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("serves the meeting's times, people and turns in order, each text untrusted, and binds its evidence", async () => {
    const read: ReadMeetingResult = value(await readMeeting(w.wide, w.capture));
    expect(read).toMatchObject({
      meeting: w.capture,
      startedAt: new Date(MEETING.startedAt).toISOString(),
      endedAt: new Date(MEETING.endedAt).toISOString(),
      app: { untrusted: "Meet" },
      title: { untrusted: "Rota review" },
      mode: "call",
      notes: null,
      from: 0,
      next: null,
    });
    expect(read.turns).toEqual([
      { index: 0, speaker: "S2", at: new Date(MEETING.startedAt).toISOString(), text: { untrusted: ASK } },
      {
        index: 1,
        speaker: "S1",
        at: new Date(Date.parse(MEETING.startedAt) + 20_000).toISOString(),
        text: { untrusted: LINE },
      },
      {
        index: 2,
        speaker: "S2",
        at: new Date(Date.parse(MEETING.startedAt) + 40_000).toISOString(),
        text: { untrusted: AFTER },
      },
    ]);
    expect(read.speakers.map((one) => [one.label, one.owner])).toEqual([
      ["S1", true],
      ["S2", false],
    ]);
    expect(JSON.stringify(read.attendees)).toContain(DEVON.address);
    const [last] = (await readLogOf(w.wide)).slice(-1);
    expect(last).toMatchObject({ tool: "read_meeting", bound: [w.evidence], shown: [] });
  });

  it("reads on from a turn: from 1 gives the rest and no notes, and past the end gives no turns", async () => {
    const rest = value(await readMeeting(w.wide, w.capture, 1));
    expect(rest.turns.map((one) => one.index)).toEqual([1, 2]);
    expect(rest).toMatchObject({ from: 1, next: null, notes: null });
    expect(value(await readMeeting(w.wide, w.capture, 9)).turns).toEqual([]);
  });

  it("invariant 6: a client not cleared for the meeting's label is answered as for an id that names nothing", async () => {
    const hidden = await readMeeting(w.own, w.capture);
    const absent = await readMeeting(w.own, ABSENT);
    expect(hidden).toEqual({ ok: false, code: "not_found" });
    expect(hidden).toEqual(absent);
    // The control: the cleared client is answered, and an absent id is not_found for it too.
    expect((await readMeeting(w.wide, w.capture)).ok).toBe(true);
    expect(await readMeeting(w.wide, ABSENT)).toEqual(absent);
    // Neither refusal logged a read.
    expect((await readLogOf(w.own)).filter((one) => one.tool === "read_meeting")).toEqual([]);
  });
});

describe("who may read a meeting", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("read_meeting is an agent's alone: a reasoner holding it and the work view is refused, and still given a meeting fact's passage", async () => {
    const reasoner = await insertReader({ db: w.db } as never, "reasoner-meeting", WIDE, {
      tools: TOOLS,
      views: VIEWS,
    });
    await queryAs(w.db.urls.admin, "update policy.clients set kind = 'reasoner' where id = $1", [reasoner.id]);
    expect(await readMeeting(reasoner, w.capture)).toMatchObject({ ok: false, code: "not_permitted" });
    expect(value(await spanOf(reasoner, w.claim)).passage).toEqual({ untrusted: `S1: ${LINE}` });
  });
});

describe("get_evidence_span for a meeting fact", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("serves the turn the claim cites, as its line of the transcript, its meeting as the source, its evidence bound", async () => {
    const found: EvidenceSpan = value(await spanOf(w.wide, w.claim));
    expect(found).toMatchObject({
      fact: w.claim,
      source: { kind: "meeting", id: w.capture },
      passage: { untrusted: `S1: ${LINE}` },
      chars: `S1: ${LINE}`.length,
      cut: false,
    });
    expect(found.noPassage).toBeUndefined();
    const [last] = (await readLogOf(w.wide)).slice(-1);
    expect(last).toMatchObject({ tool: "get_evidence_span", bound: [w.evidence] });
  });

  it("invariant 6: a client not cleared for the fact is answered as for an id that names nothing", async () => {
    const hidden = await spanOf(w.own, w.claim);
    expect(hidden).toEqual({ ok: false, code: "not_found" });
    expect(hidden).toEqual(await spanOf(w.own, "f".repeat(64)));
  });
});

// The owner's admin, as `pi erase` and `pi erase settle` reach the store.
async function asOwner<T>(fn: (owner: ReturnType<typeof createAdmin>) => Promise<T>): Promise<T> {
  const owner = createAdmin({
    url: w.db.urls.admin,
    keys: w.db.keys,
    log: eventLogger(),
    journal: journalPath(w.db.keyFile),
  });
  try {
    return await fn(owner);
  } finally {
    await owner.close();
  }
}
const REVISED = "Thanks, Friday works for the rota.";

describe("invariant 10: what replaces or removes the meeting reaches the reads", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("a revision replaces the transcript: its capture serves the new text alone, and the old revision's claim is gone", async () => {
    const revised: MeetingItem = {
      ...MEETING,
      revision: 1,
      segments: MEETING.segments.map((one, n) => (n === 2 ? { ...one, text: REVISED } : one)),
    };
    const pushed = await w.reader.pushCapture(w.device, {
      batch: "read-meeting-0002",
      items: [revised as CaptureItem],
    });
    expect(pushed.ok).toBe(true);
    expect(await w.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
    const now = one(
      await queryAs<{ id: CaptureId; evidence_id: EvidenceId }>(
        w.db.urls.admin,
        "select id, evidence_id from knowledge.captures where capture_key = $1",
        [MEETING.key],
      ),
    );
    expect(now.evidence_id).not.toBe(w.evidence);
    const read = value(await readMeeting(w.wide, now.id));
    expect(read.turns.map((one) => one.text.untrusted)).toEqual([ASK, LINE, REVISED]);
    expect(JSON.stringify(read)).not.toContain(AFTER);
    const [last] = (await readLogOf(w.wide)).slice(-1);
    expect(last).toMatchObject({ tool: "read_meeting", bound: [now.evidence_id] });
    // The earlier revision's claims are removed with it: its fact is no fact now.
    expect(await spanOf(w.wide, w.claim)).toEqual(await spanOf(w.wide, "f".repeat(64)));
    w.capture = now.id;
    w.evidence = now.evidence_id;
  });

  it("a person's erasure: the meeting's speakers, organizer and attendees no longer name them", async () => {
    const before = JSON.stringify(value(await readMeeting(w.wide, w.capture)));
    expect(before).toContain(DEVON.address);
    expect(before).toContain(DEVON.name);
    await asOwner((owner) => owner.erasure.erasePerson(w.devon as EntityId, { requestId: testId("req") }));
    const read = value(await readMeeting(w.wide, w.capture));
    expect(JSON.stringify([read.speakers, read.organizer, read.attendees])).not.toContain(DEVON.address);
    expect(JSON.stringify([read.speakers, read.organizer, read.attendees])).not.toContain(DEVON.name);
    // The control: the meeting is still served, its turns whole.
    expect(read.turns).toHaveLength(3);
  });

  it("a forget from the device: read_meeting answers nothing of it, as for an id that names nothing", async () => {
    const pushed = await w.reader.pushCapture(w.device, {
      batch: "read-meeting-0003",
      items: [{ kind: "forget", key: "forget:01JRREADMEETNG000000000002", keys: [MEETING.key] } as CaptureItem],
    });
    expect(pushed.ok).toBe(true);
    expect(await asOwner((owner) => owner.lens.settleForgets())).toMatchObject({ settled: 1, failed: 0 });
    expect(await readMeeting(w.wide, w.capture)).toEqual(await readMeeting(w.wide, ABSENT));
  });

  it("the owner's erasure of a meeting: read_meeting answers nothing of it, as for an id that names nothing", async () => {
    const { id } = await seedMeeting(w.db, ["own"], "The plan for the shed.");
    expect(value(await readMeeting(w.wide, id)).turns).toHaveLength(1);
    await asOwner((owner) => owner.erasure.eraseItem({ kind: "capture", id }, { requestId: testId("req") }));
    expect(await readMeeting(w.wide, id)).toEqual(await readMeeting(w.wide, ABSENT));
  });
});
