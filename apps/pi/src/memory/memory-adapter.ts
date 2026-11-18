import * as nodeFs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isCoded, MemoryProjection } from "@intelligence/contracts/personal";
import { renderBlock } from "@intelligence/personal-core/views";
import { type Env, refusal } from "../env.ts";
import { type AgentApiClient, startAgentApi } from "./memory-api.ts";
import { type MemoryTarget, markdownFiles } from "./memory-files.ts";
import { type InboundCounts, runInbound } from "./memory-inbound.ts";
import { fileState, statePath } from "./memory-state.ts";

// One run of the memory adapter: a fixed
// sequence with no model. There is no state file: `have` comes from the owned file itself, so a
// run killed after its write and before its confirming call leaves a file the next run starts
// from. What it returns is counts only, never an entry's line or the file's bytes.

export type AdapterCounts = { entries: number; corrections: number; removed: number; written: 0 | 1; syncs: number };

const sameBytes = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes).equals(Buffer.from(text, "utf8"));

export async function runAdapter({
  target,
  api,
}: {
  target: MemoryTarget;
  api: AgentApiClient;
}): Promise<AdapterCounts> {
  let syncs = 0;
  const sync = async (have: string[]): Promise<MemoryProjection> => {
    syncs += 1;
    const outcome = await api.call("sync_memory", { have, canDelete: target.capabilities.delete });
    if (!outcome.ok) throw refusal(outcome.code);
    const parsed = MemoryProjection.safeParse(outcome.value);
    if (!parsed.success) throw refusal("bridge_failed");
    return parsed.data;
  };

  let file = await target.readOwned();
  if (file.exists && !file.ours) throw refusal("not_ours");
  let projection = await sync(file.have);
  let written: 0 | 1 = 0;
  const removed = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = renderBlock(projection);
    if (sameBytes(file.bytes, text) && projection.inStep) break;
    if (!sameBytes(file.bytes, text)) {
      const kept = new Set(projection.entries.map((entry) => entry.stamp.projection as string));
      for (const id of file.have) if (!kept.has(id)) removed.add(id);
      await target.writeOwned(text);
      written = 1;
    }
    file = await target.readOwned();
    projection = await sync(file.have);
    if (projection.inStep) break;
    if (attempt === 1) throw refusal("not_in_step");
  }
  return {
    entries: projection.entries.length,
    corrections: projection.corrections.length,
    removed: removed.size,
    written,
    syncs,
  };
}

// The configuration: one file the owner writes by hand, `PI_ADAPTER_CONFIG` or
// `~/.config/pi/adapters.json`, read strictly. It holds no token. Of the presets only `plain` is built, a
// path the owner gives: `claude_code` waits for live checks on the real product, and is refused until
// then. `inbound`: the directories whose memory files the adapter reads and sends back, none by default.
export type AdapterConfigEntry = { preset: "plain"; bridge: string[]; owned: string; inbound: string[] };

const TARGET_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const FIELDS = new Set(["preset", "bridge", "owned", "inbound"]);

// A bridge argument that holds a token, a model key or a URL with a
// password, wherever in the argument it starts.
const BRIDGE_SECRETS = [/(^|[\s=:'"])(pit_|sk-or-)/, /:\/\/[^\s/@]*:[^\s@]*@/];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const refused = (): never => {
  throw refusal("config_refused");
};

export async function readConfig(env: Env, home: string = homedir()): Promise<Record<string, AdapterConfigEntry>> {
  const named = env.PI_ADAPTER_CONFIG ?? "";
  const path = named === "" ? join(home, ".config", "pi", "adapters.json") : named;
  if (!isAbsolute(path)) refused();
  // One handle, so the file checked is the file read. Opened without blocking, so a named pipe
  // is refused below rather than waited on.
  const file = await nodeFs.open(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK).catch(refused);
  let text: string;
  try {
    const stat = await file.stat();
    // A file its group or others can write could name another bridge or another path.
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > MAX_CONFIG_BYTES) refused();
    text = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused();
  }
  if (!isPlainObject(parsed)) refused();
  const config: Record<string, AdapterConfigEntry> = {};
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TARGET_NAME.test(name) || !isPlainObject(entry) || Object.keys(entry).some((field) => !FIELDS.has(field)))
      refused();
    const { preset, bridge, owned, inbound = [] } = entry as Record<string, unknown>;
    if (preset !== "plain") refused();
    // The bridge's arguments are run with no shell; none is a token.
    if (
      !Array.isArray(bridge) ||
      bridge.length === 0 ||
      !bridge.every(
        (one) =>
          typeof one === "string" &&
          one !== "" &&
          !one.includes("\0") &&
          !BRIDGE_SECRETS.some((pattern) => pattern.test(one)),
      )
    )
      refused();
    if (typeof owned !== "string" || owned.includes("\0")) refused();
    const expanded = expand(owned as string, home);
    if (!isAbsolute(expanded)) refused();
    config[name] = {
      preset: "plain",
      bridge: bridge as string[],
      owned: expanded,
      inbound: await inboundOf(inbound, expanded, home),
    };
  }
  return config;
}

const expand = (path: string, home: string): string => (path.startsWith("~/") ? join(home, path.slice(2)) : path);

// Each listed directory absolute after `~`, never the owned file's folder,
// compared by their real paths too, and, when it exists, a directory, not a link, that neither its
// group nor others can write. One that does not exist yet is read as empty.
async function inboundOf(value: unknown, owned: string, home: string): Promise<string[]> {
  if (!Array.isArray(value) || !value.every((one) => typeof one === "string" && one !== "" && !one.includes("\0")))
    refused();
  // Without a trailing slash, and in normal form: no `.` or `..` part names another directory.
  const dirs = [...new Set((value as string[]).map((one) => expand(one, home).replace(/\/+$/, "")))];
  // With none listed, no path is touched: a run of one target opens no other target's folder (M12).
  if (dirs.length === 0) return dirs;
  const real = (path: string): Promise<string> => nodeFs.realpath(path).catch(() => normalize(path));
  const ownedFolder = await real(dirname(owned));
  for (const dir of dirs) {
    if (!isAbsolute(dir) || normalize(dir) !== dir || dir === dirname(owned) || (await real(dir)) === ownedFolder)
      refused();
    const stat = await nodeFs.lstat(dir).catch((error: unknown) => {
      if (isCoded(error, "ENOENT")) return null;
      return refused();
    });
    if (stat !== null && (!stat.isDirectory() || (stat.mode & 0o022) !== 0)) refused();
  }
  return dirs;
}

// The commands: each reads its target from the configuration and opens no store. Their arguments
// were checked before they run.
type AdapterContext = { positionals: string[]; env: Env; io: { stdout: NodeJS.WritableStream } };

async function targetOf(context: AdapterContext): Promise<AdapterConfigEntry> {
  const config = await readConfig(context.env);
  const name = context.positionals[0] ?? "";
  const entry = Object.hasOwn(config, name) ? config[name] : undefined;
  if (entry === undefined) throw refusal("not_found");
  return entry;
}

// `pi adapter run TARGET`: one run, and one JSON line of counts. A target that lists inbound
// directories then sends the changes made to its memory files, and the
// line gains their counts under `inbound`.
export async function adapterRun(context: AdapterContext): Promise<0> {
  const entry = await targetOf(context);
  const target = markdownFiles({ owned: entry.owned });
  // A file that is not ours is refused before the bridge is started.
  const file = await target.readOwned();
  if (file.exists && !file.ours) throw refusal("not_ours");
  const api = await startAgentApi(entry.bridge);
  let counts: AdapterCounts & { inbound?: InboundCounts };
  try {
    counts = await runAdapter({ target, api });
    if (entry.inbound.length > 0) {
      const store = fileState(statePath(homedir(), context.positionals[0] ?? ""));
      counts = {
        ...counts,
        inbound: await runInbound({ dirs: entry.inbound, owned: entry.owned, store, api, now: new Date() }),
      };
    }
  } finally {
    await api.close();
  }
  context.io.stdout.write(`${JSON.stringify(counts)}\n`);
  return 0;
}

// `pi adapter check TARGET`: the owned file's header and whether the agent API offers
// sync_memory, printed as codes. It writes nothing.
export async function adapterCheck(context: AdapterContext): Promise<0 | 1> {
  const entry = await targetOf(context);
  const file = await markdownFiles({ owned: entry.owned }).readOwned();
  const owned = !file.exists ? "absent" : file.ours ? "ours" : "not_ours";
  const api = await startAgentApi(entry.bridge);
  let tools: string[];
  try {
    tools = await api.tools();
  } finally {
    await api.close();
  }
  const tool = tools.includes("sync_memory") ? "listed" : "missing";
  context.io.stdout.write(`${JSON.stringify({ owned, tool })}\n`);
  return owned !== "not_ours" && tool === "listed" ? 0 : 1;
}

// `pi adapter clear TARGET`: deletes the owned file when it is ours. It starts no bridge, so it
// works for a revoked client.
export async function adapterClear(context: AdapterContext): Promise<0> {
  const entry = await targetOf(context);
  await markdownFiles({ owned: entry.owned }).clearOwned();
  return 0;
}
