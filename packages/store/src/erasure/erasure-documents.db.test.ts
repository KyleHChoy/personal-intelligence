import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentId, type EntityId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DocBody, type DriveFile, deriveItem, driveItem } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { AdminError } from "../core/admin-error.ts";
import { connect, OWNER, QUENTIN } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// Documents through erasure and release. Every refusal has its positive control.

const TIMEOUT = 180_000;
const FOLDER = "fldEraseDocsRoot0001";

type World = {
  store: TestStore;
  db: TestDatabase;
  admin: Admin;
  journal: string;
  drive: SourceAccountRow;
  mail: SourceAccountRow;
};

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-erase-docs-"));
  const store = await openStore();
  try {
    const journal = join(dir, "keys.json.erasures");
    const { personalMail } = await connect(store.writer);
    const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, journal });
    const drive = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
    await admin.drive.addRoot("personal", FOLDER, "extract");
    await fn({ store, db: store.db, admin, journal, drive, mail: personalMail });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const file = (id: string, over: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name: `Notes ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00.000Z",
  modifiedTime: "2026-09-02T09:00:00.000Z",
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal },
  canDownload: true,
  ...over,
});
const BODY: DocBody = { blocks: [{ kind: "paragraph", text: "Notes." }] };

async function put(world: World, doc: DriveFile, body: DocBody = BODY): Promise<string> {
  const raw = driveItem(doc, body, null, {
    sourceAccount: world.drive.id,
    changeKind: "backfill",
    ownerAddress: OWNER.personal,
  });
  return world.store.writer.ingestItem(world.drive, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
}

const admin = <Row = Record<string, unknown>>(world: World, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(world.db.urls.admin, text, values);
const documentOf = async (
  world: World,
  fileId: string,
): Promise<
  { id: DocumentId; owner_fp: string | null; sharer_fp: string | null; owner_enc: unknown; held: boolean } | undefined
> =>
  (
    await admin<{
      id: DocumentId;
      owner_fp: string | null;
      sharer_fp: string | null;
      owner_enc: unknown;
      held: boolean;
    }>(world, "select id, owner_fp, sharer_fp, owner_enc, held from knowledge.documents where file_fp = $1", [
      fingerprint(world.db.keys, "source_id", fileId),
    ])
  )[0];
const personOf = async (world: World, address: string): Promise<EntityId> =>
  one(
    await admin<{ entity_id: string }>(world, "select distinct entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(world.db.keys, "address", address),
    ]),
  ).entity_id as EntityId;
const req = (): string => testId("req");

describe("documents in erasure and release", { timeout: TIMEOUT }, () => {
  it("an erased document is removed, is not stored again while Drive still lists it, and is stored again after a lift", () =>
    inWorld(async (world) => {
      const doc = file("1EraseMe00001");
      expect(await put(world, doc)).toBe("stored");
      const stored = await documentOf(world, doc.id);
      // A dry run changes nothing and reports the same counts.
      const dry = await world.admin.erasure.eraseItem(
        { kind: "document", id: stored?.id as DocumentId },
        { requestId: req(), dryRun: true },
      );
      expect(await documentOf(world, doc.id)).toBeDefined();
      const report = await world.admin.erasure.eraseItem(
        { kind: "document", id: stored?.id as DocumentId },
        { requestId: req() },
      );
      expect({ ...report, erasure: null }).toEqual({ ...dry, erasure: null });
      expect(report.items).toBe(1);
      expect(await documentOf(world, doc.id)).toBeUndefined();
      expect((await admin<{ reason: string }>(world, "select reason from knowledge.removed_evidence"))[0]?.reason).toBe(
        "owner_erasure",
      );
      // Drive still hands it over: it is not stored, and hasRevision answers true, so it is not fetched.
      expect(await put(world, { ...doc, modifiedTime: "2026-09-03T09:00:00.000Z" })).toBe("removed");
      expect(await world.store.writer.hasRevision(world.drive, `drive-file:${doc.id}`, "any-tag")).toBe(true);
      // After the lift it is stored again.
      expect(await world.admin.erasure.liftErasure(report.erasure as never, { requestId: req() })).toBe(true);
      expect(await put(world, { ...doc, modifiedTime: "2026-09-04T09:00:00.000Z" })).toBe("stored");
    }));

  // A release locks the document row, then updates its evidence row. An
  // erasure must take the same order, or the two deadlock (40P01).
  it("an erasure locks a document's row before its evidence rows, as a release does, so the two never deadlock", () =>
    inWorld(async (world) => {
      const doc = file("1LockOrder0001", { name: "Your verification code" });
      expect(await put(world, doc)).toBe("stored");
      const stored = await documentOf(world, doc.id);
      const evidence = one(
        await admin<{ evidence_id: string }>(world, "select evidence_id from knowledge.documents where id = $1", [
          stored?.id,
        ]),
      ).evidence_id;
      await session(world.db.urls.admin, async (query) => {
        // The release's first statement: the document row, held by this side.
        await query("begin");
        await query("select 1 from knowledge.documents where id = $1 for update", [stored?.id]);
        const erasure = world.admin.erasure.eraseItem(
          { kind: "document", id: stored?.id as DocumentId },
          { requestId: req() },
        );
        const settled = erasure.then(
          (report) => ({ report, error: null }),
          (error: unknown) => ({ report: null, error }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // The release's next statement, its evidence row: free, since the erasure waits on the document row.
        await query("set local lock_timeout = '10s'");
        await query("update vault.evidence_items set hold_released_at = now() where id = $1", [evidence]);
        await query("commit");
        const { report, error } = await settled;
        expect(error).toBeNull();
        expect(report?.items).toBe(1);
      });
      expect(await documentOf(world, doc.id)).toBeUndefined();
    }));

  it("an id that names no document is not_found", () =>
    inWorld(async (world) => {
      await expect(
        world.admin.erasure.eraseItem(
          { kind: "document", id: DocumentId.parse(`doc_${"0".repeat(26)}`) },
          { requestId: req() },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    }));

  it("a deleted file leaves no row that cites it, writes no removed-evidence row, and is stored again when it returns", () =>
    inWorld(async (world) => {
      const doc = file("1DeleteMe0001");
      await put(world, doc);
      await world.store.writer.applyDeletion(world.drive, {
        sourceAccount: world.drive.id,
        sourceItemId: `drive-file:${doc.id}`,
        deletedAt: "2026-09-05T00:00:00.000Z",
      });
      expect(await documentOf(world, doc.id)).toBeUndefined();
      expect(await admin(world, "select 1 from vault.evidence_items where source_kind = 'document'")).toEqual([]);
      expect(await admin(world, "select 1 from knowledge.removed_evidence")).toEqual([]);
      expect(await put(world, doc)).toBe("stored");
    }));

  it("erasing a person clears their fingerprint and sealed value from the documents they own or shared, erases none, and a dry run reports the same count", () =>
    inWorld(async (world) => {
      await put(world, file("1QuentinOwns01", { ownedByMe: false, owner: { address: QUENTIN.address } }));
      await put(world, file("1QuentinShared", { sharer: { address: QUENTIN.address } }));
      await put(world, file("1NotQuentin001"));
      // A document makes no person: Quentin is one from mail, copied on MAIL.solo.
      expect(await ingestMail(world.store.writer, world.mail, MAIL.solo)).toBe("stored");
      const person = await personOf(world, QUENTIN.address);
      const dry = await world.admin.erasure.erasePerson(person, { requestId: req(), dryRun: true });
      expect(dry.more.documents).toBe(2);
      expect((await documentOf(world, "1QuentinOwns01"))?.owner_fp).not.toBeNull();
      const report = await world.admin.erasure.erasePerson(person, { requestId: req() });
      expect(report.more.documents).toBe(2);
      const owned = await documentOf(world, "1QuentinOwns01");
      expect([owned?.owner_fp, owned?.owner_enc]).toEqual([null, null]);
      expect((await documentOf(world, "1QuentinShared"))?.sharer_fp).toBeNull();
      expect((await documentOf(world, "1QuentinShared"))?.owner_fp).not.toBeNull();
      expect((await documentOf(world, "1NotQuentin001"))?.owner_fp).not.toBeNull();
      expect((await admin<{ n: number }>(world, "select count(*)::int as n from knowledge.documents"))[0]?.n).toBe(3);
      // A later document they share is stored with no fingerprint for them.
      await put(world, file("1QuentinLater1", { sharer: { address: QUENTIN.address } }));
      expect((await documentOf(world, "1QuentinLater1"))?.sharer_fp).toBeNull();
    }));

  it("release by id unholds one document and records one release decision; an id that names no held document is not_found", () =>
    inWorld(async (world) => {
      await put(world, file("1HeldOne00001", { name: "Your verification code" }));
      await put(
        world,
        file("1HeldTwo00001", { name: "Reset your password", modifiedTime: "2026-01-02T09:00:00.000Z" }),
      );
      const held = await world.admin.held.documents();
      expect(held.held).toBe(2);
      const first = await documentOf(world, "1HeldOne00001");
      expect(await world.admin.held.releaseHeldDocuments({ id: first?.id as string })).toEqual({ released: 1 });
      expect((await documentOf(world, "1HeldOne00001"))?.held).toBe(false);
      expect(await admin(world, "select target_kind from knowledge.owner_decisions where kind = 'release'")).toEqual([
        { target_kind: "document" },
      ]);
      await expect(world.admin.held.releaseHeldDocuments({ id: first?.id as string })).rejects.toBeInstanceOf(
        AdminError,
      );
      // A new revision that still matches is held again.
      expect(
        await put(
          world,
          file("1HeldOne00001", { name: "Your verification code", modifiedTime: "2026-09-09T09:00:00.000Z" }),
        ),
      ).toBe("stored");
      expect((await documentOf(world, "1HeldOne00001"))?.held).toBe(true);
    }));

  it("release --older-than unholds the older ones only", () =>
    inWorld(async (world) => {
      await put(
        world,
        file("1HeldOld00001", { name: "Your verification code", modifiedTime: "2020-01-02T09:00:00.000Z" }),
      );
      await put(
        world,
        file("1HeldNew00001", { name: "Your verification code", modifiedTime: new Date().toISOString() }),
      );
      expect(await world.admin.held.releaseHeldDocuments({ olderThanDays: 30 })).toEqual({ released: 1 });
      expect((await documentOf(world, "1HeldOld00001"))?.held).toBe(false);
      expect((await documentOf(world, "1HeldNew00001"))?.held).toBe(true);
    }));
});
