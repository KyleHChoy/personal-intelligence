import type { EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../core/fingerprint.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { type FactSpec, seedFacts } from "../../test-support/fact-fixtures.ts";
import { lines, snapshot } from "../../test-support/snapshot.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { MISSING_ENTITY } from "../../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";

// Claims are committed through the Pipeline, their beliefs computed when asked. Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];

type World = { store: TestStore; owner: string; blake: string };

async function withWorld(audiences: string[][], body: (world: World) => Promise<void>): Promise<void> {
  const store = await openStore({ now: WORLD_NOW });
  try {
    const world = await seedWorld(store.writer, store.admin);
    const owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    const messages = await worldMessages(store);
    const on = (compartment: string, n: number): Message =>
      messages.filter((one) => one.compartment === compartment)[n] as Message;
    const specs: FactSpec[] = [
      {
        key: "ep-role",
        type: "role",
        kind: "role",
        subject: blake,
        by: blake,
        message: on("own", 0),
        fields: { title: "canary-title-blake" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [blake],
      },
      {
        key: "ep-need",
        type: "need",
        kind: "need",
        subject: blake,
        by: blake,
        message: on("own", 1),
        fields: { what: "canary-need-blake" },
        fieldKinds: { what: "text" },
        values: {},
        entities: [blake],
        status: "stale",
      },
      {
        key: "ep-work-role",
        type: "role",
        kind: "role",
        subject: blake,
        by: blake,
        message: on("employer:example", 0),
        fields: { title: "canary-work-title" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [blake],
      },
    ];
    await seedFacts(store, owner, specs, audiences);
    await body({ store, owner, blake });
  } finally {
    await store.close();
  }
}

const factsOf = (store: TestStore, keys: string[]): string[] =>
  keys.map((key) => fingerprint(store.db.keys, "fact", key)).sort();

describe("the owner's entity page", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  for (const [name, audiences] of [
    ["two clients of different clearance", [OWN, WIDE]],
    ["no client, the owner's audience alone", [WIDE]],
  ] as const) {
    it(`the page shows the entity's beliefs and their citations, once each, with ${name}`, () =>
      withWorld(
        audiences.map((one) => [...one]),
        async ({ store, blake }) => {
          const page = await store.admin.people.entityPage(blake as EntityId);
          expect(page?.entity).toMatchObject({ id: blake, kind: "person" });
          const facts = page?.facts.beliefs.map((one) => one.fact) ?? [];
          expect([...facts].sort()).toEqual(factsOf(store, ["ep-role", "ep-need", "ep-work-role"]));
          for (const belief of page?.facts.beliefs ?? []) expect(belief.cites).toHaveLength(1);
          const text = JSON.stringify(page);
          for (const canary of ["canary-title-blake", "canary-need-blake", "canary-work-title"])
            expect(text.split(canary)).toHaveLength(2);
        },
      ));
  }

  it("the page writes nothing", () =>
    withWorld([OWN, WIDE], async ({ store, blake }) => {
      const before = lines(await snapshot(store.db));
      expect(await store.admin.people.entityPage(blake as EntityId)).not.toBeNull();
      expect(lines(await snapshot(store.db))).toEqual(before);
    }));

  it("the owner's id, and one that names no one, have no page", () =>
    withWorld([WIDE], async ({ store, owner }) => {
      expect(await store.admin.people.entityPage(owner as EntityId)).toBeNull();
      expect(await store.admin.people.entityPage(MISSING_ENTITY)).toBeNull();
    }));
});
