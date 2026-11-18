import {
  BELIEF_KINDS_BY_SUBJECT,
  type CompiledBelief,
  CompiledFacts,
  type FactView,
  OPEN_BELIEF_STATUS,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";

// One entity's compiled facts: the personal page, assembled by code at each read from rows the
// caller's token returned, and never stored. Pure: the reader's fixed statements gather the input;
// this orders and cuts it.

export const MAX_BELIEFS = 200;
export const MAX_CLAIMS = 20;

export type CompileInput = {
  subjectKind: SubjectKind;
  // The entity's beliefs, each with its citing claims, latest first, in any order.
  beliefs: CompiledBelief[];
  // Claims about the entity that count in no belief, in any order.
  claims: FactView[];
  // The reader stopped short of every row.
  more: boolean;
};

// What a belief is ordered by: its kind, its status, when it was last confirmed, its fact key
// fingerprint and its subject's kind.
export type BeliefOrder = { kind: string; status: string; confirmedAt: string; fact: string; subjectKind: SubjectKind };

const rankOf = (subjectKind: SubjectKind, kind: string): number => {
  const order = BELIEF_KINDS_BY_SUBJECT[subjectKind];
  const at = order.indexOf(kind as (typeof order)[number]);
  return at === -1 ? order.length : at;
};

// The order of beliefs: by kind in the subject kind's order, then open first, then the latest
// confirmed, then by fact. get_beliefs orders beliefs of several subjects by it, every one
// ranked by the People view's list of kinds, whatever its subject.
export const byBeliefOrder = (a: BeliefOrder, b: BeliefOrder): number =>
  rankOf(a.subjectKind, a.kind) - rankOf(b.subjectKind, b.kind) ||
  Number(OPEN_BELIEF_STATUS.has(b.status)) - Number(OPEN_BELIEF_STATUS.has(a.status)) ||
  Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) ||
  byText(a.fact, b.fact);

// Beliefs in byBeliefOrder; claims newest first, then by id. Every comparison is on the
// rows given.
export function compileFacts(input: CompileInput): CompiledFacts {
  const order = (one: CompiledBelief): BeliefOrder => ({ ...one, subjectKind: input.subjectKind });
  const beliefs = input.beliefs
    .filter((belief) => belief.cites.length > 0)
    .sort((a, b) => byBeliefOrder(order(a), order(b)));
  const claims = [...input.claims].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || byText(a.id, b.id));
  return CompiledFacts.parse({
    beliefs: beliefs.slice(0, MAX_BELIEFS),
    claims: claims.slice(0, MAX_CLAIMS),
    more: input.more || beliefs.length > MAX_BELIEFS || claims.length > MAX_CLAIMS,
  });
}

// meeting_prep@4's facts: what the store knows of each attendee, the kinds that say who someone is
// and how they may be approached.
export const ATTENDEE_FACT_KINDS = Object.freeze([
  "role",
  "affiliation",
  "relationship",
  "need",
  "contact_rule",
  "consent",
] as const);
export const PER_ATTENDEE_FACTS = 5;
const ATTENDEE_KINDS: ReadonlySet<string> = new Set(ATTENDEE_FACT_KINDS);

// Whether a belief is one meeting_prep@4 shows of an attendee: open, of one of those kinds. The
// reader asks it of each opened belief before it reads any claim, and attendeeFacts again.
export const isAttendeeFact = (belief: { kind: string; status: string }): boolean =>
  ATTENDEE_KINDS.has(belief.kind) && OPEN_BELIEF_STATUS.has(belief.status);

// For each attendee in the order given, their open beliefs of those kinds, in compileFacts'
// order, at most five each. Pure, over the beliefs the reader compiled under the caller's token.
export function attendeeFacts(
  attendees: readonly { id: string; kind: SubjectKind }[],
  beliefs: readonly CompiledBelief[],
): CompiledBelief[] {
  return attendees.flatMap((attendee) => {
    const theirs = beliefs.filter((belief) => belief.subject.id === attendee.id && isAttendeeFact(belief));
    return compileFacts({ subjectKind: attendee.kind, beliefs: theirs, claims: [], more: false }).beliefs.slice(
      0,
      PER_ATTENDEE_FACTS,
    );
  });
}

// Whether a claim about the owner, taken from what someone wrote, is one of the
// owner's own facts: the owner wrote it (`ownerSaid`, their entity is its speaker, as code resolved
// it, not as the model's basis says), about themselves, and it states something. A question, a
// proposal or offer, an objection or a hypothesis is not a fact about the owner, whatever its type:
// "where should I park?" is no need, "happy to share more" no capability, "would love to talk" no
// goal. The belief build counts no other message claim about the owner, and get_self lists none of
// their own that
// fails it. A reversal states that something ended, so it counts and closes the belief.
const STATING: ReadonlySet<string> = new Set(["stated_fact", "decision", "reversal"]);

export const ownStatement = (claim: { basis: string; statementKind: string }, ownerSaid: boolean): boolean =>
  ownerSaid && claim.basis === "explicit_self" && STATING.has(claim.statementKind);

// The words that tie what someone wrote to the day it was written or the next. A
// situation that holds one is momentary, and an owner's question that holds one is logistics, not
// a lasting need. A pinned list, general and about no one: each entry a whole word or phrase, any
// case. "this week" and later are left out: a week is long enough to plan around.
export const SHORT_TIME_WORDS: readonly string[] = Object.freeze([
  "today",
  "tonight",
  "tomorrow",
  "tmrw",
  "this morning",
  "this afternoon",
  "this evening",
  "right now",
]);

const SHORT_TIME = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${SHORT_TIME_WORDS.map((word) => word.replace(" ", "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

export const saysShortTime = (text: string): boolean => SHORT_TIME.test(text);
