import { z } from "zod";
import type { KnownCardKind } from "./card-kinds.ts";
import { CardId, RequestId } from "./ids.ts";
import { CardDetail } from "./owner.ts";

// An agent's attempt on a card before it reaches the owner: the kinds an agent is asked first,
// which of their answers settle the card without the owner, and the shapes of the task's brief and
// of the answer its done report carries.

// The kinds an agent can work: its answer rests on what it can read and cite, and a wrong one costs
// the owner a reopen or one more answer. A kind only the owner can answer (a release, a grant, a
// goal, a lesson, a send, work that reaches outside) is never here, and same-person questions have
// their own route to agents.
export const AGENT_ATTEMPT_KINDS = [
  "same_fact",
  "shared_address",
  "time_effort",
  "reminder",
  "tier_proposal",
  "relation_audit",
  "agent_claim",
] as const satisfies readonly KnownCardKind[];
type AgentAttemptKind = (typeof AGENT_ATTEMPT_KINDS)[number];
export const isAgentAttemptKind = (kind: string): kind is AgentAttemptKind =>
  (AGENT_ATTEMPT_KINDS as readonly string[]).includes(kind);

// The kinds whose card is held back from the owner while an agent works it. Never a reminder: its
// card is the reminder, raised when it is due, so the owner sees it at once and an agent's answer
// may still settle it.
export const AGENT_HELD_KINDS: readonly AgentAttemptKind[] = Object.freeze(
  AGENT_ATTEMPT_KINDS.filter((kind) => kind !== "reminder"),
);

// The answers of each kind that settle its card with no owner. A reminder's intention fired when its
// card was raised, so `done` writes nothing more. An agent_claim card is settled by a second agent,
// never the claim's author: its confirm or reject is stored as an agent ruling (AGENT_RULING_KINDS),
// which the belief build reads below the owner's own confirmation, and which the owner's own answer on
// the card, or their reopen, outranks and lifts. Every other answer of every kind is attached to the card the
// owner sees: its effect is a ruling, and a ruling written for an agent would be marked as the owner's.
export const AGENT_SETTLES: Readonly<Partial<Record<AgentAttemptKind, readonly string[]>>> = Object.freeze({
  reminder: ["done"],
  agent_claim: ["confirm", "reject"],
});

// The kinds whose settling answer is an agent ruling: one row of ledger.agent_rulings keyed by the
// card, naming the agent that decided and the refs its report cited, read wherever the owner's own
// answer to that kind is read and below it, and left out of everything that learns from their answers
// (ANSWER_LEARNING, question rules, `stopped_by_rule`), since it is never a row of
// knowledge.owner_decisions. `same_fact`, `tier_proposal` and `time_effort` may join later, each with
// its own reader.
export const AGENT_RULING_KINDS = ["agent_claim"] as const satisfies readonly AgentAttemptKind[];

// Who withdraws a card an agent's answer settled, and the code on that event: `agent_` and the answer.
export const AGENT_ATTEMPT_BY = "system:agent_attempt";
const AGENT_SETTLED_PREFIX = "agent_";
export const agentSettledCode = (answer: string): string => `${AGENT_SETTLED_PREFIX}${answer}`;
export const AGENT_SETTLED_CODES: readonly string[] = Object.freeze([
  ...new Set(Object.values(AGENT_SETTLES).flatMap((answers) => (answers ?? []).map(agentSettledCode))),
]);

// The kinds no agent is asked and no agent relays: notices, kinds code
// settles, and kinds with a route of their own (an outcome's weekly sample, same-person questions'
// two agents, which merge identities on the owner's word alone). With CARD_RELAY_NEVER,
// AGENT_ATTEMPT_KINDS and CARD_RELAY_KINDS, every card kind is in exactly one list; a test holds
// that against CARD_OPTIONS. An attempt that does not settle its card may then be asked through an
// agent (CARD_RELAY_AFTER_ATTEMPT), which is no fifth list.
export const CARD_NOT_ASKED = [
  "notice",
  "ignore_narrowed",
  "ruling_carry",
  "calibration_drift",
  "stale_restatement",
  "box_health",
  "outcome",
  "same_person",
  "same_person_batch",
] as const satisfies readonly KnownCardKind[];

// The owner's weekly check of what agents settled: at most this many cards an agent's answer settled
// in the last whole ISO week, so the five do not change once shown, chosen by a hash of the card and
// the week, each for the owner to mark right or wrong. Precision on these marks is the kind's measure.
export const AGENT_SETTLED_SAMPLE = 5;
export const AgentSettlementMark = z.enum(["right", "wrong"]);
export type AgentSettlementMark = z.infer<typeof AgentSettlementMark>;

// One settled card in the owner's sample: ids, codes and times. `cited`: the refs the agent's report
// cited, as stored on its ruling (agent_claim); `reopened`: the owner took it back; `question`: on the
// owner's page, the card with its lines as the cards list shows one, so the owner reads the claim the
// agent confirmed or rejected. Null for a card that cannot be read there.
export const AgentSettlementView = z.strictObject({
  card: z.string(),
  kind: z.string(),
  agent: z.string(),
  answer: z.string(),
  at: z.string(),
  cited: z.array(z.strictObject({ kind: z.string(), id: z.string() })).max(100),
  mark: AgentSettlementMark.nullable(),
  reopened: z.boolean(),
  question: CardDetail.nullable().optional(),
});
export type AgentSettlementView = z.infer<typeof AgentSettlementView>;
export const AgentSettlements = z.strictObject({
  week: z.string(),
  settlements: z.array(AgentSettlementView).max(AGENT_SETTLED_SAMPLE),
});
export type AgentSettlements = z.infer<typeof AgentSettlements>;
// The owner's mark on one of them; marking again replaces it, so a repeat writes the same.
export const MarkAgentSettlementBody = z.strictObject({
  card: CardId,
  mark: AgentSettlementMark,
  requestId: RequestId,
});
export type MarkAgentSettlementBody = z.infer<typeof MarkAgentSettlementBody>;

// How long a card waits for an agent before the owner sees it, and how long it waits for the tick to
// raise its task at all, while tasks are on: a card whose task could not be raised (a veto, a
// restricted label) is the owner's after the second, and with tasks off it never waits.
export const AGENT_ATTEMPT_HOURS = 48;
export const AGENT_ATTEMPT_GRACE_MINUTES = 15;

export const CARD_CANT_TELL = "cant_tell";

// What a card task's done report says: one of the card's own options, or cant_tell. What it rests on
// is the report's sources and the finding they cite.
export const CardAttemptAnswer = z
  .strictObject({ answer: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/) })
  .describe("A card_question task's only: one of your brief's card.options, or cant_tell.");
export type CardAttemptAnswer = z.infer<typeof CardAttemptAnswer>;

// The card in its task's brief: ids and code words only. What it is about is read with the read tools.
export const CardAttemptBrief = z.strictObject({
  id: z.string(),
  kind: z.string(),
  options: z.array(z.string()).max(10),
  target: z.strictObject({ kind: z.string(), id: z.string() }).nullable(),
  refs: z.array(z.strictObject({ kind: z.string(), id: z.string() })).max(50),
  // The caller raised this card itself: its answer is refused, so it releases the task.
  own: z.boolean(),
});
export type CardAttemptBrief = z.infer<typeof CardAttemptBrief>;

export const CARD_ATTEMPT_ASK =
  "A question is waiting for the owner, and you are asked it first: your brief's card gives its kind, the answers it takes, and the ids of what it is about. Read those with your read tools, and what the owner's mail, chats and records say of them. Record a finding of what you read and what it shows, citing it, then report done with report.card.answer set to one of card.options and report.sources citing that finding. If card.own is true you raised this card yourself: release the task, another agent answers it. If what you can read does not settle it, answer cant_tell: a wrong answer costs the owner more than a question. Your answer is marked as an agent's, never the owner's; the owner sees it with what you cited and may overrule it. Contact no one, and change nothing.";

export const CARD_ATTEMPT_HINTS = {
  card_not_asked: "Only a card_question task's report takes report.card: remove it.",
  needs_card_answer:
    "A card_question task is done only with report.card.answer: one of your brief's card.options, or cant_tell. Nothing to say: release the task.",
  card_answer_refused:
    "report.card.answer must be one of your brief's card.options or cant_tell, on a card still waiting, by an agent that did not raise it, once. If it has been answered or closed since, release the task.",
} as const;
