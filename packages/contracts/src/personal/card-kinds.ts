import { currentDefinition } from "./ladder.ts";

// Every card kind and what it may be answered: the one table the store's queue checks a new card
// against, each kind's row reads its own from, and the dashboard's words are keyed by.
// A new kind starts here, and these then fail to compile until it has its row: the store's CARD_KINDS,
// ANSWER_LEARNING (action-learning.ts), the page's card kind rows and QUESTIONS, and cardLineText for any new line key. By
// hand, since no type reaches them: a migration remaking the role's insert policy for its kind and
// author (test-support/catalogue.ts holds that policy), and a fixture in the page's raw-cards.ts, which
// tests/structure/raw-cards-store.test.ts holds to the store.
export const CARD_OPTIONS = {
  notice: ["acknowledge"],
  opportunity_decision: Object.keys(currentDefinition("opportunity_go").outputs),
  owner_question: Object.keys(currentDefinition("owner_question").outputs),
  outcome: ["acknowledge", "dismiss"],
  reminder: ["done", "snooze", "dismiss"],
  agent_claim: ["confirm", "reject"],
  about_you: ["confirm", "reject"],
  client_preference: ["confirm", "reject"],
  draft_waiting: ["reject", "acknowledge"],
  same_person: ["same", "different"],
  shared_address: ["shared", "one_person"],
  same_person_batch: ["all_same", "all_different", "leave"],
  question_rule: ["confirm", "decline"],
  same_fact: ["same", "different", "skip"],
  ignore_narrowed: ["acknowledge"],
  ruling_carry: ["acknowledge"],
  calibration_drift: ["seen"],
  box_health: ["seen"],
  stale_restatement: ["acknowledge"],
  research_request: ["approve", "decline"],
  idea: ["pursue", "not_now", "no"],
  lesson: ["confirm", "reject"],
  goal_proposal: ["accept", "reject"],
  relation_audit: ["right", "wrong", "skip"],
  tier_proposal: ["confirm", "reject"],
  time_effort: ["confirm", "reject"],
  grant_suggestion: ["confirm", "reject"],
  grant_lift_suggestion: ["confirm", "reject"],
} as const satisfies Record<string, readonly string[]>;

export type KnownCardKind = keyof typeof CARD_OPTIONS;

export const cardOptionsOf = (kind: string): readonly string[] | undefined =>
  Object.hasOwn(CARD_OPTIONS, kind) ? CARD_OPTIONS[kind as keyof typeof CARD_OPTIONS] : undefined;
