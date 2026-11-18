// Covers commands.ts, the `pi` command line, through the commands of one area.
// pi adapter, the memory adapter's three commands.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type Env, expectRefused, KEYS, MAIN, PROXY, pi, READER } from "./test-support/commands-fixtures.ts";

describe("pi", () => {
  // The adapter's three commands. Each test that reaches a command's body starts the target's
  // bridge, a node process of its own: slow on a busy machine, so not the 5 s default.
  describe("pi adapter", { timeout: 30_000 }, () => {
    const FIXTURE = fileURLToPath(new URL("./test-support/memory-api.fixture.ts", import.meta.url));
    // A folder with a configuration of one target, `agent`, whose bridge is `bridge` (by default
    // a stand-in for pi-mcp that runs the real agent API over a fake provider), and its owned
    // file's path.
    async function adapterFolder(
      bridge: string[] = [process.execPath, FIXTURE],
    ): Promise<{ dir: string; owned: string; env: Env }> {
      const dir = await mkdtemp(join(tmpdir(), "pi-adapter-command-"));
      const owned = join(dir, "agent", "memory.md");
      const config = join(dir, "adapters.json");
      await writeFile(config, JSON.stringify({ agent: { preset: "plain", bridge, owned } }), { mode: 0o600 });
      return { dir, owned, env: { PI_ADAPTER_CONFIG: config } };
    }
    async function listing(dir: string): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const name of (await readdir(dir, { recursive: true })).sort()) {
        const path = join(dir, name);
        out[name] = (await stat(path)).isDirectory() ? "<folder>" : (await readFile(path)).toString("base64");
      }
      return out;
    }

    it("pi adapter run refuses to start with a database URL, with a key file path, with a client token and with either Google client secret in its environment, one case each, and runs with none", async () => {
      const { dir, owned, env } = await adapterFolder();
      try {
        for (const [why, extra] of [
          ["a database URL", READER],
          ["the proxy's database URL", PROXY],
          ["a key file path", KEYS],
          ["a client token", { PI_CLIENT_TOKEN: `pit_${"a".repeat(43)}` }],
          ["the Google client secret", { PI_GOOGLE_CLIENT_SECRET: "sentinel-secret" }],
          ["the sending Google client secret", { PI_SEND_GOOGLE_CLIENT_SECRET: "sentinel-secret" }],
        ] as const) {
          for (const command of ["run", "check", "clear"])
            await expectRefused(["adapter", command, "agent"], { ...env, ...extra }, "wrong_role_url");
          expect(await listing(dir), why).toEqual({ "adapters.json": expect.any(String) as string });
        }
        // The control: with none of them it runs, and prints one line of counts.
        const ran = await pi(["adapter", "run", "agent"], env);
        expect(ran).toEqual({
          exit: 0,
          stdout: `${JSON.stringify({ entries: 0, corrections: 0, removed: 0, written: 1, syncs: 2 })}\n`,
          stderr: "",
        });
        expect((await readFile(owned, "utf8")).endsWith("## Current\n\n## Corrections\n")).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("a target off the name form, or not one argument, is a usage error, and one the configuration lacks is not_found", async () => {
      const { dir, env } = await adapterFolder();
      try {
        for (const argv of [
          ["adapter", "run"],
          ["adapter", "run", "Agent"],
          ["adapter", "check", "agent", "other"],
          ["adapter", "clear", "-x"],
          ["adapter", "show", "agent"],
        ])
          await expectRefused(argv, env, "usage", 2);
        await expectRefused(["adapter", "run", "other"], env, "not_found");
        await expectRefused(
          ["adapter", "run", "agent"],
          { PI_ADAPTER_CONFIG: join(dir, "absent.json") },
          "config_refused",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("the modules pi adapter loads import nothing of the store, the Google package or the shared crypto package", async () => {
      // Five real node processes, each loading pi: seconds of work, so not the 5 s default.
      // The real process, with a hook registered before main.ts that keeps every module it
      // resolves, and writes the list to a file as it exits: the list is longer than one write
      // to a pipe carries whole (64 KiB).
      const traceTo = (file: string): string =>
        `data:text/javascript,${encodeURIComponent(`
        import { writeFileSync } from "node:fs";
        import { registerHooks } from "node:module";
        const seen = new Set();
        registerHooks({ resolve(specifier, context, next) { const found = next(specifier, context); seen.add(found.url); return found; } });
        process.on("exit", () => writeFileSync(${JSON.stringify(file)}, JSON.stringify([...seen])));
      `)}`;
      const { dir, env } = await adapterFolder();
      try {
        let runs = 0;
        // The modules a run loaded, and its stderr when it failed (only where `failing` says so).
        const run = async (
          argv: string[],
          extra: Env,
          failing = false,
        ): Promise<{ modules: string[]; stderr?: string }> => {
          const file = join(dir, `trace-${(runs += 1)}.json`);
          const stderr = await promisify(execFile)(process.execPath, ["--import", traceTo(file), MAIN, ...argv], {
            env: { PATH: process.env.PATH ?? "", ...extra },
          }).then(
            () => undefined,
            (error: { stderr: string }) => {
              if (!failing) throw error;
              return error.stderr;
            },
          );
          return {
            modules: JSON.parse(await readFile(file, "utf8")) as string[],
            ...(stderr === undefined ? {} : { stderr }),
          };
        };
        const loaded = async (argv: string[], extra: Env): Promise<string[]> => (await run(argv, extra)).modules;
        const forbidden = (modules: string[]): string[] =>
          modules.filter((url) =>
            /\/packages\/(?=(?:beliefs|core|extract|google|ladder|mcp|models|store)\/)(store|google)\/|\/packages\/crypto\/|node_modules\/pg\//.test(
              url,
            ),
          );
        for (const command of ["run", "check", "clear"]) {
          const modules = await loaded(["adapter", command, "agent"], env);
          expect(
            modules.some((url) => url.endsWith("/memory-adapter.ts")),
            command,
          ).toBe(true);
          expect(forbidden(modules), command).toEqual([]);
        }
        // A run that fails with an error of the file system, not a refusal of pi's own, loads
        // none of them either: an owned path under a file is ENOTDIR.
        const broken = join(dir, "broken.json");
        await writeFile(
          broken,
          JSON.stringify({
            agent: {
              preset: "plain",
              bridge: [process.execPath, FIXTURE],
              owned: join(dir, "adapters.json", "memory.md"),
            },
          }),
          { mode: 0o600 },
        );
        for (const command of ["run", "check", "clear"]) {
          const { modules, stderr } = await run(["adapter", command, "agent"], { PI_ADAPTER_CONFIG: broken }, true);
          // The bridge's folder is a file: a system error, by its errno.
          expect(stderr?.split("\n")[0], command).toBe(
            JSON.stringify({ event: "command_failed", code: "unavailable", reason: "enotdir" }),
          );
          expect(forbidden(modules), command).toEqual([]);
        }
        // The positive control: a command that opens the store loads it, and the driver with it.
        const init = await loaded(["keys", "init"], { PI_KEY_FILE: join(dir, "keys.json") });
        expect(forbidden(init).some((url) => url.includes("packages/store/"))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it("clear deletes the owned file and starts no child", async () => {
      // A bridge that leaves a mark when it is started.
      const mark = join(tmpdir(), `pi-adapter-mark-${process.pid}-${Date.now()}`);
      const { dir, owned, env } = await adapterFolder([
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "")`,
      ]);
      try {
        // Nothing to delete is no failure.
        expect(await pi(["adapter", "clear", "agent"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
        await mkdir(join(dir, "agent"));
        await writeFile(
          owned,
          "<!-- Written by the Personal Intelligence memory adapter, which replaces this file whole on each run. Do not edit it. -->\n",
        );
        expect(await pi(["adapter", "clear", "agent"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
        expect(await listing(dir)).toEqual({ "adapters.json": expect.any(String) as string, agent: "<folder>" });
        await expect(stat(mark)).rejects.toThrow();
        // A file that is not ours is refused and kept.
        await writeFile(owned, "# The owner's own notes\n");
        await expectRefused(["adapter", "clear", "agent"], env, "not_ours");
        expect(await readFile(owned, "utf8")).toBe("# The owner's own notes\n");
        // The control: the same bridge, started by check, leaves its mark.
        expect((await pi(["adapter", "check", "agent"], env)).exit).toBe(1);
        expect((await stat(mark)).isFile()).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(mark, { force: true });
      }
    });

    it("check writes nothing", async () => {
      const { dir, env } = await adapterFolder();
      try {
        const before = await listing(dir);
        expect(await pi(["adapter", "check", "agent"], env)).toEqual({
          exit: 0,
          stdout: `${JSON.stringify({ owned: "absent", tool: "listed" })}\n`,
          stderr: "",
        });
        expect(await listing(dir)).toEqual(before);
        // After a run, check finds the file ours, and still writes nothing.
        expect((await pi(["adapter", "run", "agent"], env)).exit).toBe(0);
        const written = await listing(dir);
        expect(await pi(["adapter", "check", "agent"], env)).toEqual({
          exit: 0,
          stdout: `${JSON.stringify({ owned: "ours", tool: "listed" })}\n`,
          stderr: "",
        });
        expect(await listing(dir)).toEqual(written);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
