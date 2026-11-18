import type { CaptureId, EntityId, EventId, FactId, MessageId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealUnder } from "../../core/seal.ts";
import { testId } from "../../test-support/clients.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { asClaimsOwner, session } from "../../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../../test-support/database.ts";
import { seedFacts } from "../../test-support/fact-fixtures.ts";
import { claimRecord } from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { seeder } from "../../test-support/seeder.ts";
import { draftingClient, type SendWorld, seedDraft, sendWorld } from "../../test-support/sender-fixtures.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { buildAs } from "../../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";
import { Admin, createAdmin } from "../admin.ts";

// A statement that changes or removes a claim, as the claims' owner: pi_admin may not.
const claimsAs = (db: TestDatabase, text: string, values: unknown[] = []): Promise<unknown> =>
  asClaimsOwner(db, (query) => query(text, values));

// Made-up values only.

const OWN = ["own"];

let store: TestStore;
let admin: Admin;
let messages: Message[];
let blake: EntityId;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
  admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log });
  const world = await seedWorld(store.writer, store.admin);
  blake = world.entityOf(WORLD.both.address);
  messages = await worldMessages(store);
  const own = messages.find((one) => one.compartment === "own") as Message;
  // The owner's beliefs built for `own` alone: their audience leaves the work mail out.
  await seedFacts(
    store,
    world.ownerEntity(),
    [
      {
        key: "s-role",
        type: "role",
        kind: "role",
        subject: blake,
        by: blake,
        message: own,
        fields: { title: "Canary heron keeper" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [blake],
      },
    ],
    [OWN],
  );
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

const subjectOf = async (id: string): Promise<string | null> =>
  (await admin.items.message(id as MessageId))?.subject?.untrusted ?? null;

describe("a row opened to its message (R-P6)", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("serves a message in the owner's audience as read_message does, and none outside it, unknown or held", async () => {
    const own = messages.filter((one) => one.compartment === "own");
    const work = messages.filter((one) => one.compartment !== "own");
    expect(own.length).toBeGreaterThan(1);
    expect(work.length).toBeGreaterThan(0);
    const shown = await admin.items.message(own[0]?.id as MessageId);
    expect(shown?.subject?.untrusted).toMatch(/^canary-own-subject-/);
    expect(shown?.offset).toBe(0);
    for (const one of work) expect(await admin.items.message(one.id as MessageId)).toBeNull();
    expect(await admin.items.message(testId("msg") as MessageId)).toBeNull();

    const held = own[1] as Message;
    expect(await subjectOf(held.id)).not.toBeNull();
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [held.id]);
    expect(await admin.items.message(held.id as MessageId)).toBeNull();
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = false where id = $1", [held.id]);
  });
});

describe("search beyond names (R-P5a)", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("finds the owner's mail by subject and facts by their words, only within the owner's audience, and drops a message once held", async () => {
    const found = await admin.search.factsAndMail("canary-own-subject");
    const own = new Set(messages.filter((one) => one.compartment === "own").map((one) => one.id));
    expect(found.mail.length).toBeGreaterThan(0);
    expect(found.mail.every((one) => own.has(one.message) && one.match === "subject")).toBe(true);
    // Work mail is outside the owner's audience: nothing of it is matched or counted.
    expect((await admin.search.factsAndMail("canary-work")).mail).toEqual([]);
    expect((await admin.search.factsAndMail(WORLD.workOnly.address)).mail).toEqual([]);

    const facts = (await admin.search.factsAndMail("heron keep")).facts;
    expect(facts.map((one) => one.words.untrusted)).toEqual(["Canary heron keeper"]);
    expect(facts[0]?.subject?.id).toBe(blake);
    expect(await admin.facts.show(facts[0]?.fact as never)).not.toBeNull();

    const held = found.mail[0]?.message as string;
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [held]);
    expect((await admin.search.factsAndMail("canary-own-subject")).mail.map((one) => one.message)).not.toContain(held);
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = false where id = $1", [held]);
    expect((await admin.search.factsAndMail("canary-own-subject")).mail.map((one) => one.message)).toContain(held);
  });
});

describe("a draft opened in its card (R-P7)", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let world: SendWorld;
  beforeAll(async () => {
    world = await sendWorld();
  }, SLOW_DB_TEST_TIMEOUT);
  afterAll(async () => {
    await world?.close();
  });

  it("serves the draft as the agent wrote it, with no code, and nothing for an unknown id", async () => {
    const client = await draftingClient(world, "drafter");
    const draft = await seedDraft(world, client, { subject: "Canary: the heron rota", body: "Line one\nLine two" });
    const owner = createAdmin({ url: world.db.urls.admin, keys: world.db.keys, log: recordingLogger().log });
    try {
      const shown = await owner.items.draft(draft.id);
      expect(shown).toMatchObject({
        id: draft.id,
        status: "made",
        to: [{ untrusted: draft.payload.to[0] }],
        cc: [],
        subject: { untrusted: "Canary: the heron rota" },
        text: { untrusted: "Line one\nLine two" },
        newThread: true,
      });
      expect(JSON.stringify(shown)).not.toContain(draft.code);
      // Its account never wrote to this address, so it is a first contact, and the
      // page's send command carries --first-contact.
      expect(shown?.firstContact).toBe(true);
      expect(Array.isArray(shown?.names)).toBe(true);
      expect(await owner.items.draft(testId("drf"))).toBeNull();
    } finally {
      await owner.close();
    }
  });
});

// Settings names each join and split in one read, each side as factShow renders it.
describe("several facts rendered in one read", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("renders each claim as factShow does, and leaves out an id that names none", async () => {
    const [role] = await session(store.db.urls.admin, (query) =>
      query<{ id: FactId }>("select id from knowledge.claims where type = 'role' order by id"),
    );
    if (role === undefined) throw new Error("the seeded role claim is missing");
    const unknown = "f".repeat(64) as FactId;
    const views = await admin.facts.views([role.id, unknown, role.id]);
    expect([...views.keys()]).toEqual([role.id]);
    expect(views.get(role.id)).toEqual((await admin.facts.show(role.id))?.fact);
    expect(views.get(role.id)?.source).toBe("mail");
  });
});

// Last in the file: its seeded rows are none of the earlier reads' business.
describe("a meeting opened from a timeline (R-P9)", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("serves an event in the owner's audience with its participants, a recording with its people, and nothing outside", async () => {
    const seeded = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const person = await seed.entity("person");
      const event = await seed.eventDetails(OWN);
      await query(
        "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'organizer', $3)",
        [event, person, OWN],
      );
      const work = await seed.eventDetails(["employer:example"], await seed.event(["employer:example"]));
      const recording = await seed.capture(OWN);
      await query(
        "update knowledge.captures set kind = 'meeting', capture_key = 'meeting:' || substr(capture_key, 8) where id = $1",
        [recording.id],
      );
      const claim = await seed.claim(OWN, recording.evidenceId);
      await claimsAs(store.db, "update knowledge.claims set type = 'capture.person' where id = $1", [claim]);
      await seed.claimEntity(OWN, claim, person);
      // Its sealed title, and a fact said in it.
      const sealedAt = (table: string, id: string, column: string, value: unknown) =>
        sealUnder(store.db.keys, OWN, { table, id, column }, JSON.stringify(value));
      await query("update knowledge.captures set facts_enc = $2 where id = $1", [
        recording.id,
        sealedAt("knowledge.captures", recording.id, "facts_enc", {
          kind: "meeting",
          title: "canary-recorded-title",
          calendar: null,
        }),
      ]);
      const fact = await seed.claim(OWN, recording.evidenceId);
      const record = claimRecord(recording.evidenceId, "own", person);
      const said = {
        ...record,
        claim: {
          ...record.claim,
          content: { ...record.claim.content, fields: { what: "canary-said-in-the-meeting" } },
        },
        fieldKinds: { what: "text" },
      };
      await claimsAs(store.db, "update knowledge.claims set content_enc = $2 where id = $1", [
        fact,
        sealedAt("knowledge.claims", fact, "content_enc", said),
      ]);
      await seed.claimEntity(OWN, fact, person);
      return { person, event, work, recording: recording.id, fact };
    });
    const event = await admin.items.meeting(seeded.event as EventId);
    expect(event?.kind).toBe("meeting");
    if (event?.kind !== "meeting") return;
    expect(event.meeting.title?.untrusted).toMatch(/^Seed title /);
    expect(event.meeting.participants.map((one) => one.id)).toEqual([seeded.person]);
    expect(await admin.items.meeting(seeded.work as EventId)).toBeNull();
    expect(await admin.items.meeting(testId("evt") as EventId)).toBeNull();

    const recording = await admin.items.meeting(seeded.recording as CaptureId);
    expect(recording).toMatchObject({
      kind: "captured_meeting",
      id: seeded.recording,
      participants: [{ id: seeded.person }],
    });
    // Its title and the fact said in it; never its participant claim, which "With" stands for.
    if (recording?.kind !== "captured_meeting") return;
    expect(recording.title?.untrusted).toBe("canary-recorded-title");
    expect(recording.facts).toEqual([{ id: seeded.fact, words: { untrusted: "canary-said-in-the-meeting" } }]);
    // Its row on the person's timeline carries the same title, once the owner's warmth is built.
    await buildAs(store.db, OWN);
    const entries = (await admin.people.timeline({ entity: seeded.person as EntityId }))?.entries ?? [];
    expect(entries.find((entry) => entry.kind === "captured_meeting")).toMatchObject({
      id: seeded.recording,
      title: { untrusted: "canary-recorded-title" },
    });
  });
});
