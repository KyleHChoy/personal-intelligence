// The codes a tool call can be refused with, and what every port method answers.
import { z } from "zod";

export const PersonalToolError = z.enum([
  "unauthorized",
  "not_permitted",
  "invalid_request",
  "not_found",
  "unavailable",
  "rate_limited",
  "stale_cursor",
  "unsupported_template",
  "unknown_role",
]);
export type PersonalToolError = z.infer<typeof PersonalToolError>;

// Why close_commitment was refused, each a fixed code with its fixed hint.
const CloseRefusal = z.enum([
  "already_closed",
  "evidence_not_read",
  "evidence_unrelated",
  "evidence_predates",
  "reopened_by_owner",
  "label_wider",
  "closes_off",
]);
// Why a typed claim on a record finding was refused, declared here and applied by its write
// path.
const TypedClaimRefusal = z.enum(["finding_untyped", "subject_ambiguous", "subject_unknown", "fields_invalid"]);
// Why plan_move did not clear a move, where the reason is the caller's own standing.
const MOVE_BLOCKS = [
  "kill_switch",
  "not_go",
  "no_intent",
  "intent_revoked",
  "kind_not_listed",
  "client_not_listed",
  "no_harness_mode",
  "not_act",
  "not_next_stage",
  "not_internal",
] as const;
// Why a call on work the caller can see was refused, from what its own view already shows it: so an agent
// is told which step comes next. Work it cannot see stays a plain not_found. WORK_CALL_FAULTS: what is
// wrong with a call on work the caller holds or sees, told from its own arguments, its own record, its own
// lease and the work's view: sent with invalid_request for an argument, with not_found for a state.
// `area_unknown` (Part C, AR5): a project's area named by a key that is no active area the caller can see.
const WORK_CALL_FAULTS = [
  "record_not_taken_in",
  "record_not_your_handoff",
  "record_removed",
  "record_label_wider",
  "release_needs_reason",
  "owner_needs_record",
  "task_not_to_owner",
  "due_too_soon",
  "due_too_far",
  "due_past_expiry",
  "check_backs_full",
  "holds_full",
  "move_closed",
  "work_blocked",
  "work_for_other_role",
  "area_unknown",
] as const;
// Why a relayed answer was refused, each from what the caller can see.
const CARD_RELAY_FAULTS = [
  "not_question_role",
  "card_not_routed",
  "already_relayed",
  "owner_answered",
  "own_card",
  "not_an_option",
] as const;
// Why an agent's seen on a box health card was refused, each from what the caller can see of the
// card it is cleared for.
const HEALTH_SEEN_FAULTS = ["owners_card", "came_back_after_seen", "card_closed"] as const;
// An agent's anchor on a key another agent's live anchor holds, as the caller sees it.
const TIME_SORT_FAULTS = ["anchor_taken"] as const;
export const WorkStateRefusal = z.enum([
  "not_a_question",
  "not_a_task",
  "work_not_held",
  "work_held",
  "work_closed",
  "question_needs_owner_go",
  "move_not_cleared",
  "question_answered",
  "session_renewed",
  "closes_by_measure",
  "needs_fix_ref",
  "fix_ref_refused",
  ...MOVE_BLOCKS,
  ...WORK_CALL_FAULTS,
  ...CARD_RELAY_FAULTS,
  ...HEALTH_SEEN_FAULTS,
  ...TIME_SORT_FAULTS,
]);
export type WorkStateRefusal = z.infer<typeof WorkStateRefusal>;
// Which window of its read budget a rate_limited read ran out of: the minute's calls, or the day's
// items, characters or rows. From the caller's own rows alone.
export const ReadBudgetRefusal = z.enum(["rate_limited_minute", "rate_limited_day"]);
export type ReadBudgetRefusal = z.infer<typeof ReadBudgetRefusal>;
// Why a proposed fact about the owner was refused, as a fixed code. A write tool's invalid_request may
// carry one (`refusal`), and the agent API sends its fixed hint (CLAIM_REFUSAL_HINTS) beside it: never a
// value, a row or a model's text. `not_what_was_said` is the extraction lane's model check's, filed with
// the unmapped claim; the others are code's. Also `vague_summary`, a proposal's summary that does not name
// the work itself (propose_opportunity, propose_task and propose_hypothesis). `question_unpaid`, a question
// to the owner whose `tried` is missing or not borne out by the caller's own logs. `bet_budget_spent`, a
// bet past the caller's budget for the last seven days. `bet_needs_owner`, a bet on work a bet cannot
// approve: a stage that drafts, sends or pays, an owner_question, or a decision asked of the owner.
// `ids_in_prose`, an id in text a person reads; `subject_is_owner`, a typed claim on a finding about the
// owner, whose facts go through propose_about_you; `goal_proposed_elsewhere`, a goal of the owner's sent to
// propose_about_you, whose path is propose_goal.
export const ClaimRefusal = z.enum([
  "bad_fields",
  "multi_fact",
  "negated_object",
  "not_standalone",
  "not_in_quote",
  "not_what_was_said",
  "not_owner_words",
  ...CloseRefusal.options,
  ...TypedClaimRefusal.options,
  "vague_summary",
  "question_unpaid",
  "bet_budget_spent",
  "bet_needs_owner",
  "ids_in_prose",
  "subject_is_owner",
  "goal_proposed_elsewhere",
  ...WorkStateRefusal.options,
  ...ReadBudgetRefusal.options,
]);
export type ClaimRefusal = z.infer<typeof ClaimRefusal>;

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; code: PersonalToolError; refusal?: ClaimRefusal };

// Every code an agent's call can be refused with as a tool result, as an agent reads it.
// unauthorized and unavailable are answered as protocol errors, never as a tool result, and the guide says what to do on each.
export const ToolRefusalCode = PersonalToolError.exclude(["unauthorized", "unavailable"]);
export type ToolRefusalCode = z.infer<typeof ToolRefusalCode>;
