import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { codePoints } from "@intelligence/personal-core";
import { splitEntries } from "@intelligence/personal-core/checks";
import { refusal } from "../env.ts";
import type { AgentApiClient } from "./memory-api.ts";
import { missing } from "./memory-files.ts";
import type { AdapterState, Pending, StateEntry, StateStore } from "./memory-state.ts";

// Memory coming back, the adapter's side: read the directories the owner lists, split each file
// into entries, diff them against the state file's last copy, and send the changes with
// import_memory, 50 at a time. Only regular `*.md` files directly inside a listed directory are
// read, never an agent's instruction files or the owned file, never through a link, at most 200
// files of 64 KiB. What it returns is counts only, never an entry's text.

// `too_long` counts the entries over 8 000 code points, and any holding a NUL, which are not sent.
export type InboundCounts = { added: number; removed: number; too_long: number; skipped_files: number };

const NEVER = new Set(["CLAUDE.md", "AGENTS.md"]);
const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024;
const MAX_CODE_POINTS = 8000;
const MAX_LOCATOR = 512;
const BATCH = 50;
// An entry id is nine random bytes in base64url: twelve characters.
const ENTRY_ID_SHAPE = "x".repeat(12);

// The calls the reading makes, so a test can see every path it touches.
export type InboundFs = Pick<typeof nodeFs, "readdir" | "open">;

type Read = { entries: string[]; modified: Date };

const randomId = (bytes: number): string => randomBytes(bytes).toString("base64url");
// What import_memory takes as a body. One that is not is never sent, since a batch
// the host refuses would be sent again by every later run.
const sendable = (text: string): boolean => codePoints(text) <= MAX_CODE_POINTS && !text.includes("\0");
const locatorOf = (file: string, id: string): string => `${file}#${id}`;

// Each listed directory's files, by path, with their entries; and how many were passed over: a
// link, anything not a plain file, a file over 64 KiB, past the 200th, or whose locator would be
// too long. A directory that does not exist lists nothing.
async function readFiles(
  dirs: readonly string[],
  owned: string,
  fs: InboundFs,
): Promise<{ read: Map<string, Read>; listed: Set<string>; skipped: number }> {
  const read = new Map<string, Read>();
  const listed = new Set<string>();
  let skipped = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).sort();
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (!name.endsWith(".md") || NEVER.has(name) || path === owned) continue;
      listed.add(path);
      if (read.size >= MAX_FILES || codePoints(locatorOf(path, ENTRY_ID_SHAPE)) > MAX_LOCATOR) {
        skipped += 1;
        continue;
      }
      // No link is followed, and a named pipe is never waited on.
      let handle: nodeFs.FileHandle;
      try {
        handle = await fs.open(
          path,
          nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK,
        );
      } catch {
        skipped += 1;
        continue;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) {
          skipped += 1;
          continue;
        }
        read.set(path, { entries: splitEntries(await handle.readFile("utf8")), modified: stat.mtime });
      } finally {
        await handle.close();
      }
    }
  }
  return { read, listed, skipped };
}

// The changes that bring the state's copies to what was read. An entry whose text
// equals one in the last copy of its file keeps that entry's id, each old entry matched once; any
// other is added, with a new id, request id and generation; an old one matched by none is removed.
// Reordering sends nothing. A file listed and not read is left as it was; a file of a listed
// directory that is no longer there has every entry removed.
function diff(
  state: AdapterState,
  dirs: readonly string[],
  files: Awaited<ReturnType<typeof readFiles>>,
  now: Date,
): { changes: Pending[]; tooLong: number } {
  const changes: Pending[] = [];
  let tooLong = 0;
  const removed = (file: string, entry: StateEntry): Pending => ({
    file,
    change: "removed",
    entry: { ...entry, requestId: randomId(16) },
  });
  for (const [file, { entries, modified }] of files.read) {
    const known = state.files[file];
    let generation = known?.generation ?? 0;
    const pool = new Map<string, StateEntry[]>();
    for (const entry of known?.entries ?? []) pool.set(entry.text, [...(pool.get(entry.text) ?? []), entry]);
    // On a first run of a file, an entry was first seen when the file was last modified.
    const firstSeen = (known === undefined ? modified : now).toISOString();
    for (const text of entries) {
      if (!sendable(text)) {
        tooLong += 1;
        continue;
      }
      const same = pool.get(text);
      if (same !== undefined && same.length > 0) {
        same.shift();
        continue;
      }
      generation += 1;
      changes.push({
        file,
        change: "added",
        entry: { id: randomId(9), text, requestId: randomId(16), generation, firstSeen },
      });
    }
    for (const left of pool.values()) for (const entry of left) changes.push(removed(file, entry));
  }
  for (const [file, known] of Object.entries(state.files)) {
    const underListed = dirs.some((dir) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes("/"));
    if (underListed && !files.listed.has(file)) for (const entry of known.entries) changes.push(removed(file, entry));
  }
  return { changes, tooLong };
}

// A sent change folded into its file's copy. A file's record is kept when it has no entry left,
// so its generation only rises.
function fold(state: AdapterState, sent: readonly Pending[]): void {
  for (const { file, change, entry } of sent) {
    const known = state.files[file] ?? { generation: 0, entries: [] };
    if (change === "added") {
      known.entries.push(entry);
      known.generation = Math.max(known.generation, entry.generation);
    } else {
      known.entries = known.entries.filter((one) => one.id !== entry.id);
    }
    state.files[file] = known;
  }
}

const toChange = ({ file, change, entry }: Pending) =>
  change === "added"
    ? {
        requestId: entry.requestId,
        locator: locatorOf(file, entry.id),
        change,
        entryTime: entry.firstSeen,
        body: entry.text,
      }
    : { requestId: entry.requestId, locator: locatorOf(file, entry.id), change };

// One inbound pass. The batch being sent is written to the state file before its call, and the
// state whole after its answer: a batch not answered is sent again by the next run with the same
// request ids, and the host answers it replayed. A refusal ends the run with its code.
export async function runInbound({
  dirs,
  owned,
  store,
  api,
  now,
  fs = nodeFs,
}: {
  dirs: readonly string[];
  owned: string;
  store: StateStore;
  api: AgentApiClient;
  now: Date;
  fs?: InboundFs;
}): Promise<InboundCounts> {
  const state = await store.read();
  const counts: InboundCounts = { added: 0, removed: 0, too_long: 0, skipped_files: 0 };
  const send = async (batch: Pending[]): Promise<void> => {
    state.pending = batch;
    await store.write(state);
    const outcome = await api.call("import_memory", { changes: batch.map(toChange) });
    if (!outcome.ok) throw refusal(outcome.code);
    fold(state, batch);
    state.pending = [];
    await store.write(state);
    for (const one of batch) counts[one.change] += 1;
  };
  if (state.pending.length > 0) await send(state.pending);
  const files = await readFiles(dirs, owned, fs);
  const { changes, tooLong } = diff(state, dirs, files, now);
  counts.too_long = tooLong;
  counts.skipped_files = files.skipped;
  for (let at = 0; at < changes.length; at += BATCH) await send(changes.slice(at, at + BATCH));
  return counts;
}
