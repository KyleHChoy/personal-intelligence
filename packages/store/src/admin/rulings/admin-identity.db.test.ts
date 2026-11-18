import type { CardId, EntityId, NewCard, RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { insertSecret, testId } from "../../test-support/clients.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../../test-support/identity-fixtures.ts";
import { snapshot } from "../../test-support/snapshot.ts";
import { createAdmin } from "../admin.ts";
import { googleSecretName } from "../admin-base.ts";

// The owner's rulings, with a suppressed address and a shared mark among them. Each refusal has its
// positive control.

const TIMEOUT = 180_000;
const A = "ava@identity-admin.test";
const B = "ava.second@identity-admin.example";
const C = "cy@identity-admin.test";
const D = "dee@identity-admin.test";

// Four people, each on a contact of their own, and A and B on one contact too.
async function people(world: IdentityWorld): Promise<Record<"a" | "b" | "c" | "d", EntityId>> {
  const { personalContacts } = world.accounts;
  await world.save(personalContacts, "ab", { names: ["Ava Example"], emails: [A, B] });
  await world.save(personalContacts, "c", { names: ["Cy Example"], emails: [C] });
  await world.save(personalContacts, "d", { names: ["Dee Example"], emails: [D] });
  return { a: await world.person(A), b: await world.person(B), c: await world.person(C), d: await world.person(D) };
}

const sameCard = (a: EntityId, b: EntityId, caseKey: string): NewCard =>
  ({
    id: testId("crd") as CardId,
    requestId: req(),
    kind: "same_person",
    author: "system:identity",
    options: ["same", "different"],
    target: null,
    refs: [
      { kind: "entity", id: a },
      { kind: "entity", id: b },
    ],
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey,
    run: null,
    body: null,
    bodyFrom: null,
  }) as NewCard;

const stateOf = async (world: IdentityWorld, card: string): Promise<string | undefined> =>
  (
    await world.sql<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [card],
    )
  )[0]?.event;

describe("the owner's rulings", { timeout: TIMEOUT }, () => {
  it("a ruling is written with its decision, and a repeated request id writes one", () =>
    inIdentityWorld(async (world) => {
      const { a, b } = await people(world);
      const requestId = req();
      const ruling = await world.admin.identity.linkPeople(a, b, "same", { requestId });
      expect(await world.admin.identity.linkPeople(a, b, "same", { requestId })).toBe(ruling);
      expect(await world.count("knowledge.identity_rulings")).toBe(1);
      expect(await world.count("knowledge.owner_decisions", "id = $1 and kind = 'identity'", [ruling])).toBe(1);
    }));

  it("a same ruling changes no row but its own and the withdrawals", () =>
    inIdentityWorld(async (world) => {
      const { a, b } = await people(world);
      const before = await snapshot(world.db);
      await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      const after = await snapshot(world.db);
      const changed = [...after]
        .filter(([key, xmin]) => before.get(key) !== xmin)
        .map(([key]) => key.split(" ")[0] ?? key);
      expect([...new Set(changed)].sort()).toEqual(["knowledge.identity_rulings", "knowledge.owner_decisions"]);
    }));

  it("a lifted ruling leaves both people as they were, and lifting twice writes one row", () =>
    inIdentityWorld(async (world) => {
      const { a, b } = await people(world);
      const ruling = await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      const requestId = req();
      expect(await world.admin.identity.liftIdentity(ruling, { requestId })).toBe(true);
      expect(await world.admin.identity.liftIdentity(ruling, { requestId })).toBe(true);
      expect(await world.admin.identity.liftIdentity(ruling, { requestId: req() })).toBe(false);
      expect(await world.count("knowledge.owner_decisions", "kind = 'identity_lift'")).toBe(1);
      expect([await world.person(A), await world.person(B)]).toEqual([a, b]);
      expect(
        await world.admin.identity.liftIdentity("rul_01JABCDEFGHJKMNPQRSTVWXYZ0" as RulingId, { requestId: req() }),
      ).toBe(false);
    }));

  it("same on a joined pair writes nothing and answers already_settled with the joining ruling, and one lift then splits them", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c } = await people(world);
      const ab = await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      const bc = await world.admin.identity.linkPeople(b, c, "same", { requestId: req() });
      await expect(world.admin.identity.linkPeople(a, c, "same", { requestId: req() })).rejects.toMatchObject({
        code: "already_settled",
        rulings: [ab, bc].sort(),
      });
      expect(await world.count("knowledge.identity_rulings")).toBe(2);
      await world.admin.identity.liftIdentity(bc, { requestId: req() });
      expect(await world.admin.identity.linkPeople(a, c, "same", { requestId: req() })).toMatch(/^rul_/);
    }));

  it("a same across a different is refused, through a third person too; a different inside a group is refused", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c, d } = await people(world);
      await world.admin.identity.linkPeople(a, c, "different", { requestId: req() });
      await world.admin.identity.linkPeople(b, c, "same", { requestId: req() });
      await expect(world.admin.identity.linkPeople(a, b, "same", { requestId: req() })).rejects.toMatchObject({
        code: "conflicting_ruling",
      });
      await expect(world.admin.identity.linkPeople(b, c, "different", { requestId: req() })).rejects.toMatchObject({
        code: "conflicting_ruling",
      });
      expect(await world.count("knowledge.identity_rulings")).toBe(2);
      // The positive control.
      expect(await world.admin.identity.linkPeople(a, d, "same", { requestId: req() })).toMatch(/^rul_/);
    }));

  it("of same(A,B) and same(B,C) against different(A,C), started on two connections, exactly one commits", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c } = await people(world);
      await world.admin.identity.linkPeople(a, c, "different", { requestId: req() });
      const other = createAdmin({
        url: world.db.urls.admin,
        keys: world.db.keys,
        log: world.store.log,
        journal: world.journal,
      });
      try {
        const results = await Promise.allSettled([
          world.admin.identity.linkPeople(a, b, "same", { requestId: req() }),
          other.identity.linkPeople(b, c, "same", { requestId: req() }),
        ]);
        expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
        const refused = results.find((one) => one.status === "rejected");
        expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "conflicting_ruling" });
      } finally {
        await other.close();
      }
    }));

  it("pi identity link withdraws the open card for that pair in its transaction, and admits the next", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c, d } = await people(world);
      const card = await world.admin.cards.raiseCard(sameCard(a, b, "same:test-ab"));
      const open = await world.admin.cards.raiseCard(sameCard(c, d, "same:test-cd"));
      await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      expect(await stateOf(world, card.id)).toBe("withdrawn");
      expect(await stateOf(world, open.id)).toBe("pending");
    }));

  it("a same answer on a card, lifted, puts the card back for the owner to answer again", () =>
    inIdentityWorld(async (world) => {
      const { c, d } = await people(world);
      const card = await world.admin.cards.raiseCard(sameCard(c, d, "same:test-cd-lift"));
      const [decided] = await world.admin.cards.decide({ cards: [card.id], answer: "same", requestId: req() });
      expect(await stateOf(world, card.id)).toBe("decided");
      expect(await world.admin.identity.liftIdentity(decided?.ruling as RulingId, { requestId: req() })).toBe(true);
      expect(await stateOf(world, card.id)).toBe("pending");
      // The owner answers it anew.
      await world.admin.cards.decide({ cards: [card.id], answer: "different", requestId: req() });
      expect(await stateOf(world, card.id)).toBe("decided");
    }));

  it("markShared withdraws every open same_person card of the address in its transaction", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c } = await people(world);
      const one = await world.admin.cards.raiseCard(sameCard(a, b, "same:test-ab"));
      const two = await world.admin.cards.raiseCard(sameCard(a, c, "same:test-ac"));
      await world.admin.identity.markShared(a, { requestId: req() });
      expect([await stateOf(world, one.id), await stateOf(world, two.id)]).toEqual(["withdrawn", "withdrawn"]);
    }));

  it("a ruling on a person whose address is in knowledge.suppressions is not_a_person and writes nothing", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c } = await people(world);
      const ruling = testId("rul");
      await world.sql(
        `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')`,
        [ruling, req()],
      );
      const erasure = testId("ers");
      await world.sql(
        `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', 1, now(), 0, 1, 0, '{own}')`,
        [erasure, ruling],
      );
      await world.sql(
        `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, now(), '{own}')`,
        [testId("sup"), erasure, world.fp(A)],
      );
      await expect(world.admin.identity.linkPeople(a, b, "same", { requestId: req() })).rejects.toMatchObject({
        code: "not_a_person",
      });
      expect(await world.count("knowledge.identity_rulings")).toBe(0);
      expect(await world.admin.identity.linkPeople(b, c, "same", { requestId: req() })).toMatch(/^rul_/);
    }));

  it("a ruling on the owner, or an organization, is not_a_person; an id that does not exist is not_found", () =>
    inIdentityWorld(async (world) => {
      const { a } = await people(world);
      const owner = (await world.sql<{ id: EntityId }>("select id from knowledge.entities where kind = 'owner'"))[0]
        ?.id as EntityId;
      await expect(world.admin.identity.linkPeople(a, owner, "same", { requestId: req() })).rejects.toMatchObject({
        code: "not_a_person",
      });
      await expect(
        world.admin.identity.linkPeople(a, "ent_00000000000000000000000000" as EntityId, "same", { requestId: req() }),
      ).rejects.toMatchObject({ code: "not_found" });
    }));

  it("a shared address is refused a same ruling, and marking is refused while a same names it", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c, d } = await people(world);
      await world.admin.identity.markShared(a, { requestId: req() });
      await expect(world.admin.identity.linkPeople(a, b, "same", { requestId: req() })).rejects.toMatchObject({
        code: "shared_address",
      });
      await world.admin.identity.linkPeople(c, d, "same", { requestId: req() });
      await expect(world.admin.identity.markShared(c, { requestId: req() })).rejects.toMatchObject({
        code: "conflicting_ruling",
      });
      expect(await world.admin.identity.markShared(b, { requestId: req() })).toMatch(/^rul_/);
    }));

  it("a contact that lists an assistant's address makes two people, and after a different ruling each keeps its own", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "boss", {
        names: ["Jonah Pike"],
        emails: ["jonah@identity-admin.test", "lena@identity-admin.test"],
      });
      const [jonah, lena] = [
        await world.person("jonah@identity-admin.test"),
        await world.person("lena@identity-admin.test"),
      ];
      expect(jonah).not.toBe(lena);
      await world.admin.identity.linkPeople(jonah, lena, "different", { requestId: req() });
      expect([await world.person("jonah@identity-admin.test"), await world.person("lena@identity-admin.test")]).toEqual(
        [jonah, lena],
      );
    }));

  it("contacts are removed only once the label's contacts token is gone, and every ruling stays", () =>
    inIdentityWorld(async (world) => {
      const { a, b } = await people(world);
      await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      await insertSecret(world.db, googleSecretName("personal", "contacts_refresh_token"), "fake-contacts-token");
      await expect(world.admin.identity.removeContacts("personal", { requestId: req() })).rejects.toMatchObject({
        code: "contacts_connected",
      });
      expect(await world.count("knowledge.contacts")).toBe(3);
      await world.sql("delete from policy.secrets where name = $1", [
        googleSecretName("personal", "contacts_refresh_token"),
      ]);
      expect(await world.admin.identity.removeContacts("personal", { requestId: req() })).toEqual({ items: 3 });
      expect(await world.count("knowledge.contacts")).toBe(0);
      expect(await world.count("knowledge.identity_rulings")).toBe(1);
      expect(await world.count("knowledge.suppressions")).toBe(0);
      expect(await world.count("knowledge.removed_evidence")).toBe(0);
    }));

  it("markShared withdraws the address's open shared_address card, and a one_person answer after a shared mark is refused", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      await world.save(contacts, "x1", { names: ["Odile Brandt"], emails: ["family@identity-admin.test"] });
      await world.save(contacts, "x2", { names: ["Paul Brandt"], emails: ["family@identity-admin.test"] });
      await world.admin.identity.proposeIdentity({ now: new Date("2026-09-15T12:00:00Z") });
      const [card] = await world.sql<{ id: string }>("select id from ledger.cards where kind = 'shared_address'");
      const family = await world.person("family@identity-admin.test");
      const shared = await world.admin.identity.markShared(family, { requestId: req() });
      expect(await stateOf(world, card?.id ?? "")).toBe("withdrawn");
      await expect(world.admin.identity.markShared(family, { requestId: req() })).rejects.toMatchObject({
        code: "already_settled",
        rulings: [shared],
      });
      expect(await world.count("knowledge.identity_rulings", "verdict in ('shared', 'single')")).toBe(1);
    }));

  it("removeContacts clears the contacts account's cursor, so a reconnect lists from the start", () =>
    inIdentityWorld(async (world) => {
      await people(world);
      await world.sql("update vault.source_accounts set cursor_enc = '{}'::jsonb where id = $1", [
        world.accounts.personalContacts.id,
      ]);
      await world.admin.identity.removeContacts("personal", { requestId: req() });
      expect(
        await world.count("vault.source_accounts", "id = $1 and cursor_enc is null", [
          world.accounts.personalContacts.id,
        ]),
      ).toBe(1);
    }));

  it("listIdentity names the people that hold each address now, or null", () =>
    inIdentityWorld(async (world) => {
      const { a, b, c } = await people(world);
      const same = await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      const shared = await world.admin.identity.markShared(c, { requestId: req() });
      const listed = await world.admin.identity.listIdentity();
      expect(listed.map((one) => [one.id, one.verdict, [one.a, one.b].sort(), one.liftedAt])).toEqual([
        [same, "same", [a, b].sort(), null],
        [shared, "shared", [c, null].sort(), null],
      ]);
    }));
});
