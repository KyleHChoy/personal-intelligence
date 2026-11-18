import { randomBytes } from "node:crypto";
import { open as openFile, rename, rm, stat } from "node:fs/promises";
import { DataKey, Envelope } from "@intelligence/contracts";
import { isCanaryCompartment, isRestricted } from "@intelligence/contracts/personal";
import { fingerprint } from "./fingerprint.ts";
import { randomHex } from "./ids.ts";
import type { Keys } from "./key-set.ts";
import { isWrapped, parseWrapped, type Wrapped, wrapKeys, wrappedText } from "./restricted-lock.ts";
import { open, type RowRef, sealRow } from "./seal.ts";

export type { Keys } from "./key-set.ts";
export {
  createRestrictedUnlock,
  type RestrictedUnlock,
  unwrap,
  type Wrapped,
  withPrf,
  withUnlock,
} from "./restricted-lock.ts";

export class KeyFileRefused extends Error {
  static {
    KeyFileRefused.prototype.name = "KeyFileRefused";
  }

  readonly code:
    | "exists"
    | "mode"
    | "check"
    | "format"
    | "missing"
    | "locked"
    | "changed"
    | "wrapped"
    | "restricted_key_file_unset";

  constructor(code: KeyFileRefused["code"]) {
    super(`key file refused (${code})`);
    this.code = code;
  }
}

// The file, as JSON. Every key is base64 of 32 bytes. The restricted file has no fingerprint key.
type RestrictedFile = {
  version: 1;
  compartments: Record<string, DataKey>;
  check: Record<string, Envelope>;
};
type KeyFile = RestrictedFile & { fingerprint: DataKey; fingerprintCheck: string };

// Which of the two files a path is read as.
type Which = "general" | "restricted";

const CHECK_TEXT = "pi-key-check";
const KEY_BYTES = 32;
const OWNER_ONLY = 0o600;
// The mode bits each file refuses: the restricted file is its owner's alone, and the general file
// may also be read by its group, `pi` in the box.
const REFUSED_MODE: Record<Which, number> = { general: 0o037, restricted: 0o077 };

// The key set an owner's read is given: without the check's compartments, so a canary is, to the
// terminal and the page, a compartment whose key is gone, which every owner read already leaves out.
// An erasure's walk does without it: it opens any row that could name who is erased, and shows only
// counts.
export const withoutCanary = (keys: Keys): Keys => ({
  ...keys,
  compartments: new Map([...keys.compartments].filter(([compartment]) => !isCanaryCompartment(compartment))),
});
// Where a compartment's check is sealed: the binding { evidenceId: "keyfile/<compartment>", field: "check" }.
const checkAt = (compartment: string): RowRef => ({ table: "keyfile", id: compartment, column: "check" });

const newKey = (): DataKey => DataKey.parse(randomBytes(KEY_BYTES).toString("base64"));

// The restricted file's keys alone carry an empty fingerprint key, for its checks only.
const keysOf = (file: RestrictedFile): Keys => ({
  compartments: new Map(Object.entries(file.compartments)),
  fingerprintKey: "fingerprint" in file ? Buffer.from((file as KeyFile).fingerprint, "base64") : Buffer.alloc(0),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The file's shape, and nothing about whether its keys are the right ones. The general file
// holds no restricted key; the restricted file holds restricted keys alone and no fingerprint key.
function parsed(text: string, which: Which): RestrictedFile {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new KeyFileRefused("format");
  }
  if (!isRecord(file) || file.version !== 1 || !isRecord(file.compartments) || !isRecord(file.check))
    throw new KeyFileRefused("format");
  if (
    which === "general" &&
    (!DataKey.safeParse(file.fingerprint).success || typeof file.fingerprintCheck !== "string")
  )
    throw new KeyFileRefused("format");
  if (which === "restricted" && (Object.hasOwn(file, "fingerprint") || Object.hasOwn(file, "fingerprintCheck")))
    throw new KeyFileRefused("format");
  for (const [compartment, key] of Object.entries(file.compartments)) {
    if (isRestricted(compartment) !== (which === "restricted")) throw new KeyFileRefused("format");
    if (!DataKey.safeParse(key).success || !Envelope.safeParse(file.check[compartment]).success)
      throw new KeyFileRefused("format");
  }
  return file as RestrictedFile;
}

const errorCode = (error: unknown): string | undefined => (error as { code?: string }).code;

// What a rewrite keeps of the file it replaces: its mode and its group.
type Kept = { mode: number; gid: number };

// A new file only its owner may read, with these bytes on disk before it returns. "wx": it fails
// when the path exists, so nothing is ever overwritten. A rewrite gives it the old file's mode and
// group before its bytes are synced, so the general file stays readable by `pi`. The group
// is changed only when the new file's differs: pirestricted, which rewrites the general file, is
// not in the group pi and cannot give a file that group, so the box's key folder gives every new
// file in it the group pi itself (its set-group-id bit, set by the image), and no change is asked.
async function writeNew(path: string, contents: string, kept?: Kept): Promise<void> {
  const handle = await openFile(path, "wx", OWNER_ONLY);
  try {
    if (kept !== undefined) {
      if ((await handle.stat()).gid !== kept.gid) await handle.chown(-1, kept.gid);
      await handle.chmod(kept.mode);
    }
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Reads a key file whose mode, shape and checks all hold, with the mode and group it has.
async function readText(path: string, which: Which): Promise<{ text: string; kept: Kept }> {
  const handle = await openFile(path, "r").catch((error: unknown) => {
    // No file, or no folder to hold one.
    if (errorCode(error) === "ENOENT") throw new KeyFileRefused("missing");
    throw error;
  });
  let text: string;
  let kept: Kept;
  try {
    // The mode of the file that is read, not of whatever the path names a moment later. A wrapped
    // restricted file opens nothing without a secret the box does not hold, so the group may read
    // it, as it reads the general file.
    const stats = await handle.stat();
    text = await handle.readFile("utf8");
    const refusedBits = which === "restricted" && isWrapped(text) ? REFUSED_MODE.general : REFUSED_MODE[which];
    if ((stats.mode & refusedBits) !== 0) throw new KeyFileRefused("mode");
    kept = { mode: stats.mode & 0o777, gid: stats.gid };
  } finally {
    await handle.close();
  }
  return { text, kept };
}

// A key file's text whose shape and checks all hold.
function checked(text: string, which: Which): RestrictedFile {
  const file = parsed(text, which);
  const keys = keysOf(file);
  for (const compartment of keys.compartments.keys()) {
    const row = { id: compartment, compartments: [compartment], check: file.check[compartment] };
    if (open(keys, row, "keyfile.check", "null") !== CHECK_TEXT) throw new KeyFileRefused("check");
  }
  if (which === "general" && fingerprint(keys, "source_id", CHECK_TEXT) !== (file as KeyFile).fingerprintCheck)
    throw new KeyFileRefused("check");
  return file;
}

// Reads a key file whose mode, shape and checks all hold, with the mode and group it has.
async function read(path: string, which: Which): Promise<{ file: RestrictedFile; kept: Kept }> {
  const { text, kept } = await readText(path, which);
  return { file: checked(text, which), kept };
}

// Adds one compartment's key and its check to a file in memory.
function addKey(file: RestrictedFile, compartment: string): void {
  file.compartments[compartment] = newKey();
  file.check[compartment] = sealRow(keysOf(file), compartment, checkAt(compartment), CHECK_TEXT);
}

const text = (file: RestrictedFile): string => `${JSON.stringify(file, null, 2)}\n`;

// The general file. A restricted key is refused: it belongs in the restricted file alone.
export async function generateKeyFile(path: string, compartments: string[] = ["own"]): Promise<void> {
  if (compartments.some(isRestricted)) throw new KeyFileRefused("format");
  const file: KeyFile = { version: 1, compartments: {}, fingerprint: newKey(), check: {}, fingerprintCheck: "" };
  for (const compartment of compartments) addKey(file, compartment);
  file.fingerprintCheck = fingerprint(keysOf(file), "source_id", CHECK_TEXT);
  try {
    await writeNew(path, text(file));
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new KeyFileRefused("exists");
    throw error;
  }
}

// A `restricted:<category>` key goes to the restricted file at `restrictedPath`, which its first
// key creates, and is refused (`restricted_key_file_unset`) with no path; every other key goes to
// the general file at `path`, which must exist.
export async function addCompartmentKey(path: string, compartment: string, restrictedPath?: string): Promise<void> {
  if (isRestricted(compartment) && (restrictedPath ?? "") === "") throw new KeyFileRefused("restricted_key_file_unset");
  const which: Which = isRestricted(compartment) ? "restricted" : "general";
  const target = which === "restricted" ? (restrictedPath as string) : path;
  // One add at a time: the file is read, changed and written back, and a second add working
  // from the same read would drop the first one's key. The lock is a file beside the key file.
  // An add that is killed leaves it, and the owner removes it by hand.
  const lock = `${target}.lock`;
  try {
    await writeNew(lock, "");
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new KeyFileRefused("locked");
    // No folder, so no key file in it.
    if (errorCode(error) === "ENOENT") throw new KeyFileRefused("missing");
    throw error;
  }
  try {
    // A wrapped restricted file takes no key: its keys open only with the owner's secret.
    if (which === "restricted" && (await wrappedAt(target)) !== undefined) throw new KeyFileRefused("wrapped");
    const found = await existing(target, which);
    const file = found?.file ?? { version: 1, compartments: {}, check: {} };
    if (Object.hasOwn(file.compartments, compartment)) throw new KeyFileRefused("exists");
    addKey(file, compartment);
    // The restricted file's first key makes it, as generateKeyFile makes the general file.
    if (found === undefined) {
      await writeNew(target, text(file));
      return;
    }
    // Written beside the file, synced, and renamed over it, so a kill leaves the old file or
    // the whole new one.
    const next = `${target}.${randomHex(8)}.tmp`;
    try {
      await writeNew(next, text(file), found.kept);
      await rename(next, target);
    } catch (error) {
      await rm(next, { force: true });
      throw error;
    }
  } finally {
    await rm(lock, { force: true });
  }
}

// The file at `target`, or, for the restricted file alone, nothing when there is none yet.
async function existing(target: string, which: Which): Promise<{ file: RestrictedFile; kept: Kept } | undefined> {
  try {
    return await read(target, which);
  } catch (error) {
    if (which === "restricted" && error instanceof KeyFileRefused && error.code === "missing") return undefined;
    throw error;
  }
}

// The general file's keys, and with `restrictedPath` the restricted file's beside them. No
// restricted file there yet is no restricted key: the first category's key makes the file. A
// wrapped one gives no key, only the names of its compartments, as `locked`.
export async function loadKeys(path: string, restrictedPath?: string): Promise<Keys> {
  const general = keysOf((await read(path, "general")).file);
  const wrapped = restrictedPath === undefined ? undefined : await wrappedAt(restrictedPath);
  if (wrapped !== undefined) return { ...general, locked: new Set(wrapped.compartments) };
  const found = restrictedPath === undefined ? undefined : await existing(restrictedPath, "restricted");
  if (found === undefined) return general;
  const restricted = keysOf(found.file);
  return {
    compartments: new Map([...general.compartments, ...restricted.compartments]),
    fingerprintKey: general.fingerprintKey,
  };
}

// The general file's keys as they are on disk at each call: what a long-running process (`pi
// http`) holds, so a client whose key `pia clients add` or `set-tools` wrote after it started
// is served without a restart. The file is read again, with every check `loadKeys` runs, only
// when its inode, size, modification or change time differ from those of the last read, and
// once for every caller that sees the change. A reload adds keys and changes none: a fingerprint
// key or a held key that differs, or a held key that is gone, is refused (`changed`), as is a
// file that would refuse a start. A refusal is kept for its file until the file changes again.
// The first read is made here, so a file that is refused still refuses the start.
export async function reloadingKeys(path: string): Promise<() => Promise<Keys>> {
  const stampOf = async (): Promise<string> => {
    const stats = await stat(path, { bigint: true }).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") throw new KeyFileRefused("missing");
      throw error;
    });
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  };
  // Stamped before it is read: a change between the two is read again by the next call.
  let read = { stamp: await stampOf(), keys: loadKeys(path) };
  let held = await read.keys;
  const added = async (): Promise<Keys> => {
    const keys = await loadKeys(path);
    const kept =
      keys.fingerprintKey.equals(held.fingerprintKey) &&
      [...held.compartments].every(([compartment, key]) => keys.compartments.get(compartment) === key);
    if (!kept) throw new KeyFileRefused("changed");
    held = keys;
    return keys;
  };
  return async () => {
    const stamp = await stampOf();
    if (stamp !== read.stamp) read = { stamp, keys: added() };
    return read.keys;
  };
}

// The compartments `pi send` holds: `own` and every `agent:` key, chosen by name alone.
export const forSending = (compartment: string): boolean => compartment === "own" || compartment.startsWith("agent:");

// A key file's text narrowed to the fingerprint key and the compartments `keep` names, with their
// checks, in the file's own format, so `loadKeys` reads it unchanged. Every check `loadKeys` runs
// is run on the whole text first, but the mode, which a text has none of: the send wrapper's entry
// narrows the bytes a `pi` process hands it on a pipe.
export function narrowKeyText(whole: string, keep: (compartment: string) => boolean): string {
  const file = checked(whole, "general") as KeyFile;
  const names = Object.keys(file.compartments).filter(keep);
  const narrowed: KeyFile = {
    ...file,
    compartments: Object.fromEntries(names.map((name) => [name, file.compartments[name] as DataKey])),
    check: Object.fromEntries(names.map((name) => [name, file.check[name] as Envelope])),
  };
  return text(narrowed);
}

// The narrowed copy of a key file, as a new file only its owner may read; nothing is overwritten.
export async function narrowKeyFile(path: string, out: string, keep: (compartment: string) => boolean): Promise<void> {
  const narrowed = narrowKeyText((await readText(path, "general")).text, keep);
  try {
    await writeNew(out, narrowed);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new KeyFileRefused("exists");
    throw error;
  }
}

// The wrapped restricted file at `path`, or nothing when there is none or it is not wrapped. Its
// mode and shape are checked as `loadKeys` checks them.
export async function wrappedAt(path: string): Promise<Wrapped | undefined> {
  let text: string;
  try {
    text = (await readText(path, "restricted")).text;
  } catch (error) {
    if (error instanceof KeyFileRefused && error.code === "missing") return undefined;
    throw error;
  }
  if (!isWrapped(text)) return undefined;
  try {
    return parseWrapped(text);
  } catch {
    throw new KeyFileRefused("format");
  }
}

// One write of the restricted file at a time, under the same lock file an add takes.
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  try {
    await writeNew(lock, "");
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new KeyFileRefused("locked");
    if (errorCode(error) === "ENOENT") throw new KeyFileRefused("missing");
    throw error;
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

// Writes `contents` over the file at `path` by a synced rename, keeping its mode and group, or
// as a new file only its owner may read when there is none.
async function replace(path: string, contents: string, kept?: Kept): Promise<void> {
  if (kept === undefined) return writeNew(path, contents);
  const next = `${path}.${randomHex(8)}.tmp`;
  try {
    await writeNew(next, contents, kept);
    await rename(next, path);
  } catch (error) {
    await rm(next, { force: true });
    throw error;
  }
}

// The restricted file wrapped (restricted-lock.ts): the keys of a plain file there, and a new key
// for each of `compartments` it lacks, sealed under a new file key, which the recovery secret this
// returns opens. The plain file is replaced whole, so no restricted key is left on disk in the
// clear. A file already wrapped is `exists`.
export async function wrapRestrictedFile(path: string, compartments: readonly string[]): Promise<string> {
  if (!compartments.every(isRestricted)) throw new KeyFileRefused("format");
  return withLock(path, async () => {
    if ((await wrappedAt(path)) !== undefined) throw new KeyFileRefused("exists");
    const found = await existing(path, "restricted");
    const keys = new Map(Object.entries(found?.file.compartments ?? {}));
    for (const compartment of compartments) if (!keys.has(compartment)) keys.set(compartment, newKey());
    const { file, recovery } = wrapKeys(keys);
    await replace(path, wrappedText(file), found?.kept);
    return recovery;
  });
}

// A wrapped file rewritten whole, as a PRF slot's add rewrites it.
export async function saveWrapped(path: string, file: Wrapped): Promise<void> {
  await withLock(path, async () => {
    const { kept } = await readText(path, "restricted");
    await replace(path, wrappedText(file), kept);
  });
}
