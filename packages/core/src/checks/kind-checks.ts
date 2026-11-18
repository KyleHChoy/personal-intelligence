import { DAY_MS, MONTH_WORD } from "../days.ts";
import { type Word, wordsOf } from "../text.ts";

// The pinned rules that refuse a fact filed under the wrong kind, each with a code that says where
// it belongs. Pure, with pinned tables: a change to them is a decision of its own. A model proposes
// the kind; these rules only refuse.

// Whether `entry`, a sequence of lowered words, stands in `words`.
const holds = (words: readonly Word[], entry: readonly string[]): boolean =>
  words.some((_, n) => entry.every((one, k) => words[n + k]?.word === one));

// `dated_task`: the words of a task, a deadline, an appointment or a code, each a sequence of
// words. A situation that holds one is refused unless it lasts longer (DATED_TASK_DAYS).
const DATED_TASK_WORDS: readonly string[] = Object.freeze([
  "due",
  "deadline",
  "appointment",
  "appt",
  "reservation",
  "booking",
  "code",
  "verification",
  "otp",
  "ticket",
  "invoice",
  "bill",
  "rsvp",
  "reminder",
  "submit",
  "submission",
  "pay by",
  "renew by",
  "expires",
]);
const TASK = DATED_TASK_WORDS.map((entry) => entry.split(" "));
// A date or a time written in the phrase: an ISO or a full numeric date, a month's name beside a
// day, a weekday, or a clock time.
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun";
const DATE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b\d{4}-\d{1,2}-\d{1,2}\b/u,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/u,
  new RegExp(
    `\\b(?:${MONTH_WORD})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_WORD})\\b`,
    "iu",
  ),
  new RegExp(`\\b(?:on|by|this|next|before|until)\\s+(?:${WEEKDAYS})\\b`, "iu"),
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/iu,
]);
// A situation whose `until` is more than this many days after it was stated lasts longer than a
// task, and is exempt; one whose `until` is within it is a dated task.
const DATED_TASK_DAYS = 14;

// `fields` the situation's, `at` when it was stated (the record's time, or now at the store).
export function datedTask(phrase: string, fields: Readonly<Record<string, unknown>>, at: string | undefined): boolean {
  const until = typeof fields.until === "string" ? Date.parse(fields.until) : Number.NaN;
  const said = at === undefined ? Number.NaN : Date.parse(at);
  const known = Number.isFinite(until) && Number.isFinite(said);
  if (known && until - said > DATED_TASK_DAYS * DAY_MS) return false;
  if (known) return true;
  const words = wordsOf(phrase);
  return TASK.some((entry) => holds(words, entry)) || DATE_PATTERNS.some((pattern) => pattern.test(phrase));
}

// `agent_instruction`: words that name an agent or a tool of one (never "AI" or "prompt", which a
// fact of the owner's life holds: "prefers AI startups", "prefers prompt replies"), and the imperative verbs a
// preference or a constraint never opens with; with the names of the owner's registered clients beside
// them, which the store gives.
const AGENT_WORDS: readonly string[] = Object.freeze([
  "agent",
  "agents",
  "assistant",
  "assistants",
  "autofill",
  "chatbot",
  "bot",
  "claude",
  "chatgpt",
  "gpt",
  "codex",
  "gemini",
  "copilot",
  "mcp",
]);
const AGENTS = AGENT_WORDS.map((entry) => entry.split(" "));
const IMPERATIVE_OPENERS: readonly string[] = Object.freeze([
  "use",
  "check",
  "try",
  "ask",
  "tell",
  "remind",
  "notify",
  "draft",
  "include",
  "ensure",
  "verify",
  "confirm",
  "search",
  "look up",
  "fill",
  "make sure",
  "please",
  "always",
  "do",
  "don't",
]);
const OPENERS = IMPERATIVE_OPENERS.map((entry) => entry.split(" "));

export function agentInstruction(phrase: string, imperative: boolean, clients: readonly string[]): boolean {
  const words = wordsOf(phrase);
  const named = [
    ...AGENTS,
    ...clients.map((name) => wordsOf(name).map((one) => one.word)).filter((entry) => entry.length > 0),
  ];
  if (named.some((entry) => holds(words, entry))) return true;
  return imperative && OPENERS.some((entry) => entry.every((one, k) => words[k]?.word === one));
}

// `not_about_owner`: the phrase names a person the store resolved (each a name as written, given by
// the store from the person entities the caller can see, never the owner's): a run of its words,
// each beginning with a capital as written in the phrase, so "will" is never "Will".
export function namesPerson(phrase: string, people: readonly string[]): boolean {
  const words = wordsOf(phrase);
  const capital = (one: Word): boolean => /^\p{Lu}/u.test(one.raw);
  return people.some((name) => {
    const entry = wordsOf(name).map((one) => one.word);
    if (entry.length === 0 || (entry.length === 1 && [...(entry[0] as string)].length < 3)) return false;
    return words.some((_, n) => entry.every((one, k) => words[n + k]?.word === one && capital(words[n + k] as Word)));
  });
}
