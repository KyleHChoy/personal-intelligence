import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { queryAs } from "../../test-support/database.ts";
import { seedFacts } from "../../test-support/fact-fixtures.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";

// The page's Settings names each ignore ruling and veto:
// `ignoredWho` matches a ruling's fingerprints to the people or organizations that hold them, and
// `whoOf` names entities by id in the owner's audience, as the page's other reads name them. Made-up
// values only.

let store: TestStore;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW });
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("ignore rulings named for the page", { timeout: DB_TEST_TIMEOUT }, () => {
  it("names the person an entity ignore covers, and no one for a domain nothing known holds", async () => {
    const world = await seedWorld(store.writer, store.admin);
    const pat = world.entityOf(WORLD.ownOnly.address);
    // A belief built for the owner's audience, which names are read in.
    const own = (await worldMessages(store)).find((one) => one.compartment === "own") as Message;
    await seedFacts(
      store,
      world.ownerEntity(),
      [
        {
          key: "w-role",
          type: "role",
          kind: "role",
          subject: pat,
          by: pat,
          message: own,
          fields: { title: "canary-w-title" },
          fieldKinds: { title: "text" },
          values: {},
          entities: [pat],
        },
      ],
      [["own"]],
    );
    const ruling = await store.admin.ignores.addIgnore("entity", pat, { requestId: testId("req") });
    const unknown = await store.admin.ignores.addIgnore("domain", "never-written.test", { requestId: testId("req") });

    const who = await store.admin.ignores.ignoredWho();
    expect(who.get(ruling)?.map((one) => [one.id, one.name?.untrusted])).toEqual([[pat, WORLD.ownOnly.name]]);
    expect(who.has(unknown)).toBe(false);

    // A ruling lifted keeps its name: the page shows what it covered.
    await store.admin.ignores.liftIgnore(ruling, { requestId: testId("req") });
    expect((await store.admin.ignores.ignoredWho()).get(ruling)?.map((one) => one.id)).toEqual([pat]);

    const named = await store.admin.names.who([pat, testId("ent")]);
    expect(named.get(pat)?.name?.untrusted).toBe(WORLD.ownOnly.name);
    expect(named.size).toBe(1);

    // A join or split is named by the latest claim of each side's key; a key with none has none.
    const [claim] = await queryAs<{ id: string; fact_key_fp: string }>(
      store.db.urls.admin,
      "select id, fact_key_fp from knowledge.claims where fact_key_fp is not null order by valid_from desc, id limit 1",
    );
    if (claim === undefined) throw new Error("no claim seeded");
    const latest = await store.admin.facts.latestClaims([claim.fact_key_fp, "0".repeat(64)]);
    expect([...latest.keys()]).toEqual([claim.fact_key_fp]);
  });
});
