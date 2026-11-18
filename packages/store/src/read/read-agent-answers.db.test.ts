import { ContextPack, EventId, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openUnder } from "../core/seal.ts";
import { seedCapture } from "../test-support/capture-fixtures.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// What an agent's first read and a meeting's prep give, on the synthetic world, under the caller's
// token: the goals first, the signs of applications, the notes that name an attendee and the last
// captured meeting. Reserved domains only.

const VIEWS = ["self", "people", "work"];
// Credential-shaped, split so no scanner takes the test for one.
const TOKEN = "gh" + "p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const TOOLS = ["get_self", "build_context_pack", "record", "list_goals"];

describe("what an agent gets", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let reader: Reader;
  let own: Client;
  let noPeople: Client;
  let uncleared: Client;
  let event: string;
  let capture: string;

  const self = async (client: Client, args = {}) =>
    SelfView.parse(outcomeValue(await reader.getSelf(client.token, args)));
  const prep = async (client: Client) =>
    ContextPack.parse(
      outcomeValue(
        await reader.buildContextPack(client.token, { purpose: "meeting_prep", event: EventId.parse(event) }),
      ),
    );

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "agent:own-reader"] });
    const world = await seedWorld(store.writer, store.admin);
    reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
    own = await insertReader(store, "own-reader", ["own", "agent:own-reader"], { tools: TOOLS, views: VIEWS });
    noPeople = await insertReader(store, "no-people", ["own"], { tools: ["get_self"], views: ["self"] });
    uncleared = await insertReader(store, "uncleared", ["own"], {
      tools: ["build_context_pack"],
      views: ["self", "people"],
    });

    const seed = storeSeeder(store.writer, WORLD_NOW);
    const to = [{ address: WORLD.ownerPersonal }];
    const day = (back: number): Date => new Date(WORLD_NOW.getTime() - back * 86_400_000);
    const mailbox = world.accounts.personalMail;
    const workbox = world.accounts.workMail;
    if (mailbox === undefined || workbox === undefined) throw new Error("the world has both mailboxes");
    await seed.mail(mailbox, {
      id: "applied-alder",
      from: { address: "jobs@alder.example" },
      to,
      at: day(2),
      subject: "Thank you for applying to Alder Labs",
    });
    await seed.mail(mailbox, {
      id: "applied-masked",
      from: { address: "jobs@birch.example" },
      to,
      at: day(3),
      subject: `Application received, portal token ${TOKEN}`,
    });
    await seed.mail(mailbox, {
      id: "newsletter",
      from: { address: "news@birch.example" },
      to,
      at: day(1),
      subject: "Birch is hiring a chief of staff",
    });
    await seed.mail(workbox, {
      id: "applied-work",
      from: { address: "jobs@cedar.example" },
      to: [{ address: WORLD.ownerWork }],
      at: day(1),
      subject: "canary-work your application to Cedar",
    });

    const events = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
      store.db.urls.admin,
      "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
    );
    const found = events.find(
      (row) =>
        row.title_enc !== null &&
        openUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.event_details", id: row.id, column: "title_enc" },
          row.title_enc as never,
        ) === WORLD.ownMeeting,
    );
    if (found === undefined) throw new Error("the world has the meeting");
    event = found.id;
    capture = await seedCapture(store.db, ["own"], "meeting");
    await queryAs(store.db.urls.admin, "update knowledge.captures set event_id = $2, started_at = $3 where id = $1", [
      capture,
      event,
      day(3).toISOString(),
    ]);

    const write = async (client: Client, body: string, n: number) =>
      outcomeValue(await reader.record(client.token, { kind: "finding", body, requestId: `answers-request-${n}` }))
        .recordId;
    await write(own, `Call prep: the purpose is the next step with ${WORLD.both.ownName}.`, 1);
    await write(own, "A note about a rover shaft and nobody at all.", 2);
  });

  afterAll(async () => {
    await store.close();
  });

  it("puts the goals and what is withheld first", async () => {
    const whole = await self(own);
    expect(Object.keys(whole)[0]).toBe("goals");
    const partial = await self(noPeople);
    expect(Object.keys(partial).slice(0, 2)).toEqual(["goals", "withheld"]);
    expect(partial.withheld).toEqual(expect.arrayContaining(["goals", "work", "applications"]));
  });

  it("shows a confirmation from the caller's mail, and no newsletter or mail outside its label", async () => {
    const whole = await self(own);
    expect(whole.applications?.[0]).toMatchObject({
      state: "applied",
      what: { untrusted: "Thank you for applying to Alder Labs" },
      from: { untrusted: "jobs@alder.example" },
    });
    expect(whole.applications).toHaveLength(2);
    expect(JSON.stringify(whole)).not.toContain(TOKEN);
    expect(JSON.stringify(whole)).not.toContain("canary-work");
  });

  it("serves the signs with career alone, and gives a client without mail none of them", async () => {
    expect((await self(own, { domain: "career" })).applications).toHaveLength(2);
    expect((await self(own, { domain: "travel" })).applications).toBeUndefined();
    expect(JSON.stringify(await self(noPeople))).not.toContain("Alder Labs");
  });

  it("serves the agent notes naming an attendee, and the last captured meeting, in meeting_prep", async () => {
    const pack = await prep(own);
    expect(pack.template).toBe("meeting_prep@8");
    const notes = pack.items.flatMap((item) => (item.kind === "record" ? [item.record.body?.untrusted] : []));
    expect(notes).toEqual([`Call prep: the purpose is the next step with ${WORLD.both.ownName}.`]);
    const attendees = pack.items.flatMap((item) => (item.kind === "attendee" ? [item.attendee] : []));
    expect(attendees.some((one) => one.lastCapture?.capture === capture)).toBe(true);
  });

  it("gives a client not cleared for a note's label none of it", async () => {
    const pack = await prep(uncleared);
    expect(pack.items.some((item) => item.kind === "record")).toBe(false);
  });
});
