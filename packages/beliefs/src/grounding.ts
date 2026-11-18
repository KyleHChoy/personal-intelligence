import { isPicture, isShaping } from "@intelligence/personal-core";
import { numerals, readings } from "./grounding-numbers.ts";
import type { Grounding } from "./ontology.ts";

// Text is matched in a normal form and stored as the passage's own slice; a number is matched
// against the readings of the passage's numerals. Pure functions: nothing here is model output but
// the value tested.

const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″"]);
const FORMAT = /^\p{Cf}$/u;
// A variation selector only picks how the character before it is drawn, so it is dropped as a
// format character is (core's isShaping, the joiner with it, which is Cf): a heart
// with its emoji selector and one without are one heart.
// A pictograph (an emoji, its skin tone, a flag's letters, a keycap's mark) and the object
// replacement character Messages writes for an attachment are no word (core's isPicture):
// each reads as white space, so a phrase copied without the emoji between its words ("only do
// weekends bc of work" for "only do weekends 😩" and "bc of work" sent as two messages) is found,
// and the slice kept is the passage's own, the emoji with it.
const DASH = /^[\p{Pd}−]$/u;
const SPACE = /^\s$/u;
const WORD = /^[\p{L}\p{N}]$/u;
const LETTER = /^\p{L}$/u;
const STOPS = new Set([".", "!", "?"]);

const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char);

const mapped = (char: string): string =>
  SINGLE_QUOTES.has(char)
    ? "'"
    : DOUBLE_QUOTES.has(char)
      ? '"'
      : DASH.test(char)
        ? "-"
        : SPACE.test(char) || isPicture(char)
          ? " "
          : char;

// The normal form, and for each code unit of it the index of the code point of `text` it
// came from. Format characters and variation selectors are dropped; each other code point is
// replaced by its own NFKC form, so positions survive; a pictograph is white space, and runs of
// white space become one space.
export function normal(text: string): { text: string; origins: number[] } {
  let out = "";
  const origins: number[] = [];
  [...text].forEach((point, index) => {
    if (FORMAT.test(point) || isShaping(point)) return;
    for (const char of point.normalize("NFKC")) {
      const written = mapped(char);
      if (written === " " && out.endsWith(" ")) continue;
      const lower = written.toLowerCase();
      out += lower;
      for (let unit = 0; unit < lower.length; unit += 1) origins.push(index);
    }
  });
  return { text: out, origins };
}

// Reading left from code point `at` of the passage: the start, a line break, or a stop followed
// by white space comes before any letter or digit.
function startsStatement(points: string[], at: number): boolean {
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = points[index] as string;
    if (char === "\n" || char === "\r") return true;
    if (STOPS.has(char) && SPACE.test(points[index + 1] ?? "")) return true;
    if (isWord(char)) return false;
  }
  return true;
}

// Reading right from code point `at`, itself included: the end, a line break, or a stop
// followed by white space or by the end comes before any letter or digit.
function endsStatement(points: string[], at: number): boolean {
  for (let index = at; index < points.length; index += 1) {
    const char = points[index] as string;
    if (char === "\n" || char === "\r") return true;
    if (STOPS.has(char) && (index + 1 === points.length || SPACE.test(points[index + 1] as string))) return true;
    if (index > at && isWord(char)) return false;
  }
  return true;
}

// Whether a match, the code points `first` to `last` of the segment, counts.
type Place = (points: string[], first: number, last: number) => boolean;
const anywhere: Place = () => true;

const CAPITAL = /^\p{Lu}$/u;
// White space within a line: a line break ends a name, as in a signature's "Thanks\nMira".
const GAP = /^[^\S\r\n]$/u;
// The first code point of the word against the match, past one run of white space within a line,
// on each side; -1 for none.
function wordBefore(points: string[], first: number): number {
  let end = first;
  while (end > 0 && GAP.test(points[end - 1] as string)) end -= 1;
  if (end === first) return -1;
  let start = end;
  while (start > 0 && LETTER.test(points[start - 1] as string)) start -= 1;
  return start < end ? start : -1;
}
function wordAfter(points: string[], last: number): number {
  let at = last + 1;
  while (at < points.length && GAP.test(points[at] as string)) at += 1;
  return at > last + 1 && LETTER.test(points[at] ?? "") ? at : -1;
}
// Two words are not a name's: the pronoun "I" after it, and, before a name of more than one word, a
// word that starts a statement ("Yesterday Bryn Calder", "Hi Bryn Calder"). Before a name of one
// word, such a word may be its first name, so it still counts: "Hi Bryn" fails closed.
const wholeName: Place = (points, first, last) => {
  const before = wordBefore(points, first);
  const after = wordAfter(points, last);
  const several = points.slice(first, last + 1).some((point) => GAP.test(point));
  const capitalBefore =
    before !== -1 && CAPITAL.test(points[before] as string) && !(several && startsStatement(points, before));
  const capitalAfter =
    after !== -1 &&
    CAPITAL.test(points[after] as string) &&
    !(points[after] === "I" && !LETTER.test(points[after + 1] ?? ""));
  return !capitalBefore && !capitalAfter;
};

function match(value: string, segment: string, grounding: Grounding, place: Place): string | null {
  const wanted = normal(value).text.trim();
  if (wanted === "") return null;
  const passage = normal(segment);
  const points = [...segment];
  for (let from = passage.text.indexOf(wanted); from !== -1; from = passage.text.indexOf(wanted, from + 1)) {
    const to = from + wanted.length;
    if (isWord(passage.text[from - 1]) || isWord(passage.text[to])) continue;
    const first = passage.origins[from] as number;
    const last = passage.origins[to - 1] as number;
    if (grounding === "statement" && !(startsStatement(points, first) && endsStatement(points, last))) continue;
    if (!place(points, first, last)) continue;
    return points.slice(first, last + 1).join("");
  }
  return null;
}

const unescaped = (value: string): string =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// A value with the stop, comma or colon at its end a passage typed without one lacks, as a chat
// line often is ("training for a half." for "training for a half"). Never a question mark, which
// would make a question of a line that asks none.
const unstopped = (value: string): string => value.replace(/[\s.!,;:]+$/u, "");

// The segment's own slice that the value stands for, or null. The value is tried as given and,
// when that finds nothing, once more with the three escapes read as their characters, then once
// more without the marks at its end. What is kept is the segment's own slice.
function ground(value: string, segment: string, grounding: Grounding, place: Place): string | null {
  const tried = new Set<string>();
  for (const one of [value, unescaped(value), unstopped(unescaped(value))]) {
    if (tried.has(one)) continue;
    tried.add(one);
    const found = match(one, segment, grounding, place);
    if (found !== null) return found;
  }
  return null;
}

export const groundText = (value: string, segment: string, grounding: Grounding): string | null =>
  ground(value, segment, grounding, anywhere);
// A name's slice by the phrase match where it stands as a whole name, or null.
export const groundName = (name: string, segment: string): string | null => ground(name, segment, "phrase", wholeName);

// Words are compared, so punctuation between them, and white space missing after it, count for
// nothing (`punctuation`); then apostrophes are dropped (`apostrophe`); then a pinned set of
// contractions (`contraction`) and of texting's abbreviations (`abbreviation`) are expanded, on
// both sides, so either may be the one typed; then a word of at least TEXTING_EDIT_MIN letters may
// differ from its fellow by one letter added, dropped, changed or two swapped, the first letter
// kept (`one_edit`). The phrase stands on whole words of the passage, and what is kept is the
// passage's own slice, never the model's words. Pinned: a change is a change of what grounds.
export type TextingRule = "punctuation" | "apostrophe" | "contraction" | "abbreviation" | "one_edit";
const TEXTING_RULES: readonly TextingRule[] = Object.freeze([
  "punctuation",
  "apostrophe",
  "contraction",
  "abbreviation",
  "one_edit",
]);
const TEXTING_EDIT_MIN = 5;
// Each with its apostrophe; a word typed without it expands too, unless that word is a common one of
// its own (TEXTING_APOSTROPHE_ONLY: "ill", "were", "well", "its"); "cant" and "wont" are words too,
// but rare in a chat beside the contractions, so they expand. "I'd", "he's", "she's" and "let's" are
// left out, each two contractions or a word. The apostrophe rung before this one still finds "I'll"
// typed "ill": only the expansion to "I will" waits for the apostrophe.
const TEXTING_CONTRACTIONS: Readonly<Record<string, string>> = Object.freeze({
  "i'm": "i am",
  "i've": "i have",
  "i'll": "i will",
  "you're": "you are",
  "you've": "you have",
  "you'll": "you will",
  "we're": "we are",
  "we've": "we have",
  "we'll": "we will",
  "they're": "they are",
  "they've": "they have",
  "they'll": "they will",
  "it's": "it is",
  "that's": "that is",
  "what's": "what is",
  "there's": "there is",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "can't": "can not",
  cannot: "can not",
  "won't": "will not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "couldn't": "could not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  gonna: "going to",
  wanna: "want to",
  gotta: "got to",
});
const TEXTING_APOSTROPHE_ONLY: readonly string[] = Object.freeze(["i'll", "we're", "we'll", "it's"]);
// `&` and `+` only standing alone between white space: "AT&T" and "2+2" hold no "and".
const TEXTING_ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  u: "you",
  ur: "your",
  "w/": "with",
  "w/o": "without",
  "&": "and",
  "+": "and",
  bc: "because",
  "b/c": "because",
  cuz: "because",
  rn: "right now",
  tmrw: "tomorrow",
  abt: "about",
  ppl: "people",
  thru: "through",
  pls: "please",
  plz: "please",
  bday: "birthday",
});

const TEXT_APOSTROPHES = /['‘’ʼ′`]/gu;
const bare = (word: string): string => word.replaceAll("'", "");
const CONTRACTED = new Map<string, string[]>(
  Object.entries(TEXTING_CONTRACTIONS).map(([key, words]) => [key, words.split(" ")]),
);
for (const [key, words] of Object.entries(TEXTING_CONTRACTIONS))
  if (!TEXTING_APOSTROPHE_ONLY.includes(key)) CONTRACTED.set(bare(key), words.split(" "));
const ABBREVIATED = new Map<string, string[]>(
  Object.entries(TEXTING_ABBREVIATIONS).map(([key, words]) => [key, words.split(" ")]),
);
// A word, its apostrophes inside it; an abbreviation with a slash; `&` or `+` alone. A combining
// mark, a format character and a variation selector are part of the word they stand in.
const TEXT_TOKEN =
  /(?<![\p{L}\p{N}])(?:w\/o|b\/c)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])w\/|(?<=^|\s)[&+](?=\s|$)|[\p{L}\p{N}\p{M}\p{Cf}]+(?:['‘’ʼ′`][\p{L}\p{N}\p{M}\p{Cf}]+)*/giu;
type TextToken = { from: number; to: number; word: string };
const textTokens = (text: string): TextToken[] =>
  [...text.matchAll(TEXT_TOKEN)]
    .map((found) => ({
      from: found.index,
      to: found.index + found[0].length,
      word: [...found[0].normalize("NFKC").toLowerCase()]
        .filter((point) => !FORMAT.test(point) && !isShaping(point))
        .join("")
        .replace(TEXT_APOSTROPHES, "'"),
    }))
    .filter((token) => token.word !== "");

// A token's words at a rung, each with its token and whether it opens or closes the token's words.
type TextWord = { word: string; token: number; opens: boolean; closes: boolean };
const RUNG = Object.fromEntries(TEXTING_RULES.map((rule, at) => [rule, at])) as Record<TextingRule, number>;
function wordsAt(tokens: readonly TextToken[], rung: number): TextWord[] {
  return tokens.flatMap((token, at) => {
    const folded = rung >= RUNG.apostrophe ? bare(token.word) : token.word;
    const words = (rung >= RUNG.contraction ? (CONTRACTED.get(token.word) ?? CONTRACTED.get(folded)) : undefined) ??
      (rung >= RUNG.abbreviation ? ABBREVIATED.get(folded) : undefined) ?? [folded];
    return words.map((word, n) => ({ word, token: at, opens: n === 0, closes: n === words.length - 1 }));
  });
}

const LETTERS = /^\p{L}+$/u;
// One letter added, dropped, changed, or two neighbours swapped; never the first letter, never in
// a word under TEXTING_EDIT_MIN letters or one that is not all letters.
function oneEdit(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (
    Math.min(x.length, y.length) < TEXTING_EDIT_MIN ||
    !LETTERS.test(a) ||
    !LETTERS.test(b) ||
    x[0] !== y[0] ||
    Math.abs(x.length - y.length) > 1
  )
    return false;
  let at = 0;
  while (at < x.length && x[at] === y[at]) at += 1;
  if (at === x.length && at === y.length) return true;
  const rest = (i: number, j: number): boolean => x.slice(i).join("") === y.slice(j).join("");
  if (x.length === y.length)
    return rest(at + 1, at + 1) || (x[at] === y[at + 1] && x[at + 1] === y[at] && rest(at + 2, at + 2));
  return x.length > y.length ? rest(at + 1, at) : rest(at, at + 1);
}

// The passage's own slice the value stands for, and the first rung that finds it, or null.
export function groundTexting(value: string, segment: string): { slice: string; rule: TextingRule } | null {
  const asked = textTokens(unescaped(value));
  if (asked.length === 0) return null;
  const tokens = textTokens(segment);
  for (const [rung, rule] of TEXTING_RULES.entries()) {
    const wanted = wordsAt(asked, rung).map((one) => one.word);
    const have = wordsAt(tokens, rung);
    const same = (a: string, b: string): boolean => a === b || (rung >= RUNG.one_edit && oneEdit(a, b));
    for (let start = 0; start + wanted.length <= have.length; start += 1) {
      const first = have[start] as TextWord;
      const last = have[start + wanted.length - 1] as TextWord;
      if (!first.opens || !last.closes || !wanted.every((word, n) => same(word, (have[start + n] as TextWord).word)))
        continue;
      return {
        slice: segment.slice((tokens[first.token] as TextToken).from, (tokens[last.token] as TextToken).to),
        rule,
      };
    }
  }
  return null;
}

// Then a phrase may skip at most DURABLE_FILLERS_MAX hesitations between its words, and a statement
// may be a short, faithful restatement of a sentence. What is kept is always the transcript's own
// words: a phrase its words as transcribed, joined by single spaces; a statement the whole sentence
// (or sentences) of the cited text it stands on. The model's wording is never stored.
const DURABLE_FILLERS_MAX = 2;
// A restatement: at least this share of its content words are the sentence's, at most this many are not.
const RESTATE_OVERLAP = 0.6;
const RESTATE_UNMATCHED_MAX = 3;
// The sentence a restatement stands on is at most this many code units.
const RESTATE_SLICE_MAX = 400;

// Hesitations only. A word such as "well", "right" or "like" is often a word of the fact.
export const FILLERS = new Set(["uh", "um", "er", "erm", "ah", "hmm", "mm"]);
// Negation typed without its apostrophe, which `negates` does not read.
export const BARE_NEGATIONS = new Set(
  "dont doesnt didnt wont wouldnt cant couldnt shouldnt isnt arent wasnt werent havent hasnt hadnt aint mustnt neednt".split(
    " ",
  ),
);
// Words a restatement may add, drop or change without changing what was said.
export const STOPWORDS = new Set(
  "a an the and or but so of to in on at by for from with about as is am are was were be been being it its this that these those there here i me my mine we us our you your he him his she her they them their will would shall can could may must do does did have has had just really very also then than too some any all each every one going gonna wanna get got let lets i'll i'm i've i'd we'll we're you'll".split(
    " ",
  ),
);
export const isStopword = (word: string): boolean => STOPWORDS.has(word);
const NEGATORS = new Set(["not", "no", "never", "cannot", "nothing", "nobody", "none", "neither", "nor", "without"]);
// Words that make a statement conditional or uncertain: a sentence that holds one is restated only with it.
const HEDGES = new Set([
  "if",
  "unless",
  "maybe",
  "might",
  "perhaps",
  "probably",
  "possibly",
  "hopefully",
  "whether",
  "depends",
  "should",
  "would",
  "could",
]);
const FIRST_PERSON = new Set([
  "i",
  "i'll",
  "i'm",
  "i've",
  "i'd",
  "me",
  "my",
  "we",
  "we'll",
  "we're",
  "we've",
  "us",
  "our",
]);
// Words that say when: a restatement's are the sentence's too, so a restated promise keeps its time.
const TIMES = new Set(
  "today tonight tomorrow yesterday morning afternoon evening night week weekend weeks month months year years next last monday tuesday wednesday thursday friday saturday sunday".split(
    " ",
  ),
);
const WORD_RUN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export type Token = { word: string; from: number; to: number; raw: string };
export const tokensOf = (text: string): Token[] =>
  [...text.matchAll(WORD_RUN)].map((found) => ({
    raw: found[0],
    word: found[0].normalize("NFKC").toLowerCase().replaceAll("’", "'"),
    from: found.index,
    to: found.index + found[0].length,
  }));

export const negates = (tokens: readonly Token[]): boolean =>
  tokens.some((one) => NEGATORS.has(one.word) || one.word.endsWith("n't"));
// The same word, or the same word with another ending: one a prefix of the other, the shorter at
// least four letters and the difference at most three.
// The other word's ending must be an inflection, so "store" is not
// "story" nor "stripe" "stripped". After a word of at least four letters: s, es, ed, d or ing, or
// its last consonant doubled before ed or ing (plan, planned); a final e drops before ing, ed or es
// (negotiate, negotiating). Never er, ers or ly, which make another word (bank,
// banker; hard, hardly; manage, manager).
const ENDINGS = new Set(["s", "es", "ed", "d", "ing"]);
const E_ENDINGS = new Set(["ing", "ed", "es"]);
const DOUBLED = new Set(["ed", "ing"]);
const sameWord = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  if (long.startsWith(short)) {
    const rest = long.slice(short.length);
    return ENDINGS.has(rest) || (rest[0] === short[short.length - 1] && DOUBLED.has(rest.slice(1)));
  }
  const stem = short.slice(0, -1);
  return short.endsWith("e") && short.length > 4 && long.startsWith(stem) && E_ENDINGS.has(long.slice(stem.length));
};
// The names of a text: its capitalised words that are not "I" and not a function word. A
// sentence's first word may be a name or any word, so it is set apart (`opening`), and left out
// when a comma follows it (whom the speaker addresses) or it is an interjection.
const INTERJECTIONS = new Set(
  "yeah yes yep no okay ok so well sure right great fine oh hey hi thanks alright anyway look listen honestly actually".split(
    " ",
  ),
);
function namesIn(text: string): { names: string[]; opening: string[] } {
  const tokens = tokensOf(text);
  const names: string[] = [];
  const opening: string[] = [];
  tokens.forEach((one, index) => {
    if (!/^\p{Lu}/u.test(one.raw) || one.raw === "I" || STOPWORDS.has(one.word)) return;
    const before = text.slice(index === 0 ? 0 : (tokens[index - 1] as Token).to, one.from);
    if (!(index === 0 || /[.!?]/.test(before))) names.push(one.word);
    else if (!INTERJECTIONS.has(one.word) && !/^\s*,/.test(text.slice(one.to))) opening.push(one.word);
  });
  return { names, opening };
}
export const numbersIn = (text: string): string[] => numerals(text).flatMap(readings);

// A phrase's words, in order, each the same word of the text, with at most DURABLE_FILLERS_MAX
// hesitations between them and nothing else. Its value is the text between its words as
// transcribed, a hyphen or an apostrophe kept, each skipped hesitation closing up to one space;
// `from` and `to` are its first and last word's place in the text.
type Grounded = { value: string; from: number; to: number };
function durablePhrase(value: string, text: string): Grounded | null {
  const wanted = tokensOf(value);
  const have = tokensOf(text);
  if (wanted.length === 0) return null;
  for (let start = 0; start < have.length; start += 1) {
    let at = start;
    let skipped = 0;
    const kept: Token[] = [];
    for (const word of wanted) {
      // A word may differ in its ending, as a statement's may.
      const same = (one: Token | undefined): boolean => one !== undefined && sameWord(word.word, one.word);
      while (
        kept.length > 0 &&
        at < have.length &&
        !same(have[at]) &&
        FILLERS.has((have[at] as Token).word) &&
        skipped < DURABLE_FILLERS_MAX
      ) {
        at += 1;
        skipped += 1;
      }
      if (!same(have[at])) break;
      kept.push(have[at] as Token);
      at += 1;
    }
    if (kept.length === wanted.length) {
      const pieces: string[] = [];
      let from = (kept[0] as Token).from;
      kept.forEach((one, n) => {
        const next = kept[n + 1];
        if (next !== undefined && have.indexOf(next) === have.indexOf(one) + 1) return;
        pieces.push(text.slice(from, one.to));
        if (next !== undefined) from = next.from;
      });
      return { value: pieces.join(" "), from: (kept[0] as Token).from, to: (kept[kept.length - 1] as Token).to };
    }
  }
  return null;
}

// The sentences of a text, by their ranges: each ends after a stop that white space or the end follows.
function sentencesOf(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let from = 0;
  for (const found of text.matchAll(/[.!?]+(?=\s|$)/gu)) {
    const to = found.index + found[0].length;
    ranges.push([from, to]);
    from = to;
  }
  if (text.slice(from).trim() !== "") ranges.push([from, text.length]);
  return ranges.map(([a, b]) => {
    const lead = text.slice(a, b).length - text.slice(a, b).trimStart().length;
    return [a + lead, b];
  });
}

// Dates a sentence may name: a month and its day, with or without a year, and a month and its
// year. A number alone is never taken for a year ("the 2000 dollar invoice").
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_EXPRESSION = new RegExp(
  `\\b(?:(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s+\\d{4})?|(?:${MONTHS})\\s+\\d{4})\\b`,
  "gu",
);
// Each date as its parts: a month with its day, and a year, so "March 12" is one of "March 12, 2026".
const datesIn = (text: string): string[] =>
  [...text.matchAll(DATE_EXPRESSION)].flatMap((found) => {
    const date = found[0]
      .toLowerCase()
      .replace(/(\d)(st|nd|rd|th)\b/gu, "$1")
      .replace(/[,\s]+/gu, " ");
    const year = /\b\d{4}\b/u.exec(date)?.[0];
    const day = date.replace(/\b\d{4}\b/u, "").trim();
    return [...(day === "" ? [] : [day.split(" ").sort().join(" ")]), ...(year === undefined ? [] : [year])];
  });

// The part of a sentence a negation is read in: from its start to the first word of a
// reason or a purpose (so, because) after the restated words. A clause before them is read, and so
// is one a comma, a semicolon, a colon or a contrast (though, although, while, whereas) sets after
// them, since that may take the promise back ("tomorrow, actually no, I won't"; "though actually no,
// I won't"); a clause that only gives a reason or a purpose is not ("so you do not have to").
// Hedges are read over the whole sentence.
const CLAUSE_WORDS = new Set(["so", "because"]);
function upToClauseEnd(text: string, to: number): string {
  const joining = tokensOf(text).find((one) => one.from >= to && CLAUSE_WORDS.has(one.word));
  return joining === undefined ? text : text.slice(0, joining.from);
}

// A statement restated. Its content words, at least RESTATE_OVERLAP of them (at most
// RESTATE_UNMATCHED_MAX not), are words of the cited text; the sentences that hold the first to the
// last of them are the slice, at most RESTATE_SLICE_MAX code units. The slice and the restatement
// then agree on everything that changes a fact: the same names (but one the speaker
// addresses), the same numbers, a negation in both or neither, every hedge or condition of the
// slice in the restatement, and the first person of the restatement in the slice.
function durableStatement(value: string, text: string): Grounded | null {
  const wanted = tokensOf(value);
  const content = [
    ...new Set(wanted.map((one) => one.word).filter((word) => !STOPWORDS.has(word) && !HEDGES.has(word))),
  ];
  if (content.length < 2) return null;
  const have = tokensOf(text);
  const matched = content.filter((word) => have.some((one) => sameWord(word, one.word)));
  if (matched.length / content.length < RESTATE_OVERLAP || content.length - matched.length > RESTATE_UNMATCHED_MAX)
    return null;
  // The shortest run of the text's words holding one of each matched word.
  let best: [number, number] | null = null;
  const width = (range: [number, number]): number => (have[range[1]] as Token).to - (have[range[0]] as Token).from;
  for (let first = 0; first < have.length; first += 1) {
    if (!matched.some((word) => sameWord(word, (have[first] as Token).word))) continue;
    const missing = new Set(matched);
    for (let last = first; last < have.length; last += 1) {
      for (const word of [...missing]) if (sameWord(word, (have[last] as Token).word)) missing.delete(word);
      if (missing.size === 0) {
        if (best === null || width([first, last]) < width(best)) best = [first, last];
        break;
      }
    }
  }
  if (best === null) return null;
  const from = (have[best[0]] as Token).from;
  const to = (have[best[1]] as Token).to;
  // One sentence: a negation or a first person of the sentence beside it must not
  // stand for the restatement's.
  const sentences = sentencesOf(text).filter(([a, b]) => b > from && a < to);
  if (sentences.length !== 1) return null;
  const [start, end] = sentences[0] as [number, number];
  const slice = text.slice(start, end).trimEnd();
  if (slice.length > RESTATE_SLICE_MAX) return null;
  const said = tokensOf(slice);
  const words = new Set(said.map((one) => one.word));
  const told = new Set(wanted.map((one) => one.word));
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.every((one) => b.includes(one)) && b.every((one) => a.includes(one));
  // A date the sentence names (a month and its day, a year) may be left out
  // of the restatement, since the claim's date field carries it; a date the restatement names must
  // be one of the sentence's. Numbers and names are compared with the dates set apart.
  const valueDates = datesIn(value);
  const sliceDates = datesIn(slice);
  if (!valueDates.every((one) => sliceDates.includes(one))) return null;
  const undated = (text: string): string => text.replace(DATE_EXPRESSION, " ");
  const named = namesIn(undated(value));
  const naming = namesIn(undated(slice));
  if (!sameSet([...new Set(named.names)], [...new Set(naming.names)])) return null;
  // A sentence's first word that may be a name: each side's must be a word of the other, so
  // "Alice will send it" never grounds "Bob will send it", and "Send it Tuesday" grounds "send it".
  if (!naming.opening.every((word) => told.has(word)) || !named.opening.every((word) => words.has(word))) return null;
  if (!sameSet([...new Set(numbersIn(undated(value)))], [...new Set(numbersIn(undated(slice)))])) return null;
  // A negation is read up to the end of the clause that holds the matched
  // words, so "I will take the cuttings away so you do not have to" restates as a promise, while
  // "I will not under any circumstances send the deck" and "I will never, ever send it" never do.
  if (negates(wanted) !== negates(tokensOf(upToClauseEnd(slice, to - start)))) return null;
  // Every hedge or condition of the sentence, before or after the restated words, is kept.
  if ([...words].some((word) => HEDGES.has(word) && !told.has(word))) return null;
  if ([...told].some((word) => FIRST_PERSON.has(word)) && ![...words].some((word) => FIRST_PERSON.has(word)))
    return null;
  if ([...told].some((word) => TIMES.has(word) && !words.has(word))) return null;
  return { value: slice, from: start, to: start + slice.length };
}

// The value durable grounding keeps and where in the text it stands (a phrase that skipped a
// hesitation is not a substring of the text, and attribution places it by its range).
export function groundDurableAt(value: string, text: string, grounding: Grounding): Grounded | null {
  const exact = groundText(value, text, grounding);
  if (exact !== null) {
    const at = text.indexOf(exact);
    return { value: exact, from: at, to: at + exact.length };
  }
  const plain = unescaped(value);
  return grounding === "phrase" ? durablePhrase(plain, text) : durableStatement(plain, text);
}
export const groundDurable = (value: string, text: string, grounding: Grounding): string | null =>
  groundDurableAt(value, text, grounding)?.value ?? null;

// The meeting evaluation's scorer: the share of `expected`'s content words that
// `found` holds, each as itself or with another ending. Not used by any check of the lanes.
export function wordsCovered(expected: string, found: string): number {
  const want = [
    ...new Set(
      tokensOf(expected)
        .map((one) => one.word)
        .filter((word) => !STOPWORDS.has(word)),
    ),
  ];
  if (want.length === 0) return 0;
  const have = tokensOf(found).map((one) => one.word);
  return want.filter((word) => have.some((one) => sameWord(word, one))).length / want.length;
}
