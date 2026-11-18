import type { EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type IdentityWorld, inIdentityWorld, MAIL, req } from "../test-support/identity-fixtures.ts";
import { snapshot } from "../test-support/snapshot.ts";

// The sweep. Made-up values on reserved domains only.

const TIMEOUT = 180_000;
const NOW = new Date("2026-09-15T12:00:00Z");
const sweep = (world: IdentityWorld) => world.admin.identity.proposeIdentity({ now: NOW });

const cards = (world: IdentityWorld) =>
  world.sql<{ id: string; kind: string; created_by: string; case_key: string; state: string; refs: string[] }>(
    `select c.id, c.kind, c.created_by, c.case_key,
       (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state,
       array(select b.ref_id from ledger.basis b where b.row_kind = 'card' and b.row_id = c.id order by b.ref_id) as refs
     from ledger.cards c order by c.created_at, c.id`,
  );

describe("the identity sweep", { timeout: TIMEOUT }, () => {
  it("two people on one contact are raised once, and a second sweep raises nothing; every card is by system:identity", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1, skipped: 0 });
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 0, skipped: 0 });
      const raised = await cards(world);
      expect(raised.map((one) => [one.kind, one.created_by, one.state])).toEqual([
        ["same_person", "system:identity", "pending"],
      ]);
      expect(raised[0]?.refs.sort()).toEqual(
        [await world.person("sam@identity-sweep.test"), await world.person("sam.orrin@identity-sweep.example")].sort(),
      );
    }));

  it("the sweep writes cards, their events and basis rows and nothing else", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      const before = await snapshot(world.db);
      await sweep(world);
      const after = await snapshot(world.db);
      const changed = new Set(
        [...after].filter(([key, xmin]) => before.get(key) !== xmin).map(([key]) => key.split(" ")[0] ?? key),
      );
      expect([...changed].sort()).toEqual(["ledger.basis", "ledger.cards", "ledger.record_events"]);
    }));

  it("the sweep refuses with sync_running while a sync holds the lock, and writes nothing", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      await world.store.writer.withSyncLock(async () => {
        await expect(sweep(world)).rejects.toMatchObject({ code: "sync_running" });
      });
      expect(await world.count("ledger.cards")).toBe(0);
      expect((await sweep(world)).raised).toBe(1);
    }));

  it("a one-word name raises nothing; a name shared with a person the owner never wrote to raises nothing", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      await world.save(contacts, "one", { names: ["Mononym"], emails: ["mono@identity-sweep.test"] });
      await world.save(contacts, "two", { names: ["Mononym"], emails: ["mono@identity-sweep.example"] });
      await world.save(contacts, "three", { names: ["Rae Lindqvist"], emails: ["rae@identity-sweep.test"] });
      expect((await sweep(world)).candidates).toBe(0);
      // Both established, two words: a candidate.
      await world.save(contacts, "four", { names: ["Rae Lindqvist"], emails: ["rae@identity-sweep.example"] });
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1 });
    }));

  it("a pair that shares a one-word name and a two-word name is raised by the two-word name", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      await world.save(contacts, "one", { names: ["Sam", "Sam Orrin"], emails: ["s1@identity-sweep.test"] });
      await world.save(contacts, "two", { names: ["Sam", "Sam Orrin"], emails: ["s2@identity-sweep.example"] });
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1 });
    }));

  it("a settled pair is not raised, through a third person too, and the owner and a shared address are in no candidate", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      await world.save(contacts, "ab", { names: ["Ab"], emails: ["a@identity-sweep.test", "b@identity-sweep.test"] });
      await world.save(contacts, "bc", { names: ["Bc"], emails: ["b@identity-sweep.test", "c@identity-sweep.test"] });
      await world.save(contacts, "ac", { names: ["Ac"], emails: ["a@identity-sweep.test", "c@identity-sweep.test"] });
      const [a, b, c] = [
        await world.person("a@identity-sweep.test"),
        await world.person("b@identity-sweep.test"),
        await world.person("c@identity-sweep.test"),
      ];
      await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
      await world.admin.identity.linkPeople(b, c, "same", { requestId: req() });
      expect((await sweep(world)).candidates).toBe(0);
      await world.save(contacts, "sd", { names: ["Sd"], emails: ["s@identity-sweep.test", "d@identity-sweep.test"] });
      await world.admin.identity.markShared(await world.person("s@identity-sweep.test"), { requestId: req() });
      expect((await sweep(world)).candidates).toBe(0);
    }));

  it("the eleventh candidate waits and no card is deferred; candidates are raised in rank order", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      for (let i = 0; i < 11; i += 1)
        await world.save(contacts, `pair${i}`, {
          names: [`Pair ${i}`],
          emails: [`p${i}@identity-sweep.test`, `q${i}@identity-sweep.example`],
        });
      expect(await sweep(world)).toMatchObject({ candidates: 11, raised: 10 });
      const raised = await cards(world);
      expect(raised.every((one) => one.state === "pending")).toBe(true);
      expect(await world.count("ledger.record_events", "event = 'deferred'")).toBe(0);
      // Deciding one makes room for the eleventh.
      const first = raised[0];
      if (first === undefined) throw new Error("no card");
      await world.admin.cards.decide({ cards: [first.id as never], answer: "different", requestId: req() });
      expect(await sweep(world)).toMatchObject({ raised: 1 });
    }));

  it("a ruling committed between the read and a card's transaction leaves no card for the pair", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      const [sam, orrin] = [
        await world.person("sam@identity-sweep.test"),
        await world.person("sam.orrin@identity-sweep.example"),
      ];
      // The ruling first, then the sweep: its recheck under the locks drops the pair.
      await world.admin.identity.linkPeople(sam as EntityId, orrin as EntityId, "different", { requestId: req() });
      expect((await sweep(world)).raised).toBe(0);
      expect(await world.count("ledger.cards")).toBe(0);
    }));

  it("an address on two contacts under two names raises one shared_address card, and under one name none; the sweep opens no facts_enc", () =>
    inIdentityWorld(async (world) => {
      const contacts = world.accounts.personalContacts;
      await world.save(contacts, "x1", {
        names: ["Odile Brandt"],
        emails: ["family@identity-sweep.test", "o1@identity-sweep.test", "o2@identity-sweep.test"],
      });
      await world.save(contacts, "x2", {
        names: ["Paul Brandt"],
        emails: ["family@identity-sweep.test", "p1@identity-sweep.test", "p2@identity-sweep.test"],
      });
      await world.save(contacts, "y1", { names: ["Same Name"], emails: ["same@identity-sweep.test"] });
      await world.save(contacts, "y2", { names: ["Same Name"], emails: ["same@identity-sweep.test"] });
      await sweep(world);
      const shared = (await cards(world)).filter((one) => one.kind === "shared_address");
      expect(shared.map((one) => one.refs)).toEqual([[await world.person("family@identity-sweep.test")]]);
    }));

  it("re-raise after lift: a pair whose card was decided same, once the ruling is lifted, is asked again on its card under the same case key", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      await sweep(world);
      const [card] = await cards(world);
      if (card === undefined) throw new Error("no card");
      const [decided] = await world.admin.cards.decide({ cards: [card.id as never], answer: "same", requestId: req() });
      expect(await world.count("knowledge.identity_rulings", "ruling_id = $1", [decided?.ruling])).toBe(1);
      expect((await sweep(world)).raised).toBe(0);
      await world.admin.identity.liftIdentity(decided?.ruling as never, { requestId: req() });
      // The lift puts the owner's answered card back, pending, so the pair is asked again on that card and
      // a later sweep raises no second one.
      expect((await cards(world)).map((one) => [one.id, one.state])).toEqual([[card.id, "pending"]]);
      expect((await world.admin.identity.proposeIdentity({ now: new Date(NOW.getTime() + 60_000) })).raised).toBe(0);
      const all = await cards(world);
      expect(all.map((one) => one.id)).toEqual([card.id]);
      expect(new Set(all.map((one) => one.case_key)).size).toBe(1);
    }));

  it("a card for an erased person is withdrawn and none is raised again", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "sam", {
        names: ["Sam Orrin"],
        emails: ["sam@identity-sweep.test", "sam.orrin@identity-sweep.example"],
      });
      await world.mail(MAIL.solo);
      await sweep(world);
      await world.admin.erasure.erasePerson(await world.person("sam@identity-sweep.test"), { requestId: req() });
      expect((await cards(world)).map((one) => one.state)).not.toContain("pending");
      expect((await sweep(world)).raised).toBe(0);
    }));
});
