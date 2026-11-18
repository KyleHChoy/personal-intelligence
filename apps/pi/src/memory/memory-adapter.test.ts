import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  type MemoryCorrection,
  MemoryEntry,
  type MemoryProjection,
  type ReadOutcome,
} from "@intelligence/contracts/personal";
import { renderBlock } from "@intelligence/personal-core/views";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, runAdapter } from "./memory-adapter.ts";
import type { AgentApiClient } from "./memory-api.ts";
import { startAgentApi } from "./memory-api.ts";
import { type MemoryTarget, markdownFiles } from "./memory-files.ts";

// One run of the adapter, and its configuration file, parsed strictly. Of the two presets only
// `plain` is built, as a path the owner gives; `claude_code` waits for live checks on the real
// product.

const dirs: string[] = [];
const ownedPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-adapter-"));
  dirs.push(dir);
  return join(dir, "memory.md");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pid = (n: number): string => `mpr_${n.toString(16).padStart(40, "0")}`;
const ENTITY = "ent_01J0000000000000000000000A";
const entry = (n: number, due = "2026-10-09"): MemoryEntry =>
  MemoryEntry.parse({
    kind: "commitment",
    section: "commitments",
    stamp: { projection: pid(n), fact: "b".repeat(64), state: "c".repeat(64) },
    status: "active",
    direction: "owed_by_owner",
    counterparty: ENTITY,
    due,
  });

// A host that answers each sync from the state it is in, as serve_memory does: remove is what
// `have` holds that is not current, and inStep is true when `have` is exactly the current ids.
function host(states: { entries: MemoryEntry[]; corrections?: MemoryCorrection[] }[]): {
  api: AgentApiClient;
  haves: string[][];
} {
  const haves: string[][] = [];
  let calls = 0;
  const api: AgentApiClient = {
    async call(name, args): Promise<ReadOutcome<unknown>> {
      if (name !== "sync_memory") return { ok: false, code: "not_permitted" };
      const { have } = args as { have: string[]; canDelete: boolean };
      haves.push(have);
      const state = states[Math.min(calls, states.length - 1)] ?? { entries: [] };
      calls += 1;
      const ids = state.entries.map((one) => one.stamp.projection as string);
      const value: MemoryProjection = {
        template: "active_memory@1",
        asOf: "2026-10-04T12:00:00Z",
        entries: state.entries,
        corrections: state.corrections ?? [],
        remove: have.filter((id) => !ids.includes(id)) as MemoryProjection["remove"],
        truncated: false,
        inStep: have.length === ids.length && ids.every((id) => have.includes(id)),
        hash: "e".repeat(64),
      };
      return { ok: true, value };
    },
    tools: async () => ["sync_memory"],
    close: async () => {},
  };
  return { api, haves };
}

const failure = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("one run of the adapter", () => {
  it("two runs over the same projection leave the same bytes and the second writes nothing", async () => {
    const owned = ownedPath();
    const target = markdownFiles({ owned });
    const { api } = host([{ entries: [entry(1), entry(2)] }]);
    const first = await runAdapter({ target, api });
    const bytes = readFileSync(owned);
    const second = await runAdapter({ target, api });
    expect(readFileSync(owned)).toEqual(bytes);
    expect(first).toEqual({ entries: 2, corrections: 0, removed: 0, written: 1, syncs: 2 });
    expect(second).toEqual({ entries: 2, corrections: 0, removed: 0, written: 0, syncs: 1 });
  });

  it("the confirming call carries what the file holds after the write", async () => {
    const owned = ownedPath();
    const changed: MemoryCorrection = {
      projection: pid(1) as MemoryCorrection["projection"],
      endedAt: "2026-10-04T11:00:00Z",
      reason: "changed",
      current: pid(3) as MemoryCorrection["projection"],
    };
    const { api, haves } = host([{ entries: [entry(1), entry(2)] }]);
    await runAdapter({ target: markdownFiles({ owned }), api });
    const later = host([{ entries: [entry(3, "2026-10-12"), entry(2)], corrections: [changed] }]);
    const counts = await runAdapter({ target: markdownFiles({ owned }), api: later.api });
    expect(haves).toEqual([[], [pid(1), pid(2)]]);
    expect(later.haves).toEqual([
      [pid(1), pid(2)],
      [pid(3), pid(2)],
    ]);
    expect(counts).toEqual({ entries: 2, corrections: 1, removed: 1, written: 1, syncs: 2 });
    expect(readFileSync(owned, "utf8")).not.toContain(`[pi:${pid(1)} `);
    expect(readFileSync(owned, "utf8")).toContain(`the entry stamped pi:${pid(1)} no longer holds`);
  });

  it("a projection that changed between the two calls is written once more, and a third difference ends the run with not_in_step", async () => {
    const owned = ownedPath();
    const twice = host([{ entries: [entry(1)] }, { entries: [entry(2)] }, { entries: [entry(2)] }]);
    expect(await runAdapter({ target: markdownFiles({ owned }), api: twice.api })).toEqual({
      entries: 1,
      corrections: 0,
      removed: 1,
      written: 1,
      syncs: 3,
    });
    expect(readFileSync(owned, "utf8")).toBe(
      renderBlock(
        (
          (await twice.api.call("sync_memory", { have: [pid(2)], canDelete: true })) as {
            ok: true;
            value: MemoryProjection;
          }
        ).value,
      ),
    );
    const restless = host([{ entries: [entry(1)] }, { entries: [entry(2)] }, { entries: [entry(3)] }]);
    expect(await failure(runAdapter({ target: markdownFiles({ owned: ownedPath() }), api: restless.api }))).toBe(
      "not_in_step",
    );
    expect(restless.haves).toHaveLength(3);
  });

  it("a file that is not ours ends the run with not_ours and is left as it was", async () => {
    const owned = ownedPath();
    writeFileSync(owned, "# The owner's own notes\n");
    const { api, haves } = host([{ entries: [entry(1)] }]);
    expect(await failure(runAdapter({ target: markdownFiles({ owned }), api }))).toBe("not_ours");
    expect(readFileSync(owned, "utf8")).toBe("# The owner's own notes\n");
    expect(haves).toEqual([]);
  });

  it("a run killed after writeOwned and before the confirming call leaves a file the next run converges", async () => {
    const owned = ownedPath();
    const { api, haves } = host([{ entries: [entry(1), entry(2)] }]);
    let calls = 0;
    const dying: AgentApiClient = {
      ...api,
      call: (name, args) =>
        ++calls === 2
          ? Promise.reject(Object.assign(new Error("bridge_failed"), { code: "bridge_failed" }))
          : api.call(name, args),
    };
    expect(await failure(runAdapter({ target: markdownFiles({ owned }), api: dying }))).toBe("bridge_failed");
    const left = readFileSync(owned);
    expect(await runAdapter({ target: markdownFiles({ owned }), api })).toEqual({
      entries: 2,
      corrections: 0,
      removed: 0,
      written: 0,
      syncs: 1,
    });
    expect(readFileSync(owned)).toEqual(left);
    expect(haves.at(-1)).toEqual([pid(1), pid(2)]);
  });

  it("with no entry and no correction the file is written with two empty sections", async () => {
    const owned = ownedPath();
    const { api } = host([{ entries: [] }]);
    expect(await runAdapter({ target: markdownFiles({ owned }), api })).toEqual({
      entries: 0,
      corrections: 0,
      removed: 0,
      written: 1,
      syncs: 2,
    });
    expect(readFileSync(owned, "utf8").endsWith("## Current\n\n## Corrections\n")).toBe(true);
  });

  it("a refusal from the host ends the run with its code and writes nothing", async () => {
    const owned = ownedPath();
    const refusing: AgentApiClient = {
      call: async () => ({ ok: false, code: "not_permitted" }),
      tools: async () => [],
      close: async () => {},
    };
    expect(await failure(runAdapter({ target: markdownFiles({ owned }), api: refusing }))).toBe("not_permitted");
    expect(await markdownFiles({ owned }).readOwned()).toMatchObject({ exists: false });
    // A value that is not a projection is no answer either.
    const wrong: AgentApiClient = {
      call: async () => ({ ok: true, value: { entries: "all" } }),
      tools: async () => [],
      close: async () => {},
    };
    expect(await failure(runAdapter({ target: markdownFiles({ owned }), api: wrong }))).toBe("bridge_failed");
  });

  it("canDelete is the target's capability", async () => {
    const owned = ownedPath();
    const { api, haves } = host([{ entries: [entry(1)] }]);
    const args: unknown[] = [];
    const watching: AgentApiClient = {
      ...api,
      call: (name, value) => {
        args.push(value);
        return api.call(name, value);
      },
    };
    const files = markdownFiles({ owned });
    const cannotDelete: MemoryTarget = { ...files, capabilities: { write: true, delete: false } };
    await runAdapter({ target: cannotDelete, api: watching });
    expect(args).toEqual([
      { have: [], canDelete: false },
      { have: [pid(1)], canDelete: false },
    ]);
    expect(haves).toHaveLength(2);
  });

  it("no output line and no log event holds an entry's line or the file's bytes", async () => {
    const owned = ownedPath();
    const { api } = host([{ entries: [entry(1, "2031-07-19")] }]);
    const counts = await runAdapter({ target: markdownFiles({ owned }), api });
    const text = JSON.stringify(counts);
    for (const value of [pid(1), ENTITY, "2031-07-19", "Commitment", "b".repeat(16)]) expect(text).not.toContain(value);
    expect(Object.keys(counts).sort()).toEqual(["corrections", "entries", "removed", "syncs", "written"]);
  });

  it("a run through the real agent API, over a fake provider, writes the projection it answers", async () => {
    const owned = ownedPath();
    const projection = {
      template: "active_memory@1",
      asOf: null,
      entries: [entry(1)],
      corrections: [],
      remove: [],
      truncated: false,
      inStep: true,
      hash: "1".repeat(64),
    };
    const api = await startAgentApi([
      process.execPath,
      join(import.meta.dirname, "..", "test-support", "memory-api.fixture.ts"),
      JSON.stringify(projection),
    ]);
    try {
      expect(await runAdapter({ target: markdownFiles({ owned }), api })).toEqual({
        entries: 1,
        corrections: 0,
        removed: 0,
        written: 1,
        syncs: 2,
      });
    } finally {
      await api.close();
    }
    expect(readFileSync(owned, "utf8")).toBe(renderBlock(projection as MemoryProjection));
  });

  it("the modules the adapter loads import nothing of the store, the Google package or the shared crypto package", () => {
    // Every import of the three files and of the local files they reach.
    const imports = (file: string): string[] =>
      [...readFileSync(file, "utf8").matchAll(/^import[^"]*"([^"]+)";$/gm)].map((match) => match[1] ?? "");
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of imports(file)) {
        if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
        else packages.add(specifier);
      }
    };
    for (const file of ["memory-adapter.ts", "memory-files.ts", "memory-api.ts"]) walk(join(import.meta.dirname, file));
    // The inbound pass and its state file.
    expect([...seen].map((file) => relative(import.meta.dirname, file)).sort()).toEqual([
      "../env.ts",
      "../switches.ts",
      "memory-adapter.ts",
      "memory-api.ts",
      "memory-files.ts",
      "memory-inbound.ts",
      "memory-state.ts",
    ]);
    expect([...packages].sort()).toEqual([
      "@intelligence/contracts/personal",
      "@intelligence/personal-core",
      "@intelligence/personal-core/checks",
      "@intelligence/personal-core/views",
      "node:child_process",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
    ]);
    // And the one workspace package it loads besides the contracts reaches none of them either.
    const core = join(
      import.meta.dirname,
      "..",
      "..",
      "node_modules",
      "@intelligence",
      "personal-core",
      "package.json",
    );
    const { dependencies = {} } = JSON.parse(readFileSync(core, "utf8")) as { dependencies?: Record<string, string> };
    for (const forbidden of [
      "@intelligence/personal-store",
      "@intelligence/personal-google",
      "@intelligence/crypto",
      "@intelligence/db",
    ])
      expect(Object.keys(dependencies)).not.toContain(forbidden);
  });
});

describe("the adapter's configuration", () => {
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pi-adapter-config-"));
    dirs.push(dir);
    return dir;
  };
  const written = (value: unknown, mode = 0o600): { PI_ADAPTER_CONFIG: string } => {
    const path = join(folder(), "adapters.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    chmodSync(path, mode);
    return { PI_ADAPTER_CONFIG: path };
  };
  const BRIDGE = ["ssh", "-T", "pi-box", "/usr/local/bin/pi-mcp"];

  it("a plain target with a bridge and an absolute owned path is read, and ~ is the home folder", async () => {
    const config = await readConfig(
      written({
        agent: { preset: "plain", bridge: BRIDGE, owned: "/srv/agent/memory.md" },
        "second-1": { preset: "plain", bridge: ["/usr/local/bin/pi-mcp"], owned: "~/notes/pi.md" },
      }),
      "/home/owner",
    );
    expect(config).toEqual({
      agent: { preset: "plain", bridge: BRIDGE, owned: "/srv/agent/memory.md", inbound: [] },
      "second-1": { preset: "plain", bridge: ["/usr/local/bin/pi-mcp"], owned: "/home/owner/notes/pi.md", inbound: [] },
    });
  });

  it("without PI_ADAPTER_CONFIG the file is ~/.config/pi/adapters.json", async () => {
    const home = folder();
    expect(await failure(readConfig({}, home))).toBe("config_refused");
    const path = join(home, ".config", "pi");
    await import("node:fs/promises").then((fs) => fs.mkdir(path, { recursive: true }));
    writeFileSync(
      join(path, "adapters.json"),
      JSON.stringify({ agent: { preset: "plain", bridge: BRIDGE, owned: "/srv/agent/memory.md" } }),
      { mode: 0o600 },
    );
    expect(Object.keys(await readConfig({}, home))).toEqual(["agent"]);
  });

  it("a configuration with a token field, an unknown field, a relative path, a plain target without owned, or that others can write is refused with config_refused", async () => {
    const good = { preset: "plain", bridge: BRIDGE, owned: "/srv/agent/memory.md" };
    // The positive control.
    expect(Object.keys(await readConfig(written({ agent: good }), "/home/owner"))).toEqual(["agent"]);
    for (const [why, value, mode] of [
      ["a token field", { agent: { ...good, token: "pit_sentinel" } }, 0o600],
      ["an unknown field", { agent: { ...good, outbound: true } }, 0o600],
      ["an inbound that is not a list", { agent: { ...good, inbound: true } }, 0o600],
      ["an unknown field at the top", { agent: good, version: 1 }, 0o600],
      ["a token in the bridge", { agent: { ...good, bridge: ["pi-mcp", "--token=pit_sentinel"] } }, 0o600],
      [
        "a token after a space in the bridge",
        { agent: { ...good, bridge: ["curl", "-H", "Authorization: Bearer pit_sentinel"] } },
        0o600,
      ],
      [
        "a model key in the bridge",
        { agent: { ...good, bridge: ["ssh", "pi-box", "env PI_OPENROUTER_KEY=sk-or-sentinel pi-mcp"] } },
        0o600,
      ],
      ["a model key alone in the bridge", { agent: { ...good, bridge: ["pi-mcp", "sk-or-sentinel"] } }, 0o600],
      [
        "a URL with a password in the bridge",
        { agent: { ...good, bridge: ["psql", "postgres://owner:sentinel@host/db"] } },
        0o600,
      ],
      ["a relative path", { agent: { ...good, owned: "memory.md" } }, 0o600],
      ["a path relative to the home folder by another form", { agent: { ...good, owned: "~owner/memory.md" } }, 0o600],
      ["a plain target without owned", { agent: { preset: "plain", bridge: BRIDGE } }, 0o600],
      ["a preset that is not built", { agent: { preset: "claude_code", bridge: BRIDGE } }, 0o600],
      ["a preset that does not exist", { agent: { ...good, preset: "codex" } }, 0o600],
      ["an empty bridge", { agent: { ...good, bridge: [] } }, 0o600],
      ["a bridge that is not a list of strings", { agent: { ...good, bridge: "pi-mcp" } }, 0o600],
      ["a target name off the form", { Agent: good }, 0o600],
      ["a file that is not JSON", "{ agent: ", 0o600],
      ["a file that is a list", [good], 0o600],
      ["a file others can write", { agent: good }, 0o602],
      ["a file its group can write", { agent: good }, 0o620],
    ] as const) {
      expect(await failure(readConfig(written(value, mode), "/home/owner")), why).toBe("config_refused");
    }
    // A configuration path that is relative, or names nothing.
    expect(await failure(readConfig({ PI_ADAPTER_CONFIG: "adapters.json" }, "/home/owner"))).toBe("config_refused");
    expect(await failure(readConfig({ PI_ADAPTER_CONFIG: join(folder(), "absent.json") }, "/home/owner"))).toBe(
      "config_refused",
    );
  });

  it("a configuration path that is a named pipe is refused with config_refused, not waited on", async () => {
    const path = join(folder(), "adapters.json");
    execFileSync("mkfifo", ["-m", "600", path]);
    expect(await failure(readConfig({ PI_ADAPTER_CONFIG: path }, "/home/owner"))).toBe("config_refused");
  });
});
