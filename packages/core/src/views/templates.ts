// A reference document's placeholders, after the shared claim pipeline's rule: every `{{name:kind}}` in the
// text, in order. A name is 1 to 64 characters of letters (a combining mark included), digits, space, `_`, `.`
// and `-`, trimmed as that rule trims it, and one of white space alone is none; a kind is 1 to 32 lower-case
// letters and `_`. Found by code; nothing here reads what a placeholder means.

export const MAX_PLACEHOLDERS = 100;

const PLACEHOLDER = /\{\{([\p{L}\p{M}\p{Nd} _.-]{1,64}):([a-z_]{1,32})\}\}/gu;

export type Placeholder = { ordinal: number; name: string; kind: string };

// At most the first MAX_PLACEHOLDERS.
export function placeholdersOf(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (found.length === MAX_PLACEHOLDERS) break;
    const name = (match[1] as string).trim();
    if (name !== "") found.push({ ordinal: found.length, name, kind: match[2] as string });
  }
  return found;
}
