import { OwnerActivity } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worldMessages } from "../../test-support/commitment-fixtures.ts";
import { type FactSpec, seedFacts } from "../../test-support/fact-fixtures.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";

// Made-up words, in the synthetic world.

const OWN = ["own"];

describe("the owner's activity", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "family"] });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    const own = (await worldMessages(store)).filter((one) => one.compartment === "own");
    const spec = (key: string, type: string, n: number, fields: FactSpec["fields"], kinds: FactSpec["fieldKinds"]) =>
      ({
        key,
        type,
        subject: owner,
        by: owner,
        message: own[n],
        fields,
        fieldKinds: kinds,
        entities: typeof fields.counterparty === "string" ? [fields.counterparty] : [],
      }) as FactSpec;
    await seedFacts(
      store,
      owner,
      [
        spec(
          "a-topic",
          "activity.researched",
          0,
          { topic: "soil moisture sensors", host: "docs.example.org" },
          { topic: "text", host: "text" },
        ),
        spec(
          "a-mail",
          "activity.researched",
          1,
          { category: "communication", host: "mail.example.org" },
          { category: "enum", host: "text" },
        ),
        spec("a-met", "activity.met", 2, { counterparty: blake }, { counterparty: "entity" }),
        // No activity: a goal stays in the room's parts.
        { ...spec("a-goal", "goal", 3, { what: "canary-activity-goal" }, { what: "text" }), kind: "goal", values: {} },
      ],
      [OWN],
    );
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const all = async () => {
    const first = OwnerActivity.parse(await store.admin.self.activity({}));
    return first.entries;
  };

  it("titles each from its theme, newest first, and holds no other claim", async () => {
    const entries = await all();
    const titles = entries.map((one) => one.title.untrusted);
    expect(titles).toHaveLength(3);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Communication on mail.example.org",
        "Researched soil moisture sensors",
        expect.stringMatching(/^Met /),
      ]),
    );
    expect(titles.join()).not.toContain(blake);
    expect(titles.join()).not.toContain("canary-activity-goal");
    const times = entries.map((one) => Date.parse(one.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("pages by a cursor it issued, and refuses one it did not", async () => {
    const first = await store.admin.self.activity({ limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const second = await store.admin.self.activity({ limit: 1, cursor: first.next ?? undefined });
    expect(second.entries[0]?.fact).not.toBe(first.entries[0]?.fact);
    await expect(store.admin.self.activity({ cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("a person the owner removed leaves it, with no trace of the row", async () => {
    await store.admin.ignores.addIgnore("entity", blake, { requestId: "req-activity-remove" });
    const titles = (await all()).map((one) => one.title.untrusted);
    expect(titles.filter((one) => one.startsWith("Met "))).toEqual([]);
    expect(titles).toContain("Researched soil moisture sensors");
  });
});
