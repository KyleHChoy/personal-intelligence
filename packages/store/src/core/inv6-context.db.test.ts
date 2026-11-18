import type { ContextArgs, EntityId, ReadOutcome } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader } from "../read/read.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import {
  ownerSide,
  personNeed,
  personRole,
  type Seeded,
  type Spec,
  seedSpecs,
} from "../test-support/context-db-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { fingerprint } from "./fingerprint.ts";

// Invariant 6: nothing a viewer cannot see changes anything the viewer sees. A card's lines and
// their order, and context's domains, sections, people, open work, goals, passages and order, and
// the statements each call sends, are the same for a client cleared for `own` before and after rows
// only `employer:example` may read are added: the owner's beliefs in the same domain (one naming a
// person the client cannot see), a newer role and a need of the same person, a commitment with
// them, and a goal of the same words. A client cleared for both sees them (the positive control).
// Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const VIEWS = ["self", "people", "work"];
const TOOLS = ["get_entity", "find_facts", "context", "list_goals"];
const HIDDEN = "canary-work-hidden";

describe("invariant 6: the card and context", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; wren: string };
  let messages: Message[];
  let own: Client;
  let wide: Client;
  let seeded: Seeded[];
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;

  // Each call on a reader of its own, so each opens its session as a first call does; its answer
  // and every statement it sent.
  const observe = async <T>(
    call: (reader: Reader, token: string) => Promise<ReadOutcome<T>>,
    client: Client,
  ): Promise<{ value: T; statements: string[] }> => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    const value = outcomeValue(await call(reader, client.token));
    return { value, statements: [...recorded.statements] };
  };
  const calls = (): [string, (reader: Reader, token: string) => Promise<ReadOutcome<unknown>>][] => [
    ["card", (reader, token) => reader.getEntity(token, { id: people.blake as EntityId })],
    ["context", (reader, token) => reader.context(token, { task: "Prepare for my job interview" } as ContextArgs)],
    [
      "context entity",
      (reader, token) => reader.context(token, { task: "catch up on work", entity: people.blake as EntityId }),
    ],
    ["context no domain", (reader, token) => reader.context(token, { task: "what next" })],
    [
      "find_facts belief",
      (reader, token) => reader.findFacts(token, { belief: fingerprint(store.db.keys, "fact", "i-goal") }),
    ],
  ];
  const observeAll = async (client: Client) => {
    const out: Record<string, { value: unknown; statements: string[] }> = {};
    for (const [name, call] of calls()) out[name] = await observe(call, client);
    return out;
  };

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    messages = await worldMessages(store);
    const { owner, blake } = people;
    const visible: Spec[] = [
      ownerSide("i-goal", "goal", owner, on("own", 1), "career", "canary-inv-goal"),
      ownerSide("i-situation", "situation", owner, on("own", 3), "career", "canary-inv-situation", blake),
      ownerSide("i-health", "goal", owner, on("own", 1), "health", "canary-inv-health"),
      {
        key: "i-commit",
        kind: "commitment",
        subject: owner,
        by: owner,
        message: on("own", 1),
        fields: { counterparty: blake, what: "canary-inv-commit" },
        fieldKinds: { counterparty: "entity", what: "text" },
        values: { counterparty: blake },
      },
      personRole("i-role", blake, on("own", 0), "canary-inv-title"),
      personNeed("i-need", blake, on("own", 3), "career", "canary-inv-need"),
    ];
    seeded = await seedSpecs(store, owner, visible);
    await store.admin.work.addGoal("Rehearse for the job interview.", "own", { requestId: "req-inv6-k3d-own" });
    own = await insertReader(store, "inv6-k3d-own", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "inv6-k3d-wide", WIDE, { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("a card's lines and order, and context's domains, people, work, passages and order, and their statements, do not change with hidden rows", async () => {
    const before = await observeAll(own);
    const wideBefore = await observeAll(wide);
    expect(JSON.stringify(before)).not.toContain(HIDDEN);

    const { owner, blake, wren } = people;
    // The owner's newest beliefs, in career, one said by Wren; Blake's newer role and a need; a
    // commitment with Blake; a goal of the task's words: all of work mail, for the wide audience.
    const hidden: Spec[] = [
      ownerSide("h-goal", "goal", owner, on("employer:example", 8), "career", `${HIDDEN}-goal`),
      ownerSide("h-situation", "situation", owner, on("employer:example", 7), "career", `${HIDDEN}-situation`, wren),
      ownerSide("h-health", "goal", owner, on("employer:example", 8), "health", `${HIDDEN}-health`),
      ownerSide("h-ventures", "goal", owner, on("employer:example", 8), "ventures", `${HIDDEN}-ventures`),
      {
        key: "h-commit",
        kind: "commitment",
        subject: owner,
        by: owner,
        message: on("employer:example", 7),
        fields: { counterparty: blake, what: `${HIDDEN}-commit` },
        fieldKinds: { counterparty: "entity", what: "text" },
        values: { counterparty: blake },
      },
      personRole("h-role", blake, on("employer:example", 8), `${HIDDEN}-title`),
      personNeed("h-need", blake, on("employer:example", 8), "career", `${HIDDEN}-need`),
    ];
    await seedSpecs(store, owner, hidden, seeded);
    await store.admin.work.addGoal(`Prepare the job interview, ${HIDDEN}.`, "employer:example", {
      requestId: "req-inv6-k3d-work",
    });

    const after = await observeAll(own);
    for (const [name] of calls()) {
      expect(after[name]?.value, name).toEqual(before[name]?.value);
      expect(after[name]?.statements, name).toEqual(before[name]?.statements);
    }
    expect(JSON.stringify(after)).not.toContain(HIDDEN);

    // The positive control: a client cleared for both sees what was added.
    const wideAfter = await observeAll(wide);
    expect(JSON.stringify(wideAfter.card?.value)).toContain(`${HIDDEN}-title`);
    expect(JSON.stringify(wideAfter.context?.value)).toContain(`${HIDDEN}-goal`);
    expect(JSON.stringify(wideAfter.context?.value)).not.toEqual(JSON.stringify(wideBefore.context?.value));
  });
});
