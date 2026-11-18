import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";

// The owner's deploy/owner/pi-restore-test, sourced so it runs nothing, with its decision
// asked of each line `pia restore check` can print: the script exits with what it echoes. Only a
// whole, current copy is 0, and a dump older than the schema has its own code, so neither the owner
// nor a schedule reads a failed or skipped drill as a pass.

const SCRIPT = join(repoRoot(), "deploy/owner/pi-restore-test");

const status = (line: string): string => {
  const run = spawnSync("bash", ["-c", 'source "$1" && restore_status "$2"', "test", SCRIPT, line], {
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  return run.stdout.trim();
};

const lineOf = (code: string): string =>
  JSON.stringify({ code, before: "behind", after: "level", applied: 1, survivors: 0, messages: 4 });

describe("pi-restore-test's exit status", () => {
  it("is 0 only for a whole, current copy", () => {
    expect(status(lineOf("ok"))).toBe("0");
  });

  it("is 3 for a dump older than the newest migration, which tested nothing", () => {
    expect(status(lineOf("schema_behind"))).toBe("3");
  });

  it("is 2 for every failed check, and for no line at all", () => {
    for (const code of ["empty", "keys_failed", "still_behind", "erased_came_back", "failed"])
      expect(status(lineOf(code)), code).toBe("2");
    expect(status("")).toBe("2");
    expect(status("restore_warned")).toBe("2");
  });

  it("sourced, runs nothing of the drill", () => {
    const run = spawnSync("bash", ["-c", 'source "$1" && echo sourced', "test", SCRIPT], { encoding: "utf8" });
    expect(run.stdout).toBe("sourced\n");
  });
});
