import type {
  ConnectorCursor,
  RawItem,
  SourceAccount,
  SourceAccountId,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import type { DocumentUnreadable } from "@intelligence/contracts/personal";
import { documentKind, documentTooLong, driveItem, driveRevisionTag } from "../items/documents.ts";
import type { ConnectorOptions, DocBody, DriveFile, PersonalConnector, PersonalPage } from "../items/types.ts";
import { callPlan, coded, decodeCursor, encodeCursor, type FailureKind, pageLimit } from "./support.ts";

// A Drive in memory that hands over the pages the Google connector would, with items from the same
// builder. Deterministic: no random value, and its clock is the `now` it is given. It keeps a
// folder tree, files and a changes feed; a connector reads it through its roots and asks `stored`
// before it hands a document over.
//
// A listing reads the feed's position first, then lists every file in scope by id, a page of files
// at a time. Of a page at most 25 documents are fetched; the rest are pending in the cursor and
// read again first on the next call. It ends `complete` in the feed at the position it read first.
// The feed hands over, for each change, the last entry for its file: a removal is a deletion, a
// file in scope an item, any other file is named in `left`. A folder change that can change a
// file's root ends the feed, and the next call lists again.

// A file as a test puts it: everything but its root, which the fake works out, and whether it
// was shared with the owner directly.
export type FakeDriveFile = Omit<DriveFile, "root"> & { sharedWithMe?: boolean; inSharedDrive?: boolean };

export type FakeDrive = {
  connector(sourceAccount: SourceAccountId, options: ConnectorOptions): PersonalConnector;
  // My Drive's own folder id.
  readonly myDrive: string;
  createFolder(id: string, parent?: string, options?: { inSharedDrive?: boolean }): void;
  put(file: FakeDriveFile, body?: DocBody | null): void;
  // A new revision: the change given, a modified time one second per change later, by the owner.
  edit(
    id: string,
    change?: {
      name?: string;
      body?: DocBody;
      modifiedByMe?: boolean;
      canDownload?: boolean;
      ownedByMe?: boolean;
      size?: number;
    },
  ): void;
  move(id: string, parent: string): void;
  trash(id: string): void;
  restore(id: string): void;
  // Gone for good, or no longer shared with the owner: the feed reports a removal.
  deletePermanently(id: string): void;
  unshare(id: string): void;
  moveFolder(id: string, parent: string): void;
  trashFolder(id: string): void;
  // Its content call answers 403, its answer is over the bound, or it is gone when it is read.
  forbid(id: string): void;
  tooLarge(id: string): void;
  goneAtGet(id: string): void;
  failAt(n: number, kind: FailureKind): void;
  // Every listChanges call that reached Drive.
  readonly calls: number;
  // The ids of the files whose content was read, in order.
  readonly fetched: string[];
};

type Folder = { id: string; parent?: string; trashed: boolean; inSharedDrive: boolean };
type Held = { file: FakeDriveFile; body: DocBody | null; trashed: boolean; removed: boolean };
// One change to the feed: its position, the file or folder, and for a folder its parent before.
type Change = { seq: number; id: string; folder: boolean; removed: boolean; oldParent?: string };

// A listing begins at the next call; one under way has its feed position, how far into the
// sorted list it is, whether it fetches what is stored, and the ids still to hand over.
type ListCursor = {
  fake: "drive";
  phase: "list";
  start?: number;
  offset: number;
  refetch: boolean;
  pending?: string[];
};
type ChangesCursor = { fake: "drive"; phase: "changes"; token: number; pending?: string[] };
type ResetCursor = { fake: "drive"; phase: "reset" };
type Cursor = ListCursor | ChangesCursor | ResetCursor;

const RESET: ResetCursor = { fake: "drive", phase: "reset" };
const MAX_FETCHES = 25;
const MAX_WAY_UP = 100;
const DOC = "application/vnd.google-apps.document";
const fileItemId = (id: string): string => `drive-file:${id}`;

export function fakeDrive(account: { address: string }, options: { now: Timestamp; pageSize?: number }): FakeDrive {
  const pageSize = options.pageSize ?? 50;
  const myDrive = "fake-my-drive-root-0";
  const folders = new Map<string, Folder>([[myDrive, { id: myDrive, trashed: false, inSharedDrive: false }]]);
  const files = new Map<string, Held>();
  const changes: Change[] = [];
  const forbidden = new Set<string>();
  const large = new Set<string>();
  const gone = new Set<string>();
  const fetched: string[] = [];
  const plan = callPlan();
  let seq = 0;

  const record = (id: string, folder: boolean, removed: boolean, oldParent?: string): void => {
    seq += 1;
    changes.push({ seq, id, folder, removed, ...(oldParent === undefined ? {} : { oldParent }) });
  };
  const heldFile = (id: string): Held => {
    const found = files.get(id);
    if (found === undefined || found.removed) throw new Error("unknown file");
    return found;
  };
  const heldFolder = (id: string): Folder => {
    const found = folders.get(id);
    if (found === undefined) throw new Error("unknown folder");
    return found;
  };

  // The folders from a parent up, at most MAX_WAY_UP, or null for a way that loops or is too long.
  function wayUp(parent: string | undefined): string[] | null {
    const way: string[] = [];
    for (let at = parent; at !== undefined; at = folders.get(at)?.parent) {
      if (way.includes(at) || way.length >= MAX_WAY_UP) return null;
      const folder = folders.get(at);
      if (folder === undefined || folder.trashed || folder.inSharedDrive) return null;
      way.push(at);
    }
    return way;
  }

  function rootOf(held: Held, roots: string[]): string | null {
    if (held.removed || held.trashed || held.file.inSharedDrive === true) return null;
    const way = wayUp(held.file.parent);
    if (way !== null) {
      const folder = way.find((id) => roots.includes(id));
      if (folder !== undefined) return folder;
      if (way.at(-1) === myDrive && roots.includes("my-drive")) return "my-drive";
    }
    return held.file.sharedWithMe === true && roots.includes("shared-with-me") ? "shared-with-me" : null;
  }

  function connector(sourceAccount: SourceAccountId, built: ConnectorOptions): PersonalConnector {
    const roots = built.roots ?? [];
    const stored = built.stored;

    // A file of the account as the connector reads it, with its root.
    const asFile = (held: Held, root: string): DriveFile => {
      const { sharedWithMe: _shared, inSharedDrive: _drive, ...file } = held.file;
      return { ...file, root };
    };

    // One file in scope: nothing when its tag is stored and the page does not refetch; else its
    // item, reading the content of a Google Doc that may be downloaded. Gone at its content call
    // is `left`. Answers whether a content call was made.
    async function take(
      source: SourceAccount,
      id: string,
      root: string,
      refetch: boolean,
      page: Built,
    ): Promise<"listed" | "fetched" | "taken" | "left"> {
      const held = heldFile(id);
      const file = asFile(held, root);
      if (!refetch && stored !== undefined && (await stored(fileItemId(id), driveRevisionTag(file)))) return "listed";
      const readable = file.mimeType === DOC && file.canDownload;
      if (readable && gone.has(id)) return "left";
      let body: DocBody | null = null;
      let unreadable: DocumentUnreadable | null = null;
      if (!readable) unreadable = documentKind(file.mimeType) === "doc" ? "no_download" : "not_a_document";
      else if (forbidden.has(id)) unreadable = "forbidden";
      else if (large.has(id)) unreadable = "too_large";
      else {
        const read = held.body ?? { blocks: [] };
        if (documentTooLong(read)) unreadable = "too_long";
        else body = read;
      }
      if (readable) fetched.push(id);
      page.items.push(
        driveItem(file, body, unreadable, {
          sourceAccount: source.id,
          changeKind: page.changeKind,
          ownerAddress: account.address,
        }),
      );
      return readable ? "fetched" : "taken";
    }

    type Built = {
      items: RawItem[];
      deletions: SourceDeletion[];
      listed: string[];
      left: string[];
      changeKind: "backfill" | "live";
      fetches: number;
    };

    // Each id until 25 documents are fetched; the ids not reached are returned.
    async function takeAll(source: SourceAccount, ids: string[], refetch: boolean, page: Built): Promise<string[]> {
      for (const [at, id] of ids.entries()) {
        if (page.fetches >= MAX_FETCHES) return ids.slice(at);
        const held = files.get(id);
        const root = held === undefined ? null : rootOf(held, roots);
        if (held === undefined || root === null) {
          page.left.push(fileItemId(id));
          continue;
        }
        const taken = await take(source, id, root, refetch, page);
        if (taken === "fetched") page.fetches += 1;
        if (taken === "listed" && page.changeKind === "backfill") page.listed.push(fileItemId(id));
        if (taken === "left") page.left.push(fileItemId(id));
      }
      return [];
    }

    const empty = (changeKind: Built["changeKind"]): Built => ({
      items: [],
      deletions: [],
      listed: [],
      left: [],
      changeKind,
      fetches: 0,
    });
    const pageOf = (built: Built, more: boolean, next: Cursor, listing?: PersonalPage["listing"]): PersonalPage => ({
      items: built.items,
      deletions: built.deletions,
      skipped: [],
      more,
      next: encodeCursor(next),
      ...(listing === undefined ? {} : { listing }),
      ...(built.changeKind === "backfill" ? { listed: built.listed } : {}),
      ...(built.left.length === 0 ? {} : { left: built.left }),
    });

    async function listingPage(source: SourceAccount, cursor: ListCursor, size: number): Promise<PersonalPage> {
      const first = cursor.start === undefined;
      const start = cursor.start ?? seq;
      const built = empty("backfill");
      const inScope = [...files.entries()]
        .filter(([, held]) => rootOf(held, roots) !== null)
        .map(([id]) => id)
        .sort();
      const pending = await takeAll(source, cursor.pending ?? [], cursor.refetch, built);
      const listedNow = pending.length > 0 ? [] : inScope.slice(cursor.offset, cursor.offset + size);
      const rest = pending.length > 0 ? pending : await takeAll(source, listedNow, cursor.refetch, built);
      const offset = cursor.offset + listedNow.length;
      const done = rest.length === 0 && offset >= inScope.length;
      const next: Cursor = done
        ? { fake: "drive", phase: "changes", token: start }
        : {
            fake: "drive",
            phase: "list",
            start,
            offset,
            refetch: cursor.refetch,
            ...(rest.length === 0 ? {} : { pending: rest }),
          };
      return pageOf(built, !done, next, { first, ...(done ? { ended: "complete" as const } : {}) });
    }

    function endsFeed(change: Change): boolean {
      if (!change.folder) return false;
      if (change.removed) return true;
      const reaches = (parent: string | undefined): boolean =>
        roots.includes(change.id) ||
        (wayUp(parent) ?? []).some((id) => roots.includes(id)) ||
        (roots.includes("my-drive") && (wayUp(parent) ?? []).at(-1) === myDrive);
      return reaches(change.oldParent) || reaches(folders.get(change.id)?.parent);
    }

    async function changesPage(source: SourceAccount, cursor: ChangesCursor, size: number): Promise<PersonalPage> {
      const built = empty("live");
      // What an earlier page listed and did not hand over is read again first.
      const waiting = await takeAll(source, cursor.pending ?? [], false, built);
      if (waiting.length > 0)
        return pageOf(built, true, { fake: "drive", phase: "changes", token: cursor.token, pending: waiting });
      const after = changes.filter((change) => change.seq > cursor.token);
      const read = after.slice(0, size);
      const token = read.at(-1)?.seq ?? cursor.token;
      const ended = read.some(endsFeed);
      const last = new Map<string, Change>();
      for (const change of read) if (!change.folder) last.set(change.id, change);
      const ids: string[] = [];
      for (const change of [...last.values()].sort((a, b) => a.seq - b.seq)) {
        if (change.removed)
          built.deletions.push({
            sourceAccount: source.id,
            sourceItemId: fileItemId(change.id),
            deletedAt: options.now,
          });
        else ids.push(change.id);
      }
      const rest = await takeAll(source, ids, false, built);
      if (ended)
        return pageOf(built, true, {
          fake: "drive",
          phase: "list",
          offset: 0,
          refetch: false,
          ...(rest.length === 0 ? {} : { pending: rest }),
        });
      const more = after.length > read.length || rest.length > 0;
      return pageOf(built, more, {
        fake: "drive",
        phase: "changes",
        token,
        ...(rest.length === 0 ? {} : { pending: rest }),
      });
    }

    // Any other phase: no call.
    function removalsPage(
      source: SourceAccount,
      state: Cursor | null,
      given: ConnectorCursor | null,
      size: number,
    ): PersonalPage {
      const built = empty("live");
      if (state?.phase !== "changes") return { ...pageOf(built, false, RESET), next: given ?? encodeCursor(RESET) };
      const after = changes.filter((change) => change.seq > state.token);
      const read = after.slice(0, size);
      const last = new Map<string, Change>();
      for (const change of read) if (!change.folder) last.set(change.id, change);
      for (const change of [...last.values()].sort((a, b) => a.seq - b.seq)) {
        const held = files.get(change.id);
        if (change.removed)
          built.deletions.push({
            sourceAccount: source.id,
            sourceItemId: fileItemId(change.id),
            deletedAt: options.now,
          });
        else if (held !== undefined && (held.trashed || held.file.inSharedDrive === true))
          built.left.push(fileItemId(change.id));
      }
      return pageOf(built, after.length > read.length, {
        fake: "drive",
        phase: "changes",
        token: read.at(-1)?.seq ?? state.token,
      });
    }

    return {
      async listChanges(source, cursor, limit) {
        if (source.id !== sourceAccount || source.connector !== "google_docs") throw coded("off_allowlist");
        const size = Math.min(pageLimit(limit), pageSize);
        const state: Cursor | null = cursor === null ? null : decodeCursor<Cursor>(cursor, "drive");
        if (roots.length === 0) return pageOf(empty("backfill"), false, RESET, { first: true, ended: "complete" });
        const failure = plan.next();
        if (failure !== undefined && !(failure === "not_found" && state?.phase === "changes")) throw coded(failure);
        if (built.removalsOnly === true) return removalsPage(source, state, cursor, size);
        if (state === null)
          return listingPage(source, { fake: "drive", phase: "list", offset: 0, refetch: false }, size);
        if (state.phase === "reset")
          return listingPage(source, { fake: "drive", phase: "list", offset: 0, refetch: true }, size);
        if (state.phase === "list") return listingPage(source, state, size);
        if (failure === "not_found")
          return listingPage(source, { fake: "drive", phase: "list", offset: 0, refetch: false }, size);
        return changesPage(source, state, size);
      },
      syncAccessList: async (_source, cursor) => ({
        changes: [],
        next: cursor ?? encodeCursor({ fake: "drive-access" }),
      }),
      resetCursor: () => encodeCursor(RESET),
    };
  }

  const fileChange = (id: string, change: (held: Held) => void): void => {
    change(heldFile(id));
    record(id, false, false);
  };
  const later = (): Timestamp => new Date(Date.parse(options.now) + (seq + 1) * 1000).toISOString() as Timestamp;

  return {
    connector,
    myDrive,
    createFolder(id, parent = myDrive, folderOptions = {}) {
      folders.set(id, { id, parent, trashed: false, inSharedDrive: folderOptions.inSharedDrive === true });
      record(id, true, false);
    },
    put(file, body = null) {
      files.set(file.id, { file: { ...file }, body, trashed: false, removed: false });
      record(file.id, false, false);
    },
    edit(id, change = {}) {
      const modifiedTime = later();
      fileChange(id, (held) => {
        const { body, ...fields } = change;
        held.file = { ...held.file, modifiedByMe: true, ...fields, modifiedTime };
        if (body !== undefined) held.body = body;
      });
    },
    move: (id, parent) => fileChange(id, (held) => void (held.file = { ...held.file, parent })),
    trash: (id) => fileChange(id, (held) => void (held.trashed = true)),
    restore: (id) => fileChange(id, (held) => void (held.trashed = false)),
    deletePermanently(id) {
      heldFile(id).removed = true;
      record(id, false, true);
    },
    unshare(id) {
      heldFile(id).removed = true;
      record(id, false, true);
    },
    moveFolder(id, parent) {
      const folder = heldFolder(id);
      const oldParent = folder.parent;
      folder.parent = parent;
      record(id, true, false, oldParent);
    },
    trashFolder(id) {
      const folder = heldFolder(id);
      folder.trashed = true;
      record(id, true, false, folder.parent);
    },
    forbid: (id) => void forbidden.add(id),
    tooLarge: (id) => void large.add(id),
    goneAtGet: (id) => void gone.add(id),
    failAt: plan.failAt,
    get calls() {
      return plan.calls;
    },
    get fetched() {
      return [...fetched];
    },
  };
}
