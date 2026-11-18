import {
  type ConnectorCursor,
  type HttpPort,
  RawItem,
  type SourceAccount,
  type SourceCredential,
} from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import type { Connector } from "@intelligence/personal-core/items";
import {
  type DriveFile,
  driveRevisionTag,
  type PersonalConnector,
  type PersonalPage,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { createGoogleConnector } from "./connector.ts";
import { calendarCursor, driveCursor, mailCursor, readDriveCursor } from "./cursor.ts";
import { FILE_FIELDS } from "./drive.ts";
import { createGoogleHttp, type GoogleDeps, MAX_DOCUMENT_ANSWER_BYTES, scopesFor } from "./http.ts";
import { failureOfCall as failure } from "./test-support/fixtures.ts";

// Every value is made up; no test reaches the network.

const accountId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const account: SourceAccount = {
  id: accountId,
  connector: "google_docs",
  sourceKind: "document",
  vault: "personal",
  externalRef: "personal",
  accessSyncKind: "none",
  compartments: ["own"],
  markerCompartments: [],
};
const credential: SourceCredential = {
  connector: "google_docs",
  sourceAccount: accountId,
  scopes: [...scopesFor("drive")],
  secret: '{"fake":"secret"}',
};
const OWNER = "owner@example.org";
const MY = "myDriveRootId0";
const DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const T0 = Date.parse("2026-03-10T12:00:00.000Z");

type Meta = Record<string, unknown> & { id: string; mimeType: string };
type Change = { changeType?: string; fileId: string; removed?: boolean; file?: Meta };
type Call = { url: URL; at: number; method: string; kind: string | undefined; timeoutMs: number | undefined };

// A Drive of folders and files, a Docs body for each Google Doc, and a changes log whose token
// is its length.
function fakeDrive() {
  const clock = { now: T0 };
  const folders = new Map<string, string | undefined>();
  const files = new Map<string, Meta>();
  const docs = new Map<string, unknown>();
  const status = new Map<string, number>();
  const log: Change[] = [];
  const calls: Call[] = [];
  let feedStatus: number | undefined;
  let inFlight = 0;
  let overlapped = false;

  const meta = (id: string, over: Record<string, unknown> = {}): Meta => ({
    id,
    name: `Name ${id}`,
    mimeType: DOC,
    createdTime: "2026-01-01T00:00:00.000Z",
    modifiedTime: "2026-02-01T00:00:00.000Z",
    parents: ["A"],
    ownedByMe: true,
    owners: [{ emailAddress: OWNER, displayName: "Owner Example" }],
    lastModifyingUser: { me: true },
    capabilities: { canDownload: true },
    ...over,
  });
  const body = (text: string) => ({
    title: "t",
    tabs: [
      {
        tabProperties: { tabId: "t.0", title: "Tab", index: 0 },
        documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] } },
      },
    ],
  });

  const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, at: clock.now, method: init.method ?? "GET", kind: undefined, timeoutMs: undefined });
    if (inFlight > 0) overlapped = true;
    inFlight += 1;
    try {
      const path = url.pathname;
      const q = url.searchParams;
      if (url.hostname === "docs.googleapis.com") {
        const id = decodeURIComponent(path.split("/").pop() ?? "");
        const code = status.get(id);
        if (code !== undefined) return json({ error: { errors: [{ reason: "forbidden" }] } }, code);
        return docs.has(id) ? json(docs.get(id)) : json({}, 404);
      }
      if (path === "/drive/v3/about") return json({ user: { emailAddress: OWNER } });
      if (path === "/drive/v3/files/root") return json({ id: MY });
      if (path === "/drive/v3/changes/startPageToken") return json({ startPageToken: String(log.length) });
      if (path === "/drive/v3/changes") {
        if (feedStatus !== undefined) return json({}, feedStatus);
        const from = Number(q.get("pageToken"));
        const size = Number(q.get("pageSize"));
        const slice = log.slice(from, from + size);
        const end = from + slice.length;
        return json({
          changes: slice.map((one) => ({ changeType: "file", ...one })),
          ...(end < log.length ? { nextPageToken: String(end) } : { newStartPageToken: String(log.length) }),
        });
      }
      if (path === "/drive/v3/files") {
        const from = Number(q.get("pageToken") ?? "0");
        const size = Number(q.get("pageSize"));
        if (q.get("q")?.startsWith("mimeType = "))
          return json({
            files: [...folders].map(([id, parent]) => ({ id, ...(parent === undefined ? {} : { parents: [parent] }) })),
          });
        const all = [...files.values()].filter((one) => one.trashed !== true);
        const slice = all.slice(from, from + size);
        return json({ files: slice, ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}) });
      }
      if (path.startsWith("/drive/v3/files/")) {
        const id = decodeURIComponent(path.slice("/drive/v3/files/".length));
        return files.has(id) ? json(files.get(id)) : json({}, 404);
      }
      return json({}, 404);
    } finally {
      inFlight -= 1;
    }
  };
  const deps: GoogleDeps = {
    fetch,
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
    random: () => 0.5,
    timeoutMs: 1234,
  };
  const http = createGoogleHttp({ tokens: null, deps, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES });

  const drive = {
    clock,
    calls,
    deps,
    log,
    files,
    docs,
    status,
    get overlapped() {
      return overlapped;
    },
    folder(id: string, parent: string | undefined) {
      folders.set(id, parent);
      return drive;
    },
    put(id: string, over: Record<string, unknown> = {}, text = `Text of ${id}`) {
      const one = meta(id, over);
      files.set(id, one);
      if (one.mimeType === DOC) docs.set(id, body(text));
      log.push({ fileId: id, file: one });
      return one;
    },
    edit(id: string, over: Record<string, unknown>) {
      const one = { ...(files.get(id) as Meta), ...over };
      files.set(id, one);
      log.push({ fileId: id, file: one });
    },
    moveFolder(id: string, parent: string) {
      folders.set(id, parent);
      log.push({
        fileId: id,
        file: {
          id,
          mimeType: FOLDER,
          parents: [parent],
          name: "f",
          createdTime: "2026-01-01T00:00:00.000Z",
          modifiedTime: "2026-01-01T00:00:00.000Z",
        },
      });
    },
    remove(id: string) {
      files.delete(id);
      log.push({ fileId: id, removed: true });
    },
    failFeed(code: number | undefined) {
      feedStatus = code;
    },
    connector(
      options: {
        roots?: string[];
        stored?: (id: string, tag?: string) => Promise<boolean>;
        removalsOnly?: boolean;
      } = {},
    ): PersonalConnector {
      return createGoogleConnector("google_docs", credential, http, { roots: ["A"], ...options }, deps);
    },
    docGets: () => calls.filter((one) => one.url.hostname === "docs.googleapis.com"),
    drivePaths: () => calls.filter((one) => one.url.hostname === "www.googleapis.com").map((one) => one.url.pathname),
  };
  // My Drive > A (root) > B ; My Drive > D (outside).
  drive.folder("A", MY).folder("B", "A").folder("D", MY);
  return drive;
}

const ids = (page: PersonalPage): string[] => page.items.map((item) => item.sourceItemId);
const phaseOf = (page: PersonalPage) => readDriveCursor(page.next);

// Every page of a listing from `cursor`, until it ends.
async function drain(
  connector: PersonalConnector,
  cursor: ConnectorCursor | null,
  limit = 100,
): Promise<PersonalPage[]> {
  const pages: PersonalPage[] = [];
  let at = cursor;
  for (let n = 0; n < 50; n += 1) {
    const page = await connector.listChanges(account, at, limit);
    pages.push(page);
    at = page.next;
    if (!page.more) return pages;
  }
  throw new Error("did not end");
}

describe("the Drive connector", () => {
  it("the connector type-checks as a Connector", () => {
    const connector: Connector = fakeDrive().connector();
    expect(typeof connector.listChanges).toBe("function");
  });

  it("with no root the connector makes no call and ends a complete listing", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    const page = await drive.connector({ roots: [] }).listChanges(account, null, 50);
    expect(drive.calls).toHaveLength(0);
    expect(page).toMatchObject({
      items: [],
      deletions: [],
      skipped: [],
      more: false,
      listing: { first: true, ended: "complete" },
      listed: [],
    });
  });

  it("the start token is read before the first list call and the listing ends in the feed at it", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    const start = String(drive.log.length);
    const [page] = await drain(drive.connector(), null);
    const paths = drive.drivePaths();
    expect(paths.indexOf("/drive/v3/changes/startPageToken")).toBeLessThan(paths.lastIndexOf("/drive/v3/files"));
    expect(page?.listing).toEqual({ first: true, ended: "complete" });
    expect(phaseOf(page as PersonalPage)).toEqual({ phase: "d_changes", token: start });
    expect(ids(page as PersonalPage)).toEqual(["drive-file:1inA_abcdefgh"]);
  });

  it("a change made during a listing is handed over again", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 3; i += 1) drive.put(`1inA_file_${i}`);
    const connector = drive.connector();
    const first = await connector.listChanges(account, null, 2);
    drive.edit("1inA_file_0", { modifiedTime: "2026-02-02T00:00:00.000Z" });
    const pages = [first, ...(await drain(connector, first.next, 2))];
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(ids(feed)).toEqual(["drive-file:1inA_file_0"]);
  });

  it("a listing sends no date bound", async () => {
    const drive = fakeDrive();
    drive.put("1old_abcdefgh", { modifiedTime: "2001-01-01T00:00:00.000Z", createdTime: "2001-01-01T00:00:00.000Z" });
    const [page] = await drain(drive.connector(), null);
    expect(ids(page as PersonalPage)).toEqual(["drive-file:1old_abcdefgh"]);
    const list = drive.calls.find(
      (one) => one.url.pathname === "/drive/v3/files" && one.url.searchParams.get("q")?.startsWith("mimeType != "),
    );
    expect(Object.fromEntries(list?.url.searchParams ?? [])).toEqual({
      q: "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      corpora: "user",
      spaces: "drive",
      pageSize: "100",
      fields: `nextPageToken,files(${FILE_FIELDS})`,
    });
  });

  it("a file outside every root is in no page, and no documents.get names it", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    drive.put("1inD_abcdefgh", { parents: ["D"] });
    drive.put("1shared_abcde", { parents: [], sharedWithMeTime: "2026-01-01T00:00:00.000Z" });
    const pages = await drain(drive.connector(), null);
    const all = pages.flatMap((page) => [...ids(page), ...(page.listed ?? []), ...(page.left ?? [])]);
    expect(all).toEqual(["drive-file:1inA_abcdefgh"]);
    expect(drive.docGets().map((one) => one.url.pathname)).toEqual(["/v1/documents/1inA_abcdefgh"]);
    expect(JSON.stringify(pages)).not.toContain("1inD");
  });

  it("no call sets supportsAllDrives or includeItemsFromAllDrives, and a change of type drive and a file in a shared drive are ignored", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    drive.put("1inSharedDrv_", { driveId: "0Ashared" });
    const connector = drive.connector();
    const pages = await drain(connector, null);
    expect(pages.flatMap(ids)).toEqual(["drive-file:1inA_abcdefgh"]);
    drive.log.push({ changeType: "drive", fileId: "0Ashared" });
    drive.edit("1inSharedDrv_", { modifiedTime: "2026-02-03T00:00:00.000Z" });
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(feed).toMatchObject({ items: [], deletions: [], skipped: [] });
    expect(feed.left).toBeUndefined();
    for (const call of drive.calls)
      for (const name of ["supportsAllDrives", "includeItemsFromAllDrives"])
        expect(call.url.searchParams.has(name)).toBe(false);
  });

  it("the folder listing asks for ids and parents only, once for a connector's life", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    drive.edit("1inA_abcdefgh", { modifiedTime: "2026-02-04T00:00:00.000Z" });
    await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    const folderLists = drive.calls.filter((one) => one.url.searchParams.get("q")?.startsWith("mimeType = "));
    expect(folderLists).toHaveLength(1);
    expect(folderLists[0]?.url.searchParams.get("fields")).toBe("nextPageToken,files(id,parents)");
    expect(drive.drivePaths().filter((path) => path === "/drive/v3/files/root")).toHaveLength(1);
  });

  it("a folder change on a feed page updates the map before the page's files are placed", async () => {
    const drive = fakeDrive();
    const connector = drive.connector({ roots: ["A", "D"] });
    const pages = await drain(connector, null);
    // A new folder N under D, and a file in it, on one feed page: the file is in scope.
    drive.folder("N", "D");
    drive.log.push({
      fileId: "N",
      file: {
        id: "N",
        mimeType: FOLDER,
        parents: ["D"],
        name: "n",
        createdTime: "2026-01-01T00:00:00.000Z",
        modifiedTime: "2026-01-01T00:00:00.000Z",
      },
    });
    drive.put("1inN_abcdefgh", { parents: ["N"] });
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(ids(feed)).toEqual(["drive-file:1inN_abcdefgh"]);
  });

  it("a removed change is a source deletion dated by the injected clock", async () => {
    const drive = fakeDrive();
    drive.put("1inA_abcdefgh");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    drive.remove("1inA_abcdefgh");
    drive.remove("1neverStored_");
    drive.clock.now = Date.parse("2026-03-11T08:00:00.000Z");
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(feed.deletions).toEqual([
      { sourceAccount: accountId, sourceItemId: "drive-file:1inA_abcdefgh", deletedAt: "2026-03-11T08:00:00.000Z" },
      { sourceAccount: accountId, sourceItemId: "drive-file:1neverStored_", deletedAt: "2026-03-11T08:00:00.000Z" },
    ]);
    // An unknown removal does not end the feed.
    expect(phaseOf(feed).phase).toBe("d_changes");
  });

  it("a file moved out of every root, and a trashed one, are named in left", async () => {
    const drive = fakeDrive();
    drive.put("1moved_abcdef");
    drive.put("1trashed_abcd");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    drive.edit("1moved_abcdef", { parents: ["D"] });
    drive.edit("1trashed_abcd", { trashed: true });
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(feed.items).toEqual([]);
    expect(feed.left).toEqual(["drive-file:1moved_abcdef", "drive-file:1trashed_abcd"]);
    expect(drive.docGets()).toHaveLength(2);
  });

  it("two changes to one file give one entry, the last", async () => {
    const drive = fakeDrive();
    drive.put("1twice_abcdef");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    drive.edit("1twice_abcdef", { modifiedTime: "2026-02-05T00:00:00.000Z" });
    drive.edit("1twice_abcdef", { parents: ["D"] });
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(feed.items).toEqual([]);
    expect(feed.left).toEqual(["drive-file:1twice_abcdef"]);
  });

  it("a change to a root folder ends the feed, and after a folder is moved out of a root the next complete listing names none of its files", async () => {
    const drive = fakeDrive();
    drive.put("1inB_abcdefgh", { parents: ["B"] });
    drive.put("1inA_abcdefgh");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    drive.moveFolder("B", "D");
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(phaseOf(feed)).toMatchObject({ phase: "d_list", refetch: false });
    expect(feed.more).toBe(true);
    const listing = await drain(connector, feed.next);
    expect(listing[0]?.listing?.first).toBe(true);
    expect(listing.at(-1)?.listing?.ended).toBe("complete");
    const named = listing.flatMap((page) => [...ids(page), ...(page.listed ?? [])]);
    expect(named).toEqual(["drive-file:1inA_abcdefgh"]);
    // A folder created outside every root does not end the feed.
    drive.folder("Z", "D");
    drive.log.push({
      fileId: "Z",
      file: {
        id: "Z",
        mimeType: FOLDER,
        parents: ["D"],
        name: "z",
        createdTime: "2026-01-01T00:00:00.000Z",
        modifiedTime: "2026-01-01T00:00:00.000Z",
      },
    });
    const quiet = await connector.listChanges(account, listing.at(-1)?.next ?? null, 50);
    expect(phaseOf(quiet).phase).toBe("d_changes");
  });

  it("the listing a feed ends in reads the folders again, so a move on a later feed page is not missed", async () => {
    const drive = fakeDrive();
    drive.put("1inB_abcdefgh", { parents: ["B"] });
    drive.put("1inA_abcdefgh");
    const connector = drive.connector();
    const pages = await drain(connector, null);
    // Page one of the feed ends it; the move of B out of A is on page two, which is never read.
    drive.moveFolder("A", MY);
    drive.moveFolder("B", "D");
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 1);
    expect(phaseOf(feed).phase).toBe("d_list");
    const listing = await drain(connector, feed.next);
    expect(listing.flatMap((page) => [...ids(page), ...(page.listed ?? [])])).toEqual(["drive-file:1inA_abcdefgh"]);
    const folderLists = drive.calls.filter((one) => one.url.searchParams.get("q")?.startsWith("mimeType = "));
    expect(folderLists).toHaveLength(2);
  });

  it("a feed token answered 400, 404 or 410 starts a new listing in the same call", async () => {
    for (const code of [400, 404, 410]) {
      const drive = fakeDrive();
      drive.put("1inA_abcdefgh");
      drive.failFeed(code);
      const page = await drive.connector().listChanges(account, driveCursor({ phase: "d_changes", token: "77" }), 50);
      expect(page.listing, String(code)).toEqual({ first: true, ended: "complete" });
      expect(ids(page), String(code)).toEqual(["drive-file:1inA_abcdefgh"]);
    }
    // The control: a 500 fails the page.
    const drive = fakeDrive();
    drive.failFeed(500);
    expect(
      (
        await failure(() =>
          drive.connector().listChanges(account, driveCursor({ phase: "d_changes", token: "77" }), 50),
        )
      ).code,
    ).toBe("unavailable");
  });

  it("a page fetches 25 documents and leaves the rest pending, and the next call reads them again before it lists", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 30; i += 1) drive.put(`1many_${String(i).padStart(4, "0")}`);
    const connector = drive.connector();
    const first = await connector.listChanges(account, null, 100);
    expect(first.items).toHaveLength(25);
    expect(first.more).toBe(true);
    const pending = phaseOf(first);
    expect(pending).toMatchObject({
      phase: "d_list",
      pending: Array.from({ length: 5 }, (_, i) => `1many_${String(25 + i).padStart(4, "0")}`),
    });
    const before = drive.calls.length;
    const second = await connector.listChanges(account, first.next, 100);
    expect(second.items).toHaveLength(5);
    expect(second.listing).toEqual({ first: false, ended: "complete" });
    const after = drive.calls.slice(before).map((one) => one.url.pathname);
    expect(after.filter((path) => path === "/drive/v3/files")).toHaveLength(0);
    expect(after.filter((path) => path.startsWith("/drive/v3/files/1many_"))).toHaveLength(5);
  });

  it("a page stops at the byte bound", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 20; i += 1) drive.put(`1big_${String(i).padStart(5, "0")}`, {}, "é".repeat(950_000));
    const page = await drive.connector().listChanges(account, null, 100);
    expect(page.items.length).toBeLessThan(20);
    expect(page.items.length).toBeGreaterThan(1);
    const bytes = page.items.reduce((sum, item) => sum + item.payload.length, 0);
    expect(bytes - (page.items.at(-1)?.payload.length ?? 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(phaseOf(page)).toMatchObject({ phase: "d_list" });
  });

  it("a pending id that files.get answers 404 is named in left, and one that comes back trashed is too", async () => {
    const drive = fakeDrive();
    drive.put("1gone_abcdefg");
    drive.put("1trash_abcdef");
    drive.files.delete("1gone_abcdefg");
    drive.edit("1trash_abcdef", { trashed: true });
    const page = await drive
      .connector()
      .listChanges(
        account,
        driveCursor({ phase: "d_list", start: "0", refetch: false, pending: ["1gone_abcdefg", "1trash_abcdef"] }),
        100,
      );
    expect(page.items).toEqual([]);
    expect(page.left).toEqual(["drive-file:1gone_abcdefg", "drive-file:1trash_abcdef"]);
  });

  it("a stored tag is not fetched: named in listed in a listing, absent from a feed page", async () => {
    const drive = fakeDrive();
    drive.put("1kept_abcdefg");
    const file: DriveFile = {
      id: "1kept_abcdefg",
      name: "Name 1kept_abcdefg",
      mimeType: DOC,
      createdTime: "2026-01-01T00:00:00.000Z",
      modifiedTime: "2026-02-01T00:00:00.000Z",
      parent: "A",
      root: "A",
      ownedByMe: true,
      modifiedByMe: true,
      canDownload: true,
    };
    const tag = driveRevisionTag(file);
    const asked: [string, string | undefined][] = [];
    const stored = async (id: string, revision?: string): Promise<boolean> => {
      asked.push([id, revision]);
      return revision === tag;
    };
    const connector = drive.connector({ stored });
    const pages = await drain(connector, null);
    expect(pages[0]?.items).toEqual([]);
    expect(pages[0]?.listed).toEqual(["drive-file:1kept_abcdefg"]);
    expect(asked).toEqual([["drive-file:1kept_abcdefg", tag]]);
    drive.edit("1kept_abcdefg", {});
    const feed = await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(feed).toMatchObject({ items: [], deletions: [], skipped: [] });
    expect(feed.listed).toBeUndefined();
    expect(drive.docGets()).toHaveLength(0);
  });

  it("an erased document is not fetched, and without stored every document in scope is fetched", async () => {
    const drive = fakeDrive();
    drive.put("1erased_abcde");
    const erased = await drain(drive.connector({ stored: async (id) => id === "drive-file:1erased_abcde" }), null);
    expect(erased.flatMap(ids)).toEqual([]);
    expect(drive.docGets()).toHaveLength(0);
    const all = await drain(drive.connector(), null);
    expect(all.flatMap(ids)).toEqual(["drive-file:1erased_abcde"]);
    expect(drive.docGets()).toHaveLength(1);
  });

  it("a listing from the reset cursor fetches a stored tag again, also when resumed", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 27; i += 1) drive.put(`1reset_${String(i).padStart(4, "0")}`);
    const asked: string[] = [];
    const connector = drive.connector({
      stored: async (id) => {
        asked.push(id);
        return true;
      },
    });
    const first = await connector.listChanges(account, connector.resetCursor(), 100);
    expect(first.items).toHaveLength(25);
    expect(phaseOf(first)).toMatchObject({ phase: "d_list", refetch: true });
    const second = await connector.listChanges(account, first.next, 100);
    expect(second.items).toHaveLength(2);
    expect(asked).toEqual([]);
  });

  it("resetCursor is the same cursor every time and makes no call", () => {
    const drive = fakeDrive();
    const connector = drive.connector();
    expect(connector.resetCursor()).toBe(connector.resetCursor());
    expect(readDriveCursor(connector.resetCursor() as ConnectorCursor)).toEqual({ phase: "d_reset" });
    expect(drive.calls).toHaveLength(0);
  });

  it("no documents.get starts sooner than 250 ms after the last, on the injected clock, and a list call is not paced", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 4; i += 1) drive.put(`1pace_${String(i).padStart(5, "0")}`);
    drive.put("1sheet_abcdef", { mimeType: "application/vnd.google-apps.spreadsheet" });
    await drain(drive.connector(), null);
    const gets = drive.docGets().map((one) => one.at);
    expect(gets).toHaveLength(4);
    for (let i = 1; i < gets.length; i += 1)
      expect((gets[i] as number) - (gets[i - 1] as number)).toBeGreaterThanOrEqual(250);
    const drives = drive.calls.filter((one) => one.url.hostname === "www.googleapis.com").map((one) => one.at);
    expect(new Set(drives)).toEqual(new Set([T0]));
  });

  it("a sheet, a deck, a PDF and a shortcut are items with no content call, and so is a document whose owner switched downloading off", async () => {
    const drive = fakeDrive();
    const types = [
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
      "application/pdf",
      "application/vnd.google-apps.shortcut",
    ];
    types.forEach((mimeType, i) => {
      drive.put(`1other_${i}_abcde`, { mimeType, size: "1234" });
    });
    drive.put("1nodownload_a", { capabilities: { canDownload: false } });
    const [page] = await drain(drive.connector(), null);
    expect(drive.docGets()).toHaveLength(0);
    expect(page?.items.map((item) => item.depth)).toEqual(["headers", "headers", "headers", "headers", "headers"]);
    const facts = (page?.items ?? []).map((item) => {
      const block = Buffer.from(item.payload, "base64").toString("utf8");
      const content = /content="([^"]+)"/.exec(block)?.[1] ?? "";
      return (JSON.parse(Buffer.from(content, "base64url").toString("utf8")) as { unreadable: string }).unreadable;
    });
    expect(facts).toEqual(["not_a_document", "not_a_document", "not_a_document", "not_a_document", "no_download"]);
  });

  it("an item names the account's own address alone, and its root", async () => {
    const drive = fakeDrive();
    drive.put("1shared_abcde", {
      ownedByMe: false,
      owners: [{ emailAddress: "other@example.com" }],
      sharingUser: { emailAddress: "other@example.com" },
    });
    const [page] = await drain(drive.connector(), null);
    const [item] = page?.items ?? [];
    expect(RawItem.safeParse(item).success).toBe(true);
    expect(item?.permissions).toEqual({ scope: "listed", identifiers: [OWNER] });
    expect(item?.markers).toEqual(["drive", "root:A"]);
    expect(drive.drivePaths().filter((path) => path === "/drive/v3/about")).toHaveLength(1);
  });

  it("a file whose fields are wrongly typed is skipped as unsupported, and one that names no id fails the page", async () => {
    const drive = fakeDrive();
    drive.put("1wrong_abcdef", { modifiedTime: 7 });
    drive.put("1inA_abcdefgh");
    const [page] = await drain(drive.connector(), null);
    expect(page?.skipped).toEqual([{ sourceItemId: "drive-file:1wrong_abcdef", reason: "unsupported" }]);
    expect(ids(page as PersonalPage)).toEqual(["drive-file:1inA_abcdefgh"]);
    const broken = fakeDrive();
    broken.files.set("x", { id: "", mimeType: DOC } as Meta);
    expect((await failure(() => broken.connector().listChanges(account, null, 50))).code).toBe("bad_response");
  });

  it("a cursor of another connector fails bad_cursor, and a mail cursor still decodes", async () => {
    const drive = fakeDrive();
    const connector = drive.connector();
    for (const cursor of [mailCursor({ phase: "reset" }), calendarCursor({ phase: "sync", syncToken: "s" })]) {
      expect((await failure(() => connector.listChanges(account, cursor, 10))).code).toBe("bad_cursor");
    }
    const bad = Buffer.from(JSON.stringify({ v: 4, connector: "google_docs", phase: "d_list", start: "1" })).toString(
      "base64url",
    ) as ConnectorCursor;
    expect((await failure(() => connector.listChanges(account, bad, 10))).code).toBe("bad_cursor");
    expect(drive.calls).toHaveLength(0);
    const mail = createGoogleConnector(
      "google_mail",
      { ...credential, connector: "google_mail", scopes: [...scopesFor("mail")] },
      createGoogleHttp({ tokens: null }),
      {},
    );
    expect(typeof mail.resetCursor()).toBe("string");
  });

  it("every request is a GET and a read with the timeout from deps, and no request starts before the last has settled", async () => {
    const drive = fakeDrive();
    for (let i = 0; i < 3; i += 1) drive.put(`1req_${String(i).padStart(6, "0")}`);
    const real = createGoogleHttp({ tokens: null, deps: drive.deps, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES });
    const seen: string[] = [];
    const recording: HttpPort = {
      send: (req) => {
        seen.push(`${req.method} ${req.kind} ${req.timeoutMs}`);
        return real.send(req);
      },
    };
    const connector = createGoogleConnector("google_docs", credential, recording, { roots: ["A"] }, drive.deps);
    const pages = await drain(connector, null);
    drive.edit("1req_000000", { modifiedTime: "2026-02-09T00:00:00.000Z" });
    await connector.listChanges(account, pages.at(-1)?.next ?? null, 50);
    expect(seen.length).toBeGreaterThan(5);
    expect(new Set(seen)).toEqual(new Set(["GET read 1234"]));
    expect(drive.overlapped).toBe(false);
  });

  it("the removals pass reads the feed alone: deletions and trashed files, no content call, no listing and no feed end", async () => {
    const drive = fakeDrive();
    drive.put("1gone_abcdefg");
    drive.put("1trash_abcdef");
    drive.put("1edited_abcde");
    const pages = await drain(drive.connector(), null);
    const feedAt = pages.at(-1)?.next ?? null;
    drive.remove("1gone_abcdefg");
    drive.edit("1trash_abcdef", { trashed: true });
    drive.edit("1edited_abcde", { modifiedTime: "2026-02-06T00:00:00.000Z" });
    drive.moveFolder("B", "D");
    const before = drive.calls.length;
    const removals = drive.connector({ removalsOnly: true });
    const page = await removals.listChanges(account, feedAt, 50);
    expect(page.deletions.map((one) => one.sourceItemId)).toEqual(["drive-file:1gone_abcdefg"]);
    expect(page.left).toEqual(["drive-file:1trash_abcdef"]);
    expect([page.items, page.listing]).toEqual([[], undefined]);
    const made = drive.calls.slice(before).map((one) => one.url.pathname);
    expect(made).toEqual(["/drive/v3/changes"]);
    expect(phaseOf(page).phase).toBe("d_changes");
    // In a listing, from the reset cursor or with no cursor, it makes no call and hands back the
    // cursor it was given.
    for (let i = 0; i < 3; i += 1) drive.put(`1more_file_${i}`);
    const listingAt = (await drive.connector().listChanges(account, null, 1)).next;
    expect(phaseOf({ next: listingAt } as PersonalPage).phase).toBe("d_list");
    expect((await removals.listChanges(account, removals.resetCursor(), 50)).next).toBe(removals.resetCursor());
    const calls = drive.calls.length;
    const idle = await removals.listChanges(account, listingAt, 50);
    expect([drive.calls.length, idle.more, idle.next]).toEqual([calls, false, listingAt]);
    expect((await removals.listChanges(account, null, 50)).items).toEqual([]);
    expect(drive.calls.length).toBe(calls);
    // The positive control: the full pass fetches the edited document.
    expect(ids(await drive.connector().listChanges(account, feedAt, 50))).toContain("drive-file:1edited_abcde");
  });
});
