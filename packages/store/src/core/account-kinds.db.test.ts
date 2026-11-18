import type { EntityId, PersonalTool, RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { OWNER } from "../test-support/cast.ts";
import { fingerprint } from "../test-support/database.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import type { MailFixture } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { commitmentOnMail } from "../test-support/memory-fixtures.ts";
import { snapshot } from "../test-support/snapshot.ts";
import { registration } from "../test-support/values.ts";

// Account kinds: the owner's role and person marks, the reclassification of stored accounts with
// its dry run, the re-point of add-address, and the ignore list. Made-up values on reserved domains
// only; the AI networking bot is synthetic.

const TIMEOUT = 180_000;
// Within get_self's ninety days of the store's clock, which is the real one in this world.
const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "get_commitments",
] as PersonalTool[];

async function client(world: IdentityWorld, name: string, compartments: string[] = ["own"]): Promise<string> {
  const { token } = await world.admin.clients.addClient(
    registration(name, compartments, { views: ["self", "people", "work"], tools: TOOLS }),
  );
  return token;
}

const value = <T>(outcome: { ok: boolean; value?: T }): T => {
  if (!outcome.ok || outcome.value === undefined) throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome.value;
};

const mailFrom = (address: string, id: string, name = "Synthetic Sender"): MailFixture => ({
  ...MAIL.solo,
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@account-kinds.test`,
  from: { address, name },
  cc: [],
});

const accountsOf = (world: IdentityWorld, address: string) =>
  world.sql<{ entity_id: string; kind: string; entity_kind: string }>(
    "select a.entity_id, a.kind, e.kind as entity_kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by a.id",
    [world.fp(address)],
  );

const domainRows = (world: IdentityWorld, domain: string) =>
  world.count("knowledge.domains", "domain_fp = $1", [fingerprint(world.db.keys, "domain", domain)]);

const ownerId = async (world: IdentityWorld): Promise<string> =>
  (await world.sql<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";

// What changed between two snapshots, by table.
const changedTables = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [
    ...new Set([...after].filter(([key, xmin]) => before.get(key) !== xmin).map(([key]) => key.split(" ")[0] ?? key)),
  ].sort();

async function legacyPerson(world: IdentityWorld, address: string, id: string): Promise<EntityId> {
  const ruling = await world.admin.identity.markAddress({ address }, "person", { requestId: req() });
  await world.mail(mailFrom(address, id));
  await world.sql("delete from knowledge.identity_rulings where ruling_id = $1", [ruling]);
  const person = await world.person(address);
  expect(await accountsOf(world, address)).toEqual([{ entity_id: person, kind: "email", entity_kind: "person" }]);
  return person;
}

describe("account kinds", { timeout: TIMEOUT }, () => {
  it("a role address and a bulk address make no person and mint no organization; a person's address at the same domain does", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("privacy@k1a-shop.test", "k1a-role"));
      await world.mail(mailFrom("no-reply@k1a-shop.test", "k1a-bulk-shape"));
      expect(await accountsOf(world, "privacy@k1a-shop.test")).toEqual([]);
      expect(await accountsOf(world, "no-reply@k1a-shop.test")).toEqual([]);
      expect(await domainRows(world, "k1a-shop.test")).toBe(0);
      // The evidence is kept: both messages are stored.
      expect(
        await world.count("knowledge.messages", "sender_fp = any($1)", [
          [world.fp("privacy@k1a-shop.test"), world.fp("no-reply@k1a-shop.test")],
        ]),
      ).toBe(2);
      // The positive control.
      await world.mail(mailFrom("alex@k1a-shop.test", "k1a-person"));
      expect((await accountsOf(world, "alex@k1a-shop.test")).map((row) => [row.kind, row.entity_kind])).toEqual([
        ["email", "person"],
      ]);
      expect(await domainRows(world, "k1a-shop.test")).toBe(1);
    }));

  it("the owner's person mark makes a role-looking address a person's, by the address, before any mail from it", () =>
    inIdentityWorld(async (world) => {
      const ruling = await world.admin.identity.markAddress({ address: "support@k1a-founders.test" }, "person", {
        requestId: req(),
      });
      expect(ruling).toMatch(/^rul_/);
      await world.mail(mailFrom("support@k1a-founders.test", "k1a-founder", "Founder Example"));
      const person = await world.person("support@k1a-founders.test");
      expect((await accountsOf(world, "support@k1a-founders.test")).map((row) => row.kind)).toEqual(["email"]);
      const token = await client(world, "k1a-founder");
      expect(value(await world.store.reader.getEntity(token, { id: person })).id).toBe(person);
      // The decision is the owner's identity decision, and its answer the mark.
      expect(
        await world.count("knowledge.owner_decisions", "id = $1 and kind = 'identity' and answer = 'person'", [ruling]),
      ).toBe(1);
    }));

  it("a role mark on a person sets its accounts' kind in the ruling's transaction, and every reader withholds it; its lift gives it back", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("frontdesk.ana@k1a-clinic.test", "k1a-clinic"));
      const person = await world.person("frontdesk.ana@k1a-clinic.test");
      const token = await client(world, "k1a-role");
      expect(value(await world.store.reader.getEntity(token, { id: person })).id).toBe(person);

      const before = await snapshot(world.db);
      const ruling = await world.admin.identity.markAddress({ entity: person }, "role", { requestId: req() });
      expect(changedTables(before, await snapshot(world.db))).toEqual([
        "knowledge.accounts",
        "knowledge.identity_rulings",
        "knowledge.owner_decisions",
      ]);
      expect((await accountsOf(world, "frontdesk.ana@k1a-clinic.test")).map((row) => row.kind)).toEqual(["role"]);
      expect(await world.store.reader.getEntity(token, { id: person })).toEqual({ ok: false, code: "not_found" });
      expect(value(await world.store.reader.getSelf(token)).contacts.map((one) => one.id)).not.toContain(person);
      // One mark at a time: a person mark on the same address is refused, and a repeat settles.
      await expect(
        world.admin.identity.markAddress({ entity: person }, "person", { requestId: req() }),
      ).rejects.toMatchObject({
        code: "conflicting_ruling",
      });
      await expect(
        world.admin.identity.markAddress({ address: "frontdesk.ana@k1a-clinic.test" }, "role", { requestId: req() }),
      ).rejects.toMatchObject({ code: "already_settled", rulings: [ruling] });

      expect(await world.admin.identity.liftIdentity(ruling, { requestId: req() })).toBe(true);
      expect((await accountsOf(world, "frontdesk.ana@k1a-clinic.test")).map((row) => row.kind)).toEqual(["email"]);
      expect(value(await world.store.reader.getEntity(token, { id: person })).id).toBe(person);
    }));

  it("a role mark refuses a same ruling on its address, and an owner address is never marked", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "two", {
        names: ["Rae Example"],
        emails: ["rae@k1a-pair.test", "rae.office@k1a-pair.example"],
      });
      const [a, b] = [await world.person("rae@k1a-pair.test"), await world.person("rae.office@k1a-pair.example")];
      await world.admin.identity.markAddress({ entity: b }, "role", { requestId: req() });
      await expect(world.admin.identity.linkPeople(a, b, "same", { requestId: req() })).rejects.toMatchObject({
        code: "not_a_person",
      });
      await expect(
        world.admin.identity.markAddress({ address: OWNER.personal }, "role", { requestId: req() }),
      ).rejects.toMatchObject({ code: "not_a_person" });
      await expect(
        world.admin.identity.markAddress({ address: "not an address" }, "person", { requestId: req() }),
      ).rejects.toMatchObject({ code: "invalid_address" });
    }));
});

describe("reclassify", { timeout: TIMEOUT }, () => {
  it("the dry run counts the accounts, the people it would withhold and the claims naming them, and writes nothing", () =>
    inIdentityWorld(async (world) => {
      const person = await legacyPerson(world, "billing@k1a-legacy.test", "k1a-legacy");
      const owner = await ownerId(world);
      await commitmentOnMail(world.store, world.accounts.personalMail, owner, "k1a-legacy-commitment", {
        from: { address: "billing@k1a-legacy.test", name: "Billing" },
      });
      const [{ n: claims } = { n: 0 }] = await world.sql<{ n: number }>(
        "select count(distinct claim_id)::int as n from knowledge.claim_entities where entity_id = $1",
        [person],
      );
      expect(claims).toBeGreaterThan(0);

      const before = await snapshot(world.db);
      expect(await world.admin.identity.reclassifyAccounts({ dryRun: true })).toEqual({
        accounts: 1,
        hidden: 1,
        shown: 0,
        claims,
        committed: false,
      });
      expect(changedTables(before, await snapshot(world.db))).toEqual([]);
      expect((await accountsOf(world, "billing@k1a-legacy.test")).map((row) => row.kind)).toEqual(["email"]);
    }));

  it("invariant 3: the commit changes account kinds alone, never a claim, and the person leaves contacts, search, get_entity and commitments", () =>
    inIdentityWorld(async (world) => {
      const person = await legacyPerson(world, "membership@k1a-club.test", "k1a-club");
      const owner = await ownerId(world);
      const { fact } = await commitmentOnMail(world.store, world.accounts.personalMail, owner, "k1a-club-commitment", {
        from: { address: "membership@k1a-club.test", name: "Membership" },
      });
      const token = await client(world, "k1a-reclassify");
      expect(
        value(await world.store.reader.getCommitments(token, { state: "any" })).commitments.map(
          (one) => one.belief.fact,
        ),
      ).toContain(fact);
      const claimsBefore = await world.sql("select id, xmin::text as xmin from knowledge.claims order by id");

      const before = await snapshot(world.db);
      const counts = await world.admin.identity.reclassifyAccounts({ dryRun: false });
      expect(counts).toMatchObject({ accounts: 1, hidden: 1, shown: 0, committed: true });
      expect(changedTables(before, await snapshot(world.db))).toEqual(["knowledge.accounts"]);
      expect(await world.sql("select id, xmin::text as xmin from knowledge.claims order by id")).toEqual(claimsBefore);
      expect((await accountsOf(world, "membership@k1a-club.test")).map((row) => [row.kind, row.entity_kind])).toEqual([
        ["role", "person"],
      ]);

      expect(await world.store.reader.getEntity(token, { id: person })).toEqual({ ok: false, code: "not_found" });
      expect(value(await world.store.reader.getSelf(token)).contacts.map((one) => one.id)).not.toContain(person);
      expect(
        value(await world.store.reader.getCommitments(token, { state: "any" })).commitments.map(
          (one) => one.belief.fact,
        ),
      ).not.toContain(fact);
      // A second commit finds nothing to change.
      expect(await world.admin.identity.reclassifyAccounts({ dryRun: false })).toEqual({
        accounts: 0,
        hidden: 0,
        shown: 0,
        claims: 0,
        committed: true,
      });
    }));

  it("refused while a sync holds the lock", () =>
    inIdentityWorld(async (world) => {
      await world.store.writer.withSyncLock(async () => {
        await expect(world.admin.identity.reclassifyAccounts({ dryRun: true })).rejects.toMatchObject({
          code: "sync_running",
        });
      });
    }));
});

describe("the owner's other addresses", { timeout: TIMEOUT }, () => {
  it("every reader withholds a person holding an owner address, from the moment the address is the owner's", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("owner.side@k1a-alias.test", "k1a-alias", "Owner Elsewhere"));
      const person = await world.person("owner.side@k1a-alias.test");
      const token = await client(world, "k1a-alias");
      expect(value(await world.store.reader.getEntity(token, { id: person })).id).toBe(person);
      // Learned as sync learns a send-as alias: an owner account row, with no re-derive yet.
      expect(
        await world.store.writer.addOwnerAddresses(world.accounts.personalMail, [
          "Owner.Side@k1a-alias.test",
          "not an address",
        ]),
      ).toBe(1);
      expect(await world.store.reader.getEntity(token, { id: person })).toEqual({ ok: false, code: "not_found" });
      expect(value(await world.store.reader.search(token, { query: "Owner Elsewhere" })).results).toEqual([]);
    }));

  it("add-address re-points the person who held the address to the owner in its one transaction", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("owner.other@k1a-other.test", "k1a-repoint", "Owner Other"));
      const person = await world.person("owner.other@k1a-other.test");
      const result = await world.admin.accounts.addOwnerAddress("owner.other@k1a-other.test", "own");
      expect(result.rederived).toBe(true);
      expect(result.items).toBeGreaterThan(0);
      expect((await accountsOf(world, "owner.other@k1a-other.test")).map((row) => row.entity_kind)).toEqual(["owner"]);
      expect(await world.count("knowledge.entities", "id = $1", [person])).toBe(0);
      expect(await world.admin.accounts.addOwnerAddress("owner.other@k1a-other.test", "own")).toEqual({
        rederived: false,
        items: 0,
      });
    }));

  it("add-address is refused while a sync holds the lock, and writes nothing", () =>
    inIdentityWorld(async (world) => {
      await world.store.writer.withSyncLock(async () => {
        await expect(world.admin.accounts.addOwnerAddress("owner.locked@k1a-other.test", "own")).rejects.toMatchObject({
          code: "sync_running",
        });
      });
      expect(await accountsOf(world, "owner.locked@k1a-other.test")).toEqual([]);
    }));
});

describe("the ignore list", { timeout: TIMEOUT }, () => {
  const BOT = "connect@k1a-networking-bot.test";

  it("an ignored account leaves get_self's contacts, get_entity, search and commitments, and its evidence stays", () =>
    inIdentityWorld(async (world) => {
      const owner = await ownerId(world);
      const { fact, message } = await commitmentOnMail(world.store, world.accounts.personalMail, owner, "k1a-bot", {
        from: { address: BOT, name: "Networking Bot" },
        at: RECENT,
      });
      const bot = await world.person(BOT);
      const token = await client(world, "k1a-ignore");
      expect(value(await world.store.reader.getSelf(token)).contacts.map((one) => one.id)).toContain(bot);
      expect(
        value(await world.store.reader.getCommitments(token, { state: "any" })).commitments.map(
          (one) => one.belief.fact,
        ),
      ).toContain(fact);

      const ruling = await world.admin.ignores.addIgnore("account", BOT, { requestId: req() });
      expect(value(await world.store.reader.getSelf(token)).contacts.map((one) => one.id)).not.toContain(bot);
      expect(await world.store.reader.getEntity(token, { id: bot })).toEqual({ ok: false, code: "not_found" });
      expect(value(await world.store.reader.search(token, { query: "Networking Bot" })).results).toEqual([]);
      expect(
        value(await world.store.reader.getCommitments(token, { state: "any" })).commitments.map(
          (one) => one.belief.fact,
        ),
      ).not.toContain(fact);
      // Nothing of the evidence is deleted.
      expect(await world.count("knowledge.messages", "id = $1", [message.id])).toBe(1);
      expect(value(await world.store.reader.findMessages(token, {})).messages.map((one) => one.id)).toContain(
        message.id,
      );

      // A second ignore of the same account settles; the list prints ids, counts and times.
      await expect(world.admin.ignores.addIgnore("account", BOT, { requestId: req() })).rejects.toMatchObject({
        code: "already_settled",
        rulings: [ruling],
      });
      expect(await world.admin.ignores.listIgnore()).toEqual([
        { id: ruling, target: "account", subject: "address", values: 1, at: expect.any(String), liftedAt: null },
      ]);
      expect(JSON.stringify(await world.admin.ignores.listIgnore())).not.toContain("k1a-networking-bot");

      // The lift gives it back.
      expect(await world.admin.ignores.liftIgnore(ruling, { requestId: req() })).toBe(true);
      expect(await world.admin.ignores.liftIgnore(ruling, { requestId: req() })).toBe(false);
      expect(value(await world.store.reader.getEntity(token, { id: bot })).id).toBe(bot);
    }));

  it("ignoring a person covers its addresses, and ignoring a domain covers every person at it and its organization", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("ana@k1a-ignored.test", "k1a-dom-a"));
      await world.mail(mailFrom("ben@k1a-ignored.test", "k1a-dom-b"));
      await world.mail(mailFrom("cy@k1a-kept.test", "k1a-dom-c"));
      const [ana, ben, cy] = [
        await world.person("ana@k1a-ignored.test"),
        await world.person("ben@k1a-ignored.test"),
        await world.person("cy@k1a-kept.test"),
      ];
      const token = await client(world, "k1a-ignore-domain");
      await world.admin.ignores.addIgnore("entity", cy, { requestId: req() });
      expect(await world.store.reader.getEntity(token, { id: cy })).toEqual({ ok: false, code: "not_found" });
      await world.admin.ignores.addIgnore("domain", "K1A-Ignored.test", { requestId: req() });
      for (const one of [ana, ben])
        expect(await world.store.reader.getEntity(token, { id: one })).toEqual({ ok: false, code: "not_found" });
      const [organization] = await world.sql<{ entity_id: string }>(
        "select entity_id from knowledge.domains where domain_fp = $1",
        [fingerprint(world.db.keys, "domain", "k1a-ignored.test")],
      );
      expect(await world.store.reader.getEntity(token, { id: organization?.entity_id as EntityId })).toEqual({
        ok: false,
        code: "not_found",
      });
      await expect(world.admin.ignores.addIgnore("domain", "not a domain", { requestId: req() })).rejects.toMatchObject(
        {
          code: "invalid_argument",
        },
      );
      await expect(
        world.admin.ignores.addIgnore("account", OWNER.personal, { requestId: req() }),
      ).rejects.toMatchObject({
        code: "not_a_person",
      });
      await expect(
        world.admin.ignores.addIgnore("entity", await ownerId(world), { requestId: req() }),
      ).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }));

  it("the sweep raises no card about an ignored person", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "bot", {
        names: ["Networking Bot"],
        emails: [BOT, "hello.bot@k1a-networking-bot.example"],
      });
      await world.admin.ignores.addIgnore("domain", "k1a-networking-bot.test", { requestId: req() });
      expect(await world.admin.identity.proposeIdentity({ now: new Date("2026-09-15T12:00:00Z") })).toMatchObject({
        candidates: 0,
        raised: 0,
        skipped: 0,
      });
      // The positive control: lifted, the pair is raised.
      const [ruling] = (await world.admin.ignores.listIgnore()).map((one) => one.id);
      await world.admin.ignores.liftIgnore(ruling as RulingId, { requestId: req() });
      expect(await world.admin.identity.proposeIdentity({ now: new Date("2026-09-15T12:00:00Z") })).toMatchObject({
        candidates: 1,
        raised: 1,
        skipped: 0,
      });
    }));

  it("an erasure of the person deletes the ignore rulings that hold its address", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom(BOT, "k1a-erase", "Networking Bot"));
      const bot = await world.person(BOT);
      await world.admin.ignores.addIgnore("entity", bot, { requestId: req() });
      expect(await world.count("knowledge.ignore_rulings")).toBe(1);
      await world.admin.erasure.erasePerson(bot, { requestId: req() });
      expect(await world.count("knowledge.ignore_rulings")).toBe(0);
    }));

  // A domain ignore a refold narrowed to addresses
  // withholds each address it holds, as an address ignore does, and an erasure of the person takes
  // the address out of it and leaves the ruling.
  it("a domain ignore narrowed to an address withholds that person, the sweep leaves it out, and an erasure takes the address out of it", () =>
    inIdentityWorld(async (world) => {
      const NELL = "nell@k1a-narrowed.test";
      await world.save(world.accounts.personalContacts, "nell", {
        names: ["Nell Ferris"],
        emails: [NELL, "nell.ferris@k1a-narrowed-two.test"],
      });
      const nell = await world.person(NELL);
      const token = await client(world, "k1a-narrowed");
      expect(value(await world.store.reader.getEntity(token, { id: nell })).id).toBe(nell);
      const ruling = await world.admin.ignores.addIgnore("domain", "k1a-elsewhere.test", { requestId: req() });
      await world.sql("update knowledge.ignore_rulings set address_fps = $2 where ruling_id = $1", [
        ruling,
        [world.fp(NELL)],
      ]);
      expect(await world.store.reader.getEntity(token, { id: nell })).toEqual({ ok: false, code: "not_found" });
      // The pair the contact makes is raised by neither sweep.
      expect(await world.admin.identity.proposeIdentity({ now: new Date("2026-09-15T12:00:00Z") })).toMatchObject({
        candidates: 0,
        raised: 0,
        skipped: 0,
      });
      expect(
        await world.store.writer.withSyncLock(() =>
          world.store.writer.proposeIdentity(new Date("2026-09-15T12:00:00Z")),
        ),
      ).toEqual({ candidates: 0, raised: 0, skipped: 0 });
      await world.admin.erasure.erasePerson(nell, { requestId: req() });
      expect(
        await world.sql("select address_fps from knowledge.ignore_rulings where ruling_id = $1", [ruling]),
      ).toEqual([{ address_fps: [] }]);
    }));
});

// Invariant 6: a mark or an ignore changes what a client sees only by taking away a row it saw,
// and a ruling that holds only rows a client cannot see changes nothing it sees.
describe("invariant 6", { timeout: TIMEOUT }, () => {
  it("an ignore or a role mark on a hidden address changes nothing a client of the other compartment sees", () =>
    inIdentityWorld(async (world) => {
      // Kit is seen in own; Kit's work address only in employer:example, on one work contact.
      await world.save(world.accounts.personalContacts, "kit", { names: ["Kit Arden"], emails: ["kit@k1a-inv6.test"] });
      await world.save(world.accounts.workContacts, "kit-work", {
        names: ["Kit Arden"],
        emails: ["kit.arden@k1a-inv6.example"],
      });
      const [own, work] = [await world.person("kit@k1a-inv6.test"), await world.person("kit.arden@k1a-inv6.example")];
      const token = await client(world, "k1a-inv6-own");
      // get_self's work carries the read's own time, which no ruling changes.
      const self = async () => {
        const answer = value(await world.store.reader.getSelf(token));
        return answer.work === undefined ? answer : { ...answer, work: { ...answer.work, asOf: "<read time>" } };
      };
      const before = {
        self: await self(),
        entity: value(await world.store.reader.getEntity(token, { id: own })),
        search: value(await world.store.reader.search(token, { query: "Kit Arden" })),
      };
      await world.admin.ignores.addIgnore("entity", work, { requestId: req() });
      await world.admin.identity.markAddress({ address: "kit.arden@k1a-inv6.example" }, "role", { requestId: req() });
      await world.admin.ignores.addIgnore("domain", "k1a-inv6.example", { requestId: req() });
      expect(await self()).toEqual(before.self);
      expect(value(await world.store.reader.getEntity(token, { id: own }))).toEqual(before.entity);
      expect(value(await world.store.reader.search(token, { query: "Kit Arden" }))).toEqual(before.search);
    }));

  it("an owner address the client cannot see withholds nothing it sees", () =>
    inIdentityWorld(async (world) => {
      await world.mail(mailFrom("shared.desk@k1a-inv6-owner.test", "k1a-inv6-owner"));
      const person = await world.person("shared.desk@k1a-inv6-owner.test");
      const token = await client(world, "k1a-inv6-owner");
      const before = value(await world.store.reader.getEntity(token, { id: person }));
      // The owner's address under the work compartment alone, which the own client does not hold.
      await world.store.writer.addOwnerAddresses(world.accounts.workMail, ["shared.desk@k1a-inv6-owner.test"]);
      expect(value(await world.store.reader.getEntity(token, { id: person }))).toEqual(before);
      // The positive control: a client of both compartments no longer sees the person.
      const both = await client(world, "k1a-inv6-owner-both", ["own", "employer:example"]);
      expect(await world.store.reader.getEntity(both, { id: person })).toEqual({ ok: false, code: "not_found" });
    }));
});
