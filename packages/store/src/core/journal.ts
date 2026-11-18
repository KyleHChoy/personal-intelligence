import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { CodedError, ErasureJournalEntry, isCoded } from "@intelligence/contracts/personal";
import type { Query } from "./db.ts";

// The erasure journal: one file beside the key file, mode 0600, one JSON line per entry, appended
// and synced to disk before the erasure's transaction commits. Ids, fingerprints and sequence
// numbers only: an entry is parsed with a strict schema that has no field for a string of content.
// Every refusal is `journal_refused` and carries nothing of the file.

export type JournalEntry = ErasureJournalEntry;

export const journalPath = (keyFile: string): string => `${keyFile}.erasures`;

const refused = (): Error => new CodedError("journal_refused");

// A journal any but its owner may read, write or run is refused.
const ownerOnly = (mode: number): boolean => (mode & 0o077) === 0;

const missing = (error: unknown): boolean => isCoded(error, "ENOENT");

// The folder synced, so a file just made in it survives a crash.
async function syncFolder(path: string): Promise<void> {
  const folder = await open(dirname(path), "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

// The file opened for appending, made with mode 0600 and its folder synced when it is missing.
async function openForAppend(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const existed = await stat(path).then(
    () => true,
    (error: unknown) => {
      if (missing(error)) return false;
      throw refused();
    },
  );
  const handle = await open(path, "a", 0o600).catch(() => {
    throw refused();
  });
  try {
    if (!ownerOnly((await handle.stat()).mode)) throw refused();
    if (!existed) await syncFolder(path);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// One entry, appended as one line and synced to disk before this returns.
export async function appendJournal(path: string, entry: JournalEntry): Promise<void> {
  if (!ErasureJournalEntry.safeParse(entry).success) throw refused();
  const handle = await openForAppend(path);
  try {
    await handle.write(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The empty journal, made when it is missing (`pi erase replay` on a store with no erasure).
export async function ensureJournal(path: string): Promise<void> {
  const handle = await openForAppend(path);
  await handle.close();
}

// The file's text, or null for a missing file that need not exist. A file others may read is
// refused.
async function journalText(path: string, mustExist: boolean): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (missing(error) && !mustExist) return null;
    throw refused();
  }
  try {
    if (!ownerOnly((await handle.stat()).mode)) throw refused();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function entriesOf(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw refused();
    }
    const parsed = ErasureJournalEntry.safeParse(value);
    if (!parsed.success || parsed.data.seq !== entries.length + 1) throw refused();
    entries.push(parsed.data);
  }
  return entries;
}

// Every entry in order and the last sequence number, 0 for a journal with none. A missing file
// reads as no entry, and is refused with `mustExist`. A file others may read, a line that does
// not parse and a sequence that does not rise by one from 1 are refused.
export async function readJournal(
  path: string,
  options: { mustExist?: boolean } = {},
): Promise<{ entries: JournalEntry[]; seq: number }> {
  const text = await journalText(path, options.mustExist === true);
  const entries = text === null ? [] : entriesOf(text);
  return { entries, seq: entries.length };
}

// The journal's mark: its last sequence number alone, one line `{"mark":N}`. It is the form the
// agent API's user holds, since its reader needs only the number: it carries no id and no
// fingerprint, so that user learns nothing of an erasure in a compartment it is not cleared for.
const MARK = /^\{"mark":(0|[1-9][0-9]{0,14})\}\n?$/;
export const journalMarkText = (seq: number): string => {
  if (!Number.isSafeInteger(seq) || seq < 0) throw refused();
  return `${JSON.stringify({ mark: seq })}\n`;
};

// The last sequence number of a journal, whole or in its mark's form (`markForm`), as readJournal
// reads it. A mark that is not exactly the one line is refused.
async function lastSeq(path: string, options: { mustExist: boolean; markForm: boolean }): Promise<number> {
  const text = await journalText(path, options.mustExist);
  if (text === null) return 0;
  const mark = options.markForm ? MARK.exec(text) : null;
  if (mark !== null) return Number(mark[1]);
  return entriesOf(text).length;
}

// A journal that is missing while the database holds an entry is refused: a wrong path must never read as no
// erasure. With `mustExist` a missing journal is refused whatever the mark (the dispatcher's check, which has no
// key file to find it beside). With `markForm` the file may also be the journal's mark (journalMarkText), as the
// agent API's reader takes it.
export async function erasureLevel(
  query: Query,
  path: string,
  options: { mustExist?: boolean; markForm?: boolean } = {},
): Promise<"level" | "behind"> {
  const [row] = await query<{ mark: string }>("select policy.journal_mark()::text as mark");
  const mark = Number(row?.mark ?? 0);
  const seq = await lastSeq(path, {
    mustExist: options.mustExist === true || mark > 0,
    markForm: options.markForm === true,
  });
  return seq === mark ? "level" : "behind";
}
