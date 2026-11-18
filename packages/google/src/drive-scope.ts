import type { HttpPort } from "@intelligence/contracts";
import { apiGet, bad, type GoogleDeps, GoogleError, isRecord, text } from "./http.ts";

// The map holds ids and parents only: no folder's name is asked for. It is a cache of one sync run,
// rebuilt from Google in the next.

const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const FOLDER_TYPE = "application/vnd.google-apps.folder";
const MY_DRIVE = "my-drive";
const SHARED_WITH_ME = "shared-with-me";

// The most folders a map holds.
export const MAX_FOLDERS = 50_000;
const MAX_WAY_UP = 100;
const FOLDER_PAGE = 1000;
const FOLDER_QUERY = `mimeType = '${FOLDER_TYPE}' and trashed = false`;

export function driveUrl(path: string, params: [string, string][]): string {
  const built = new URL(`${DRIVE_API}/${path}`);
  for (const [name, value] of params) built.searchParams.append(name, value);
  return built.toString();
}

// The first parent of a file or folder as Google names it, or undefined. A file in My Drive has
// one parent; Drive no longer lets a file have several, and only the first is read.
export function firstParent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(text)) throw bad();
  return value[0];
}

export type Placed = { parent?: string | undefined; sharedWithMe: boolean };

export type FolderChange = { id: string; gone: boolean; parent?: string | undefined };

export class FolderMap {
  readonly #parents: Map<string, string | undefined>;
  readonly #myDrive: string;

  constructor(myDrive: string, folders: Iterable<[string, string | undefined]>) {
    this.#myDrive = myDrive;
    this.#parents = new Map(folders);
  }

  get size(): number {
    return this.#parents.size;
  }

  has(id: string): boolean {
    return this.#parents.has(id);
  }

  // `shared-with-me` takes only a file that itself carries sharedWithMeTime.
  rootOf(file: Placed, roots: ReadonlySet<string>): string | null {
    const above = this.#wayUp(file.parent, roots);
    if (above === "none") return null;
    if (above !== null) return above;
    return file.sharedWithMe && roots.has(SHARED_WITH_ME) ? SHARED_WITH_ME : null;
  }

  // The first root on the way up from `start`: a folder root's id, or `my-drive` when the way
  // reaches My Drive's own folder and that is a root; null when the way leaves the map first;
  // "none" for a way that passes 100 folders or comes back to one it passed, which has no root.
  #wayUp(start: string | undefined, roots: ReadonlySet<string>): string | null | "none" {
    const passed = new Set<string>();
    for (let at = start; at !== undefined; at = this.#parents.get(at)) {
      if (passed.has(at) || passed.size === MAX_WAY_UP) return "none";
      passed.add(at);
      if (roots.has(at)) return at;
      if (at === this.#myDrive) return roots.has(MY_DRIVE) ? MY_DRIVE : null;
      if (!this.#parents.has(at)) return null;
    }
    return null;
  }

  endsFeed(change: FolderChange, roots: ReadonlySet<string>): boolean {
    if (change.gone && this.#parents.has(change.id)) return true;
    if (roots.has(change.id)) return true;
    const reaches = (start: string | undefined): boolean => {
      const found = start === undefined ? null : this.#wayUp(start, roots);
      return found !== null && found !== "none";
    };
    return reaches(this.#parents.get(change.id)) || reaches(change.parent);
  }

  update(change: FolderChange): void {
    if (change.gone) this.#parents.delete(change.id);
    else this.#parents.set(change.id, change.parent);
    if (this.#parents.size > MAX_FOLDERS) throw new GoogleError("too_many_folders");
  }
}

export async function loadFolders(http: HttpPort, deps: GoogleDeps = {}): Promise<FolderMap> {
  const root = (await apiGet(http, driveUrl("files/root", [["fields", "id"]]), deps)).body;
  if (!isRecord(root) || !text(root.id)) throw bad();
  const folders: [string, string | undefined][] = [];
  let pageToken: string | undefined;
  do {
    const params: [string, string][] = [
      ["q", FOLDER_QUERY],
      ["corpora", "user"],
      ["spaces", "drive"],
      ["pageSize", String(FOLDER_PAGE)],
      ["fields", "nextPageToken,files(id,parents)"],
      ...(pageToken === undefined ? [] : [["pageToken", pageToken] satisfies [string, string]]),
    ];
    const body = (await apiGet(http, driveUrl("files", params), deps)).body;
    if (!isRecord(body) || (body.files !== undefined && !Array.isArray(body.files))) throw bad();
    for (const one of (body.files as unknown[] | undefined) ?? []) {
      if (!isRecord(one) || !text(one.id)) throw bad();
      folders.push([one.id, firstParent(one.parents)]);
      if (folders.length > MAX_FOLDERS) throw new GoogleError("too_many_folders");
    }
    const next = body.nextPageToken;
    if (next !== undefined && !text(next)) throw bad();
    pageToken = next;
  } while (pageToken !== undefined);
  return new FolderMap(root.id, folders);
}
