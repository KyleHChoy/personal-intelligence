import type { Claim, EvidenceId } from "@intelligence/contracts";
import type {
  CaptureId,
  CaptureItem,
  CaptureMention,
  ClaimRecord,
  CommitmentList,
  ContextPack,
  FactList,
  MeetingItem,
} from "@intelligence/contracts/personal";
import { meetingText } from "@intelligence/personal-core/lens";
import { fakeLens } from "@intelligence/personal-core/testing";
import { remarkDays } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerCommitments } from "../admin/work/admin-commitments.ts";
import type { AdminContext } from "../core/admin-context.ts";
import { createDb } from "../core/job-db.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { connect, OWNER } from "../test-support/cast.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent } from "../test-support/items.ts";
import { addMacDevice } from "../test-support/lens-setup.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { createReader, type Reader } from "./read.ts";

// A meeting is pushed and drained as Lens and `pi sync` would, linked to a work event and so labelled
// {employer:example, own}; its claims are committed through the Pipeline as the meeting lane would hand
// them over, and its belief computed when asked. No model is called and nothing of
// @intelligence/personal-extract is imported. Reserved domains only.

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
const CANARY = "canary-capture-capture-commitment";

const LINKED: MeetingItem = {
  kind: "meeting",
  key: "meeting:01JRCAPFCT0000000000000001",
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
    id: "evreadcapfacts01",
    status: "confirmed",
    etag: '"etag-evreadcapfacts01"',
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
  const { spans } = meetingText(LINKED);
  const cited = spans[1];
  if (cited === undefined) throw new Error("no second segment");
  return { from: cited.from, to: cited.to, text: `seg:${cited.from}-${cited.to}` };
})();

type World = {
  db: TestDatabase;
  reader: Reader;
  writer: Writer;
  evidence: EvidenceId;
  capture: CaptureId;
  owner: string;
  devon: string;
  eventId: string;
  fact: string;
  wide: Client;
  own: Client;
};
let w: World;

// The owner's commitment to Devon from the meeting, as the lane would commit it: explicit_self,
// the meeting's whole label, citing the owner's line.
function commitmentRecord(evidence: string, owner: string, devon: string): ClaimRecord {
  const claim = {
    id: `${evidence.slice(0, 60)}0001`,
    content: { type: "commitment", subject: owner, fields: { counterparty: devon, what: `${LINE} ${CANARY}` } },
    statementKind: "stated_fact",
    basis: "explicit_self",
    assertedBy: owner,
    validFrom: new Date(Date.parse(LINKED.startedAt) + 20_000).toISOString(),
    evidence: [{ evidenceId: evidence, span: span.text }],
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
    factKey: `capture commitment ${evidence}`,
    lane: "meeting",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: [devon],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

const facts = async (client: Client, args: Parameters<Reader["findFacts"]>[1] = {}): Promise<FactList> =>
  outcomeValue(await w.reader.findFacts(client.token, args));
const commitments = async (client: Client): Promise<CommitmentList> =>
  outcomeValue(await w.reader.getCommitments(client.token, {}));
const readLogOf = (client: Client) =>
  queryAs<{ tool: string; bound: string[]; shown: string[] }>(
    w.db.urls.admin,
    "select tool, bound, shown from ledger.read_log where client_id = $1 order by id",
    [client.id],
  );

// What each client sees before the meeting's claims are committed: a store without the meeting.
let before: { facts: FactList; commitments: CommitmentList };

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const accounts = await connect(writer);
  const token = await addMacDevice(db, meetRule.value);
  expect(await ingestEvent(writer, accounts.workCalendar, LINKED_EVENT)).toBe("stored");
  const answer = await reader.pushCapture(token, { batch: "read-capture-facts-0001", items: [LINKED as CaptureItem] });
  expect(answer.ok).toBe(true);
  expect(await writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  const row = one(
    await queryAs<{ id: CaptureId; evidence_id: EvidenceId; compartments: string[]; event_id: string }>(
      db.urls.admin,
      "select id, evidence_id, compartments, event_id from knowledge.captures where capture_key = $1",
      [LINKED.key],
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
  const wide = await insertReader({ db } as never, "wide-capture", WIDE, { tools: TOOLS, views: VIEWS });
  const own = await insertReader({ db } as never, "own-capture", ["own"], { tools: TOOLS, views: VIEWS });
  w = {
    db,
    reader,
    writer,
    evidence: row.evidence_id,
    capture: row.id,
    owner,
    devon,
    eventId: row.event_id,
    fact: "",
    wide,
    own,
  };
  before = { facts: await facts(own), commitments: await commitments(own) };

  // The meeting's commitment, as the lane would commit it; its belief is computed when asked.
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    const record = commitmentRecord(row.evidence_id, owner, devon);
    expect(await pipeline.commit(batchOf(row.evidence_id, [record], { lane: "meeting", groups: 1, leftOut: 0 }))).toBe(
      "committed",
    );
    w.fact = fingerprint(db.keys, "fact", record.factKey);
  } finally {
    await pipeline.close();
  }
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("find_facts cites a capture item", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a fact from capture names its capture and its segment, and no other source", async () => {
    const answer = await facts(w.wide, { type: "commitment" });
    const found = answer.facts.find((one) => one.fields !== undefined && JSON.stringify(one.fields).includes(CANARY));
    expect(found).toMatchObject({
      capture: w.capture,
      segment: { from: span.from, to: span.to },
      message: null,
      document: null,
      passage: null,
      page: null,
      basis: "explicit_self",
      provenance: "source",
      source: "meeting",
    });
    expect(found?.subject).toMatchObject({ id: w.owner, kind: "owner" });
    // The item is bound in the read set, as a message is.
    expect((await readLogOf(w.wide)).at(-1)?.bound).toContain(w.evidence);
  });

  // FactSource: a capture item's fact says its kind of source by the row's kind and source, as the
  // token reads them: a source moment (iMessage) is messages, any other moment what Lens saw on screen.
  it("a fact from a moment says messages for a source moment and screen for any other, never mail", async () => {
    const sourceOf = async (): Promise<string | undefined> =>
      (await facts(w.wide, { type: "commitment" })).facts.find((one) => JSON.stringify(one.fields).includes(CANARY))
        ?.source;
    const as = (kind: string, source: string | null) =>
      queryAs(
        w.db.urls.admin,
        "update knowledge.captures set kind = $2, capture_key = $2 || ':' || split_part(capture_key, ':', 2), source = $3 where id = $1",
        [w.capture, kind, source],
      );
    try {
      await as("moment", "imessage");
      expect(await sourceOf()).toBe("messages");
      await as("moment", null);
      expect(await sourceOf()).toBe("screen");
    } finally {
      await as("meeting", null);
    }
    expect(await sourceOf()).toBe("meeting");
  });

  it("a fact of an agent app's moment is marked the same by its belief as by its type", async () => {
    const byType = async () => {
      const found = (await facts(w.wide, { type: "commitment" })).facts.find((one) =>
        JSON.stringify(one.fields).includes(CANARY),
      );
      if (found === undefined) throw new Error("no fact");
      return found;
    };
    const agentApp = (on: boolean) =>
      queryAs(
        w.db.urls.admin,
        "update knowledge.captures set agent_app = $2, kind = $3, capture_key = $3 || ':' || split_part(capture_key, ':', 2) where id = $1",
        [w.capture, on, on ? "moment" : "meeting"],
      );
    const { id } = await byType();
    const [row] = await queryAs<{ fact_key_fp: string }>(
      w.db.urls.admin,
      "select fact_key_fp from knowledge.claims where id = $1",
      [id],
    );
    if (row === undefined) throw new Error("no claim");
    try {
      await agentApp(true);
      const listed = await byType();
      // This claim is the owner's own prompt line, so its mark is the chat's; another's is the agent's word.
      expect(listed.sourceMark).toBe("agent_chat");
      const behind = (await facts(w.wide, { belief: row.fact_key_fp })).facts.find((one) => one.id === id);
      expect(behind).toMatchObject({ tier: listed.tier, provenance: listed.provenance, sourceMark: "agent_chat" });
    } finally {
      await agentApp(false);
    }
  });

  it("a client not cleared for the meeting's label gets none of it, and its results are those of a store without the meeting", async () => {
    const after = await facts(w.own);
    expect(after).toEqual(before.facts);
    expect(JSON.stringify(after)).not.toContain(CANARY);
    expect(JSON.stringify(after)).not.toContain(w.capture);
  });
});

describe("commitments and packs cite capture", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("get_commitments gives the meeting commitment's what from its claim, cited by capture and segment, its evidence id bound", async () => {
    const answer = await commitments(w.wide);
    const found = answer.commitments.find((one) => one.belief.fact === w.fact);
    expect(found).toMatchObject({
      direction: "owed_by_owner",
      what: { untrusted: `${LINE} ${CANARY}` },
      message: null,
      capture: w.capture,
      segment: { from: span.from, to: span.to },
      source: "meeting",
    });
    expect(found?.counterparty).toMatchObject({ id: w.devon });
    const [last] = (await readLogOf(w.wide)).slice(-1);
    expect(last).toMatchObject({ tool: "get_commitments" });
    expect(last?.bound).toContain(w.evidence);
  });

  // A commitment says its kind of source by the capture row the token returned, and so does the owner's page.
  it("a commitment from a moment says messages for a source moment and screen for any other, for an agent and the owner", async () => {
    const sourceOf = async (): Promise<string | undefined> =>
      // Any state: as a source moment, this undated commitment is a chat remark, which has lapsed by now.
      outcomeValue(await w.reader.getCommitments(w.wide.token, { state: "any" })).commitments.find(
        (one) => one.belief.fact === w.fact,
      )?.source;
    const adminDb = createDb(w.db.urls.admin, recordingLogger().log);
    const context: AdminContext = {
      transaction: (fn) => adminDb.transaction(fn),
      keys: w.db.keys,
      log: recordingLogger().log,
      now: () => new Date(),
    };
    const ownerSourceOf = async (state: "open" | "closed" = "open", at = context): Promise<string | undefined> =>
      (await ownerCommitments(at, { state })).commitments.find((one) => one.item.belief.fact === w.fact)?.item.source;
    // The meeting was two days ago, so its remark lapses past the remark window: the owner's page reads
    // the closed list at a clock that far on (commitment-lapse.ts remarkDays).
    const lapsed: AdminContext = {
      ...context,
      now: () => new Date(Date.now() + (remarkDays("owed_by_owner") + 1) * DAY),
    };
    const as = (kind: string, source: string | null) =>
      queryAs(
        w.db.urls.admin,
        "update knowledge.captures set kind = $2, capture_key = $2 || ':' || split_part(capture_key, ':', 2), source = $3 where id = $1",
        [w.capture, kind, source],
      );
    try {
      await as("moment", "imessage");
      expect(await sourceOf()).toBe("messages");
      expect(await ownerSourceOf("closed", lapsed)).toBe("messages");
      await as("moment", null);
      expect(await sourceOf()).toBe("screen");
      expect(await ownerSourceOf()).toBe("screen");
    } finally {
      await as("meeting", null);
    }
    expect(await sourceOf()).toBe("meeting");
    expect(await ownerSourceOf()).toBe("meeting");
    await adminDb.close();
  });

  it("meeting_prep and person_brief follow through commitmentsOf: the commitment with its what and its capture", async () => {
    for (const args of [
      { purpose: "meeting_prep" as const, event: w.eventId },
      { purpose: "person_brief" as const, entity: w.devon },
    ]) {
      const pack: ContextPack = outcomeValue(await w.reader.buildContextPack(w.wide.token, args as never));
      const item = pack.items.find((one) => one.kind === "commitment" && one.commitment.belief.fact === w.fact);
      expect(item, args.purpose).toBeDefined();
      if (item?.kind === "commitment")
        expect(item.commitment).toMatchObject({
          capture: w.capture,
          segment: { from: span.from, to: span.to },
          what: { untrusted: `${LINE} ${CANARY}` },
        });
      // The pack shows the item by its evidence id.
      expect((await readLogOf(w.wide)).at(-1)?.shown, args.purpose).toContain(w.evidence);
    }
  });

  it("a client not cleared for the meeting's label gets none of it, and its results are those of a store without the meeting", async () => {
    expect(await commitments(w.own)).toEqual(before.commitments);
    const brief = await w.reader.buildContextPack(w.own.token, { purpose: "person_brief", entity: w.devon } as never);
    expect(JSON.stringify(brief)).not.toContain(CANARY);
    expect(JSON.stringify(brief)).not.toContain(w.capture);
  });
});
