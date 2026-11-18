import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim, EvidenceId, ModelCallRecord } from "@intelligence/contracts";
import { type ClaimRecord, DocumentId, type ReadOutcome } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DocBody, type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { openRow } from "../core/seal.ts";
import { type Accounts, connect, OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, countOf, rowsOf } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { evidenceIdOf, registration } from "../test-support/values.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { createPipeline, type Pipeline } from "./pipeline.ts";

// The store's side of documents in extraction: documents as items of extraction, through the Pipeline
// as pi_pipeline, on hand-written records. No model is called and nothing of
// @intelligence/personal-extract is imported. Every refusal has its positive control.

const TIMEOUT = 240_000;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const FOLDER = "fldPipeDocsRoot0001";
const REFERENCE_FOLDER = "fldPipeDocsReference0001";
const WORK_FOLDER = "fldPipeDocsWork0001";
// The run's start less an hour: what `pi extract` passes as settledBefore.
const SETTLED = "2026-09-20T11:00:00.000Z";

type Docs = {
  store: TestStore;
  db: TestDatabase;
  admin: Admin;
  pipeline: Pipeline;
  accounts: Accounts;
  personal: SourceAccountRow;
  work: SourceAccountRow;
  roots: { extract: string; reference: string; work: string };
  owner: string;
};

// A database with the owner's mail accounts, a Drive account for each label, an extract root and a
// reference root for `personal` and an extract root for `work`, an Admin with a journal, and a
// Pipeline as pi_pipeline.
async function withDocs(fn: (docs: Docs) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-pipeline-docs-"));
  const store = await openStore({ now: NOW });
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const accounts = await connect(store.writer);
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      now: () => NOW,
    });
    const personal = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
    const work = await store.writer.ensureSourceAccount("work", "google_docs", "employer:example", OWNER.work);
    const roots = {
      extract: (await admin.drive.addRoot("personal", FOLDER, "extract")).id,
      reference: (await admin.drive.addRoot("personal", REFERENCE_FOLDER, "reference")).id,
      work: (await admin.drive.addRoot("work", WORK_FOLDER, "extract")).id,
    };
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    await fn({ store, db: store.db, admin, pipeline, accounts, personal, work, roots, owner });
  } finally {
    await pipeline.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A Google Doc under FOLDER, owned and last edited by the owner, unless overridden.
const file = (id: string, over: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name: `Plan ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00.000Z",
  modifiedTime: "2026-09-02T09:00:00.000Z",
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal, name: OWNER.name },
  canDownload: true,
  ...over,
});
const LUNCH = "Lunch with the harbour team on 2026-09-25.";
const body = (...texts: string[]): DocBody => ({
  blocks: [
    { kind: "heading", level: 1, text: "Plans" },
    ...texts.map((text) => ({ kind: "paragraph" as const, text })),
  ],
});
const BODY = body(LUNCH);

// Stores a file through the writer with core's own derive; answers the document's evidence id.
async function put(
  docs: Docs,
  account: SourceAccountRow,
  doc: DriveFile,
  content: DocBody | null = BODY,
): Promise<EvidenceId> {
  const ownerAddress = account.compartment === "own" ? OWNER.personal : OWNER.work;
  const raw = driveItem(doc, content, content === null ? "not_a_document" : null, {
    sourceAccount: account.id,
    changeKind: "backfill",
    ownerAddress,
  });
  const answer = await docs.store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
  if (answer !== "stored") throw new Error(`not stored: ${answer}`);
  return (await documentOf(docs, doc.id)).evidence_id as EvidenceId;
}

const documentOf = async (docs: Docs, fileId: string): Promise<{ id: DocumentId; evidence_id: string }> =>
  one(
    await rowsOf<{ id: DocumentId; evidence_id: string }>(
      docs.db,
      "select id, evidence_id from knowledge.documents where file_fp = $1",
      [fingerprint(docs.db.keys, "source_id", fileId)],
    ),
  );

const dueIds = async (
  docs: Docs,
  options: { settledBefore?: string; compartments?: string[]; generation?: number } = {},
): Promise<string[]> =>
  (
    await docs.pipeline.dueDocuments(50, options.generation ?? 1, {
      settledBefore: (options.settledBefore ?? SETTLED) as never,
      ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
    })
  ).map((one) => one.evidenceId);

// One plan claim of a document, citing `span`, as the extraction would commit it: no author, no
// counterparty, dated by the document's modified time.
function planRecord(
  evidenceId: string,
  compartment: string,
  owner: string,
  span: string,
  options: { n?: number; validFrom?: string } = {},
): ClaimRecord {
  const n = options.n ?? 1;
  const claim = {
    // The evidence's own: a claim's id is unique across documents.
    id: `${evidenceId.slice(0, 60)}${String(n).padStart(4, "0")}`,
    content: { type: "plan", subject: owner, fields: { what: LUNCH, when: "2026-09-25" } },
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: options.validFrom ?? "2026-09-02T09:00:00.000Z",
    evidence: [{ evidenceId, span }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [compartment], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: `plan ${evidenceId} ${n}`,
    lane: "document",
    fieldKinds: { what: "text", when: "date" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// A saved call for the item, as the shared replay saves one.
const savedCall = (evidenceId: string, compartment: string, inputHash = "a".repeat(64)): ModelCallRecord =>
  ({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: "personal_document",
      promptVersion: "1",
      inputHash,
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "b".repeat(64),
    label: { compartments: [compartment], readers: ["m-owner"] },
    origin: "live",
  }) as unknown as ModelCallRecord;

// The extracted rows of one evidence row, by table.
async function extractedOf(db: TestDatabase, evidenceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["knowledge.claims", "vault.model_calls", "vault.pipeline_items", "vault.unmapped_claims"])
    counts[table] = await countOf(db, table, "evidence_id = $1", [evidenceId]);
  return counts;
}
const NOTHING = {
  "knowledge.claims": 0,
  "vault.model_calls": 0,
  "vault.pipeline_items": 0,
  "vault.unmapped_claims": 0,
};

const statusFacts = async (
  db: TestDatabase,
  evidenceId: string,
): Promise<Record<string, unknown> & { waiting: boolean }> => {
  const row = one(
    await rowsOf<{ facts_enc: unknown; compartments: string[]; waiting: boolean }>(
      db,
      "select facts_enc, compartments, waiting from vault.pipeline_items where evidence_id = $1",
      [evidenceId],
    ),
  );
  const facts = JSON.parse(
    openRow(
      db.keys,
      row.compartments[0] ?? "",
      { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
      row.facts_enc as never,
    ),
  ) as Record<string, unknown>;
  return { ...facts, waiting: row.waiting };
};

// Commits one plan claim and saves one call for the document: what a run leaves for it.
async function extracted(docs: Docs, evidenceId: EvidenceId, compartment = "own"): Promise<void> {
  expect(await docs.pipeline.open(evidenceId)).not.toBeNull();
  await docs.pipeline.calls("configured/model").save(savedCall(evidenceId, compartment));
  expect(
    await docs.pipeline.commit(
      batchOf(evidenceId, [planRecord(evidenceId, compartment, docs.owner, "chars:7-49")], {
        lane: "document",
        groups: 1,
        leftOut: 0,
      }),
    ),
  ).toBe("committed");
}

const readValue = <T>(outcome: ReadOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.value;
};

describe("documents due for extraction", { timeout: TIMEOUT }, () => {
  it("a document modified inside the settle time is not due; a settled one is, newest modified first, and after takes up past the last of a page", () =>
    withDocs(async (docs) => {
      const older = await put(
        docs,
        docs.personal,
        file("1PipeOlder00001", { modifiedTime: "2026-09-02T09:00:00.000Z" }),
      );
      const newer = await put(
        docs,
        docs.personal,
        file("1PipeNewer00001", { modifiedTime: "2026-09-03T09:00:00.000Z" }),
      );
      const editing = await put(
        docs,
        docs.personal,
        file("1PipeEditing001", { modifiedTime: "2026-09-20T11:30:00.000Z" }),
      );
      expect(await dueIds(docs)).toEqual([newer, older]);
      // The positive control: once the edit has settled, it is due, first.
      expect(await dueIds(docs, { settledBefore: "2026-09-20T11:30:00.000Z" })).toEqual([editing, newer, older]);

      const [first] = await docs.pipeline.dueDocuments(1, 1, { settledBefore: SETTLED as never });
      expect(first).toMatchObject({
        evidenceId: newer,
        compartment: "own",
        modifiedAt: "2026-09-03T09:00:00.000Z",
        attempts: 0,
        override: false,
        triage: {
          reference: false,
          kind: "doc",
          mine: true,
          editedByMe: true,
          unreadable: false,
          chars: `Plans\n\n${LUNCH}`.length,
          modifiedAt: "2026-09-03T09:00:00.000Z",
        },
      });
      const after = await docs.pipeline.dueDocuments(10, 1, {
        settledBefore: SETTLED as never,
        after: { modifiedAt: first?.modifiedAt as never, evidenceId: first?.evidenceId as never },
      });
      expect(after.map((one) => one.evidenceId)).toEqual([older]);
      // No message is a due document, and no document is a due message.
      await ingestMail(docs.store.writer, docs.accounts.personalMail, MAIL.canary);
      expect(await dueIds(docs)).toEqual([newer, older]);
      expect((await docs.pipeline.due(10, 1)).map((one) => one.evidenceId)).toEqual([
        evidenceIdOf(docs.accounts.personalMail, mailSourceId(MAIL.canary)),
      ]);
    }));

  it("a document of a compartment left out is not due, and its triage row says what kind it is and whether it has text", () =>
    withDocs(async (docs) => {
      const own = await put(docs, docs.personal, file("1PipeOwn0000001"));
      const work = await put(
        docs,
        docs.work,
        file("1PipeWork000001", { parent: WORK_FOLDER, root: WORK_FOLDER, owner: { address: OWNER.work } }),
      );
      const sheet = await put(
        docs,
        docs.personal,
        file("1PipeSheet00001", {
          mimeType: "application/vnd.google-apps.spreadsheet",
          modifiedTime: "2026-09-01T09:00:00.000Z",
        }),
        null,
      );
      const shared = await put(
        docs,
        docs.personal,
        file("1PipeShared0001", {
          ownedByMe: false,
          modifiedByMe: false,
          owner: { address: "noor.lake@example.org" },
          modifiedTime: "2026-08-30T09:00:00.000Z",
        }),
      );
      expect((await dueIds(docs, { compartments: ["own"] })).sort()).toEqual([own, sheet, shared].sort());
      expect(await dueIds(docs, { compartments: ["employer:example"] })).toEqual([work]);
      // The positive control: with no compartments given, every document is due.
      expect((await dueIds(docs)).sort()).toEqual([own, work, sheet, shared].sort());
      const rows = await docs.pipeline.dueDocuments(10, 1, { settledBefore: SETTLED as never });
      expect(rows.find((one) => one.evidenceId === sheet)?.triage).toMatchObject({
        kind: "sheet",
        unreadable: true,
        chars: 0,
      });
      expect(rows.find((one) => one.evidenceId === shared)?.triage).toMatchObject({
        mine: false,
        editedByMe: false,
        unreadable: false,
      });
      expect(rows.find((one) => one.evidenceId === work)?.compartment).toBe("employer:example");
    }));

  it("a document with a status row of another generation, or marked waiting, is due; a done one is not", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeStatus0001"));
      expect(await docs.pipeline.commit(batchOf(doc, [], { lane: "document" }))).toBe("committed");
      expect(await dueIds(docs)).toEqual([]);
      expect(await dueIds(docs, { generation: 2 })).toEqual([doc]);
      await docs.pipeline.defer(doc, 1, { code: "model_unavailable", lane: "document" });
      expect(await dueIds(docs)).toEqual([doc]);
    }));

  it("a withheld document that is not waiting is not due at another generation", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeWithheld02"));
      expect(
        await docs.pipeline.commit(batchOf(doc, [], { lane: "document", status: "withheld", code: "sensitive" })),
      ).toBe("committed");
      expect(await dueIds(docs, { generation: 2 })).toEqual([]);
    }));

  it("a held document is not due, and once released it is", () =>
    withDocs(async (docs) => {
      const held = await put(
        docs,
        docs.personal,
        file("1PipeHeld000001", { name: "Your verification code backup" }),
        body("Backup code 482913."),
      );
      const open = await put(docs, docs.personal, file("1PipeOpen000001"));
      expect(await dueIds(docs)).toEqual([open]);
      expect(await countOf(docs.db, "vault.pipeline_items")).toBe(0);
      const heldId = (await documentOf(docs, "1PipeHeld000001")).id;
      expect(await docs.admin.held.releaseHeldDocuments({ id: heldId })).toEqual({ released: 1 });
      expect((await dueIds(docs)).sort()).toEqual([held, open].sort());
    }));

  it("a reference document is due only to be skipped: due with its mark, and not after its skip is committed", () =>
    withDocs(async (docs) => {
      const reference = await put(
        docs,
        docs.personal,
        file("1PipeReference1", { parent: REFERENCE_FOLDER, root: REFERENCE_FOLDER }),
      );
      const [due] = await docs.pipeline.dueDocuments(10, 1, { settledBefore: SETTLED as never });
      expect(due).toMatchObject({ evidenceId: reference, triage: { reference: true } });
      expect(
        await docs.pipeline.commit(batchOf(reference, [], { lane: "skip", status: "skipped", code: "reference" })),
      ).toBe("committed");
      expect(await dueIds(docs)).toEqual([]);
      expect(await statusFacts(docs.db, reference)).toMatchObject({
        lane: "skip",
        status: "skipped",
        code: "reference",
        waiting: false,
      });
    }));
});

describe("a document opened and committed", { timeout: TIMEOUT }, () => {
  it("openDocument opens the document's latest revision with its block whole, and opens no message", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeOpened0001"));
      const opened = await docs.pipeline.openDocument(doc);
      expect(opened?.raw.sourceKind).toBe("document");
      expect(opened?.raw.sourceItemId).toBe("drive-file:1PipeOpened0001");
      expect(opened?.context).toMatchObject({
        evidenceId: doc,
        revision: 0,
        compartment: "own",
        ownerEntity: docs.owner,
      });
      expect(Buffer.from(opened?.raw.payload ?? "", "base64").toString("utf8")).toContain(LUNCH);
      // A message's evidence id opens nothing as a document; the positive control opens it as one.
      await ingestMail(docs.store.writer, docs.accounts.personalMail, MAIL.canary);
      const message = evidenceIdOf(docs.accounts.personalMail, mailSourceId(MAIL.canary));
      expect(await docs.pipeline.openDocument(message as EvidenceId)).toBeNull();
      expect(await docs.pipeline.open(message as EvidenceId)).not.toBeNull();
      expect(await docs.pipeline.openDocument("f".repeat(64) as EvidenceId)).toBeNull();
    }));

  it("a commit records a document's groups and the passages left out in its status row, and its claims are dated as given", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeGroups0001"));
      expect(await docs.pipeline.openDocument(doc)).not.toBeNull();
      const record = planRecord(doc, "own", docs.owner, "chars:7-49");
      expect(await docs.pipeline.commit(batchOf(doc, [record], { lane: "document", groups: 2, leftOut: 3 }))).toBe(
        "committed",
      );
      expect(await statusFacts(docs.db, doc)).toMatchObject({
        lane: "document",
        status: "done",
        claims: 1,
        groups: 2,
        leftOut: 3,
        waiting: false,
      });
      const [claim] = await rowsOf<{ valid_from: Date }>(
        docs.db,
        "select valid_from from knowledge.claims where evidence_id = $1",
        [doc],
      );
      expect(claim?.valid_from.toISOString()).toBe("2026-09-02T09:00:00.000Z");
    }));

  it("a new revision removes the earlier revision's claims, saved calls and status row in its transaction, and is due again", () =>
    withDocs(async (docs) => {
      const first = await put(docs, docs.personal, file("1PipeRevision01"));
      await extracted(docs, first);
      expect(await extractedOf(docs.db, first)).toEqual({
        ...NOTHING,
        "knowledge.claims": 1,
        "vault.model_calls": 1,
        "vault.pipeline_items": 1,
      });
      const second = await put(
        docs,
        docs.personal,
        file("1PipeRevision01", { modifiedTime: "2026-09-04T09:00:00.000Z" }),
        body(LUNCH, "Bring the survey."),
      );
      expect(second).not.toBe(first);
      expect(await extractedOf(docs.db, first)).toEqual(NOTHING);
      expect(await extractedOf(docs.db, second)).toEqual(NOTHING);
      expect(await dueIds(docs)).toEqual([second]);
      // The earlier revision's own commit writes nothing: its evidence row was rewritten when its
      // original expired, so the xmin the run read has changed; a pipeline that never opened it
      // finds it superseded.
      await expect(docs.pipeline.commit(batchOf(first, [], { lane: "document" }))).rejects.toMatchObject({
        code: "item_changed",
      });
      const fresh = createPipeline({ url: docs.db.urls.pipeline, keys: docs.db.keys, log: recordingLogger().log });
      try {
        expect(await fresh.commit(batchOf(first, [], { lane: "document" }))).toBe("superseded");
      } finally {
        await fresh.close();
      }
      expect(await extractedOf(docs.db, first)).toEqual(NOTHING);
    }));

  it("a removed document, and an erased one, leave no claim, saved call or status row", () =>
    withDocs(async (docs) => {
      const deleted = await put(docs, docs.personal, file("1PipeDeleted001"));
      const erased = await put(docs, docs.personal, file("1PipeErased0001"));
      const kept = await put(docs, docs.personal, file("1PipeKept000001"));
      for (const doc of [deleted, erased, kept]) await extracted(docs, doc);
      await docs.store.writer.applyDeletion(docs.personal, {
        sourceAccount: docs.personal.id,
        sourceItemId: "drive-file:1PipeDeleted001",
        deletedAt: "2026-09-05T00:00:00.000Z",
      });
      await docs.admin.erasure.eraseItem(
        { kind: "document", id: (await documentOf(docs, "1PipeErased0001")).id },
        { requestId: testId("req") },
      );
      expect(await extractedOf(docs.db, deleted)).toEqual(NOTHING);
      expect(await extractedOf(docs.db, erased)).toEqual(NOTHING);
      // The positive control: the document left alone keeps what was extracted from it.
      expect(await extractedOf(docs.db, kept)).toEqual({
        ...NOTHING,
        "knowledge.claims": 1,
        "vault.model_calls": 1,
        "vault.pipeline_items": 1,
      });
    }));

  it("the pipeline role reads a document row and no root", () =>
    withDocs(async (docs) => {
      await put(docs, docs.personal, file("1PipeRole000001"));
      expect(
        one(await queryAs<{ n: number }>(docs.db.urls.pipeline, "select count(*)::int as n from knowledge.documents"))
          .n,
      ).toBe(1);
      expect(await sqlState(() => queryAs(docs.db.urls.pipeline, "select id from policy.drive_roots"))).toBe("42501");
      expect(await sqlState(() => queryAs(docs.db.urls.pipeline, "update knowledge.documents set held = true"))).toBe(
        "42501",
      );
      // The positive control: the admin reads the roots.
      expect(await countOf(docs.db, "policy.drive_roots")).toBe(3);
    }));
});

describe("the owner's side for documents", { timeout: TIMEOUT }, () => {
  it("setting a root's mode sets its documents back to waiting with their saved calls superseded, and is refused while a run holds the extract lock", () =>
    withDocs(async (docs) => {
      const under = await put(docs, docs.personal, file("1PipeModeUnder1"));
      const elsewhere = await put(
        docs,
        docs.personal,
        file("1PipeModeOther1", { parent: REFERENCE_FOLDER, root: REFERENCE_FOLDER }),
      );
      await extracted(docs, under);
      await extracted(docs, elsewhere);
      // Refused while a run holds the lock, and nothing changes.
      const refused = await docs.pipeline.withExtractLock(() =>
        docs.admin.drive.setRootMode(docs.roots.extract, "reference").then(
          () => null,
          (error: { code?: string }) => error.code,
        ),
      );
      expect(refused).toBe("extract_running");
      expect(await dueIds(docs)).toEqual([]);
      // The positive control: with no run, the mode is set and its documents wait again.
      expect(await docs.admin.drive.setRootMode(docs.roots.extract, "reference")).toEqual({ documents: 1 });
      expect(await statusFacts(docs.db, under)).toMatchObject({ status: "waiting", attempts: 0, waiting: true });
      // Superseded, not deleted: kept, and none still replayed.
      expect(await countOf(docs.db, "vault.model_calls", "evidence_id = $1 and superseded_at is null", [under])).toBe(
        0,
      );
      expect(await countOf(docs.db, "vault.model_calls", "evidence_id = $1", [under])).toBe(1);
      const [due] = await docs.pipeline.dueDocuments(10, 1, { settledBefore: SETTLED as never });
      expect(due).toMatchObject({ evidenceId: under, triage: { reference: true } });
      // A document of another root is left as it was.
      expect(await extractedOf(docs.db, elsewhere)).toEqual({
        ...NOTHING,
        "knowledge.claims": 1,
        "vault.model_calls": 1,
        "vault.pipeline_items": 1,
      });
    }));

  it("retry --document sets one document waiting and supersedes its saved calls; a lane given is the owner's; an id that names no document is not_found", () =>
    withDocs(async (docs) => {
      const chosen = await put(docs, docs.personal, file("1PipeRetry00001"));
      const other = await put(docs, docs.personal, file("1PipeRetry00002"));
      await extracted(docs, chosen);
      await extracted(docs, other);
      const { id } = await documentOf(docs, "1PipeRetry00001");
      expect(await docs.admin.extraction.retry({ documentId: id }, { lane: "document" })).toEqual({ selected: 1 });
      expect(await statusFacts(docs.db, chosen)).toMatchObject({
        status: "waiting",
        laneOverride: "document",
        attempts: 0,
        waiting: true,
      });
      // Superseded, not deleted: kept, and none still replayed.
      expect(await countOf(docs.db, "vault.model_calls", "evidence_id = $1 and superseded_at is null", [chosen])).toBe(
        0,
      );
      expect(await countOf(docs.db, "vault.model_calls", "evidence_id = $1", [chosen])).toBe(1);
      const [due] = await docs.pipeline.dueDocuments(10, 1, { settledBefore: SETTLED as never });
      expect(due).toMatchObject({ evidenceId: chosen, lane: "document" });
      // The positive control: the other document keeps its call and its status.
      expect(await countOf(docs.db, "vault.model_calls", "evidence_id = $1", [other])).toBe(1);
      expect(await statusFacts(docs.db, other)).toMatchObject({ status: "done" });
      await expect(
        docs.admin.extraction.retry({ documentId: DocumentId.parse(`doc_${"0".repeat(26)}`) }, {}),
      ).rejects.toMatchObject({ code: "not_found" });
    }));

  it("pi extract status counts the document lane and its codes", () =>
    withDocs(async (docs) => {
      const done = await put(docs, docs.personal, file("1PipeCount00001"));
      const skipped = await put(
        docs,
        docs.personal,
        file("1PipeCount00002", { ownedByMe: false, modifiedByMe: false }),
      );
      await extracted(docs, done);
      expect(
        await docs.pipeline.commit(batchOf(skipped, [], { lane: "skip", status: "skipped", code: "not_owners" })),
      ).toBe("committed");
      const view = await docs.admin.extraction.status({ generation: 1 });
      expect(view.items).toEqual(
        expect.arrayContaining([
          { lane: "document", status: "done", code: null, count: 1 },
          { lane: "skip", status: "skipped", code: "not_owners", count: 1 },
        ]),
      );
      expect(view.claims).toEqual({ plan: 1 });
    }));
});

describe("a bulk retry's lane and the status of documents", { timeout: TIMEOUT }, () => {
  it("a bulk retry with a message's lane leaves a document's lane as it was; skip applies to both kinds", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeBulkLane01"));
      await ingestMail(docs.store.writer, docs.accounts.personalMail, MAIL.canary);
      const message = evidenceIdOf(docs.accounts.personalMail, mailSourceId(MAIL.canary));
      expect(await docs.pipeline.commit(batchOf(doc, [], { lane: "document" }))).toBe("committed");
      expect(await docs.pipeline.commit(batchOf(message, []))).toBe("committed");
      expect(await docs.admin.extraction.retry({ all: true }, { lane: "correspondence" })).toEqual({ selected: 2 });
      const facts = await statusFacts(docs.db, doc);
      expect(facts.laneOverride).toBeUndefined();
      expect(facts).toMatchObject({ status: "waiting", lane: "document" });
      // The positive control: the message takes the lane given.
      expect(await statusFacts(docs.db, message)).toMatchObject({ status: "waiting", laneOverride: "correspondence" });
      const [due] = await docs.pipeline.dueDocuments(10, 1, { settledBefore: SETTLED as never });
      expect(due?.lane).toBeUndefined();
      // skip is a lane of both kinds.
      expect(await docs.admin.extraction.retry({ all: true }, { lane: "skip" })).toEqual({ selected: 2 });
      expect(await statusFacts(docs.db, doc)).toMatchObject({ laneOverride: "skip" });
      expect(await statusFacts(docs.db, message)).toMatchObject({ laneOverride: "skip" });
    }));

  it("pi extract status lists a withheld document by its id, and counts the documents due beside the messages", () =>
    withDocs(async (docs) => {
      const withheld = await put(docs, docs.personal, file("1PipeWithheld01"));
      await put(docs, docs.personal, file("1PipeDueStill01"));
      expect(
        await docs.pipeline.commit(batchOf(withheld, [], { lane: "document", status: "withheld", code: "sensitive" })),
      ).toBe("committed");
      const view = await docs.admin.extraction.status({ generation: 1 });
      expect(view.withheld.count).toBe(1);
      expect(view.withheld.messages).toEqual([]);
      expect(view.withheld.documents).toEqual([
        { id: (await documentOf(docs, "1PipeWithheld01")).id, at: "2026-09-02T09:00:00.000Z", code: "sensitive" },
      ]);
      expect(view.due).toBe(0);
      expect(view.documentsDue).toBe(1);
    }));
});

describe("find_facts on a document's claims", { timeout: TIMEOUT }, () => {
  it("a fact from a document names its document and passage, the passage slices get_document's text to the claim's text, and a held document's fact is not found", () =>
    withDocs(async (docs) => {
      const doc = await put(docs, docs.personal, file("1PipeFact000001"));
      const held = await put(
        docs,
        docs.personal,
        file("1PipeFactHeld01", { name: "Your verification code", modifiedTime: "2026-09-03T09:00:00.000Z" }),
      );
      const views = ["self", "people", "work"] as never;
      const tools = ["find_facts", "get_document", "find_documents"] as never;
      const token = (await docs.admin.clients.addClient(registration("facts-docs", ["own"], { views, tools }))).token;
      const { id } = await documentOf(docs, "1PipeFact000001");
      const text = readValue(await docs.store.reader.getDocument(token, { id })).text?.untrusted ?? "";
      const start = text.indexOf(LUNCH);
      expect(start).toBeGreaterThanOrEqual(0);
      const span = `chars:${start}-${start + LUNCH.length}`;
      for (const evidenceId of [doc, held]) {
        expect(await docs.pipeline.openDocument(evidenceId)).not.toBeNull();
        expect(
          await docs.pipeline.commit(
            batchOf(evidenceId, [planRecord(evidenceId, "own", docs.owner, span, { n: evidenceId === doc ? 1 : 2 })], {
              lane: "document",
              groups: 1,
            }),
          ),
        ).toBe("committed");
      }
      const { facts } = readValue(await docs.store.reader.findFacts(token, {}));
      expect(facts).toHaveLength(1);
      const [fact] = facts;
      expect(fact).toMatchObject({
        type: "plan",
        message: null,
        document: id,
        source: "document",
        passage: { start, end: start + LUNCH.length },
        basis: "third_party",
        statedBy: null,
        at: "2026-09-02T09:00:00.000Z",
      });
      expect(text.slice(fact?.passage?.start, fact?.passage?.end)).toContain(
        (fact!.fields as { what: { untrusted: string } }).what.untrusted,
      );
      // The positive control: once the held document is released, its fact is found too.
      await docs.admin.held.releaseHeldDocuments({ id: (await documentOf(docs, "1PipeFactHeld01")).id });
      expect(readValue(await docs.store.reader.findFacts(token, {})).facts).toHaveLength(2);
    }));
});
