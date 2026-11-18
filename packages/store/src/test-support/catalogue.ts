// The catalogue of tables, and the grants and policy conditions of the earlier migrations.

// `key` is an SQL expression for a row's key as text: `id`, or the primary key where the table
// has no `id`. `column` is one plain column, for a statement that must name one.
export type Table = { name: string; key: string; column: string };

export const TABLES: readonly Table[] = [
  { name: "policy.migrations", key: "name", column: "name" },
  { name: "policy.clients", key: "id", column: "id" },
  { name: "policy.secrets", key: "name", column: "name" },
  { name: "policy.calls", key: "id::text", column: "tool" },
  { name: "policy.tool_names", key: "name", column: "name" },
  { name: "vault.source_accounts", key: "id", column: "id" },
  { name: "vault.evidence_items", key: "id", column: "id" },
  { name: "vault.evidence_blobs", key: "blob_ref", column: "blob_ref" },
  { name: "vault.listed_items", key: "account_id || '/' || source_item_fp", column: "account_id" },
  { name: "vault.sent_recipients", key: "evidence_id || '/' || address_fp", column: "evidence_id" },
  { name: "knowledge.entities", key: "id", column: "id" },
  { name: "knowledge.accounts", key: "id", column: "id" },
  { name: "knowledge.domains", key: "id", column: "id" },
  { name: "knowledge.aliases", key: "id", column: "id" },
  { name: "knowledge.messages", key: "id", column: "id" },
  { name: "knowledge.interaction_log", key: "id", column: "id" },
  { name: "knowledge.events", key: "id", column: "id" },
  { name: "knowledge.event_details", key: "event_id", column: "event_id" },
  { name: "knowledge.event_participants", key: "event_id || '/' || entity_id", column: "event_id" },
  { name: "vault.pipeline_items", key: "evidence_id", column: "evidence_id" },
  { name: "vault.model_calls", key: "id", column: "id" },
  { name: "vault.model_usage", key: "id", column: "id" },
  { name: "vault.extraction_runs", key: "seq::text", column: "code" },
  { name: "vault.unmapped_claims", key: "id", column: "id" },
  { name: "vault.extraction_reviews", key: "id", column: "id" },
  { name: "knowledge.claims", key: "id", column: "id" },
  { name: "knowledge.claim_entities", key: "claim_id || '/' || entity_id", column: "claim_id" },
  // `column` is never an identity column.
  { name: "knowledge.projects", key: "id", column: "id" },
  { name: "knowledge.project_anchors", key: "id", column: "id" },
  { name: "knowledge.project_bindings", key: "id::text", column: "claim_id" },
  { name: "knowledge.areas", key: "id", column: "id" },
  { name: "ledger.sessions", key: "id", column: "id" },
  { name: "ledger.read_log", key: "id::text", column: "tool" },
  { name: "ledger.agent_writes", key: "id", column: "id" },
  { name: "policy.record_quota", key: "client_id", column: "client_id" },
  { name: "ledger.context_packs", key: "id::text", column: "purpose" },
  // The owner surface. `column` is never an identity column, so the probes' `insert ... select`
  // names a column a role may write.
  { name: "knowledge.owner_decisions", key: "id", column: "id" },
  { name: "knowledge.vetoes", key: "ruling_id", column: "ruling_id" },
  { name: "ledger.cards", key: "id", column: "id" },
  { name: "ledger.record_events", key: "id::text", column: "row_kind" },
  { name: "ledger.basis", key: "id::text", column: "row_kind" },
  // Erasure and suppression.
  { name: "knowledge.erasures", key: "id", column: "id" },
  { name: "knowledge.removed_evidence", key: "id", column: "id" },
  { name: "knowledge.suppressions", key: "id", column: "id" },
  // A ruling's `column` is one the reader may read and the admin may update.
  { name: "knowledge.contacts", key: "id", column: "id" },
  { name: "knowledge.contact_addresses", key: "contact_id || '/' || value_fp", column: "contact_id" },
  { name: "knowledge.identity_rulings", key: "ruling_id", column: "lifted_at" },
  // The owner's ignore list, pi_admin's and pi_owner's alone.
  { name: "knowledge.ignore_rulings", key: "ruling_id", column: "lifted_at" },
  // The owner's tier rulings, pi_admin's and pi_owner's alone.
  { name: "knowledge.tier_rulings", key: "ruling_id", column: "lifted_at" },
  // The owner's Remove, hiding a person's group: pi_admin's alone.
  { name: "knowledge.person_hides", key: "ruling_id", column: "lifted_at" },
  // The owner's lists of people, pi_admin's alone.
  { name: "knowledge.time_rulings", key: "id", column: "lifted_at" },
  // An agent's anchors and time rulings.
  { name: "knowledge.agent_anchors", key: "id", column: "lifted_at" },
  { name: "knowledge.agent_time_rulings", key: "id", column: "lifted_at" },
  { name: "knowledge.owner_lists", key: "id", column: "deleted_at" },
  { name: "knowledge.owner_list_members", key: "ruling_id", column: "removed_at" },
  // The owner's names for organizations.
  { name: "knowledge.organization_names", key: "id", column: "domain_fp" },
  { name: "knowledge.person_names", key: "id", column: "lifted_at" },
  // Belief rulings.
  { name: "knowledge.belief_rulings", key: "ruling_id", column: "ruling_id" },
  // The owner's joins and splits.
  { name: "knowledge.fact_rulings", key: "ruling_id", column: "ruling_id" },
  // The owner's releases of confirmed proposals.
  { name: "knowledge.claim_releases", key: "ruling_id", column: "ruling_id" },
  // The journalled lifts of the owner's releases.
  { name: "knowledge.release_lifts", key: "seq::text", column: "ruling_id" },
  // The same-fact sweep's judgment, kept once a pair, labelled by the two claims it read.
  { name: "knowledge.same_fact_judgments", key: "a_fp || ':' || b_fp", column: "a_fp" },
  { name: "projections.declassified_facts", key: "id", column: "id" },
  { name: "policy.research_settings", key: "one::text", column: "card_expiry_days" },
  // The owner's settings, one row; the reader selects `time_zone` alone.
  { name: "policy.owner_settings", key: "one::text", column: "one" },
  // The fact rulings' append-only marks, the trigger's alone.
  { name: "policy.fact_ruling_marks", key: "id::text", column: "id" },
  { name: "ledger.research_requests", key: "id", column: "id" },
  { name: "ledger.research_fetches", key: "id", column: "id" },
  { name: "knowledge.pages", key: "id", column: "id" },
  // `column` is never an identity column.
  { name: "policy.intents", key: "id", column: "id" },
  { name: "policy.harness_modes", key: "id", column: "id" },
  { name: "policy.work_settings", key: "max_runs_per_day::text", column: "max_runs_per_day" },
  { name: "policy.stage_plan", key: "opportunity_kind || '/' || ordinal", column: "stage" },
  { name: "projections.goal_state", key: "goal_id", column: "goal_id" },
  { name: "queue.leases", key: "resource_kind || '/' || resource_id", column: "holder" },
  { name: "ledger.kill_switch", key: "id::text", column: "state" },
  { name: "ledger.runs", key: "id", column: "id" },
  { name: "ledger.run_attempts", key: "run_id || '/' || attempt", column: "run_id" },
  { name: "ledger.run_steps", key: "id::text", column: "kind" },
  { name: "ledger.silences", key: "id::text", column: "reason" },
  { name: "ledger.cases", key: "id", column: "id" },
  { name: "ledger.hypotheses", key: "id", column: "id" },
  { name: "ledger.hypothesis_tests", key: "id", column: "id" },
  { name: "ledger.opportunities", key: "id", column: "id" },
  { name: "ledger.opportunity_decisions", key: "id::text", column: "decision" },
  { name: "ledger.assignments", key: "id", column: "id" },
  { name: "ledger.moves", key: "id", column: "id" },
  { name: "ledger.intentions", key: "id", column: "id" },
  { name: "ledger.decision_point_calls", key: "id", column: "id" },
  // `column` is never an identity column.
  { name: "ledger.drafts", key: "id", column: "id" },
  { name: "ledger.draft_beliefs", key: "draft_id || '/' || fact_key_fp", column: "draft_id" },
  { name: "ledger.gate_checks", key: "id::text", column: "kind" },
  { name: "ledger.sent_messages", key: "id", column: "id" },
  // `column` is never an identity column.
  { name: "ledger.memory_projections", key: "id", column: "id" },
  { name: "ledger.memory_exposures", key: "id::text", column: "projection_id" },
  { name: "policy.drive_roots", key: "id", column: "id" },
  { name: "knowledge.documents", key: "id", column: "id" },
  // `column` is never an identity column.
  { name: "vault.decision_calls", key: "id", column: "id" },
  { name: "policy.thresholds", key: "id", column: "id" },
  { name: "policy.threshold_targets", key: "decision_id", column: "decision_id" },
  { name: "policy.rung_suspensions", key: "id", column: "id" },
  { name: "ledger.point_verdicts", key: "id", column: "id" },
  { name: "ledger.calibration_reports", key: "id", column: "id" },
  { name: "ledger.threshold_proposals", key: "id", column: "id" },
  // The learning item. `column` is never an identity column.
  { name: "ledger.owner_views", key: "id::text", column: "target_kind" },
  { name: "ledger.silence_samples", key: "id", column: "id" },
  { name: "ledger.move_result_links", key: "id", column: "id" },
  { name: "ledger.outcome_assessments", key: "id", column: "id" },
  { name: "ledger.forecasts", key: "id", column: "id" },
  // The lessons a move's report named and its session was served, a learning row, written by
  // ledger.report_move as pi_owner; pi_admin only reads it.
  { name: "ledger.move_lessons", key: "id::text", column: "session_id" },
  // Exposure. `column` is never an identity column.
  { name: "ledger.exposures", key: "id::text", column: "ref" },
  {
    name: "ledger.erasure_exposures",
    key: "erasure_id || '/' || coalesce(exposure_id::text, 'memory ' || memory_exposure_id::text)",
    column: "erasure_id",
  },
  // Restatement checks and memory imports. `column` is never an identity column.
  { name: "ledger.restatement_checks", key: "id::text", column: "claim_key" },
  { name: "ledger.memory_imports", key: "id::text", column: "request_id" },
  // `column` is never an identity column.
  { name: "policy.restricted_categories", key: "category", column: "category" },
  { name: "vault.restriction_requests", key: "id", column: "id" },
  {
    name: "vault.restriction_lifts",
    key: "account_id || '/' || source_item_fp || '/' || category",
    column: "account_id",
  },
  { name: "vault.restrict_screens", key: "evidence_id", column: "evidence_id" },
  { name: "vault.screen_passes", key: "id::text", column: "version" },
  { name: "vault.unresolved_mentions", key: "id", column: "id" },
  { name: "knowledge.mention_bindings", key: "id", column: "id" },
  // Forgetting.
  { name: "policy.retention_rules", key: "id", column: "id" },
  { name: "knowledge.seals", key: "id", column: "id" },
  { name: "knowledge.signatures", key: "evidence_id", column: "evidence_id" },
  { name: "policy.oauth_registrations", key: "id", column: "id" },
  { name: "policy.oauth_approvals", key: "code_hash", column: "code_hash" },
  { name: "policy.oauth_codes", key: "code_hash", column: "code_hash" },
  { name: "policy.oauth_tokens", key: "token_hash", column: "token_hash" },
  // The owner's mission for the planner, one row sealed under `own`;
  // pi_admin writes it, and the reasoner reads it within its clearance.
  { name: "projections.planner_mission", key: "one::text", column: "set_at" },
  // Lens's inbox. `column` is never an identity column.
  { name: "policy.lens_devices", key: "name", column: "name" },
  { name: "policy.capture_scope", key: "id", column: "id" },
  { name: "policy.time_exceptions", key: "id", column: "id" },
  { name: "ledger.capture_inbox", key: "id", column: "id" },
  { name: "ledger.capture_erasures", key: "id::text", column: "capture_key" },
  { name: "knowledge.captures", key: "id", column: "id" },
  { name: "policy.capture_push_refusals", key: "client_id || ' ' || hour::text", column: "client_id" },
  { name: "policy.capture_excludes", key: "id", column: "id" },
  { name: "policy.capture_accounts", key: "id", column: "id" },
  // Lens's mirror: what each mirror client was served, and the pass cursors the server issued,
  // written by the definer functions as pi_owner.
  { name: "ledger.mirror_entries", key: "id", column: "id" },
  { name: "ledger.mirror_cursors", key: "id", column: "id" },
  // Lens's saved calls: the moments a group's saved call was asked for.
  { name: "vault.model_call_members", key: "call_id || '/' || evidence_id", column: "call_id" },
  // The labels in use, pi_owner's alone, for policy.clearance_keys() and the
  // trigger that keeps them.
  { name: "policy.labels", key: "key", column: "key" },
  // The owner's role for each gap trigger, pi_admin's, read by
  // ledger.raise_gap_flag as pi_owner.
  { name: "policy.gap_routes", key: "trigger", column: "trigger" },
  // The coverage migration's three: what each sync of an account listed and decided, each scheduled
  // job's runs, and each coverage row's last state. `column` is never an identity column, and
  // coverage_states' is not one pi_admin may update.
  { name: "vault.sync_outcomes", key: "id::text", column: "account_id" },
  { name: "ledger.job_runs", key: "id::text", column: "job" },
  { name: "ledger.coverage_states", key: "row_kind || '/' || row_id", column: "row_id" },
  // An agent's work-notice address, the notices and the declines. No label.
  { name: "policy.client_webhooks", key: "client_id", column: "client_id" },
  { name: "ledger.work_notices", key: "id", column: "id" },
  { name: "ledger.work_declines", key: "opportunity_id || '/' || client_id", column: "client_id" },
  // The box health cards forwarded to the owner's agents. No label.
  { name: "ledger.health_notices", key: "id", column: "id" },
  // The day's ping for knowledge gaps, what agents wrote back, and what each client was told. No
  // source's id in the feed's two; a mark's label is its writer's clearance.
  { name: "ledger.batch_notices", key: "id", column: "id" },
  { name: "ledger.ping_walks", key: "opportunity_id", column: "opportunity_id" },
  { name: "ledger.signal_marks", key: "id", column: "state" },
  { name: "ledger.change_log", key: "client_id || '/' || signal_key", column: "signal_key" },
  { name: "ledger.change_cursors", key: "client_id", column: "client_id" },
  // Fewer cards: what code did with a claim of an answered or open fact. Its `column` is answer,
  // never null, not reopened_at: that one pi_admin may update, and it is null on most rows, so a
  // count of it would miss them.
  { name: "ledger.fact_settlements", key: "id", column: "answer" },
  {
    name: "projections.warmth_days",
    key: "compartments::text || ':' || entity_id || ':' || day::text",
    column: "entity_id",
  },
  { name: "projections.warmth_day_builds", key: "compartments::text", column: "removed_at" },
  // A card held until whom it asks about has a name.
  { name: "ledger.card_name_holds", key: "card_id", column: "held_at" },
  // A source moment's counted lines, the writer's, read by the build.
  { name: "knowledge.chat_lines", key: "id", column: "id" },
  // A close of a commitment reopened, by the owner or its agent.
  { name: "ledger.commitment_reopens", key: "id", column: "fact_fp" },
  { name: "ledger.goal_proposals", key: "id", column: "change" },
  // Query time: a claim's value rows, and the relations between claims.
  { name: "knowledge.claim_values", key: "claim_id || '/' || claim_key", column: "claim_id" },
  { name: "knowledge.claim_relations", key: "id::text", column: "kind" },
  // A claim's organization name, and a named organization's names.
  { name: "knowledge.claim_org_names", key: "claim_id", column: "name_fp" },
  { name: "knowledge.org_names", key: "id", column: "name_fp" },
  // The diffs owed, and what the diff found changed.
  { name: "ledger.trigger_rechecks", key: "id::text", column: "cause" },
  { name: "ledger.trigger_log", key: "id::text", column: "state_fp" },
  // Every goal id to its claim's fact key.
  { name: "knowledge.goal_ids", key: "claim_id", column: "goal_id" },
  // The owner's rulings on a goal by its key, and a source goal's place.
  { name: "knowledge.goal_key_rulings", key: "ruling_id", column: "lifted_at" },
  { name: "projections.goal_key_ranks", key: "fact_key_fp", column: "rank" },
  // The relation kinds' switches, and the relation step's checks.
  { name: "policy.relation_switches", key: "id::text", column: "kind" },
  { name: "ledger.relation_checks", key: "id::text", column: "state" },
  // What work expects, what it watches, and what came of it.
  { name: "ledger.expected_outcomes", key: "id::text", column: "outcome_type" },
  { name: "ledger.work_watches", key: "id::text", column: "kind" },
  { name: "ledger.outcome_links", key: "id::text", column: "kind" },
  // The outcome judge's checks.
  { name: "ledger.outcome_checks", key: "id::text", column: "state" },
  // The source checks.
  { name: "ledger.source_checks", key: "id::text", column: "kind" },
  { name: "ledger.recall_checks", key: "id::text", column: "filter" },
  { name: "ledger.surfaced_items", key: "item_key", column: "surface" },
  // Agent messages, their reads, and the improvement store.
  { name: "ledger.agent_messages", key: "id", column: "kind" },
  { name: "ledger.agent_message_reads", key: "message_id || '/' || client_id", column: "client_id" },
  { name: "ledger.improvements", key: "id", column: "kind" },
  { name: "ledger.agent_learnings", key: "id", column: "scope" },
  { name: "ledger.improvement_events", key: "id", column: "event" },
  // What an agent loop spent on its model.
  { name: "ledger.agent_spend", key: "id::text", column: "model_id" },
  // The outcome test and the measures a filing pass read.
  { name: "ledger.outcome_test_runs", key: "id", column: "suite" },
  { name: "ledger.outcome_test_tasks", key: "id", column: "task" },
  { name: "ledger.held_out_questions", key: "id", column: "class" },
  { name: "ledger.measure_readings", key: "id::text", column: "metric" },
  // Same-person questions, what agents answered, and rules from the owner's answers.
  { name: "ledger.identity_questions", key: "id", column: "basis" },
  { name: "ledger.identity_answers", key: "id", column: "verdict" },
  { name: "ledger.question_rules", key: "id", column: "pattern" },
  // Which work waits on which, under the waiting work's label.
  { name: "ledger.work_dependencies", key: "opportunity_id || '/' || blocked_by", column: "blocked_by" },
  // What an agent answered on a card before the owner saw it, under the card's label.
  { name: "ledger.card_answers", key: "id", column: "answer" },
  // An agent's ruling on a card, under the card's label.
  { name: "ledger.agent_rulings", key: "card_id", column: "answer" },
  { name: "policy.dream_lines", key: "id::text", column: "kind" },
  { name: "policy.dream_models", key: "id::text", column: "role" },
  { name: "ledger.dream_subjects", key: "entity_id || '/' || judge", column: "judge" },
  { name: "ledger.dream_findings", key: "id", column: "id" },
  { name: "ledger.belief_settlements", key: "id", column: "id" },
  { name: "ledger.dream_identity_candidates", key: "id::text", column: "judge" },
  { name: "ledger.dream_nights", key: "id::text", column: "pass" },
  // An agent's report that one person is two, under the label of what it read.
  { name: "ledger.wrong_merge_reports", key: "id", column: "because" },
  // An agent's report that a model's relation is wrong, under the relation's label and its cites'.
  { name: "ledger.relation_reports", key: "id", column: "because" },
  // A relay an agent made on a card, under the card's label.
  { name: "ledger.card_relays", key: "id", column: "option" },
  // The settings and their history. No label: a setting is a number or a code.
  { name: "policy.settings", key: "key", column: "key" },
  { name: "policy.setting_changes", key: "id::text", column: "key" },
  // The promotion gate and its intake: every promotion sent or taken, and the claims taken.
  { name: "ledger.promotions", key: "id", column: "direction" },
  { name: "knowledge.promoted_claims", key: "id", column: "ref" },
  // Session taint's counts: the agent API's refusals and would-refuses, per client, day, tool and
  // code. No label: a client id, a tool, a code and a count.
  {
    name: "ledger.session_taint_counts",
    key: "client_id || '/' || day || '/' || tool || '/' || code || '/' || enforced",
    column: "tool",
  },
];

export const WORK_TABLES: readonly string[] = [
  "policy.intents",
  "policy.harness_modes",
  "policy.work_settings",
  "policy.stage_plan",
  "projections.goal_state",
  "queue.leases",
  "ledger.kill_switch",
  "ledger.runs",
  "ledger.run_attempts",
  "ledger.run_steps",
  "ledger.silences",
  "ledger.cases",
  "ledger.hypotheses",
  "ledger.hypothesis_tests",
  "ledger.opportunities",
  "ledger.opportunity_decisions",
  "ledger.assignments",
  "ledger.moves",
  "ledger.intentions",
  "ledger.decision_point_calls",
];
// The send proxy's four.
export const SEND_TABLES: readonly string[] = [
  "ledger.drafts",
  "ledger.draft_beliefs",
  "ledger.gate_checks",
  "ledger.sent_messages",
];
// The decision tables, seven.
export const DECISION_TABLES: readonly string[] = [
  "vault.decision_calls",
  "policy.thresholds",
  "policy.threshold_targets",
  "policy.rung_suspensions",
  "ledger.point_verdicts",
  "ledger.calibration_reports",
  "ledger.threshold_proposals",
];
// The memory adapters' two: ledger tables the reader holds no privilege on.
export const MEMORY_TABLES: readonly string[] = ["ledger.memory_projections", "ledger.memory_exposures"];
// The learning item's five: only pi_admin reads them, and no runtime role but pi_admin writes any.
export const LEARNING_TABLES: readonly string[] = [
  "ledger.owner_views",
  "ledger.silence_samples",
  "ledger.move_result_links",
  "ledger.outcome_assessments",
  "ledger.forecasts",
  "ledger.move_lessons",
];
// Their grants: the admin's, and pi_owner's for the two outcome functions and the taint.
export const LEARNING_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_owner", ("select" | "insert" | "update")[]>>>
> = {
  "ledger.owner_views": { pi_admin: ["select", "insert"] },
  "ledger.silence_samples": { pi_admin: ["select", "insert"], pi_owner: ["select", "update"] },
  "ledger.move_result_links": { pi_admin: ["select"], pi_owner: ["select", "insert", "update"] },
  "ledger.outcome_assessments": { pi_admin: ["select"], pi_owner: ["select", "insert", "update"] },
  "ledger.forecasts": { pi_admin: ["select", "insert"], pi_owner: ["select", "update"] },
  // Written only by ledger.report_move, as pi_owner.
  "ledger.move_lessons": { pi_admin: ["select"], pi_owner: ["select", "insert"] },
};
// The mentions' two: a filed mention and the owner's binding. The reader reads nothing of either; a
// sync writes neither.
export const MENTION_TABLES: readonly string[] = ["vault.unresolved_mentions", "knowledge.mention_bindings"];
// Their grants: each cell one policy named <role>_<cell> and the same table privileges. pi_owner
// selects the unresolved mentions, for the gap scan.
export const MENTION_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<Record<"pi_admin" | "pi_writer" | "pi_pipeline" | "pi_owner", ("all" | "select" | "insert" | "delete")[]>>
  >
> = {
  "vault.unresolved_mentions": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete"],
    pi_pipeline: ["select", "insert", "delete"],
    pi_owner: ["select"],
  },
  // The writer selects every binding, inserts a code one and deletes a source moment's live code
  // binding; pi_owner selects them for policy.moment_handle_names.
  "knowledge.mention_bindings": {
    pi_admin: ["all"],
    pi_writer: ["select", "insert", "delete"],
    pi_pipeline: ["select"],
    pi_owner: ["select"],
  },
};
// The exposure tables: ledger tables only pi_admin reads, and nothing updates or deletes. The
// definer function and the trigger insert exposures as pi_owner; the erasure's hook inserts its
// links as pi_admin.
export const EXPOSURE_TABLES: readonly string[] = ["ledger.exposures", "ledger.erasure_exposures"];
export const EXPOSURE_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_owner", ("select" | "insert")[]>>>
> = {
  "ledger.exposures": { pi_admin: ["select"], pi_owner: ["select", "insert"] },
  // pi_owner's select is for policy.serve_mirror's pruning of the ended mirror rows no erasure
  // links.
  "ledger.erasure_exposures": { pi_admin: ["select", "insert"], pi_owner: ["select"] },
};
// The rest of the agent records, two: ledger tables the reader holds no privilege on either.
export const AGENT_REST_TABLES: readonly string[] = ["ledger.restatement_checks", "ledger.memory_imports"];
// The grants of the memory tables and of the agent records' two, each cell one policy: the admin reads, and
// the definer functions, as pi_owner, select, insert and update; the writer reads seven columns of a
// projection, the admin updates a mark's two clear columns, and the writer an import row's mark and record.
export const MEMORY_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_owner" | "pi_writer", ("select" | "insert" | "update")[]>>>
> = {
  "ledger.memory_projections": {
    pi_admin: ["select"],
    pi_owner: ["select", "insert", "update"],
    pi_writer: ["select"],
  },
  "ledger.memory_exposures": { pi_admin: ["select"], pi_owner: ["select", "insert", "update"] },
  "ledger.restatement_checks": { pi_admin: ["select", "update"], pi_owner: ["select", "insert"] },
  "ledger.memory_imports": {
    pi_admin: ["select"],
    pi_writer: ["select", "update"],
    pi_owner: ["select", "insert", "update"],
  },
};
// The column grants among them.
export const MEMORY_COLUMN_GRANTS: readonly string[] = [
  ...["id", "client_id", "evidence_ids", "first_served_at", "ended_at", "tainted_at", "line_fp"].map(
    (column) => `ledger.memory_projections ${column} pi_writer SELECT`,
  ),
  "ledger.restatement_checks cleared_at pi_admin UPDATE",
  "ledger.restatement_checks cleared_by pi_admin UPDATE",
  "ledger.memory_imports mark pi_writer UPDATE",
  "ledger.memory_imports record_id pi_writer UPDATE",
];
const MEMORY_COLUMN_CELLS: ReadonlySet<string> = new Set(
  MEMORY_COLUMN_GRANTS.map((line) => {
    const [table, , role, privilege] = line.split(" ");
    return `${table ?? ""} ${role ?? ""} ${(privilege ?? "").toLowerCase()}`;
  }),
);
export const isMemoryColumnGrant = (table: string, role: string, cell: string): boolean =>
  MEMORY_COLUMN_CELLS.has(`${table} ${role} ${cell}`);
// The restriction tables, five.
export const RESTRICTED_TABLES: readonly string[] = [
  "policy.restricted_categories",
  "vault.restriction_requests",
  "vault.restriction_lifts",
  "vault.restrict_screens",
  "vault.screen_passes",
];
// The forgetting tables, three: only the owner's commands write the rules and the seals, and only
// the signature step the signatures, never a mail or calendar ingest.
export const FORGETTING_TABLES: readonly string[] = [
  "policy.retention_rules",
  "knowledge.seals",
  "knowledge.signatures",
];
// Their grants: the admin's, the writer's, the reader's of a signature, and pi_owner's of the
// rules and the seals for policy.journal_mark. The admin's update of a seal is two columns.
export const FORGETTING_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<Record<"pi_admin" | "pi_writer" | "pi_reader" | "pi_owner", ("all" | "select" | "insert" | "update")[]>>
  >
> = {
  "policy.retention_rules": { pi_admin: ["select", "insert"], pi_writer: ["select"], pi_owner: ["select"] },
  "knowledge.seals": { pi_admin: ["select", "insert", "update"], pi_writer: ["select"], pi_owner: ["select"] },
  "knowledge.signatures": { pi_admin: ["all"], pi_writer: ["all"], pi_reader: ["select"] },
};
export const FORGETTING_COLUMN_GRANTS: readonly string[] = [
  "knowledge.seals lift_seq pi_admin UPDATE",
  "knowledge.seals lifted_at pi_admin UPDATE",
];

// The restriction grants: each cell one policy named <role>_<cell> and, but for pi_owner's and the column
// grant below, the same table privileges. pi_restricted's cells are not here: it holds a copy of each of
// pi_pipeline's, on every table (restrictedCellsOf).
export const RESTRICTED_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_writer" | "pi_pipeline" | "pi_owner",
        ("all" | "select" | "insert" | "update" | "delete")[]
      >
    >
  >
> = {
  "policy.restricted_categories": {
    pi_admin: ["all"],
    pi_writer: ["select"],
    pi_pipeline: ["select"],
    pi_owner: ["select"],
  },
  "vault.restriction_requests": { pi_admin: ["all"], pi_writer: ["select", "update", "delete"], pi_owner: ["insert"] },
  "vault.restriction_lifts": {
    pi_admin: ["all"],
    pi_writer: ["select"],
    pi_pipeline: ["select"],
    pi_owner: ["select"],
  },
  "vault.restrict_screens": {
    pi_admin: ["all"],
    pi_writer: ["select", "delete"],
    pi_pipeline: ["select", "insert", "update"],
  },
  "vault.screen_passes": { pi_admin: ["all"], pi_writer: ["select", "insert"] },
};
export const RESTRICTED_COLUMN_GRANTS: readonly string[] = [
  "vault.restriction_requests applied_at pi_writer UPDATE",
  "vault.restrict_screens categories pi_pipeline UPDATE",
  "vault.restrict_screens screened_at pi_pipeline UPDATE",
];

const BLIND = / AND \(NOT policy\.is_restricted\((compartments|audience)\)\)/g;
const ONLY = / AND policy\.is_restricted\((compartments|audience)\)/g;
export const bareCondition = (text: string | null): string | null =>
  text === null
    ? null
    : text
        .replace(BLIND, "")
        .replace(ONLY, "")
        .replace(/[()\s]/g, "");

// The tables pi_reader reads nothing of. A pinned list: every reader-facing check below runs over
// the other knowledge tables, and owner-database.db.test.ts asserts 42501 for the reader on each of
// these.
export const OWNER_ONLY: readonly string[] = [
  "knowledge.owner_decisions",
  "knowledge.vetoes",
  "ledger.cards",
  "ledger.record_events",
  "ledger.basis",
];

// What pi_pipeline holds on the owner surface's five tables and eight functions: exactly these
// lines, and nothing else. Each line is one of "policy <table> <policy name> <command>",
// "privilege <table> <privilege>" and "execute <schema>.<function>".
export const PIPELINE_LEDGER_GRANTS: readonly string[] = [
  "policy ledger.cards pi_pipeline_select SELECT",
  "policy ledger.cards pi_pipeline_insert INSERT",
  "policy ledger.record_events pi_pipeline_select SELECT",
  "policy ledger.record_events pi_pipeline_insert INSERT",
  "privilege ledger.cards SELECT",
  "privilege ledger.cards INSERT",
  // A column grant: every column but body_enc.
  "privilege ledger.record_events SELECT",
  "privilege ledger.record_events INSERT",
  "execute ledger.lock_rows",
  "execute ledger.label",
  // The update of a card's match_fp alone, once.
  "policy ledger.cards pi_pipeline_update UPDATE",
  "privilege ledger.cards UPDATE",
];

export const PIPELINE_LEDGER_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.agent_writes pi_pipeline_select": { qual: "true", check: null },
  "ledger.agent_writes pi_pipeline_update": { qual: "true", check: "(flagged_at IS NOT NULL)" },
  "ledger.cards pi_pipeline_select": { qual: "(created_by = 'system:extract'::text)", check: null },
  "ledger.cards pi_pipeline_insert": {
    qual: null,
    check:
      "((kind = ANY (ARRAY['agent_claim'::text, 'about_you'::text, 'client_preference'::text, 'same_fact'::text, 'relation_audit'::text, 'time_effort'::text])) AND (created_by = 'system:extract'::text))",
  },
  "ledger.cards pi_restricted_insert": {
    qual: null,
    check:
      "((kind = ANY (ARRAY['agent_claim'::text, 'about_you'::text, 'client_preference'::text])) AND (created_by = 'system:extract'::text))",
  },
  "ledger.record_events pi_pipeline_select": {
    qual: "((row_kind = 'card'::text) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)))",
    check: null,
  },
  "ledger.record_events pi_pipeline_insert": {
    qual: null,
    check:
      "((row_kind = 'card'::text) AND (by = 'system:extract'::text) AND (event = ANY (ARRAY['pending'::text, 'deferred'::text])) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)))",
  },
};

// The writer's policies on ledger tables, for the identity sweep at
// the end of a sync, as pg_policies prints them.
export const WRITER_LEDGER_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.cards pi_writer_select": { qual: "(created_by = 'system:identity'::text)", check: null },
  "ledger.cards pi_writer_insert": {
    qual: null,
    check:
      "((kind = ANY (ARRAY['same_person'::text, 'shared_address'::text, 'ignore_narrowed'::text, 'same_person_batch'::text])) AND (created_by = 'system:identity'::text))",
  },
  "ledger.record_events pi_writer_select": {
    qual: "((row_kind = 'card'::text) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)))",
    check: null,
  },
  "ledger.record_events pi_writer_insert": {
    qual: null,
    check:
      "((row_kind = 'card'::text) AND (by = 'system:identity'::text) AND (event = ANY (ARRAY['pending'::text, 'deferred'::text])) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)) AND ledger.card_unopened(row_id))",
  },
};
