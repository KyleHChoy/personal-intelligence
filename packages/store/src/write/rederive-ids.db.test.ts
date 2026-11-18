import { randomBytes } from "node:crypto";
import type { CardId, EntityId, NewCard, PersonalRef } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { addOwnerAddressUnderived, type Query, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { namesSealed, recordingStatements } from "../test-support/recording.ts";
import { inStore, type TestStore } from "../test-support/store.ts";
import { registration } from "../test-support/values.ts";
import { seedWorld, WORLD } from "../test-support/world.ts";

const TIMEOUT = 180_000;

type Ids = {
  messages: Record<string, string>;
  events: Record<string, string>;
  people: Record<string, string>;
  organizations: Record<string, string>;
};

// Every derived id, keyed by what does not change across a re-derive: a message and an event by
// their source item's fingerprint, a person by its address fingerprint, an organization by its
// domain fingerprint. Read as pi_admin.
async function ids(store: TestStore): Promise<Ids> {
  const rows = (text: string) => queryAs<{ key: string; id: string }>(store.db.urls.admin, text);
  const record = (list: { key: string; id: string }[]) => Object.fromEntries(list.map((row) => [row.key, row.id]));
  return {
    messages: record(
      await rows(
        "select e.source_item_fp as key, m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
      ),
    ),
    events: record(
      await rows(
        "select e.source_item_fp as key, v.id from knowledge.events v join vault.evidence_items e on e.id = v.evidence_id",
      ),
    ),
    people: record(
      await rows(
        "select distinct a.value_fp as key, a.entity_id as id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person'",
      ),
    ),
    organizations: record(await rows("select distinct domain_fp as key, entity_id as id from knowledge.domains")),
  };
}

// A pending notice with a body, about `target`, citing `refs`.
async function card(store: TestStore, target: PersonalRef | null, refs: PersonalRef[] = []): Promise<CardId> {
  const made: NewCard = {
    id: newId("crd") as CardId,
    requestId: `req-${randomBytes(8).toString("hex")}`,
    kind: "notice",
    author: "system:test",
    options: ["acknowledge"],
    target,
    refs,
    compartments: ["own"],
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: null,
    run: null,
    body: "a body to keep or lose",
    bodyFrom: "code",
  };
  await session(store.db.urls.admin, async (query: Query) => {
    await query("begin");
    await raiseCard(query, made, { now: store.now, keys: store.db.keys });
    await query("commit");
  });
  return made.id;
}

const tainted = async (store: TestStore, id: CardId): Promise<boolean> =>
  (
    await queryAs<{ tainted: boolean }>(
      store.db.urls.admin,
      "select tainted_at is not null as tainted from ledger.cards where id = $1",
      [id],
    )
  )[0]?.tainted === true;

// The world, then Pat's address made the owner's, with no re-derive yet, as a sync's send-as list
// adds one: Pat is the one person a re-derive removes. `owned: false` leaves the
// address Pat's alone, for a test to make it the owner's itself.
async function world(store: TestStore, { owned = true }: { owned?: boolean } = {}) {
  const seeded = await seedWorld(store.writer, store.admin);
  const pat = seeded.entityOf(WORLD.ownOnly.address);
  const blake = seeded.entityOf(WORLD.both.address);
  if (owned) await addOwnerAddressUnderived(store.db, WORLD.ownOnly.address, "own");
  return { ...seeded, pat, blake };
}

const withWorld = (fn: (store: TestStore) => Promise<void>): Promise<void> =>
  inStore({ now: new Date("2026-03-10T12:00:00.000Z") }, fn);

describe("a re-derive keeps ids", { timeout: TIMEOUT }, () => {
  it("a re-derive keeps the id of every message, event, person and organization that is still there", () =>
    withWorld(async (store) => {
      const seeded = await world(store);
      const before = await ids(store);
      expect(await store.writer.rederiveIfNeeded(seeded.derive)).toMatchObject({ rederived: true });
      const after = await ids(store);

      // Every message and event is still there, under its id.
      expect(Object.keys(before.messages).length).toBeGreaterThan(0);
      expect(Object.keys(before.events).length).toBeGreaterThan(0);
      expect(after.messages).toEqual(before.messages);
      expect(after.events).toEqual(before.events);
      // Every person but Pat, and every organization, keeps its id.
      const patFp = fingerprint(store.db.keys, "address", WORLD.ownOnly.address);
      expect(before.people[patFp]).toBe(seeded.pat);
      const { [patFp]: _gone, ...stayed } = before.people;
      expect(Object.keys(stayed).length).toBeGreaterThan(0);
      expect(after.people).toEqual(stayed);
      expect(Object.keys(before.organizations).length).toBeGreaterThan(0);
      expect(after.organizations).toEqual(before.organizations);
    }));

  it("the person whose address became the owner's is gone, its id answers not_found, and a card about it is tainted", () =>
    withWorld(async (store) => {
      const seeded = await world(store, { owned: false });
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      // The positive control: while the address is Pat's alone, Pat is found.
      expect((await store.reader.getEntity(token, { id: seeded.pat as EntityId })).ok).toBe(true);
      const about = await card(store, { kind: "entity", id: seeded.pat });
      // From the moment the address is the owner's, before any re-derive, every reader withholds
      // Pat (policy.entity_withheld), though Pat's row is still there.
      await addOwnerAddressUnderived(store.db, WORLD.ownOnly.address, "own");
      expect(await store.reader.getEntity(token, { id: seeded.pat as EntityId })).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(
        await queryAs(store.db.urls.admin, "select id from knowledge.entities where id = $1", [seeded.pat]),
      ).toEqual([{ id: seeded.pat }]);

      await store.writer.rederiveIfNeeded(seeded.derive);
      expect(
        await queryAs(store.db.urls.admin, "select id from knowledge.entities where id = $1", [seeded.pat]),
      ).toEqual([]);
      expect(await store.reader.getEntity(token, { id: seeded.pat as EntityId })).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(await tainted(store, about)).toBe(true);
    }));

  it("a timeline read with an id from before the re-derive gives the same entries after it", () =>
    withWorld(async (store) => {
      const seeded = await world(store);
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      const before = await store.reader.getTimeline(token, { id: seeded.blake as EntityId });
      expect(before.ok).toBe(true);
      if (before.ok) expect(before.value.entries.length).toBeGreaterThan(0);

      await store.writer.rederiveIfNeeded(seeded.derive);
      expect(await store.reader.getTimeline(token, { id: seeded.blake as EntityId })).toEqual(before);
    }));

  // The organizations' map is keyed by the fingerprint of each
  // registrable domain, so the re-derive opens every domain row to fold it (org-fold.ts); the
  // people's map still reads ids and fingerprints alone.
  it("a re-derive holds no opened value in its id maps", () =>
    withWorld(async (store) => {
      const seeded = await world(store);
      const { result, statements } = await recordingStatements(() => store.writer.rederiveIfNeeded(seeded.derive));
      expect(result.rederived).toBe(true);
      // The maps are read after the removal starts and before the entities are deleted.
      const deletes = statements.findIndex((one) => /delete from knowledge\.entities/.test(one.text));
      expect(deletes).toBeGreaterThan(0);
      const read = statements
        .slice(0, deletes)
        .filter(
          (one) =>
            /^\s*select\b/i.test(one.text) &&
            /from knowledge\.(accounts|domains)\b/.test(one.text) &&
            !/exists\s*\(/.test(one.text),
        );
      const columnsOf = (text: string): string[] =>
        (/select([\s\S]*?)\bfrom\b/i.exec(text)?.[1] ?? "").split(",").map(
          (part) =>
            part
              .trim()
              .split(/\s+as\s+/i)[0]
              ?.split(".")
              .pop() ?? "",
        );
      const notes = read.filter((one) => /from knowledge\.claim_entities\b/.test(one.text));
      expect(notes).toHaveLength(1);
      for (const one of notes) {
        expect(namesSealed(one.text), one.text).toBe(false);
        for (const column of columnsOf(one.text))
          expect(column.endsWith("id") || column === "compartments" || column.endsWith("_fp"), column).toBe(true);
      }
      const maps = read.filter((one) => !notes.includes(one));
      // The positive control: there are two, one for each map, and they brought rows back.
      expect(maps).toHaveLength(2);
      expect(maps.every((one) => one.rows > 0)).toBe(true);
      const [people, domains] = [/from knowledge\.accounts\b/, /from knowledge\.domains\b/].map((table) =>
        maps.filter((one) => table.test(one.text)),
      );
      expect([people?.length, domains?.length]).toEqual([1, 1]);
      // The people's: ids and fingerprints only, no sealed column, nothing opened.
      for (const one of people ?? []) {
        expect(namesSealed(one.text), one.text).toBe(false);
        for (const column of columnsOf(one.text))
          expect(column === "id" || column === "entity_id" || column.endsWith("_fp"), column).toBe(true);
      }
      // The organizations': each row's id, its entity, and the sealed domain with the label it is
      // opened under, and nothing else.
      for (const one of domains ?? [])
        expect(columnsOf(one.text)).toEqual(["id", "entity_id", "compartments", "domain_enc"]);
    }));

  it("a re-derive taints nothing for an entity that is still there", () =>
    withWorld(async (store) => {
      const seeded = await world(store);
      const [message] = Object.values((await ids(store)).messages);
      const [event] = Object.values((await ids(store)).events);
      const blake = await card(store, { kind: "entity", id: seeded.blake }, [
        { kind: "message", id: message } as PersonalRef,
        { kind: "event", id: event } as PersonalRef,
        { kind: "entity", id: seeded.blake },
      ]);
      // The positive control: a card about the person who goes is tainted by the same re-derive.
      const pat = await card(store, { kind: "entity", id: seeded.pat });

      await store.writer.rederiveIfNeeded(seeded.derive);
      expect(await tainted(store, blake)).toBe(false);
      expect(
        await queryAs(store.db.urls.admin, "select count(*)::int as n from ledger.basis where tainted_at is not null"),
      ).toEqual([{ n: 0 }]);
      expect(await tainted(store, pat)).toBe(true);
    }));
});
