import { GapTrigger, OpportunityStatus, PipelineCode, PipelineStatus } from "@intelligence/contracts/personal";
import type { OutcomeName } from "../../core/outcome-thresholds.ts";

// The parts of a measure that are stored with its reading, and so served to an agent by get_health:
// for each measure, the keys its parts may have. A closed list: a measure not named here stores no
// parts, and a key no rule here admits is dropped before the reading is written. Every part named
// here is counted within the reading's own label, or over rows that hold no label and are the same
// for every reader (a setting's change, a job's run). A part counted over anything else stays in
// `ownerParts`, the owner's report alone.
//
// A family is closed by its enum where the contracts hold one (a gap's trigger, work's status, the
// pipeline's codes). Three are closed by form, not by a list: a card's kind and a command's kind,
// which code alone writes from its registries, and the reason code gives its own no
// (`ledger.opportunity_decisions.reason` of a `policy` decision). Each is held to a code's form
// here, so none is text, but a new kind or reason is admitted with no change to this file.
// `switch_changes` and `lever_changes` count changes to settings, which hold no label: they are
// served to every reader of that reading, whatever it is cleared for.

const CODE = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const WEEK = /^week_\d{4}-\d{2}-\d{2}$/;
const exact = (...keys: string[]): RegExp => new RegExp(`^(?:${keys.join("|")})$`);
// `other`: one the contracts do not name, so each family of a measure's parts sums to its sample.
const TRIGGERS = [...GapTrigger.options, "other"].join("|");
const STATUSES = [...OpportunityStatus.options, "other"].join("|");

export const SERVED_PARTS: Readonly<Partial<Record<OutcomeName, readonly RegExp[]>>> = Object.freeze({
  code_no_go_per_day: [exact("held_by_expired_card", "cases", "days_since_last"), new RegExp(`^${CODE}$`)],
  owner_actions_per_week: [
    WEEK,
    exact(
      "card_answers",
      "owner_answers",
      "sends",
      "commands",
      "defect_closes",
      "stops",
      "switch_changes",
      "runs_asked",
      "lesson_changes",
      "mission_set",
      "lever_changes",
      "area_changes",
      "relayed",
    ),
    new RegExp(`^command_${CODE}$`),
  ],
  defects_closed_without_owner: [
    exact(
      "owner_command",
      "pr",
      "commit",
      "lever",
      "ops",
      "none",
      "recovered_untaken",
      "agent_closed",
      "closed_no_data",
    ),
  ],
  capture_to_claim_24h_moments: [
    exact("waiting", "asked", "unreadable", "other", ...PipelineStatus.options, ...PipelineCode.options),
  ],
  policy_merges_wrong_share: [exact("audited", "found_wrong", "split", "waiting_owner")],
  owner_questions_per_week: [
    WEEK,
    exact(
      "repeats",
      "stopped_by_rule",
      "settled_by_code",
      "settled_by_agent",
      "waiting_on_agent",
      "relayed",
      "relayed_unapplied",
      "nothing_to_read",
    ),
    new RegExp(`^${CODE}$`),
  ],
  owner_questions_attempted: [exact("agents", "code", "attempted", "untried")],
  questions_paid_share: [exact("asked", "paid")],
  bets_used_share: [exact("used", "unused", "approved", "approved_lifted")],
  agent_settled_precision: [exact("right", "wrong")],
  settled_without_owner_overturned: [exact("settled", "overturned", "relayed_applied", "relayed_overturned")],
  gap_tasks_raised_per_day: [
    new RegExp(`^(?:${TRIGGERS})$`),
    new RegExp(`^now_(?:${STATUSES})$`),
    new RegExp(`^(?:${TRIGGERS})_now_(?:${STATUSES})$`),
  ],
  top_people_filled: [exact("filled", "no_beliefs", "few_beliefs", "not_fresh")],
  tasks_claimed_no_result_per_day: [exact("with_result", "no_result")],
  // A role is configuration, held to a role's form by policy.clients, never text from a source.
  roles_unattended: [/^role:[a-z][a-z0-9-]{1,31}$/],
  commitments_refused_share: [exact("not_a_promise", "wrong_direction")],
  signals_picked_up: [exact("read", "claimed")],
});

// The parts never stored, whatever a rule above admits: each is counted over rows the reading's
// label does not bound.
export const OWNER_ONLY_PARTS: readonly string[] = Object.freeze(["erased_since_dump", "days_since_erasure"]);

// Whether a measure's part is one a reading keeps.
export const servedPartKey = (metric: string, key: string): boolean =>
  !OWNER_ONLY_PARTS.includes(key) &&
  ((SERVED_PARTS as Record<string, readonly RegExp[] | undefined>)[metric] ?? []).some((rule) => rule.test(key));
