import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCoded } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import { refusal } from "../env.ts";

// The client's files as `pi web` serves them: read once at start, from the manifest the client's
// build writes (pi-web-client's vite.config.ts), and held in memory, so no request names a file on
// disk. Without a manifest the page serves a placeholder shell.
//
// The manifest, manifest.json in the build folder:
//   { "index": "index.html", "assets": { "/assets/index-1a2b.js": { "file": "assets/index-1a2b.js", "type": "text/javascript; charset=utf-8", "br": "assets/index-1a2b.js.br", "gzip": "assets/index-1a2b.js.gz" }, ... } }
// The index is served for every page path; each asset at its URL path. A file is a relative path
// of letters, digits, `.`, `_` and `-`, no part beginning with a dot; a type is one below. `br`
// and `gzip`, where given, name the same file compressed at build time, `<file>.br` and
// `<file>.gz`, which the server sends to a browser that accepts them.

// In the image, /opt/intelligence/apps/web/dist. `PI_WEB_CLIENT_DIR` names
// another.
const CLIENT_FOLDER = join(repoRoot(), "apps/web/dist/");
export const MANIFEST = "manifest.json";

export type ClientFile = { type: string; body: Buffer; br?: Buffer; gzip?: Buffer };
export type Client = { shell: ClientFile; assets: ReadonlyMap<string, ClientFile> };

const HTML = "text/html; charset=utf-8";
const TYPES = new Set([
  HTML,
  "text/javascript; charset=utf-8",
  "text/css; charset=utf-8",
  "font/woff2",
  "image/svg+xml",
  "image/png",
  "image/x-icon",
  "application/manifest+json",
]);
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const urlPathOk = (path: string): boolean =>
  path.startsWith("/") && FILE.test(path.slice(1)) && !path.startsWith("/api/") && path !== "/login";

export const PLACEHOLDER = Buffer.from(
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Intelligence</title></head><body>\n<p>The page's client is not built in this image.</p>\n</body></html>\n`,
);

// The shell a refused link login answers with (web-router.ts, `startSession`): the same page, marked so
// it says, beside the passkey's sign-in, that the link no longer works, never which of wrong, used
// or old it was.
export const LINK_REFUSED = '<meta name="pi-link" content="refused">';
export const linkRefusedShell = (shell: Buffer): Buffer =>
  Buffer.from(shell.toString("utf8").replace(/<head>/i, `<head>${LINK_REFUSED}`));

const bad = () => refusal("bad_client_manifest");

// The client in `folder`, or the placeholder when it holds no manifest and none is `required` (a
// folder named by PI_WEB_CLIENT_DIR is). A manifest that is not as
// above refuses the start.
export async function loadClient(
  folder: string = CLIENT_FOLDER,
  { required = false }: { required?: boolean } = {},
): Promise<Client> {
  const text = await readFile(join(folder, MANIFEST), "utf8").catch((error: unknown) => {
    if (isCoded(error, "ENOENT")) return null;
    throw error;
  });
  if (text === null && required) throw refusal("no_client_manifest");
  if (text === null) return { shell: { type: HTML, body: PLACEHOLDER }, assets: new Map() };
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw bad();
  }
  const { index, assets } = (manifest ?? {}) as { index?: unknown; assets?: unknown };
  if (
    typeof index !== "string" ||
    !FILE.test(index) ||
    !index.endsWith(".html") ||
    typeof assets !== "object" ||
    assets === null ||
    Array.isArray(assets)
  )
    throw bad();
  const files = new Map<string, ClientFile>();
  for (const [path, entry] of Object.entries(assets)) {
    const { file, type, br, gzip } = (entry ?? {}) as { file?: unknown; type?: unknown; br?: unknown; gzip?: unknown };
    if (
      !urlPathOk(path) ||
      typeof file !== "string" ||
      !FILE.test(file) ||
      typeof type !== "string" ||
      !TYPES.has(type)
    )
      throw bad();
    if ((br !== undefined && br !== `${file}.br`) || (gzip !== undefined && gzip !== `${file}.gz`)) throw bad();
    files.set(path, {
      type,
      body: await readFile(join(folder, file)),
      ...(br === undefined ? {} : { br: await readFile(join(folder, `${file}.br`)) }),
      ...(gzip === undefined ? {} : { gzip: await readFile(join(folder, `${file}.gz`)) }),
    });
  }
  return { shell: files.get(`/${index}`) ?? { type: HTML, body: await readFile(join(folder, index)) }, assets: files };
}
