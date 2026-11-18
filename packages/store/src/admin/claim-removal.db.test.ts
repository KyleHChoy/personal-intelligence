import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
// The fixtures first: they load the admin, whose imports settle the store's module cycle.
import { one, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD } from "../test-support/world.ts";
import { Admin } from "./admin.ts";

// Each owner command that removes claims still does, as pi_admin. Synthetic people only.

const OWN = ["own"];
const RUNTIME = [
  "pi_admin",
  "pi_writer",
  "pi_reader",
  "pi_pipeline",
  "pi_work",
  "pi_proxy",
  "pi_restricted",
  "pi_notify",
];
const REMOVERS = [
  "knowledge.remove_claims(text[])",
  "knowledge.remove_extracted_claims()",
  "knowledge.remove_person_links(text[])",
];

const req = (): string => testId("req");
const sql = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where: string, values: unknown[]): Promise<number> =>
  one(await sql<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;

type World = { store: TestStore; db: TestDatabase; admin: Admin; blake: EntityId; pat: EntityId };

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-claim-removal-"));
  const store = await openStore({ now: new Date("2026-03-10T12:00:00.000Z") });
  try {
    const seeded = await seedWorld(store.writer, store.admin);
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      recordEnabled: true,
    });
    await fn({
      store,
      db: store.db,
      admin,
      blake: seeded.entityOf(WORLD.both.address) as EntityId,
      pat: seeded.entityOf(WORLD.ownOnly.address) as EntityId,
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// An extracted claim on one of the world's mail items, naming the person, as pi_admin inserts it.
async function extractedClaim(world: World, person: EntityId): Promise<string> {
  const [item] = await sql<{ id: string }>(
    world.db,
    "select id from vault.evidence_items where source_kind <> 'owner_command' and compartments = '{own}' order by id limit 1",
  );
  if (item === undefined) throw new Error("the world holds no own item");
  return session(world.db.urls.admin, async (query) => {
    const seed = seeder(world.db, query);
    const claim = await seed.claim(OWN, item.id);
    await seed.claimEntity(OWN, claim, person);
    return claim;
  });
}

describe("claim removal", { timeout: DB_TEST_TIMEOUT }, () => {
  it("no runtime role may update a claim or its entity rows; pi_admin reads and inserts them and deletes neither, and the writer still deletes", () =>
    inWorld(async (world) => {
      const { db } = world;
      for (const table of ["knowledge.claims", "knowledge.claim_entities"])
        expect(
          await sql<{ role: string }>(
            db,
            "select r as role from unnest($1::text[]) r where has_table_privilege(r, $2, 'UPDATE') order by 1",
            [RUNTIME, table],
          ),
          table,
        ).toEqual([]);
      // pi_admin inserts: the positive control of its grant.
      const claim = await extractedClaim(world, world.blake);
      expect(await count(db, "knowledge.claims", "id = $1", [claim])).toBe(1);
      for (const statement of [
        "update knowledge.claims set type = type where id = $1",
        "delete from knowledge.claims where id = $1",
        "update knowledge.claim_entities set compartments = compartments where claim_id = $1",
        "delete from knowledge.claim_entities where claim_id = $1",
      ])
        expect(await sqlState(() => sql(db, statement, [claim])), statement).toBe("42501");
      // The writer, which removes what a source no longer says, still may.
      await queryAs(db.urls.writer, "delete from knowledge.claim_entities where claim_id = $1", [claim]);
      await queryAs(db.urls.writer, "delete from knowledge.claims where id = $1", [claim]);
      expect(await count(db, "knowledge.claims", "id = $1", [claim])).toBe(0);
    }));

  it("the removal functions are definers owned by pi_owner with a pinned search path, executed by pi_admin and pi_writer alone", () =>
    inWorld(async (world) => {
      const rows = await queryAs<{ fn: string; definer: boolean; owner: string; config: string[]; roles: string[] }>(
        world.db.urls.admin,
        `select f as fn, p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                array(select r from unnest($2::text[]) r where has_function_privilege(r, p.oid, 'EXECUTE') order by 1) as roles
         from unnest($1::text[]) f join pg_proc p on p.oid = to_regprocedure(f) order by 1`,
        [REMOVERS, [...RUNTIME, "public"]],
      );
      expect(rows).toEqual(
        [...REMOVERS].sort().map((fn) => ({
          fn,
          definer: true,
          owner: "pi_owner",
          config: ["search_path=pg_catalog, policy, pg_temp"],
          roles: ["pi_admin", "pi_writer"],
        })),
      );
      const claim = await extractedClaim(world, world.blake);
      for (const url of [world.db.urls.reader, world.db.urls.pipeline])
        expect(await sqlState(() => queryAs(url, "select knowledge.remove_claims($1)", [[claim]]))).toBe("42501");
      // remove_person_links takes only an owner command's links: an extracted claim's stay.
      await sql(world.db, "select knowledge.remove_person_links($1)", [[claim]]);
      expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [claim])).toBe(1);
      // remove_claims takes the claim and its entity rows.
      await sql(world.db, "select knowledge.remove_claims($1)", [[claim]]);
      expect(await count(world.db, "knowledge.claims", "id = $1", [claim])).toBe(0);
      expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [claim])).toBe(0);
    }));

  it("erasing an owner item and erasing a person remove their claims, as pi_admin", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: "canary-removal-note" },
        { requestId: req() },
      );
      await world.admin.erasure.eraseOwnerItem(note, { requestId: req() });
      expect(await count(world.db, "knowledge.claims", "id = $1", [note])).toBe(0);
      expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [note])).toBe(0);

      const extracted = await extractedClaim(world, world.blake);
      const second = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: "canary-removal-second" },
        { requestId: req() },
      );
      await world.admin.erasure.erasePerson(world.blake, { requestId: req() });
      for (const claim of [extracted, second]) {
        expect(await count(world.db, "knowledge.claims", "id = $1", [claim]), claim).toBe(0);
        expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [claim]), claim).toBe(0);
      }
    }));

  it("the owner's re-derive (pi owner add-address) removes every extracted claim and keeps an owner note with its person link, as pi_admin", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: "canary-removal-kept" },
        { requestId: req() },
      );
      const extracted = await extractedClaim(world, world.blake);
      expect(await world.admin.accounts.addOwnerAddress(WORLD.ownOnly.address, "own")).toMatchObject({
        rederived: true,
      });
      expect(await count(world.db, "knowledge.claims", "id = $1", [extracted])).toBe(0);
      expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [extracted])).toBe(0);
      expect(await count(world.db, "knowledge.claims", "id = $1", [note])).toBe(1);
      // Blake keeps an id by address across a re-derive, so the note's link is put back on Blake.
      expect(await sql(world.db, "select entity_id from knowledge.claim_entities where claim_id = $1", [note])).toEqual(
        [{ entity_id: world.blake }],
      );
    }));
});
