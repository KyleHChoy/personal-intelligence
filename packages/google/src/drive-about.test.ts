import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { driveAbout, driveFolder } from "./drive-about.ts";
import { createGoogleHttp, type GoogleDeps } from "./http.ts";
import * as root from "./index.ts";

// The two Drive calls outside a page, on a fake fetch. Every value is made up.

function fake(answer: (url: URL) => { status: number; body: unknown }) {
  const calls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status });
  };
  const deps: GoogleDeps = { fetch, sleep: async () => {}, now: () => 0, random: () => 0.5, timeoutMs: 1000 };
  return { calls, deps, http: createGoogleHttp({ tokens: null, deps }) };
}

describe("Drive: about and folders", () => {
  it("about answers the address", async () => {
    const { calls, deps, http } = fake(() => ({ status: 200, body: { user: { emailAddress: "owner@example.org" } } }));
    expect(await driveAbout(http, deps)).toEqual({ address: "owner@example.org" });
    expect(calls.map((url) => `${url.pathname}?${url.searchParams}`)).toEqual([
      "/drive/v3/about?fields=user%28emailAddress%29",
    ]);
    const empty = fake(() => ({ status: 200, body: { user: {} } }));
    await expect(driveAbout(empty.http, empty.deps)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("a folder id answers its id, and a file, a trashed folder and a folder in a shared drive answer null", async () => {
    const folder = "application/vnd.google-apps.folder";
    const files: Record<string, unknown> = {
      fold1: { id: "fold1", mimeType: folder },
      root: { id: "myDriveRootId0", mimeType: folder },
      file1: { id: "file1", mimeType: "application/vnd.google-apps.document" },
      trash1: { id: "trash1", mimeType: folder, trashed: true },
      shared1: { id: "shared1", mimeType: folder, driveId: "0Ashared" },
    };
    const { calls, deps, http } = fake((url) => {
      const id = url.pathname.split("/").pop() ?? "";
      return id in files ? { status: 200, body: files[id] } : { status: 404, body: {} };
    });
    expect(await driveFolder(http, "fold1", deps)).toEqual({ id: "fold1" });
    expect(await driveFolder(http, "root", deps)).toEqual({ id: "myDriveRootId0" });
    for (const id of ["file1", "trash1", "shared1", "missing"])
      expect(await driveFolder(http, id, deps), id).toBeNull();
    expect(calls[0]?.searchParams.get("fields")).toBe("id,mimeType,trashed,driveId");
  });

  it("every Drive name the package offers is exported from the package root", () => {
    for (const name of ["scopesFor", "grantedScopesFor", "driveAbout", "driveFolder"] as const) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the test checks each export by its name, and a test bundle is never tree-shaken
      expect(typeof root[name], name).toBe("function");
    }
    expect(root.MAX_DOCUMENT_ANSWER_BYTES).toBe(8 * 1024 * 1024);
  });

  it("no source file asks for an export, a download, comments, revisions or permissions", () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir).filter((one) => one.endsWith(".ts") && !one.includes(".test."))) {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      for (const word of [
        "/export",
        "alt=media",
        "/comments",
        "/revisions",
        "/permissions",
        "exportLinks",
        "thumbnailLink",
      ])
        expect(text.includes(word), `${file} ${word}`).toBe(false);
    }
  });
});
