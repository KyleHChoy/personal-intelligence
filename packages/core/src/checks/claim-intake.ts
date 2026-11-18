import { KEY_FIELDS, LIFE_DOMAINS, type OwnerSideKind } from "@intelligence/contracts/personal";
import {
  afterNegation,
  beginsNegated,
  FIRST_PERSON_SUBJECTS,
  KEY_PHRASE_CODE_POINTS,
  KEY_PHRASE_WORDS,
  keyPhrase,
  NEGATIONS,
  statesTwoFacts,
  verbLike,
  withoutPictures,
  wordCount,
} from "../key-phrase.ts";
import { straightened, WORD } from "../text.ts";
import { agentInstruction, datedTask, namesPerson } from "./kind-checks.ts";

// The claim intake: the one check of a fact's typed key fields, for every source. Mail claims (the
// extract package's check.ts, after their span is grounded), agent proposals and the owner's
// answers (the store at write time, and the extract package's proposal.ts again) all pass
// `checkKeyFields`; only the adapter that turns a source into typed fields differs. Pure, with
// pinned tables, so no fact is refused or kept by a model here.

// A word as the checks read it: NFKC, curly apostrophes straight, kept inside the word, so "I'll"
// is never "ill" and "we're" never "were". `raw` keeps its case, so an acronym (US, IT) is no
// pronoun. `exempt`: the token is part of a pinned technical pair ("I/O"), whose "I" is no pronoun;
// any other run of joined words is read word by word, so "him/her" points (when unsure, refuse).
type Token = { raw: string; word: string; exempt: boolean };
// The technical pairs whose words are no pronoun. Pinned: a change is a new decision.
const TECHNICAL_PAIRS: readonly string[] = Object.freeze(["i/o"]);
const TECHNICAL = new Set(TECHNICAL_PAIRS);
const tokensOf = (text: string): Token[] =>
  [...straightened(text).matchAll(/\S+/gu)].flatMap((run) => {
    const exempt = TECHNICAL.has(run[0].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    return [...run[0].matchAll(WORD)].map((match) => ({ raw: match[0], word: match[0].toLowerCase(), exempt }));
  });
// Two or more letters, all capitals: an acronym, never a pronoun or a pointer word.
const acronym = (token: Token): boolean =>
  /\p{L}.*\p{L}/u.test(token.raw) && token.raw === token.raw.toUpperCase() && token.raw !== token.word;

// The owner's lists. Pinned, provisional: a change is a new decision.
// First-person words refused anywhere after that leading subject.
const FIRST_PERSON = new Set([...FIRST_PERSON_SUBJECTS, "mine", "myself", "us", "our", "ours", "ourselves"]);
// The first-person possessives a fact about the owner may hold after its first word ("finish my
// thesis", "grow our revenue"): the owner is its subject, so they name what is the owner's.
const OWNER_POSSESSIVES = new Set(["my", "our"]);
// "that" is a relative only after a noun and before a determiner that opens its clause's subject
// ("a job that the team likes"); "this" never is. A pronoun subject never makes one, since a
// pronoun or a first-person word is refused in its own right, and a subject relative ("a job that
// pays well") is refused by design. Anywhere else "that" points ("contact that investor").
const RELATIVE_SUBJECTS = new Set(["a", "an", "the", "my", "our"]);
// Pronouns and pointer words that name nothing on their own, with their contractions.
const POINTER_WORDS: readonly string[] = Object.freeze([
  "them",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "he",
  "she",
  "they",
  "him",
  "her",
  "his",
  "hers",
  "their",
  "it's",
  "it'll",
  "that's",
  "that'll",
  "there's",
  "here's",
  "he's",
  "he'll",
  "he'd",
  "she's",
  "she'll",
  "she'd",
  "they're",
  "they've",
  "they'll",
  "they'd",
]);
const POINTERS = new Set(POINTER_WORDS);
// Relative time words, each a sequence of words: refused unless a since, until or by date is given.
const RELATIVE_TIME: readonly string[] = Object.freeze([
  "today",
  "tomorrow",
  "yesterday",
  "tonight",
  "this week",
  "last week",
  "next week",
  "recently",
  "soon",
  "lately",
]);
const RELATIVE = RELATIVE_TIME.map((entry) => entry.split(" "));
// Function words: a phrase of these alone says nothing (standsAlone). No negation, modal,
// quantifier or word of comparison is one.
const FUNCTION_WORDS: readonly string[] = Object.freeze(
  (
    "a an the and or but of to in on at by for with from as into onto about then so if " +
    "is are was were be been being am do does did done have has had having " +
    "this that these those it its i me my we us our you your he him his she her they them their there here " +
    "what which who whom whose when where why how"
  ).split(" "),
);
const FUNCTION = new Set(FUNCTION_WORDS);
const NEGATION_WORDS = new Set(NEGATIONS.filter((entry) => !entry.includes(" ")));
// The words a phrase may add to the quote's: articles, and the owner's possessives. Every other
// word of a phrase, a function word included, is the quote's.
const ADDABLE = new Set(["a", "an", "the", "my", "our"]);
// A negation, apostrophes dropped: not, no, never, and every n't contraction, written with its
// apostrophe or without (dont, isnt, wont, cannot). A modal is none: the claim's type carries what
// a modal says ("can" a capability, "should" a goal), and its key drops it.
const NEGATIONS_OF_CLAUSE = new Set([
  "not",
  "no",
  "never",
  "cannot",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "wont",
  "cant",
  "couldnt",
  "shouldnt",
  "wouldnt",
  "havent",
  "hasnt",
  "hadnt",
  "mustnt",
  "mightnt",
  "neednt",
  "aint",
]);
const negation = (word: string): boolean => NEGATIONS_OF_CLAUSE.has(word.replaceAll("'", "")) || word.endsWith("n't");
// The words word grounding may not skip between two words it matched, since leaving one out
// reverses or narrows what was said: a negation, or a word of contrast.
const CONTRAST = new Set(["over", "instead", "rather", "than", "except", "but"]);

// A word folded for grounding: a possessive and apostrophes dropped, and a simple plural to its
// singular, so "Fridays" is "Friday" and "parties" is "party".
function folded(word: string): string {
  const bare = word.replace(/'s$/u, "").replaceAll("'", "");
  if (bare.length > 4 && bare.endsWith("ies")) return `${bare.slice(0, -3)}y`;
  if (bare.length > 3 && /(?:s|x|z|ch|sh)es$/u.test(bare)) return bare.slice(0, -2);
  if (bare.length > 3 && bare.endsWith("s") && !bare.endsWith("ss")) return bare.slice(0, -1);
  return bare;
}
const isContent = (token: Token): boolean =>
  !FUNCTION.has(token.word) || NEGATION_WORDS.has(token.word.replaceAll("'", ""));

// A single line break inside a phrase is a wrapped line, read as a space; a blank line still ends a
// sentence.
const unwrapped = (text: string): string =>
  text
    .split(/\n\s*\n/u)
    .map((part) => part.replace(/\s*\n\s*/gu, " "))
    .join("\n\n");

// A list of three or more items, comma-separated: "Seattle, New York, and LA". A comma inside a
// number ("1,000,000") separates nothing.
export const listsThree = (text: string): boolean =>
  text.split(/,\s+/u).filter((part) => part.trim() !== "").length >= 3;

// The tokens after one leading first-person subject standing as its own word, which the key drops.
const afterSubject = (tokens: Token[]): Token[] =>
  tokens.length > 1 && tokens[0]?.exempt === false && FIRST_PERSON_SUBJECTS.includes(tokens[0].word)
    ? tokens.slice(1)
    : tokens;

// A relative "that" mid-phrase: after a noun (a word that carries meaning, no verb and no pointer)
// and before its clause's subject ("a job that the team likes"). "this" is never one.
const relativeClause = (rest: Token[], n: number): boolean => {
  const before = rest[n - 1];
  const after = rest[n + 1];
  return (
    rest[n]?.word === "that" &&
    before !== undefined &&
    after !== undefined &&
    !FUNCTION.has(before.word) &&
    !verbLike(before.word) &&
    RELATIVE_SUBJECTS.has(after.word)
  );
};

// Whether a key phrase makes sense with no conversation around it: no pronoun or pointer word
// standing as its own word but a relative, no first-person word but one leading subject (and,
// for a fact about the owner, a possessive after the phrase's first word), no relative time word
// unless `dated`, and one word that carries meaning.
export function standsAlone(text: string, dated: boolean, owner = false): boolean {
  const tokens = tokensOf(text);
  const rest = afterSubject(tokens);
  const points = (token: Token, n: number): boolean =>
    !token.exempt &&
    !acronym(token) &&
    ((POINTERS.has(token.word) && !relativeClause(rest, n)) ||
      (FIRST_PERSON.has(token.word) && !(owner && n > 0 && OWNER_POSSESSIVES.has(token.word))));
  if (rest.some(points)) return false;
  const words = tokens.map((token) => token.word.replace(/'s$/u, ""));
  const relative = RELATIVE.some((entry) => words.some((_, n) => entry.every((word, k) => words[n + k] === word)));
  if (relative && !dated) return false;
  return rest.some(isContent);
}

// Words that stand in for content not yet written. Pinned: a change is a new decision.
const PLACEHOLDER_WORDS: readonly string[] = Object.freeze(
  "x xx xxx xyz test tests testing tbd tba todo fixme wip placeholder foo bar baz lorem ipsum dolor amet asdf qwerty na none null nil undefined dummy blah untitled misc etc stuff something thing things".split(
    " ",
  ),
);
const PLACEHOLDERS = new Set(PLACEHOLDER_WORDS);
const SUMMARY_MIN_WORDS = 3;
const SUMMARY_MIN_MEANINGFUL = 2;
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// Whether a work summary (propose_opportunity, propose_task, propose_hypothesis) names the work
// itself: at least SUMMARY_MIN_WORDS words with a letter, of which at least SUMMARY_MIN_MEANINGFUL
// distinct ones (folded) carry meaning: two letters or more, no function word (standsAlone's list)
// and no placeholder. Words are read as the claim checks read them. standsAlone's pointer,
// first-person and relative time rules are not applied: a summary is a sentence of up to 280 code
// points whose pronoun names something earlier in it ("ask Dana whether she can introduce him"),
// written by an agent in its own voice, beside a dueAt that dates it. In a script written without
// spaces (Han, kana, Thai, Lao, Khmer, Myanmar) each letter is read as one word that carries
// meaning, since no space marks where its words end.
export function summaryStandsAlone(text: string): boolean {
  const words = tokensOf(text).flatMap(({ word }) =>
    UNSPACED.test(word)
      ? [...word].filter((letter) => /\p{L}/u.test(letter)).map((letter) => ({ word: letter, unspaced: true }))
      : /\p{L}/u.test(word)
        ? [{ word, unspaced: false }]
        : [],
  );
  const meaningful = words.filter(
    ({ word, unspaced }) => unspaced || ([...word].length >= 2 && !FUNCTION.has(word) && !PLACEHOLDERS.has(word)),
  );
  return (
    words.length >= SUMMARY_MIN_WORDS &&
    new Set(meaningful.map(({ word }) => folded(word))).size >= SUMMARY_MIN_MEANINGFUL
  );
}

// The quote's words, each folded and with the number of its clause: a clause ends at a sentence
// mark, a semicolon, a colon, a comma or a line break.
type Said = { word: string; folded: string; clause: number };
const saidOf = (quote: string): Said[] =>
  quote
    .split(/[.;:!?,\n]+/u)
    .flatMap((part, clause) =>
      tokensOf(part).map((token) => ({ word: token.word, folded: folded(token.word), clause })),
    );
// Whether a negation stands anywhere before the quote's word at `start` in its clause, which a
// phrase beginning there leaves out ("want to manage people" from "I do not really want to manage
// people").
const negatedBefore = (said: readonly Said[], start: number): boolean => {
  const clause = said[start]?.clause;
  return said.some((one, k) => k < start && one.clause === clause && negation(one.word));
};

// Every word of a phrase is a word of the quote, folded, in the order the quote says them (a
// subsequence), but an article or the owner's possessive, which it may add. A function word counts
// as any other ("move to Portland from Denver" is no grounding of "move from Portland to Denver");
// no negation stands before its first word in its clause; and it skips no negation or word of
// contrast between two words it matched ("remote and hybrid" from "remote and not hybrid", "prefer
// remote" from "prefer office over remote"). Checked once, when the store takes the body: the
// pipeline never grounds again.
export function wordGrounded(text: string, quote: string): boolean {
  const said = saidOf(quote);
  const words = tokensOf(text).filter((token) => !ADDABLE.has(token.word));
  const at: number[] = [];
  for (const token of words) {
    const found = said.findIndex((one, n) => n > (at.at(-1) ?? -1) && one.folded === folded(token.word));
    if (found < 0) return false;
    at.push(found);
  }
  const skips = at.some(
    (n, k) =>
      k > 0 && said.slice((at[k - 1] as number) + 1, n).some((one) => negation(one.word) || CONTRAST.has(one.word)),
  );
  return at.length > 0 && words.some(isContent) && !skips && !negatedBefore(said, at[0] as number);
}

// Every word of the phrase, in a run of the quote's words, case and punctuation aside, with no
// negation before it in its clause. An answer's phrases are held to this when the store takes the
// answer.
export function sliceGrounded(text: string, quote: string): boolean {
  const said = saidOf(quote);
  const words = tokensOf(text).map((token) => token.word);
  return (
    words.length > 0 &&
    said.some((_, n) => words.every((word, k) => said[n + k]?.word === word) && !negatedBefore(said, n))
  );
}

export type KeyFieldsRefusal = "bad_fields" | "multi_fact" | "negated_object" | "not_standalone";
// The classifier's guards, given only with `kinds`: kept as guards on the classifier's typing,
// not as a contract an agent's own fields are held to.
export type KindRefusal = "dated_task" | "agent_instruction" | "not_about_owner";
export type KeyFieldsVerdict<R extends string = KeyFieldsRefusal> = { fields: Record<string, unknown> } | { reason: R };

const isDomain = (value: unknown): boolean =>
  typeof value === "string" && (LIFE_DOMAINS as readonly string[]).includes(value);
const dated = (fields: Readonly<Record<string, unknown>>): boolean =>
  ["since", "until", "by", "when"].some((name) => typeof fields[name] === "string" && fields[name] !== "");
// The code points are counted without the pictures (withoutPictures), as the words are; and,
// pictures included, at most twice as many, so no run of emoji is unbounded.
const bounded = (text: string): boolean =>
  wordCount(text) <= KEY_PHRASE_WORDS &&
  [...withoutPictures(text)].length <= KEY_PHRASE_CODE_POINTS &&
  [...text].length <= 2 * KEY_PHRASE_CODE_POINTS &&
  keyPhrase(text) !== "";

// The kinds whose typed fields the claim intake checks: the owner-side kinds (a view, a status and
// a visit among them), and a role and an affiliation, which take no domain.
export type CheckedKind = OwnerSideKind | "role" | "affiliation";

// An organization's name is a proper name ("Here Technologies" names a thing), so it is held to the
// bounds alone.
function checkNamed(
  kind: "role" | "affiliation",
  fields: Readonly<Record<string, unknown>>,
  owner: boolean,
): KeyFieldsVerdict {
  const title = fields.title;
  const name = fields.organization_name;
  if (kind === "role" && typeof title !== "string") return { reason: "bad_fields" };
  if ((typeof title === "string" && !bounded(title)) || (typeof name === "string" && !bounded(name)))
    return { reason: "bad_fields" };
  if (typeof title === "string" && !standsAlone(title, dated(fields), owner)) return { reason: "not_standalone" };
  return { fields: { ...fields } };
}

// The check of an owner-side fact's typed key fields, whatever its source: a domain of the list; a
// key phrase of at most 12 words and 90 code points with a word in it (`bad_fields`); one fact, not
// two and not a list of three (`multi_fact`); a preference's leading negation moved into its
// polarity, only `prefers` flipping, the object the text after it (`negated_object` for one still
// negated or a double negative); and a phrase that stands alone (`not_standalone`). A role or an
// affiliation: checkNamed. Answers the fields, with the one rewrite, or the refusal. `owner`: the
// claim's subject is the owner (standsAlone's possessives).
//
// A view's topic and a status's organization and state are held to the bounds too, and a status
// names its organization and its state. With `kinds` (an agent's write after the switch, or an
// extraction prompt version that offers the view, status and visit kinds), the pinned kind rules
// follow (kind-checks.ts), each code saying where the fact belongs: a situation that is a dated task
// (`dated_task`, `at` when it was stated); a preference, a constraint or a situation that instructs
// the owner's agents (`agent_instruction`, `clients` their registered clients' names; an opening imperative
// only for a preference or a constraint); and an owner's fact that names a person the store
// resolved (`not_about_owner`, `people` their names). Without `kinds` a stored record is checked as
// before, so no rebuild drops a fact the owner confirmed.
export type KindOptions = { at?: string | undefined; clients?: readonly string[]; people?: readonly string[] };
const SECOND_FIELDS: Readonly<Partial<Record<OwnerSideKind, readonly { name: string; required: boolean }[]>>> = {
  view: [{ name: "topic", required: false }],
  status: [
    { name: "organization_name", required: true },
    { name: "state", required: true },
  ],
};
const INSTRUCTED: ReadonlySet<CheckedKind> = new Set(["preference", "constraint", "situation"]);
const IMPERATIVE: ReadonlySet<CheckedKind> = new Set(["preference", "constraint"]);
export function checkKeyFields(
  kind: CheckedKind,
  given: Readonly<Record<string, unknown>>,
  options?: { owner?: boolean },
): KeyFieldsVerdict;
export function checkKeyFields(
  kind: CheckedKind,
  given: Readonly<Record<string, unknown>>,
  options: { owner?: boolean; kinds?: KindOptions },
): KeyFieldsVerdict<KeyFieldsRefusal | KindRefusal>;
export function checkKeyFields(
  kind: CheckedKind,
  given: Readonly<Record<string, unknown>>,
  options: { owner?: boolean; kinds?: KindOptions } = {},
): KeyFieldsVerdict<KeyFieldsRefusal | KindRefusal> {
  const owner = options.owner ?? false;
  if (kind === "role" || kind === "affiliation") return checkNamed(kind, given, owner);
  const name = KEY_FIELDS[kind].phrase;
  const phrase = given[name];
  if (!isDomain(given.domain) || typeof phrase !== "string") return { reason: "bad_fields" };
  if (!bounded(phrase)) return { reason: "bad_fields" };
  for (const field of SECOND_FIELDS[kind] ?? []) {
    const value = given[field.name];
    if (value === undefined ? field.required : typeof value !== "string" || !bounded(value))
      return { reason: "bad_fields" };
  }
  const flat = unwrapped(phrase);
  if (statesTwoFacts(flat) || listsThree(flat)) return { reason: "multi_fact" };
  const fields: Record<string, unknown> = { ...given };
  const rest = kind === "preference" ? afterNegation(phrase) : null;
  if (rest !== null) {
    if (fields.polarity !== "prefers" || rest === "" || beginsNegated(rest)) return { reason: "negated_object" };
    Object.assign(fields, { [name]: rest, polarity: "avoids" });
  }
  if (!standsAlone(fields[name] as string, dated(fields), owner)) return { reason: "not_standalone" };
  const refusal =
    options.kinds === undefined ? null : kindRefusal(kind, fields, fields[name] as string, owner, options.kinds);
  return refusal === null ? { fields } : { reason: refusal };
}

// The pinned kind rules, after every other check, in this order.
function kindRefusal(
  kind: OwnerSideKind,
  fields: Readonly<Record<string, unknown>>,
  phrase: string,
  owner: boolean,
  options: KindOptions,
): KindRefusal | null {
  if (INSTRUCTED.has(kind) && agentInstruction(phrase, IMPERATIVE.has(kind), options.clients ?? []))
    return "agent_instruction";
  if (owner && namesPerson(phrase, options.people ?? [])) return "not_about_owner";
  if (kind === "situation" && datedTask(phrase, fields, options.at)) return "dated_task";
  return null;
}

// An interpretation's own checks, after its key fields pass checkKeyFields.
// The statement is the agent's wording, so word grounding and the first-person rule do not apply;
// two stand-alone rules do: no relative time word unless the fields carry a date, and no opening
// pointer word that names nothing (`not_standalone`). A quote that is the statement or holds it
// whole, compared word by word, is the agent's words passed off as the owner's (`not_owner_words`);
// the statement may hold a quote, which still reads as the owner's.
const OPENING_POINTERS = new Set([
  "it",
  "its",
  "it's",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "there's",
  "here's",
  "that's",
]);
export type InterpretationRefusal = "not_standalone" | "not_owner_words";
export function interpretationRefusal(
  statement: string,
  quotes: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): InterpretationRefusal | null {
  const tokens = tokensOf(statement);
  const first = tokens[0];
  if (first === undefined || (!first.exempt && !acronym(first) && OPENING_POINTERS.has(first.word)))
    return "not_standalone";
  const words = tokens.map((token) => token.word.replace(/'s$/u, ""));
  if (!dated(fields) && RELATIVE.some((entry) => words.some((_, n) => entry.every((word, k) => words[n + k] === word))))
    return "not_standalone";
  return passedOffAsOwners(statement, quotes) ? "not_owner_words" : null;
}

// `not_owner_words`, the one check: a quote with no word in it, or one that is the statement or
// holds it whole, compared word by word. The statement is whatever is not the owner's: an agent's
// wording, or the text of the question a relayed answer answers.
export function passedOffAsOwners(statement: string, quotes: readonly string[]): boolean {
  const flat = (text: string): string =>
    ` ${tokensOf(text)
      .map((token) => token.word)
      .join(" ")} `;
  const said = flat(statement);
  return quotes.some((quote) => flat(quote).trim() === "" || (said.trim() !== "" && flat(quote).includes(said)));
}

// The line a fact renders as on a page, from its kind and typed fields alone: what the claim
// intake's model check is shown.
export function factLine(kind: CheckedKind, fields: Readonly<Record<string, unknown>>): string {
  const organization = typeof fields.organization_name === "string" ? ` at ${fields.organization_name}` : "";
  if (kind === "role") return `${String(fields.title ?? "")}${organization}`;
  if (kind === "affiliation") {
    const relation = String(fields.relation ?? "");
    return `${relation.charAt(0).toUpperCase()}${relation.slice(1)}${organization}`;
  }
  const said = String(fields[KEY_FIELDS[kind].phrase] ?? "");
  const at = (word: string, name: string): string =>
    typeof fields[name] === "string" ? `, ${word} ${fields[name] as string}` : "";
  switch (kind) {
    case "goal":
      return `Goal: ${said}${at("by", "by")}`;
    case "need":
      return `Need: ${said}${at("by", "by")}`;
    case "capability":
      return `Capability: ${said}`;
    case "preference": {
      const polarity = String(fields.polarity ?? "");
      return `${polarity.charAt(0).toUpperCase()}${polarity.slice(1)}: ${said}`;
    }
    case "constraint":
      return `Constraint: ${said}${at("until", "until")}`;
    case "situation":
      return `Situation: ${said}${at("until", "until")}`;
    case "view":
      return typeof fields.topic === "string" ? `View on ${fields.topic as string}: ${said}` : `View: ${said}`;
    case "status":
      return `${String(fields.organization_name ?? "")}, ${said}: ${String(fields.state ?? "")}${at("since", "since")}`;
    case "visited":
      return `Visited: ${said}${at("in", "when")}`;
  }
}
