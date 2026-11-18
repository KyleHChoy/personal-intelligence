// An unknown command, and --help.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { COMMAND_ARGS, COMMAND_NAMES } from "./commands.ts";
import { ADMIN, type Env, expectRefused, KEYS, MAIN, pi, WRITER } from "./test-support/commands-fixtures.ts";

describe("pi", () => {
  it("an unknown command exits 2", async () => {
    const unknown: string[][] = [
      [],
      ["frobnicate"],
      ["clients"],
      ["clients", "frobnicate"],
      ["keys", "list"],
      ["help"],
      ["sync", "--help"],
      ["--help", "sync"],
      ["clients list"],
    ];
    for (const argv of unknown) await expectRefused(argv, {}, "usage", 2);
    // An option the command does not take, and an argument too many or too few.
    await expectRefused(["status", "--bogus"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["status", "extra"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["clients", "revoke"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["sync", "--reset"], { ...WRITER, ...KEYS }, "usage", 2);
    for (const days of ["0", "91", "1.5", "x"])
      await expectRefused(["outcomes", "--days", days], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["outcomes", "extra"], { ...ADMIN, ...KEYS }, "usage", 2);
    for (const days of ["0", "91", "x"])
      await expectRefused(["loops", "--days", days], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["loops"], { ...WRITER, ...KEYS }, "wrong_role_url");
    // A relation kind and a limit from 1 to 100, before any connection.
    for (const args of [["--limit", "0"], ["--limit", "101"], ["--limit", "x"], ["--kind", "nonsense"], ["extra"]])
      await expectRefused(["dream", "findings", ...args], { ...ADMIN, ...KEYS }, "usage", 2);
    // weeks from 1 to 26, and only pi_admin is served them.
    for (const weeks of ["0", "27", "1.5", "x"])
      await expectRefused(["agents", "record", "--weeks", weeks], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["agents", "record", "extra"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["agents", "record"], { ...WRITER, ...KEYS }, "wrong_role_url");
    for (const red of ["-1", "x", "1.5", "Ignore"])
      await expectRefused(["improvements", "nightly", "--red", red], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["improvements", "nightly"], { ...ADMIN, ...KEYS }, "usage", 2);
    // The role defects go to: one role in its form, or --none, never both and never neither.
    for (const args of [[], ["Not A Role"], ["builder", "--none"], ["builder", "second"]])
      await expectRefused(["improvements", "default-role", ...args], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["improvements", "--owners", "extra"], { ...ADMIN, ...KEYS }, "usage", 2);
    // Only pi_admin is served these numbers.
    await expectRefused(["outcomes"], { ...WRITER, ...KEYS }, "wrong_role_url");
  });

  it("--help lists every command and exits 0", async () => {
    const result = await pi(["--help"], {});
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n");
    for (const name of COMMAND_NAMES) {
      const line = `pi ${name} ${COMMAND_ARGS[name]}`.trimEnd();
      expect(
        lines.filter((one) => one === line),
        line,
      ).toHaveLength(1);
    }
    expect(lines.filter((one) => one === "pi --help")).toHaveLength(1);
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  it("--help loads neither the store nor the database driver", async () => {
    // Two real node processes, each loading pi: slow on a busy machine, so not the 5 s default.
    // The real process, with a hook registered before main.ts that keeps the modules it
    // resolves among pi's own shell, the personal packages and the driver, and writes the list
    // to a file as it exits: on a long checkout path the list is longer than one write to a pipe
    // carries whole (64 KiB).
    const folder = await mkdtemp(join(tmpdir(), "pi-help-test-"));
    const trace = (file: string): string =>
      `data:text/javascript,${encodeURIComponent(`
      import { writeFileSync } from "node:fs";
      import { registerHooks } from "node:module";
      const seen = new Set();
      const kept = /\\/commands\\.ts$|\\/packages\\/(?=(?:beliefs|core|extract|google|ladder|mcp|models|store)\\/)|node_modules\\/pg\\//;
      registerHooks({ resolve(specifier, context, next) { const found = next(specifier, context); if (kept.test(found.url)) seen.add(found.url); return found; } });
      process.on("exit", () => writeFileSync(${JSON.stringify(file)}, JSON.stringify([...seen])));
    `)}`;
    let runs = 0;
    const loaded = async (argv: string[], env: Env): Promise<{ stdout: string; modules: string[] }> => {
      const file = join(folder, `trace-${(runs += 1)}.json`);
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", trace(file), MAIN, ...argv], {
        env: { PATH: process.env.PATH ?? "", ...env },
      });
      return { stdout, modules: JSON.parse(await readFile(file, "utf8")) as string[] };
    };
    const heavy = (modules: string[]): string[] =>
      modules.filter((url) =>
        /\/packages\/(?=(?:beliefs|core|extract|google|ladder|mcp|models|store)\/)|node_modules\/pg\//.test(url),
      );

    try {
      const help = await loaded(["--help"], {});
      expect(help.stdout).toContain("pi keys init");
      expect(help.modules.some((url) => url.endsWith("/commands.ts"))).toBe(true);
      expect(heavy(help.modules)).toEqual([]);

      // The positive control: a command that uses the store loads it, and the driver with it.
      const init = await loaded(["keys", "init"], { PI_KEY_FILE: join(folder, "keys.json") });
      expect(heavy(init.modules).some((url) => url.includes("packages/store/"))).toBe(true);
      expect(heavy(init.modules).some((url) => url.includes("node_modules/pg/"))).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
});
