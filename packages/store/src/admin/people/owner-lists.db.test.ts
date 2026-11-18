import type { EntityId, OwnerListId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createDb } from "../../core/job-db.ts";
import type { ErasureHook } from "../../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../../erasure/erasure-hooks.ts";
import { testId } from "../../test-support/clients.ts";
import { addOwnerAddressUnderived, session } from "../../test-support/connections.ts";
import { fingerprint, queryAs } from "../../test-support/database.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { seedWorld, WORLD } from "../../test-support/world.ts";

// The owner's lists of people through the Admin as pi_admin. Each write is one owner decision; a
// list's name is sealed; membership survives a re-derive and follows an identity merge; an erasure
// reaches it; no agent reads it. The synthetic world of test-support/world.ts.

const TIMEOUT = 180_000;
const req = (): { requestId: string } => ({ requestId: testId("req").slice(4) });
const NAME = "Canary-List Founders";

const withWorld = async (
  fn: (store: TestStore, seeded: Awaited<ReturnType<typeof seedWorld>>) => Promise<void>,
): Promise<void> => {
  const store = await openStore({ now: new Date("2026-03-10T12:00:00.000Z") });
  try {
    await fn(store, await seedWorld(store.writer, store.admin));
  } finally {
    await store.close();
  }
};

const codeOf = async (fn: () => Promise<unknown>): Promise<unknown> =>
  fn().then(
    () => null,
    (error: { code?: unknown; rulings?: unknown }) => ({ code: error.code, rulings: error.rulings }),
  );
const membersOf = async (store: TestStore, list: OwnerListId): Promise<EntityId[] | undefined> =>
  (await store.admin.lists.all()).find((one) => one.id === list)?.members;
const kinds = (store: TestStore) =>
  queryAs<{ kind: string }>(
    store.db.urls.admin,
    "select kind from knowledge.owner_decisions where kind like 'list_%' order by decided_at, id",
  );

describe("the owner's lists of people", { timeout: TIMEOUT }, () => {
  it("creates, renames, adds, removes and deletes, each one owner decision; the name is sealed; a repeated request writes once; refusals", () =>
    withWorld(async (store, seeded) => {
      const blake = seeded.entityOf(WORLD.both.address);
      const pat = seeded.entityOf(WORLD.ownOnly.address);
      const { admin } = store;
      const created = req();
      const list = await admin.lists.createList(NAME, created);
      expect(await admin.lists.createList(NAME, created)).toBe(list);
      expect(await admin.lists.all()).toEqual([
        { id: list, name: NAME, createdAt: expect.any(String), members: [], people: [] },
      ]);
      // Sealed: the name is in no column as text.
      const [row] = await queryAs<{ text: string; compartments: string[] }>(
        store.db.urls.admin,
        "select row_to_json(l)::text as text, compartments from knowledge.owner_lists l where id = $1",
        [list],
      );
      expect(row?.text).not.toContain("Canary-List");
      expect(row?.compartments).toEqual(["own"]);

      await admin.lists.renameList(list, "Canary-List Renamed", req());
      expect((await admin.lists.all())[0]?.name).toBe("Canary-List Renamed");

      // By entity id and by address.
      const added = await admin.lists.addToList(list, blake, req());
      await admin.lists.addToList(list, WORLD.ownOnly.address, req());
      expect(await membersOf(store, list)).toEqual([blake, pat].sort());
      expect(await codeOf(() => admin.lists.addToList(list, WORLD.both.address, req()))).toEqual({
        code: "already_settled",
        rulings: [added],
      });
      // Blake's member row carries Blake's account labels.
      expect(
        await queryAs(
          store.db.urls.admin,
          "select compartments from knowledge.owner_list_members where ruling_id = $1",
          [added],
        ),
      ).toEqual([{ compartments: ["employer:example", "own"] }]);

      expect(await admin.lists.removeFromList(list, blake, req())).toBe(true);
      expect(await admin.lists.removeFromList(list, blake, req())).toBe(false);
      expect(await membersOf(store, list)).toEqual([pat]);
      // Re-added: a new member row, the removed one kept with its removal.
      await admin.lists.addToList(list, blake, req());
      expect(await membersOf(store, list)).toEqual([blake, pat].sort());

      // A second list is its own.
      const other = await admin.lists.createList("Canary-List Other", req());
      expect(await membersOf(store, other)).toEqual([]);

      const deleted = await admin.lists.deleteList(list, req());
      expect((await admin.lists.all()).map((one) => one.id)).toEqual([other]);
      // Its members in force are removed by the delete.
      expect(
        await queryAs(
          store.db.urls.admin,
          "select distinct remove_ruling_id from knowledge.owner_list_members where list_id = $1 and remove_ruling_id = $2",
          [list, deleted],
        ),
      ).toEqual([{ remove_ruling_id: deleted }]);
      expect(
        await queryAs(
          store.db.urls.admin,
          "select count(*)::int as n from knowledge.owner_list_members where list_id = $1 and removed_at is null",
          [list],
        ),
      ).toEqual([{ n: 0 }]);
      expect(await kinds(store)).toEqual(
        [
          "list_create",
          "list_rename",
          "list_add",
          "list_add",
          "list_remove",
          "list_add",
          "list_create",
          "list_delete",
        ].map((kind) => ({ kind })),
      );

      // Refusals, before any write.
      expect(await codeOf(() => admin.lists.addToList(list, pat, req()))).toMatchObject({ code: "not_found" });
      expect(await codeOf(() => admin.lists.renameList(list, "Canary-List Again", req()))).toMatchObject({
        code: "not_found",
      });
      expect(await codeOf(() => admin.lists.deleteList(list, req()))).toMatchObject({ code: "not_found" });
      expect(await codeOf(() => admin.lists.addToList(other, seeded.ownerEntity(), req()))).toMatchObject({
        code: "not_a_person",
      });
      expect(await codeOf(() => admin.lists.addToList(other, "nobody@example.test", req()))).toMatchObject({
        code: "not_found",
      });
      expect(await codeOf(() => admin.lists.createList("two\nlines", req()))).toMatchObject({
        code: "invalid_argument",
      });
      expect(await codeOf(() => admin.lists.createList("   ", req()))).toMatchObject({ code: "invalid_argument" });
      expect(await kinds(store)).toHaveLength(8);
      // No log line carries the name.
      expect(JSON.stringify(store.log.events)).not.toContain("Canary-List");
    }));

  it("membership survives a re-derive, follows a new id and an identity merge, and never holds the owner", () =>
    withWorld(async (store, seeded) => {
      const blake = seeded.entityOf(WORLD.both.address);
      const wren = seeded.entityOf(WORLD.workOnly.address);
      const pat = seeded.entityOf(WORLD.ownOnly.address);
      const list = await store.admin.lists.createList(NAME, req());
      for (const person of [blake, wren, pat]) await store.admin.lists.addToList(list, person, req());
      expect(await membersOf(store, list)).toEqual([blake, wren, pat].sort());

      // A re-derive: Pat's address became the owner's (a send-as address), so Pat is gone and the
      // owner is no member; Blake and Wren stay members.
      await addOwnerAddressUnderived(store.db, WORLD.ownOnly.address, "own");
      expect(await store.writer.rederiveIfNeeded(seeded.derive)).toMatchObject({ rederived: true });
      const after = await membersOf(store, list);
      expect(after).toHaveLength(2);
      const blakeNow = (
        await queryAs<{ entity_id: EntityId }>(
          store.db.urls.admin,
          "select entity_id from knowledge.accounts where value_fp = $1",
          [fingerprint(store.db.keys, "address", WORLD.both.address)],
        )
      )[0]?.entity_id;
      const wrenNow = (
        await queryAs<{ entity_id: EntityId }>(
          store.db.urls.admin,
          "select entity_id from knowledge.accounts where value_fp = $1",
          [fingerprint(store.db.keys, "address", WORLD.workOnly.address)],
        )
      )[0]?.entity_id;
      expect(after).toEqual([blakeNow, wrenNow].sort());

      // A new id for Blake: the same addresses under another entity keep the membership.
      const renewed = await session(store.db.urls.admin, async (query) => {
        const id = (await seeder(store.db, query).entity("person")) as EntityId;
        await query("update knowledge.accounts set entity_id = $2 where entity_id = $1", [blakeNow, id]);
        return id;
      });
      expect(await membersOf(store, list)).toEqual([renewed, wrenNow].sort());

      // An identity merge: Wren's accounts joined to Blake's person. One member, the merged person.
      await queryAs(store.db.urls.admin, "update knowledge.accounts set entity_id = $2 where entity_id = $1", [
        wrenNow,
        renewed,
      ]);
      expect(await membersOf(store, list)).toEqual([renewed]);
    }));

  it("an erasure deletes the member rows holding an erased address's fingerprint, and counts them on a dry run", () =>
    withWorld(async (store, seeded) => {
      const list = await store.admin.lists.createList(NAME, req());
      await store.admin.lists.addToList(list, seeded.entityOf(WORLD.ownOnly.address), req());
      await store.admin.lists.addToList(list, seeded.entityOf(WORLD.both.address), req());
      const hook = (ERASURE_HOOKS as ErasureHook[]).find((one) => one.name === "owner_list_members");
      if (hook === undefined) throw new Error("no owner_list_members hook");
      const names = ERASURE_HOOKS.map((one) => one.name);
      expect(names.indexOf("owner_list_members")).toBe(names.indexOf("tier_rulings") + 1);
      const input = {
        evidenceIds: [],
        refs: [],
        addressFps: [fingerprint(store.db.keys, "address", WORLD.ownOnly.address)],
        sources: [],
        records: [],
        recordEvidenceIds: [],
        erasureId: null,
        factKeyFps: [],
        nameFps: [],
        claimKeys: [],
        claimIds: [],
      } as Parameters<ErasureHook["run"]>[1];
      const adminDb = createDb(store.db.urls.admin, recordingLogger().log);
      try {
        expect(
          await adminDb.transaction((query) =>
            hook.run(query, input, { dryRun: true, now: new Date(), keys: store.db.keys }),
          ),
        ).toBe(1);
        expect(
          await queryAs(store.db.urls.admin, "select count(*)::int as n from knowledge.owner_list_members"),
        ).toEqual([{ n: 2 }]);
        expect(
          await adminDb.transaction((query) =>
            hook.run(query, input, { dryRun: false, now: new Date(), keys: store.db.keys }),
          ),
        ).toBe(1);
      } finally {
        await adminDb.close();
      }
      expect(await membersOf(store, list)).toEqual([seeded.entityOf(WORLD.both.address)]);
    }));

  it("no agent reads a list: the reader, writer and pipeline hold nothing on either table", () =>
    withWorld(async (store) => {
      await store.admin.lists.createList(NAME, req());
      for (const url of [store.db.urls.reader, store.db.urls.writer, store.db.urls.pipeline]) {
        for (const table of ["knowledge.owner_lists", "knowledge.owner_list_members"]) {
          await expect(queryAs(url, `select count(*) from ${table}`), `${url} ${table}`).rejects.toMatchObject({
            code: "42501",
          });
        }
      }
      // The positive control.
      expect(await queryAs(store.db.urls.admin, "select count(*)::int as n from knowledge.owner_lists")).toEqual([
        { n: 1 },
      ]);
    }));
});
