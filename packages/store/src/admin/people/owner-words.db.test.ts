import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BELIEF_TYPES, ClaimRecord, type EntityId, type FactId, type RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { readJournal } from "../../core/journal.ts";
import { openedUnder } from "../../core/tx.ts";
import { testId } from "../../test-support/clients.ts";
// The fixtures first: they load the admin, whose imports settle the store's module cycle.
import { addOwnerAddressUnderived, one } from "../../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../../test-support/database.ts";
import { beliefsComputed } from "../../test-support/pipeline-fixtures.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { seedWorld, WORLD } from "../../test-support/world.ts";
import { Admin } from "../admin.ts";

// A note is their words in one owner_command item and one claim made by code; a retire is a liftable
// ruling; erasing the person or the note removes the item, its payload and its claim; a re-derive
// keeps the note and its link to the person. Synthetic words and people only.

const WORDS = "canary-note-words met at the harbour fair";
const BIO = "canary-bio-words runs the lighthouse";

type World = {
  store: TestStore;
  db: TestDatabase;
  admin: Admin;
  journal: string;
  blake: EntityId;
  pat: EntityId;
  derive: Awaited<ReturnType<typeof seedWorld>>["derive"];
};

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-notes-"));
  const store = await openStore({ now: new Date("2026-03-10T12:00:00.000Z") });
  try {
    const seeded = await seedWorld(store.writer, store.admin);
    const journal = join(dir, "keys.json.erasures");
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal,
      recordEnabled: true,
    });
    await fn({
      store,
      db: store.db,
      admin,
      journal,
      blake: seeded.entityOf(WORLD.both.address) as EntityId,
      pat: seeded.entityOf(WORLD.ownOnly.address) as EntityId,
      derive: seeded.derive,
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const sql = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where: string, values: unknown[]): Promise<number> =>
  one(await sql<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;
const req = (): string => testId("req");

// The note's claim and item rows, as stored.
async function stored(world: World, note: FactId) {
  const claim = one(
    await sql<{
      type: string;
      readers: string[];
      compartments: string[];
      content_enc: unknown;
      evidence_id: string;
      source_kind: string;
      blob_ref: string;
      account: string;
      fp: string;
    }>(
      world.db,
      `select c.type, c.readers, c.compartments, c.content_enc, c.evidence_id, e.source_kind, e.blob_ref, e.source_account_id as account, e.source_item_fp as fp
       from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where c.id = $1`,
      [note],
    ),
  );
  const record = ClaimRecord.parse(
    JSON.parse(
      openedUnder(
        world.db.keys,
        claim.compartments,
        { table: "knowledge.claims", id: note, column: "content_enc" },
        claim.content_enc,
      ),
    ),
  );
  return { ...claim, record };
}

describe("the owner's notes and bios", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a note is an owner_command item and a claim made by code, the owner's words in neither the decision nor the log", () =>
    inWorld(async (world) => {
      const request = req();
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: WORDS },
        { requestId: request },
      );
      // A repeated request returns the first note and writes nothing more.
      expect(
        await world.admin.notes.addNote({ person: world.blake, role: "note", text: WORDS }, { requestId: request }),
      ).toBe(note);
      expect(await count(world.db, "knowledge.owner_decisions", "kind = 'note_add'", [])).toBe(1);

      const row = await stored(world, note);
      expect(row).toMatchObject({
        type: "owner_note",
        readers: ["m-owner"],
        compartments: ["own"],
        source_kind: "owner_command",
      });
      expect(row.record).toMatchObject({
        origin: "owner_command",
        subjectKind: "person",
        claim: { content: { type: "owner_note", subject: world.blake, fields: { role: "note", text: WORDS } } },
      });
      expect(
        await count(world.db, "knowledge.claim_entities", "claim_id = $1 and entity_id = $2", [note, world.blake]),
      ).toBe(1);
      // The decision names the person and holds no words.
      expect(
        one(
          await sql<{ target_id: string; body: unknown }>(
            world.db,
            "select target_id, body_enc as body from knowledge.owner_decisions where kind = 'note_add'",
          ),
        ),
      ).toEqual({
        target_id: world.blake,
        body: null,
      });
      // No belief is built of it, and no log line carries a word of it.
      expect(
        (await beliefsComputed(world.db, ["own"], BELIEF_TYPES, new Date().toISOString())).filter((one) =>
          one.belief.support.some((id) => fingerprint(world.db.keys, "claim", id) === note),
        ),
      ).toEqual([]);
      expect(JSON.stringify(world.store.log.events)).not.toContain("canary-note-words");

      // Only a person takes a note.
      const owner = one(
        await sql<{ id: EntityId }>(world.db, "select id from knowledge.entities where kind = 'owner'"),
      ).id;
      await expect(
        world.admin.notes.addNote({ person: owner, role: "note", text: WORDS }, { requestId: req() }),
      ).rejects.toMatchObject({ code: "not_a_person" });
    }));

  it("a retire hides a note until lifted; an edit is a new note and the old one's retire; bios come first", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: WORDS },
        { requestId: req() },
      );
      const bio = await world.admin.notes.addNote(
        { person: world.blake, role: "bio", text: BIO },
        { requestId: req() },
      );
      expect((await world.admin.notes.listNotes(world.blake)).map((one) => [one.note, one.role, one.text])).toEqual([
        [bio, "bio", BIO],
        [note, "note", WORDS],
      ]);

      const ruling: RulingId = await world.admin.notes.retireNote(note, { requestId: req() });
      expect((await world.admin.notes.listNotes(world.blake)).map((one) => one.note)).toEqual([bio]);
      await world.admin.facts.liftRuling(ruling, { requestId: req() });
      expect((await world.admin.notes.listNotes(world.blake)).map((one) => one.note)).toEqual([bio, note]);

      const edited = await world.admin.notes.addNote(
        { person: world.blake, role: "bio", text: `${BIO} and the ferry`, replaces: bio },
        { requestId: req() },
      );
      expect((await world.admin.notes.listNotes(world.blake)).map((one) => one.note)).toEqual([edited, note]);
      // An id that is no note is refused.
      await expect(world.admin.notes.retireNote("0".repeat(64) as FactId, { requestId: req() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  it("erasing the person removes the note's claim, item and payload, and journals its item", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: WORDS },
        { requestId: req() },
      );
      const row = await stored(world, note);
      await world.admin.erasure.erasePerson(world.blake, { requestId: req() });
      expect(await count(world.db, "knowledge.claims", "id = $1", [note])).toBe(0);
      expect(await count(world.db, "vault.evidence_items", "id = $1", [row.evidence_id])).toBe(0);
      expect(await count(world.db, "vault.evidence_blobs", "blob_ref = $1", [row.blob_ref])).toBe(0);
      // A restore's replay removes it again: the journal names its item.
      const [entry] = (await readJournal(world.journal)).entries;
      expect(entry).toMatchObject({ kind: "person" });
      expect((entry as { items: { account: string; fp: string }[] }).items).toContainEqual({
        account: row.account,
        fp: row.fp,
      });
    }));

  it("erasing the note by its id removes its claim, item and payload, and leaves the person", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: WORDS },
        { requestId: req() },
      );
      const row = await stored(world, note);
      await world.admin.erasure.eraseOwnerItem(note, { requestId: req() });
      expect(await count(world.db, "knowledge.claims", "id = $1", [note])).toBe(0);
      expect(await count(world.db, "vault.evidence_items", "id = $1", [row.evidence_id])).toBe(0);
      expect(await count(world.db, "vault.evidence_blobs", "blob_ref = $1", [row.blob_ref])).toBe(0);
      expect(await count(world.db, "knowledge.entities", "id = $1", [world.blake])).toBe(1);
      await expect(world.admin.erasure.eraseOwnerItem(note, { requestId: req() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  it("a re-derive keeps a note and its link to its person, and succeeds when the person is gone", () =>
    inWorld(async (world) => {
      const note = await world.admin.notes.addNote(
        { person: world.blake, role: "note", text: WORDS },
        { requestId: req() },
      );
      const patNote = await world.admin.notes.addNote(
        { person: world.pat, role: "note", text: WORDS },
        { requestId: req() },
      );
      // Pat's address made the owner's: a re-derive is due, and removes Pat.
      await addOwnerAddressUnderived(world.db, WORLD.ownOnly.address, "own");
      expect(await world.store.writer.rederiveIfNeeded(world.derive)).toMatchObject({ rederived: true });
      expect((await world.admin.notes.listNotes(world.blake)).map((one) => [one.note, one.text])).toEqual([
        [note, WORDS],
      ]);
      // Pat is gone; the note stays, linked to no one, until the owner erases it.
      expect(await count(world.db, "knowledge.entities", "id = $1", [world.pat])).toBe(0);
      expect(await count(world.db, "knowledge.claims", "id = $1", [patNote])).toBe(1);
      expect(await count(world.db, "knowledge.claim_entities", "claim_id = $1", [patNote])).toBe(0);
      // Erasing Blake after the re-derive still reaches the note.
      await world.admin.erasure.erasePerson(world.blake, { requestId: req() });
      expect(await count(world.db, "knowledge.claims", "id = $1", [note])).toBe(0);
    }));
});
