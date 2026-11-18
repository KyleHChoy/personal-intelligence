import { CANARY_COMPARTMENT, type CardDetail, type CardId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { type Message, worldMessages } from "../../test-support/commitment-fixtures.ts";
import { session } from "../../test-support/connections.ts";
import { fingerprint, queryAs, sealRow } from "../../test-support/database.ts";
import { type FactSpec, seedFacts } from "../../test-support/fact-fixtures.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { warmthWorld } from "../../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD_NOW } from "../../test-support/world.ts";
import { Admin } from "../admin.ts";

// The tier proposer. Seven people of one
// organization by their affiliations: three the owner moves to close, two the owner has not ruled on
// (one whose affiliation came from the owner's work mail), one the owner ruled on before, and one whose
// affiliation and address are in a compartment outside the owner's audience. Beliefs are built for that audience
// alone, own and employer:example. Reserved domains and made-up ids only.

const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const LATER = new Date(WORLD_NOW.getTime() + 3_600_000);

let store: TestStore;
let organization: string;
const moved: string[] = [];
let ownProposed: string;
let workProposed: string;
let ruledBefore: string;
let hidden: string;
const addresses = new Map<string, string>();

const req = (): { requestId: string } => ({ requestId: testId("req").slice(4) });

// A person with one account of their own address under the label.
async function personOf(label: string[]): Promise<string> {
  const address = `tier-proposal-${testId("x").slice(-8).toLowerCase()}@example.test`;
  const entity = await session(store.db.urls.admin, async (query) => {
    const made = await seeder(store.db, query).entity("person");
    const id = testId("adr");
    await query(
      "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc) values ($1, $2, 'email', $3, $4, $5, $6)",
      [
        id,
        made,
        fingerprint(store.db.keys, "address", address),
        fingerprint(store.db.keys, "domain", "example.test"),
        label,
        sealRow(store.db.keys, label[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, address),
      ],
    );
    return made;
  });
  addresses.set(entity, address);
  return entity;
}

const proposals = async (): Promise<{ id: CardId; state: string; compartments: string[] }[]> =>
  queryAs(
    store.db.urls.admin,
    `select c.id, (select e.event from ledger.record_events e where e.row_kind = 'card' and e.row_id = c.id order by e.id desc limit 1) as state, c.compartments
     from ledger.cards c where c.kind = 'tier_proposal' order by c.created_at, c.id`,
  );

const texts = (card: CardDetail | null): string[] => (card?.lines ?? []).map((line) => line.text);

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", CANARY_COMPARTMENT] });
  const world = await seedWorld(store.writer, store.admin);
  const owner = world.ownerEntity();
  organization = await session(store.db.urls.admin, (query) => seeder(store.db, query).entity("organization"));
  for (let n = 0; n < 3; n += 1) moved.push(await personOf(OWN));
  ownProposed = await personOf(OWN);
  workProposed = await personOf(OWN);
  ruledBefore = await personOf(OWN);
  hidden = await personOf([CANARY_COMPARTMENT]);
  // A message in the compartment outside the owner's audience (the standing check's, which the
  // owner's audience leaves out by code), for the hidden person's affiliation.
  await warmthWorld(store.db).mail([CANARY_COMPARTMENT], { at: WORLD_NOW.toISOString(), from: hidden });

  const messages = await worldMessages(store);
  const of = (compartment: string): Message => messages.find((one) => one.compartment === compartment) as Message;
  const affiliation = (person: string, message: Message): FactSpec => ({
    key: `aff-${person}`,
    type: "affiliation",
    kind: "affiliation",
    subject: person,
    by: person,
    message,
    fields: { organization },
    fieldKinds: {},
    values: { organization },
    entities: [person, organization],
  });
  await seedFacts(
    store,
    owner,
    [
      ...[...moved, ownProposed, ruledBefore].map((person) => affiliation(person, of("own"))),
      affiliation(workProposed, of("employer:example")),
      affiliation(hidden, of(CANARY_COMPARTMENT)),
    ],
    [BOTH],
  );
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("the tier proposer", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("three close moves of one organization's people raise one card naming the other two, under the union of what it read", async () => {
    await store.admin.tiers.setTier(ruledBefore, "regular", req());
    await store.admin.tiers.setTier(moved[0] as string, "close", req());
    await store.admin.tiers.setTier(moved[1] as string, "close", req());
    expect(await proposals()).toEqual([]);
    await store.admin.tiers.setTier(moved[2] as string, "close", req());
    const [card, ...more] = await proposals();
    expect(more).toEqual([]);
    // The owner's own mail's and work mail's beliefs: the union of what it read (invariant 4).
    expect(card).toEqual({ id: expect.any(String), state: "pending", compartments: BOTH });
    const lines = texts(await store.admin.cards.card(card?.id as CardId));
    expect(lines).toEqual(
      expect.arrayContaining([
        "trait: they are affiliated with",
        "tier: close",
        "already close, set by you in the last 30 days:",
        "proposed for close, not yet ruled on by you:",
      ]),
    );
    for (const person of [...moved, ownProposed, workProposed]) expect(lines).toContain(addresses.get(person));
    // Nobody the owner ruled on is proposed; nobody outside the owner's audience is named.
    expect(lines).not.toContain(addresses.get(ruledBefore));
    expect(lines.join("\n")).not.toContain(addresses.get(hidden) as string);
    expect(lines.join("\n")).not.toContain(hidden);
    const proposed = lines.slice(lines.indexOf("proposed for close, not yet ruled on by you:") + 1, -1);
    expect(proposed.sort()).toEqual([addresses.get(ownProposed), addresses.get(workProposed)].sort());
    // Another pass while it is open raises no second card.
    await store.admin.tiers.setTier(ruledBefore, "known", req());
    expect(await proposals()).toHaveLength(1);
  });

  it("rejecting stops it until a new move of the owner's shares the trait", async () => {
    const [card] = await proposals();
    await store.admin.cards.decide({ cards: [card?.id as CardId], answer: "reject", requestId: req().requestId });
    // A pass with no newer move of the organization's people raises nothing.
    await store.admin.tiers.setTier(ruledBefore, "outer", req());
    expect((await proposals()).map((one) => one.state)).toEqual(["decided"]);
    // An hour later the owner moves one of them away and back: a new move, so the pair is proposed again.
    const later = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, now: () => LATER });
    await later.tiers.setTier(moved[0] as string, "inner", req());
    expect(await proposals()).toHaveLength(1);
    await later.tiers.setTier(moved[0] as string, "close", req());
    expect((await proposals()).map((one) => one.state)).toEqual(["decided", "pending"]);
  });

  it("confirming tiers each proposed person, one decision each, and nobody is proposed again", async () => {
    const before = await queryAs<{ n: number }>(
      store.db.urls.admin,
      "select count(*)::int as n from knowledge.owner_decisions where kind = 'warmth_tier'",
    );
    const card = (await proposals())[1];
    await store.admin.cards.decide({ cards: [card?.id as CardId], answer: "confirm", requestId: req().requestId });
    const tiers = await store.admin.tiers.listTiers();
    for (const person of [ownProposed, workProposed])
      expect(tiers.find((one) => one.people.includes(person as never))?.tier).toBe("close");
    const after = await queryAs<{ n: number }>(
      store.db.urls.admin,
      "select count(*)::int as n from knowledge.owner_decisions where kind = 'warmth_tier'",
    );
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(2);
    expect(tiers.some((one) => one.people.includes(hidden as never))).toBe(false);
    await store.admin.tiers.setTier(ruledBefore, "close", req());
    expect((await proposals()).map((one) => one.state)).toEqual(["decided", "decided"]);
  });
});
