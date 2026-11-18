import {
  type HttpPort,
  type RawItem,
  type SkippedItem,
  type SourceAccount,
  type SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import type { DocumentUnreadable } from "@intelligence/contracts/personal";
import {
  type ConnectorOptions,
  type DocBody,
  type DriveFile,
  type DrivePerson,
  driveItem,
  driveRevisionTag,
  type PersonalPage,
} from "@intelligence/personal-core/items";
import { type DrivePhase, driveCursor } from "./cursor.ts";
import { readDocument } from "./docs.ts";
import { driveAbout } from "./drive-about.ts";
import { driveUrl, FOLDER_TYPE, type FolderChange, type FolderMap, firstParent, loadFolders } from "./drive-scope.ts";
import {
  apiGet,
  bad,
  failed,
  type GoogleDeps,
  isRecord,
  MAX_PAGE_BYTES,
  optionalToken,
  text,
  withDefaults,
} from "./http.ts";

// The Drive phases. A listing of every file of the account, of which only those under a
// root are handed over, then Drive's changes feed from the token taken before the listing.
// Every request is a GET and a read. Only a Google Doc in scope is read for its content; nothing
// is asked of a file outside every root, and nothing a document says is followed.

const MAX_DOCUMENTS = 25;
// What one list or feed call asks for at most.
const MAX_LISTED = 200;
const PACE_MS = 250;
const GOOGLE_DOC = "application/vnd.google-apps.document";

// The fixed file mask.
export const FILE_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,parents,trashed,driveId,ownedByMe,sharedWithMeTime,owners(emailAddress,displayName),sharingUser(emailAddress,displayName),lastModifyingUser(me),capabilities(canDownload)";
const FILE_QUERY = `mimeType != '${FOLDER_TYPE}' and trashed = false`;

const itemId = (fileId: string): string => `drive-file:${fileId}`;

// One file of an answer as read, before its root is known. `unsupported` for a file whose fields
// are wrongly typed: it is skipped by its id.
type Listed = {
  file: Omit<DriveFile, "root">;
  trashed: boolean;
  sharedDrive: boolean;
  sharedWithMe: boolean;
  folder: boolean;
};

class Wrong extends Error {}

function person(value: unknown): DrivePerson | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Wrong();
  const [address, name] = [value.emailAddress, value.displayName];
  if ((address !== undefined && typeof address !== "string") || (name !== undefined && typeof name !== "string"))
    throw new Wrong();
  const found = { ...(address === undefined ? {} : { address }), ...(name === undefined ? {} : { name }) };
  return Object.keys(found).length === 0 ? undefined : found;
}

const bool = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Wrong();
  return value;
};

const time = (value: unknown): Timestamp => {
  const parsed = Timestamp.safeParse(value);
  if (!parsed.success) throw new Wrong();
  return parsed.data;
};

// The file mask, field by field. A file that names no id fails the page.
function readFile(value: unknown): Listed | { unsupported: string } {
  if (!isRecord(value) || !text(value.id)) throw bad();
  const id = value.id;
  try {
    const { name, mimeType, size, driveId, owners, sharingUser, lastModifyingUser, capabilities } = value;
    if (typeof name !== "string" || !text(mimeType)) throw new Wrong();
    if (size !== undefined && (typeof size !== "string" || !/^\d{1,15}$/.test(size))) throw new Wrong();
    if (driveId !== undefined && typeof driveId !== "string") throw new Wrong();
    if (owners !== undefined && !Array.isArray(owners)) throw new Wrong();
    if (lastModifyingUser !== undefined && !isRecord(lastModifyingUser)) throw new Wrong();
    if (capabilities !== undefined && !isRecord(capabilities)) throw new Wrong();
    if (value.sharedWithMeTime !== undefined && typeof value.sharedWithMeTime !== "string") throw new Wrong();
    const owner = person((owners as unknown[] | undefined)?.[0]);
    const sharer = person(sharingUser);
    const parent = firstParent(value.parents);
    const file: Omit<DriveFile, "root"> = {
      id,
      name,
      mimeType,
      ...(size === undefined ? {} : { size: Number(size) }),
      createdTime: time(value.createdTime),
      modifiedTime: time(value.modifiedTime),
      ...(parent === undefined ? {} : { parent }),
      ownedByMe: bool(value.ownedByMe),
      modifiedByMe: bool((lastModifyingUser as Record<string, unknown> | undefined)?.me),
      ...(owner === undefined ? {} : { owner }),
      ...(sharer === undefined ? {} : { sharer }),
      canDownload: bool((capabilities as Record<string, unknown> | undefined)?.canDownload),
    };
    return {
      file,
      trashed: bool(value.trashed),
      sharedDrive: driveId !== undefined,
      sharedWithMe: value.sharedWithMeTime !== undefined,
      folder: mimeType === FOLDER_TYPE,
    };
  } catch (error) {
    if (error instanceof Wrong || failed(error, "bad_response")) return { unsupported: id };
    throw error;
  }
}

// What a page gathers.
type Gathered = {
  items: RawItem[];
  deletions: SourceDeletion[];
  skipped: SkippedItem[];
  listed: string[];
  left: string[];
  fetches: number;
  bytes: number;
};
const gathered = (): Gathered => ({
  items: [],
  deletions: [],
  skipped: [],
  listed: [],
  left: [],
  fetches: 0,
  bytes: 0,
});

const full = (into: Gathered): boolean => into.fetches >= MAX_DOCUMENTS || into.bytes > MAX_PAGE_BYTES;

function placed(one: Listed, map: FolderMap, roots: ReadonlySet<string>): DriveFile | null {
  if (one.trashed || one.sharedDrive || one.folder) return null;
  const root = map.rootOf({ parent: one.file.parent, sharedWithMe: one.sharedWithMe }, roots);
  return root === null ? null : { ...one.file, root };
}

const pageOf = (into: Gathered, next: DrivePhase, more: boolean, listing?: PersonalPage["listing"]): PersonalPage => ({
  items: into.items,
  deletions: into.deletions,
  skipped: into.skipped,
  more,
  ...(listing === undefined ? {} : { listing }),
  ...(into.listed.length > 0 || listing !== undefined ? { listed: into.listed } : {}),
  ...(into.left.length > 0 ? { left: into.left } : {}),
  next: driveCursor(next),
});

// Null when the token is no longer good.
async function readChanges(
  http: HttpPort,
  deps: GoogleDeps,
  token: string,
  limit: number,
): Promise<{
  pageToken: string | undefined;
  newStart: string | undefined;
  last: Map<string, Record<string, unknown>>;
} | null> {
  const params: [string, string][] = [
    ["pageToken", token],
    ["includeRemoved", "true"],
    ["restrictToMyDrive", "false"],
    ["spaces", "drive"],
    ["pageSize", String(Math.min(limit, MAX_LISTED))],
    ["fields", `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FILE_FIELDS}))`],
  ];
  let body: unknown;
  try {
    ({ body } = await apiGet(http, driveUrl("changes", params), deps));
  } catch (error) {
    if (failed(error, "bad_response", 400) || failed(error, "not_found")) return null;
    throw error;
  }
  if (!isRecord(body) || (body.changes !== undefined && !Array.isArray(body.changes))) throw bad();
  const [pageToken, newStart] = [optionalToken(body.nextPageToken), optionalToken(body.newStartPageToken)];
  if (pageToken === undefined && newStart === undefined) throw bad();
  const last = new Map<string, Record<string, unknown>>();
  for (const one of (body.changes as unknown[] | undefined) ?? []) {
    if (!isRecord(one)) throw bad();
    if (one.changeType === "drive") continue;
    if (!text(one.fileId)) throw bad();
    last.delete(one.fileId);
    last.set(one.fileId, one);
  }
  return { pageToken, newStart, last };
}

// One sync run's connector: its handles and roots, and what it keeps for its life: the folder map,
// the account's own address, and when the last document fetch started.
type DriveRun = {
  readonly http: HttpPort;
  readonly deps: GoogleDeps;
  readonly roots: ReadonlySet<string>;
  readonly stored: ConnectorOptions["stored"];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  folders?: FolderMap | undefined;
  ownerAddress?: string;
  lastFetch?: number;
};

const mapOf = async (run: DriveRun): Promise<FolderMap> => (run.folders ??= await loadFolders(run.http, run.deps));
const addressOf = async (run: DriveRun): Promise<string> =>
  (run.ownerAddress ??= (await driveAbout(run.http, run.deps)).address);
const clock = (run: DriveRun): Timestamp => new Date(run.now()).toISOString();

async function paced(run: DriveRun): Promise<void> {
  const wait = run.lastFetch === undefined ? 0 : run.lastFetch + PACE_MS - run.now();
  if (wait > 0) await run.sleep(wait);
  run.lastFetch = run.now();
}

// Its tag is asked about before anything is fetched; a stored tag, or an erased item, is not
// fetched. Only a Google Doc whose owner allows download is read; any other file is an item made
// from its metadata.
async function take(
  run: DriveRun,
  account: SourceAccount,
  file: DriveFile,
  inListing: boolean,
  refetch: boolean,
  into: Gathered,
): Promise<void> {
  const id = itemId(file.id);
  if (!refetch && run.stored !== undefined && (await run.stored(id, driveRevisionTag(file)))) {
    if (inListing) into.listed.push(id);
    return;
  }
  let body: DocBody | null = null;
  let unreadable: DocumentUnreadable | null = null;
  if (file.mimeType !== GOOGLE_DOC) unreadable = "not_a_document";
  else if (!file.canDownload) unreadable = "no_download";
  else {
    into.fetches += 1;
    await paced(run);
    const read = await readDocument(run.http, file.id, run.deps);
    if (read === "gone") {
      into.left.push(id);
      return;
    }
    if (read === "unsupported") {
      into.skipped.push({ sourceItemId: id, reason: "unsupported" });
      return;
    }
    ({ body, unreadable } = read);
  }
  const item = driveItem(file, body, unreadable, {
    sourceAccount: account.id,
    changeKind: inListing ? "backfill" : "live",
    ownerAddress: await addressOf(run),
  });
  into.items.push(item);
  into.bytes += item.payload.length;
}

async function takeSome(
  run: DriveRun,
  account: SourceAccount,
  files: DriveFile[],
  inListing: boolean,
  refetch: boolean,
  into: Gathered,
): Promise<string[]> {
  for (const [at, file] of files.entries()) {
    if (full(into)) return files.slice(at).map((one) => one.id);
    await take(run, account, file, inListing, refetch, into);
  }
  return [];
}

// One answered 404, or that comes back trashed, in a shared drive or out of scope, is named in
// `left`.
async function takePending(
  run: DriveRun,
  account: SourceAccount,
  pending: string[],
  inListing: boolean,
  refetch: boolean,
  into: Gathered,
): Promise<string[]> {
  const map = await mapOf(run);
  for (const [at, fileId] of pending.entries()) {
    if (full(into)) return pending.slice(at);
    let body: unknown;
    try {
      ({ body } = await apiGet(
        run.http,
        driveUrl(`files/${encodeURIComponent(fileId)}`, [["fields", FILE_FIELDS]]),
        run.deps,
      ));
    } catch (error) {
      if (failed(error, "not_found", 404)) {
        into.left.push(itemId(fileId));
        continue;
      }
      throw error;
    }
    const read = readFile(body);
    if ("unsupported" in read) {
      into.skipped.push({ sourceItemId: itemId(read.unsupported), reason: "unsupported" });
      continue;
    }
    const file = placed(read, map, run.roots);
    if (file === null) into.left.push(itemId(fileId));
    else await take(run, account, file, inListing, refetch, into);
  }
  return [];
}

const startToken = async (run: DriveRun): Promise<string> => {
  const body = (await apiGet(run.http, driveUrl("changes/startPageToken", []), run.deps)).body;
  if (!isRecord(body) || !text(body.startPageToken)) throw bad();
  return body.startPageToken;
};

// A listing has no window: every file under a root is handed over, whatever its age.
async function listing(
  run: DriveRun,
  account: SourceAccount,
  at: Extract<DrivePhase, { phase: "d_list" }>,
  limit: number,
): Promise<PersonalPage> {
  const into = gathered();
  // A listing's first page has neither a page token nor pending ids.
  const first = at.pageToken === undefined && at.pending === undefined;
  const { pending: _pending, pageToken: _token, ...stood } = at;
  const resume = (left: string[], pageToken: string | undefined): PersonalPage | null =>
    left.length === 0
      ? null
      : pageOf(into, { ...stood, ...(pageToken === undefined ? {} : { pageToken }), pending: left }, true, { first });
  const ended = (pageToken: string | undefined): PersonalPage =>
    pageToken === undefined
      ? pageOf(into, { phase: "d_changes", token: at.start }, false, { first, ended: "complete" })
      : pageOf(into, { ...stood, pageToken }, true, { first });

  if (at.pending !== undefined) {
    const left = await takePending(run, account, at.pending, true, at.refetch, into);
    return resume(left, at.pageToken) ?? ended(at.pageToken);
  }
  const map = await mapOf(run);
  const params: [string, string][] = [
    ["q", FILE_QUERY],
    ["corpora", "user"],
    ["spaces", "drive"],
    ["pageSize", String(Math.min(limit, MAX_LISTED))],
    ["fields", `nextPageToken,files(${FILE_FIELDS})`],
    ...(at.pageToken === undefined ? [] : [["pageToken", at.pageToken] satisfies [string, string]]),
  ];
  const body = (await apiGet(run.http, driveUrl("files", params), run.deps)).body;
  if (!isRecord(body) || (body.files !== undefined && !Array.isArray(body.files))) throw bad();
  const pageToken = optionalToken(body.nextPageToken);
  const inScope: DriveFile[] = [];
  for (const one of (body.files as unknown[] | undefined) ?? []) {
    const read = readFile(one);
    if ("unsupported" in read) {
      into.skipped.push({ sourceItemId: itemId(read.unsupported), reason: "unsupported" });
      continue;
    }
    const file = placed(read, map, run.roots);
    if (file !== null) inScope.push(file);
  }
  const left = await takeSome(run, account, inScope, true, at.refetch, into);
  return resume(left, pageToken) ?? ended(pageToken);
}

// The folder map is read again after it, so a folder change the feed did not hand over before the
// token is not missed.
async function newListing(
  run: DriveRun,
  account: SourceAccount,
  refetch: boolean,
  limit: number,
): Promise<PersonalPage> {
  run.folders = undefined;
  return listing(run, account, { phase: "d_list", start: await startToken(run), refetch }, limit);
}

async function feed(
  run: DriveRun,
  account: SourceAccount,
  at: Extract<DrivePhase, { phase: "d_changes" }>,
  limit: number,
): Promise<PersonalPage> {
  const into = gathered();
  if (at.pending !== undefined) {
    const left = await takePending(run, account, at.pending, false, false, into);
    return pageOf(into, { phase: "d_changes", token: at.token, ...(left.length === 0 ? {} : { pending: left }) }, true);
  }
  const map = await mapOf(run);
  const changes = await readChanges(run.http, run.deps, at.token, limit);
  if (changes === null) return newListing(run, account, false, limit);
  const { pageToken, newStart, last } = changes;

  let ends = false;
  const files: Listed[] = [];
  for (const [fileId, change] of last) {
    const removed = change.removed === true;
    const read = removed || change.file === undefined ? null : readFile(change.file);
    if (read !== null && "unsupported" in read) {
      into.skipped.push({ sourceItemId: itemId(fileId), reason: "unsupported" });
      continue;
    }
    if ((removed && map.has(fileId)) || read?.folder === true) {
      const folder: FolderChange = {
        id: fileId,
        gone: removed || read?.trashed === true || read?.sharedDrive === true,
        parent: read?.file.parent,
      };
      if (map.endsFeed(folder, run.roots)) ends = true;
      map.update(folder);
      continue;
    }
    if (removed || read === null) {
      into.deletions.push({ sourceAccount: account.id, sourceItemId: itemId(fileId), deletedAt: clock(run) });
      continue;
    }
    if (read.sharedDrive) continue;
    files.push(read);
  }

  // The page's files, placed after every folder change of the page.
  const inScope: DriveFile[] = [];
  for (const one of files) {
    const file = placed(one, map, run.roots);
    if (file === null) into.left.push(itemId(one.file.id));
    else inScope.push(file);
  }
  if (ends) {
    // What does not fit the page is listed again by that listing.
    await takeSome(run, account, inScope, false, false, into);
    const start = await startToken(run);
    // The listing reads the folders again, after its start token: later feed pages are not read.
    run.folders = undefined;
    return pageOf(into, { phase: "d_list", start, refetch: false }, true);
  }
  const left = await takeSome(run, account, inScope, false, false, into);
  const token = pageToken ?? (newStart as string);
  return pageOf(
    into,
    { phase: "d_changes", token, ...(left.length === 0 ? {} : { pending: left }) },
    pageToken !== undefined || left.length > 0,
  );
}

// Only the feed is read, from the token given; nothing is fetched, nothing is listed, the folder
// map is not read, and no change ends the feed. A token no longer good gives an empty page: the
// full pass, below the ceiling, lists.
async function removals(
  run: DriveRun,
  account: SourceAccount,
  at: Extract<DrivePhase, { phase: "d_changes" }>,
  limit: number,
): Promise<PersonalPage> {
  const into = gathered();
  const changes = await readChanges(run.http, run.deps, at.token, limit);
  if (changes === null) return pageOf(into, at, false);
  const { pageToken, newStart, last } = changes;
  for (const [fileId, change] of last) {
    const read = change.removed === true || change.file === undefined ? null : readFile(change.file);
    if (read === null)
      into.deletions.push({ sourceAccount: account.id, sourceItemId: itemId(fileId), deletedAt: clock(run) });
    else if (!("unsupported" in read) && !read.folder && (read.trashed || read.sharedDrive))
      into.left.push(itemId(fileId));
  }
  return pageOf(into, { phase: "d_changes", token: pageToken ?? (newStart as string) }, pageToken !== undefined);
}

export function drivePages(
  http: HttpPort,
  options: ConnectorOptions,
  deps: GoogleDeps,
): {
  page: (account: SourceAccount, phase: DrivePhase | null, limit: number) => Promise<PersonalPage>;
} {
  const { now, sleep } = withDefaults(deps);
  const roots = new Set(options.roots ?? []);
  const run: DriveRun = { http, deps, roots, stored: options.stored, now, sleep };
  return {
    async page(account, phase, limit) {
      if (options.removalsOnly === true) {
        if (roots.size === 0 || phase === null) return pageOf(gathered(), { phase: "d_reset" }, false);
        return phase.phase === "d_changes"
          ? removals(run, account, { phase: "d_changes", token: phase.token }, limit)
          : pageOf(gathered(), phase, false);
      }
      if (roots.size === 0) return pageOf(gathered(), { phase: "d_reset" }, false, { first: true, ended: "complete" });
      if (phase === null) return newListing(run, account, false, limit);
      if (phase.phase === "d_reset") return newListing(run, account, true, limit);
      if (phase.phase === "d_list") return listing(run, account, phase, limit);
      return feed(run, account, phase, limit);
    },
  };
}
