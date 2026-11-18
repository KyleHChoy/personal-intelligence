import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReader } from "../test-support/commitment-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";
import { tallied } from "./db.ts";

// What `pi http`'s `tool_work` line rests on: the statements a real read sends, counted per call,
// through the driver and the reader's transaction.

describe("the statement tally", { timeout: DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let token: string;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    await seedWorld(store.writer, store.admin);
    token = (await insertReader(store, "tally", ["own"], { tools: ["get_self"], views: ["self", "people", "work"] }))
      .token;
  }, DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  it("counts one call's statements, and two calls at once apart", async () => {
    // The first call opens the client's session, one statement more.
    expect((await store.reader.getSelf(token)).ok).toBe(true);
    const one = await tallied(() => store.reader.getSelf(token));
    expect(one.value.ok).toBe(true);
    expect(one.tally.statements).toBeGreaterThan(5);
    expect(one.tally.sqlMs).toBeGreaterThan(0);
    const [left, right] = await Promise.all([
      tallied(() => store.reader.getSelf(token)),
      tallied(() => store.reader.getSelf(token)),
    ]);
    expect(left.tally.statements).toBe(one.tally.statements);
    expect(right.tally.statements).toBe(one.tally.statements);
  });
});
