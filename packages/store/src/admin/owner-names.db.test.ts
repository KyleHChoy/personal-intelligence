import type { CardId, EntityId, FactId, NewCard } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { commitFacts } from "../test-support/fact-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Names, not ids: the owner's words for the ids an agent wrote, in one batch, and a question about
// someone with no name the owner can see held out of the waiting list and its count. Made-up values
// only.

let store: TestStore;
let pat: string;
let entityOf: (address: string) => string;
let wren: string;
let message: Message;
let claim: string;
let workClaim: string;
let owner: string;
let work: Message;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW });
  const world = await seedWorld(store.writer, store.admin);
  entityOf = world.entityOf;
  pat = world.entityOf(WORLD.ownOnly.address);
  wren = world.entityOf(WORLD.workOnly.address);
  // The owner's audience is every compartment of a claim of a belief type, here `own` alone: Wren's
  // fact, from work mail, is a plan, which builds no belief, so Wren, seen only in work mail, is
  // outside it.
  message = (await worldMessages(store)).find((one) => one.compartment === "own") as Message;
  work = (await worldMessages(store)).find((one) => one.compartment !== "own") as Message;
  owner = world.ownerEntity();
  await commitFacts(store, owner, [
    {
      key: "n-role",
      type: "role",
      kind: "role",
      subject: pat,
      by: pat,
      message,
      fields: { title: "canary-n-title" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [pat],
    },
    {
      key: "n-work",
      type: "plan",
      subject: wren,
      by: wren,
      message: work,
      fields: { title: "canary-work-title" },
      fieldKinds: { title: "text" },
      values: {},
      entities: [wren],
    },
  ]);
  const rows = await queryAs<{ id: string; compartments: string[] }>(
    store.db.urls.admin,
    "select id, compartments from knowledge.claims where type in ('role', 'plan') order by id",
  );
  claim = rows.find((row) => row.compartments.join() === "own")?.id ?? "";
  workClaim = rows.find((row) => row.compartments.join() !== "own")?.id ?? "";
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

const notice = (target: EntityId): NewCard => ({
  id: testId("crd") as CardId,
  requestId: testId("req"),
  kind: "notice",
  author: "system:test",
  options: ["acknowledge"],
  target: { kind: "entity", id: target },
  refs: [],
  compartments: ["own"],
  expiresAt: null,
  expiresAfterDays: null,
  caseKey: null,
  run: null,
  body: null,
  bodyFrom: null,
});

describe("R-ids in the owner's words", { timeout: DB_TEST_TIMEOUT }, () => {
  it("names a person, a message and a fact the owner can see, and says one outside their audience or unknown in the same neutral words", async () => {
    const missing = testId("ent");
    const record = testId("rec");
    const named = await store.admin.names.words([pat, wren, missing, message.id, claim, record, workClaim]);
    expect(named.get(pat)).toEqual({ words: WORLD.ownOnly.name, open: { kind: "person", id: pat } });
    expect(named.get(message.id)?.open).toEqual({ kind: "message", id: message.id });
    expect(Object.values(WORLD.ownSubjects)).toContain(named.get(message.id)?.words);
    expect(named.get(claim)).toEqual({ words: "canary-n-title", open: { kind: "fact", id: claim } });
    // Outside the owner's audience, and no one at all: the same words, the same shape, nothing to open.
    expect(named.get(wren)).toEqual({ words: "someone", open: null });
    expect(named.get(missing)).toEqual(named.get(wren));
    expect(named.get(record)).toEqual({ words: "a record", open: null });
    // A fact outside the owner's audience, though the key file opens it: neutral words, nothing to open.
    expect(workClaim).not.toBe("");
    expect(named.get(workClaim)).toEqual({ words: "a fact", open: null });
    expect(JSON.stringify([...named.values()])).not.toContain("canary-work");
    // Nothing of Wren's name or address reaches the owner.
    expect(JSON.stringify([...named.values()])).not.toMatch(/Wren|wren\./);
  });

  it("holds a question about someone with no name the owner can see out of the waiting list and its count, and counts it there", async () => {
    const shown = notice(pat as EntityId);
    const held = notice(wren as EntityId);
    // An agent's claim about Wren asks about Wren too.
    const claimed: NewCard = { ...notice(wren as EntityId), target: { kind: "claim", id: workClaim as never } };
    await store.admin.cards.raiseCard(shown);
    await store.admin.cards.raiseCard(held);
    await store.admin.cards.raiseCard(claimed);
    const listed = await store.admin.cards.withLines({});
    expect(listed.cards.map((card) => card.id)).toContain(shown.id);
    expect(listed.cards.map((card) => card.id)).not.toContain(held.id);
    expect(listed.cards.map((card) => card.id)).not.toContain(claimed.id);
    const status = await store.admin.work.status();
    expect(status.cards.waitingForNames).toBe(2);
    expect(status.cards.pending).toBe(listed.cards.length);
    // It still waits: the terminal's list keeps it, and a name releases it.
    expect((await store.admin.cards.listPending({})).map((card) => card.id)).toContain(held.id);
  });

  // A card about someone with no name is held, and a name admits it.
  it("holds ten cards for a name, and admits every one once the person is named", async () => {
    const author = "system:captest";
    const blake = entityOf(WORLD.both.address);
    const about = (entity: string): NewCard => ({ ...notice(entity as EntityId), author });
    const stateOf = async (ids: readonly string[]): Promise<Record<string, string>> =>
      Object.fromEntries(
        (
          await queryAs<{ id: string; state: string }>(
            store.db.urls.admin,
            "select c.id, (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state from ledger.cards c where c.id = any ($1::text[])",
            [[...ids]],
          )
        ).map((row) => [row.id, row.state]),
      );
    const pendingOf = async (): Promise<number> =>
      (
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.cards c where c.created_by = $1 and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) = 'pending'",
          [author],
        )
      )[0]?.n ?? -1;

    // The owner's Remove of Pat leaves Pat with no name the owner can see.
    const ruling = await store.admin.ignores.addIgnore("entity", pat, { requestId: testId("req") });
    const held = Array.from({ length: 10 }, () => about(pat));
    for (const card of held) await store.admin.cards.raiseCard(card);
    expect(await pendingOf()).toBe(10);
    expect((await store.admin.cards.sweepNameHolds()).held).toBeGreaterThanOrEqual(10);
    expect(new Set(Object.values(await stateOf(held.map((card) => card.id))))).toEqual(new Set(["deferred"]));
    expect(await pendingOf()).toBe(0);

    // The eleventh, about someone named, waits for the owner at once, and eight more.
    const named = about(blake);
    expect((await store.admin.cards.raiseCard(named)).state).toBe("pending");
    for (let n = 0; n < 8; n += 1) expect((await store.admin.cards.raiseCard(about(blake))).state).toBe("pending");
    expect(await pendingOf()).toBe(9);

    // Pat named again: every hold is released, and every card admitted.
    await store.admin.ignores.liftIgnore(ruling, { requestId: testId("req") });
    expect((await store.admin.cards.sweepNameHolds()).released).toBeGreaterThanOrEqual(10);
    expect(await pendingOf()).toBe(19);
    const states = await stateOf(held.map((card) => card.id));
    expect(Object.values(states).filter((one) => one === "pending")).toHaveLength(10);
    expect(
      await queryAs(
        store.db.urls.admin,
        "select 1 from ledger.card_name_holds h join ledger.cards c on c.id = h.card_id where c.created_by = $1",
        [author],
      ),
    ).toEqual([]);
  });
});

// Last, since a work claim of a belief type widens it for the store.
describe("the owner's audience, by the claims a ruling leaves", { timeout: DB_TEST_TIMEOUT }, () => {
  let workRole: string;
  const wrenNamed = async () => (await store.admin.names.words([wren])).get(wren);

  it("a work claim of a belief type brings a work-only person into the owner's names", async () => {
    expect(await wrenNamed()).toEqual({ words: "someone", open: null });
    await commitFacts(store, owner, [
      {
        key: "n-work-role",
        type: "role",
        kind: "role",
        subject: wren,
        by: wren,
        message: work,
        fields: { title: "canary-work-role" },
        fieldKinds: { title: "text" },
        values: {},
        entities: [wren],
      },
    ]);
    const [row] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.claims where type = 'role' and compartments = $1::text[]",
      [[work.compartment]],
    );
    workRole = row?.id ?? "";
    expect(workRole).not.toBe("");
    expect(await wrenNamed()).toEqual({ words: WORLD.workOnly.name, open: { kind: "person", id: wren } });
  });

  it("a vetoed one still does, so the veto keeps the label it counts under; a rejected one does not", async () => {
    const veto = await store.admin.facts.vetoFact(workRole as FactId, { requestId: testId("req") });
    expect(await wrenNamed()).toEqual({ words: WORLD.workOnly.name, open: { kind: "person", id: wren } });
    expect(await store.admin.facts.liftRuling(veto, { requestId: testId("req") })).toBe(true);
    expect(await wrenNamed()).toEqual({ words: WORLD.workOnly.name, open: { kind: "person", id: wren } });
    await store.admin.facts.rejectClaim(workRole as FactId, { requestId: testId("req"), learn: false });
    expect(await wrenNamed()).toEqual({ words: "someone", open: null });
  });
});
