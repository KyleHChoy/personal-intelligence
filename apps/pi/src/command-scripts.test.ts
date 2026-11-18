import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, SCRIPT_READS } from "./commands.ts";

// The box's scripts run `pi` through their wrappers. A script that captures a command's output reads
// that command's exact words, so each such command says so in its table row.

const deploy = join(repoRoot(), "deploy");
const scripts = ["lib", "bin"].flatMap((folder) =>
  readdirSync(join(deploy, folder))
    .filter((name) => !name.endsWith(".sql"))
    .map((name) => ({ name, text: readFileSync(join(deploy, folder, name), "utf8") })),
);
const code = (text: string): string[] => text.split("\n").filter((line) => !/^\s*#/.test(line));

// A wrapper and what follows it: `pi-admin clients list`, `as-pi admin keys agent-journal`,
// `"$admin" admin clients list`, `lib/pi/run model-key models import-key`, `bin/pi db verifier`.
const WRAPPER =
  /(?:\/pi-(?:admin|sync|extract|work)|as-pi [a-z-]+|"\$admin" admin|lib\/pi\/run [a-z-]+|\/usr\/local\/bin\/pi) ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/g;
const longest = [...COMMAND_NAMES].sort((a, b) => b.length - a.length);
const commandOf = (words: string): string | undefined =>
  longest.find((name) => words === name || words.startsWith(`${name} `));

// Each `$( ... )` of a line, to its matching bracket.
function substitutions(line: string): string[] {
  const found: string[] = [];
  for (let start = line.indexOf("$("); start !== -1; start = line.indexOf("$(", start + 2)) {
    let depth = 0;
    let end = start + 1;
    for (; end < line.length; end++) {
      if (line[end] === "(") depth++;
      else if (line[end] === ")" && --depth === 0) break;
    }
    found.push(line.slice(start, end));
  }
  return found;
}

// Each command a script's line captures the output of, or hands on: `$( ... )`, canary-run's `step`,
// agent-keys' `made`, whose one definition captures `"$@"`.
function captured(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (words: string, script: string) => {
    const name = commandOf(words);
    if (name !== undefined) found.set(name, [...(found.get(name) ?? []), script]);
  };
  for (const { name, text } of scripts)
    for (const line of code(text)) {
      for (const part of [...substitutions(line), ...(/^\s*step /.test(line) ? [line] : [])])
        for (const match of part.matchAll(WRAPPER)) add(match[1] as string, name);
      for (const match of line.matchAll(/\bmade (keys [a-z-]+)/g)) add(match[1] as string, name);
    }
  return found;
}

describe("the commands a script reads", () => {
  it("each command a script captures says so in its row", () => {
    const unsaid = [...captured()]
      .filter(([name]) => SCRIPT_READS[name] === undefined)
      .map(([name, by]) => `${name}: read by ${by.join(", ")}`);
    expect(unsaid).toEqual([]);
  });

  it("finds the captures it is meant to find, so a change in how scripts call pi cannot empty it", () => {
    const found = captured();
    for (const name of [
      "health dream-due",
      "health open",
      "status",
      "extract",
      "dream",
      "sync",
      "clients list",
      "keys agent-copy",
      "keys agent-journal",
      "models import-key",
      "db verifier",
      "canary plant",
    ])
      expect(found.has(name), name).toBe(true);
  });

  it("names only commands that exist, and each row names the script that reads it", () => {
    for (const [name, what] of Object.entries(SCRIPT_READS)) {
      expect(COMMAND_NAMES, name).toContain(name);
      expect(what, name).toMatch(/lib\/|pi-|the timer|the entrypoint/);
    }
  });
});
