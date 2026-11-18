import { ConnectorCursor, type EvidenceId, type SourceDeletion } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { QUENTIN, SOLO } from "../test-support/cast.ts";
import { addOwnerAddressUnderived, one, session } from "../test-support/connections.ts";
import { fingerprint, sealRow } from "../test-support/database.ts";
import { derive, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
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
import { seeder } from "../test-support/seeder.ts";
import { evidenceIdOf } from "../test-support/values.ts";

// The writer removes what was extracted: at a deletion, a reconcile and a new revision, and at a
// re-derive, where it keeps the status rows at generation 0 and the saved calls. Claims and beliefs
// are written through the Pipeline.

const TIMEOUT = 240_000;
const evidence = (value: string): EvidenceId => value as EvidenceId;
const deletion = (store: PipelineStore, sourceItemId: string): SourceDeletion =>
  ({ sourceAccount: store.accounts.personalMail.id, sourceItemId }) as SourceDeletion;
const entityOf = async (store: PipelineStore, address: string): Promise<string> =>
  one(
    await rowsOf<{ entity_id: string }>(store.db, "select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(store.db.keys, "address", address),
    ]),
  ).entity_id;

// Everything an item can have extracted: two claims, one naming Quentin, a belief on them, an
// unmapped claim, a saved call, a review, a status row; and a usage row and a run row, which name
// no item.
async function extracted(store: PipelineStore, evidenceId: string): Promise<void> {
  const { pipeline, owner, db } = store;
  const quentin = await entityOf(store, QUENTIN.address);
  const claims = [
    claimRecord(evidenceId, "own", owner, { n: 1, entities: [quentin] }),
    claimRecord(evidenceId, "own", owner, { n: 2 }),
  ];
  expect(
    await pipeline.commit(
      batchOf(evidenceId, claims, {
        unmapped: [{ id: `u-${evidenceId}`, proposedType: "commitment", reason: "bad_fields" }],
      }),
    ),
  ).toBe("committed");
  await pipeline.calls("configured/model").save({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_correspondence",
      promptVersion: "1",
      inputHash: "a".repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: '{"claims":[],"narrowing":"none"}',
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);
  await session(db.urls.admin, (query) => seeder(db, query).review(["own"], evidenceId));
  await pipeline.recordUsage({
    promptId: "personal_correspondence",
    promptVersion: "1",
    modelId: "configured/model",
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd: 1,
    outcome: "ok",
    evidenceId: evidence(evidenceId),
  });
  await pipeline.recordRun({
    code: "ok",
    counts: {
      done: 1,
      skipped: 0,
      withheld: 0,
      failed: 0,
      waiting: 0,
      claims: 2,
      unmapped: 1,
      unresolved: 0,
      liveCalls: 1,
      beliefs: 1,
      beliefsChanged: 1,
      beliefsMixed: 0,
      beliefsFailed: 0,
      beliefsRemoved: 0,
      rebuildMs: 1,
    },
  });
}

const ITEM_TABLES = [
  "knowledge.claims",
  "knowledge.claim_entities",
  "vault.unmapped_claims",
  "vault.model_calls",
  "vault.extraction_reviews",
  "vault.pipeline_items",
];
const counts = async (store: PipelineStore): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      [...ITEM_TABLES, "vault.model_usage", "vault.extraction_runs"].map(
        async (table) => [table, await countOf(store.db, table)] as const,
      ),
    ),
  );
const FULL = {
  "knowledge.claims": 2,
  "knowledge.claim_entities": 1,
  "vault.unmapped_claims": 1,
  "vault.model_calls": 1,
  "vault.extraction_reviews": 1,
  "vault.pipeline_items": 1,
  "vault.model_usage": 1,
  "vault.extraction_runs": 1,
};
const EMPTY = {
  ...Object.fromEntries(ITEM_TABLES.map((table) => [table, 0])),
  "vault.model_usage": 1,
  "vault.extraction_runs": 1,
};

describe("the writer removes what was extracted", { timeout: TIMEOUT }, () => {
  it("a deleted message leaves no claim, belief, saved call, status row or review, and a usage row and a run row outlive it", () =>
    withPipeline(async (store) => {
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      await extracted(store, id);
      expect(await counts(store)).toEqual(FULL);
      await store.writer.applyDeletion(store.accounts.personalMail, deletion(store, mailSourceId(MAIL.canary)));
      expect(await counts(store)).toEqual(EMPTY);
      expect(await countOf(store.db, "vault.evidence_items", "id = $1", [id])).toBe(0);
    }));

  it("junk removal takes the item's claims with it", () =>
    withPipeline(async (store) => {
      // Sync removes a message that became junk by the same deletion.
      const id = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      await extracted(store, id);
      await store.writer.applyDeletion(store.accounts.personalMail, deletion(store, mailSourceId(MAIL.fromQuentin)));
      expect(await counts(store)).toEqual(EMPTY);
    }));

  it("a reconcile takes an unlisted item's claims with it", () =>
    withPipeline(async (store) => {
      const gone = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
      const kept = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
      await extracted(store, gone);
      await store.pipeline.commit(batchOf(kept, [claimRecord(kept, "own", store.owner, { n: 9 })]));
      const result = await store.writer.finishPage(store.accounts.personalMail, {
        listing: { first: true, ended: "complete" },
        listedIds: [mailSourceId(MAIL.solo)],
        skippedIds: [],
        next: ConnectorCursor.parse("cursor-ext-1"),
      });
      expect(result).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
      expect(await countOf(store.db, "knowledge.claims")).toBe(1);
      expect(await countOf(store.db, "knowledge.claims", "evidence_id = $1", [kept])).toBe(1);
    }));

  it("a new revision takes the earlier revision's claims, call, status row and review with it", () =>
    withPipeline(async (store) => {
      const first = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
      await extracted(store, first);
      await store.writer.ingestItem(
        store.accounts.personalMail,
        mailRevision(MAIL.soloAgain, store.accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      expect(await counts(store)).toEqual(EMPTY);
      const second = evidenceIdOf(store.accounts.personalMail, mailSourceId(MAIL.solo), 1);
      expect(await countOf(store.db, "vault.evidence_items", "id = any ($1)", [[first, second]])).toBe(2);
      // A repeat of the latest revision removes nothing.
      expect(await store.pipeline.commit(batchOf(second, [claimRecord(second, "own", store.owner)]))).toBe("committed");
      expect(
        await store.writer.ingestItem(
          store.accounts.personalMail,
          mailRevision(MAIL.soloAgain, store.accounts.personalMail),
          mailFacts(MAIL.soloAgain),
        ),
      ).toBe("repeat");
      expect(await countOf(store.db, "knowledge.claims")).toBe(1);
    }));

  it("a person named only by a claim stays while the claim does, and goes with it", () =>
    withPipeline(async (store) => {
      const { writer, accounts, pipeline, owner, db } = store;
      // Solo is on one message only; the canary message's claim names Solo too.
      await stored(writer, accounts.personalMail, MAIL.solo);
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const solo = await entityOf(store, SOLO.address);
      await pipeline.commit(batchOf(canary, [claimRecord(canary, "own", owner, { entities: [solo] })]));

      await writer.applyDeletion(accounts.personalMail, deletion(store, mailSourceId(MAIL.solo)));
      expect(await countOf(db, "knowledge.entities", "id = $1", [solo])).toBe(1);
      expect(await countOf(db, "knowledge.accounts", "entity_id = $1", [solo])).toBe(1);

      await writer.applyDeletion(accounts.personalMail, deletion(store, mailSourceId(MAIL.canary)));
      expect(await countOf(db, "knowledge.entities", "id = $1", [solo])).toBe(0);
      expect(await countOf(db, "knowledge.accounts", "entity_id = $1", [solo])).toBe(0);
    }));

  it("after a re-derive every message is due, and the saved calls are all still there", () =>
    withPipeline(async (store) => {
      const { writer, accounts, pipeline, db } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      await extracted(store, canary);
      await pipeline.commit(batchOf(solo, [], { status: "skipped", code: "bulk", lane: "skip" }));
      expect(await pipeline.due(10, 1)).toEqual([]);

      await addOwnerAddressUnderived(db, QUENTIN.address, "own");
      expect(await writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });

      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId).sort()).toEqual([canary, solo].sort());
      expect(await counts(store)).toEqual({
        ...EMPTY,
        "vault.model_calls": 1,
        "vault.extraction_reviews": 1,
        "vault.pipeline_items": 2,
      });
      expect(await rowsOf(db, "select distinct extractor_generation from vault.pipeline_items")).toEqual([
        { extractor_generation: 0 },
      ]);
    }));

  it("a re-derive keeps the owner's lane and the owner's release", () =>
    withPipeline(async (store) => {
      const { writer, accounts, pipeline, db } = store;
      const skipped = await stored(writer, accounts.personalMail, MAIL.canary);
      const released = await stored(writer, accounts.personalMail, MAIL.solo);
      const seal = (id: string, facts: object) =>
        sealRow(db.keys, "own", { table: "vault.pipeline_items", id, column: "facts_enc" }, JSON.stringify(facts));
      const facts = { attempts: 0, claims: 0, unmapped: 0, unresolved: 0, status: "skipped", code: "bulk" };
      await rowsOf(
        db,
        "insert into vault.pipeline_items (evidence_id, waiting, extractor_generation, facts_enc, compartments) values ($1, false, 1, $2, '{own}'), ($3, false, 1, $4, '{own}')",
        [
          skipped,
          seal(skipped, { ...facts, lane: "skip", laneOverride: "skip", override: false }),
          released,
          seal(released, { ...facts, lane: "correspondence", override: true, status: "done", code: undefined }),
        ],
      );
      await addOwnerAddressUnderived(db, QUENTIN.address, "own");
      await writer.rederiveIfNeeded(derive);
      const due = await pipeline.due(10, 1);
      // The item sent to skip comes back with the owner's lane, so it is not sent to the vendor;
      // the released one keeps its release, so its narrowing is not read again.
      expect(due.find((item) => item.evidenceId === skipped)).toMatchObject({ lane: "skip", override: false });
      expect(due.find((item) => item.evidenceId === released)).toMatchObject({ override: true });
      expect(due.find((item) => item.evidenceId === released)).not.toHaveProperty("lane");
    }));
});
