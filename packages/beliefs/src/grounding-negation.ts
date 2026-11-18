import { BARE_NEGATIONS, FILLERS, negates, STOPWORDS, type Token, tokensOf } from "./grounding.ts";

// Whether a phrase the exact match took stands only under a negation it does not open with: "take the
// offer" in "will not take the offer". The words are the passage's and the fact is the reverse.

const isNegation = (one: Token): boolean => negates([one]) || BARE_NEGATIONS.has(one.word);

// What ends the clause a negation is read in, so "it is not cheap, but I run the office" keeps its
// second half: one stop before white space or the end, a blank line, a semicolon, a colon or a contrast
// word. A comma does not ("will not, under any terms, take the offer"), nor a line break alone, since
// mail is hard-wrapped, nor an ellipsis, which carries the negation on.
const CLAUSE_BREAK =
  /(?<![.\u2026])[.!?](?=\s|$)|\n\s*\n|[;:]|\b(?:but|however|though|although)\b|\band (?=(?:i|we|he|she|they|you)\b)/giu;
// A contrast word set off by commas is an aside, and ends no clause: "will not, however, take it".
const ASIDE = /,\s*(?:however|though|although)\s*,/giu;
// What only looks like a negation, in any apostrophe: "can't wait to start", "don't worry", "no doubt".
const NOT_NEGATION =
  /\bno\s*[,!]|\bno (?:worries|problem|thanks|doubt|wonder)\b|\bnot only\b|\b(?:can['\u2019]?t|cannot) wait\b|\bdon['\u2019]?t worry\b/giu;

const clauseBefore = (text: string): string => {
  const plain = text.replace(ASIDE, ",");
  let from = 0;
  for (const found of plain.matchAll(CLAUSE_BREAK)) from = found.index + found[0].length;
  return plain.slice(from).replace(NOT_NEGATION, " ");
};

// Where the phrase's words stand in order as whole words, in any case or spacing, a hesitation
// between them skipped: the character each place starts at.
function placesOf(phrase: readonly Token[], segment: string): number[] {
  const have = tokensOf(segment);
  const places: number[] = [];
  have.forEach((start, at) => {
    let next = at;
    for (const word of phrase) {
      while (next < have.length && FILLERS.has((have[next] as Token).word)) next += 1;
      if ((have[next] as Token | undefined)?.word !== word.word) return;
      next += 1;
    }
    places.push(start.from);
  });
  return places;
}

// True when the phrase does not open with a negation of its own, and every place it stands in the
// segment has one before it in its clause. A place it stands free is what the source said there.
export function cutFromNegation(phrase: string, segment: string): boolean {
  const words = tokensOf(phrase).filter((one) => !FILLERS.has(one.word));
  const opening = words.find((one) => !STOPWORDS.has(one.word));
  if (opening === undefined || isNegation(opening)) return false;
  const places = placesOf(words, segment);
  return places.length > 0 && places.every((at) => tokensOf(clauseBefore(segment.slice(0, at))).some(isNegation));
}
