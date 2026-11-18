import { convert } from "html-to-text";
import { PipelineError } from "./errors.ts";
import type { Limits } from "./limits.ts";

// HTML to text, behind a pre-scan. The HTML parser under html-to-text keeps its open elements
// in a list it searches and shifts for every tag, so its work grows with the square of the
// nesting depth: a few hundred kilobytes of nested tags take seconds and a few megabytes take
// minutes. The pre-scan reads the HTML once, and anything over a bound is refused before the
// parser sees it.

const refuse = (): never => {
  throw new PipelineError("parse_failed");
};

// Elements that never hold others, and the elements an opening tag closes when one of them is
// the innermost open element. Both lists are the parser's own (htmlparser2).
const VOID = new Set(
  "area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr".split(
    " ",
  ),
);
const P = new Set(["p"]);
const FORM = new Set(["input", "option", "optgroup", "select", "button", "datalist", "textarea"]);
const CLOSES = new Map<string, Set<string>>([
  ["tr", new Set(["tr", "th", "td"])],
  ["th", new Set(["th"])],
  ["td", new Set(["thead", "th", "td"])],
  ["body", new Set(["head", "link", "script"])],
  ["li", new Set(["li"])],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["optgroup", "option"])],
  ["dd", new Set(["dd", "dt"])],
  ["dt", new Set(["dd", "dt"])],
  ["rt", new Set(["rt", "rp"])],
  ["rp", new Set(["rt", "rp"])],
  ["tbody", new Set(["thead", "tbody"])],
  ["tfoot", new Set(["thead", "tbody"])],
  ...["select", "input", "output", "button", "datalist", "textarea"].map((name): [string, Set<string>] => [name, FORM]),
  ...["p", "h1", "h2", "h3", "h4", "h5", "h6", "address", "article", "aside", "blockquote", "details", "div", "dl"].map(
    (name): [string, Set<string>] => [name, P],
  ),
  ...[
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "header",
    "hr",
    "main",
    "nav",
    "ol",
    "pre",
    "section",
    "table",
    "ul",
  ].map((name): [string, Set<string>] => [name, P]),
]);
// Elements whose content is text up to their own closing tag.
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp"]);

const isLetter = (character: string | undefined): boolean =>
  character !== undefined && character >= "a" && character <= "z";
const isSpace = (character: string | undefined): boolean =>
  character === " " || character === "\n" || character === "\t" || character === "\r" || character === "\f";

// Where the tag whose name ends at `from` ends: the index just past its ">", and whether it
// closed itself with "/>". A ">" inside a quoted attribute value does not end it. An unclosed
// tag runs to the end.
function tagEnd(html: string, from: number): { end: number; selfClosed: boolean } {
  // 0 before a name, 1 in a name, 2 after a name, 3 before a value, 4 in an unquoted value.
  let state = 0;
  let slash = false;
  for (let at = from; at < html.length; at += 1) {
    const character = html[at] as string;
    const afterSlash = slash;
    slash = false;
    if (state === 3 && (character === '"' || character === "'")) {
      const close = html.indexOf(character, at + 1);
      if (close < 0) break;
      at = close;
      state = 0;
    } else if (character === ">") {
      return { end: at + 1, selfClosed: afterSlash };
    } else if (state === 4) {
      if (isSpace(character)) state = 0;
    } else if (state === 3) {
      if (!isSpace(character)) state = 4;
    } else if (character === "=" && state !== 0) {
      state = 3;
    } else if (character === "/") {
      state = 0;
      slash = true;
    } else {
      state = isSpace(character) ? (state === 1 ? 2 : state) : 1;
    }
  }
  return { end: html.length, selfClosed: false };
}

// One pass over the HTML, following what the parser would hold open. Two bounds:
// - `htmlTags` counts every "<" that is followed by a letter, wherever it stands. No parser
//   can open more elements than that, so this bound holds even if the rest of this scan is
//   wrong about something.
// - `htmlDepth` is the deepest the open elements get, read the way the parser reads them.
function checkShape(source: string, limits: Limits): void {
  // Tag names ignore letter case. Only ASCII is lowered, so every index still matches the source.
  const html = source.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  let tags = 0;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) {
    if (isLetter(html[at + 1])) {
      tags += 1;
      if (tags > limits.htmlTags) refuse();
    }
  }

  const open: string[] = [];
  const counts = new Map<string, number>();
  const pop = (): void => {
    const name = open.pop() as string;
    counts.set(name, (counts.get(name) ?? 1) - 1);
  };
  const after = (text: string, from: number): number => {
    const found = html.indexOf(text, from);
    return found < 0 ? html.length : found + text.length;
  };

  let at = html.indexOf("<");
  while (at >= 0) {
    const next = html[at + 1];
    let resume = at + 1;
    if (next === "!" || next === "?") {
      // A comment, a CDATA section, or a declaration that runs to the next ">".
      if (html.startsWith("<!--", at)) resume = after("-->", at + 2);
      else if (source.startsWith("<![CDATA[", at)) resume = after("]]>", at + 9);
      else resume = after(">", at + 2);
    } else if (next === "/") {
      // A closing tag: its name runs to white space or ">", whatever it starts with.
      let start = at + 2;
      while (isSpace(html[start])) start += 1;
      let nameEnd = start;
      while (nameEnd < html.length && !isSpace(html[nameEnd]) && html[nameEnd] !== ">") nameEnd += 1;
      const name = html.slice(start, nameEnd);
      // It closes the nearest open element of its name, and all inside it.
      if ((counts.get(name) ?? 0) > 0) {
        while (open[open.length - 1] !== name) pop();
        pop();
      } else if (name === "p" && open.length >= limits.htmlDepth) {
        // A stray "</p>" opens a paragraph for a moment before it closes it.
        refuse();
      }
      resume = after(">", nameEnd);
    } else if (isLetter(next)) {
      let nameEnd = at + 1;
      while (nameEnd < html.length && !isSpace(html[nameEnd]) && html[nameEnd] !== "/" && html[nameEnd] !== ">")
        nameEnd += 1;
      const name = html.slice(at + 1, nameEnd);
      const closes = CLOSES.get(name);
      while (closes !== undefined && open.length > 0 && closes.has(open[open.length - 1] as string)) pop();
      if (!VOID.has(name)) {
        open.push(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (open.length > limits.htmlDepth) refuse();
      }
      const tag = tagEnd(html, nameEnd);
      resume = tag.end;
      // Raw text runs to the element's own closing tag: its name, then white space or ">".
      while (RAW_TEXT.has(name) && !tag.selfClosed && resume < html.length) {
        const close = html.indexOf(`</${name}`, resume);
        const follows = close < 0 ? undefined : html[close + name.length + 2];
        if (close >= 0 && (follows === ">" || isSpace(follows))) {
          resume = close;
          break;
        }
        resume = close < 0 ? html.length : close + 2;
      }
    }
    at = html.indexOf("<", resume);
  }
}

// html-to-text's own bounds, as a second line. They cut content off rather than refuse it, and
// they do not bound the parser, which is why the scan above comes first.
const bounds = (limits: Limits) => ({ maxInputLength: limits.htmlChars, maxDepth: limits.htmlDepth });
const SELECTORS = [
  { selector: "a", options: { ignoreHref: true } },
  { selector: "img", format: "skip" },
];

export function htmlToText(html: string, limits: Limits): string {
  if (html.length > limits.htmlChars) refuse();
  checkShape(html, limits);
  const text = convert(html, { wordwrap: false, limits: bounds(limits), selectors: SELECTORS });
  return text.length > limits.bodyChars ? refuse() : text;
}

// What stands before a heading's text in the text of an HTML document: the ASCII record
// separator, which no text needs. A document that holds one of its own only gives itself a heading.
export const HEADING_MARK = "\u001e";

// The most of a title that is kept.
export const TITLE_CHARS = 200;

// An HTML document as text, for the document lane: its title, and its body with each `h1` to
// `h6` on a line of its own, its text after the heading mark. A heading inside a list item or
// a block quote has that block's marker before the mark. The title is the first `<title>`
// inside `<head>` and no other: one in the body, or inside an image, is not a title. Nothing
// else is read from the markup: a `<meta>` that names a status or an owner is not looked at.
export function htmlDocumentToText(html: string, limits: Limits): { title: string; text: string } {
  if (html.length > limits.htmlChars) refuse();
  checkShape(html, limits);
  const text = convert(html, {
    wordwrap: false,
    limits: bounds(limits),
    formatters: {
      sectionHeading: (element, walk, builder) => {
        builder.openBlock({ leadingLineBreaks: 2 });
        builder.addInline(HEADING_MARK);
        walk(element.children, builder);
        builder.closeBlock({ trailingLineBreaks: 2 });
      },
    },
    // A `<title>` in the body, or inside an image, is neither the title nor a section's text.
    selectors: [
      ...SELECTORS,
      { selector: "title", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, format: "sectionHeading" })),
    ],
  });
  let titled = false;
  const title = convert(html, {
    wordwrap: false,
    limits: bounds(limits),
    baseElements: { selectors: ["head > title"], returnDomByDefault: false },
    formatters: {
      firstTitle: (element, walk, builder) => {
        if (titled) return;
        titled = true;
        walk(element.children, builder);
      },
    },
    selectors: [{ selector: "title", format: "firstTitle" }],
  });
  return text.length > limits.bodyChars ? refuse() : { title: title.trim().slice(0, TITLE_CHARS), text };
}
