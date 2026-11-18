import {
  BARE_NEGATIONS,
  groundText,
  groundTexting,
  negates,
  numbersIn,
  STOPWORDS,
  type TextingRule,
  type Token,
  tokensOf,
} from "./grounding.ts";
import type { Grounding } from "./ontology.ts";

// The rule is that a repair never changes what was said, and it refuses whenever it cannot tell: so
// the slice holds the value's own words in the value's order, and only spelling that cannot change a
// fact differs. What this finds is only ever the segment's own slice, and the caller's check then
// judges that slice as it judges any value. Pure: no model, no state, the same answer for the same
// value and segment, so a replay of a saved answer repairs as the first run did.

// The rule that found the slice: a rung of texting's ladder that keeps every word (its `one_edit`
// is left out, since one letter makes another word: leading, leaving), or a run of the value's
// words with its articles changed.
export type RepairRule = Exclude<TextingRule, "one_edit"> | "word_window";

// Pinned: a change is a change of what grounds, and of what a replay stores.
// A value of fewer words is a name or a fragment: only texting's ladder may place it.
const REPAIR_MIN_WORDS = 3;
// A longer value is no near miss, and costs more to place than it could return.
const REPAIR_MAX_WORDS = 40;
// Articles added, dropped or changed between the value and the slice.
const REPAIR_MAX_WORD_EDITS = 2;
// The only words that may differ. Every other small word changes a fact: to and from, is and was,
// you and I, will and may, all and some.
const FREE_WORDS = new Set(["a", "an", "the"]);
// A word this long may differ by a plural ending alone. Any other ending may be a tense: "hired" is
// not "hire".
const PLURAL_MIN_LETTERS = 4;

const negated = (tokens: readonly Token[]): boolean =>
  negates(tokens) || tokens.some((one) => BARE_NEGATIONS.has(one.word));

// The only words that may stand either side of the slice in its sentence, unless the value says
// them too. Anything else may make it a wish, a plan, a past state, a condition, a question or
// another's word before it ("want to", "used to", "did you", "he claims"), or take it back after it
// ("fell through", "was my mistake", "or at least I hope so"), and a list of those would miss some.
const BEFORE_SLICE = new Set(
  "and so also now still just finally currently already then yes yeah ok okay thanks hi hey well".split(" "),
);
const AFTER_SLICE = new Set("now today finally too also already again thanks".split(" "));
// First person may stand before it only when the owner is the claim's subject and its speaker: then
// "I am running the team" is the claim's own. "He is running the team" is someone the model may not
// have named, so no other pronoun stands there.
const FIRST_PERSON_BEFORE = new Set("i am we are i'm we're i've we've my our".split(" "));

// Dropping the apostrophe makes another word of these: "were" is not "we're".
const APOSTROPHE_WORDS = new Set(["were", "well", "ill", "shell", "hell", "wed", "id", "its", "lets", "shed", "hed"]);

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((one) => b.includes(one)) && b.every((one) => a.includes(one));
const wordsOf = (tokens: readonly Token[]): string[] => tokens.map((one) => one.word);
// The marks that say whose money or what share: $500 is not €500.
const marksOf = (text: string): string[] => [...text].filter((point) => /[\p{Sc}%]/u.test(point));

// The same word, or the same with a plural ending.
const sameForm = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= PLURAL_MIN_LETTERS && (long === `${short}s` || long === `${short}es`);
};

// What texting's ladder folds and a word comparison cannot see: numbers, the marks beside them, a
// negation in both or neither, and the words an apostrophe tells apart.
function agrees(value: string, slice: string): boolean {
  const told = tokensOf(value);
  const said = tokensOf(slice);
  if (!sameSet(numbersIn(value), numbersIn(slice)) || !sameSet(marksOf(value), marksOf(slice))) return false;
  if (negated(told) !== negated(said)) return false;
  const left = (a: string[], b: string[]): boolean => a.some((one) => APOSTROPHE_WORDS.has(one) && !b.includes(one));
  return !left(wordsOf(told), wordsOf(said)) && !left(wordsOf(said), wordsOf(told));
}

// Where a sentence ends: one stop before white space or the end, or a blank line. Never a line break
// alone, since mail is hard-wrapped and "I did not\nsign the lease" is one sentence, nor an ellipsis, a
// colon or a semicolon, which carry a negation on ("I didnt... sign the lease").
const SENTENCE_END = /(?<![.\u2026])[.!?](?=\s|$)|\n\s*\n/gu;

const sentenceBefore = (text: string): string => {
  let from = 0;
  for (const found of text.matchAll(SENTENCE_END)) from = found.index + found[0].length;
  return text.slice(from);
};

// Whether any place the slice stands is ruled by the rest of its sentence: a question, or either side
// a word that is not plainly harmless and that the value does not say.
function governed(slice: string, value: string, segment: string, firstPerson: boolean): boolean {
  const told = wordsOf(tokensOf(value));
  const free = (one: Token, list: ReadonlySet<string>): boolean => list.has(one.word) || told.includes(one.word);
  for (let at = segment.indexOf(slice); at !== -1; at = segment.indexOf(slice, at + 1)) {
    const before = tokensOf(sentenceBefore(segment.slice(0, at)));
    const rest = segment.slice(at + slice.length);
    const end = new RegExp(SENTENCE_END.source, "u").exec(rest);
    if (end?.[0] === "?") return true;
    const after = tokensOf(end === null ? rest : rest.slice(0, end.index));
    if (before.some((one) => !free(one, BEFORE_SLICE) && !(firstPerson && FIRST_PERSON_BEFORE.has(one.word))))
      return true;
    if (after.some((one) => !free(one, AFTER_SLICE))) return true;
  }
  return false;
}

// A stop or a line break inside is two sentences, read as one.
const oneSentence = (slice: string): boolean => !/[.!?]\s|\n/u.test(slice);

// Words to change, add or drop to make `a` of `b`.
function wordEdits(a: readonly Token[], b: readonly Token[]): number {
  let row = [0, ...b.map((_, at) => at + 1)];
  a.forEach((word, i) => {
    const next = [i + 1];
    b.forEach((other, j) => {
      const change = (row[j] as number) + (sameForm(word.word, other.word) ? 0 : 1);
      next.push(Math.min(change, (row[j + 1] as number) + 1, (next[j] as number) + 1));
    });
    row = next;
  });
  return row[b.length] as number;
}

// A run of the segment's words that is the value's words in order, only its articles different and
// at most REPAIR_MAX_WORD_EDITS of them. Two runs that differ are no answer: code does not guess.
function wordWindow(value: string, segment: string): string | null {
  const wanted = tokensOf(value);
  const words = wanted.filter((one) => !FREE_WORDS.has(one.word));
  const content = wanted.filter((one) => !STOPWORDS.has(one.word));
  const first = words[0];
  if (wanted.length < REPAIR_MIN_WORDS || wanted.length > REPAIR_MAX_WORDS || first === undefined || content.length < 2)
    return null;
  const have = tokensOf(segment);
  const slices = new Map<string, string>();
  have.forEach((word, start) => {
    if (!sameForm(first.word, word.word)) return;
    let at = start;
    for (const one of words) {
      while (at < have.length && FREE_WORDS.has((have[at] as Token).word)) at += 1;
      if (at >= have.length || !sameForm(one.word, (have[at] as Token).word)) return;
      at += 1;
    }
    const run = have.slice(start, at);
    if (wordEdits(wanted, run) > REPAIR_MAX_WORD_EDITS) return;
    const slice = segment.slice(word.from, (run[run.length - 1] as Token).to);
    slices.set(wordsOf(run).join(" "), slice);
  });
  const [slice] = slices.values();
  return slices.size === 1 && slice !== undefined ? slice : null;
}

// The segment's own slice a value stands for, and the rule that found it, or null. Only asked about
// a value the exact match refused. The first slice that the exact match itself takes under the
// field's grounding, and that nothing about it says otherwise, is the answer: an invented phrase has
// no such slice, and neither has a reworded one. A slice is never widened past the value's words: a
// sentence around a phrase can add a fact, a speaker or a question the model never read.
export function repairText(
  value: string,
  segment: string,
  grounding: Grounding,
  options: { firstPerson?: boolean } = {},
): { slice: string; rule: RepairRule } | null {
  const texting = groundTexting(value, segment);
  const window = wordWindow(value, segment);
  const close: { slice: string; rule: RepairRule }[] = [
    ...(texting === null || texting.rule === "one_edit" ? [] : [{ slice: texting.slice, rule: texting.rule }]),
    ...(window === null ? [] : [{ slice: window, rule: "word_window" as const }]),
  ];
  for (const one of close) {
    if (!oneSentence(one.slice)) continue;
    const kept = groundText(one.slice, segment, grounding);
    if (kept !== null && agrees(value, kept) && !governed(kept, value, segment, options.firstPerson === true))
      return { slice: kept, rule: one.rule };
  }
  return null;
}
