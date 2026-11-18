// Every sealed column, and the grants and conditions of the work, send and decision migrations.

// Every sealed column, with the column that holds the id its envelope is bound to.
export const SEALED: readonly { table: string; id: string; column: string }[] = [
  { table: "policy.secrets", id: "name", column: "value_enc" },
  { table: "vault.source_accounts", id: "id", column: "address_enc" },
  { table: "vault.source_accounts", id: "id", column: "cursor_enc" },
  { table: "vault.source_accounts", id: "id", column: "send_as_enc" },
  { table: "vault.evidence_items", id: "id", column: "item_enc" },
  { table: "vault.evidence_blobs", id: "blob_ref", column: "envelope" },
  { table: "knowledge.accounts", id: "id", column: "value_enc" },
  { table: "knowledge.domains", id: "id", column: "domain_enc" },
  { table: "knowledge.aliases", id: "id", column: "value_enc" },
  { table: "knowledge.messages", id: "id", column: "subject_enc" },
  { table: "knowledge.messages", id: "id", column: "thread_id_enc" },
  { table: "knowledge.messages", id: "id", column: "sender_enc" },
  { table: "knowledge.messages", id: "id", column: "sender_name_enc" },
  { table: "knowledge.messages", id: "id", column: "body_enc" },
  { table: "knowledge.messages", id: "id", column: "facts_enc" },
  { table: "knowledge.event_details", id: "event_id", column: "title_enc" },
  // Contacts and identity.
  { table: "knowledge.contacts", id: "id", column: "facts_enc" },
  { table: "ledger.agent_writes", id: "id", column: "body_enc" },
  // From the extraction migration.
  { table: "vault.pipeline_items", id: "evidence_id", column: "facts_enc" },
  { table: "vault.model_calls", id: "id", column: "output_enc" },
  { table: "vault.unmapped_claims", id: "id", column: "facts_enc" },
  { table: "vault.extraction_reviews", id: "id", column: "facts_enc" },
  { table: "knowledge.claims", id: "id", column: "content_enc" },
  // From the documents migration: a root's id under the `own` key, and a document's seven under its
  // row's compartment.
  { table: "policy.drive_roots", id: "id", column: "root_enc" },
  { table: "knowledge.documents", id: "id", column: "title_enc" },
  { table: "knowledge.documents", id: "id", column: "file_id_enc" },
  { table: "knowledge.documents", id: "id", column: "owner_enc" },
  { table: "knowledge.documents", id: "id", column: "sharer_enc" },
  { table: "knowledge.documents", id: "id", column: "body_enc" },
  { table: "knowledge.documents", id: "id", column: "outline_enc" },
  { table: "knowledge.documents", id: "id", column: "facts_enc" },
  // From the projects migration: the owner's name for a project.
  { table: "knowledge.projects", id: "id", column: "name_enc" },
  // Lens's inbox: a pushed item under `own`, a scope rule's value and account under `own`, and a
  // stored item's facts under its row's label.
  { table: "ledger.capture_inbox", id: "id", column: "body_enc" },
  { table: "policy.capture_scope", id: "id", column: "value_enc" },
  { table: "policy.time_exceptions", id: "id", column: "value_enc" },
  { table: "policy.capture_scope", id: "id", column: "account_enc" },
  // The exclude list's hosts and the account map's accounts.
  { table: "policy.capture_excludes", id: "id", column: "value_enc" },
  { table: "policy.capture_accounts", id: "id", column: "account_enc" },
  { table: "knowledge.captures", id: "id", column: "facts_enc" },
  // From the anchors migration: a device anchor's value.
  { table: "knowledge.project_anchors", id: "id", column: "value_enc" },
];

// The sealed columns of the owner surface's tables, which no writer fills: each is sealed with
// `sealUnder` for its row's compartments. Kept apart from SEALED, whose test asks the writer to
// fill every column it lists.
export const OWNER_SEALED: readonly { table: string; id: string; column: string }[] = [
  { table: "knowledge.owner_decisions", id: "id", column: "body_enc" },
  { table: "ledger.cards", id: "id", column: "body_enc" },
  { table: "ledger.record_events", id: "id::text", column: "body_enc" },
];

export const RECORD_EVENTS_WORK_INSERT =
  "((by <> 'owner'::text) OR (code IS NULL) OR (NOT (((row_kind = 'opportunity'::text) AND (event = 'no_go'::text)) OR ((row_kind = ANY (ARRAY['hypothesis'::text, 'goal_proposal'::text])) AND (event = 'rejected'::text)))))";

// The sealed columns of the durable-work tables, which no writer fills either: the store seals each
// for its row's compartments before the function call.
export const WORK_SEALED: readonly { table: string; id: string; column: string }[] = [
  { table: "ledger.hypotheses", id: "id", column: "body_enc" },
  { table: "ledger.opportunities", id: "id", column: "body_enc" },
  { table: "ledger.intentions", id: "id", column: "body_enc" },
  { table: "projections.goal_state", id: "goal_id", column: "statement_enc" },
];

export type WorkRole = "pi_admin" | "pi_work" | "pi_reader" | "pi_owner";
export type WorkCell = "all" | "select" | "insert" | "update" | "delete";
export const WORK_TABLE_GRANTS: Readonly<Record<string, Partial<Record<WorkRole, WorkCell[]>>>> = {
  "policy.intents": { pi_admin: ["all"], pi_work: ["select"], pi_owner: ["select"] },
  "policy.harness_modes": { pi_admin: ["all"], pi_work: ["select"], pi_owner: ["select"] },
  "policy.work_settings": { pi_admin: ["all"], pi_work: ["select"], pi_owner: ["select"] },
  "policy.stage_plan": { pi_admin: ["select"], pi_work: ["select"], pi_owner: ["select"] },
  "projections.goal_state": {
    pi_admin: ["all"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "update"],
  },
  "queue.leases": {
    pi_admin: ["select", "delete"],
    pi_work: ["select", "insert", "update", "delete"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update", "delete"],
  },
  "ledger.kill_switch": { pi_admin: ["select", "insert"], pi_work: ["select"], pi_owner: ["select"] },
  "ledger.runs": {
    pi_admin: ["select", "insert"],
    pi_work: ["select", "insert"],
    pi_reader: ["select"],
    pi_owner: ["select", "update"],
  },
  "ledger.run_attempts": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert"],
  },
  // pi_owner's update, for ledger.forget_web_requests alone.
  "ledger.run_steps": { pi_admin: ["select"], pi_work: ["select"], pi_owner: ["select", "insert", "update"] },
  "ledger.silences": { pi_admin: ["select", "insert"], pi_work: ["select", "insert"], pi_owner: ["select", "insert"] },
  "ledger.cases": { pi_admin: ["select"], pi_work: ["select"], pi_owner: ["select", "insert"] },
  "ledger.hypotheses": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.hypothesis_tests": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.opportunities": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  // pi_owner inserts a gap flag's rung-0 go, in ledger.raise_gap_flag.
  "ledger.opportunity_decisions": {
    pi_admin: ["select", "insert"],
    pi_work: ["select", "insert"],
    pi_owner: ["select", "insert"],
  },
  "ledger.assignments": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert"],
  },
  "ledger.moves": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.intentions": {
    pi_admin: ["select", "insert"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.decision_point_calls": {
    pi_admin: ["select", "insert"],
    pi_work: ["select", "insert"],
    pi_owner: ["select", "insert"],
  },
};
// No pi_owner policy is added on any of them.
export const WORK_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<WorkRole, WorkCell[]>>>> = {
  "policy.clients": { pi_work: ["select"] },
  "knowledge.owner_decisions": { pi_work: ["select"] },
  "knowledge.events": { pi_work: ["select"] },
  "knowledge.event_details": { pi_work: ["select"] },
  "knowledge.messages": { pi_work: ["select"] },
  "knowledge.entities": { pi_work: ["select"] },
  "ledger.basis": { pi_work: ["select"], pi_reader: ["select"] },
  "ledger.record_events": { pi_work: ["select", "insert"], pi_reader: ["select"] },
  "ledger.cards": { pi_work: ["select", "insert"] },
};
// The cells that are granted on columns and not on the table, and those columns.
const WORK_COLUMNS: Readonly<Record<string, { role: WorkRole; columns: string[] }>> = {
  "policy.clients": { role: "pi_work", columns: ["id", "kind", "status", "compartments"] },
  "projections.goal_state": {
    role: "pi_work",
    columns: ["goal_id", "status", "ruling_id", "updated_at", "compartments"],
  },
  "knowledge.owner_decisions": {
    role: "pi_work",
    columns: [
      "id",
      "kind",
      "target_kind",
      "target_id",
      "answer",
      "card_id",
      "decided_at",
      "compartments",
      "tainted_at",
    ],
  },
  "knowledge.events": { role: "pi_work", columns: ["id", "evidence_id", "compartments"] },
  "knowledge.event_details": {
    role: "pi_work",
    columns: ["event_id", "starts_at", "ends_at", "cancelled", "owner_response", "compartments"],
  },
  "knowledge.messages": { role: "pi_work", columns: ["id", "evidence_id", "direction", "thread_fp", "compartments"] },
  "knowledge.entities": { role: "pi_work", columns: ["id", "kind"] },
  // And its creation time, for a goal's support at read.
  "ledger.moves": {
    role: "pi_reader",
    columns: ["id", "opportunity_id", "stage", "compartments", "tainted_at", "created_at"],
  },
};
export const isWorkColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "select" && WORK_COLUMNS[table]?.role === role;
// As "<table> <column> <role> SELECT".
export const WORK_COLUMN_GRANTS: readonly string[] = Object.entries(WORK_COLUMNS).flatMap(
  ([table, { role, columns }]) => columns.map((column) => `${table} ${column} ${role} SELECT`),
);
export const workColumnsOf = (table: string): readonly string[] => WORK_COLUMNS[table]?.columns ?? [];
const CLEARANCE = /select\s+(policy\.)?client_clearance\(\)/i;
const CURRENT_CLIENT = /current_client\(\)/i;
export const WORK_READER_CONDITIONS: Readonly<Record<string, readonly RegExp[]>> = {
  "projections.goal_state": [CLEARANCE, /reasoner/i],
  "queue.leases": [/\bholder\b/i, CURRENT_CLIENT],
  "ledger.opportunities": [CLEARANCE],
  "ledger.hypotheses": [CLEARANCE],
  "ledger.hypothesis_tests": [CLEARANCE],
  "ledger.basis": [CLEARANCE, /'card'/i],
  "ledger.record_events": [CLEARANCE, /'card'/i],
  "ledger.assignments": [CLEARANCE, /\bclient_id\b/i, CURRENT_CLIENT],
  "ledger.moves": [CLEARANCE],
  "ledger.intentions": [CLEARANCE, /\bclient_id\b/i, CURRENT_CLIENT, /reasoner/i],
  "ledger.runs": [/run_attempts/i, CURRENT_CLIENT],
  "ledger.run_attempts": [/\bclient_id\b/i, CURRENT_CLIENT],
};

export type SendRole = WorkRole | "pi_proxy";
export const SEND_TABLE_GRANTS: Readonly<Record<string, Partial<Record<SendRole, WorkCell[]>>>> = {
  "ledger.drafts": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_proxy: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.draft_beliefs": { pi_admin: ["select"], pi_owner: ["select", "insert"] },
  "ledger.gate_checks": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_proxy: ["select"],
    pi_owner: ["select", "insert"],
  },
  "ledger.sent_messages": {
    pi_admin: ["select"],
    pi_work: ["select"],
    pi_proxy: ["select"],
    pi_owner: ["select", "insert", "update"],
  },
};
export const STATE_WAKE_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<WorkRole, WorkCell[]>>>> = {
  "knowledge.claim_entities": { pi_owner: ["select"] },
};

export const SEND_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<SendRole, WorkCell[]>>>> = {
  "policy.secrets": { pi_proxy: ["select", "insert", "update", "delete"], pi_owner: ["select"] },
  "vault.source_accounts": { pi_proxy: ["select"], pi_owner: ["select"] },
  "vault.evidence_items": { pi_proxy: ["select"] },
  "vault.sent_recipients": { pi_owner: ["select"] },
  "knowledge.owner_decisions": { pi_owner: ["insert"] },
  "knowledge.claims": { pi_owner: ["select"] },
  "knowledge.suppressions": { pi_owner: ["select"] },
  "knowledge.removed_evidence": { pi_owner: ["select"] },
  "ledger.record_events": { pi_proxy: ["select"] },
  "ledger.basis": { pi_proxy: ["select"] },
  "ledger.cards": { pi_proxy: ["select"] },
  "ledger.kill_switch": { pi_proxy: ["select"] },
};
// The cells granted on columns: pi_proxy's three, and pi_work's two, which are every column but the
// sealed or the clear facts one (computed from the catalogue by the tests that compare them).
export const SEND_PROXY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "ledger.cards": ["id", "target_kind", "target_id"],
  "vault.source_accounts": ["id", "label", "connector", "compartments", "address_enc", "last_sync_at", "last_outcome"],
  "vault.evidence_items": ["sent_id"],
};
export const SEND_WORK_COLUMNS_BUT: Readonly<Record<string, string>> = {
  "ledger.drafts": "body_enc",
  "ledger.gate_checks": "facts",
};
export const isSendColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "select" &&
  ((role === "pi_proxy" && SEND_PROXY_COLUMNS[table] !== undefined) ||
    (role === "pi_work" && SEND_WORK_COLUMNS_BUT[table] !== undefined));
export const SEND_CONDITIONS: Readonly<
  Record<string, { qual: readonly RegExp[] | null; check: readonly RegExp[] | null }>
> = {
  "policy.secrets pi_admin_all": {
    qual: [/not\s+starts_with\(name, 'google-send\/'/i],
    check: [/not\s+starts_with\(name, 'google-send\/'/i],
  },
  "policy.secrets pi_proxy_select": { qual: [/^starts_with\(name, 'google-send\/'::text\)$/], check: null },
  "policy.secrets pi_proxy_insert": { qual: null, check: [/^starts_with\(name, 'google-send\/'::text\)$/] },
  "policy.secrets pi_proxy_update": {
    qual: [/^starts_with\(name, 'google-send\/'::text\)$/],
    check: [/^starts_with\(name, 'google-send\/'::text\)$/],
  },
  "policy.secrets pi_proxy_delete": { qual: [/^starts_with\(name, 'google-send\/'::text\)$/], check: null },
  "policy.secrets pi_owner_select": {
    qual: [/starts_with\(name, 'google\/'::text\)/, /starts_with\(name, 'google-send\/'::text\)/, /\bOR\b/i],
    check: null,
  },
  "vault.evidence_items pi_proxy_select": { qual: [/^\(?sent_id IS NOT NULL\)?$/i], check: null },
  "knowledge.owner_decisions pi_owner_insert": { qual: null, check: [/'send'/, /'send_settle'/] },
  "ledger.record_events pi_proxy_select": { qual: [/'draft'/, /'send'/], check: null },
  "ledger.basis pi_proxy_select": { qual: [/'draft'/], check: null },
};

export type DecisionRole = "pi_admin" | "pi_writer" | "pi_pipeline" | "pi_owner";
export const DECISION_TABLE_GRANTS: Readonly<Record<string, Partial<Record<DecisionRole, WorkCell[]>>>> = {
  "vault.decision_calls": { pi_admin: ["select", "insert", "delete"], pi_writer: ["select", "delete"] },
  "policy.thresholds": { pi_admin: ["all"], pi_pipeline: ["select"] },
  "policy.threshold_targets": { pi_admin: ["all"] },
  "policy.rung_suspensions": { pi_admin: ["all"], pi_pipeline: ["select"] },
  // The ledger is append-only: the admin selects and inserts, and updates two columns of a verdict,
  // for the erasure hook (a column grant, below).
  "ledger.point_verdicts": { pi_admin: ["select", "insert", "update"] },
  "ledger.calibration_reports": { pi_admin: ["select", "insert"] },
  "ledger.threshold_proposals": { pi_admin: ["select", "insert"] },
};
export const DECISION_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<DecisionRole, WorkCell[]>>>> = {
  "vault.evidence_items": { pi_owner: ["update"] },
  "knowledge.messages": { pi_owner: ["update"] },
};
export const DECISION_COLUMN_GRANTS: readonly string[] = [
  "ledger.agent_writes flagged_at pi_admin UPDATE",
  "ledger.point_verdicts tainted_at pi_admin UPDATE",
  "ledger.point_verdicts body_enc pi_admin UPDATE",
];
const PAIR_ROWS = "starts_with(subject, 'pair:'::text)";
const FACTS_ROWS = "starts_with(subject, 'facts:'::text)";
const PAIR_OR_FACTS_ROWS = `(${PAIR_ROWS} OR ${FACTS_ROWS})`;
export const DECISION_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "vault.decision_calls pi_admin_insert": { qual: null, check: PAIR_ROWS },
  // The writer's reach the same-fact calls too, for an erasure, and the Pipeline selects and
  // inserts those alone.
  "vault.decision_calls pi_writer_select": { qual: PAIR_OR_FACTS_ROWS, check: null },
  "vault.decision_calls pi_writer_delete": { qual: PAIR_OR_FACTS_ROWS, check: null },
  "vault.decision_calls pi_pipeline_select": { qual: FACTS_ROWS, check: null },
  "vault.decision_calls pi_pipeline_insert": { qual: null, check: FACTS_ROWS },
};
// The sealed columns of the decision tables, each sealed with `sealUnder` for its row's
// compartments.
export const DECISION_SEALED: readonly { table: string; id: string; column: string }[] = [
  { table: "vault.decision_calls", id: "id", column: "output_enc" },
  { table: "ledger.point_verdicts", id: "id", column: "body_enc" },
];
export const DECISION_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  "vault.mark_recovery(text,boolean,text)": ["pi_pipeline", "pi_restricted"],
};
