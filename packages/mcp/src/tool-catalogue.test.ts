import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAIM_REFUSAL_FIELDS,
  COMPACT_PATHS,
  FINGERPRINT_PATHS,
  isCompactReadTool,
  PersonalReadTool,
  PersonalTool,
  READ_BUDGET,
  TOOL_NAMES,
  ToolRefusalCode,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS } from "./deadlines.ts";
import { hintFor } from "./handle.ts";
import { clientView } from "./test-support/fakes.ts";
import { offered } from "./tools.ts";

// What each tool sends, as it stood when these tables became views of one catalogue: its place in
// tools/list, its deadline, its budget, and a digest of its description, schema, hints and
// compaction. A name, a view, a budget, a wire shape, a description or a refusal never moves by
// accident: a change to one is made here too, on purpose, with
// `PIN_TOOLS=1 pnpm exec vitest run packages/mcp/src/tool-catalogue.test.ts`. A tool added
// later is in no row, and a schema's list of tool names is read without it, so this file needs no
// edit for it.

const digest = (value: unknown, replacer?: (key: string, value: unknown) => unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value, replacer) ?? "null")
    .digest("hex")
    .slice(0, 16);

const everyTool = clientView({ tools: [...PersonalTool.options], views: ["self", "people", "work"] });
const namesWith = (views: string[]): string[] =>
  offered(clientView({ tools: [...PersonalTool.options], views })).map((tool) => tool.name);

function catalogue(pinned: readonly string[] = TOOL_NAMES) {
  const served = new Map(offered(everyTool).map((tool) => [tool.name, tool]));
  // append_step's schema lists the read tools.
  const withoutLater = (key: string, value: unknown): unknown =>
    key === "enum" && Array.isArray(value)
      ? value.filter((one) => pinned.includes(one) || !(TOOL_NAMES as readonly string[]).includes(one))
      : value;
  return {
    // The order is tools/list's; a client's views decide which of them it is offered.
    byViews: {
      none: namesWith([]),
      self: namesWith(["self"]),
      people: namesWith(["people"]),
      work: namesWith(["work"]),
    },
    tools: TOOL_NAMES.map((name) => {
      const tool = served.get(name);
      return {
        name,
        deadline: DEADLINE_MS[name],
        budget: PersonalReadTool.safeParse(name).success ? READ_BUDGET[name as PersonalReadTool] : null,
        compact: isCompactReadTool(name),
        wording: digest({ description: tool?.description, inputSchema: tool?.inputSchema }, withoutLater),
        hints: digest(ToolRefusalCode.options.map((code) => hintFor(name, code))),
        fields: digest(CLAIM_REFUSAL_FIELDS[name] ?? null),
        paths: digest({
          compact: (COMPACT_PATHS as Record<string, unknown>)[name] ?? null,
          fingerprints: Object.entries(FINGERPRINT_PATHS[name] ?? {}).sort(),
        }),
      };
    }),
  };
}

const PIN = join(import.meta.dirname, "tool-catalogue.pin.json");

describe("what each tool sends", () => {
  it("is what the pin holds", () => {
    if (process.env.PIN_TOOLS === "1") writeFileSync(PIN, `${JSON.stringify(catalogue(), null, 1)}\n`);
    const pinned = JSON.parse(readFileSync(PIN, "utf8")) as ReturnType<typeof catalogue>;
    const names: string[] = pinned.tools.map((tool) => tool.name);
    const now = catalogue(names);
    for (const row of pinned.tools) {
      expect(
        now.tools.find((tool) => tool.name === row.name),
        row.name,
      ).toEqual(row);
    }
    expect(now.tools.map((tool) => tool.name).filter((name) => names.includes(name))).toEqual(names);
    for (const [views, listed] of Object.entries(pinned.byViews)) {
      const kept = now.byViews[views as keyof typeof now.byViews].filter((name) => names.includes(name));
      expect(kept, views).toEqual(listed);
    }
  });
});
