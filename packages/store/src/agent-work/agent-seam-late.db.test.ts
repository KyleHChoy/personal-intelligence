import type { OpenItems, RequestId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { insertReader, type Message, seedCommitments, worldMessages } from "../test-support/commitment-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld } from "../test-support/world.ts";
import { createWork } from "./work.ts";

// A commitment an agent marked handled while it was only due: when it falls late after the mark, that is
// news, and the signal comes back. Synthetic rows only.

const DAY = 86_400_000;
const VIEWS = ["self", "people", "work"];
const TOOLS = ["get_self", "get_open_items", "get_changes", "write_back", "list_opportunities"];

let store: TestStore;
let owner: string;

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example"] });
  const world = await seedWorld(store.writer, store.admin);
  owner = world.ownerEntity();
}, 300_000);

afterAll(async () => {
  await store?.close();
}, 60_000);

describe("a handled commitment that falls late", { timeout: DB_TEST_TIMEOUT }, () => {
  it("clears while due, and is a signal again once late", async () => {
    const client = await insertReader(store, "marker", ["own"], { tools: TOOLS, views: VIEWS });
    const messages = await worldMessages(store);
    const message = messages.find((one: Message) => one.compartment === "own") as Message;
    const due = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    await seedCommitments(
      store,
      owner,
      [
        {
          key: "owed-the-report",
          subject: owner,
          counterparty: owner,
          due,
          claims: [{ message, what: "Send the report", at: new Date().toISOString() }],
        },
      ],
      [["own"]],
    );
    const items = async (reader: Reader): Promise<OpenItems["items"]> => {
      const open = await reader.getOpenItems(client.token, {});
      if (!open.ok) throw new Error(open.code);
      return open.value.items;
    };
    const next = async (reader: Reader) => {
      const self = await reader.getSelf(client.token);
      if (!self.ok) throw new Error(self.code);
      return self.value.next?.moves ?? [];
    };
    const [item] = await items(store.reader);
    expect(item?.due).toBe(due);
    expect((await next(store.reader)).some((move) => move.kind === "due_soon")).toBe(true);

    const work = createWork({ reader: store.reader, log: store.log });
    const wrote = await work.writeBack(client.token, {
      source: { kind: "commitment", id: item?.source.id as never },
      state: "handled",
      requestId: testId("req") as RequestId,
    });
    expect(wrote.ok).toBe(true);
    expect((await next(store.reader)).some((move) => move.source.id === item?.source.id)).toBe(false);

    const later = new Reader({
      pool: store.readerPool,
      keys: store.db.keys,
      log: store.log,
      now: () => new Date(Date.now() + 4 * DAY),
    });
    const moves = await next(later);
    expect(moves.find((move) => move.source.id === item?.source.id)?.kind).toBe("overdue");
  });
});
