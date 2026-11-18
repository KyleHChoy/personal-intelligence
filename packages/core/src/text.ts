// The text toolkit the checks and normal forms read words through, so a change to what a word is
// (a new apostrophe, a new format character) is made once.

const FORMAT = /\p{Cf}/gu;
const APOSTROPHES = /[‘’ʼ′`]/gu;

// NFKC, format characters dropped, every apostrophe straight.
export const straightened = (text: string): string =>
  text.replace(FORMAT, "").normalize("NFKC").replace(APOSTROPHES, "'");

// A word: letters, marks and digits, joined inside by straight apostrophes, so "don't" is one word
// and "I'll" is never "ill". Global: read it with matchAll.
export const WORD = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu;

// A text's words as written (case kept) and lowered.
export type Word = { raw: string; word: string };
export const wordsOf = (text: string): Word[] =>
  [...straightened(text).matchAll(WORD)].map((match) => ({ raw: match[0], word: match[0].toLowerCase() }));

const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″"]);
const DASH = /^[\p{Pd}−]$/u;
const SPACE = /^\s$/u;
const plainChar = (char: string): string =>
  SINGLE_QUOTES.has(char) ? "'" : DOUBLE_QUOTES.has(char) ? '"' : DASH.test(char) ? "-" : SPACE.test(char) ? " " : char;

export function normalChars(chars: Iterable<string>): string {
  let out = "";
  for (const char of chars) {
    const written = plainChar(char);
    if (written === " " && out.endsWith(" ")) continue;
    out += written.toLowerCase();
  }
  return out;
}

// A code point that is a format character.
export const isFormat = (point: string): boolean => /^\p{Cf}$/u.test(point);

// A name as the store's name fingerprint folds it: NFKC, trimmed, single spaces, lower case.
export const foldName = (name: string): string => name.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase();
