import { CREDENTIAL_SHAPED } from "@intelligence/contracts/personal";

// Each match of CREDENTIAL_SHAPED keeps its first group, the known prefix, and the rest is filled
// with `*` to its original length in code points, line breaks kept, so every offset and length, and
// the text's lines, stay exact. The formats are tried in order; a match that overlaps an earlier
// one is passed over. Pure: each call makes its own global copy of every pattern, so no pattern's
// state carries over.

// One masked value's place in the masked text, end exclusive: in code points, and in code units
// for a window counted in units (get_document's).
export type MaskedSpan = { start: number; end: number; startUnit: number; endUnit: number };

const pointsIn = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

// The masked text and the place of each value it masked, in order.
export function maskedSpans(text: string): { text: string; spans: MaskedSpan[] } {
  const found: Array<{ at: number; end: number; prefix: string; value: string }> = [];
  for (const { pattern } of CREDENTIAL_SHAPED) {
    for (const match of text.matchAll(
      new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
    )) {
      const at = match.index;
      const end = at + match[0].length;
      if (match[0].length === 0 || found.some((one) => at < one.end && one.at < end)) continue;
      found.push({ at, end, prefix: match[1] ?? "", value: match[0] });
    }
  }
  if (found.length === 0) return { text, spans: [] };
  found.sort((a, b) => a.at - b.at);
  let out = "";
  let from = 0;
  let point = 0;
  const spans: MaskedSpan[] = [];
  for (const one of found) {
    const before = text.slice(from, one.at);
    point += pointsIn(before);
    const length = pointsIn(one.value);
    out += before;
    const startUnit = out.length;
    // Line breaks are kept, so a masked block keeps the text's lines and the parse its segments.
    out +=
      one.prefix +
      Array.from(one.value.slice(one.prefix.length), (character) =>
        character === "\n" || character === "\r" ? character : "*",
      ).join("");
    spans.push({ start: point, end: point + length, startUnit, endUnit: out.length });
    point += length;
    from = one.end;
  }
  return { text: out + text.slice(from), spans };
}

export function maskCredentials(text: string): { text: string; masked: number } {
  const { text: masked, spans } = maskedSpans(text);
  return { text: masked, masked: spans.length };
}

// How many masked values overlap the window [start, end) of code points: a value cut by a
// window's edge counts in each window it reaches.
export const maskedIn = (spans: readonly MaskedSpan[], start: number, end: number): number =>
  spans.filter((span) => span.start < end && start < span.end).length;

// The same over a window of code units.
export const maskedInUnits = (spans: readonly MaskedSpan[], start: number, end: number): number =>
  spans.filter((span) => span.startUnit < end && start < span.endUnit).length;

// The count a result carries, absent when nothing it serves was masked.
export const maskedField = (masked: number): { masked?: number } => (masked > 0 ? { masked } : {});
