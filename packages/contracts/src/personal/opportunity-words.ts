import { z } from "zod";

// The words an opportunity is told by, apart from work.ts: learning reads them, and work.ts reads learning's.
export const SilenceReason = z.enum([
  "kill_switch",
  "vetoed",
  "no_reasoner",
  "owner_backlog",
  "budget",
  "nothing_to_do",
  "below_bar",
  "waiting_is_better",
]);
export type SilenceReason = z.infer<typeof SilenceReason>;

export const OpportunityKind = z.enum([
  "follow_up",
  "reply",
  "meeting_prep",
  "investigate",
  "goal_step",
  "life_admin",
  "owner_question",
  "research",
  "introduction",
]);
export type OpportunityKind = z.infer<typeof OpportunityKind>;

export const OpportunityStatus = z.enum([
  "proposed",
  "go",
  "no_go",
  "later",
  "claimed",
  "handed_to_owner",
  "done",
  "expired",
  "withdrawn",
  "outcome_met",
  "outcome_not_met",
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;
