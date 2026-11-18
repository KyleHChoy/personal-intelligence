import { ConnectorCursor, type EvidenceId, type SourceDeletion } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { CANARY_PERSON, QUENTIN } from "../test-support/cast.ts";
import { addOwnerAddressUnderived, one } from "../test-support/connections.ts";
import { fingerprint } from "../test-support/database.ts";
import { derive, type MailFixture, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  batchOf,
  claimRecord,
  countOf,
  type PipelineStore,
  rowsOf,
  stored,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { holdingLock as holding, outcome, pending } from "../test-support/waits.ts";

// The tests on two connections. One connection holds a lock and stays open; the other's call is
// started and not awaited, shown not to have settled, and awaited once the first commits. The
// writer's transaction is held at its beliefs lock: a connection of the test holds that lock, so
// the writer has already taken the message row and the evidence rows when it waits.

const TIMEOUT = 240_000;
const BELIEFS = "select pg_advisory_xact_lock(hashtext('intelligence personal beliefs'))";
const evidence = (value: string): EvidenceId => value as EvidenceId;

const deletionOf = (store: PipelineStore, fixture: MailFixture): SourceDeletion =>
  ({ sourceAccount: store.accounts.personalMail.id, sourceItemId: mailSourceId(fixture) }) as SourceDeletion;

// The writer's three ways of removing an item, each started now and left to wait.
const removals: Record<string, (store: PipelineStore) => Promise<unknown>> = {
  "a deletion the source named": (store) =>
    store.writer.applyDeletion(store.accounts.personalMail, deletionOf(store, MAIL.solo)),
  "a reconcile": (store) =>
    store.writer.finishPage(store.accounts.personalMail, {
      listing: { first: true, ended: "complete" },
      listedIds: [],
      skippedIds: [],
      next: ConnectorCursor.parse("cursor-locks-1"),
    }),
  "a new revision": (store) =>
    store.writer.ingestItem(
      store.accounts.personalMail,
      mailRevision(MAIL.soloAgain, store.accounts.personalMail),
      mailFacts(MAIL.soloAgain),
    ),
};
const answers: Record<string, string> = {
  "a deletion the source named": "gone",
  "a reconcile": "gone",
  "a new revision": "superseded",
};

describe("the pipeline and the writer, on two connections", { timeout: TIMEOUT }, () => {
  for (const [path, remove] of Object.entries(removals)) {
    it(`a commit that waited on the writer's lock writes nothing once the item is removed: ${path}`, () =>
      withPipeline(async (store) => {
        const id = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
        // A first revision's earlier claim, so a new revision has something to remove too.
        await store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 1 })]));
        const lock = await holding(store.db.urls.admin, BELIEFS);
        const writer = remove(store);
        expect(await pending(writer)).toBe(true);
        // The writer holds the evidence rows `for update`: the commit waits on them.
        const commit = store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 2 })]));
        expect(await pending(commit)).toBe(true);
        await lock.release();
        await writer;
        expect(await commit).toBe(answers[path]);
        expect(await countOf(store.db, "knowledge.claims")).toBe(0);
        expect(await countOf(store.db, "vault.pipeline_items")).toBe(0);
      }));
  }

  it("a writer that waited on a commit removes what the commit wrote", () =>
    withPipeline(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
      // The commit's transaction is held at the beliefs lock, after its share lock, because the
      // item has a claim to delete.
      await store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 1 })]));
      const lock = await holding(store.db.urls.admin, BELIEFS);
      const commit = store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 2 })]));
      expect(await pending(commit)).toBe(true);
      const writer = store.writer.applyDeletion(store.accounts.personalMail, deletionOf(store, MAIL.solo));
      expect(await pending(writer)).toBe(true);
      await lock.release();
      expect(await commit).toBe("committed");
      await writer;
      expect(await countOf(store.db, "knowledge.claims")).toBe(0);
      expect(await countOf(store.db, "vault.pipeline_items")).toBe(0);
    }));

  it("a release and a deletion of the same message both finish", () =>
    withPipeline(async (store) => {
      const held: MailFixture = { ...MAIL.solo, held: true };
      await stored(store.writer, store.accounts.personalMail, held);
      const message = one(await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages")).id;
      const { log } = recordingLogger();
      const admin = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log });
      try {
        // The message row held by a third connection, so both wait on it, in this order.
        const lock = await holding(store.db.urls.admin, "select 1 from knowledge.messages where id = $1 for update", [
          message,
        ]);
        const release = outcome(admin.held.releaseHeld({ id: message }));
        expect(await pending(release)).toBe(true);
        const writer = outcome(store.writer.applyDeletion(store.accounts.personalMail, deletionOf(store, MAIL.solo)));
        expect(await pending(writer)).toBe(true);
        await lock.release();
        // Neither ends in a deadlock: the release finds its message, and the deletion follows.
        expect(await release).toEqual({ released: 1 });
        expect(await writer).toEqual({ recordsRemoved: 0 });
      } finally {
        await admin.close();
      }
      expect(await countOf(store.db, "knowledge.messages")).toBe(0);
    }));

  for (const names of [false, true]) {
    it(`a commit during a re-derive waits, then throws, and the next run commits it: ${names ? "a claim that names a person" : "a claim that names nobody"}`, () =>
      withPipeline(async (store) => {
        const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
        // The canary person, who stays a person through the re-derive under a new id.
        const person = async (): Promise<string> =>
          one(
            await rowsOf<{ entity_id: string }>(
              store.db,
              "select entity_id from knowledge.accounts where value_fp = $1",
              [fingerprint(store.db.keys, "address", CANARY_PERSON.address)],
            ),
          ).entity_id;
        const entities = names ? [await person()] : [];
        expect(await store.pipeline.open(evidence(id))).not.toBeNull();
        // A re-derive is needed: an owner address is held by a person too.
        await addOwnerAddressUnderived(store.db, QUENTIN.address, "own");
        const lock = await holding(store.db.urls.admin, BELIEFS);
        const rederive = store.writer.rederiveIfNeeded(derive);
        expect(await pending(rederive)).toBe(true);
        const commit = outcome(store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { entities })])));
        expect(await pending(commit)).toBe(true);
        await lock.release();
        expect(await rederive).toMatchObject({ rederived: true });
        // The evidence row was rewritten under the opened item: the commit fails whatever its
        // claims name, and writes nothing.
        expect(await commit).toEqual({ rejected: "item_changed" });
        expect(await countOf(store.db, "knowledge.claims")).toBe(0);
        expect(await countOf(store.db, "vault.pipeline_items")).toBe(0);

        // The next run opens it again, under the re-derived identity, and commits.
        expect(await store.pipeline.open(evidence(id))).not.toBeNull();
        expect(
          await store.pipeline.commit(
            batchOf(id, [claimRecord(id, "own", store.owner, { entities: names ? [await person()] : [] })]),
          ),
        ).toBe("committed");
      }));
  }

  // Where a re-derive meets a commit: the re-derive locks the entity rows it deletes, and a commit
  // takes an entity row (its claim_entities' foreign key) after its evidence row. A re-derive that
  // started while a commit held its evidence row waits for that commit, and neither is aborted by a
  // deadlock.
  it("a re-derive and a commit at once both finish: the commit holds its evidence row and then names a person", () =>
    withPipeline(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const person = one(
        await rowsOf<{ entity_id: string }>(store.db, "select entity_id from knowledge.accounts where value_fp = $1", [
          fingerprint(store.db.keys, "address", CANARY_PERSON.address),
        ]),
      ).entity_id;
      // A first claim, so the second commit has one to delete and takes the beliefs lock after
      // its share lock: it is held there with the evidence row locked.
      await store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 1 })]));
      expect(await store.pipeline.open(evidence(id))).not.toBeNull();
      await addOwnerAddressUnderived(store.db, QUENTIN.address, "own");
      const lock = await holding(store.db.urls.admin, BELIEFS);
      const commit = outcome(
        store.pipeline.commit(batchOf(id, [claimRecord(id, "own", store.owner, { n: 2, entities: [person] })])),
      );
      expect(await pending(commit)).toBe(true);
      const rederive = outcome(store.writer.rederiveIfNeeded(derive));
      expect(await pending(rederive)).toBe(true);
      await lock.release();
      // The commit ran first, whole; the re-derive then removed what it wrote and made the item due
      // again. A deadlock would reject one of the two with 40P01.
      expect(await commit).toBe("committed");
      expect(await rederive).toMatchObject({ rederived: true });
      expect(await countOf(store.db, "knowledge.claims")).toBe(0);
      expect(await countOf(store.db, "knowledge.claim_entities")).toBe(0);
      expect(await rowsOf(store.db, "select extractor_generation from vault.pipeline_items")).toEqual([
        { extractor_generation: 0 },
      ]);
    }));
});
