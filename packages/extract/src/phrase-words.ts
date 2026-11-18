// Compared in Unicode's default lower case, with every run of white space as one space. Extended by
// a commit.
export const GENERIC_TITLE_WORDS: readonly string[] = Object.freeze([
  "1:1",
  "all hands",
  "call",
  "catch up",
  "catch-up",
  "check-in",
  "chat",
  "coffee",
  "daily",
  "discussion",
  "follow up",
  "follow-up",
  "interview",
  "intro",
  "kickoff",
  "lunch",
  "meeting",
  "meetings",
  "monthly",
  "notes",
  "one on one",
  "planning",
  "project",
  "review",
  "standup",
  "stand-up",
  "sync",
  "team",
  "update",
  "weekly",
]);

export const folded = (text: string): string => text.toLowerCase().replace(/\s+/gu, " ");
export const GENERIC = new Set(GENERIC_TITLE_WORDS.map(folded));
const WORD = /[\p{L}\p{N}]/u;

// Whether `phrase` stands in `text` as a whole phrase: each end the text's end or a character
// that is neither a letter nor a digit.
export function wholePhrase(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    const before = [...text.slice(0, at)].at(-1);
    const after = [...text.slice(at + phrase.length)][0];
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) return true;
  }
  return false;
}
