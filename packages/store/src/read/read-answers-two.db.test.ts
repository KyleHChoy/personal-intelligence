import { ContextPack, EntityId, EntityView, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// The outcome test's second round, end to end under a client's token, on the synthetic world: an offer's
// body ends it, only a client that may read a message whole reads one, a person's brief names the next
// step, list_goals names the goals set, and find_paths' claim statement runs. Reserved domains only.

const VIEWS = ["self", "people", "work"];

describe("answers, second round", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let reader: Reader;
  let reads: Client;
  let subjectsOnly: Client;
  let person: string;

  const applications = async (client: Client) =>
    SelfView.parse(outcomeValue(await reader.getSelf(client.token, { domain: "career" }))).applications ?? [];

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
    const world = await seedWorld(store.writer, store.admin);
    person = world.entityOf(WORLD.both.address);
    reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
    reads = await insertReader(store, "reads-whole", ["own"], {
      tools: ["get_self", "read_message", "list_goals", "build_context_pack", "get_entity", "find_paths"],
      views: VIEWS,
    });
    subjectsOnly = await insertReader(store, "subjects-only", ["own"], { tools: ["get_self"], views: VIEWS });

    const seed = storeSeeder(store.writer, WORLD_NOW);
    const mailbox = world.accounts.personalMail;
    if (mailbox === undefined) throw new Error("the world has the mailbox");
    const day = (back: number): Date => new Date(WORLD_NOW.getTime() - back * 86_400_000);
    const to = [{ address: WORLD.ownerPersonal }];
    await seed.mail(mailbox, {
      id: "cedar-offer",
      from: { address: "team@cedar.example" },
      to,
      at: day(5),
      subject: "Your offer from Cedar",
    });
    await seed.mail(mailbox, {
      id: "cedar-update",
      from: { address: "team@cedar.example" },
      to,
      at: day(2),
      subject: "An update on your Cedar offer",
      text: "We are no longer able to move forward with your offer for this project.",
    });
    await seed.mail(mailbox, {
      id: "forged-offer",
      from: { address: "team@alder.example" },
      to,
      at: day(9),
      subject: "Your offer from Alder",
    });
    await queryAs(store.db.urls.admin, "update knowledge.messages set auth = 'fail' where sent_at = $1", [day(9)]);
    await store.admin.work.addGoal("Ship the review.", "own", { requestId: "req-answers-two-goal" });
  });

  afterAll(async () => {
    await store.close();
  });

  it("a client that may read a message whole sees the offer ended, and the earlier sign gone", async () => {
    const cedar = (await applications(reads)).filter((one) => one.from?.untrusted === "team@cedar.example");
    expect(cedar.map((one) => [one.state, one.what.untrusted])).toEqual([["closed", "An update on your Cedar offer"]]);
  });

  it("mail failing authentication is no sign, so a forged sender neither adds nor ends one", async () => {
    const signs = await applications(reads);
    expect(signs.some((one) => one.from?.untrusted === "team@alder.example")).toBe(false);
  });

  it("a body read for its state is never bound, so no close may cite it as read whole", async () => {
    await applications(reads);
    const rows = await queryAs<{ bound: string[] }>(
      store.db.urls.admin,
      `select r.bound from ledger.read_log r
       where r.client_id = $1 and r.tool = 'get_self'
         and r.bound && (select array_agg(m.evidence_id) from knowledge.messages m where m.sent_at = $2)`,
      [reads.id, new Date(WORLD_NOW.getTime() - 2 * 86_400_000)],
    );
    expect(rows).toEqual([]);
  });

  it("a client without read_message goes by the subject, so an update claims no offer and no end", async () => {
    const cedar = (await applications(subjectsOnly)).filter((one) => one.from?.untrusted === "team@cedar.example");
    expect(cedar.map((one) => one.state)).toEqual(["in_progress", "offer"]);
  });

  it("the whole page serves the same signs, and its plans, situations and events read", async () => {
    const page = SelfView.parse(outcomeValue(await reader.getSelf(reads.token, {})));
    expect(page.applications?.some((one) => one.state === "closed")).toBe(true);
    expect(page.openItems).toBeDefined();
  });

  it("list_goals names the goals the owner set", async () => {
    const listed = outcomeValue(await reader.listGoals(reads.token, { stale: true }));
    expect(listed.goals.map((one) => one.statement.untrusted)).toContain("Ship the review.");
    for (const goal of listed.goals) expect(goal.id).toMatch(/^gol_/);
  });

  it("a person's brief names the same next step as their card", async () => {
    const pack = ContextPack.parse(
      outcomeValue(
        await reader.buildContextPack(reads.token, { purpose: "person_brief", entity: EntityId.parse(person) }),
      ),
    );
    expect(pack.template).toBe("person_brief@5");
    const item = pack.items.find((one) => one.kind === "entity");
    const card = EntityView.parse(outcomeValue(await reader.getEntity(reads.token, { id: person as never })));
    expect(card.lead?.nextStep).toBeDefined();
    expect(item?.kind === "entity" ? item.entity.lead?.nextStep : undefined).toEqual(card.lead?.nextStep);
  });

  it("find_paths still walks, a contact's claim citable", async () => {
    expect(outcomeValue(await reader.findPaths(reads.token, { target: person as never })).paths).toBeInstanceOf(Array);
  });
});
