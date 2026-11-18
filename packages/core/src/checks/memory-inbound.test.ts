import { MemoryEntry } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { findAddresses } from "../addresses.ts";
import { entryLine, renderEntry } from "../views/memory.ts";
import { splitEntries } from "./memory-inbound.ts";

// The pure parts of memory coming back. Made-up values only.

const ENTITY = "ent_01J0000000000000000000000A";
const ENTRY = MemoryEntry.parse({
  kind: "commitment",
  section: "commitments",
  stamp: { projection: `mpr_${"1".repeat(40)}`, fact: "a".repeat(64), state: "b".repeat(64) },
  status: "active",
  direction: "owed_by_owner",
  counterparty: ENTITY,
  due: "2026-10-09",
});

describe("splitEntries", () => {
  it("a list item and its continuation are one entry; a heading is none", () => {
    const text = [
      "# Memory",
      "",
      "- The owner prefers mornings",
      "  for calls with vendors.",
      "  - a nested note stays with its item",
      "- Second item",
      "",
      "A paragraph of two",
      "lines.",
      "",
      "## Another heading",
      "1. A numbered item",
      "",
      "    an indented continuation after a blank line",
      "",
      "Last paragraph.",
    ].join("\n");
    expect(splitEntries(text)).toEqual([
      "- The owner prefers mornings\n  for calls with vendors.\n  - a nested note stays with its item",
      "- Second item",
      "A paragraph of two\nlines.",
      "1. A numbered item\n\n    an indented continuation after a blank line",
      "Last paragraph.",
    ]);
  });

  it("a fenced block is one entry with its blank lines, and carriage returns and trailing spaces are dropped", () => {
    expect(splitEntries("```\nline one\n\n# not a heading\n```\r\nafter   \r\n")).toEqual([
      "```\nline one\n\n# not a heading\n```\nafter",
    ]);
  });

  it("a text of headings and blank lines has no entry", () => {
    expect(splitEntries("# One\n\n## Two\n\n   \n")).toEqual([]);
    expect(splitEntries("")).toEqual([]);
  });
});

describe("entryLine", () => {
  it("a rendered entry and the same line without its stamp give one entryLine", () => {
    const rendered = renderEntry(ENTRY);
    const unstamped = rendered.replace(/ \[pi:[^\]]+\]$/, "");
    expect(unstamped).not.toBe(rendered);
    expect(entryLine(rendered)).toBe(entryLine(unstamped));
    expect(entryLine(`  ${unstamped.replace(/ /g, "  \t")}  `)).toBe(entryLine(unstamped));
    expect(entryLine("Café at noon")).toBe(entryLine("Café at noon"));
    // Its list marker is not part of the line, so a copy under another marker matches.
    expect(entryLine(unstamped.replace(/^- /, "* "))).toBe(entryLine(unstamped));
  });

  it("a different line gives a different entryLine, and a line of only a stamp gives the empty string", () => {
    const rendered = renderEntry(ENTRY);
    expect(entryLine(rendered.replace("2026-10-09", "2026-10-10"))).not.toBe(entryLine(rendered));
    expect(entryLine(`[pi:mpr_${"1".repeat(40)} f:${"a".repeat(16)} s:${"b".repeat(16)}]`)).toBe("");
  });
});

describe("findAddresses", () => {
  it("the tokenizer finds a plain address, ignores one inside a word, and accepts no Unicode local part", () => {
    expect(findAddresses("Write to Quentin.Ross@Example.ORG about it.")).toEqual(["quentin.ross@example.org"]);
    expect(findAddresses("<a+b@mail.example.com>, (c_d@example.net)")).toEqual([
      "a+b@mail.example.com",
      "c_d@example.net",
    ]);
    // Inside a word: a non-ASCII letter on either side is part of the word.
    expect(findAddresses("éanna@example.org")).toEqual([]);
    expect(findAddresses("anna@example.orgé")).toEqual([]);
    expect(findAddresses("jöe@example.org")).toEqual([]);
    // Not an address: no dot in the domain, a dot at an edge of the local part, two at signs.
    expect(findAddresses("root@localhost .x@example.org x.@example.org a@b@example.org")).toEqual([]);
    // An apostrophe is part of an address; a quoted address is given with and without its mark.
    expect(findAddresses("Ask o'brien@example.com, or 'kim@example.com'.")).toEqual([
      "o'brien@example.com",
      "'kim@example.com",
      "kim@example.com",
    ]);
    // Each once, in order of first appearance.
    expect(findAddresses("b@example.org a@example.org B@example.org")).toEqual(["b@example.org", "a@example.org"]);
  });
});
