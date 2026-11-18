import { type ConnectorCursor, RawItem, type SourceAccount } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { driveRevisionTag } from "../items/documents.ts";
import type { ConnectorOptions, PersonalConnector, PersonalPage } from "../items/types.ts";
import { type FakeDrive, type FakeDriveFile, fakeDrive } from "./drive.ts";

// The fake Drive hands over the pages the real connector is given.

const now = "2026-03-10T12:00:00.000Z";
const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const account: SourceAccount = { id: sourceAccount, connector: "google_docs" } as SourceAccount;
const DOC = "application/vnd.google-apps.document";

const file = (id: string, parent: string, over: Partial<FakeDriveFile> = {}): FakeDriveFile => ({
  id,
  name: `Name ${id}`,
  mimeType: DOC,
  createdTime: "2026-01-01T00:00:00.000Z",
  modifiedTime: "2026-02-01T00:00:00.000Z",
  parent,
  ownedByMe: true,
  modifiedByMe: true,
  canDownload: true,
  ...over,
});
const body = (text: string) => ({ blocks: [{ kind: "paragraph" as const, text }] });

// A drive with two folders under My Drive: `root-a` (a root) holding `sub-a`, and `other`.
function made(): FakeDrive {
  const drive = fakeDrive({ address: "owner@example.org" }, { now });
  drive.createFolder("root-a");
  drive.createFolder("sub-a", "root-a");
  drive.createFolder("other");
  drive.put(file("doc-1", "root-a"), body("one"));
  drive.put(file("doc-2", "sub-a"), body("two"));
  drive.put(file("sheet-1", "root-a", { mimeType: "application/vnd.google-apps.spreadsheet" }));
  drive.put(file("doc-out", "other"), body("outside"));
  return drive;
}

const ids = (page: PersonalPage): string[] => page.items.map((item) => item.sourceItemId);

// Every page until one with no more, from a cursor.
async function drain(
  connector: PersonalConnector,
  cursor: ConnectorCursor | null,
): Promise<{ pages: PersonalPage[]; next: ConnectorCursor | null }> {
  const pages: PersonalPage[] = [];
  let at = cursor;
  for (let i = 0; i < 50; i += 1) {
    const page = await connector.listChanges(account, at, 100);
    pages.push(page);
    at = page.next;
    if (!page.more) break;
  }
  return { pages, next: at };
}

const roots = (...list: string[]): ConnectorOptions => ({ roots: list });

describe("fakeDrive", () => {
  it("a listing hands over every file under a root and ends complete", async () => {
    const drive = made();
    const { pages } = await drain(drive.connector(sourceAccount, roots("root-a")), null);
    expect(pages).toHaveLength(1);
    const [page] = pages as [PersonalPage];
    expect(ids(page)).toEqual(["drive-file:doc-1", "drive-file:doc-2", "drive-file:sheet-1"]);
    expect(page.listing).toEqual({ first: true, ended: "complete" });
    for (const item of page.items) expect(RawItem.safeParse(item).success).toBe(true);
    expect(page.items.map((item) => item.markers)).toEqual([
      ["drive", "root:root-a"],
      ["drive", "root:root-a"],
      ["drive", "root:root-a"],
    ]);
    // With no root: no call, and an empty page that ends a complete listing.
    const none = await made().connector(sourceAccount, roots()).listChanges(account, null, 10);
    expect([none.items, none.listing]).toEqual([[], { first: true, ended: "complete" }]);
  });

  it("an edit, a move out, a trash, a deletion and an unshare each give what R11 says", async () => {
    const drive = made();
    drive.put(file("doc-3", "root-a"), body("three"));
    drive.put(file("doc-4", "root-a"), body("four"));
    const connector = drive.connector(sourceAccount, roots("root-a"));
    const { next } = await drain(connector, null);
    drive.edit("doc-1", { body: body("one, edited") });
    drive.move("doc-2", "other");
    drive.trash("sheet-1");
    drive.deletePermanently("doc-3");
    drive.unshare("doc-4");
    const [page] = (await drain(connector, next)).pages as [PersonalPage];
    expect(ids(page)).toEqual(["drive-file:doc-1"]);
    expect(page.left).toEqual(["drive-file:doc-2", "drive-file:sheet-1"]);
    expect(page.deletions).toEqual([
      { sourceAccount, sourceItemId: "drive-file:doc-3", deletedAt: now },
      { sourceAccount, sourceItemId: "drive-file:doc-4", deletedAt: now },
    ]);
    expect(page.listing).toBeUndefined();
    // Two changes to one file give one entry.
    drive.edit("doc-1");
    drive.edit("doc-1");
    expect(ids((await drain(connector, page.next)).pages[0] as PersonalPage)).toEqual(["drive-file:doc-1"]);
  });

  it("a folder move across a root ends the feed and the next listing names none of its files", async () => {
    const drive = made();
    const connector = drive.connector(sourceAccount, roots("root-a"));
    const { next } = await drain(connector, null);
    drive.moveFolder("sub-a", "other");
    const ended = await connector.listChanges(account, next, 100);
    expect(ended.more).toBe(true);
    const listing = await connector.listChanges(account, ended.next, 100);
    expect(listing.listing).toEqual({ first: true, ended: "complete" });
    expect(ids(listing)).toEqual(["drive-file:doc-1", "drive-file:sheet-1"]);
    // Moved back in, it ends the feed again and is listed.
    drive.moveFolder("sub-a", "root-a");
    const again = await connector.listChanges(account, listing.next, 100);
    expect(again.more).toBe(true);
    expect(ids(await connector.listChanges(account, again.next, 100))).toContain("drive-file:doc-2");
  });

  it("a folder created outside every root does not end the feed", async () => {
    const drive = made();
    const connector = drive.connector(sourceAccount, roots("root-a"));
    const { next } = await drain(connector, null);
    drive.createFolder("new-outside", "other");
    const page = await connector.listChanges(account, next, 100);
    expect([page.more, page.listing, page.items]).toEqual([false, undefined, []]);
    // The positive control: one created inside a root does.
    drive.createFolder("new-inside", "root-a");
    expect((await connector.listChanges(account, page.next, 100)).more).toBe(true);
  });

  it("a pending id gone at files.get is named in left", async () => {
    const drive = made();
    for (let i = 10; i < 40; i += 1) drive.put(file(`doc-${i}`, "root-a"), body(`n${i}`));
    const connector = drive.connector(sourceAccount, roots("root-a"));
    const first = await connector.listChanges(account, null, 100);
    // 25 documents are fetched; the rest wait.
    expect(first.items.filter((item) => item.depth === "full")).toHaveLength(25);
    expect(first.more).toBe(true);
    const waiting = "doc-9";
    drive.put(file(waiting, "root-a"), body("late"));
    drive.deletePermanently("doc-36");
    const second = await connector.listChanges(account, first.next, 100);
    expect(second.left).toEqual(["drive-file:doc-36"]);
    expect(second.listing).toEqual({ first: false, ended: "complete" });
  });

  it("fetched holds only Google Docs in scope", async () => {
    const drive = made();
    drive.put(file("pdf-1", "root-a", { mimeType: "application/pdf" }));
    drive.put(file("locked", "root-a", { canDownload: false }), body("no download"));
    const { pages } = await drain(drive.connector(sourceAccount, roots("root-a")), null);
    expect(drive.fetched).toEqual(["doc-1", "doc-2"]);
    const bare = pages
      .flatMap((page) => page.items)
      .filter((item) => item.depth === "headers")
      .map((item) => item.sourceItemId);
    expect(bare.sort()).toEqual(["drive-file:locked", "drive-file:pdf-1", "drive-file:sheet-1"]);
  });

  it("a stored tag is not fetched, and the reset cursor fetches it again", async () => {
    const drive = made();
    const tags = new Set<string>();
    const stored = async (id: string, tag?: string): Promise<boolean> => tags.has(`${id} ${tag}`);
    const tagged = await drive.connector(sourceAccount, roots("root-a")).listChanges(account, null, 100);
    for (const item of tagged.items) tags.add(`${item.sourceItemId} ${item.revisionTag}`);
    const before = drive.fetched.length;
    const connector = drive.connector(sourceAccount, { roots: ["root-a"], stored });
    const again = await connector.listChanges(account, null, 100);
    expect([again.items, again.listed]).toEqual([[], ["drive-file:doc-1", "drive-file:doc-2", "drive-file:sheet-1"]]);
    expect(drive.fetched.length).toBe(before);
    const reset = await connector.listChanges(account, connector.resetCursor(), 100);
    expect(ids(reset)).toHaveLength(3);
    expect(connector.resetCursor()).toBe(connector.resetCursor());
    expect(driveRevisionTag({ ...file("doc-1", "root-a"), root: "root-a" })).toBe(reset.items[0]?.revisionTag);
  });

  it("the same cursor gives the same page while the store is unchanged", async () => {
    const drive = made();
    const connector = drive.connector(sourceAccount, roots("root-a"));
    const { next } = await drain(connector, null);
    drive.edit("doc-2");
    expect(await connector.listChanges(account, next, 100)).toEqual(await connector.listChanges(account, next, 100));
    expect(await connector.listChanges(account, null, 100)).toEqual(await connector.listChanges(account, null, 100));
  });

  it("the removals pass reads the feed alone, and makes no listing", async () => {
    const drive = made();
    const { next } = await drain(drive.connector(sourceAccount, roots("root-a")), null);
    drive.deletePermanently("doc-1");
    drive.trash("sheet-1");
    drive.edit("doc-2");
    drive.moveFolder("sub-a", "other");
    const before = drive.fetched.length;
    const removals = drive.connector(sourceAccount, { roots: ["root-a"], removalsOnly: true });
    const page = await removals.listChanges(account, next, 100);
    expect(page.deletions.map((one) => one.sourceItemId)).toEqual(["drive-file:doc-1"]);
    expect([page.left, page.items, page.listing, drive.fetched.length]).toEqual([
      ["drive-file:sheet-1"],
      [],
      undefined,
      before,
    ]);
    // From no cursor or a listing's, nothing at all, and the cursor given back.
    const idle = await removals.listChanges(account, null, 100);
    expect([idle.items, idle.deletions, idle.more]).toEqual([[], [], false]);
  });
});
