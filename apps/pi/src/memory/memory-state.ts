import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { refusal } from "../env.ts";
import { missing, replaceWhole } from "./memory-files.ts";

// The memory adapter's state file for memory coming back: `~/.config/pi/adapter-state/<target>.json`, mode
// 0600, holding for each file the last copy it sent of each entry's text with its entry id, request id and
// generation, and the batch it is sending. It holds no hash of any content. Its copies are of files already
// on that disk, under that user. Written whole, as the owned file is (replaceWhole).

export type StateEntry = { id: string; text: string; requestId: string; generation: number; firstSeen: string };
type FileState = { generation: number; entries: StateEntry[] };
// A change being sent: written before its call, so a run that dies before the state that
// follows its answer is written sends it again with the same request ids.
export type Pending = { file: string; change: "added" | "removed"; entry: StateEntry };
export type AdapterState = { files: Record<string, FileState>; pending: Pending[] };

export type StateStore = { read(): Promise<AdapterState>; write(state: AdapterState): Promise<void> };

export const statePath = (home: string, target: string): string =>
  join(home, ".config", "pi", "adapter-state", `${target}.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isEntry = (value: unknown): value is StateEntry =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.text === "string" &&
  typeof value.requestId === "string" &&
  Number.isSafeInteger(value.generation) &&
  typeof value.firstSeen === "string";
const isFile = (value: unknown): value is FileState =>
  isRecord(value) &&
  Number.isSafeInteger(value.generation) &&
  Array.isArray(value.entries) &&
  value.entries.every(isEntry);
const isPending = (value: unknown): value is Pending =>
  isRecord(value) &&
  typeof value.file === "string" &&
  (value.change === "added" || value.change === "removed") &&
  isEntry(value.entry);

// A state file that does not parse is refused, never replaced: replacing it would send every
// entry again as new.
export function fileState(
  path: string,
  fs: Pick<typeof nodeFs, "readFile" | "writeFile" | "rename" | "mkdir" | "unlink"> = nodeFs,
): StateStore {
  return {
    async read() {
      let text: string;
      try {
        text = await fs.readFile(path, "utf8");
      } catch (error) {
        if (missing(error)) return { files: {}, pending: [] };
        throw refusal("state_refused");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw refusal("state_refused");
      }
      if (
        !isRecord(parsed) ||
        !isRecord(parsed.files) ||
        !Object.values(parsed.files).every(isFile) ||
        !Array.isArray(parsed.pending) ||
        !parsed.pending.every(isPending)
      ) {
        throw refusal("state_refused");
      }
      return { files: parsed.files as Record<string, FileState>, pending: parsed.pending as Pending[] };
    },
    write: (state) => replaceWhole(fs, path, JSON.stringify(state)),
  };
}
