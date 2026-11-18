import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportMemoryArgs, type MemoryChange, type ReadOutcome } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "./memory-adapter.ts";
import type { AgentApiClient } from "./memory-api.ts";
import { type InboundFs, runInbound } from "./memory-inbound.ts";
import { fileState, type StateStore, statePath } from "./memory-state.ts";

// The adapter's inbound pass, over real files in a temporary folder and a fake host that keeps the
// request ids it has seen, as policy.import_memory does.

const dirs: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inbound-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = new Date("2026-10-05T12:00:00.000Z");
const failure = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

// A host that answers import_memory as the store does: the number of changes, whatever was
// kept; and that remembers what it was sent.
function host(options: { refuseAfter?: number } = {}): {
  api: AgentApiClient;
  batches: MemoryChange[][];
  seen: Set<string>;
  replayed: string[];
} {
  const batches: MemoryChange[][] = [];
  const seen = new Set<string>();
  const replayed: string[] = [];
  const api: AgentApiClient = {
    async call(name, args): Promise<ReadOutcome<unknown>> {
      if (name !== "import_memory") return { ok: false, code: "not_permitted" };
      const { changes } = ImportMemoryArgs.parse(args);
      if (options.refuseAfter !== undefined && batches.length >= options.refuseAfter)
        return { ok: false, code: "rate_limited" };
      batches.push(changes);
      for (const change of changes) {
        if (seen.has(change.requestId)) replayed.push(change.requestId);
        seen.add(change.requestId);
      }
      return { ok: true, value: { received: changes.length } };
    },
    tools: async () => ["sync_memory", "import_memory"],
    close: async () => {},
  };
  return { api, batches, seen, replayed };
}

type Setup = { home: string; memory: string; owned: string; state: string; store: StateStore };
function setup(): Setup {
  const home = folder();
  const memory = join(home, "memory");
  mkdirSync(memory, { mode: 0o700 });
  const state = statePath(home, "agent");
  return { home, memory, owned: join(home, "owned", "pi.md"), state, store: fileState(state) };
}
const run = (s: Setup, api: AgentApiClient, options: { dirs?: string[]; fs?: InboundFs; store?: StateStore } = {}) =>
  runInbound({
    dirs: options.dirs ?? [s.memory],
    owned: s.owned,
    store: options.store ?? s.store,
    api,
    now: NOW,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
const sent = (h: ReturnType<typeof host>): MemoryChange[] => h.batches.flat();

describe("the configuration's inbound directories", () => {
  const written = (value: unknown): { PI_ADAPTER_CONFIG: string } => {
    const path = join(folder(), "adapters.json");
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return { PI_ADAPTER_CONFIG: path };
  };
  const good = { preset: "plain", bridge: ["pi-mcp"], owned: "/srv/agent/memory.md" };

  it("a target with no inbound reads nothing", async () => {
    expect((await readConfig(written({ agent: good }), "/home/owner")).agent?.inbound).toEqual([]);
    const s = setup();
    writeFileSync(join(s.memory, "MEMORY.md"), "- an entry\n");
    const h = host();
    const calls: string[] = [];
    const fs: InboundFs = {
      readdir: ((path: string) => {
        calls.push(path);
        return nodeFs.readdir(path);
      }) as never,
      open: ((path: string, flags: number) => {
        calls.push(path);
        return nodeFs.open(path, flags);
      }) as never,
    };
    expect(await run(s, h.api, { dirs: [], fs })).toEqual({ added: 0, removed: 0, too_long: 0, skipped_files: 0 });
    expect(calls).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  it("an absolute directory and one under ~ are taken; a relative path, the owned file's folder and a directory others can write are refused", async () => {
    const home = folder();
    const memory = join(home, "memory");
    mkdirSync(memory, { mode: 0o700 });
    expect(
      (await readConfig(written({ agent: { ...good, inbound: [memory, "~/memory/", "~/later"] } }), home)).agent
        ?.inbound,
    ).toEqual([memory, join(home, "later")]);
    for (const [why, inbound] of [
      ["a relative path", ["memory"]],
      ["a path with a dot part", [`${memory}/../memory`]],
      ["the owned file's folder", ["/srv/agent"]],
      ["not a list", memory],
    ] as const) {
      expect(await failure(readConfig(written({ agent: { ...good, inbound } }), home)), why).toBe("config_refused");
    }
    const open = join(home, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect(await failure(readConfig(written({ agent: { ...good, inbound: [open] } }), home))).toBe("config_refused");
    const link = join(home, "link");
    symlinkSync(memory, link);
    expect(await failure(readConfig(written({ agent: { ...good, inbound: [link] } }), home))).toBe("config_refused");
    // The owned file's folder named through a link in a parent is still its folder.
    const parent = join(home, "parent-link");
    symlinkSync(home, parent);
    expect(
      await failure(
        readConfig(
          written({ agent: { ...good, owned: join(memory, "pi.md"), inbound: [join(parent, "memory")] } }),
          home,
        ),
      ),
    ).toBe("config_refused");
  });
});

describe("reading and the state file", () => {
  it("the adapter reads no file outside the listed directories, never a CLAUDE.md, follows no link, and its state file holds no 64-character hexadecimal string", async () => {
    const s = setup();
    const outside = join(s.home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "- outside the listed directory\n");
    writeFileSync(join(s.memory, "CLAUDE.md"), "- never read\n");
    writeFileSync(join(s.memory, "AGENTS.md"), "- never read either\n");
    writeFileSync(join(s.memory, "notes.txt"), "not markdown\n");
    symlinkSync(join(outside, "secret.md"), join(s.memory, "linked.md"));
    mkdirSync(join(s.memory, "nested"));
    writeFileSync(join(s.memory, "nested", "deep.md"), "- not directly inside\n");
    writeFileSync(
      join(s.memory, "MEMORY.md"),
      `# Index\n\n- The owner prefers ${"a".repeat(10)} mornings\n- Second entry\n`,
    );
    const opened: string[] = [];
    const listedDirs: string[] = [];
    const fs: InboundFs = {
      readdir: ((path: string) => {
        listedDirs.push(path);
        return nodeFs.readdir(path);
      }) as never,
      open: ((path: string, flags: number) => {
        opened.push(path);
        return nodeFs.open(path, flags);
      }) as never,
    };
    const h = host();
    expect(await run(s, h.api, { fs })).toEqual({ added: 2, removed: 0, too_long: 0, skipped_files: 1 });
    expect(listedDirs).toEqual([s.memory]);
    // The link is opened with O_NOFOLLOW, which refuses it, so it is skipped and never read.
    expect(opened.sort()).toEqual([join(s.memory, "MEMORY.md"), join(s.memory, "linked.md")]);
    expect(sent(h).map((change) => change.body)).toEqual([
      `- The owner prefers ${"a".repeat(10)} mornings`,
      "- Second entry",
    ]);
    const state = readFileSync(s.state, "utf8");
    expect(state).not.toMatch(/[0-9a-f]{64}/);
    expect(statSync(s.state).mode & 0o777).toBe(0o600);
    expect(state).not.toContain("outside the listed directory");
  });

  it("reordering entries sends nothing; editing one sends one removed and one added", async () => {
    const s = setup();
    const file = join(s.memory, "MEMORY.md");
    writeFileSync(file, "- one\n- two\n- three\n");
    const h = host();
    await run(s, h.api);
    const first = sent(h);
    writeFileSync(file, "- three\n- one\n- two\n");
    expect(await run(s, h.api)).toEqual({ added: 0, removed: 0, too_long: 0, skipped_files: 0 });
    writeFileSync(file, "- three\n- one, edited\n- two\n");
    expect(await run(s, h.api)).toEqual({ added: 1, removed: 1, too_long: 0, skipped_files: 0 });
    const [edit] = h.batches.slice(-1);
    const removed = edit?.find((change) => change.change === "removed");
    const added = edit?.find((change) => change.change === "added");
    expect(removed?.locator).toBe(first.find((change) => change.body === "- one")?.locator);
    expect(added?.body).toBe("- one, edited");
    expect(removed?.body).toBeUndefined();
  });

  it("removing an entry and adding it back gives a new request id and a higher generation", async () => {
    const s = setup();
    const file = join(s.memory, "MEMORY.md");
    writeFileSync(file, "- kept\n- comes back\n");
    const h = host();
    await run(s, h.api);
    const generationOf = (): number | undefined =>
      (
        JSON.parse(readFileSync(s.state, "utf8")) as {
          files: Record<string, { entries: { text: string; generation: number }[] }>;
        }
      ).files[file]?.entries.find((one) => one.text === "- comes back")?.generation;
    const before = generationOf();
    const firstAdd = sent(h).find((change) => change.body === "- comes back");
    writeFileSync(file, "- kept\n");
    await run(s, h.api);
    writeFileSync(file, "- kept\n- comes back\n");
    await run(s, h.api);
    const again = h.batches.at(-1)?.find((change) => change.body === "- comes back");
    expect(again?.requestId).not.toBe(firstAdd?.requestId);
    expect(again?.locator).not.toBe(firstAdd?.locator);
    expect(generationOf()).toBeGreaterThan(before as number);
    // A file emptied keeps its record, so the generation still rises after it.
    writeFileSync(file, "");
    await run(s, h.api);
    writeFileSync(file, "- comes back\n");
    await run(s, h.api);
    expect(generationOf()).toBeGreaterThan((before as number) + 1);
    // Every request id is 16 random bytes, and none is used twice.
    const ids = sent(h).map((change) => change.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("reordering the configuration keeps every locator", async () => {
    const s = setup();
    const second = join(s.home, "second");
    mkdirSync(second, { mode: 0o700 });
    writeFileSync(join(s.memory, "a.md"), "- in the first\n");
    writeFileSync(join(second, "b.md"), "- in the second\n");
    const h = host();
    await run(s, h.api, { dirs: [s.memory, second] });
    expect(await run(s, h.api, { dirs: [second, s.memory] })).toEqual({
      added: 0,
      removed: 0,
      too_long: 0,
      skipped_files: 0,
    });
    expect(
      sent(h)
        .map((change) => change.locator.replace(/#.*$/, ""))
        .sort(),
    ).toEqual([join(s.memory, "a.md"), join(second, "b.md")]);
  });

  it("an entry over 8 000 code points is counted too_long and not sent; a first run's entry time is the file's modification time", async () => {
    const s = setup();
    const file = join(s.memory, "MEMORY.md");
    writeFileSync(file, `- short\n\n${"é".repeat(8001)}\n`);
    utimesSync(file, new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05Z"));
    const h = host();
    expect(await run(s, h.api)).toEqual({ added: 1, removed: 0, too_long: 1, skipped_files: 0 });
    expect(sent(h)).toEqual([
      {
        requestId: expect.any(String),
        locator: expect.stringMatching(new RegExp(`^${file}#`)),
        change: "added",
        entryTime: "2026-01-02T03:04:05.000Z",
        body: "- short",
      },
    ]);
    // A later entry is first seen now.
    writeFileSync(file, "- short\n- later\n");
    await run(s, h.api);
    expect(h.batches.at(-1)?.[0]?.entryTime).toBe(NOW.toISOString());
  });

  it("an entry holding a NUL is not sent, so no batch the host refuses is sent again forever", async () => {
    const s = setup();
    writeFileSync(join(s.memory, "MEMORY.md"), "- fine\n- bad\u0000byte\n");
    const h = host();
    expect(await run(s, h.api)).toEqual({ added: 1, removed: 0, too_long: 1, skipped_files: 0 });
    expect(await run(s, h.api)).toEqual({ added: 0, removed: 0, too_long: 1, skipped_files: 0 });
  });

  it("a file over 64 KiB is skipped and its entries are kept as they were; a file that is gone has every entry removed", async () => {
    const s = setup();
    const big = join(s.memory, "big.md");
    const gone = join(s.memory, "gone.md");
    writeFileSync(big, "- big one\n");
    writeFileSync(gone, "- gone one\n- gone two\n");
    const h = host();
    await run(s, h.api);
    writeFileSync(big, `- big one\n${"x".repeat(64 * 1024)}\n`);
    rmSync(gone);
    expect(await run(s, h.api)).toEqual({ added: 0, removed: 2, too_long: 0, skipped_files: 1 });
  });
});

describe("the run", () => {
  it("batches of 50, and a run killed after a batch was answered and before the state was written sends the batch again and the host answers it replayed", async () => {
    const s = setup();
    writeFileSync(join(s.memory, "MEMORY.md"), Array.from({ length: 120 }, (_, n) => `- entry ${n}`).join("\n"));
    const h = host();
    // The state write after the second answer fails: the run dies there.
    let writes = 0;
    const dying: StateStore = {
      read: () => s.store.read(),
      write: async (state) => {
        writes += 1;
        if (writes === 4) throw Object.assign(new Error("killed"), { code: "killed" });
        await s.store.write(state);
      },
    };
    expect(await failure(run(s, h.api, { store: dying }))).toBe("killed");
    expect(h.batches.map((batch) => batch.length)).toEqual([50, 50]);
    const second = h.batches[1]?.map((change) => change.requestId);
    expect(await run(s, h.api)).toEqual({ added: 70, removed: 0, too_long: 0, skipped_files: 0 });
    expect(h.batches[2]?.map((change) => change.requestId)).toEqual(second);
    expect(h.replayed).toEqual(second);
    expect(h.batches.map((batch) => batch.length)).toEqual([50, 50, 50, 20]);
    // And then nothing is left to send.
    expect(await run(s, h.api)).toEqual({ added: 0, removed: 0, too_long: 0, skipped_files: 0 });
  });

  it("a refusal from the host ends the run with its code and leaves the state's copy as it was", async () => {
    const s = setup();
    writeFileSync(join(s.memory, "MEMORY.md"), "- one\n");
    expect(await failure(run(s, host({ refuseAfter: 0 }).api))).toBe("rate_limited");
    const h = host();
    expect(await run(s, h.api)).toEqual({ added: 1, removed: 0, too_long: 0, skipped_files: 0 });
  });

  it("no output line holds an entry's text", async () => {
    const s = setup();
    writeFileSync(join(s.memory, "MEMORY.md"), "- canary-inbound-sentinel\n");
    const counts = await run(s, host().api);
    expect(JSON.stringify(counts)).not.toContain("canary-inbound-sentinel");
  });
});
