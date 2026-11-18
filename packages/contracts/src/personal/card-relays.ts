import { z } from "zod";
import type { KnownCardKind } from "./card-kinds.ts";
import { CardId, RequestId } from "./ids.ts";
import { CardDetail } from "./owner.ts";

// A card asked through an agent: the kinds routed to the role the owner names for questions, how
// long a routed card is held out of the owner's queue, the rules a relayed answer is taken by, and
// the shapes of the task's brief, of `relay_card_answer` and of the owner's list of relayed
// answers.

// The kinds asked through an agent, each a question that reaches the owner and takes an answer
// whose effect a relayed word may carry: a decision on work, and only where the work it decides is
// a read-only task; a lesson and a client preference, each guidance an agent other than its author
// relays; a question of the planner's for the owner; an idea; and a statement about the owner, whose
// relayed confirm is read at the `owner_relayed` tier and releases nothing (RELAYED_CONFIRM_KINDS).
// None releases, sends, pays or grants, and none writes the owner's own words or merges identities,
// since a relayed answer is applied as the owner's on one agent's word.
export const CARD_RELAY_KINDS = [
  "opportunity_decision",
  "lesson",
  "client_preference",
  "owner_question",
  "idea",
  "about_you",
] as const satisfies readonly KnownCardKind[];

// The kinds an agent is asked first (AGENT_ATTEMPT_KINDS) that are asked through an agent when that
// attempt does not settle the card: the agent answered cant_tell or an answer that is only attached,
// its task failed or ended, or the wait ran out. An agent's claim among them, its relayed confirm
// read at the `owner_relayed` tier. Never `shared_address`, whose `one_person` merges two people,
// nor `reminder`: its card is the reminder, due when it is raised, and goes to the owner at once;
// nor `relation_audit`: its answer is the owner's audit of a model's relation, which outranks agents'
// reports and switches a kind, so no agent's word may stand in for it.
export const CARD_RELAY_AFTER_ATTEMPT = [
  "same_fact",
  "time_effort",
  "tier_proposal",
  "agent_claim",
] as const satisfies readonly KnownCardKind[];

// The kinds whose relayed confirm is the owner's word relayed and no more: the belief build reads it
// through policy.relayed_claims at the `owner_relayed` tier, below the owner's own confirmation,
// which policy.confirmed_claims reads and which leaves a relayed decision out; it writes no release
// and settles no other card on its fact. The owner's own answer, or their reopen, lifts it.
export const RELAYED_CONFIRM_KINDS = ["about_you", "agent_claim"] as const satisfies readonly KnownCardKind[];
export const isRelayedConfirmKind = (kind: string): boolean =>
  (RELAYED_CONFIRM_KINDS as readonly string[]).includes(kind);

// Every kind a relay may answer: ledger.card_relay_kinds holds the same.
export const CARD_RELAYED_KINDS = [...CARD_RELAY_KINDS, ...CARD_RELAY_AFTER_ATTEMPT] as const;
export type CardRelayKind = (typeof CARD_RELAYED_KINDS)[number];
export const isCardRelayKind = (kind: string): kind is CardRelayKind =>
  (CARD_RELAYED_KINDS as readonly string[]).includes(kind);

// The kinds only the owner answers, on the page: a send, a grant or its lift, a research request
// (it spends and fetches from outside), a goal (its accept writes the agent's words as the owner's
// own goal, which drives work and which no reopen takes back), and a standing question rule (its
// words open to the owner's own reads alone, so no agent can put it). Neither ledger.answer_card
// nor ledger.relay_card_answer takes an answer on one (ledger.card_relay_never).
export const CARD_RELAY_NEVER = [
  "draft_waiting",
  "grant_suggestion",
  "grant_lift_suggestion",
  "research_request",
  "goal_proposal",
  "question_rule",
] as const satisfies readonly KnownCardKind[];

// How long a routed card is held out of the owner's queue while its task is open, and how long it
// waits for the tick to raise that task while a question role is set.
export const CARD_RELAY_HOURS = 48;
export const CARD_RELAY_GRACE_MINUTES = 15;
// A task no agent has claimed for this long no longer holds its card: the card is the owner's,
// and the task stays on the board.
export const CARD_RELAY_UNCLAIMED_HOURS = 6;

// The owner's words in a relay: at most this many characters.
export const CARD_RELAY_QUOTE_MOST = 2000;
// How many relayed answers a week the owner is shown with their quotes, chosen by code.
export const CARD_RELAY_SAMPLE = 3;

// Why a relay was refused: every code ledger.relay_card_answer answers but `ok`, `applied` and the
// plain `not_found` of a card the caller cannot see, each decided from what the caller can see.
// `not_owner_words` (the claim intake's own check, made before the function is called) is the
// quote being what the card says, or holding it whole, in place of what the owner said.
export const CARD_RELAY_REFUSALS = [
  "kill_switch",
  "not_question_role",
  "card_not_routed",
  "work_not_held",
  "already_relayed",
  "owner_answered",
  "own_card",
  "not_an_option",
] as const;
export type CardRelayRefusal = (typeof CARD_RELAY_REFUSALS)[number];

// What became of a relay: `taken`, waiting for the owner's process to apply it; `applied`, the
// owner's answer; `failed`, it could not be applied and the card is the owner's to answer;
// `reopened`, the owner took it back.
export const CardRelayState = z.enum(["taken", "applied", "failed", "reopened"]);
export type CardRelayState = z.infer<typeof CardRelayState>;

// The card in its task's brief: ids and code words, and what the owner's page would say of it,
// opened under the caller's keys and served inside `untrusted`: the card's own stored words, or for
// a card about a lesson, an idea or a question of the planner's, that row's; null when there are
// none or they do not open. `attempt`: for a kind an agent was asked first, what that agent
// answered (one of the card's options, or cant_tell) and the refs its report cited, within the
// task's label; null when no agent answered.
export const CardRelayBrief = z.strictObject({
  id: z.string(),
  kind: z.string(),
  options: z.array(z.string()).max(10),
  target: z.strictObject({ kind: z.string(), id: z.string() }).nullable(),
  refs: z.array(z.strictObject({ kind: z.string(), id: z.string() })).max(50),
  words: z.strictObject({ untrusted: z.string() }).nullable(),
  attempt: z
    .strictObject({
      agent: z.string(),
      answer: z.string(),
      refs: z.array(z.strictObject({ kind: z.string(), id: z.string() })).max(50),
    })
    .nullable(),
});
export type CardRelayBrief = z.infer<typeof CardRelayBrief>;

// `relay_card_answer`: what the owner answered a card with, given to the agent in conversation. `option`
// is one of the card's own; `quote` is the owner's exact words.
export const RelayCardAnswerArgs = z.strictObject({
  card: CardId,
  option: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  quote: z
    .string()
    .min(1)
    .max(CARD_RELAY_QUOTE_MOST)
    .refine((quote) => quote.trim() !== "", { message: "the owner's words" }),
  requestId: RequestId,
});
export type RelayCardAnswerArgs = z.infer<typeof RelayCardAnswerArgs>;

// `applied` false: the relay is taken, and the owner's process applies it as an answer of the
// owner's within the minute. True on a repeat of the request once it is.
export const RelayCardAnswerResult = z.strictObject({ card: CardId, applied: z.boolean() });
export type RelayCardAnswerResult = z.infer<typeof RelayCardAnswerResult>;

// One relayed answer in the owner's list: ids, codes and times, and with `--sample` the quote.
export const CardRelayView = z.strictObject({
  id: z.string(),
  card: CardId,
  kind: z.string(),
  agent: z.string(),
  option: z.string(),
  at: z.string(),
  state: CardRelayState,
  ruling: z.string().nullable(),
  code: z.string().nullable(),
  quote: z.string().nullable().optional(),
  // On the owner's page: the card that was answered, with its lines, as the cards list shows one,
  // so the row says which question it was. Null for a card removed since.
  question: CardDetail.nullable().optional(),
});
export type CardRelayView = z.infer<typeof CardRelayView>;

// The owner's page of relayed answers: each relay with its quote, the newest first, and the body of the write that takes
// one back.
const CARD_RELAYS_LISTED = 200;
export const RelayedAnswers = z.strictObject({ relays: z.array(CardRelayView).max(CARD_RELAYS_LISTED) });
export type RelayedAnswers = z.infer<typeof RelayedAnswers>;
export const ReopenRelayedBody = z.strictObject({ card: CardId, requestId: RequestId });
export type ReopenRelayedBody = z.infer<typeof ReopenRelayedBody>;

export const CARD_RELAY_ASK =
  "A question is waiting for the owner, and you are asked to put it to them: your brief's relay gives its kind, the answers it takes, the ids of what it is about and, in relay.words, what it says. When relay.attempt is set, another agent was asked it first and could not settle it: its answer and what it cited are there, so read those too and tell the owner what was found. Read what it is about with your read tools, then ask the owner in your conversation, with that context, in names, never ids. When they answer, call relay_card_answer with the card, the option their words mean and quote, their exact words. Never choose for them and never paraphrase: with no answer, release the task and the question goes to their page. Your relay is applied as the owner's answer, marked as relayed by you, and the owner sees it and can take it back. Contact no one else, and change nothing.";
