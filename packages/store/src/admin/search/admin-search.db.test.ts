import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import type { Query } from "../../core/db.ts";
import { createDb } from "../../core/job-db.ts";
import { testId } from "../../test-support/clients.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { type FactSpec, seedFacts } from "../../test-support/fact-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";
import { Admin } from "../admin.ts";
import { type NameIndexHolder, ownerSearch } from "./admin-search.ts";

// Made-up values only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];

let store: TestStore;
let admin: Admin;
let dir: string;
let blake: EntityId;
let wren: EntityId;
let pat: EntityId;
const holder: NameIndexHolder = { index: null };

// One search on its own transaction, every statement it sends kept.
async function search(term: string): Promise<{ ids: string[]; matches: string[]; sent: string[] }> {
  const db = createDb(store.db.urls.admin, recordingLogger().log);
  const sent: string[] = [];
  try {
    const context: AdminContext = {
      keys: store.db.keys,
      log: recordingLogger().log,
      now: () => WORLD_NOW,
      transaction: (fn) =>
        db.transaction((query) => {
          const counting: Query = (text, values) => {
            sent.push(text);
            return query(text, values);
          };
          return fn(counting);
        }),
    };
    const { hits } = await ownerSearch(context, holder, term);
    return { ids: hits.map((one) => one.who.id), matches: hits.map((one) => one.match), sent };
  } finally {
    await db.close();
  }
}
const rebuilt = (sent: string[]): boolean => sent.some((text) => text.includes("'knowledge.aliases' as at"));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-search-"));
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
  admin = new Admin({
    pool: store.adminPool,
    keys: store.db.keys,
    log: store.log,
    journal: join(dir, "keys.json.erasures"),
  });
  const world = await seedWorld(store.writer, store.admin);
  const owner = world.ownerEntity();
  blake = world.entityOf(WORLD.both.address);
  wren = world.entityOf(WORLD.workOnly.address);
  pat = world.entityOf(WORLD.ownOnly.address);
  const messages = await worldMessages(store);
  const on = (compartment: string): Message => messages.find((one) => one.compartment === compartment) as Message;
  // Beliefs built for the owner's audience, so it is the wider of two.
  const specs: FactSpec[] = [
    {
      key: "s-role",
      type: "role",
      kind: "role",
      subject: blake,
      by: blake,
      message: on("own"),
      fields: { title: "canary-s-title" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [blake],
    },
    {
      key: "s-work-role",
      type: "role",
      kind: "role",
      subject: blake,
      by: blake,
      message: on("employer:example"),
      fields: { title: "canary-s-work" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [blake],
    },
  ];
  await seedFacts(store, owner, specs, [OWN, WIDE]);
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("owner search", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("finds people by name prefix and by address within the owner's audience, never the owner, and builds the index once", async () => {
    const first = await search("blake");
    expect(first.ids).toEqual([blake]);
    expect(first.matches).toEqual(["name"]);
    expect(rebuilt(first.sent)).toBe(true);

    // The same index: no alias is read again.
    const second = await search("Canary-Work");
    expect(second.ids).toContain(wren);
    expect(rebuilt(second.sent)).toBe(false);

    expect((await search("wren.workonly")).matches).toEqual(["address"]);
    expect((await search("owner.personal")).ids).toEqual([]);
    expect((await search("   ")).ids).toEqual([]);
    expect((await search("canary-nobody")).ids).toEqual([]);
  });

  it("an ignore ruling rebuilds it and leaves the person out", async () => {
    expect((await search("pat")).ids).toEqual([pat]);
    await admin.ignores.addIgnore("entity", pat, { requestId: testId("req") });
    const after = await search("pat");
    expect(rebuilt(after.sent)).toBe(true);
    expect(after.ids).toEqual([]);
  });

  it("an erased person leaves the index at the next search (invariant 10)", async () => {
    expect((await search("wren")).ids).toEqual([wren]);
    await admin.erasure.erasePerson(wren, { requestId: testId("req") });
    const after = await search("wren");
    expect(rebuilt(after.sent)).toBe(true);
    expect(after.ids).toEqual([]);
  });
});
