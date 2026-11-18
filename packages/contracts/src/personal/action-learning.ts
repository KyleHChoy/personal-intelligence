import type { KnownCardKind } from "./card-kinds.ts";
import type { OwnerDecisionKind } from "./owner.ts";

// How each of the owner's decision kinds teaches the system. `plan`: an input to lessons runs,
// which steer planning and agents' briefs. `ruling`: applied at once, and generalized by a proposer
// for its kind, named, or `pending` until one is built. `none`: never learned from, for the reason
// given. Only types are taken from owner.ts, which reaches learning.ts at run time.

type RulingProposer = "tier" | "confirm_rate" | "pending";
export type OwnerActionTeaching =
  | Readonly<{ teaches: "plan" }>
  | Readonly<{ teaches: "ruling"; proposer: RulingProposer }>
  | Readonly<{ teaches: "none"; reason: string }>;

const plan: OwnerActionTeaching = Object.freeze({ teaches: "plan" });
const pending: OwnerActionTeaching = Object.freeze({ teaches: "ruling", proposer: "pending" });
const tier: OwnerActionTeaching = Object.freeze({ teaches: "ruling", proposer: "tier" });
// The owner's answers on an agent's about-you proposals, and their Not true, make its confirm rate.
const confirmRate: OwnerActionTeaching = Object.freeze({ teaches: "ruling", proposer: "confirm_rate" });
const none = (reason: string): OwnerActionTeaching => Object.freeze({ teaches: "none", reason });

const AUTHORITY = "it grants or withdraws authority or access, which is never inferred";
const ERASURE = "what the owner removes or hides must never become a preference";
const SEND = "a send is the owner's act on one message, already decided by the card that proposed it";
const EVALUATION = "an evaluation label, kept inert so it can judge the system (learning R12)";
const NOT_THEIRS = "written by code carrying the owner's ruling to a new claim, never their answer";

// An answer teaches by the card's kind, by its effect. Identity, about-you and same-fact answers
// are rulings; a lesson card's answer already decides the lesson, and would otherwise wake the next
// lessons run from its own output; a research request's approval and a client's preference are
// grants, a waiting draft's answer a send, and a card whose one option only acknowledges it chooses
// nothing. Every other kind is
// `plan`. The store's CARD_KINDS and this map hold the same keys, which a store test checks.
const GRANT = "authority: a grant or a client's setting";
const SEEN = "nothing chosen: the card's one option only acknowledges it";
const ANSWER_LEARNING: Readonly<Record<KnownCardKind, OwnerActionTeaching>> = Object.freeze({
  notice: none(SEEN),
  opportunity_decision: plan,
  owner_question: plan,
  outcome: plan,
  reminder: plan,
  agent_claim: plan,
  about_you: confirmRate,
  client_preference: none(GRANT),
  draft_waiting: none("a send: the owner's answer on one waiting draft"),
  same_person: pending,
  same_person_batch: pending,
  // A rule the owner confirms is the owner's word on a pattern; nothing counts it as an answer to the pattern again.
  question_rule: none("authority: a standing rule the owner confirms or declines"),
  shared_address: pending,
  same_fact: pending,
  ignore_narrowed: none(SEEN),
  ruling_carry: none(SEEN),
  calibration_drift: none(SEEN),
  box_health: none(SEEN),
  stale_restatement: none(SEEN),
  research_request: none(GRANT),
  idea: plan,
  lesson: none(
    "the owner's answer already decides the lesson; counting it would wake lessons runs from their own output",
  ),
  goal_proposal: plan,
  relation_audit: plan,
  // The owner's confirm writes tier rulings, their reject stops the proposal; both are tier rulings'.
  tier_proposal: tier,
  // Yes makes a project from a group of the owner's time; no stops that time being proposed.
  time_effort: plan,
  // A card proposing a standing release, or its lift, from a confirm rate: answering it only
  // tells them the terminal command, and quiets the proposal for a while.
  grant_suggestion: none(GRANT),
  grant_lift_suggestion: none(GRANT),
});

export const OWNER_ACTION_LEARNING: Readonly<
  Record<Exclude<OwnerDecisionKind, "answer">, OwnerActionTeaching> & {
    answer: Readonly<Record<string, OwnerActionTeaching>>;
  }
> = Object.freeze({
  answer: ANSWER_LEARNING,
  // `plan`: goals, the owner's tasks for agents, their answers to owner questions, commitment
  // closes and reopens, notes, projects and their anchors, harm marks.
  goal_set: plan,
  goal_status: plan,
  goal_reword: plan,
  goal_rank: plan,
  goal_adopt: plan,
  goal_adopt_undo: plan,
  goal_hide: plan,
  goal_hide_lift: plan,
  goal_target: plan,
  task_add: plan,
  task_withdraw: plan,
  task_cancel: plan,
  work_free: plan,
  task_tier: plan,
  default_task_role: plan,
  question_role: plan,
  title_role: plan,
  defect_role: plan,
  ping_settings: plan,
  auto_settings: none(GRANT),
  gap_route: plan,
  owner_answer: plan,
  commitment_close: plan,
  open_item_close: plan,
  open_item_reopen: plan,
  commitment_reopen: plan,
  note_add: plan,
  project_add: plan,
  project_anchor: plan,
  project_unanchor: plan,
  project_close: plan,
  time_ruling: plan,
  time_unruling: plan,
  time_veto: plan,
  harm: plan,
  harm_lift: plan,
  // The owner's Keep or Not useful on a finished task's result teaches which research is worth asking
  // for. Neither grants or releases anything.
  result_eval: plan,
  // `ruling`: the tier proposer is built; the others are pending. A fact ruling whose details carry
  // `via: "cleanup"` is code's rule applied by `pia facts clean`, never an answer of theirs: a proposer
  // and a confirm rate leave it out.
  warmth_tier: tier,
  warmth_tier_lift: tier,
  identity: pending,
  identity_lift: pending,
  owner_address: pending,
  confirmation_lift: pending,
  relay_lift: pending,
  correction: confirmRate,
  correction_lift: pending,
  veto: pending,
  veto_lift: pending,
  fact_veto: pending,
  fact_veto_lift: pending,
  fact_retire: pending,
  fact_retire_lift: pending,
  fact_domain: pending,
  fact_domain_lift: pending,
  fact_kind: pending,
  fact_kind_lift: pending,
  fact_join: pending,
  fact_split: pending,
  fact_ruling_lift: pending,
  ignore: pending,
  ignore_lift: pending,
  organization_name: pending,
  // The owner's name for a person: a ruling, its proposer not built yet.
  person_name: pending,
  person_name_lift: pending,
  list_create: pending,
  list_rename: pending,
  list_delete: pending,
  list_add: pending,
  list_remove: pending,
  mention_bind: pending,
  mention_unbind: pending,
  // `none`.
  release: none(AUTHORITY),
  record_release: none(AUTHORITY),
  close_release: none(AUTHORITY),
  declassify: none(AUTHORITY),
  declassify_revoke: none(AUTHORITY),
  threshold_grant: none(AUTHORITY),
  threshold_revoke: none(AUTHORITY),
  threshold_target: none(AUTHORITY),
  rung_resume: none(AUTHORITY),
  intent_confirm: none(AUTHORITY),
  intent_revoke: none(AUTHORITY),
  harness_grant: none(AUTHORITY),
  harness_revoke: none(AUTHORITY),
  combining_grant: none(AUTHORITY),
  client_roles: none(AUTHORITY),
  webhook_set: none(AUTHORITY),
  webhook_removed: none(AUTHORITY),
  restriction_lift: none(AUTHORITY),
  research: none(AUTHORITY),
  research_settings: none(AUTHORITY),
  identity_policy: none(AUTHORITY),
  // The owner's standing release of an agent's quoted facts of one kind, and its
  // lift. A grant of authority, never inferred; the owner's Not true on a fact kept under it is a
  // `correction`, which teaches as every reject does.
  release_grant: none(AUTHORITY),
  release_grant_lift: none(AUTHORITY),
  // The owner's switch for learning from one agent's proposals: authority over what is proposed
  // to them and told to it, never inferred.
  learning_switch: none(AUTHORITY),
  // The cleanup's apply: its rulings are code's, by the owner's one command, and never counted as
  // their answers.
  facts_clean: none(NOT_THEIRS),
  ruling_carry: none(NOT_THEIRS),
  erase: none(ERASURE),
  erase_lift: none(ERASURE),
  seal: none(ERASURE),
  seal_lift: none(ERASURE),
  retention_rule: none(ERASURE),
  retention_forget: none(ERASURE),
  restatement_clear: none(ERASURE),
  send: none(SEND),
  send_settle: none(SEND),
  card_label: none(EVALUATION),
  silence_verdict: none(EVALUATION),
});

// How a decision teaches: an `answer` by its card's kind, null when that kind is not given or has
// no entry. A kind read from the database is checked too: one the registry lacks is null.
export function teachesOf(kind: OwnerDecisionKind, cardKind?: string): OwnerActionTeaching | null {
  if (kind !== "answer") return Object.hasOwn(OWNER_ACTION_LEARNING, kind) ? OWNER_ACTION_LEARNING[kind] : null;
  return cardKind !== undefined && Object.hasOwn(ANSWER_LEARNING, cardKind)
    ? (ANSWER_LEARNING[cardKind as KnownCardKind] ?? null)
    : null;
}
