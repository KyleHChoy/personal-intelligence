import { ConnectorCursor, type RawItem } from "@intelligence/contracts";
import { PERSONAL_LIMITS, THE_OWNER } from "@intelligence/personal-core";
import {
  type DocBody,
  type DriveFile,
  deriveItem,
  driveItem,
  driveRevisionTag,
  type ItemContext,
  type ItemFacts,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { connect, OWNER, SOLO } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, sealRow, type TestDatabase } from "../test-support/database.ts";
import { derive as fixtureDerive, ingestMail, type MailFixture, mailFacts, mailItem } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { seeder } from "../test-support/seeder.ts";
import { changed, opened, rowCounts } from "../test-support/snapshot.ts";
import { openStore, type Store, withStore } from "../test-support/store.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import type { Writer } from "../write/writer.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// The writer's tests. Written blind, from the spec and the stubs' signatures. Roots are written in
// SQL as pi_admin, as the admin will write them; the admin's own root methods are tested in
// roots.db.test.ts. Every refusal has its positive control.

const TIMEOUT = 180_000;
const AT = "2026-09-20T00:00:00Z";

// Folder and file ids made for these tests.
const FOLDER = "fldGdWriterRoot0001";
const REFERENCE_FOLDER = "fldGdWriterReference0001";
const OTHER_FOLDER = "fldGdWriterOutside0001";
const WORK_FOLDER = "fldGdWriterWork0001";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;

// A root of a label, as the admin writes one: its keyed fingerprint, and its value
// sealed under the `own` key.
async function addRoot(
  db: TestDatabase,
  label: string,
  root: string,
  mode: "extract" | "reference" = "extract",
): Promise<string> {
  const id = testId("drt");
  const kind = root === "my-drive" || root === "shared-with-me" ? root : "folder";
  await admin(
    db,
    "insert into policy.drive_roots (id, label, kind, root_fp, mode, created_at, root_enc) values ($1, $2, $3, $4, $5, $6, $7)",
    [
      id,
      label,
      kind,
      fingerprint(db.keys, "source_id", root),
      mode,
      AT,
      sealRow(db.keys, "own", { table: "policy.drive_roots", id, column: "root_enc" }, root),
    ],
  );
  return id;
}

type Drive = { personal: SourceAccountRow; work: SourceAccountRow };

// The owner's two labels, each with a Drive account.
async function drive(writer: Writer): Promise<Drive> {
  return {
    personal: await writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal),
    work: await writer.ensureSourceAccount("work", "google_docs", "employer:example", OWNER.work),
  };
}

// A Google Doc under FOLDER, owned and last edited by the owner, unless overridden.
const file = (id: string, overrides: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name: `Planning notes ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00Z",
  modifiedTime: "2026-09-02T09:00:00Z",
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal, name: OWNER.name },
  canDownload: true,
  ...overrides,
});

const body = (...paragraphs: string[]): DocBody => ({
  blocks: [
    { kind: "heading", level: 1, text: "Notes" },
    ...paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
  ],
});
const BODY = body("The harbour survey is due on Friday.");

const ownerAddressOf = (account: SourceAccountRow): string =>
  account.compartment === "own" ? OWNER.personal : OWNER.work;
const itemOf = (account: SourceAccountRow, doc: DriveFile, content: DocBody | null = BODY): RawItem =>
  driveItem(doc, content, content === null ? "not_a_document" : null, {
    sourceAccount: account.id,
    changeKind: "backfill",
    ownerAddress: ownerAddressOf(account),
  });
const sourceId = (doc: DriveFile): string => `drive-file:${doc.id}`;

// Ingests a file through the writer with core's own derive, and keeps the facts it derived.
async function ingest(
  writer: Writer,
  account: SourceAccountRow,
  doc: DriveFile,
  content: DocBody | null = BODY,
): Promise<{ answer: string; facts: ItemFacts | undefined }> {
  const raw = itemOf(account, doc, content);
  let facts: ItemFacts | undefined;
  const answer = await writer.ingestItem(account, raw, async (ctx: ItemContext) => {
    facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
    return facts;
  });
  return { answer, facts };
}
const ingested = async (
  writer: Writer,
  account: SourceAccountRow,
  doc: DriveFile,
  content: DocBody | null = BODY,
): Promise<string> => (await ingest(writer, account, doc, content)).answer;

type DocumentRow = {
  id: string;
  evidence_id: string;
  source_account_id: string;
  compartments: string[];
  kind: string;
  modified_at: Date;
  created_at: Date;
  mine: boolean;
  edited_by_me: boolean;
  reference: boolean;
  held: boolean;
  root_id: string;
  file_fp: string;
  folder_fp: string | null;
  owner_fp: string | null;
  sharer_fp: string | null;
  title_enc: unknown;
  file_id_enc: unknown;
  owner_enc: unknown;
  sharer_enc: unknown;
  body_enc: unknown;
  outline_enc: unknown;
  facts_enc: unknown;
};

// A file's document rows, by its account and its file id's fingerprint.
const rowsOf = (db: TestDatabase, account: SourceAccountRow, doc: DriveFile): Promise<DocumentRow[]> =>
  admin<DocumentRow>(db, "select * from knowledge.documents where source_account_id = $1 and file_fp = $2", [
    account.id,
    fingerprint(db.keys, "source_id", doc.id),
  ]);
const rowOf = async (db: TestDatabase, account: SourceAccountRow, doc: DriveFile): Promise<DocumentRow> =>
  one(await rowsOf(db, account, doc));

// A sealed column of a document row, opened under the row's compartment.
const sealedOf = (db: TestDatabase, row: DocumentRow, column: keyof DocumentRow): string | null => {
  const value = row[column];
  return value === null
    ? null
    : opened(db, row.compartments[0] ?? "", { table: "knowledge.documents", id: row.id, column }, value);
};

type EvidenceRow = {
  id: string;
  revision: number;
  blob_ref: string | null;
  payload_state: string;
  content_hash: string;
  source_item_fp: string;
  item_enc: unknown;
  hold_released_at: Date | null;
};
const evidenceOf = (db: TestDatabase, account: SourceAccountRow, doc: DriveFile): Promise<EvidenceRow[]> =>
  admin<EvidenceRow>(
    db,
    "select id, revision, blob_ref, payload_state, content_hash, source_item_fp, item_enc, hold_released_at from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision",
    [account.id, fingerprint(db.keys, "source_id", sourceId(doc))],
  );
const blobsOf = (db: TestDatabase, refs: (string | null)[]): Promise<number> =>
  count(db, "vault.evidence_blobs", "blob_ref = any($1)", [refs.filter((ref) => ref !== null)]);

// The rows an erasure leaves for a source item: its decision, the erasure, and the
// removed-evidence row by the item's fingerprint.
async function removedEvidence(db: TestDatabase, account: SourceAccountRow, sourceItemId: string): Promise<void> {
  const ruling = testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')",
    [ruling, testId("req"), AT],
  );
  const erasure = testId("ers");
  await admin(
    db,
    "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', (select coalesce(max(journal_seq), 0) + 1 from knowledge.erasures), $3, 0, 0, 0, '{own}')",
    [erasure, ruling, AT],
  );
  await admin(
    db,
    `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
     values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, '{own}')`,
    [testId("rme"), erasure, account.id, fingerprint(db.keys, "source_id", sourceItemId), AT],
  );
}

// The suppression an erasure of a person writes for an address.
async function suppress(db: TestDatabase, address: string): Promise<void> {
  const ruling = testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')",
    [ruling, testId("req"), AT],
  );
  const erasure = testId("ers");
  await admin(
    db,
    "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', (select coalesce(max(journal_seq), 0) + 1 from knowledge.erasures), $3, 0, 1, 0, '{own}')",
    [erasure, ruling, AT],
  );
  await admin(
    db,
    "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')",
    [testId("sup"), erasure, fingerprint(db.keys, "address", address), AT],
  );
}

const withDrive = (fn: (store: Store, accounts: Drive) => Promise<void>): Promise<void> =>
  withStore(async (store) => {
    const accounts = await drive(store.writer);
    await addRoot(store.db, "personal", FOLDER);
    await fn(store, accounts);
  });

describe("the writer and documents", { timeout: TIMEOUT }, () => {
  describe("every stored document has exactly one row, citing its latest revision", () => {
    it("a document has one row, and a new revision keeps its id", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const first = file("fileGdOneRow0001");
        expect(await ingested(writer, personal, first)).toBe("stored");
        const row = await rowOf(db, personal, first);
        expect(row.evidence_id).toBe(evidenceIdOf(personal, sourceId(first), 0));
        expect(sealedOf(db, row, "body_enc")).toContain("The harbour survey is due on Friday.");

        // The same revision again is a repeat, and changes nothing.
        expect(await ingested(writer, personal, first)).toBe("repeat");
        expect(await rowsOf(db, personal, first)).toEqual([row]);

        // An edit is the next revision: the same row, updated in place, citing it.
        const edited = { ...first, modifiedTime: "2026-09-05T09:00:00Z" };
        expect(driveRevisionTag(edited)).not.toBe(driveRevisionTag(first));
        expect(await ingested(writer, personal, edited, body("The harbour survey moved to Monday."))).toBe("stored");
        const after = await rowOf(db, personal, first);
        expect(after.id).toBe(row.id);
        expect(after.evidence_id).toBe(evidenceIdOf(personal, sourceId(first), 1));
        expect(sealedOf(db, after, "body_enc")).toContain("The harbour survey moved to Monday.");
        expect(sealedOf(db, after, "body_enc")).not.toContain("due on Friday");
        expect(new Date(after.modified_at).getTime()).toBe(Date.parse(edited.modifiedTime));
        expect(await count(db, "knowledge.documents")).toBe(1);
      }));

    it("a re-derive leaves every document row and its id as they were", async () => {
      const store = await openStore();
      try {
        const accounts = await drive(store.writer);
        const { personalMail } = await connect(store.writer);
        await addRoot(store.db, "personal", FOLDER);
        expect(await ingestMail(store.writer, personalMail, MAIL.solo)).toBe("stored");
        const files = [
          file("fileGdRederive0001"),
          file("fileGdRederive0002", {
            ownedByMe: false,
            owner: { address: "ines.keeper@example.org", name: "Ines Keeper" },
          }),
        ];
        for (const doc of files) expect(await ingested(store.writer, accounts.personal, doc)).toBe("stored");
        const before = await admin(store.db, "select *, xmin::text as version from knowledge.documents order by id");
        expect(before).toHaveLength(2);

        // A new owner address that a person holds makes the next re-derive run (rederive.ts,
        // NEEDED); the derive it is handed is never asked for a document.
        await addOwnerAddressUnderived(store.db, SOLO.address, "own");
        const kinds: string[] = [];
        const result = await store.writer.rederiveIfNeeded((raw, ctx) => {
          kinds.push(raw.sourceKind);
          return raw.sourceKind === "document" ? deriveItem(raw, ctx, PERSONAL_LIMITS) : fixtureDerive(raw, ctx);
        });
        expect(result.rederived).toBe(true);
        // The positive control: the re-derive did run, over the message.
        expect(kinds).toContain("email");
        expect(kinds).not.toContain("document");
        expect(await admin(store.db, "select *, xmin::text as version from knowledge.documents order by id")).toEqual(
          before,
        );
      } finally {
        await store.close();
      }
    });
  });

  describe("a document keeps the original of its latest revision only", () => {
    it("a new revision deletes the earlier blob, sets blob_ref null and payload_state expired, and keeps its row", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const first = file("fileGdExpiry0001");
        expect(await ingested(writer, personal, first)).toBe("stored");
        const [original] = await evidenceOf(db, personal, first);
        expect(original).toMatchObject({ revision: 0, payload_state: "present" });
        expect(original?.blob_ref).not.toBeNull();

        const second = { ...first, modifiedTime: "2026-09-06T09:00:00Z" };
        expect(await ingested(writer, personal, second, body("A second draft of the survey."))).toBe("stored");
        const third = { ...first, modifiedTime: "2026-09-07T09:00:00Z", name: "Planning notes, renamed" };
        expect(await ingested(writer, personal, third, body("A third draft of the survey."))).toBe("stored");

        const revisions = await evidenceOf(db, personal, first);
        expect(revisions.map((row) => [row.revision, row.payload_state, row.blob_ref === null])).toEqual([
          [0, "expired", true],
          [1, "expired", true],
          [2, "present", false],
        ]);
        // The earlier rows keep their record and hash.
        expect(revisions[0]).toMatchObject({
          id: original?.id,
          content_hash: original?.content_hash,
          source_item_fp: original?.source_item_fp,
          item_enc: original?.item_enc,
        });
        // Their blobs are gone; the latest one is there: one original for the document.
        expect(await blobsOf(db, [original?.blob_ref ?? null])).toBe(0);
        expect(await blobsOf(db, [revisions[2]?.blob_ref ?? null])).toBe(1);
        const blobs = await admin<{ n: number }>(
          db,
          "select count(*)::int as n from vault.evidence_blobs b join vault.evidence_items e on e.blob_ref = b.blob_ref where e.source_account_id = $1",
          [personal.id],
        );
        expect(one(blobs).n).toBe(1);
        expect((await rowOf(db, personal, first)).evidence_id).toBe(revisions[2]?.id);
      }));

    it("after a message's label change every mail revision still has its blob", () =>
      withDrive(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const inbox: MailFixture = { ...MAIL.fromQuentin };
        const updates: MailFixture = { ...inbox, labels: ["INBOX", "CATEGORY_UPDATES"], reads: "bulk" };
        expect(mailItem(updates, personalMail).revisionTag).not.toBe(mailItem(inbox, personalMail).revisionTag);
        for (const fixture of [inbox, updates, inbox])
          expect(await writer.ingestItem(personalMail, mailItem(fixture, personalMail), mailFacts(fixture))).toBe(
            "stored",
          );

        const revisions = await admin<{ revision: number; payload_state: string; blob_ref: string | null }>(
          db,
          "select revision, payload_state, blob_ref from vault.evidence_items where source_account_id = $1 order by revision",
          [personalMail.id],
        );
        expect(revisions.map((row) => [row.revision, row.payload_state])).toEqual([
          [0, "present"],
          [1, "present"],
          [2, "present"],
        ]);
        expect(
          await blobsOf(
            db,
            revisions.map((row) => row.blob_ref),
          ),
        ).toBe(3);
      }));
  });

  it("an item whose root was removed is not stored and answers left", () =>
    withDrive(async ({ db, writer }, { personal }) => {
      // A root of another label is not one of this label's.
      await addRoot(db, "work", OTHER_FOLDER);
      const before = await rowCounts(db);
      let derived = 0;
      for (const [n, root] of [OTHER_FOLDER, "my-drive", "shared-with-me"].entries()) {
        const raw = itemOf(
          personal,
          file(`fileGdLeft000${n}`, { root, parent: root === OTHER_FOLDER ? OTHER_FOLDER : "fldGdSomewhere0001" }),
        );
        const answer = await writer.ingestItem(personal, raw, async (ctx) => {
          derived += 1;
          return deriveItem(raw, ctx, PERSONAL_LIMITS);
        });
        expect(answer, root).toBe("left");
      }
      expect(await rowCounts(db)).toEqual(before);
      expect(derived).toBe(0);

      // The positive control: the same kind of item under the label's own root is stored, and so
      // is one under `my-drive` once that is a root.
      expect(await ingested(writer, personal, file("fileGdLeftControl0001"))).toBe("stored");
      await addRoot(db, "personal", "my-drive");
      expect(
        await ingested(
          writer,
          personal,
          file("fileGdLeftControl0002", { root: "my-drive", parent: "fldGdSomewhere0001" }),
        ),
      ).toBe("stored");
      expect(await count(db, "knowledge.documents")).toBe(2);
    }));

  describe("what left the owner's scope is removed, and stored again when it returns", () => {
    it("a left id is removed with everything that cites it, writes no removed-evidence row, and is stored again when it returns", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const leaving = file("fileGdLeaving0001");
        const staying = file("fileGdStaying0001");
        expect(await ingested(writer, personal, leaving)).toBe("stored");
        expect(
          await ingested(writer, personal, { ...leaving, modifiedTime: "2026-09-04T09:00:00Z" }, body("Edited once.")),
        ).toBe("stored");
        expect(await ingested(writer, personal, staying)).toBe("stored");
        const revisions = await evidenceOf(db, personal, leaving);
        expect(revisions).toHaveLength(2);
        // A claim that rests on the document's latest revision.
        const latest = revisions[1]?.id ?? "";
        await session(db.urls.admin, (query) => seeder(db, query).claim(["own"], latest));
        expect(await count(db, "knowledge.claims", "evidence_id = $1", [latest])).toBe(1);

        const next = ConnectorCursor.parse("cursor-gd-left-0001");
        await writer.finishPage(personal, { listedIds: [], skippedIds: [], leftIds: [sourceId(leaving)], next });

        expect(await rowsOf(db, personal, leaving)).toEqual([]);
        expect(await evidenceOf(db, personal, leaving)).toEqual([]);
        expect(
          await blobsOf(
            db,
            revisions.map((row) => row.blob_ref),
          ),
        ).toBe(0);
        expect(await count(db, "knowledge.claims", "evidence_id = any($1)", [revisions.map((row) => row.id)])).toBe(0);
        expect(await count(db, "knowledge.removed_evidence")).toBe(0);
        // The cursor is stored after the removal.
        expect(await writer.cursor(personal)).toEqual(next);
        // The positive control: the document that did not leave is as it was.
        expect(await rowsOf(db, personal, staying)).toHaveLength(1);
        expect(await evidenceOf(db, personal, staying)).toHaveLength(1);

        // Handed over in scope again, it is stored again, as a new item is.
        expect(await ingested(writer, personal, leaving)).toBe("stored");
        expect(await rowsOf(db, personal, leaving)).toHaveLength(1);
        expect(await evidenceOf(db, personal, leaving)).toHaveLength(1);
      }));

    it("a complete listing removes a stored document it did not name, and a skipped id counts as listed", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const [listed, skipped, unnamed] = [
          file("fileGdListed0001"),
          file("fileGdSkipped0001"),
          file("fileGdUnnamed0001"),
        ];
        for (const doc of [listed, skipped, unnamed]) expect(await ingested(writer, personal, doc)).toBe("stored");
        const gone = await evidenceOf(db, personal, unnamed);

        const page = await writer.finishPage(personal, {
          listing: { first: true, ended: "complete" },
          listedIds: [sourceId(listed)],
          skippedIds: [sourceId(skipped)],
          next: ConnectorCursor.parse("cursor-gd-listing-0001"),
        });
        expect(page).toEqual({ removed: 1, reconciled: true, recordsRemoved: 0 });
        expect(await rowsOf(db, personal, unnamed)).toEqual([]);
        expect(await evidenceOf(db, personal, unnamed)).toEqual([]);
        expect(
          await blobsOf(
            db,
            gone.map((row) => row.blob_ref),
          ),
        ).toBe(0);
        expect(await count(db, "knowledge.removed_evidence")).toBe(0);
        // The positive controls: the listed and the skipped documents stay.
        expect(await rowsOf(db, personal, listed)).toHaveLength(1);
        expect(await rowsOf(db, personal, skipped)).toHaveLength(1);
      }));
  });

  it("a document carries its root's mode", () =>
    withDrive(async ({ db, writer }, { personal }) => {
      await addRoot(db, "personal", REFERENCE_FOLDER, "reference");
      const kept = file("fileGdReference0001", { root: REFERENCE_FOLDER, parent: REFERENCE_FOLDER });
      const extracted = file("fileGdExtract0001");
      expect(await ingested(writer, personal, kept)).toBe("stored");
      expect(await ingested(writer, personal, extracted)).toBe("stored");
      const roots = await admin<{ id: string; mode: string }>(
        db,
        "select id, mode from policy.drive_roots where label = 'personal'",
      );
      const rootOf = (mode: string): string | undefined => roots.find((root) => root.mode === mode)?.id;
      expect(await rowOf(db, personal, kept)).toMatchObject({ reference: true, root_id: rootOf("reference") });
      expect(await rowOf(db, personal, extracted)).toMatchObject({ reference: false, root_id: rootOf("extract") });
    }));

  it("a document makes no entity, account, alias or interaction row", () =>
    withDrive(async ({ db, writer }, { personal }) => {
      const { personalMail } = await connect(writer);
      // A message first, so whatever the owner's first item makes is made before the count.
      expect(await ingestMail(writer, personalMail, MAIL.solo)).toBe("stored");
      const before = await rowCounts(db);
      const shared = file("fileGdNoPerson0001", {
        ownedByMe: false,
        owner: { address: "ines.keeper@example.org", name: "Ines Keeper" },
        sharer: { address: "sam.sharer@example.org", name: "Sam Sharer" },
      });
      expect(await ingested(writer, personal, shared)).toBe("stored");
      expect(changed(before, await rowCounts(db))).toEqual({
        "vault.evidence_items": 1,
        "vault.evidence_blobs": 1,
        "knowledge.documents": 1,
      });
      // Its owner and sharer are on its row, by keyed fingerprint and sealed.
      const row = await rowOf(db, personal, shared);
      expect(row.owner_fp).toBe(fingerprint(db.keys, "address", "ines.keeper@example.org"));
      expect(row.sharer_fp).toBe(fingerprint(db.keys, "address", "sam.sharer@example.org"));
      expect(JSON.parse(sealedOf(db, row, "owner_enc") ?? "null")).toEqual({
        address: "ines.keeper@example.org",
        name: "Ines Keeper",
      });
      expect(JSON.parse(sealedOf(db, row, "sharer_enc") ?? "null")).toEqual({
        address: "sam.sharer@example.org",
        name: "Sam Sharer",
      });
      expect(await count(db, "knowledge.accounts", "value_fp = any($1)", [[row.owner_fp, row.sharer_fp]])).toBe(0);
    }));

  describe("no name, title, text, address or Google id of a document is in a column in clear", () => {
    it("a canary title, text, owner address, folder id and file id are in no column in clear, nor the plain hash of one", () =>
      withStore(async ({ db, writer }) => {
        const { personal } = await drive(writer);
        const canary = {
          title: "Canary document: the osprey ledger for Friday",
          text: "Canary text: the osprey ledger is under the second lantern.",
          owner: "marisol.canary@osprey-canary.test",
          ownerName: "Marisol Ospreyfield-Canary",
          folder: "fldCanaryOsprey0001",
          file: "fileCanaryOsprey0001",
        };
        await addRoot(db, "personal", canary.folder);
        const doc = file(canary.file, {
          name: canary.title,
          parent: canary.folder,
          root: canary.folder,
          ownedByMe: false,
          owner: { address: canary.owner, name: canary.ownerName },
        });
        expect(await ingested(writer, personal, doc, body(canary.text))).toBe("stored");

        // The positive control: each is stored, sealed, and opens.
        const row = await rowOf(db, personal, doc);
        expect(sealedOf(db, row, "title_enc")).toBe(canary.title);
        expect(sealedOf(db, row, "file_id_enc")).toBe(canary.file);
        expect(sealedOf(db, row, "body_enc")).toContain(canary.text);
        expect(JSON.parse(sealedOf(db, row, "owner_enc") ?? "null")).toEqual({
          address: canary.owner,
          name: canary.ownerName,
        });

        const values = Object.values(canary);
        const needles = [...values, ...values.map(sha256Hex)];
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);

        // The self-test: a value planted where a sealed one belongs is found, and so is the plain
        // hash of a file id planted where its keyed fingerprint belongs.
        const places = async (): Promise<string[]> =>
          (await scanForPlaintext(db.urls.admin, needles))
            .map((hit) => `${hit.table.split(".").pop() ?? ""}.${hit.column}`)
            .sort();
        await admin(
          db,
          "update knowledge.documents set title_enc = jsonb_set(title_enc, '{ciphertext}', to_jsonb($1::text)) where id = $2",
          [canary.title, row.id],
        );
        expect(await places()).toEqual(["documents.title_enc"]);
        await admin(db, "update knowledge.documents set file_fp = $1 where id = $2", [sha256Hex(canary.file), row.id]);
        expect(await places()).toEqual(["documents.file_fp", "documents.title_enc"]);
      }));

    it("in clear are the kind, the times, the marks, the root and keyed fingerprints; the rest is sealed", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const rootId = one(
          await admin<{ id: string }>(db, "select id from policy.drive_roots where label = 'personal'"),
        ).id;
        const shared = file("fileGdColumns0001", {
          name: "Quarterly plan",
          createdTime: "2026-08-01T10:00:00Z",
          modifiedTime: "2026-09-03T11:30:00Z",
          size: 2048,
          ownedByMe: false,
          modifiedByMe: true,
          owner: { address: "Ines.Keeper@Example.org", name: "Ines Keeper" },
          sharer: { address: "sam.sharer@example.org" },
        });
        const content: DocBody = {
          blocks: [
            { kind: "heading", level: 1, text: "Plan" },
            { kind: "paragraph", text: "First step." },
            { kind: "heading", level: 2, text: "Budget" },
            { kind: "paragraph", text: "Ten crates." },
          ],
        };
        const { answer, facts } = await ingest(writer, personal, shared, content);
        expect(answer).toBe("stored");
        if (facts?.kind !== "document") throw new Error("the derive gave no document facts");
        const derived = facts.document;
        expect(derived.text).toContain("First step.");
        expect(derived.sections.length).toBeGreaterThan(1);

        const row = await rowOf(db, personal, shared);
        expect({
          ...row,
          modified_at: new Date(row.modified_at).toISOString(),
          created_at: new Date(row.created_at).toISOString(),
        }).toMatchObject({
          evidence_id: evidenceIdOf(personal, sourceId(shared), 0),
          source_account_id: personal.id,
          compartments: ["own"],
          kind: "doc",
          modified_at: "2026-09-03T11:30:00.000Z",
          created_at: "2026-08-01T10:00:00.000Z",
          mine: false,
          edited_by_me: true,
          reference: false,
          held: false,
          root_id: rootId,
          file_fp: fingerprint(db.keys, "source_id", shared.id),
          folder_fp: fingerprint(db.keys, "source_id", FOLDER),
          owner_fp: fingerprint(db.keys, "address", "ines.keeper@example.org"),
          sharer_fp: fingerprint(db.keys, "address", "sam.sharer@example.org"),
        });
        expect(row.id).toMatch(/^doc_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(sealedOf(db, row, "title_enc")).toBe("Quarterly plan");
        expect(sealedOf(db, row, "file_id_enc")).toBe(shared.id);
        expect(JSON.parse(sealedOf(db, row, "owner_enc") ?? "null")).toEqual({
          address: "ines.keeper@example.org",
          name: "Ines Keeper",
        });
        expect(JSON.parse(sealedOf(db, row, "sharer_enc") ?? "null")).toEqual({ address: "sam.sharer@example.org" });
        expect(sealedOf(db, row, "body_enc")).toBe(derived.text);
        expect(JSON.parse(sealedOf(db, row, "outline_enc") ?? "null")).toEqual(derived.sections);
        expect(JSON.parse(sealedOf(db, row, "facts_enc") ?? "null")).toEqual({
          chars: derived.text?.length,
          sections: derived.sections.length,
          size: 2048,
          unreadable: null,
        });

        // A file that is not a Google Doc has no text: its body is null, and its facts say why.
        const sheet = file("fileGdColumnsSheet0001", { mimeType: "application/vnd.google-apps.spreadsheet" });
        expect(await ingested(writer, personal, sheet, null)).toBe("stored");
        const sheetRow = await rowOf(db, personal, sheet);
        expect(sheetRow.kind).toBe("sheet");
        expect(sheetRow.body_enc).toBeNull();
        expect(JSON.parse(sealedOf(db, sheetRow, "facts_enc") ?? "null")).toMatchObject({
          unreadable: "not_a_document",
          size: null,
        });
      }));
  });

  describe("a document's compartment is its account's", () => {
    it("two labels' documents are in their own compartments", () =>
      withDrive(async ({ db, writer }, { personal, work }) => {
        await addRoot(db, "work", WORK_FOLDER);
        const own = file("fileGdOwnLabel0001");
        const employer = file("fileGdWorkLabel0001", {
          root: WORK_FOLDER,
          parent: WORK_FOLDER,
          owner: { address: OWNER.work },
        });
        expect(await ingested(writer, personal, own)).toBe("stored");
        expect(await ingested(writer, work, employer)).toBe("stored");

        const ownRow = await rowOf(db, personal, own);
        const workRow = await rowOf(db, work, employer);
        expect(ownRow.compartments).toEqual(["own"]);
        expect(workRow.compartments).toEqual(["employer:example"]);
        const evidence = await admin<{ compartments: string[] }>(
          db,
          "select compartments from vault.evidence_items where id = any($1) order by source_account_id = $2 desc",
          [[ownRow.evidence_id, workRow.evidence_id], personal.id],
        );
        expect(evidence.map((row) => row.compartments)).toEqual([["own"], ["employer:example"]]);
        // Each opens under its own compartment's key and not under the other's.
        expect(sealedOf(db, workRow, "title_enc")).toBe(employer.name);
        expect(() =>
          opened(db, "own", { table: "knowledge.documents", id: workRow.id, column: "title_enc" }, workRow.title_enc),
        ).toThrow();
        expect(() =>
          opened(
            db,
            "employer:example",
            { table: "knowledge.documents", id: ownRow.id, column: "title_enc" },
            ownRow.title_enc,
          ),
        ).toThrow();
      }));

    it("a document shared from another domain into the personal account is own", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const shared = file("fileGdSharedIn0001", {
          ownedByMe: false,
          modifiedByMe: false,
          owner: { address: "odalys.owner@employer-example.test", name: "Odalys at work" },
          sharer: { address: "wren@partner-example.test", name: "Wren Partnerfield" },
        });
        expect(await ingested(writer, personal, shared)).toBe("stored");
        const row = await rowOf(db, personal, shared);
        expect(row.compartments).toEqual(["own"]);
        expect(row.mine).toBe(false);
      }));

    it("the item's permissions name the owner only", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const shared = file("fileGdPermissions0001", {
          ownedByMe: false,
          owner: { address: "ines.keeper@example.org" },
          sharer: { address: "sam.sharer@example.org" },
        });
        expect(await ingested(writer, personal, shared)).toBe("stored");
        const evidence = one(
          await admin<{
            id: string;
            participant_members: string[];
            sender_member: string | null;
            readers: string[];
            compartments: string[];
            item_enc: unknown;
          }>(
            db,
            "select id, participant_members, sender_member, readers, compartments, item_enc from vault.evidence_items where id = $1",
            [evidenceIdOf(personal, sourceId(shared), 0)],
          ),
        );
        expect(evidence).toMatchObject({
          participant_members: [THE_OWNER],
          sender_member: null,
          readers: [THE_OWNER],
          compartments: ["own"],
        });
        const item = JSON.parse(
          opened(db, "own", { table: "vault.evidence_items", id: evidence.id, column: "item_enc" }, evidence.item_enc),
        ) as { permissions: unknown; markers: unknown };
        expect(item.permissions).toEqual({ scope: "listed", identifiers: [OWNER.personal] });
        expect(item.markers).toEqual(["drive", `root:${FOLDER}`]);
      }));
  });

  describe("a document that matches the recovery markers is held", () => {
    it("a document whose title holds a recovery term is held, and one whose first 2 000 code points hold one is held", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const byTitle = file("fileGdHeldTitle0001", { name: "How to reset your password for the archive" });
        const byText = file("fileGdHeldText0001");
        const late = file("fileGdHeldLate0001");
        const plain = file("fileGdHeldPlain0001");
        expect(await ingested(writer, personal, byTitle)).toBe("stored");
        expect(await ingested(writer, personal, byText, body("Your one-time code is in the drawer."))).toBe("stored");
        // The term only after the first 2 000 code points: not held.
        expect(
          await ingested(
            writer,
            personal,
            late,
            body(`${"lantern ".repeat(400)}`, "Your one-time code is in the drawer."),
          ),
        ).toBe("stored");
        expect(await ingested(writer, personal, plain)).toBe("stored");

        expect((await rowOf(db, personal, byTitle)).held).toBe(true);
        expect((await rowOf(db, personal, byText)).held).toBe(true);
        // The positive controls: neither of these is held.
        expect((await rowOf(db, personal, late)).held).toBe(false);
        expect((await rowOf(db, personal, plain)).held).toBe(false);
      }));

    it("a new revision that still matches is held again", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const held = file("fileGdHeldAgain0001", { name: "Verification code for the shared vault" });
        expect(await ingested(writer, personal, held)).toBe("stored");
        const first = await rowOf(db, personal, held);
        expect(first.held).toBe(true);

        // A release as the owner's release leaves it: the revision's evidence row released, the row
        // not held.
        await admin(db, "update vault.evidence_items set hold_released_at = $1 where id = $2", [AT, first.evidence_id]);
        await admin(db, "update knowledge.documents set held = false where id = $1", [first.id]);

        // A new revision that still matches is held again: a release covers the revision released.
        const edited = { ...held, modifiedTime: "2026-09-08T09:00:00Z" };
        expect(await ingested(writer, personal, edited, body("Still about the code."))).toBe("stored");
        const again = await rowOf(db, personal, held);
        expect(again).toMatchObject({
          id: first.id,
          evidence_id: evidenceIdOf(personal, sourceId(held), 1),
          held: true,
        });
        const latest = await evidenceOf(db, personal, held);
        expect(latest[1]?.hold_released_at ?? null).toBeNull();

        // The positive control: a revision that no longer matches is not held.
        const renamed = { ...held, modifiedTime: "2026-09-09T09:00:00Z", name: "Shared vault notes" };
        expect(await ingested(writer, personal, renamed, body("Nothing to keep back."))).toBe("stored");
        expect((await rowOf(db, personal, held)).held).toBe(false);
      }));
  });

  describe("a refetch under an unchanged tag", () => {
    // `pi sync --reset drive` fetches every document again, and the tag
    // does not change, so the store must tell a new reading from the same one by its content.
    it("a document stored as forbidden, fetched again with its text under the same tag, is its next revision", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const doc = file("fileGdRefetch0001");
        const forbidden = driveItem(doc, null, "forbidden", {
          sourceAccount: personal.id,
          changeKind: "backfill",
          ownerAddress: OWNER.personal,
        });
        expect(await writer.ingestItem(personal, forbidden, (ctx) => deriveItem(forbidden, ctx, PERSONAL_LIMITS))).toBe(
          "stored",
        );
        expect(sealedOf(db, await rowOf(db, personal, doc), "body_enc")).toBeNull();

        // The refetch: the same tag, now with the text.
        expect(await ingested(writer, personal, doc)).toBe("stored");
        const row = await rowOf(db, personal, doc);
        expect(row.evidence_id).toBe(evidenceIdOf(personal, sourceId(doc), 1));
        expect(sealedOf(db, row, "body_enc")).toContain("The harbour survey is due on Friday.");
        // One original, the latest.
        const evidence = await evidenceOf(db, personal, doc);
        expect(evidence.map((one) => [one.revision, one.payload_state, one.blob_ref === null])).toEqual([
          [0, "expired", true],
          [1, "present", false],
        ]);

        // The positive control: the same reading again, under the same tag, is a repeat.
        expect(await ingested(writer, personal, doc)).toBe("repeat");
        expect(await evidenceOf(db, personal, doc)).toHaveLength(2);
      }));
  });

  describe("hasRevision", () => {
    it("hasRevision is true for a stored tag, false for another, and true with no tag", () =>
      withDrive(async ({ writer }, { personal }) => {
        const stored = file("fileGdHasRevision0001");
        expect(await ingested(writer, personal, stored)).toBe("stored");
        const tag = driveRevisionTag(stored);
        expect(await writer.hasRevision(personal, sourceId(stored), tag)).toBe(true);
        expect(await writer.hasRevision(personal, sourceId(stored))).toBe(true);
        const edited = { ...stored, modifiedTime: "2026-09-10T09:00:00Z" };
        expect(await writer.hasRevision(personal, sourceId(stored), driveRevisionTag(edited))).toBe(false);
        // An item never stored, and the stored item under another account, answer false.
        expect(await writer.hasRevision(personal, "drive-file:fileGdNeverStored0001")).toBe(false);
        const { work } = await drive(writer);
        expect(await writer.hasRevision(work, sourceId(stored), tag)).toBe(false);

        // After the next revision, only its tag is the latest.
        expect(await ingested(writer, personal, edited, body("An edit."))).toBe("stored");
        expect(await writer.hasRevision(personal, sourceId(stored), driveRevisionTag(edited))).toBe(true);
        expect(await writer.hasRevision(personal, sourceId(stored), tag)).toBe(false);
      }));

    it("an erased document's id answers true from hasRevision, and the writer answers removed for it", () =>
      withDrive(async ({ db, writer }, { personal }) => {
        const erased = file("fileGdErased0001");
        await removedEvidence(db, personal, sourceId(erased));
        expect(await writer.hasRevision(personal, sourceId(erased))).toBe(true);
        expect(await writer.hasRevision(personal, sourceId(erased), driveRevisionTag(erased))).toBe(true);

        const before = await rowCounts(db);
        expect(await ingested(writer, personal, erased)).toBe("removed");
        expect(await rowCounts(db)).toEqual(before);
        // The positive control: another file of the same account is not erased, and is stored.
        const other = file("fileGdNotErased0001");
        expect(await writer.hasRevision(personal, sourceId(other))).toBe(false);
        expect(await ingested(writer, personal, other)).toBe("stored");
      }));
  });

  it("an owner or sharer whose address is suppressed is stored with no fingerprint and no sealed value for them", () =>
    withDrive(async ({ db, writer }, { personal }) => {
      await suppress(db, "ines.keeper@example.org");
      const shared = file("fileGdSuppressed0001", {
        ownedByMe: false,
        owner: { address: "ines.keeper@example.org", name: "Ines Keeper" },
        sharer: { address: "sam.sharer@example.org", name: "Sam Sharer" },
      });
      // Stored, never `suppressed`: a document is no email from a suppressed sender.
      expect(await ingested(writer, personal, shared)).toBe("stored");
      const row = await rowOf(db, personal, shared);
      expect(row.owner_fp).toBeNull();
      expect(row.owner_enc).toBeNull();
      // The positive control: the sharer, who is not suppressed, is kept.
      expect(row.sharer_fp).toBe(fingerprint(db.keys, "address", "sam.sharer@example.org"));
      expect(JSON.parse(sealedOf(db, row, "sharer_enc") ?? "null")).toEqual({
        address: "sam.sharer@example.org",
        name: "Sam Sharer",
      });

      // And the same for a suppressed sharer.
      await suppress(db, "sam.sharer@example.org");
      const again = file("fileGdSuppressed0002", {
        ownedByMe: false,
        owner: { address: "rowan.keeper@example.org" },
        sharer: { address: "sam.sharer@example.org" },
      });
      expect(await ingested(writer, personal, again)).toBe("stored");
      const second = await rowOf(db, personal, again);
      expect([second.sharer_fp, second.sharer_enc]).toEqual([null, null]);
      expect(second.owner_fp).toBe(fingerprint(db.keys, "address", "rowan.keeper@example.org"));
    }));

  it("databaseBytes is the database's size", () =>
    withStore(async ({ db, writer }) => {
      const bytes = await writer.databaseBytes();
      expect(Number.isInteger(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      const size = one(await admin<{ n: string }>(db, "select pg_database_size(current_database())::text as n")).n;
      // Within a megabyte of what the catalogue says now.
      expect(Math.abs(bytes - Number(size))).toBeLessThan(1024 * 1024);
    }));

  it("listRoots gives that label's roots only", () =>
    withStore(async ({ db, writer }) => {
      const folder = await addRoot(db, "personal", FOLDER);
      const myDrive = await addRoot(db, "personal", "my-drive", "reference");
      const work = await addRoot(db, "work", WORK_FOLDER);
      const byId = (rows: { id: string; root: string; mode: string }[]) =>
        [...rows].sort((left, right) => (left.id < right.id ? -1 : 1));
      expect(byId(await writer.listRoots("personal"))).toEqual(
        byId([
          { id: folder, root: FOLDER, mode: "extract" },
          { id: myDrive, root: "my-drive", mode: "reference" },
        ]),
      );
      expect(await writer.listRoots("work")).toEqual([{ id: work, root: WORK_FOLDER, mode: "extract" }]);
      expect(await writer.listRoots("nobody")).toEqual([]);
    }));
});
