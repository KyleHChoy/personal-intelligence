import { randomBytes } from "node:crypto";
import { type EvidenceId, type Mention, RequestId, type SourceDeletion, Timestamp } from "@intelligence/contracts";
import {
  type CaptureItem,
  type EntityId,
  type MeetingItem,
  type MentionBindingId,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  contactDeletion,
  contactItem,
  deriveItem,
  macContactItem,
  whitelistedContact,
} from "@intelligence/personal-core/items";
import { fakeLens } from "@intelligence/personal-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealRow } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createReader, type Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { event, ingestEvent, type MailFixture, mailItem, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MEETING_PEOPLE_PER_DAY } from "./participant-binding.ts";
import { createWriter, type Writer } from "./writer.ts";

// Synthetic people on reserved domains: a person matched by a name alone, two people of one name,
// an unknown participant made a person, the owner's split, and an erasure that suppresses creation
// by name. With the grant's own checks: no client gains a read (invariant 6), and no model and no
// pipeline commit chooses a binding (invariant 5). No model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const utc = (offset: number): string => new Date(T + offset).toISOString();

const lens = fakeLens({ now: new Date(T - 3 * DAY) });
const meetRule = lens.scope.find(
  (rule) => rule.match === "bundle" && rule.compartment === "own" && rule.kinds.includes("meeting"),
);
if (meetRule === undefined) throw new Error("the world's scope has no own meeting app");

let keys = 0;
// A room of the owner and one other speaker known by a name alone.
const room = (name: string): MeetingItem => {
  keys += 1;
  return {
    kind: "meeting",
    key: `meeting:01JRPARTBD${String(keys).padStart(16, "0")}`,
    revision: 0,
    startedAt: local(-30 * HOUR + keys * MINUTE),
    endedAt: local(-29 * HOUR + keys * MINUTE),
    app: { bundle: meetRule.value, name: "Recorder" },
    title: "Catch-up",
    consent: true,
    mode: "room",
    speakers: [
      { label: "S1", owner: true, mention: { address: OWNER.personal } },
      { label: "S2", owner: false, mention: { name } },
    ],
    segments: [
      {
        speaker: "S1",
        fromMs: 0,
        toMs: 9_000,
        channel: "input",
        text: "Thanks for coming over to look at the space today.",
      },
      {
        speaker: "S2",
        fromMs: 10_000,
        toMs: 19_000,
        channel: "input",
        text: "Happy to, I need a workshop with three-phase power.",
      },
    ],
  };
};

// A chat of the owner and one contact known by a name alone, its lines' turns as
// Lens marks them from the bubbles' layout.
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const chatWith = (name: string): MomentItem => {
  keys += 1;
  const lines = [
    "I can read a credit file fast, I did it for six years.",
    "Nice, I need someone like that for the pilot.",
  ];
  const text = lines.join("\n");
  return {
    kind: "moment",
    key: `moment:01JRPARTBD${String(keys).padStart(16, "0")}`,
    revision: 0,
    observedAt: local(-20 * HOUR + keys * MINUTE),
    endedAt: local(-20 * HOUR + keys * MINUTE),
    app: CHAT,
    entity: "chat",
    thread: name,
    participants: [{ name }],
    text,
    read: "ax",
    turns: [
      { from: 0, to: (lines[0] ?? "").length, speaker: "participant", participant: 0 },
      { from: (lines[0] ?? "").length + 1, to: text.length, speaker: "owner" },
    ],
  };
};

// A personal-calendar event whose attendee has a name, so a person holds that name as an alias.
const meetingWith = (id: string, name: string, address: string) =>
  event({
    event: {
      id,
      status: "confirmed",
      etag: `"etag-${id}"`,
      updated: utc(-5 * DAY),
      summary: "Coffee",
      start: { dateTime: utc(-6 * DAY) },
      end: { dateTime: utc(-6 * DAY + HOUR) },
      organizer: { email: OWNER.personal },
      attendees: [
        { email: OWNER.personal, self: true, responseStatus: "accepted" },
        { email: address, displayName: name, responseStatus: "accepted" },
      ],
    },
    title: "Coffee",
    startsAt: utc(-6 * DAY),
    endsAt: utc(-6 * DAY + HOUR),
    allDay: false,
  });

type World = { db: TestDatabase; writer: Writer; reader: Reader; admin: Admin; token: string; accounts: Accounts };
let w: World;
let pushes = 0;

async function addDevice(db: TestDatabase): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insertClient = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
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
      mirror,
      "mac",
      sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
      ["own"],
      ["self", "people", "work"],
      ["sync_mirror"],
      "agent",
      ...quota(MIRROR_QUOTA),
    ]);
    await query("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)", [
      "mac",
      capture.id,
      mirror,
    ]);
    await query(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', 'lens_meetings', 'transcript', '{own}')",
      [testId("acc")],
    );
    // The device's moments too, from one chat app under `own`.
    await query(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', 'lens_activity', 'screen_activity', '{own}')",
      [testId("acc")],
    );
    const chatRule = testId("csr");
    await query(
      "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, 'bundle', $2, $3, null, null, 'own', '{moment}')",
      [
        chatRule,
        fingerprint(db.keys, "capture_scope", CHAT.bundle),
        sealRow(db.keys, "own", { table: "policy.capture_scope", id: chatRule, column: "value_enc" }, CHAT.bundle),
      ],
    );
    const id = testId("csr");
    await query(
      "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, 'bundle', $2, $3, null, null, 'own', '{meeting}')",
      [
        id,
        fingerprint(db.keys, "capture_scope", meetRule?.value ?? ""),
        sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, meetRule?.value ?? ""),
      ],
    );
    await query("commit");
  });
  return capture.token;
}

// Pushes and drains one meeting; its evidence id.
async function drained(item: MeetingItem | MomentItem): Promise<EvidenceId> {
  pushes += 1;
  expect(
    (
      await w.reader.pushCapture(w.token, {
        batch: `participants-${String(pushes).padStart(4, "0")}`,
        items: [item as CaptureItem],
      })
    ).ok,
  ).toBe(true);
  expect(await w.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  return one(
    await queryAs<{ evidence_id: EvidenceId }>(
      w.db.urls.admin,
      "select evidence_id from knowledge.captures where capture_key = $1",
      [item.key],
    ),
  ).evidence_id;
}

// What the pipeline's identity port answers for the name in that meeting, or that moment.
async function resolved(
  evidence: EvidenceId,
  name: string,
  kind: "meeting" | "moment" = "meeting",
): Promise<string | null> {
  const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
  try {
    const opened = kind === "meeting" ? await pipeline.openCapture(evidence) : await pipeline.openMoment(evidence);
    if (opened === null) throw new Error("not opened");
    const observedAt = "startedAt" in opened.capture ? opened.capture.startedAt : opened.capture.observedAt;
    const answer = await opened.context.identity.resolve(
      { key: { kind: "name", value: name }, observedAt } as Mention,
      "personal",
      RequestId.parse("participants-test"),
    );
    return answer.outcome === "linked" ? answer.entity : null;
  } finally {
    await pipeline.close();
  }
}

const entityOf = async (address: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fingerprint(w.db.keys, "address", address)],
    ),
  ).entity_id;
const bindingsOf = (evidence: EvidenceId) =>
  queryAs<{ id: MentionBindingId; origin: string; ruling_id: string | null; lifted: boolean }>(
    w.db.urls.admin,
    "select id, origin, ruling_id, lifted_at is not null as lifted from knowledge.mention_bindings where evidence_id = $1 order by created_at, id",
    [evidence],
  );
const people = async (): Promise<number> =>
  one(
    await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from knowledge.entities where kind = 'person'",
    ),
  ).n;
let requests = 0;
const req = (): string => `participants-req-${(requests += 1)}`;

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const log = eventLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log });
  const admin = createAdmin({
    url: db.urls.admin,
    keys: db.keys,
    log: recordingLogger().log,
    journal: journalPath(db.keyFile),
  });
  const accounts = await connect(writer);
  const token = await addDevice(db);
  w = { db, writer, reader, admin, token, accounts };
  expect(
    await ingestEvent(
      writer,
      accounts.personalCalendar,
      meetingWith("evpartbind0001", "Quinn Lake", "quinn.lake@example.org"),
    ),
  ).toBe("stored");
  expect(
    await ingestEvent(
      writer,
      accounts.personalCalendar,
      meetingWith("evpartbind0002", "Rowan Hale", "rowan.hale@example.org"),
    ),
  ).toBe("stored");
  expect(
    await ingestEvent(
      writer,
      accounts.personalCalendar,
      meetingWith("evpartbind0003", "Rowan Hale", "r.hale@example.net"),
    ),
  ).toBe("stored");
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.admin.close();
  await w?.reader.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("meeting participants bound by code", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a person known by a name alone binds to the one person of that name, by code, with no ruling, and the pipeline's port resolves the name to them", async () => {
    const evidence = await drained(room("Quinn Lake"));
    // Before the step the name resolves to nobody: the old behaviour, filed for the owner.
    expect(await resolved(evidence, "Quinn Lake")).toBeNull();
    const before = await people();
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({ bound: 1, failed: 0 });
    expect(await people()).toBe(before);
    expect(await bindingsOf(evidence)).toEqual([
      expect.objectContaining({ origin: "code", ruling_id: null, lifted: false }),
    ]);
    expect(await resolved(evidence, "Quinn Lake")).toBe(await entityOf("quinn.lake@example.org"));
    // A second run binds nothing again.
    expect((await w.writer.bindParticipants(new Date(T))).bound).toBe(0);
    expect(await bindingsOf(evidence)).toHaveLength(1);
  });

  it("two people of one name: the stronger by the existing order is bound, it is counted ambiguous, and the identity sweep asks the owner whether they are one person", async () => {
    const evidence = await drained(room("Rowan Hale"));
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({ bound: 1, ambiguous: 1 });
    const [first, second] = [await entityOf("rowan.hale@example.org"), await entityOf("r.hale@example.net")].sort();
    // Neither is on a contact, written to or at a linked event: the lower id.
    expect(await resolved(evidence, "Rowan Hale")).toBe(first);
    expect(second).not.toBe(first);
    await w.writer.proposeIdentity(new Date(T));
    const cards = await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from ledger.cards where kind = 'same_person' and created_by = 'system:identity'",
    );
    expect(one(cards).n).toBeGreaterThanOrEqual(1);
  });

  it("an unknown participant becomes one new person, keyed profile:meeting/, with the name as an alias; a rerun and a later meeting name the same person", async () => {
    const before = await people();
    const evidence = await drained(room("Ivo Brandt"));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, created: 1 });
    expect(await people()).toBe(before + 1);
    const ivo = await resolved(evidence, "Ivo Brandt");
    expect(ivo).not.toBeNull();
    const accounts = await queryAs<{ value_fp: string }>(
      w.db.urls.admin,
      "select value_fp from knowledge.accounts where entity_id = $1",
      [ivo],
    );
    expect(accounts).toHaveLength(1);
    const aliases = await queryAs<{ n: number }>(
      w.db.urls.admin,
      "select count(*)::int as n from knowledge.aliases where entity_id = $1 and value_fp = $2",
      [ivo, fingerprint(w.db.keys, "name", "Ivo Brandt")],
    );
    expect(one(aliases).n).toBe(1);
    expect((await w.writer.bindParticipants(new Date(T))).created).toBe(0);
    const later = await drained(room("Ivo Brandt"));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, created: 0 });
    expect(await resolved(later, "Ivo Brandt")).toBe(ivo);
    expect(await people()).toBe(before + 1);
  });

  it("the owner's unbind of a code binding is the owner's 'not the same': the next sync makes the participant a new person there, and the rejected one never returns to that meeting", async () => {
    const evidence = await drained(room("Ivo Brandt"));
    await w.writer.bindParticipants(new Date(T));
    const rejected = await resolved(evidence, "Ivo Brandt");
    const [binding] = await bindingsOf(evidence);
    expect(binding?.origin).toBe("code");
    expect((await w.admin.mentions.listCodeBindings({ limit: 50 })).map((one) => one.binding)).toContain(binding?.id);
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    expect(await resolved(evidence, "Ivo Brandt")).toBeNull();
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, created: 1 });
    const split = await resolved(evidence, "Ivo Brandt");
    expect(split).not.toBeNull();
    expect(split).not.toBe(rejected);
    // A further sync leaves the split as it is.
    expect((await w.writer.bindParticipants(new Date(T))).bound).toBe(0);
    expect(await resolved(evidence, "Ivo Brandt")).toBe(split);
  });

  it("an erasure of the person made from a name suppresses that name: a later meeting naming them makes nobody", async () => {
    const evidence = await drained(room("Tova Lind"));
    await w.writer.bindParticipants(new Date(T));
    const tova = (await resolved(evidence, "Tova Lind")) as EntityId;
    expect(tova).not.toBeNull();
    await w.admin.erasure.erasePerson(tova, { requestId: req() });
    const before = await people();
    const later = await drained(room("Tova Lind"));
    await w.writer.bindParticipants(new Date(T));
    expect(await people()).toBe(before);
    expect(await resolved(later, "Tova Lind")).toBeNull();
  });

  // A chat's contact known by a name alone, by the same step and the same key.
  it("a chat moment's contact known by a name alone becomes one person, bound by code; a meeting naming them later binds the same person; a moment's claim about them builds no belief (G.8)", async () => {
    const before = await people();
    const evidence = await drained(chatWith("Mara Example"));
    expect(await resolved(evidence, "Mara Example", "moment")).toBeNull();
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, created: 1, failed: 0 });
    expect(await people()).toBe(before + 1);
    const mara = await resolved(evidence, "Mara Example", "moment");
    expect(mara).not.toBeNull();
    expect(await bindingsOf(evidence)).toEqual([
      expect.objectContaining({ origin: "code", ruling_id: null, lifted: false }),
    ]);
    // A second sync binds nothing again; a meeting that names them reaches the same person.
    expect((await w.writer.bindParticipants(new Date(T))).bound).toBe(0);
    const meeting = await drained(room("Mara Example"));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, created: 0 });
    expect(await resolved(meeting, "Mara Example")).toBe(mara);
    // G.8, for a chat: the contact's own line about themselves, credited to them, is stored and builds no belief.
    const record = claimRecord(evidence, "own", mara as string, { n: 1, type: "capability", basis: "explicit_self" });
    const said = {
      ...record,
      lane: "moment",
      subjectKind: "person",
      claim: { ...record.claim, assertedBy: mara },
    } as typeof record;
    const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(evidence, [said], { lane: "moment" }))).toBe("committed");
      const given = new Set(
        (await pipeline.beliefClaims()).flatMap((group) => group.claims.map((one_) => one_.claim.id as string)),
      );
      expect(given.has(said.claim.id as string)).toBe(false);
    } finally {
      await pipeline.close();
    }
    expect(
      await queryAs(w.db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [evidence]),
    ).toHaveLength(1);
  });

  it("a chat moment an agent-app rule admitted is never settled: no binding, no person", async () => {
    const before = await people();
    const evidence = await drained(chatWith("Agent Example"));
    await queryAs(w.db.urls.admin, "update knowledge.captures set agent_app = true where evidence_id = $1", [evidence]);
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 0, created: 0 });
    expect(await bindingsOf(evidence)).toEqual([]);
    expect(await people()).toBe(before);
  });

  // The writer may delete a live code binding of a source moment alone (its own test is below); a
  // meeting's or a screen chat's it cannot reach.
  it("the grant: the writer reads and inserts its code bindings, lifts none and deletes none of a meeting; no client gains a read (invariant 6); the pipeline writes no binding (invariant 5)", async () => {
    const [binding] = await queryAs<{ id: string; evidence_id: string }>(
      w.db.urls.admin,
      "select id, evidence_id from knowledge.mention_bindings where origin = 'code' limit 1",
    );
    expect(binding).toBeDefined();
    expect(
      await sqlState(() =>
        queryAs(w.db.urls.writer, "update knowledge.mention_bindings set lifted_at = now() where id = $1", [
          binding?.id,
        ]),
      ),
    ).toBe("42501");
    expect(
      await queryAs(w.db.urls.writer, "delete from knowledge.mention_bindings where id = $1 returning id", [
        binding?.id,
      ]),
    ).toEqual([]);
    expect(
      await queryAs(w.db.urls.admin, "select id from knowledge.mention_bindings where id = $1", [binding?.id]),
    ).toEqual([{ id: binding?.id }]);
    expect(await sqlState(() => queryAs(w.db.urls.reader, "select id from knowledge.mention_bindings"))).toBe("42501");
    const insert =
      "insert into knowledge.mention_bindings (id, ruling_id, origin, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, null, 'code', $2, $3, $3, now(), '{own}')";
    expect(
      await sqlState(() => queryAs(w.db.urls.pipeline, insert, [testId("mbd"), binding?.evidence_id, "b".repeat(64)])),
    ).toBe("42501");
    // The positive control: the writer's same insert.
    expect(
      await sqlState(() => queryAs(w.db.urls.writer, insert, [testId("mbd"), binding?.evidence_id, "c".repeat(64)])),
    ).toBeNull();
  });
});

// The owner's own display names, from mail they sent, are aliases of the owner's entity, so a
// meeting or chat that types the owner by a name alone, and gives no address, is the owner's and never a
// namesake's. Synthetic names; the owner's own mail is derived by the real deriveItem.
describe("the owner's own names from mail the owner sent", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const HIS = "Sorrel Ownersby";
  const WORK_ONLY = "Tamsin Workname";
  const sentMail = (id: string, name: string, address: string, days: number): MailFixture => ({
    id,
    threadId: id,
    at: Timestamp.parse(utc(-days * DAY)),
    from: { address, name },
    to: [{ address: "pell.reader@example.org", name: "Pell Reader" }],
    subject: "Plans",
    labels: ["SENT"],
  });
  const MINE = sentMail("18d0150a0001", HIS, OWNER.personal, 4);
  const WORK = sentMail("18d0150a0002", WORK_ONLY, OWNER.work, 3);
  // The mail as Gmail hands it over, derived by core as the sync derives it.
  const send = async (fixture: MailFixture, account: Accounts[keyof Accounts]): Promise<void> => {
    const raw = mailItem(fixture, account);
    expect(await w.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
  };
  const ownerAliases = (name: string) =>
    queryAs<{ compartments: string[] }>(
      w.db.urls.admin,
      "select a.compartments from knowledge.aliases a join knowledge.entities e on e.id = a.entity_id and e.kind = 'owner' where a.value_fp = $1 order by a.id",
      [fingerprint(w.db.keys, "name", name)],
    );
  // Everything the namesake has, to show it untouched.
  const rowsOf = async (entity: string) => ({
    aliases: await queryAs(
      w.db.urls.admin,
      "select id, evidence_id, compartments from knowledge.aliases where entity_id = $1 order by id",
      [entity],
    ),
    accounts: await queryAs(
      w.db.urls.admin,
      "select id, value_fp, compartments from knowledge.accounts where entity_id = $1 order by id",
      [entity],
    ),
    bound: await queryAs(
      w.db.urls.admin,
      "select b.id, b.lifted_at from knowledge.mention_bindings b join knowledge.accounts a on a.value_fp = b.address_fp where a.entity_id = $1 order by b.id",
      [entity],
    ),
  });
  const sameCards = async (): Promise<number> =>
    one(
      await queryAs<{ n: number }>(
        w.db.urls.admin,
        "select count(*)::int as n from ledger.cards where kind = 'same_person' and created_by = 'system:identity'",
      ),
    ).n;
  let namesake: string;
  let early: EvidenceId;

  beforeAll(async () => {
    // A person of the owner's name, from an event someone else's address is on.
    expect(
      await ingestEvent(
        w.writer,
        w.accounts.personalCalendar,
        meetingWith("evpartbind0150", HIS, "sorrel.ownersby@example.org"),
      ),
    ).toBe("stored");
    namesake = await entityOf("sorrel.ownersby@example.org");
  }, SLOW_DB_TEST_TIMEOUT);

  it("with no alias of the owner's, a room that types the owner by name alone binds the namesake: the gap (the known limit)", async () => {
    expect(await ownerAliases(HIS)).toEqual([]);
    early = await drained(room(HIS));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 1, failed: 0 });
    expect(await resolved(early, HIS)).toBe(namesake);
  });

  it("mail the owner sent under their full name makes it an alias of the owner's entity, under the mail's label; the namesake is untouched and no same-person card is raised", async () => {
    // The sweep first, so the cards earlier cases leave to raise are raised before counting.
    await w.writer.proposeIdentity(new Date(T));
    const [before, cards] = [await rowsOf(namesake), await sameCards()];
    await send(MINE, w.accounts.personalMail);
    expect(await ownerAliases(HIS)).toEqual([{ compartments: ["own"] }]);
    expect(await rowsOf(namesake)).toEqual(before);
    await w.writer.proposeIdentity(new Date(T));
    expect(await sameCards()).toBe(cards);
  });

  it("a room and a chat that type the owner by name alone then bind nobody and make nobody; the namesake is untouched", async () => {
    // What a sync passes over today in this file (names that wait, such as an erased one).
    const waiting = (await w.writer.bindParticipants(new Date(T))).skipped;
    const [before, people0] = [await rowsOf(namesake), await people()];
    const meeting = await drained(room(HIS));
    const chat = await drained(chatWith(HIS));
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({ bound: 0, created: 0, failed: 0 });
    expect(await bindingsOf(meeting)).toEqual([]);
    expect(await bindingsOf(chat)).toEqual([]);
    expect(await resolved(meeting, HIS)).toBeNull();
    expect(await resolved(chat, HIS, "moment")).toBeNull();
    expect(await people()).toBe(people0);
    expect(await rowsOf(namesake)).toEqual(before);
    // A further sync passes over them before any transaction: nothing is counted as settled again.
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 0, skipped: waiting, created: 0 });
  });

  it("the code binding made before the owner's alias stays until the owner lifts it (invariant 11); after the owner's unbind the name is the owner's there, and no split person is made", async () => {
    const [binding] = await bindingsOf(early);
    expect(binding).toMatchObject({ origin: "code", lifted: false });
    expect(await resolved(early, HIS)).toBe(namesake);
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    const people0 = await people();
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 0, created: 0 });
    expect(await resolved(early, HIS)).toBeNull();
    expect(await people()).toBe(people0);
  });

  it("an alias only work mail gives decides no meeting under own (invariant 6): the name is anyone's there", async () => {
    await send(WORK, w.accounts.workMail);
    expect(await ownerAliases(WORK_ONLY)).toEqual([{ compartments: ["employer:example"] }]);
    const meeting = await drained(room(WORK_ONLY));
    await w.writer.bindParticipants(new Date(T));
    expect(await bindingsOf(meeting)).toEqual([expect.objectContaining({ origin: "code", lifted: false })]);
    const bound = await resolved(meeting, WORK_ONLY);
    expect(bound).not.toBeNull();
    expect(
      one(
        await queryAs<{ kind: string }>(w.db.urls.admin, "select kind from knowledge.entities where id = $1", [bound]),
      ).kind,
    ).toBe("person");
  });

  it("deleting the mail that gave the owner's name removes the alias (invariant 10), and the next sync binds the name like anyone's", async () => {
    const pending = await drained(room(HIS));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ bound: 0 });
    await w.writer.applyDeletion(w.accounts.personalMail, {
      sourceAccount: w.accounts.personalMail.id,
      sourceItemId: mailSourceId(MINE),
    } as SourceDeletion);
    expect(await ownerAliases(HIS)).toEqual([]);
    await w.writer.bindParticipants(new Date(T));
    expect(await bindingsOf(pending)).toEqual([expect.objectContaining({ origin: "code", lifted: false })]);
    expect(await resolved(pending, HIS)).toBe(namesake);
  });
});

// The forgery bound. Last in the file: it fills
// the device's people of the day.
describe("the bound on people made from a meeting by a name alone", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  // A heard claim of the meeting about a person: credited to nobody, of the meeting lane.
  const heard = (evidence: EvidenceId, subject: string, n: number, assertedBy?: string, entities?: string[]) => {
    const record = claimRecord(evidence, "own", subject, {
      n,
      type: "need",
      basis: "third_party",
      ...(entities === undefined ? {} : { entities }),
    });
    return {
      ...record,
      lane: "meeting",
      subjectKind: "person",
      claim: { ...record.claim, ...(assertedBy === undefined ? {} : { assertedBy }) },
    } as typeof record;
  };
  const inBeliefs = async (ids: string[]): Promise<boolean[]> => {
    const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
    try {
      const given = new Set(
        (await pipeline.beliefClaims()).flatMap((group) => group.claims.map((one) => one.claim.id as string)),
      );
      return ids.map((id) => given.has(id));
    } finally {
      await pipeline.close();
    }
  };

  it("G.8: what a meeting heard about a person made from a name alone builds no belief until the meeting is linked to a calendar event; the claims are stored, and the owner's word and a known person's count", async () => {
    const evidence = await drained(room("Wren Example"));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ created: 1 });
    const wren = (await resolved(evidence, "Wren Example")) as string;
    const quinn = await entityOf("quinn.lake@example.org");
    const owner = one(
      await queryAs<{ id: string }>(w.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    // The fourth names Wren as a counterparty of a claim about the owner.
    const claims = [
      heard(evidence, wren, 1),
      heard(evidence, quinn, 2),
      heard(evidence, wren, 3, owner),
      heard(evidence, owner, 4, undefined, [wren]),
    ];
    const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(evidence, claims, { lane: "meeting" }))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    expect(
      await queryAs(w.db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [evidence]),
    ).toHaveLength(4);
    const ids = claims.map((one) => one.claim.id as string);
    // Heard about the person made by name: none. About a person known otherwise, and the owner's own word: counted.
    expect(await inBeliefs(ids)).toEqual([false, true, true, false]);
    // Linked to an event the box holds, as the drain links one, it counts.
    const [held] = await queryAs<{ id: string }>(w.db.urls.admin, "select id from knowledge.events limit 1");
    await queryAs(w.db.urls.admin, "update knowledge.captures set event_id = $1 where evidence_id = $2", [
      held?.id,
      evidence,
    ]);
    expect(await inBeliefs(ids)).toEqual([true, true, true, true]);
  });

  it("D.7: at most MEETING_PEOPLE_PER_DAY people a device a day are made by name; the rest wait, bound to nobody, and pi status counts them by day", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const madeToday = async (): Promise<number> =>
      (await w.admin.lens.devices()).find((one) => one.name === "mac")?.peopleMade?.find((one) => one.day === day)
        ?.count ?? 0;
    const before = await madeToday();
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(MEETING_PEOPLE_PER_DAY);
    const names = Array.from(
      { length: MEETING_PEOPLE_PER_DAY + 2 },
      (_, n) => `Guest Example${String.fromCharCode(65 + n)}`,
    );
    const evidence = await drained({ ...room(names[0] ?? ""), attendees: names.map((name) => ({ name })) });
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({
      created: MEETING_PEOPLE_PER_DAY - before,
      capped: names.length - (MEETING_PEOPLE_PER_DAY - before),
      failed: 0,
    });
    expect(await madeToday()).toBe(MEETING_PEOPLE_PER_DAY);
    expect(await bindingsOf(evidence)).toHaveLength(MEETING_PEOPLE_PER_DAY - before);
    // The names past the cap wait: the next sync of the day makes none of them either.
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({
      created: 0,
      capped: names.length - (MEETING_PEOPLE_PER_DAY - before),
    });
  });
});

// Contacts are built by core's whitelist and derived by the real deriveItem; the moments are
// Messages sessions read from chat.db, admitted by a source rule. 555 numbers only.
describe("a source moment's phone handles", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
  const own = { metadata: { source: { type: "CONTACT", id: "c" } } };
  let contacts: {
    own: Awaited<ReturnType<Writer["ensureSourceAccount"]>>;
    work: Awaited<ReturnType<Writer["ensureSourceAccount"]>>;
  };
  let threads = 0;
  // One session of a chat with these handles, each of whom says one line, then the owner one.
  const session_ = (handles: string[]): MomentItem => {
    keys += 1;
    threads += 1;
    const sorted = [...handles].sort();
    const lines = [
      ...sorted.map((_, n) => `Line ${n + 1}: the tiles arrive on Thursday morning.`),
      "Thanks, I will be in.",
    ];
    const text = lines.join("\n");
    let from = 0;
    const turns = lines.map((line, n) => {
      const turn = {
        from,
        to: from + line.length,
        ...(n < sorted.length ? { speaker: "participant" as const, participant: n } : { speaker: "owner" as const }),
        at: local(-10 * HOUR + keys * MINUTE),
      };
      from += line.length + 1;
      return turn;
    });
    return {
      kind: "moment",
      key: `moment:01JRPARTBD${String(keys).padStart(16, "0")}`,
      revision: 0,
      observedAt: local(-10 * HOUR + keys * MINUTE),
      endedAt: local(-10 * HOUR + keys * MINUTE),
      app: MESSAGES,
      entity: "chat",
      participants: sorted.map((handle) => ({ handle })),
      text,
      read: "db",
      turns,
      source: "imessage",
      threadKey: `chat:01JRPARTBDTHREAD${String(threads).padStart(10, "0")}`,
    };
  };
  const saved = async (
    account: typeof contacts.own,
    resource: string,
    person: { name: string; emails: string[]; phones: string[] },
  ): Promise<void> => {
    const read = whitelistedContact({
      resourceName: `people/${resource}`,
      metadata: { sources: [{ type: "CONTACT", id: resource, updateTime: utc(-2 * DAY) }] },
      names: [{ ...own, displayName: person.name }],
      emailAddresses: person.emails.map((value) => ({ ...own, value })),
      phoneNumbers: person.phones.map((value) => ({ ...own, value })),
    });
    if (read === null) throw new Error("refused");
    const raw = contactItem(read, { sourceAccount: account.id, changeKind: "backfill", now: Timestamp.parse(utc(0)) });
    expect(await w.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
  };
  const unsaved = (account: typeof contacts.own, resource: string) =>
    w.writer.applyDeletion(
      account,
      contactDeletion(`people/${resource}`, {
        sourceAccount: account.id,
        now: Timestamp.parse(utc(0)),
      }) as SourceDeletion,
    );
  // What the pipeline's port answers for a handle in that moment, as the lane asks it: its phone
  // key, else this moment's binding of it; and the slot's names.
  async function handleOf(
    evidence: EvidenceId,
    phone: string,
  ): Promise<{ entity: string | null; names: Record<string, string> }> {
    const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
    try {
      const opened = await pipeline.openMoment(evidence);
      if (opened === null) throw new Error("not opened");
      const ask = async (key: Mention["key"]): Promise<string | null> => {
        const answer = await opened.context.identity.resolve(
          { key, observedAt: opened.capture.observedAt } as Mention,
          "personal",
          RequestId.parse("handles-test"),
        );
        return answer.outcome === "linked" ? answer.entity : null;
      };
      return {
        entity: (await ask({ kind: "address", value: `tel:${phone}` })) ?? (await ask({ kind: "name", value: phone })),
        names: { ...(opened.handleNames ?? {}) },
      };
    } finally {
      await pipeline.close();
    }
  }
  const OMAR = "+15555550201";
  const LENA = "+15555550202";
  const SHARED = "+15555550203";
  const TWO = "+15555550204";
  const WORK = "+15555550205";
  const NOBODY = "+15555550206";

  beforeAll(async () => {
    contacts = {
      own: await w.writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal),
      work: await w.writer.ensureSourceAccount("work", "google_contacts", "employer:example", OWNER.work),
    };
    const rule = testId("csr");
    await queryAs(
      w.db.urls.admin,
      "insert into policy.capture_scope (id, match, value_fp, value_enc, compartment, kinds, source) values ($1, 'bundle', $2, $3, 'own', '{moment}', 'imessage')",
      [
        rule,
        fingerprint(w.db.keys, "capture_scope", MESSAGES.bundle),
        sealRow(w.db.keys, "own", { table: "policy.capture_scope", id: rule, column: "value_enc" }, MESSAGES.bundle),
      ],
    );
    await saved(contacts.own, "omar", { name: "Omar Reyes", emails: ["omar.reyes@field.example"], phones: [OMAR] });
    await saved(contacts.own, "lena", { name: "Lena Park", emails: [], phones: [`+1 555 555 0202`] });
    await saved(contacts.own, "shared-a", { name: "Ines Ward", emails: ["ines.ward@stone.example"], phones: [SHARED] });
    await saved(contacts.own, "shared-b", {
      name: "Frank Hart",
      emails: ["frank.hart@cove.example"],
      phones: [SHARED],
    });
    await saved(contacts.own, "two", {
      name: "Nina Cole",
      emails: ["nina.cole@ridge.example", "nina@ridge.example"],
      phones: [TWO],
    });
    await saved(contacts.work, "work", { name: "Theo Marsh", emails: ["theo.marsh@lake.example"], phones: [WORK] });
  }, SLOW_DB_TEST_TIMEOUT);

  it("a phone-only contact's person holds the phone's key and its handle resolves to them, with no binding; a phone on one contact of one address binds to that person, and the slot shows their name", async () => {
    const before = await people();
    const evidence = await drained(session_([OMAR, LENA]));
    const lena = await entityOf(`tel:${LENA}`);
    expect(await handleOf(evidence, LENA)).toMatchObject({ entity: lena });
    // Before the step Omar's handle names nobody.
    expect((await handleOf(evidence, OMAR)).entity).toBeNull();
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({ handlesBound: 1, handlesRemoved: 0, failed: 0 });
    expect(await people()).toBe(before);
    expect(await bindingsOf(evidence)).toEqual([
      expect.objectContaining({ origin: "code", ruling_id: null, lifted: false }),
    ]);
    const omar = await entityOf("omar.reyes@field.example");
    expect(await handleOf(evidence, OMAR)).toEqual({
      entity: omar,
      names: { [OMAR]: "Omar Reyes", [LENA]: "Lena Park" },
    });
    // A second sync changes nothing.
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, handlesRemoved: 0 });
  });

  it("a phone on two contacts, on a contact whose two addresses are two people, on a contact under another label, or on none binds nobody and makes nobody (invariant 6: the slot is as a store without that contact)", async () => {
    const before = await people();
    const cards = async () =>
      one(
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from ledger.cards where kind = 'same_person'",
        ),
      ).n;
    // The contacts' own cards first (two addresses on one contact is a basis), so what follows is the handles'.
    await w.writer.proposeIdentity(new Date(T));
    const sweptBefore = await cards();
    const evidence = await drained(session_([SHARED, TWO, WORK, NOBODY]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, failed: 0 });
    expect(await bindingsOf(evidence)).toEqual([]);
    expect(await people()).toBe(before);
    for (const phone of [SHARED, TWO, WORK, NOBODY])
      expect(await handleOf(evidence, phone), phone).toEqual({ entity: null, names: {} });
    // The identity sweep raises no card from a handle.
    await w.writer.proposeIdentity(new Date(T));
    expect(await cards()).toBe(sweptBefore);
  });

  // A contact whose several addresses are all one person's binds to them, as one of
  // one address does; the person gets no new address and no card is raised.
  it("a phone on a contact whose two addresses are one person binds to that person; one of them another's binds nobody", async () => {
    await saved(contacts.own, "pia-mail", { name: "Pia Lund", emails: ["pia.lund@fjord.example"], phones: [] });
    const pia = await entityOf("pia.lund@fjord.example");
    // A person holding two addresses, as a merge leaves them.
    const account = testId("acc");
    await queryAs(
      w.db.urls.admin,
      "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, '{own}')",
      [
        account,
        pia,
        fingerprint(w.db.keys, "address", "pia@fjord.example"),
        fingerprint(w.db.keys, "domain", "fjord.example"),
        sealRow(
          w.db.keys,
          "own",
          { table: "knowledge.accounts", id: account, column: "value_enc" },
          "pia@fjord.example",
        ),
      ],
    );
    await saved(contacts.own, "pia", {
      name: "Pia Lund",
      emails: ["pia.lund@fjord.example", "pia@fjord.example"],
      phones: ["+15555550209"],
    });
    // And a contact whose second address is someone else's.
    await saved(contacts.own, "arlo", {
      name: "Arlo Venn",
      emails: ["arlo.venn@fjord.example", "omar.reyes@field.example"],
      phones: ["+15555550210"],
    });
    const before = await people();
    const evidence = await drained(session_(["+15555550209", "+15555550210"]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 1, failed: 0 });
    expect(await handleOf(evidence, "+15555550209")).toMatchObject({ entity: pia });
    expect((await handleOf(evidence, "+15555550210")).entity).toBeNull();
    expect(await people()).toBe(before);
  });

  // One person kept as two records, joined by the owner: the phone joins nothing, the ruling did.
  it("a phone on contacts of two people binds nobody until the owner rules them the same, then one person", async () => {
    await saved(contacts.own, "tam-one", {
      name: "Tam Reed",
      emails: ["tam.reed@fjord.example"],
      phones: ["+15555550249"],
    });
    await saved(contacts.own, "tam-two", {
      name: "T Reed",
      emails: ["t.reed@field.example"],
      phones: ["+15555550249"],
    });
    const one_ = await entityOf("tam.reed@fjord.example");
    const two = await entityOf("t.reed@field.example");
    expect(one_).not.toBe(two);
    const evidence = await drained(session_(["+15555550249"]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, failed: 0 });
    expect((await handleOf(evidence, "+15555550249")).entity).toBeNull();

    const before = await people();
    await w.admin.identity.linkPeople(one_ as never, two as never, "same", { requestId: "req-phone-group" });
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 1, failed: 0 });
    expect([one_, two]).toContain((await handleOf(evidence, "+15555550249")).entity);
    expect(await people()).toBe(before);
  });

  // A national number read in the owner's region, the contacts filled before it
  // filled again once by the catch-up.
  it("with the owner's zone in the North American plan, a contact's national number binds its handle; the contacts filled before are filled again once, and a zone outside the plan fills them back", async () => {
    await saved(contacts.own, "noor", {
      name: "Noor Hale",
      emails: ["noor.hale@fjord.example"],
      phones: ["(555) 555-0211"],
    });
    const evidence = await drained(session_(["+15555550211"]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, failed: 0 });
    const contactCount = one(
      await queryAs<{ n: number }>(w.db.urls.admin, "select count(*)::int as n from knowledge.contacts"),
    ).n;
    try {
      await queryAs(w.db.urls.admin, "update policy.owner_settings set time_zone = 'America/Chicago'");
      expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({
        handlesBound: 1,
        phonesFilled: contactCount,
        failed: 0,
      });
      expect(await handleOf(evidence, "+15555550211")).toMatchObject({
        entity: await entityOf("noor.hale@fjord.example"),
      });
      expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({
        handlesBound: 0,
        handlesRemoved: 0,
        phonesFilled: 0,
      });
      // A zone outside the plan reads no national number: every row is filled again, and the
      // binding goes.
      await queryAs(w.db.urls.admin, "update policy.owner_settings set time_zone = 'Europe/Berlin'");
      expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({
        handlesRemoved: 1,
        phonesFilled: contactCount,
      });
      expect((await handleOf(evidence, "+15555550211")).entity).toBeNull();
    } finally {
      await queryAs(w.db.urls.admin, "update policy.owner_settings set time_zone = null");
    }
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesRemoved: 0, phonesFilled: 0 });
  });

  it("the contact removed, its binding goes at the next sync; the owner's unbind lifts it, and it is not made again", async () => {
    await saved(contacts.own, "rowan", {
      name: "Rowan Vale",
      emails: ["rowan.vale@harbor.example"],
      phones: ["+15555550207"],
    });
    const evidence = await drained(session_(["+15555550207"]));
    expect((await w.writer.bindParticipants(new Date(T))).handlesBound).toBe(1);
    await unsaved(contacts.own, "rowan");
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, handlesRemoved: 1 });
    expect(await bindingsOf(evidence)).toEqual([]);
    expect((await handleOf(evidence, "+15555550207")).entity).toBeNull();
    // Saved again, bound again; the owner's unbind lifts it for good.
    await saved(contacts.own, "rowan", {
      name: "Rowan Vale",
      emails: ["rowan.vale@harbor.example"],
      phones: ["+15555550207"],
    });
    expect((await w.writer.bindParticipants(new Date(T))).handlesBound).toBe(1);
    const [binding] = await bindingsOf(evidence);
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, handlesRemoved: 0 });
    expect((await bindingsOf(evidence)).map((one) => one.lifted)).toEqual([true]);
    expect((await handleOf(evidence, "+15555550207")).entity).toBeNull();
  });

  // A moment's claims about a handle no person held are held, the handle filed
  // with its commit. When a phone-only contact later keys a person by that phone (rule 2, no
  // binding made), the sync sets the moment due again, its saved calls kept, so a run replays them;
  // once only. A handle whose binding the owner lifted stays held (invariant 11).
  it("a filed handle a phone-only contact keys since sets its moment due again once, its calls kept; one the owner unbound stays held", async () => {
    const LATER = "+15555550281";
    const LIFTED = "+15555550282";
    const generationOf = async (evidence: EvidenceId): Promise<number> =>
      one(
        await queryAs<{ generation: number }>(
          w.db.urls.admin,
          "select extractor_generation as generation from vault.pipeline_items where evidence_id = $1",
          [evidence],
        ),
      ).generation;
    const committed = async (evidence: EvidenceId, handle: string): Promise<void> => {
      const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.openMoment(evidence)).not.toBeNull();
        expect(
          await pipeline.commit(
            batchOf(evidence, [], {
              lane: "moment",
              status: "done",
              unresolved: 1,
              mentions: [{ name: handle, type: "commitment", field: "subject" }],
            }),
          ),
        ).toBe("committed");
      } finally {
        await pipeline.close();
      }
    };
    // A handle on no contact: bound by nobody, its claim held and the handle filed.
    const later = await drained(session_([LATER]));
    await committed(later, LATER);
    expect((await w.writer.bindParticipants(new Date(T))).heldDue).toBe(0);
    expect(await generationOf(later)).toBe(1);
    // The owner unbinds a handle a contact with an address bound; its claims are held again.
    await saved(contacts.own, "lifted", { name: "Wren Lake", emails: ["wren.lake@held.example"], phones: [LIFTED] });
    const lifted = await drained(session_([LIFTED]));
    expect((await w.writer.bindParticipants(new Date(T))).handlesBound).toBe(1);
    const [binding] = await bindingsOf(lifted);
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    await committed(lifted, LIFTED);
    // Phone-only contacts key a person by each phone now.
    await saved(contacts.own, "later", { name: "Ivo Gale", emails: [], phones: [LATER] });
    await saved(contacts.own, "lifted-phone", { name: "Wren L", emails: [], phones: [LIFTED] });
    expect(await handleOf(later, LATER)).toMatchObject({ entity: await entityOf(`tel:${LATER}`) });
    const calls = one(
      await queryAs<{ n: number }>(w.db.urls.admin, "select count(*)::int as n from vault.model_calls"),
    ).n;
    const counts = await w.writer.bindParticipants(new Date(T));
    expect(counts).toMatchObject({ heldDue: 1, handlesBound: 0, failed: 0 });
    expect(await generationOf(later)).toBe(0);
    expect(await generationOf(lifted)).toBe(1);
    expect(
      one(await queryAs<{ n: number }>(w.db.urls.admin, "select count(*)::int as n from vault.model_calls")).n,
    ).toBe(calls);
    // Due already: the next sync counts it no more.
    expect((await w.writer.bindParticipants(new Date(T))).heldDue).toBe(0);
  });

  // A held moment asked in a group with another moment is set due
  // with that moment, by the sync and by the owner's bind alike, so the group forms again and its
  // saved call replays.
  it("a held moment's saved call's other moments are due with it, by a phone key and by the owner's bind", async () => {
    const KEYED = "+15555550283";
    const BOUND = "+15555550284";
    const generationOf = async (evidence: EvidenceId): Promise<number> =>
      one(
        await queryAs<{ generation: number }>(
          w.db.urls.admin,
          "select extractor_generation as generation from vault.pipeline_items where evidence_id = $1",
          [evidence],
        ),
      ).generation;
    const waitingOf = async (evidence: EvidenceId): Promise<boolean> =>
      one(
        await queryAs<{ waiting: boolean }>(
          w.db.urls.admin,
          "select waiting from vault.pipeline_items where evidence_id = $1",
          [evidence],
        ),
      ).waiting;
    // Two sessions of one chat asked as one group: the first's claim names the handle, the second's none.
    const askedTogether = async (handle: string): Promise<[EvidenceId, EvidenceId]> => {
      const pair: [EvidenceId, EvidenceId] = [await drained(session_([handle])), await drained(session_([handle]))];
      const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
      try {
        for (const id of pair) expect(await pipeline.openMoment(id)).not.toBeNull();
        await pipeline.calls("configured/model", pair).save({
          key: {
            evidenceId: pair[0],
            revision: 0,
            extractorGeneration: 0,
            promptId: "personal_moment",
            promptVersion: "7",
            inputHash: "c".repeat(64),
          },
          keys: [{ evidenceId: pair[0], keyRef: "personal-unsealed" }],
          renderedInput: "",
          rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
          outputHash: "d".repeat(64),
          label: { compartments: ["own"], readers: ["m-owner"] },
          origin: "live",
        } as never);
        expect(
          await pipeline.commit(
            batchOf(pair[0], [], {
              lane: "moment",
              status: "done",
              unresolved: 1,
              mentions: [{ name: handle, type: "commitment", field: "subject" }],
            }),
          ),
        ).toBe("committed");
        expect(await pipeline.commit(batchOf(pair[1], [], { lane: "moment", status: "done" }))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      return pair;
    };
    const keyedPair = await askedTogether(KEYED);
    await saved(contacts.own, "keyed", { name: "Juno Pike", emails: [], phones: [KEYED] });
    expect((await w.writer.bindParticipants(new Date(T))).heldDue).toBe(2);
    expect([await generationOf(keyedPair[0]), await generationOf(keyedPair[1])]).toEqual([0, 0]);
    // The owner's bind of the filed handle sets the pair waiting, its call kept.
    const boundPair = await askedTogether(BOUND);
    const [filed] = await queryAs<{ id: string }>(
      w.db.urls.admin,
      "select id from vault.unresolved_mentions where evidence_id = $1",
      [boundPair[0]],
    );
    await w.admin.mentions.bindMention(filed?.id as never, (await entityOf("omar.reyes@field.example")) as EntityId, {
      requestId: req(),
    });
    expect([await waitingOf(boundPair[0]), await waitingOf(boundPair[1])]).toEqual([true, true]);
    expect(
      one(
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from vault.model_call_members where evidence_id = any($1)",
          [boundPair],
        ),
      ).n,
    ).toBe(2);
  });

  it("a person's erasure removes their handle from every CaptureFacts and lifts their binding for good; a phone person's erasure suppresses their key", async () => {
    await saved(contacts.own, "quill", {
      name: "Quill Ashby",
      emails: ["quill.ashby@field.example"],
      phones: ["+15555550208"],
    });
    await saved(contacts.own, "sol", { name: "Sol Brandt", emails: [], phones: ["+15555550209"] });
    const evidence = await drained(session_(["+15555550208", "+15555550209"]));
    await w.writer.bindParticipants(new Date(T));
    const quill = (await handleOf(evidence, "+15555550208")).entity as EntityId;
    const sol = (await handleOf(evidence, "+15555550209")).entity as EntityId;
    expect([quill, sol].every((one) => one !== null)).toBe(true);
    const handles = async (): Promise<string[]> => {
      const pipeline = createPipeline({ url: w.db.urls.pipeline, keys: w.db.keys, log: recordingLogger().log });
      try {
        return ((await pipeline.openMoment(evidence))?.capture.facts.participants ?? []).map((one) => one.handle ?? "");
      } finally {
        await pipeline.close();
      }
    };
    expect(await handles()).toEqual(["+15555550208", "+15555550209"]);
    await w.admin.erasure.erasePerson(quill, { requestId: req() });
    expect(await handles()).toEqual(["+15555550209"]);
    expect(await bindingsOf(evidence)).toEqual([]);
    await w.admin.erasure.erasePerson(sol, { requestId: req() });
    expect(await handles()).toEqual([]);
    // The next sync binds neither again, though a later session names both.
    const later = await drained(session_(["+15555550208", "+15555550209"]));
    await w.writer.bindParticipants(new Date(T));
    expect(await bindingsOf(later)).toEqual([]);
    for (const phone of ["+15555550208", "+15555550209"])
      expect((await handleOf(later, phone)).entity, phone).toBeNull();
  });

  let macAccount: Awaited<ReturnType<Writer["ensureSourceAccount"]>> | undefined;
  let macKeys = 0;
  const macSaved = async (person: { name: string; emails: string[]; phones: string[] }): Promise<void> => {
    if (macAccount === undefined) {
      const id = testId("acc");
      await queryAs(
        w.db.urls.admin,
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', 'lens_contacts', 'crm', '{own}')",
        [id],
      );
      macAccount = {
        id: SourceAccountId.parse(id),
        label: "device:mac",
        connector: "lens_contacts",
        sourceKind: "crm",
        compartment: "own",
      } as unknown as typeof macAccount;
    }
    const account = macAccount as NonNullable<typeof macAccount>;
    macKeys += 1;
    const raw = macContactItem(
      {
        kind: "contact",
        key: `contact:01JMACCBXND${String(macKeys).padStart(15, "0")}`,
        revision: 0,
        name: person.name,
        phones: person.phones,
        emails: [...person.emails].sort(),
      },
      { sourceAccount: account.id, now: Timestamp.parse(utc(0)) },
    );
    expect(await w.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
  };

  it("a handle on a Google contact of one person and a Mac contact of another binds the Google contact's; on a Mac contact alone binds its person; on two Mac copies of one person binds them; on Mac contacts of two people binds nobody", async () => {
    await saved(contacts.own, "gina", {
      name: "Gina Holt",
      emails: ["gina.holt@mesa.example"],
      phones: ["+15555550230"],
    });
    await macSaved({ name: "Bram Ode", emails: ["bram.ode@mesa.example"], phones: ["+15555550230"] });
    await macSaved({ name: "Cleo Rand", emails: ["cleo.rand@mesa.example"], phones: ["+15555550231"] });
    await macSaved({ name: "Dax Pell", emails: ["dax.pell@mesa.example"], phones: ["+15555550232"] });
    await macSaved({ name: "Dax", emails: ["dax.pell@mesa.example"], phones: ["+15555550232"] });
    await macSaved({ name: "Eli Ash", emails: ["eli.ash@mesa.example"], phones: ["+15555550233"] });
    await macSaved({ name: "Fay Ash", emails: ["fay.ash@mesa.example"], phones: ["+15555550233"] });
    const before = await people();
    const evidence = await drained(session_(["+15555550230", "+15555550231", "+15555550232", "+15555550233"]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 3, failed: 0 });
    expect(await people()).toBe(before);
    expect((await handleOf(evidence, "+15555550230")).entity).toBe(await entityOf("gina.holt@mesa.example"));
    expect((await handleOf(evidence, "+15555550231")).entity).toBe(await entityOf("cleo.rand@mesa.example"));
    expect((await handleOf(evidence, "+15555550232")).entity).toBe(await entityOf("dax.pell@mesa.example"));
    expect((await handleOf(evidence, "+15555550233")).entity).toBeNull();
  });

  it("a binding a Google contact gave is unchanged after a Mac contact copies it, and the slot names the Google contact's alias before the newer Mac contact's", async () => {
    await saved(contacts.own, "hugo", {
      name: "Hugo Mann",
      emails: ["hugo.mann@mesa.example"],
      phones: ["+15555550234"],
    });
    const evidence = await drained(session_(["+15555550234"]));
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 1 });
    const hugo = await entityOf("hugo.mann@mesa.example");
    expect(await handleOf(evidence, "+15555550234")).toEqual({ entity: hugo, names: { "+15555550234": "Hugo Mann" } });
    await macSaved({ name: "Hugo", emails: ["hugo.mann@mesa.example"], phones: ["+15555550234"] });
    expect(await w.writer.bindParticipants(new Date(T))).toMatchObject({ handlesBound: 0, handlesRemoved: 0 });
    expect(await handleOf(evidence, "+15555550234")).toEqual({ entity: hugo, names: { "+15555550234": "Hugo Mann" } });
  });

  it("0098's grant: the writer deletes a live code binding of a source moment, and no lifted one; the pipeline asks policy.moment_handle_names and the reader cannot", async () => {
    await saved(contacts.own, "arlo", {
      name: "Arlo Venn",
      emails: ["arlo.venn@named.example"],
      phones: ["+15555550210"],
    });
    const evidence = await drained(session_(["+15555550210"]));
    await w.writer.bindParticipants(new Date(T));
    const [binding] = await bindingsOf(evidence);
    expect(
      await queryAs(w.db.urls.writer, "delete from knowledge.mention_bindings where id = $1 returning id", [
        binding?.id,
      ]),
    ).toEqual([{ id: binding?.id }]);
    const call = "select * from policy.moment_handle_names($1, $2, $3)";
    expect(await sqlState(() => queryAs(w.db.urls.reader, call, [evidence, [], []]))).toBe("42501");
    expect(await sqlState(() => queryAs(w.db.urls.pipeline, call, [evidence, [], []]))).toBeNull();
    // A lifted binding stays whoever asks.
    const [lifted] = await queryAs<{ id: string }>(
      w.db.urls.admin,
      "select id from knowledge.mention_bindings where lifted_at is not null limit 1",
    );
    expect(lifted).toBeDefined();
    expect(
      await queryAs(w.db.urls.writer, "delete from knowledge.mention_bindings where id = $1 returning id", [
        lifted?.id,
      ]),
    ).toEqual([]);
  });
});
