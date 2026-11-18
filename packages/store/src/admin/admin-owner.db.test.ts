import { type EntityId, OWNER_PAGE_MOST } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerAudience } from "../core/audience.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { createDb } from "../core/job-db.ts";
import { testId } from "../test-support/clients.ts";
import { type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { type FactSpec, seedFacts } from "../test-support/fact-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY } from "../test-support/values.ts";
import { buildAs, warmthWorld } from "../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { ownerBeliefs, ownerWho, ownerWithheld } from "./admin-owner.ts";

// The foundation the owner's reads share: one owner audience, one owner belief source, reader filters
// stated, paging and names, as pi_admin, over a world with two belief audiences (a narrow client's and the
// owner's) and warmth built for three, one wider than the owner's. Claims are committed through the
// Pipeline and beliefs written as the rebuild writes them. Reserved domains and made-up ids only.

const TODAY = new Date("2026-10-22T12:00:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(TODAY.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];
const WIDE = ["employer:example", "own"];
// A client's clearance wider than any compartment a claim holds: never the owner's audience.
const WIDER = ["employer:example", "family", "own"];

let store: TestStore;
let blake: string;
let owner: string;
const people: string[] = [];

// Each statement a transaction sends, counted.
async function counted<T>(fn: (query: Query, sent: string[]) => Promise<T>): Promise<T> {
  const db = createDb(store.db.urls.admin, recordingLogger().log);
  try {
    return await db.transaction((query) => {
      const sent: string[] = [];
      const counting: Query = (text, values) => {
        sent.push(text);
        return query(text, values);
      };
      return fn(counting, sent);
    });
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "family"] });
  const world = await seedWorld(store.writer, store.admin);
  owner = world.ownerEntity();
  blake = world.entityOf(WORLD.both.address);
  const messages = await worldMessages(store);
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;
  const specs: FactSpec[] = [
    {
      key: "of-role",
      type: "role",
      kind: "role",
      subject: blake,
      by: blake,
      message: on("own", 0),
      fields: { title: "canary-of-title" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [blake],
    },
    {
      key: "of-work-role",
      type: "role",
      kind: "role",
      subject: blake,
      by: blake,
      message: on("employer:example", 0),
      fields: { title: "canary-of-work" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [blake],
    },
  ];
  await seedFacts(store, owner, specs, [OWN, WIDE]);

  // Three people the owner writes with, closest first, and warmth built for three audiences.
  const warmth = warmthWorld(store.db);
  for (const exchanges of [4, 2, 1]) {
    const person = await warmth.person(OWN);
    for (let n = 0; n < exchanges; n += 1) {
      const thread = testId("thr");
      await warmth.mail(OWN, { at: daysAgo(3 + n * 7), to: [person], thread });
      await warmth.mail(OWN, { at: daysAgo(3 + n * 7 - 0.1), from: person, thread });
    }
    people.push(person);
  }
  for (const audience of [OWN, WIDE, WIDER]) await buildAs(store.db, audience);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("owner reads' foundation", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("R-the owner's audience is every compartment of the claims, computed, asked once a transaction", () =>
    counted(async (query, sent) => {
      expect(await ownerAudience(query)).toEqual(WIDE);
      expect(await ownerAudience(query)).toEqual(WIDE);
      expect(sent.filter((text) => text.includes("cross join unnest(c.compartments)"))).toHaveLength(1);
    }));

  it("R-ownerBeliefs reads the owner's audience alone, every fact once, or the keys asked", () =>
    counted(async (query) => {
      const tx = { query, keys: store.db.keys };
      const all = await ownerBeliefs(tx, "all");
      const keys = ["of-role", "of-work-role"].map((key) => fingerprint(store.db.keys, "fact", key)).sort();
      expect(all.map((one) => one.factKey).sort()).toEqual(keys);
      expect(all.map((one) => one.compartments).sort()).toEqual([["employer:example"], ["own"]]);
      expect((await ownerBeliefs(tx, [keys[0] as string])).map((one) => one.factKey)).toEqual([keys[0]]);
      expect(await ownerBeliefs(tx, [])).toEqual([]);
    }));

  it("R-ownerWho names people in one batch whatever their number, and leaves out the owner and an unknown id", async () => {
    const one = await counted(async (query, sent) => ({
      who: await ownerWho({ query, keys: store.db.keys }, [blake]),
      sent: sent.length,
    }));
    const many = await counted(async (query, sent) => ({
      who: await ownerWho({ query, keys: store.db.keys }, [blake, ...people, owner, MISSING_ENTITY]),
      sent: sent.length,
    }));
    expect(many.sent).toBe(one.sent);
    expect([...many.who.keys()].sort()).toEqual([blake, ...people].sort());
    const named = many.who.get(blake);
    expect(named).toMatchObject({ id: blake, kind: "person" });
    expect(named?.name).not.toBeNull();
    for (const person of people) expect(many.who.get(person)?.address?.untrusted).toMatch(/@seed-org-\d+\.test$/);
  });

  it("warmth reads the owner's audience, not the widest built, and pages by the server's cursor", async () => {
    const whole = await store.admin.tiers.peopleTiers();
    expect(whole.audience?.audience).toEqual(WIDE);
    expect(whole.next).toBeNull();
    const order = whole.people.map((one) => one.entity);
    expect(order).toEqual(expect.arrayContaining(people));
    expect(order.length).toBeGreaterThan(2);

    const first = await store.admin.tiers.peopleTiers({ limit: 2 });
    expect(first.people.map((one) => one.entity)).toEqual(order.slice(0, 2));
    expect(first.next).not.toBeNull();
    const rest = await store.admin.tiers.peopleTiers({
      limit: OWNER_PAGE_MOST,
      ...(first.next === null ? {} : { cursor: first.next }),
    });
    expect(rest.people.map((one) => one.entity)).toEqual(order.slice(2));
    expect(rest.next).toBeNull();
    await expect(store.admin.tiers.peopleTiers({ limit: 2, cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "invalid_argument",
    });

    expect((await store.admin.tiers.personWarmth(people[0] as string)).audience?.audience).toEqual(WIDE);
  });

  // Last: it rules.
  it("R-a person ignored is withheld from the tiers list at once, and answered by name with no line", async () => {
    const ignored = people[1] as EntityId;
    await store.admin.ignores.addIgnore("entity", ignored, { requestId: testId("req") });
    expect([...(await counted((query) => ownerWithheld(query)))]).toContain(ignored);
    expect((await store.admin.tiers.peopleTiers()).people.map((one) => one.entity)).not.toContain(ignored);
    // Ranked at read, an ignored person takes no line and no rank slot at once; asked by name, the
    // person is answered, with no line.
    const asked = await store.admin.tiers.personWarmth(ignored);
    expect(asked.person).toBe(ignored);
    expect(asked.row).toBeNull();
  });
});
