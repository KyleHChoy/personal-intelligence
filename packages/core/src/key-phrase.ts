// Pure, with pinned tables, so no fact key depends on a model.
import { straightened } from "./text.ts";

// A leading one standing as its own word moves out, turning `prefers` into `avoids`. Pinned: a
// change is a new fact key version.
export const NEGATIONS: readonly string[] = Object.freeze([
  "no",
  "not",
  "never",
  "avoid",
  "avoids",
  "avoiding",
  "dont",
  "do not",
  "doesnt",
  "does not",
  "didnt",
  "did not",
  "wont",
  "will not",
  "without",
]);

// Two stay: the phrase's last word ("vitamin A", "Plan A"), and one joined to a slash ("A/B
// testing").
const ARTICLES = new Set(["a", "an", "the"]);
export const KEY_PHRASE_WORDS = 12;
export const KEY_PHRASE_CODE_POINTS = 90;

// A combining mark is part of its word: कुल and काल are two words, not one.
const NOT_WORD = /[^\p{L}\p{M}\p{N}]+/gu;

const wordsOf = (text: string): string[] =>
  straightened(text)
    .toLowerCase()
    .replaceAll("'", "")
    .split(NOT_WORD)
    .filter((word) => word !== "");

// The text's runs between white space that hold a word, each with where it starts and its words.
// A run of one word is a word standing on its own; "no-name" is one run of two words.
type Run = { at: number; text: string; words: string[] };
const runsOf = (text: string): Run[] =>
  [...text.matchAll(/\S+/gu)]
    .map((match) => ({ at: match.index, text: match[0], words: wordsOf(match[0]) }))
    .filter((run) => run.words.length > 0);
const alone = (run: Run | undefined): string | undefined => (run?.words.length === 1 ? run.words[0] : undefined);

export function keyWords(text: string): string[] {
  const runs = runsOf(text);
  const dropped = (run: Run, n: number) =>
    n < runs.length - 1 && !run.text.includes("/") && ARTICLES.has(alone(run) ?? "");
  return runs.flatMap((run, n) => (dropped(run, n) ? [] : run.words));
}

// A first-person subject a key phrase may begin with, written with its apostrophe
// (curly or straight), so "I'll" is never "ill" and "we're" never "were". Pinned, provisional.
export const FIRST_PERSON_SUBJECTS: readonly string[] = Object.freeze([
  "i",
  "i've",
  "i'm",
  "i'd",
  "i'll",
  "my",
  "me",
  "we",
  "we've",
  "we're",
  "we'll",
  "we'd",
]);
const SUBJECTS = new Set(FIRST_PERSON_SUBJECTS);

// A modal a key phrase may begin with, after its subject. The
// claim's type carries what it says, so "can write Python" keys as "write Python". Pinned.
const MODALS: readonly string[] = Object.freeze([
  "can",
  "could",
  "will",
  "would",
  "should",
  "must",
  "may",
  "might",
  "shall",
]);
const MODAL_SET = new Set(MODALS);

// The text without one leading word of `set` standing as its own word, when a word follows it.
function without(text: string, set: ReadonlySet<string>): string {
  const [first, next] = runsOf(text);
  const word = first?.text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ′`]/gu, "'");
  return next !== undefined && word !== undefined && set.has(word) ? text.slice(next.at) : text;
}

// A leading first-person subject is dropped first, so "I moved to Portland" and "moved to Portland"
// are one phrase; then a leading modal, so "I can write Python" and "write Python" are one phrase.
export const keyPhrase = (text: string): string => keyWords(without(without(text, SUBJECTS), MODAL_SET)).join(" ");

const NEGATION_WORDS = NEGATIONS.map((entry) => entry.split(" ")).sort((a, b) => b.length - a.length);

// The text after its leading negation, as a slice of the text itself, trimmed; null when it
// begins with none. "Never em dashes" gives "em dashes", so a grounded value stays grounded. A
// negation counts only standing as its own word: "no-name brands" and "no-code tools" begin with
// none.
export function afterNegation(text: string): string | null {
  const runs = runsOf(text);
  const entry = NEGATION_WORDS.find((words) => words.every((word, n) => alone(runs[n]) === word));
  if (entry === undefined) return null;
  const next = runs[entry.length];
  return next === undefined ? "" : text.slice(next.at).trim();
}

// Whether a text begins with a negation of the table, standing as its own word (check
// `negated_object`).
export const beginsNegated = (text: string): boolean => afterNegation(text) !== null;

// Whether that makes the polarity `avoids` is the caller's: only `prefers` flips.
export function polarPhrase(text: string): { phrase: string; negated: boolean } {
  const rest = afterNegation(text);
  return rest === null ? { phrase: keyPhrase(text), negated: false } : { phrase: keyPhrase(rest), negated: true };
}

// What is drawn and not written, in a chat line above all: a pictograph (an emoji,
// its skin tone, a flag's letters, a keycap's mark) and the object replacement character Messages
// writes for an attachment, each standing apart from the words; and the variation selectors and
// the joiner that only shape the character before them, which belong to no word and split none.
// None is part of a word. The copyright and registered signs are pictographs to
// Unicode but marks of a name in text ("Acme©Labs"), so they are neither.
const PICTURE =
  "(?![\\u{A9}\\u{AE}])[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u{20E3}\\u{FFFC}]";
const PICTURES = new RegExp(PICTURE, "gu");
const SHAPE = "[\\u{FE00}-\\u{FE0F}\\u{E0100}-\\u{E01EF}\\u{200D}]";
const SHAPING = new RegExp(SHAPE, "gu");
const ONE_PICTURE = new RegExp(`^${PICTURE}$`, "u");
const ONE_SHAPE = new RegExp(`^${SHAPE}$`, "u");
export const isPicture = (char: string): boolean => ONE_PICTURE.test(char);
export const isShaping = (char: string): boolean => ONE_SHAPE.test(char);
export const withoutPictures = (text: string): string => text.replace(SHAPING, "").replace(PICTURES, "");

// An emoji is no word, so one standing alone between two messages' words counts for none.
export const wordCount = (text: string): number =>
  text
    .replace(SHAPING, "")
    .replace(PICTURES, " ")
    .split(/\s+/u)
    .filter((word) => word !== "").length;

// A backstop to the prompt's one fact per claim, so some two-fact phrases pass.
const CONJUNCTIONS = new Set(["and", "but"]);
const OPENERS = new Set([
  "i",
  "im",
  "ill",
  "ive",
  "id",
  "we",
  "weve",
  "he",
  "she",
  "they",
  "theyre",
  "also",
  "then",
  "to",
  "will",
  "would",
  "can",
  "could",
  "should",
  "must",
]);
const VERBS: readonly string[] = Object.freeze([
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "had",
  "apply",
  "ask",
  "attend",
  "become",
  "begin",
  "build",
  "buy",
  "call",
  "change",
  "close",
  "come",
  "complete",
  "create",
  "decide",
  "do",
  "drop",
  "earn",
  "end",
  "feel",
  "find",
  "finish",
  "fix",
  "focus",
  "get",
  "give",
  "go",
  "grow",
  "help",
  "hire",
  "join",
  "keep",
  "launch",
  "lead",
  "learn",
  "leave",
  "lose",
  "make",
  "manage",
  "meet",
  "move",
  "need",
  "open",
  "pay",
  "plan",
  "prepare",
  "publish",
  "quit",
  "raise",
  "read",
  "rent",
  "return",
  "run",
  "save",
  "sell",
  "send",
  "ship",
  "sign",
  "spend",
  "start",
  "stay",
  "stop",
  "study",
  "switch",
  "take",
  "teach",
  "train",
  "travel",
  "try",
  "visit",
  "want",
  "win",
  "work",
  "write",
]);
const VERB_SET = new Set(VERBS);
// A word is a verb when it, or its stem by one inflection (-s, -es, -ed, -d, -ing, a doubled last
// consonant, an e restored), is listed.
export function verbLike(word: string): boolean {
  if (VERB_SET.has(word)) return true;
  const stems: string[] = [];
  for (const suffix of ["ing", "ed", "es", "s", "d"]) {
    if (!word.endsWith(suffix) || word.length <= suffix.length + 1) continue;
    const stem = word.slice(0, -suffix.length);
    stems.push(stem, `${stem}e`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) stems.push(stem.slice(0, -1));
  }
  return stems.some((stem) => VERB_SET.has(stem));
}

// A full stop after a pinned abbreviation or a single-letter initial ends no sentence: "moved to
// St. Louis", "join the U.S. Army", "J. Smith". Pinned, lower case.
const ABBREVIATIONS: readonly string[] = Object.freeze([
  "st",
  "dr",
  "mr",
  "mrs",
  "ms",
  "jr",
  "sr",
  "inc",
  "co",
  "corp",
  "ltd",
  "vs",
  "e.g",
  "i.e",
  "etc",
  "no",
  "mt",
  "ft",
  "u.s",
  "u.k",
]);
const ABBREVIATION_SET = new Set(ABBREVIATIONS);
const STOP = /(\S*)([.!?])\s+\p{Lu}/gu;
function sentenceBreak(text: string): boolean {
  if (/[\n\r]/u.test(text)) return true;
  return [...text.matchAll(STOP)].some(([, before = "", mark]) => {
    const word = before.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
    return mark !== "." || !(ABBREVIATION_SET.has(word) || /^\p{L}$/u.test(word));
  });
}

// The words of a clause that count toward a fact: all but its openers.
const contentOf = (clause: readonly string[]): string[] =>
  clause.filter((word) => !OPENERS.has(word) || verbLike(word));

// Articles are kept here: "a meeting and a call" is one fact, its second noun opened by "a".
export function statesTwoFacts(text: string): boolean {
  if (sentenceBreak(text.trim())) return true;
  const clauses: string[][] = [[]];
  for (const piece of text.split(/([;,])/u)) {
    if (piece === ";" || piece === ",") {
      clauses.push([]);
      continue;
    }
    for (const word of wordsOf(piece)) {
      if (CONJUNCTIONS.has(word)) clauses.push([]);
      else clauses.at(-1)?.push(word);
    }
  }
  const content = clauses.map(contentOf).filter((clause) => clause.length > 0);
  return content.some((left, n) => {
    const right = content[n + 1];
    return (
      right !== undefined && left.length > 1 && left.some(verbLike) && right.length > 1 && verbLike(right[0] as string)
    );
  });
}
