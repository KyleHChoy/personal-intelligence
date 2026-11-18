// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { OpenBody, TypedRow } from "./parts.tsx";

// A long unbroken word never runs out of its panel. A row is one line: its title, its line beneath
// and its meta are cut with an ellipsis, never pushed wider. What a row opens to wraps anywhere on
// overflow. No layout runs here, so the test renders the real row and body with a 120-character word
// and holds each element that carries it to the stylesheet's rules.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORD = "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(3).slice(0, 120);
const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Each rule outside a media query: its selectors and its declarations.
const rules = [...css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (one) => ({ selectors: (one[1] ?? "").split(",").map((selector) => selector.trim()), body: one[2] ?? "" }),
);
const matching = (element: Element, declaration: RegExp): string[] =>
  rules
    .filter((rule) => declaration.test(rule.body))
    .flatMap((rule) => rule.selectors)
    .filter((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });

let root: Root;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("a 120-character unbroken word is cut on a row's line and wraps in what the row opens to", async () => {
  expect(WORD).toHaveLength(120);
  expect(WORD).not.toMatch(/\s|-/);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        "div",
        { className: "list" },
        createElement(TypedRow, { what: WORD, sub: WORD, meta: WORD, onOpen: () => {} }),
        createElement(
          "div",
          { className: "exp" },
          createElement(OpenBody, {
            lead: [WORD],
            blocks: [["Fix", createElement("div", { className: "txt" }, WORD)]],
          }),
        ),
      ),
    ),
  );
  for (const selector of [".what .t", ".what .s", ".meta"]) {
    const element = host.querySelector(selector);
    expect(element?.textContent, selector).toContain(WORD);
    expect(matching(element as Element, /text-overflow\s*:\s*ellipsis/), selector).not.toEqual([]);
    expect(matching(element as Element, /overflow\s*:\s*hidden/), selector).not.toEqual([]);
  }
  // The line's text gives way to its lead and meta, so the row never runs past the panel.
  expect(matching(host.querySelector(".what") as Element, /min-width\s*:\s*0/)).not.toEqual([]);
  for (const selector of [".lead", ".txt"]) {
    const element = host.querySelector(selector) as Element;
    expect(element.textContent, selector).toContain(WORD);
    expect(matching(element, /overflow-wrap\s*:\s*anywhere/), selector).not.toEqual([]);
    expect(matching(element, /white-space\s*:\s*nowrap/), selector).toEqual([]);
  }
});

it("every style an open body, a note, a toast and a command use wraps the same way", () => {
  const wraps = rules
    .filter((rule) => /overflow-wrap\s*:\s*anywhere/.test(rule.body))
    .flatMap((rule) => rule.selectors);
  for (const selector of [".exp", ".lead", ".lead2", ".txt", ".say", ".empty", ".note", ".toast span", ".cmdline"])
    expect(wraps, selector).toContain(selector);
});
