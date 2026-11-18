import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isCoded } from "@intelligence/contracts/personal";
import { findStamps, OWNED_HEADER } from "@intelligence/personal-core/views";
import { refusal } from "../env.ts";

// The memory adapter's one kind of target: markdown files on disk. The adapter owns exactly one
// file, replaces it whole, and opens no other. Only the `plain` preset is built; `claude_code`
// waits for live checks on the real product (memory-adapter.ts, `AdapterConfigEntry`).

// Everything a product could differ in is behind this port.
export type MemoryTarget = {
  capabilities: { write: boolean; delete: boolean };
  // Whether the owned file exists, whether its first line is OWNED_HEADER, the projection ids
  // stamped in it (only when it is ours), and its bytes.
  readOwned(): Promise<{ exists: boolean; ours: boolean; have: string[]; bytes: Uint8Array }>;
  // Replaced whole, never appended to.
  writeOwned(text: string): Promise<void>;
  clearOwned(): Promise<void>;
};

// The calls the target makes, so a test can see every path it touches.
export type FileSystem = {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string, options: { mode: number; flag: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  unlink(path: string): Promise<void>;
};

export const missing = (error: unknown): boolean => isCoded(error, "ENOENT");

// A file of the adapter's own replaced whole: a temporary file of one fixed name beside it, so a
// run that died between the write and the rename leaves nothing the next run does not remove;
// made exclusively, so a link planted under its name is never followed; mode 0600; then renamed
// over it. Its folder is made 0700 when missing.
export async function replaceWhole(
  fs: Pick<FileSystem, "writeFile" | "rename" | "mkdir" | "unlink">,
  path: string,
  text: string,
): Promise<void> {
  const folder = dirname(path);
  const temporary = join(folder, `.${basename(path)}.tmp`);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.unlink(temporary).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, path);
}

export function markdownFiles({ owned, fs = nodeFs }: { owned: string; fs?: FileSystem }): MemoryTarget {
  const readOwned: MemoryTarget["readOwned"] = async () => {
    let stat: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
      stat = await fs.lstat(owned);
    } catch (error) {
      if (missing(error)) return { exists: false, ours: false, have: [], bytes: new Uint8Array() };
      throw error;
    }
    // A link, a folder or anything else that is not a plain file is never followed or read.
    if (stat.isSymbolicLink() || !stat.isFile())
      return { exists: true, ours: false, have: [], bytes: new Uint8Array() };
    const bytes = new Uint8Array(await fs.readFile(owned));
    const text = Buffer.from(bytes).toString("utf8");
    const ours = text.split("\n", 1)[0] === OWNED_HEADER;
    return { exists: true, ours, have: ours ? findStamps(text).map((stamp) => stamp.projection) : [], bytes };
  };

  const refuseTheirs = async (): Promise<boolean> => {
    const current = await readOwned();
    if (current.exists && !current.ours) throw refusal("not_ours");
    return current.exists;
  };

  return {
    capabilities: { write: true, delete: true },
    readOwned,
    async writeOwned(text) {
      await refuseTheirs();
      await replaceWhole(fs, owned, text);
    },
    async clearOwned() {
      if (await refuseTheirs()) await fs.unlink(owned);
    },
  };
}
