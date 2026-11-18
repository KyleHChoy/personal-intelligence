import type { Timestamp } from "@intelligence/contracts";
import type { CardId, EntityId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS, profileKey } from "@intelligence/personal-core";
import { deriveItem, importItem, readContacts } from "@intelligence/personal-core/items";
import { LINKEDIN_CONNECTIONS } from "@intelligence/personal-core/testing";
import { describe, expect, it } from "vitest";
import { OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { mail } from "../test-support/items.ts";

// The sweep's bases, its order, and the writer's sweep at the end of a sync. Made-up values on
// reserved domains only.

const TIMEOUT = 180_000;
const NOW = new Date("2026-09-15T12:00:00Z");
const sweep = (world: IdentityWorld) => world.admin.identity.proposeIdentity({ now: NOW });

// Inbound mail from an address under a display name, on a day of September: an interaction and an
// email alias. The owner never writes back, so neither person is established.
let n = 0;
async function wrote(world: IdentityWorld, address: string, name: string, day = 1): Promise<void> {
  n += 1;
  const at = `2026-09-${String(day).padStart(2, "0")}T10:00:00Z` as Timestamp;
  await world.mail(
    mail({
      id: `gm-bases-${n}`,
      threadId: `thread-bases-${n}`,
      at,
      from: { address, name },
      to: [{ address: OWNER.personal }],
      subject: "Hello",
      labels: ["INBOX"],
    }),
  );
}

const pairs = (world: IdentityWorld) =>
  world.sql<{ refs: string[] }>(
    `select array(select b.ref_id from ledger.basis b where b.row_kind = 'card' and b.row_id = c.id order by b.ref_id) as refs
     from ledger.cards c where c.kind = 'same_person' and c.created_by = 'system:identity' order by c.created_at, c.id`,
  );
const pairOf = async (world: IdentityWorld, a: string, b: string): Promise<string[]> =>
  [await world.person(a), await world.person(b)].sort();

describe("duplicate candidates", { timeout: TIMEOUT }, () => {
  it("the same full name raises one card with neither person established, and a one-word name still raises none", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "tam@bases-one.test", "Tam Rusk");
      await wrote(world, "rusk@bases-two.test", "  TAM   rusk ");
      await wrote(world, "mono@bases-one.test", "Mononym");
      await wrote(world, "mono@bases-two.test", "Mononym");
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1, skipped: 0 });
      expect((await pairs(world)).map((one) => one.refs)).toEqual([
        await pairOf(world, "tam@bases-one.test", "rusk@bases-two.test"),
      ]);
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 0, skipped: 0 });
    }));

  // The card carries both people's labels.
  it("a person imported by a profile alone and a person from mail with the same full name raise one card, labelled with both", () =>
    inIdentityWorld(async (world) => {
      const read = readContacts("linkedin-connections", LINKEDIN_CONNECTIONS, { now: NOW });
      const record = read.records.find((one) => one.emails.length === 0 && one.extras.profiles.length > 0);
      expect(record).toBeDefined();
      const key = profileKey(record?.extras.profiles[0] ?? "");
      expect(key).not.toBeNull();
      const account = await world.store.writer.ensureImportAccount("bases-profiles");
      const raw = importItem(record as NonNullable<typeof record>, {
        sourceAccount: account.id,
        now: NOW.toISOString() as Timestamp,
        id: `import:${fingerprint(world.db.keys, "source_id", "import:bases-profile")}`,
      });
      expect(await world.store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe(
        "stored",
      );
      const profiled = await world.person(key as string);
      expect(await world.count("knowledge.accounts", "entity_id = $1 and kind = 'email'", [profiled])).toBe(1);
      // The same name in mail on the work label, from an address.
      n += 1;
      await world.mail(
        mail({
          id: `gm-bases-${n}`,
          threadId: `thread-bases-${n}`,
          at: "2026-09-02T10:00:00Z" as Timestamp,
          from: { address: "lena@bases-work.test", name: "Lena Ortiz" },
          to: [{ address: OWNER.work }],
          subject: "Hello",
          labels: ["INBOX"],
        }),
        world.accounts.workMail,
      );
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1, skipped: 0 });
      expect((await pairs(world)).map((one) => one.refs)).toEqual([
        [profiled, await world.person("lena@bases-work.test")].sort(),
      ]);
      const [card] = await world.sql<{ compartments: string[] }>(
        "select compartments from ledger.cards where kind = 'same_person'",
      );
      expect(card?.compartments).toEqual(["employer:example", "own"]);
    }));

  it("a first.last@, first_last@ or firstlast@ address raises a card with the person who has that name", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "ix@bases-name.test", "Ilse Varro");
      await wrote(world, "ilse.varro@bases-dot.test", "IV");
      await wrote(world, "ilse_varro@bases-under.test", "I");
      await wrote(world, "ilsevarro@bases-joined.test", "Office");
      // A local part that spells no full name raises nothing.
      await wrote(world, "ilse.varro2@bases-digit.test", "Someone");
      expect(await sweep(world)).toMatchObject({ candidates: 3, raised: 3 });
      const raised = (await pairs(world)).map((one) => one.refs.join(" ")).sort();
      const want = await Promise.all(
        ["ilse.varro@bases-dot.test", "ilse_varro@bases-under.test", "ilsevarro@bases-joined.test"].map(async (one) =>
          (await pairOf(world, "ix@bases-name.test", one)).join(" "),
        ),
      );
      expect(raised).toEqual(want.sort());
    }));

  it("a ruling binds: a pair ruled different is not raised again, and a same ruling settles the pair for every basis", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "tam@bases-one.test", "Tam Rusk");
      await wrote(world, "tam.rusk@bases-two.test", "Tam Rusk");
      await sweep(world);
      const [card] = await world.sql<{ id: CardId }>("select id from ledger.cards where kind = 'same_person'");
      if (card === undefined) throw new Error("no card");
      await world.admin.cards.decide({ cards: [card.id], answer: "different", requestId: req() });
      expect(await world.admin.identity.proposeIdentity({ now: new Date(NOW.getTime() + 60_000) })).toMatchObject({
        candidates: 0,
        raised: 0,
        skipped: 0,
      });
      // A third address of the same name, which a same ruling joins to the first.
      await wrote(world, "t.r@bases-three.test", "Tam Rusk");
      const [one, three] = [await world.person("tam@bases-one.test"), await world.person("t.r@bases-three.test")];
      await world.admin.identity.linkPeople(one as EntityId, three as EntityId, "same", { requestId: req() });
      // One and three are one person; two was ruled different from one, so from three too.
      expect((await world.admin.identity.proposeIdentity({ now: new Date(NOW.getTime() + 120_000) })).candidates).toBe(
        0,
      );
    }));

  it("at most ten open cards in total, newest evidence first: the pair with the oldest mail waits", () =>
    inIdentityWorld(async (world) => {
      for (let i = 0; i < 11; i += 1) {
        const name = `Pair ${"abcdefghijk"[i]}${"abcdefghijk"[i]}son`;
        await wrote(world, `x${i}@bases-left.test`, name, i + 1);
        await wrote(world, `y${i}@bases-right.test`, name, i + 1);
      }
      expect(await sweep(world)).toMatchObject({ candidates: 11, raised: 10 });
      expect(await world.count("ledger.record_events", "event = 'deferred'")).toBe(0);
      const raised = new Set((await pairs(world)).map((one) => one.refs.join(" ")));
      expect(raised.has((await pairOf(world, "x0@bases-left.test", "y0@bases-right.test")).join(" "))).toBe(false);
      expect(raised.has((await pairOf(world, "x10@bases-left.test", "y10@bases-right.test")).join(" "))).toBe(true);
    }));

  it("the writer's sweep, under its sync lock, raises the card as pi_writer and writes nothing but identity cards", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "tam@bases-one.test", "Tam Rusk");
      await wrote(world, "rusk@bases-two.test", "Tam Rusk");
      const writer = world.store.writer;
      expect(await writer.withSyncLock(() => writer.proposeIdentity(NOW))).toEqual({
        candidates: 1,
        raised: 1,
        skipped: 0,
      });
      expect(await world.sql("select kind, created_by from ledger.cards")).toEqual([
        { kind: "same_person", created_by: "system:identity" },
      ]);
      // The writer's policies name system:identity's cards and their raise alone.
      const as = (sql: string) => sqlState(() => queryAs(world.db.urls.writer, sql));
      expect(
        await as(
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ('crd_baseswriterrefused0000000000', 'r', now(), 'system:extract', 'agent_claim', array['confirm'], array['own'])`,
        ),
      ).toBe("42501");
      expect(await as("update ledger.cards set request_id = request_id")).toBe("42501");
      expect(await as("delete from ledger.record_events")).toBe("42501");
      expect(await as("select count(*) from ledger.cards where created_by <> 'system:identity'")).toBeNull();
      // The owner decides it as any other card.
      const [card] = await world.sql<{ id: CardId }>("select id from ledger.cards");
      await world.admin.cards.decide({ cards: [card?.id as CardId], answer: "same", requestId: req() });
      expect(await world.count("knowledge.identity_rulings", "verdict = 'same'")).toBe(1);
    }));

  // The writer's sweep reads every live ignore, not a domain one alone.
  it("the writer's sweep leaves out a person the owner ignored by account or by entity, as the admin's does", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "tam@bases-one.test", "Tam Rusk");
      await wrote(world, "rusk@bases-two.test", "Tam Rusk");
      await wrote(world, "ora@bases-one.test", "Ora Lund");
      await wrote(world, "lund@bases-two.test", "Ora Lund");
      const writer = world.store.writer;
      await world.admin.ignores.addIgnore("account", "tam@bases-one.test", { requestId: req() });
      await world.admin.ignores.addIgnore("entity", await world.person("lund@bases-two.test"), { requestId: req() });
      expect(await writer.withSyncLock(() => writer.proposeIdentity(NOW))).toEqual({
        candidates: 0,
        raised: 0,
        skipped: 0,
      });
      // The control: the same pairs with no ignore are raised.
      await world.sql("update knowledge.ignore_rulings set lifted_at = now(), lift_ruling_id = ruling_id");
      expect(await writer.withSyncLock(() => writer.proposeIdentity(NOW))).toEqual({
        candidates: 2,
        raised: 2,
        skipped: 0,
      });
    }));

  it("the writer raises a card's first event alone, and cannot reopen a card the owner decided", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "tam@bases-one.test", "Tam Rusk");
      await wrote(world, "rusk@bases-two.test", "Tam Rusk");
      const writer = world.store.writer;
      await writer.withSyncLock(() => writer.proposeIdentity(NOW));
      const [card] = await world.sql<{ id: CardId; compartments: string[] }>(
        "select id, compartments from ledger.cards",
      );
      await world.admin.cards.decide({ cards: [card?.id as CardId], answer: "different", requestId: req() });
      const reopen = (event: string) =>
        sqlState(() =>
          queryAs(
            world.db.urls.writer,
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, now(), 'system:identity', $3)",
            [card?.id, event, card?.compartments],
          ),
        );
      for (const event of ["pending", "deferred"]) expect(await reopen(event), event).toBe("42501");
      expect(
        await world.sql(
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [card?.id],
        ),
      ).toEqual([{ event: "decided" }]);
    }));

  // The definer answers only for system:identity's cards, so the writer
  // learns nothing through it of a card another author raised.
  it("ledger.card_unopened answers false for another author's card with no event, and true for system:identity's", () =>
    inIdentityWorld(async (world) => {
      const card = async (author: string): Promise<string> => {
        const id = testId("crd");
        await world.sql(
          "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now(), $3, 'notice', '{acknowledge}', '{own}')",
          [id, `request-${id.slice(4)}`, author],
        );
        return id;
      };
      const unopened = async (id: string) =>
        (
          await queryAs<{ unopened: boolean }>(world.db.urls.writer, "select ledger.card_unopened($1) as unopened", [
            id,
          ])
        )[0]?.unopened;
      expect(await unopened(await card("system:extract"))).toBe(false);
      expect(await unopened(testId("crd"))).toBe(false);
      // The control: an identity card with no event.
      expect(await unopened(await card("system:identity"))).toBe(true);
    }));
});
