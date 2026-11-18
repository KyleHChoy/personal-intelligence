import type { RawItem } from "@intelligence/contracts";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { OWNER } from "../test-support/cast.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import { opened } from "../test-support/snapshot.ts";
import { inStore, type TestStore } from "../test-support/store.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// The roots the owner sets, through the admin. Documents are stored through the writer.

const TIMEOUT = 180_000;
const SYNC_LOCK = "hashtext('intelligence personal sync')";
const FOLDER = "fldGdRootsFirst0001";
const SECOND = "fldGdRootsSecond0001";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;

const file = (id: string, root: string): DriveFile => ({
  id,
  name: `Roots test document ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00Z",
  modifiedTime: "2026-09-02T09:00:00Z",
  parent: root,
  root,
  ownedByMe: true,
  modifiedByMe: true,
  canDownload: true,
});

async function store(writer: TestStore["writer"], account: SourceAccountRow, doc: DriveFile): Promise<string> {
  const raw: RawItem = driveItem(doc, { blocks: [{ kind: "paragraph", text: `The text of ${doc.id}.` }] }, null, {
    sourceAccount: account.id,
    changeKind: "backfill",
    ownerAddress: OWNER.personal,
  });
  return writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
}

// The documents under a root, with their reference mark and their evidence.
const documentsUnder = (db: TestDatabase, rootId: string) =>
  admin<{ id: string; reference: boolean; evidence_id: string }>(
    db,
    "select id, reference, evidence_id from knowledge.documents where root_id = $1 order by id",
    [rootId],
  );

// Runs `fn` while another connection holds the sync lock, as a running sync does.
async function whileSyncRuns<T>(db: TestDatabase, fn: () => Promise<T>): Promise<T> {
  return session(db.urls.admin, async (query) => {
    expect(one(await query<{ held: boolean }>(`select pg_try_advisory_lock(${SYNC_LOCK}) as held`)).held).toBe(true);
    try {
      return await fn();
    } finally {
      await query(`select pg_advisory_unlock(${SYNC_LOCK})`);
    }
  });
}

// Two roots of the personal label, with two documents under the first and one under the second.
async function world(test: TestStore) {
  const account = await test.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
  const first = (await test.admin.drive.addRoot("personal", FOLDER, "extract")).id;
  const second = (await test.admin.drive.addRoot("personal", SECOND, "extract")).id;
  for (const doc of [
    file("fileGdRootsA0001", FOLDER),
    file("fileGdRootsA0002", FOLDER),
    file("fileGdRootsB0001", SECOND),
  ])
    expect(await store(test.writer, account, doc)).toBe("stored");
  return { account, first, second };
}

// The label's Drive cursor, given a stand-in value first so a reset to null shows.
async function withCursor(db: TestDatabase, accountId: string): Promise<void> {
  await admin(db, "update vault.source_accounts set cursor_enc = address_enc where id = $1", [accountId]);
  expect(await cursorSet(db, accountId)).toBe(true);
}
const cursorSet = async (db: TestDatabase, accountId: string): Promise<boolean> =>
  one(
    await admin<{ set: boolean }>(db, "select cursor_enc is not null as set from vault.source_accounts where id = $1", [
      accountId,
    ]),
  ).set;

const withStore = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({}, fn);

describe("the owner's roots", { timeout: TIMEOUT }, () => {
  it("addRoot stores a root by its keyed fingerprint, sealed, and roots and listRoots list it", () =>
    withStore(async (test) => {
      const { db, admin: owner, writer } = test;
      const folder = await owner.drive.addRoot("personal", FOLDER, "extract");
      const myDrive = await owner.drive.addRoot("personal", "my-drive", "reference");
      const shared = await owner.drive.addRoot("work", "shared-with-me", "extract");
      for (const made of [folder, myDrive, shared]) expect(made.id).toMatch(/^drt_[0-9A-HJKMNP-TV-Z]{26}$/);

      const rows = await admin<{
        id: string;
        label: string;
        kind: string;
        root_fp: string;
        mode: string;
        root_enc: unknown;
      }>(db, "select id, label, kind, root_fp, mode, root_enc from policy.drive_roots");
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(rows).toHaveLength(3);
      expect(byId.get(folder.id)).toMatchObject({
        label: "personal",
        kind: "folder",
        mode: "extract",
        root_fp: fingerprint(db.keys, "source_id", FOLDER),
      });
      expect(byId.get(myDrive.id)).toMatchObject({
        label: "personal",
        kind: "my-drive",
        mode: "reference",
        root_fp: fingerprint(db.keys, "source_id", "my-drive"),
      });
      expect(byId.get(shared.id)).toMatchObject({
        label: "work",
        kind: "shared-with-me",
        mode: "extract",
        root_fp: fingerprint(db.keys, "source_id", "shared-with-me"),
      });
      // The folder's id is sealed under the `own` key, bound to its row, and in no column in clear.
      expect(
        opened(
          db,
          "own",
          { table: "policy.drive_roots", id: folder.id, column: "root_enc" },
          byId.get(folder.id)?.root_enc,
        ),
      ).toBe(FOLDER);
      expect(await scanForPlaintext(db.urls.admin, [FOLDER])).toEqual([]);

      const listed = (await owner.drive.roots()).sort((left, right) => (left.id < right.id ? -1 : 1));
      expect(listed).toEqual(
        [
          { id: folder.id, label: "personal", kind: "folder", mode: "extract", documents: 0 },
          { id: myDrive.id, label: "personal", kind: "my-drive", mode: "reference", documents: 0 },
          { id: shared.id, label: "work", kind: "shared-with-me", mode: "extract", documents: 0 },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );
      // roots() names no folder id.
      expect(JSON.stringify(listed)).not.toContain(FOLDER);
      const personal = (await writer.listRoots("personal")).sort((left, right) => (left.id < right.id ? -1 : 1));
      expect(personal).toEqual(
        [
          { id: folder.id, root: FOLDER, mode: "extract" },
          { id: myDrive.id, root: "my-drive", mode: "reference" },
        ].sort((left, right) => (left.id < right.id ? -1 : 1)),
      );

      // The same root twice for a label is refused, and leaves one row; for another label it is a root of its own.
      await expect(owner.drive.addRoot("personal", FOLDER, "reference")).rejects.toThrow();
      expect(
        await count(db, "policy.drive_roots", "label = 'personal' and root_fp = $1", [
          fingerprint(db.keys, "source_id", FOLDER),
        ]),
      ).toBe(1);
      await owner.drive.addRoot("work", FOLDER, "extract");
      expect(await count(db, "policy.drive_roots", "root_fp = $1", [fingerprint(db.keys, "source_id", FOLDER)])).toBe(
        2,
      );
    }));

  it("roots counts the documents stored under each root", () =>
    withStore(async (test) => {
      const { first, second } = await world(test);
      const counts = Object.fromEntries((await test.admin.drive.roots()).map((root) => [root.id, root.documents]));
      expect(counts).toEqual({ [first]: 2, [second]: 1 });
    }));

  it("addRoot starts a new listing for its label: the label's Drive cursor is reset, another label's is kept", () =>
    withStore(async (test) => {
      const { db } = test;
      const { account } = await world(test);
      const work = await test.writer.ensureSourceAccount("work", "google_docs", "own", OWNER.personal);
      await withCursor(db, account.id);
      await withCursor(db, work.id);
      await test.admin.drive.addRoot("personal", "my-drive", "extract");
      expect(await cursorSet(db, account.id)).toBe(false);
      expect(await cursorSet(db, work.id)).toBe(true);
    }));

  it("addRoot while a sync holds the lock is refused with sync_running, and keeps the cursor the sync is writing", () =>
    withStore(async (test) => {
      const { db } = test;
      const { account } = await world(test);
      await withCursor(db, account.id);
      const before = await admin(db, "select * from policy.drive_roots order by id");

      await whileSyncRuns(db, () =>
        expect(test.admin.drive.addRoot("personal", "my-drive", "extract")).rejects.toMatchObject({
          code: "sync_running",
        }),
      );
      expect(await admin(db, "select * from policy.drive_roots order by id")).toEqual(before);
      expect(await cursorSet(db, account.id)).toBe(true);

      // The positive control: once the sync has ended, the same call adds the root and resets the cursor.
      await test.admin.drive.addRoot("personal", "my-drive", "extract");
      expect(await count(db, "policy.drive_roots")).toBe(before.length + 1);
      expect(await cursorSet(db, account.id)).toBe(false);
    }));

  describe("removing a root", () => {
    it("removing a root removes its documents in one transaction", () =>
      withStore(async (test) => {
        const { db } = test;
        const { account, first, second } = await world(test);
        const removed = await documentsUnder(db, first);
        expect(removed).toHaveLength(2);
        const evidence = removed.map((row) => row.evidence_id);
        const blobs = await admin<{ blob_ref: string }>(
          db,
          "select blob_ref from vault.evidence_items where id = any($1)",
          [evidence],
        );

        expect(await test.admin.drive.removeRoot(first)).toEqual({ removed: 2 });

        expect(await count(db, "policy.drive_roots", "id = $1", [first])).toBe(0);
        expect(await count(db, "knowledge.documents", "id = any($1)", [removed.map((row) => row.id)])).toBe(0);
        expect(await count(db, "vault.evidence_items", "id = any($1)", [evidence])).toBe(0);
        expect(await count(db, "vault.evidence_blobs", "blob_ref = any($1)", [blobs.map((row) => row.blob_ref)])).toBe(
          0,
        );
        // A removal, not an erasure: no removed-evidence row, so the files are stored again if a root admits them.
        expect(await count(db, "knowledge.removed_evidence")).toBe(0);
        // The positive control: the other root and its document stay.
        expect(await count(db, "policy.drive_roots", "id = $1", [second])).toBe(1);
        expect(await documentsUnder(db, second)).toHaveLength(1);
        expect((await test.admin.drive.roots()).map((root) => root.id)).toEqual([second]);
        expect(await test.writer.listRoots("personal")).toEqual([{ id: second, root: SECOND, mode: "extract" }]);
        expect(await count(db, "vault.source_accounts", "id = $1", [account.id])).toBe(1);
      }));

    it("removing a root starts a new listing for its label, so a document still in scope under another root is stored again", () =>
      withStore(async (test) => {
        const { db } = test;
        const { account, first } = await world(test);
        const work = await test.writer.ensureSourceAccount("work", "google_docs", "own", OWNER.personal);
        await withCursor(db, account.id);
        await withCursor(db, work.id);
        expect(await test.admin.drive.removeRoot(first)).toEqual({ removed: 2 });
        expect(await cursorSet(db, account.id)).toBe(false);
        expect(await cursorSet(db, work.id)).toBe(true);
      }));

    it("removing a root while a sync holds the lock is refused with sync_running", () =>
      withStore(async (test) => {
        const { db } = test;
        const { first } = await world(test);
        const before = {
          roots: await admin(db, "select * from policy.drive_roots order by id"),
          documents: await admin(db, "select * from knowledge.documents order by id"),
        };

        await whileSyncRuns(db, () =>
          expect(test.admin.drive.removeRoot(first)).rejects.toMatchObject({ code: "sync_running" }),
        );
        expect({
          roots: await admin(db, "select * from policy.drive_roots order by id"),
          documents: await admin(db, "select * from knowledge.documents order by id"),
        }).toEqual(before);

        // The positive control: once the sync has ended, the same call removes the root.
        expect(await test.admin.drive.removeRoot(first)).toEqual({ removed: 2 });
        expect(await count(db, "policy.drive_roots", "id = $1", [first])).toBe(0);
      }));
  });

  describe("setting a root's mode", () => {
    it("setting a root's mode sets it on its documents", () =>
      withStore(async (test) => {
        const { db } = test;
        const { first, second } = await world(test);
        expect((await documentsUnder(db, first)).map((row) => row.reference)).toEqual([false, false]);

        expect(await test.admin.drive.setRootMode(first, "reference")).toEqual({ documents: 2 });
        expect(
          one(await admin<{ mode: string }>(db, "select mode from policy.drive_roots where id = $1", [first])).mode,
        ).toBe("reference");
        expect((await documentsUnder(db, first)).map((row) => row.reference)).toEqual([true, true]);
        // The positive control: the other root's document keeps its mark.
        expect((await documentsUnder(db, second)).map((row) => row.reference)).toEqual([false]);
        expect((await test.admin.drive.roots()).find((root) => root.id === first)?.mode).toBe("reference");

        // And back.
        expect(await test.admin.drive.setRootMode(first, "extract")).toEqual({ documents: 2 });
        expect((await documentsUnder(db, first)).map((row) => row.reference)).toEqual([false, false]);
      }));

    it("setting a root's mode while a sync holds the lock is refused with sync_running", () =>
      withStore(async (test) => {
        const { db } = test;
        const { first } = await world(test);
        await whileSyncRuns(db, () =>
          expect(test.admin.drive.setRootMode(first, "reference")).rejects.toMatchObject({ code: "sync_running" }),
        );
        expect(
          one(await admin<{ mode: string }>(db, "select mode from policy.drive_roots where id = $1", [first])).mode,
        ).toBe("extract");
        expect((await documentsUnder(db, first)).map((row) => row.reference)).toEqual([false, false]);

        // The positive control: once the sync has ended, the same call sets it.
        expect(await test.admin.drive.setRootMode(first, "reference")).toEqual({ documents: 2 });
        expect((await documentsUnder(db, first)).map((row) => row.reference)).toEqual([true, true]);
      }));
  });
});
