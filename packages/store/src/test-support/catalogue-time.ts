// The daily time pass's cells: the Pipeline's, with no restricted copy, since the restricted worker
// runs no pass. Its reads of an exception's two columns and of a suppression's fingerprint are
// column grants.
export const TIME_PASS_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_writer" | "pi_reader" | "pi_pipeline" | "pi_owner",
        ("all" | "select" | "insert" | "update" | "delete")[]
      >
    >
  >
> = {
  // pi_owner reads a proposal for ledger.judge_time_proposal.
  "knowledge.time_rulings": {
    pi_admin: ["all"],
    pi_reader: ["select"],
    pi_pipeline: ["select", "insert"],
    pi_owner: ["select"],
  },
  // An agent's anchors and time rulings: the definers write them as pi_owner, the reader reads their
  // clear columns, the owner's commands lift and mark them.
  "knowledge.agent_anchors": {
    pi_admin: ["all"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
    pi_pipeline: ["select"],
  },
  "knowledge.agent_time_rulings": {
    pi_admin: ["all"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert", "update"],
    pi_pipeline: ["select"],
  },
  "policy.time_exceptions": { pi_admin: ["all"], pi_pipeline: ["select"] },
  "knowledge.suppressions": {
    pi_admin: ["select", "insert", "delete"],
    pi_writer: ["select"],
    pi_owner: ["select"],
    pi_pipeline: ["select"],
  },
};
export const TIME_PASS_COLUMN_GRANTS: readonly string[] = [
  ...["id", "project_id", "from_at", "to_at", "source", "pending_card", "lifted_at", "compartments", "proposal_id"].map(
    (column) => `knowledge.time_rulings ${column} pi_reader SELECT`,
  ),
  ...["id", "project_id", "kind", "anchor_fp", "client_id", "created_at", "lifted_at", "compartments"].map(
    (column) => `knowledge.agent_anchors ${column} pi_reader SELECT`,
  ),
  ...[
    "id",
    "project_id",
    "from_at",
    "to_at",
    "proposal_id",
    "client_id",
    "created_at",
    "lifted_at",
    "compartments",
    "reach",
  ].map((column) => `knowledge.agent_time_rulings ${column} pi_reader SELECT`),
  // The daily time pass reads what agents filed, never an anchor's sealed place or a request id.
  ...["id", "project_id", "anchor_fp", "lifted_at", "compartments"].map(
    (column) => `knowledge.agent_anchors ${column} pi_pipeline SELECT`,
  ),
  ...["id", "project_id", "from_at", "to_at", "lifted_at", "compartments", "reach"].map(
    (column) => `knowledge.agent_time_rulings ${column} pi_pipeline SELECT`,
  ),
  ...["match", "value_fp"].map((column) => `policy.time_exceptions ${column} pi_pipeline SELECT`),
  "knowledge.suppressions value_fp pi_pipeline SELECT",
  ...["job", "ended_at", "code"].map((column) => `ledger.job_runs ${column} pi_pipeline SELECT`),
];
export const isTimePassColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "select" &&
  ((table === "knowledge.time_rulings" && role === "pi_reader") ||
    ((table === "knowledge.agent_anchors" || table === "knowledge.agent_time_rulings") &&
      (role === "pi_reader" || role === "pi_pipeline")) ||
    (role === "pi_pipeline" &&
      ["policy.time_exceptions", "knowledge.suppressions", "ledger.job_runs"].includes(table)));
export const TIME_PASS_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "knowledge.time_rulings pi_pipeline_insert": {
    qual: null,
    check: "((source = 'system'::text) AND (ruling_id IS NULL) AND (lifted_at IS NULL) AND (lift_ruling_id IS NULL))",
  },
  "ledger.job_runs pi_pipeline_insert": { qual: null, check: "(job = 'time_pass'::text)" },
  "ledger.job_runs pi_pipeline_select": { qual: "(job = 'time_pass'::text)", check: null },
};

// The areas, which only the owner's `pia areas` writes and whose label is `own` alone, so no sweep
// over both compartments asks it: areas.db.test.ts and the hidden-rows work test ask the reader's
// policy on it.
export const AREA_TABLES: readonly string[] = ["knowledge.areas"];
// The admin never deletes an area; the reader's is a column grant; pi_owner reads one for the
// project functions' checks.
export const AREA_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_reader" | "pi_owner", ("select" | "insert" | "update")[]>>>
> = {
  "knowledge.areas": { pi_admin: ["select", "insert", "update"], pi_reader: ["select"], pi_owner: ["select"] },
};
// The reader's columns of an area.
export const AREA_READER_COLUMNS: readonly string[] = ["id", "key", "name_enc", "position", "state", "compartments"];

// The time tables the reader reads the clear columns of: the rulings, an agent's anchors and rulings.
export const TIME_TABLES: readonly string[] = [
  "knowledge.time_rulings",
  "knowledge.agent_anchors",
  "knowledge.agent_time_rulings",
];
