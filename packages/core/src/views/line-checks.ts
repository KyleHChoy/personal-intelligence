// Judgments of one rendered belief line, each from the line alone: too thin to lead, an instruction
// to agents, stale, an administrative notice, and how much it helps.
import {
  type BeliefLine,
  type BeliefTier,
  NOTICE_LAPSE_DAYS,
  type PersonalBeliefKind,
  SELF_LOW_USE,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "../days.ts";
import { dayIsOver, lastDayNamed, relativeEnd } from "../own-dates.ts";

// A line that is its phrase and nothing else, at most this many words of it, says too little to
// lead: "Goal: the Monday", "Situation: traveling". Whatever a line's kind types beside a phrase (a
// role's organization, a relationship's person, a place visited) stands on its own, so only these
// kinds can be one.
export const FRAGMENT_WORDS = 2;
const PHRASE_KINDS: ReadonlySet<PersonalBeliefKind> = new Set([
  "goal",
  "need",
  "capability",
  "preference",
  "constraint",
  "situation",
  "view",
  "decision",
  "commitment",
]);
// What the templates add after a phrase (`wordsOf`): its deadline and its other party.
const TYPED_TAIL = /(?:, (?:by|until|due|with) [^,]*)+$/;

// A capability is a lasting thing the owner can do: said once, in three words, it is more often a task
// lifted from a sentence, so it needs one word more to stand.
const CAPABILITY_FRAGMENT_WORDS = 3;
const fragmentLimit = (line: BeliefLine): number =>
  line.kind === "capability" && line.cites === 1 && line.tier !== "owner_confirmed"
    ? CAPABILITY_FRAGMENT_WORDS
    : FRAGMENT_WORDS;

export function isFragment(line: BeliefLine): boolean {
  if (!PHRASE_KINDS.has(line.kind)) return false;
  const text = line.line.untrusted;
  const phrase = text.slice(text.indexOf(": ") + 2).replace(TYPED_TAIL, "");
  return phrase.split(/\s+/).filter((word) => word !== "").length <= fragmentLimit(line);
}
// A fragment as a domain's read marks it: a page leaves off the same ones.
export const isThin = (line: BeliefLine): boolean =>
  isFragment(line) && line.tier !== "owner_confirmed" && line.kind !== "constraint";

// A preference about how an agent should work is an instruction, not something about the owner's
// life: a pinned list, general and about no one, each entry a whole word or phrase in any case. It
// reads a phrase's form alone, so it can miss one and can catch a preference that merely mentions
// these words; either way the line stays served, only later.
const AGENT_INSTRUCTION_WORDS: readonly string[] = Object.freeze([
  "agent",
  "agents",
  "assistant",
  "assistants",
  "ai",
  "chatbot",
  "llm",
  "prompt",
  "prompts",
  "draft",
  "drafts",
  "drafting",
  "writing style",
  "tone",
  "em dash",
  "em dashes",
  "em-dash",
  "em-dashes",
  "markdown",
  "formatting",
  "bullet points",
  "replies",
  "responses",
  "pull request",
  "pull requests",
  "commit message",
  "commit messages",
]);
const AGENT_INSTRUCTION = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${AGENT_INSTRUCTION_WORDS.map((word) => word.replace(" ", "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
export const isAgentInstruction = (line: BeliefLine): boolean =>
  line.kind === "preference" && AGENT_INSTRUCTION.test(line.line.untrusted);

const OWN_TIERS: ReadonlySet<BeliefTier> = new Set(["owner", "owner_confirmed", "owner_relayed"]);
// What the owner is like, which reads after what they are in the middle of.
const TRAIT_KINDS: ReadonlySet<PersonalBeliefKind> = new Set(["preference", "capability", "view", "visited"]);
const ENDED: ReadonlySet<string> = new Set(["expired", "closed", "dormant"]);

// What the owner confirmed on a card lasts longer; their own mail or chat said it once, which says no
// more of today than a source's line does. A goal, a constraint or a trait does not pass by time alone,
// and neither does a line with a date still ahead. A line's own words can say sooner: a date that has
// gone, of any kind that says what is going on, or a count or a span from when it was said.
const STALE_DAYS = 30;
const STALE_CONFIRMED_DAYS = 90;
const PASSING_KINDS: ReadonlySet<PersonalBeliefKind> = new Set(["situation", "need", "status"]);
const DATED_KINDS: ReadonlySet<PersonalBeliefKind> = new Set([...PASSING_KINDS, "goal", "constraint"]);
const wordsOfLine = (line: BeliefLine): string => {
  const text = line.line.untrusted;
  return text.slice(text.indexOf(": ") + 2).replace(TYPED_TAIL, "");
};
const endAhead = (line: BeliefLine, now: Date): boolean => {
  const end = line.until ?? line.by;
  return end !== undefined && Date.parse(end) >= now.getTime();
};

// The day a line says by: its `until` or `by`, or else the day its own words name, when it has gone and
// was still to come when the line was first said: what began on a date, that day included, holds past it.
export function pastOnOf(line: BeliefLine, now: Date): string | undefined {
  if (!DATED_KINDS.has(line.kind) || ENDED.has(line.status) || endAhead(line, now)) return undefined;
  const end = (line.until ?? line.by)?.slice(0, 10);
  if (end !== undefined) return dayIsOver(end, now) ? end : undefined;
  const said = line.since.slice(0, 10);
  const named = lastDayNamed(wordsOfLine(line), said);
  return named !== null && named > said && dayIsOver(named, now) ? named : undefined;
}

export function isStale(line: BeliefLine, now: Date): boolean {
  if (!DATED_KINDS.has(line.kind) || ENDED.has(line.status) || endAhead(line, now)) return false;
  if (pastOnOf(line, now) !== undefined) return true;
  if (!PASSING_KINDS.has(line.kind)) return false;
  const relative = relativeEnd(wordsOfLine(line), line.at);
  if (relative !== null && relative <= now.getTime()) return true;
  const days = line.tier === "owner_confirmed" ? STALE_CONFIRMED_DAYS : STALE_DAYS;
  return now.getTime() - Date.parse(line.at) > days * DAY_MS;
}

// A pinned list over the line's own words, each a whole word or phrase; the owner's own word is never
// one. It can miss a notice worded otherwise, which then ranks as any source's line.
const ADMIN_NOTICE_WORDS: readonly string[] = Object.freeze([
  "out for delivery",
  "was delivered",
  "been delivered",
  ": delivered",
  "your delivery",
  "delivery update",
  "your shipment",
  "shipping update",
  "tracking number",
  "your parcel",
  "your package",
  "your order",
  "order confirmation",
  "receipt",
  "your invoice",
  "your statement",
  "statement is",
  "account statement",
  "monthly statement",
  "autopay",
  "payment due",
  "payment received",
  "your payment",
  "return request",
  "your bill",
  "your subscription",
  "renewal notice",
  "your account",
  "your password",
  "password reset",
  "sign-in",
  "new login",
  "verification code",
  "security alert",
]);
const ADMIN_NOTICE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ADMIN_NOTICE_WORDS.map((word) => word.replace(" ", "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
const NOTICE_KINDS: ReadonlySet<PersonalBeliefKind> = new Set(["situation", "status", "need"]);
export const isAdminNotice = (line: BeliefLine): boolean =>
  NOTICE_KINDS.has(line.kind) &&
  line.tier !== null &&
  !OWN_TIERS.has(line.tier) &&
  line.tier !== "system_notice" &&
  ADMIN_NOTICE.test(line.line.untrusted);

// With `now`, a first read's, a stale line and an administrative notice are too thin to lead as
// well; a person's card passes no clock.
export function useBandOf(line: BeliefLine, now?: Date): number {
  if (line.tier === "system_notice") return 5;
  if (ENDED.has(line.status)) return 4;
  if (isFragment(line) || isAgentInstruction(line)) return SELF_LOW_USE;
  if (now !== undefined && isAdminNotice(line)) return SELF_LOW_USE;
  // The owner's own word gone stale still ranks with a source's current line, so a cut never drops it first.
  if (now !== undefined && isStale(line, now)) return line.tier !== null && OWN_TIERS.has(line.tier) ? 2 : SELF_LOW_USE;
  if (line.tier === null || !OWN_TIERS.has(line.tier)) return 2;
  return TRAIT_KINDS.has(line.kind) ? 1 : 0;
}
// A line kept out of a page's head, and still served after it.
export const isLowUse = (line: BeliefLine): boolean => useBandOf(line) >= SELF_LOW_USE;

export const noticeLapsed = (line: BeliefLine, now: Date): boolean =>
  line.notice !== undefined && now.getTime() - Date.parse(line.notice.sentAt) > NOTICE_LAPSE_DAYS * DAY_MS;
