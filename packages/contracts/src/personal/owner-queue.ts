import { z } from "zod";
import type { KnownCardKind } from "./card-kinds.ts";

// Everything waiting for the owner reaches them as one message their agent hands over: at most once
// a day for each label it is under, the agent of the question role is told how many cards wait for
// the owner, by kind in plain words, with one link to the owner's queue, and tells the owner. It
// answers and relays none of them.

// Each kind that takes an answer, in plain words, as the agent says it to the owner: never a card's
// own text. A kind with none here is told among the other questions.
export const OWNER_QUEUE_WORDS: Readonly<Partial<Record<KnownCardKind, string>>> = Object.freeze({
  opportunity_decision: "work to approve or turn down",
  owner_question: "questions the planner asked you",
  outcome: "results of work to check",
  reminder: "reminders due",
  agent_claim: "facts an agent reported, to confirm",
  about_you: "statements about you, to confirm",
  client_preference: "preferences an agent proposed, to confirm",
  draft_waiting: "drafts waiting to be sent",
  same_person: "possible duplicate people",
  shared_address: "shared addresses to sort out",
  same_person_batch: "batches of possible duplicate people",
  question_rule: "proposed rules for questions",
  same_fact: "facts that may be the same, to check",
  research_request: "research requests to approve",
  idea: "ideas to pursue or drop",
  lesson: "lessons for your agents, to confirm",
  goal_proposal: "proposed changes to your goals",
  relation_audit: "links the system drew between facts, to check",
  tier_proposal: "proposed closeness of people",
  time_effort: "time to sort into projects",
  grant_suggestion: "suggested grants of access",
  grant_lift_suggestion: "suggested removals of access",
});
const OTHER = { kind: "other", words: "other questions" } as const;

// The words a kind is told in: its own, or the other questions'.
export const ownerQueueWords = (kind: string): { kind: string; words: string } => {
  const words = Object.hasOwn(OWNER_QUEUE_WORDS, kind) ? OWNER_QUEUE_WORDS[kind as KnownCardKind] : undefined;
  return words === undefined ? OTHER : { kind, words };
};

// The owner's page, opened on Today, where their waiting cards are: the page's own address for that
// room. Null with no host.
export const ownerQueueLink = (host: string | null): string | null => (host === null ? null : `https://${host}/#today`);

// The hand-over in the task's brief: how many wait, by kind, in words, and the link. Counts and kind
// names only, never a card's id or text.
export const OwnerQueueBrief = z.strictObject({
  waiting: z.array(z.strictObject({ kind: z.string(), words: z.string(), count: z.number().int().min(1) })).max(30),
  link: z.string().nullable(),
});
export type OwnerQueueBrief = z.infer<typeof OwnerQueueBrief>;

export const OWNER_QUEUE_ASK =
  "Questions are waiting for the owner on their page: your brief's handover says how many, by kind, and gives the link to their queue. Tell the owner in your conversation how many wait and of what kinds, and give them the link. Answer none of them, relay nothing and decide nothing for them: each is theirs to answer on their own page. Once you have told them, record a finding that you did, and report done citing it.";
