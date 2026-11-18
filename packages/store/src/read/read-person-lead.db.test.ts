import { EntityView, type PersonalView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { warmthWorld } from "../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Blake's mail is in both the owner's own mailbox and their work one, so a client cleared for one
// gets a pointer into it alone, and a client cleared for both is the control. The synthetic world
// only.

describe("a person's lead", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let blake: string;
  let narrow: Client;
  let work: Client;
  let wide: Client;
  let noWork: Client;
  const tools = ["get_entity", "read_message", "read_item", "get_commitments"];
  const views: PersonalView[] = ["self", "people", "work"];

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    blake = world.entityOf(WORLD.both.address);
    narrow = await insertReader(store, "lead-own", ["own"], { tools, views });
    work = await insertReader(store, "lead-work", ["employer:example"], { tools, views });
    wide = await insertReader(store, "lead-wide", ["employer:example", "own"], { tools, views });
    noWork = await insertReader(store, "lead-people", ["own"], { tools, views: ["self", "people"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const lead = async (client: Client) => {
    const view = EntityView.parse(outcomeValue(await store.reader.getEntity(client.token, { id: blake as never })));
    expect(Object.keys(view).slice(0, 3)).toEqual(["id", "kind", "lead"]);
    return view.lead;
  };
  const newest = async (compartments: string[]) => {
    const rows = await queryAs<{ id: string }>(
      store.db.urls.admin,
      `select m.id from knowledge.messages m
       where m.compartments <@ $1::text[] and not m.held and m.evidence_id in (
         select i.evidence_id from knowledge.interaction_log i
         where i.entity_id = $2 and (i.direction = 'outbound' or (i.direction = 'inbound' and i.entity_role = 'sender')))
       order by m.sent_at desc, m.id limit 1`,
      [compartments, blake],
    );
    return rows[0]?.id;
  };

  it("points each client at the newest message it can read, and never at one it cannot", async () => {
    const own = await lead(narrow);
    const theirs = await lead(work);
    const both = await lead(wide);
    expect(own?.lastThread?.message).toBe(await newest(["own"]));
    expect(theirs?.lastThread?.message).toBe(await newest(["employer:example"]));
    // The control: one cleared for both gets the newer of the two, so the two narrow answers differ.
    expect(own?.lastThread?.message).not.toBe(theirs?.lastThread?.message);
    expect(both?.lastThread?.message).toBe(await newest(["employer:example", "own"]));
    expect(
      outcomeValue(await store.reader.readMessage(narrow.token, { id: own?.lastThread?.message as never })).id,
    ).toBe(own?.lastThread?.message);
    expect(await store.reader.readMessage(work.token, { id: own?.lastThread?.message as never })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      outcomeValue(await store.reader.readItem(narrow.token, { message: own?.lastThread?.message as never })),
    ).toBeDefined();
  });

  it("says which pointer is newer, and points at a meeting the page already names", async () => {
    const view = outcomeValue(await store.reader.getEntity(wide.token, { id: blake as never }));
    const { lastThread, lastMeeting, lastContact } = view.lead ?? {};
    expect(lastMeeting ?? null).toEqual(
      view.lastMeeting === null ? null : { meeting: view.lastMeeting.id, at: view.lastMeeting.startsAt },
    );
    if (lastThread && lastMeeting) expect(lastContact).toBe(lastThread.at >= lastMeeting.at ? "message" : "meeting");
    expect(lastContact).not.toBeNull();
  });

  it("counts a past meeting only if the owner kept it, as the owner's panel does", async () => {
    const at = new Date(WORLD_NOW.getTime() - 3_600_000).toISOString();
    const kept = new Date(WORLD_NOW.getTime() - 7_200_000).toISOString();
    const warmth = warmthWorld(store.db);
    await warmth.meeting(["own"], [blake], at, { response: "needsAction" });
    await warmth.meeting(["own"], [blake], new Date(WORLD_NOW.getTime() - 5_400_000).toISOString(), {
      response: "declined",
    });
    await warmth.meeting(["own"], [blake], kept, { response: "tentative" });
    expect((await lead(wide))?.lastMeeting?.at).toBe(kept);
  });

  it("logs the pointer's message as shown", async () => {
    const own = await lead(narrow);
    const [row] = await queryAs<{ shown: string[] }>(
      store.db.urls.admin,
      "select shown from ledger.read_log where client_id = $1 and tool = 'get_entity' order by id desc limit 1",
      [narrow.id],
    );
    const [message] = await queryAs<{ evidence_id: string }>(
      store.db.urls.admin,
      "select evidence_id from knowledge.messages where id = $1",
      [own?.lastThread?.message],
    );
    expect(row?.shown).toContain(message?.evidence_id);
  });

  it("gives each client a next step from what it can read, stored nowhere", async () => {
    const before = await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from knowledge.claims");
    const own = await lead(narrow);
    expect(own?.nextStep).toBeDefined();
    // A commitment's kind only with the Work view, as get_commitments is: a function of the registration.
    const noWorkStep = (await lead(noWork))?.nextStep;
    expect(["owed_by_owner", "owed_to_owner"]).not.toContain(noWorkStep?.kind);
    // A pointer one client gets it can read itself.
    if (own?.nextStep?.message !== undefined)
      expect(outcomeValue(await store.reader.readMessage(narrow.token, { id: own.nextStep.message as never })).id).toBe(
        own.nextStep.message,
      );
    expect(
      await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from knowledge.claims"),
    ).toEqual(before);
  });

  it("gives the open commitment count only to a client with the Work view, whatever the owner has", async () => {
    expect(typeof (await lead(narrow))?.openCommitments).toBe("number");
    expect((await lead(noWork))?.openCommitments).toBeNull();
  });

  it("an organization's page has no lead", async () => {
    const world = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select e.id from knowledge.entities e where e.kind = 'organization' order by e.id limit 1",
    );
    const id = world[0]?.id;
    if (id === undefined) throw new Error("the world holds no organization");
    const page = outcomeValue(await store.reader.getEntity(wide.token, { id: id as never }));
    expect(page.kind).toBe("organization");
    expect(page.lead).toBeUndefined();
  });
});
