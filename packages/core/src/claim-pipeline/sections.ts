import type { DocumentContent, ParsedSegment } from "@intelligence/contracts";
import { HEADING_MARK, TITLE_CHARS } from "./html.ts";

// What the document lane reads from a reference document's own content: its sections, a
// template's placeholders, and a title when the markup gives none. Nothing that gives the
// document authority is read here.

// `{{name:kind}}` in a template's section body. Neither part holds a brace, a colon or a line
// end, so each can match one way only.
const PLACEHOLDER = /\{\{([^{}:\n]{1,200}):([^{}:\n]{1,64})\}\}/g;

// What a list item or a block quote puts before its text: white space, quote marks, a bullet,
// or a number and its stop. One class, so it reads a prefix in one pass.
const BLOCK_MARKER = /^[\s>*\d.]*$/;

// Cuts the text of a document into sections: a line that holds the heading mark begins one, and
// whatever stands before the first heading is a section with no heading. The heading is what
// follows the mark. What stands before it on the line is the marker of the list item or block quote
// the heading sits in, and is dropped: a heading starts a section wherever it stands. A PDF has no
// marks, so it is one section. Returns the sections, the document's text with the marks gone (a
// section's heading, a blank line, its body, and a blank line between two sections), and one
// segment for each section over that text. The text is exactly what the segments' spans index. No
// segment has an author here.
export function readSections(
  marked: string,
  template: boolean,
): { content: DocumentContent; segments: ParsedSegment[]; text: string } {
  const pieces: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  for (const line of marked.split("\n")) {
    const at = line.indexOf(HEADING_MARK);
    // A mark with words before it is a mark the document's own text held: the line is text.
    if (at >= 0 && BLOCK_MARKER.test(line.slice(0, at)))
      pieces.push({ heading: line.slice(at).replaceAll(HEADING_MARK, "").trim(), lines: [] });
    else pieces[pieces.length - 1]?.lines.push(line.replaceAll(HEADING_MARK, ""));
  }
  const sections: DocumentContent["sections"] = [];
  const placeholders: DocumentContent["placeholders"] = [];
  const segments: ParsedSegment[] = [];
  const texts: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    const body = piece.lines.join("\n").trim();
    if (piece.heading === "" && body === "") continue;
    const text = piece.heading === "" ? body : body === "" ? piece.heading : `${piece.heading}\n\n${body}`;
    const start = length === 0 ? 0 : length + 2;
    length = start + text.length;
    sections.push({ ordinal: sections.length, heading: piece.heading, body });
    segments.push({ span: `chars:${start}-${length}`, quoted: false, text });
    texts.push(text);
    if (!template) continue;
    for (const found of body.matchAll(PLACEHOLDER)) {
      const [name, kind] = [(found[1] as string).trim(), (found[2] as string).trim()];
      if (name !== "" && kind !== "") placeholders.push({ ordinal: placeholders.length, name, kind });
    }
  }
  return { content: { sections, placeholders }, segments, text: texts.join("\n\n") };
}

// A document's title when its markup gives none: its first heading, or else its first line.
export function fallbackTitle(content: DocumentContent): string | undefined {
  const [first] = content.sections;
  if (first === undefined) return undefined;
  const line = first.heading !== "" ? first.heading : (first.body.split("\n")[0] ?? "");
  return line.trim().slice(0, TITLE_CHARS) || undefined;
}
