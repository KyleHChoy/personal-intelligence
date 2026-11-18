import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_ARGS, COMMAND_NAMES } from "./commands.ts";

// The README's "Every command" table is the command registry, by family: a command added or
// removed fails here until the table is written again from what this prints.

function everyCommandTable(names: readonly string[]): string {
  const families = new Map<string, string[]>();
  for (const name of names) {
    const [family = "", ...rest] = name.split(" ");
    families.set(family, [...(families.get(family) ?? []), rest.join(" ")]);
  }
  const rows = [...families]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([family, subs]) =>
        `| \`pi ${family}\` | ${subs.map((sub) => (sub === "" ? "itself" : `\`${sub}\``)).join(", ")} |`,
    );
  return ["| Family | Commands |", "| --- | --- |", ...rows].join("\n");
}

// A command's arguments split at each `|` outside brackets: the forms a row may show alone.
function forms(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < args.length; at++) {
    const char = args[at];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (depth === 0 && args.startsWith(" | ", at)) {
      out.push(args.slice(from, at));
      from = at + 3;
    }
  }
  return [...out, args.slice(from)];
}

// Each `pi ...` the "Commands" table's first column names, by command, with the arguments shown.
function shownArgs(readme: string): Map<string, string[]> {
  const table = readme.slice(readme.indexOf("| Command | Role | Does |"), readme.indexOf("## Every command"));
  const names = [...COMMAND_NAMES].sort((a, b) => b.length - a.length);
  const shown = new Map<string, string[]>();
  for (const row of table.split("\n").filter((line) => line.startsWith("| "))) {
    const first = row.slice(2).split(" | ")[0] ?? "";
    for (const [, cell = ""] of first.matchAll(/`pi ([^`]*)`/g)) {
      const text = cell.replaceAll("\\|", "|");
      if (text === "--help") continue;
      const name = names.find((one) => text === one || text.startsWith(`${one} `)) ?? `unknown: ${text}`;
      shown.set(name, [...(shown.get(name) ?? []), text.slice(name.length).trim()]);
    }
  }
  return shown;
}

describe("the README's command list", () => {
  it("lists every registered command, by family, and no other", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(everyCommandTable(COMMAND_NAMES));
  });

  it("shows each command's arguments as the registry has them: the whole, or every form in a row of its own", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const wrong = [...shownArgs(readme)].flatMap(([name, shown]) => {
      const args = COMMAND_ARGS[name];
      if (args === undefined) return [name];
      const each = forms(args);
      const fits =
        shown.every((one) => one === args || each.includes(one)) &&
        (shown.includes(args) || each.every((one) => shown.includes(one)));
      return fits ? [] : [`pi ${name}: ${shown.join(" ; ")} (registry: ${args})`];
    });
    expect(wrong).toEqual([]);
    expect(shownArgs(readme).get("sync")).toContain("--records");
  });
});
