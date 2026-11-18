import { describe, expect, it } from "vitest";
import { FolderMap, loadFolders, MAX_FOLDERS } from "./drive-scope.ts";
import { createGoogleHttp, type GoogleDeps } from "./http.ts";

// Folder ids are made for the test.

const MY = "myDriveRootId";
// my drive: A (root) > B > C ; D (outside) ; S shared folder whose parent is unknown.
const map = () =>
  new FolderMap(MY, [
    ["A", MY],
    ["B", "A"],
    ["C", "B"],
    ["D", MY],
    ["S", "someoneElsesFolder"],
  ]);
const roots = (...ids: string[]): Set<string> => new Set(ids);

describe("Drive: the scope", () => {
  it("a file under a root folder, or under a folder under it, is in scope, and the nearest root wins", () => {
    const folders = map();
    expect(folders.rootOf({ parent: "A", sharedWithMe: false }, roots("A"))).toBe("A");
    expect(folders.rootOf({ parent: "C", sharedWithMe: false }, roots("A"))).toBe("A");
    expect(folders.rootOf({ parent: "C", sharedWithMe: false }, roots("A", "B"))).toBe("B");
    expect(folders.rootOf({ parent: "C", sharedWithMe: false }, roots("A", "my-drive"))).toBe("A");
    expect(folders.rootOf({ parent: "D", sharedWithMe: false }, roots("A"))).toBeNull();
  });

  it("a file in My Drive is in scope only with the my-drive root", () => {
    const folders = map();
    for (const parent of [MY, "D", "C"]) {
      expect(folders.rootOf({ parent, sharedWithMe: false }, roots("my-drive")), parent).toBe("my-drive");
      expect(folders.rootOf({ parent, sharedWithMe: false }, roots("shared-with-me")), parent).toBeNull();
    }
  });

  it("a shared file with no way up to a root is in scope only with shared-with-me", () => {
    const folders = map();
    for (const parent of [undefined, "someoneElsesFolder"]) {
      expect(folders.rootOf({ parent, sharedWithMe: true }, roots("shared-with-me")), String(parent)).toBe(
        "shared-with-me",
      );
      expect(folders.rootOf({ parent, sharedWithMe: true }, roots("my-drive", "A")), String(parent)).toBeNull();
      expect(folders.rootOf({ parent, sharedWithMe: false }, roots("shared-with-me")), String(parent)).toBeNull();
    }
  });

  it("a file inside a shared folder that carries no sharedWithMeTime is out of scope under shared-with-me, and in scope when that folder is a root", () => {
    const folders = map();
    expect(folders.rootOf({ parent: "S", sharedWithMe: false }, roots("shared-with-me"))).toBeNull();
    expect(folders.rootOf({ parent: "S", sharedWithMe: false }, roots("shared-with-me", "S"))).toBe("S");
  });

  it("a way up of 101 folders, and one that loops, has no root", () => {
    const chain = (n: number): FolderMap =>
      new FolderMap(
        MY,
        Array.from({ length: n }, (_, i) => [`f${i}`, i === n - 1 ? MY : `f${i + 1}`] as [string, string]),
      );
    // A file in f0 passes f0 to f(n-1), then reaches My Drive.
    expect(chain(99).rootOf({ parent: "f0", sharedWithMe: false }, roots("my-drive"))).toBe("my-drive");
    expect(chain(101).rootOf({ parent: "f0", sharedWithMe: false }, roots("my-drive"))).toBeNull();
    expect(chain(101).rootOf({ parent: "f0", sharedWithMe: true }, roots("my-drive", "shared-with-me"))).toBeNull();
    const loop = new FolderMap(MY, [
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(loop.rootOf({ parent: "x", sharedWithMe: true }, roots("shared-with-me", "my-drive"))).toBeNull();
  });

  it("a change to a root folder ends the feed", () => {
    expect(map().endsFeed({ id: "A", gone: false, parent: MY }, roots("A"))).toBe(true);
  });

  it("a folder moved into a root's subtree ends the feed, and one moved out of it does", () => {
    const folders = map();
    expect(folders.endsFeed({ id: "D", gone: false, parent: "B" }, roots("A"))).toBe(true);
    expect(folders.endsFeed({ id: "C", gone: false, parent: "D" }, roots("A"))).toBe(true);
    // A trashed folder inside a root, as it leaves the map.
    expect(folders.endsFeed({ id: "C", gone: true }, roots("A"))).toBe(true);
  });

  it("a folder created or renamed outside every root does not end the feed", () => {
    const folders = map();
    expect(folders.endsFeed({ id: "new", gone: false, parent: "D" }, roots("A"))).toBe(false);
    expect(folders.endsFeed({ id: "D", gone: false, parent: MY }, roots("A"))).toBe(false);
    // Under my-drive every folder of My Drive is under a root.
    expect(folders.endsFeed({ id: "new", gone: false, parent: "D" }, roots("my-drive"))).toBe(true);
  });

  it("a removal of a folder id in the map ends the feed", () => {
    const folders = map();
    expect(folders.endsFeed({ id: "D", gone: true }, roots("A"))).toBe(true);
    // An id the map does not hold, and that is no root, does not.
    expect(folders.endsFeed({ id: "notAFolder", gone: true }, roots("A"))).toBe(false);
  });

  it("the map is updated in place by a folder change", () => {
    const folders = map();
    folders.update({ id: "D", gone: false, parent: "B" });
    expect(folders.rootOf({ parent: "D", sharedWithMe: false }, roots("A"))).toBe("A");
    folders.update({ id: "B", gone: true });
    expect(folders.has("B")).toBe(false);
    expect(folders.rootOf({ parent: "C", sharedWithMe: false }, roots("A"))).toBeNull();
  });
});

describe("Drive: the folder listing", () => {
  function fake(folders: number, pageSize = 1000) {
    const calls: URL[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname.endsWith("/files/root")) return new Response(JSON.stringify({ id: MY }));
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      const ids = Array.from({ length: Math.max(0, Math.min(pageSize, folders - page * pageSize)) }, (_, i) => ({
        id: `f${page * pageSize + i}`,
        parents: [MY],
      }));
      const more = (page + 1) * pageSize < folders;
      return new Response(JSON.stringify({ files: ids, ...(more ? { nextPageToken: String(page + 1) } : {}) }));
    };
    const deps: GoogleDeps = { fetch, sleep: async () => {}, now: () => 0, random: () => 0.5, timeoutMs: 1000 };
    return { calls, deps, http: createGoogleHttp({ tokens: null, deps }) };
  }

  it("the folder listing asks for ids and parents only, with My Drive's own id from files.get of root", async () => {
    const { calls, deps, http } = fake(1500);
    const folders = await loadFolders(http, deps);
    expect(folders.size).toBe(1500);
    expect(calls.map((url) => url.pathname)).toEqual(["/drive/v3/files/root", "/drive/v3/files", "/drive/v3/files"]);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({ fields: "id" });
    expect(Object.fromEntries(calls[1]?.searchParams ?? [])).toEqual({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      corpora: "user",
      spaces: "drive",
      pageSize: "1000",
      fields: "nextPageToken,files(id,parents)",
    });
    for (const url of calls)
      for (const name of ["supportsAllDrives", "includeItemsFromAllDrives"])
        expect(url.searchParams.has(name)).toBe(false);
  });

  it("50 001 folders fail the page too_many_folders", async () => {
    const over = fake(MAX_FOLDERS + 1);
    await expect(loadFolders(over.http, over.deps)).rejects.toMatchObject({ code: "too_many_folders" });
    const at = fake(MAX_FOLDERS);
    expect((await loadFolders(at.http, at.deps)).size).toBe(MAX_FOLDERS);
  });
});
