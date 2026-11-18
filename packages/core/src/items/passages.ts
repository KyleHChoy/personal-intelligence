import type { Passage } from "./types.ts";

export const PASSAGE_CHARS = 4000;

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

// Where the next passage of [from, end) ends: the section's end when the rest fits; else after
// the last paragraph end that fits; else after the last white space; else at the bound, moved
// back one unit when the bound would split a surrogate pair.
function cutAt(text: string, from: number, end: number): number {
  if (end - from <= PASSAGE_CHARS) return end;
  const window = text.slice(from, from + PASSAGE_CHARS);
  const paragraph = window.lastIndexOf("\n");
  if (paragraph > 0) return from + paragraph + 1;
  const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  if (space > 0) return from + space + 1;
  const bound = from + PASSAGE_CHARS;
  return isHigh(text.charCodeAt(bound - 1)) ? bound - 1 : bound;
}

// Each section cut into passages that cover it with no gap and no overlap. Pure and
// deterministic: the same sections and text give the same passages.
export function documentPassages(sections: { heading: string; start: number; end: number }[], text: string): Passage[] {
  const passages: Passage[] = [];
  for (const [section, { heading, start, end }] of sections.entries()) {
    for (let from = start; from < end; ) {
      const to = cutAt(text, from, end);
      passages.push({ span: `chars:${from}-${to}`, section, heading });
      from = to;
    }
  }
  return passages;
}
