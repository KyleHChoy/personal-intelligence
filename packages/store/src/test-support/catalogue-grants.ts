// Schemas and runtime roles, and the grants of the Lens, query-time, outcome, notice, warmth, coverage and research migrations.
import {
  DECISION_TABLES,
  FORGETTING_TABLES,
  MENTION_TABLES,
  OWNER_ONLY,
  RESTRICTED_TABLES,
  TABLES,
  type Table,
} from "./catalogue.ts";
import { PROMOTION_TABLES } from "./catalogue-promotion.ts";
import { AREA_TABLES, TIME_TABLES } from "./catalogue-time.ts";

export const SCHEMAS = ["policy", "vault", "knowledge", "projections", "ledger", "queue"] as const;
export const RUNTIME_ROLES = [
  "pi_admin",
  "pi_writer",
  "pi_reader",
  "pi_pipeline",
  "pi_work",
  "pi_proxy",
  "pi_restricted",
] as const;

// The tables the extraction migration adds, which nothing of stage 1 writes: a stage 1 test that
// asks every table to hold a row after a sync asks it of the others.
const EXTRACTION_TABLES: ReadonlySet<string> = new Set([
  "vault.pipeline_items",
  "vault.model_calls",
  "vault.model_usage",
  "vault.extraction_runs",
  "vault.unmapped_claims",
  "vault.extraction_reviews",
  "knowledge.claims",
  "knowledge.claim_entities",
]);
// Nor does a sync write the ledger's tables or the erasure's: only a client's calls and the owner's
// commands do. A sync's taint only updates ledger rows that are already there. Nor does a stage 1
// sync of mail and events write the contacts' tables: a contacts sync or an owner's ruling does.
// Nor do mail and calendar write the Drive's two tables: only a Drive sync and the owner's roots
// do. Nor the decision tables: the identity sweep, the owner's commands and the erasure write them.
// Nor the restriction tables: a mail or calendar sync with no restricted category on writes none of
// them.
const DRIVE_TABLES: readonly string[] = ["policy.drive_roots", "knowledge.documents"];
// Nor does a sync write the mentions' two, nor the projects' three: only a run's commit and the
// owner's commands do.
export const syncedBy = (table: string): boolean =>
  !EXTRACTION_TABLES.has(table) &&
  !table.startsWith("ledger.") &&
  !ERASURE_TABLES.includes(table) &&
  !CONTACT_TABLES.includes(table) &&
  !DRIVE_TABLES.includes(table) &&
  !OWNER_REST_TABLES.includes(table) &&
  !ORGANIZATION_TABLES.includes(table) &&
  !DECISION_TABLES.includes(table) &&
  !RESTRICTED_TABLES.includes(table) &&
  !MENTION_TABLES.includes(table) &&
  !PROJECT_TABLES.includes(table) &&
  !AREA_TABLES.includes(table) &&
  !FORGETTING_TABLES.includes(table) &&
  !LENS_TABLES.includes(table) &&
  !MOMENT_CALL_TABLES.includes(table) &&
  // Chat lines come from Lens's chat moments through the participant step, never
  // from a mail or calendar ingest (chat-lines.db.test.ts asks their labels).
  table !== "knowledge.chat_lines" &&
  // A claim's value rows and its relations, the shadow sampler's passes and the triggers' rechecks
  // and log are written with or after a claim, by the extraction, the contacts writer and the
  // owner's rulings, never by a mail or calendar ingest; their own tests ask their labels
  // (query-time, belief-inputs and triggers .db.test.ts).
  !QUERY_TIME_TABLES.includes(table) &&
  // A claim's name row is the commit's, and a named organization's the
  // binding step's (named-orgs.db.test.ts asks their labels).
  !NAMED_ORG_TABLES.includes(table);

export const schemaOf = (table: string): string => table.split(".")[0] ?? "";
export const tablesIn = (...schemas: string[]): Table[] =>
  TABLES.filter((table) => schemas.includes(schemaOf(table.name)));
// The erasure's three tables, which the reader reads nothing of either, and which only an erasure
// writes.
export const ERASURE_TABLES: readonly string[] = [
  "knowledge.erasures",
  "knowledge.removed_evidence",
  "knowledge.suppressions",
];
// The three tables of contacts and identity. The reader's policies on them are tested in
// contacts-database.db.test.ts and the gate tests N5 and N7, not by the stage 1 sweeps below. And
// the owner's ignore list, which only `pia ignore` writes and the reader reads nothing of:
// policy.entity_withheld reads it, as account-kinds.db.test.ts asks. And the tier rulings, which
// only `pia people tier` writes and the reader reads nothing of: policy.tier_rulings_in reads it,
// as tier-rulings.db.test.ts asks. And the owner's lists of people, keyed by fingerprint as the
// tier rulings are, which only `pia lists` writes and nothing but pi_admin reads, as
// owner-lists.db.test.ts asks.
const OWNER_LIST_TABLES: readonly string[] = ["knowledge.owner_lists", "knowledge.owner_list_members"];
const CONTACT_TABLES: readonly string[] = [
  "knowledge.contacts",
  "knowledge.contact_addresses",
  "knowledge.identity_rulings",
  "knowledge.ignore_rulings",
  "knowledge.tier_rulings",
  "knowledge.person_hides",
  ...OWNER_LIST_TABLES,
];
// The belief rulings' two tables, which only the owner's commands write: the reader reads no ruling, and a
// declassified fact only under the declassified clearance, so neither is among the knowledge tables the
// reader's checks run over. knowledge.fact_rulings is the same: only the owner's commands write it.
// knowledge.claim_releases too: only the owner's confirm and `pia facts release`; and its
// knowledge.release_lifts, only `pi correct lift` and `pi erase replay`.
export const OWNER_REST_TABLES: readonly string[] = [
  "knowledge.belief_rulings",
  "projections.declassified_facts",
  "knowledge.fact_rulings",
  "knowledge.claim_releases",
  "knowledge.release_lifts",
];
// The owner's names for organizations, which only `pi org name` writes: the reader's policy on it
// is asked in organizations.db.test.ts, not by the stage 1 sweeps. And the owner's names for people,
// which only `pia person name` writes, asked in person-names.db.test.ts.
export const ORGANIZATION_TABLES: readonly string[] = [
  "knowledge.organization_names",
  "knowledge.person_names",
  // The reader reads a ruling's and an agent's anchor's clear columns alone.
  ...TIME_TABLES,
];
// The named organizations' two: a claim's name row, the commit's, read by the writer; a named
// organization's names, the writer's, which deletes an item's rows its claims no longer hold, and
// the erasure hook's (pi_admin). Each read by the reader within its clearance; a delete of a claim,
// an item or an entity takes its rows by cascade.
export const NAMED_ORG_TABLES: readonly string[] = ["knowledge.claim_org_names", "knowledge.org_names"];
// pi_owner selects both, within a label, for the frontier's definers.
export const NAMED_ORG_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_pipeline" | "pi_restricted" | "pi_writer" | "pi_reader" | "pi_owner",
        ("select" | "insert" | "delete")[]
      >
    >
  >
> = {
  "knowledge.claim_org_names": {
    pi_admin: ["select", "insert"],
    pi_pipeline: ["insert"],
    pi_restricted: ["insert"],
    pi_writer: ["select", "insert"],
    pi_reader: ["select"],
    pi_owner: ["select"],
  },
  "knowledge.org_names": {
    pi_admin: ["select", "delete"],
    pi_writer: ["select", "insert", "delete"],
    pi_reader: ["select"],
    pi_owner: ["select"],
  },
};
// The projects' three, which only the owner's commands and the pipeline write, and whose reader
// grants projects.db.test.ts asks of each by itself: the reader reads no anchor, and a project and
// a binding only within its clearance.
const PROJECT_TABLES: readonly string[] = [
  "knowledge.projects",
  "knowledge.project_anchors",
  "knowledge.project_bindings",
];
// Their grants, table by table: each cell is one policy named <role>_<cell> and the same table
// privileges, but for the reader's column grant on a project. pi_owner selects a project and its
// anchors, for policy.serve_mirror's check of a project's entry against the clearance.
export const PROJECT_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_writer" | "pi_reader" | "pi_pipeline" | "pi_owner",
        ("all" | "select" | "insert" | "delete")[]
      >
    >
  >
> = {
  "knowledge.projects": { pi_admin: ["all"], pi_pipeline: ["select"], pi_reader: ["select"], pi_owner: ["select"] },
  "knowledge.project_anchors": {
    pi_admin: ["all"],
    pi_pipeline: ["select"],
    pi_reader: ["select"],
    pi_owner: ["select"],
  },
  "knowledge.project_bindings": {
    pi_admin: ["all"],
    pi_pipeline: ["select", "insert", "delete"],
    pi_writer: ["select", "delete"],
    pi_reader: ["select"],
  },
};
// The reader's columns of a project.
export const PROJECT_READER_COLUMNS: readonly string[] = ["id", "status", "name_enc", "compartments"];
// Lens's six, which only pushes, the drain, `pi erase settle` and `pi lens` write: no mail or
// calendar sync writes them, and the reader's policy on knowledge.captures is asked in
// lens-database.db.test.ts, not by the stage 1 sweeps. Each cell is one policy named <role>_<cell>
// and the same table privileges, but for the column grants below. pi_restricted holds a copy of
// pi_pipeline's cell, made by the tests as for every table. pi_owner's cells are what
// policy.push_capture, ledger.capture_erased and issue_handles' capture branch do as pi_owner;
// policy.capture_push_refusals is pi_owner's alone, the push's count of its refusals.
export const LENS_TABLES: readonly string[] = [
  "policy.lens_devices",
  "policy.capture_scope",
  "policy.time_exceptions",
  "ledger.capture_inbox",
  "ledger.capture_erasures",
  "knowledge.captures",
  "policy.capture_push_refusals",
  // The exclude list and the account map.
  "policy.capture_excludes",
  "policy.capture_accounts",
];
export const LENS_TABLE_GRANTS: Readonly<
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
  "policy.lens_devices": { pi_admin: ["all"], pi_writer: ["select"], pi_owner: ["select"] },
  "policy.capture_scope": { pi_admin: ["all"], pi_writer: ["select"], pi_owner: ["select"] },
  "ledger.capture_inbox": {
    pi_admin: ["select", "update", "delete"],
    pi_writer: ["select", "update", "delete"],
    pi_owner: ["select", "insert"],
  },
  // pi_owner's update and delete are for policy.serve_mirror's confirmation of an erased key and
  // its deletion 30 days after.
  "ledger.capture_erasures": { pi_admin: ["select"], pi_owner: ["select", "insert", "update", "delete"] },
  "knowledge.captures": {
    pi_admin: ["all"],
    pi_writer: ["select", "insert", "update", "delete"],
    pi_reader: ["select"],
    pi_pipeline: ["select"],
    pi_owner: ["select"],
  },
  "policy.capture_push_refusals": { pi_owner: ["all"] },
  // pi_admin all and pi_writer select, and no pi_owner policy, since policy.push_capture reads
  // neither.
  "policy.capture_excludes": { pi_admin: ["all"], pi_writer: ["select"] },
  "policy.capture_accounts": { pi_admin: ["all"], pi_writer: ["select"] },
};
const LENS_READER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "knowledge.captures": [
    ...[
      "id",
      "evidence_id",
      "source_account_id",
      "capture_key",
      "revision",
      "kind",
      "started_at",
      "ended_at",
      "event_id",
      "first_pushed_at",
      "local_day",
    ],
    ...[
      "minutes",
      "bundle_fp",
      "host_fp",
      "account_fp",
      "thread_fp",
      "match_fps",
      "compartments",
      "agent_app",
      "work_enc",
      "source",
    ],
  ],
};
export const LENS_COLUMN_GRANTS: readonly string[] = [
  "ledger.capture_inbox body_enc pi_admin UPDATE",
  "ledger.capture_inbox taken_at pi_admin UPDATE",
  ...["body_enc", "evidence_id", "refused_code", "taken_at", "tainted_at"].map(
    (column) => `ledger.capture_inbox ${column} pi_writer UPDATE`,
  ),
  ...Object.entries(LENS_READER_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => `${table} ${column} pi_reader SELECT`),
  ),
];
export const isLensColumnGrant = (table: string, role: string, cell: string): boolean =>
  (table === "ledger.capture_inbox" && (role === "pi_admin" || role === "pi_writer") && cell === "update") ||
  (table === "knowledge.captures" && role === "pi_reader" && cell === "select");
// Work notices: the owner keeps the addresses; the notice function and the release write as pi_owner;
// pi_notify reads the notices and the addresses' two columns and updates a notice's delivery columns,
// and reads the kill switch. No other role. Query time: the grants they add, and pi_owner's select for
// the definer triggers and functions. The shadow sampler's passes: the Pipeline's to write and read and
// pi_admin's to read. The rechecks, written by the definer triggers as pi_owner and by the work tick's
// clock, consumed by the Pipeline; the trigger log, written by the Pipeline, marked by the tick, reset
// by the claims' deferred trigger and the erasure hook. No pi_restricted cell. The goal ids, written by
// the owner's goal commands as pi_admin, read by the reader and the tick; a claim's delete takes its row
// (on delete cascade). The outcome judge's checks, as relation_checks are held, with pi_admin's delete
// for the erasure hook. The source checks, as outcome_checks are held, but pi_admin's select is
// restricted-blind and its insert is of the owner's audit rows alone.
export const QUERY_TIME_TABLES: readonly string[] = [
  "knowledge.claim_values",
  "knowledge.claim_relations",
  "knowledge.same_fact_judgments",
  "ledger.trigger_rechecks",
  "ledger.trigger_log",
  "knowledge.goal_ids",
  // Written by the owner's goal commands as pi_admin; rulings read by the reader and the tick, ranks by pi_admin.
  "knowledge.goal_key_rulings",
  "projections.goal_key_ranks",
  "policy.relation_switches",
  "ledger.relation_checks",
  "ledger.expected_outcomes",
  "ledger.work_watches",
  "ledger.outcome_links",
  "ledger.outcome_checks",
  "ledger.source_checks",
  "ledger.recall_checks",
  "ledger.surfaced_items",
];
export const QUERY_TIME_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_owner" | "pi_pipeline" | "pi_restricted" | "pi_writer" | "pi_reader" | "pi_work",
        ("select" | "insert" | "update" | "delete")[]
      >
    >
  >
> = {
  // The claim writers read the value rows of the claims they replace.
  "knowledge.claim_values": {
    pi_admin: ["select", "insert", "delete"],
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_writer: ["select", "insert"],
    pi_reader: ["select"],
    pi_owner: ["select", "insert"],
  },
  "knowledge.claim_relations": {
    pi_admin: ["select", "insert", "delete"],
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_reader: ["select"],
    // claim_relations_orphaned deletes a gone claim's relations (invariant 10), not a pi_writer delete.
    pi_owner: ["select", "delete"],
  },
  "knowledge.same_fact_judgments": { pi_pipeline: ["select", "insert", "update"], pi_admin: ["select", "delete"] },
  "ledger.trigger_rechecks": {
    pi_pipeline: ["select", "insert", "delete"],
    pi_work: ["insert"],
    pi_admin: ["select", "insert", "delete"],
    pi_owner: ["select", "insert", "delete"],
  },
  // pi_work's update is of `raised_at` alone, by a column grant. pi_owner inserts an
  // applied outcome link's row, by the link's definer trigger.
  "ledger.trigger_log": {
    pi_pipeline: ["select", "insert"],
    pi_work: ["select", "update"],
    pi_admin: ["select", "delete"],
    pi_owner: ["select", "insert", "delete"],
  },
  "knowledge.goal_ids": { pi_admin: ["select", "insert"], pi_reader: ["select"], pi_work: ["select"] },
  // pi_admin's update is of the lift's two columns alone, by a column grant, and pi_admin deletes
  // one on a key an erasure emptied (`goal_keys`).
  "knowledge.goal_key_rulings": {
    pi_admin: ["select", "insert", "update", "delete"],
    pi_reader: ["select"],
    pi_work: ["select"],
  },
  "projections.goal_key_ranks": { pi_admin: ["select", "insert", "update", "delete"] },
  "policy.relation_switches": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select", "insert"],
    pi_owner: ["select"],
  },
  "ledger.relation_checks": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select"],
    pi_owner: ["select", "delete"],
  },
  "ledger.expected_outcomes": {
    pi_pipeline: ["select"],
    pi_restricted: ["select"],
    pi_admin: ["select", "delete"],
    pi_owner: ["select", "insert"],
  },
  "ledger.work_watches": {
    pi_pipeline: ["select"],
    pi_restricted: ["select"],
    pi_work: ["insert"],
    pi_admin: ["select", "delete"],
    pi_owner: ["select", "insert"],
  },
  // The reader selects OUTCOME_READER_COLUMNS, for a goal's support at read.
  "ledger.outcome_links": {
    pi_pipeline: ["insert"],
    pi_restricted: ["insert"],
    pi_work: ["select"],
    pi_reader: ["select"],
    pi_admin: ["select", "delete"],
    pi_owner: ["select", "insert", "update"],
  },
  "ledger.outcome_checks": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select", "delete"],
    pi_owner: ["select"],
  },
  "ledger.source_checks": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select", "insert", "delete"],
    pi_owner: ["select"],
  },
  // What a closed filter lost: the dream pass writes it, the report reads it, the erasure deletes it.
  "ledger.recall_checks": { pi_pipeline: ["select", "insert"], pi_admin: ["select", "delete"] },
  // What next and the open items showed: the owner's commands alone.
  "ledger.surfaced_items": { pi_admin: ["select", "insert", "delete"] },
};
// The columns of an expectation and a watch the Pipeline selects, and
// pi_restricted as the Pipeline; never who wrote one or when.
const OUTCOME_PIPELINE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "ledger.expected_outcomes": [
    "id",
    "opportunity_id",
    "ordinal",
    "subject_kind",
    "subject_id",
    "outcome_type",
    "success_enc",
    "failure_enc",
    "horizon_days",
    "compartments",
  ],
  "ledger.work_watches": ["id", "opportunity_id", "kind", "watch_key", "account_id", "until", "compartments"],
};
// The columns of an outcome link the reader selects, for a goal's staleness and
// the `advances` shown on it; never its evidence, judge or passage.
const OUTCOME_READER_COLUMNS: readonly string[] = ["opportunity_id", "goal_id", "kind", "judged_at", "compartments"];
export const OUTCOME_COLUMN_GRANTS: readonly string[] = [
  ...Object.entries(OUTCOME_PIPELINE_COLUMNS).flatMap(([table, columns]) =>
    ["pi_pipeline", "pi_restricted"].flatMap((role) => columns.map((column) => `${table} ${column} ${role} SELECT`)),
  ),
  ...OUTCOME_READER_COLUMNS.map((column) => `ledger.outcome_links ${column} pi_reader SELECT`),
];
export const isOutcomeColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "select" &&
  ((Object.hasOwn(OUTCOME_PIPELINE_COLUMNS, table) && (role === "pi_pipeline" || role === "pi_restricted")) ||
    (table === "ledger.outcome_links" && role === "pi_reader"));
// The columns of a claim the tick's clock reads, as pi_work.
export const TRIGGER_WORK_CLAIM_COLUMNS: readonly string[] = [
  "id",
  "type",
  "valid_from",
  "due_at",
  "review_at",
  "valid_to",
  "fact_key_fp",
  "compartments",
];
// The read log's three columns the shadow sampler reads, the Pipeline's alone.
export const BELIEF_INPUTS_COLUMN_GRANTS: readonly string[] = ["fact_key_fps", "read_at", "compartments"].map(
  (column) => `ledger.read_log ${column} pi_pipeline SELECT`,
);
export const isBeliefInputsColumnGrant = (table: string, role: string, cell: string): boolean =>
  table === "ledger.read_log" && role === "pi_pipeline" && cell === "select";
// ledger.health_notices, granted as ledger.work_notices is, but that
// pi_owner writes it through ledger.health_notice alone.
export const NOTICE_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_owner" | "pi_notify", ("all" | "select" | "insert" | "update")[]>>>
> = {
  "policy.client_webhooks": { pi_admin: ["all"], pi_notify: ["select"], pi_owner: ["select"] },
  "ledger.work_notices": {
    pi_owner: ["select", "insert", "update"],
    pi_admin: ["select"],
    pi_notify: ["select", "update"],
  },
  "ledger.work_declines": { pi_owner: ["all"], pi_admin: ["select"] },
  "ledger.health_notices": { pi_owner: ["all"], pi_admin: ["select"], pi_notify: ["select", "update"] },
  "ledger.batch_notices": { pi_owner: ["all"], pi_admin: ["select"], pi_notify: ["select", "update"] },
};
export const NOTICE_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<"pi_notify", "select"[]>>>> = {
  "ledger.kill_switch": { pi_notify: ["select"] },
};
const NOTICE_DELIVERY_COLUMNS = ["state", "attempts", "last_code", "next_try_at", "delivered_at"];
export const NOTICE_COLUMN_GRANTS: readonly string[] = [
  ...["client_id", "address"].map((column) => `policy.client_webhooks ${column} pi_notify SELECT`),
  ...["work_notices", "health_notices", "batch_notices"].flatMap((table) =>
    NOTICE_DELIVERY_COLUMNS.map((column) => `ledger.${table} ${column} pi_notify UPDATE`),
  ),
];
export const isNoticeColumnGrant = (table: string, role: string, cell: string): boolean =>
  role === "pi_notify" &&
  ((table === "policy.client_webhooks" && cell === "select") ||
    (["ledger.work_notices", "ledger.health_notices", "ledger.batch_notices"].includes(table) && cell === "update"));
// Fewer cards: the pipeline writes and reads its own settlements, decide writes the ones an answer from the
// owner settles and `pi cards reopen` sets reopened_at; pi_owner's for policy.fact_answer and the definer
// path. No restricted copy: the grants name pi_pipeline alone. The pipeline sets a card's match key once.
export const FEWER_CARDS_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_pipeline" | "pi_owner", ("all" | "select" | "insert" | "update")[]>>>
> = {
  "ledger.fact_settlements": {
    pi_pipeline: ["select", "insert"],
    pi_admin: ["select", "insert", "update"],
    pi_owner: ["all"],
  },
};
export const FEWER_CARDS_COLUMN_GRANTS: readonly string[] = [
  "ledger.cards match_fp pi_pipeline UPDATE",
  "ledger.fact_settlements reopened_at pi_admin UPDATE",
];
// Commitment reopens: the reopens, pi_owner's for the definer functions, pi_admin's to read and to
// write the owner's, the pipeline's to read; no restricted copy. The pipeline reads a close's kind and
// fact key on ledger.agent_writes, to make it due again.
export const CLOSE_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_pipeline" | "pi_owner", ("all" | "select" | "insert")[]>>>
> = {
  "ledger.commitment_reopens": { pi_owner: ["all"], pi_admin: ["select", "insert"], pi_pipeline: ["select"] },
};
export const CLOSE_COLUMN_GRANTS: readonly string[] = [
  "ledger.agent_writes kind pi_pipeline SELECT",
  "ledger.agent_writes close_fact_fp pi_pipeline SELECT",
];
export const CLOSE_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.commitment_reopens pi_admin_insert": { qual: null, check: "(by = 'owner'::text)" },
  "ledger.commitment_reopens pi_pipeline_select": { qual: "(NOT policy.is_restricted(compartments))", check: null },
};
// A finding's project, which the reader serves, and the owner's names, which the pipeline grounds a
// finding's owner mention on.
export const LASTING_KNOWLEDGE_COLUMN_GRANTS: readonly string[] = ["ledger.agent_writes project_id pi_reader SELECT"];
export const LASTING_KNOWLEDGE_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "knowledge.aliases pi_pipeline_select": {
    qual: "((NOT policy.is_restricted(compartments)) AND (EXISTS ( SELECT 1\n   FROM knowledge.entities e\n  WHERE ((e.id = aliases.entity_id) AND (e.kind = 'owner'::text)))))",
    check: null,
  },
  "knowledge.aliases pi_restricted_select": {
    qual: "((EXISTS ( SELECT 1\n   FROM knowledge.entities e\n  WHERE ((e.id = aliases.entity_id) AND (e.kind = 'owner'::text)))) AND policy.is_restricted(compartments))",
    check: null,
  },
};
export const isFewerCardsColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "update" &&
  ((table === "ledger.cards" && role === "pi_pipeline") ||
    (table === "ledger.fact_settlements" && role === "pi_admin"));
export const FEWER_CARDS_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.cards pi_pipeline_update": {
    qual: "((created_by = 'system:extract'::text) AND (match_fp IS NULL) AND (NOT policy.is_restricted(compartments)))",
    check: "((created_by = 'system:extract'::text) AND (NOT policy.is_restricted(compartments)))",
  },
  "ledger.fact_settlements pi_pipeline_select": {
    qual: "((written_by = 'pipeline'::text) AND (NOT policy.is_restricted(compartments)))",
    check: null,
  },
  "ledger.fact_settlements pi_pipeline_insert": {
    qual: null,
    check:
      "((written_by = 'pipeline'::text) AND (withdrawn_card_id IS NULL) AND (reopened_at IS NULL) AND (NOT policy.is_restricted(compartments)))",
  },
  "ledger.fact_settlements pi_admin_insert": {
    qual: null,
    check: "((written_by = 'decide'::text) AND (reopened_at IS NULL))",
  },
  "knowledge.identity_rulings pi_owner_insert": {
    qual: null,
    check:
      "(((verdict = ANY (ARRAY['same'::text, 'different'::text])) AND (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity_policy'::text))))) OR ((verdict = 'same'::text) AND (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity'::text) AND (d.answer = 'same'::text) AND (d.details ? 'inPlaceOf'::text))))))",
  },
};
// The coverage migration's three: each job's role inserts its own job's rows of ledger.job_runs, by a
// policy on `job`; the writer inserts every sync outcome; pi_admin reads both and keeps the states,
// updating three columns of one. No role updates or deletes an outcome or a run. No pi_pipeline cell.
const DAYS = ["projections.warmth_days", "projections.warmth_day_builds"] as const;
const cellsOf = (write: "update" | "delete") =>
  ({
    pi_pipeline: ["select", "insert", write],
    pi_reader: ["select"],
    pi_admin: ["select", write],
    pi_writer: ["select", write],
    pi_owner: ["select"],
  }) as const;
export const WARMTH_TABLES: readonly string[] = [...DAYS];
// pi_owner selects the warmth rows, restricted-blind, for close_no_tie's definers.
export const WARMTH_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_writer" | "pi_pipeline" | "pi_reader" | "pi_owner",
        ("select" | "insert" | "update" | "delete")[]
      >
    >
  >
> = {
  // pi_owner's read of the builds is policy.group_chat_newer's, a definer that runs as it.
  ...Object.fromEntries(WARMTH_TABLES.map((table) => [table, cellsOf(table.endsWith("builds") ? "update" : "delete")])),
  // The fact rulings' marks, appended by their trigger's definer
  // (pi_owner); pi_admin reads them for status.
  "policy.fact_ruling_marks": { pi_admin: ["select"], pi_owner: ["insert", "select"] },
  // pi_admin's sweep holds and releases cards; pi_owner reads the
  // holds for ledger.admit_deferred, a definer that runs as it.
  "ledger.card_name_holds": { pi_admin: ["select", "insert", "delete"], pi_owner: ["select"] },
  // The writer derives and removes the chat lines, the admin removes
  // them, the pipeline reads them restricted-blind (pi_restricted's copy by the catalogue test). No
  // reader cell. OWNER_WRITES lists it: pi_admin selects and deletes, and never inserts or updates.
  "knowledge.chat_lines": {
    pi_writer: ["select", "insert", "delete"],
    pi_admin: ["select", "delete"],
    pi_pipeline: ["select"],
    // policy.group_chat_newer's, within the caller's clearance.
    pi_owner: ["select"],
  },
};
export const WARMTH_GRANTS_ON_EARLIER: Readonly<Record<string, Partial<Record<"pi_pipeline", "select"[]>>>> =
  Object.fromEntries(
    [
      "knowledge.interaction_log",
      "knowledge.events",
      "knowledge.event_details",
      "knowledge.event_participants",
      "knowledge.identity_rulings",
    ].map((table) => [table, { pi_pipeline: ["select"] }]),
  );
export const WARMTH_COLUMN_GRANTS: readonly string[] = [
  ...["pi_admin", "pi_writer"].map((role) => `${DAYS[1]} removed_at ${role} UPDATE`),
];
export const isWarmthColumnGrant = (table: string, role: string, cell: string): boolean =>
  table === DAYS[1] && (role === "pi_admin" || role === "pi_writer") && cell === "update";
export const COVERAGE_TABLES: readonly string[] = ["vault.sync_outcomes", "ledger.job_runs", "ledger.coverage_states"];
export const COVERAGE_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<string, ("select" | "insert" | "update")[]>>>
> = {
  "vault.sync_outcomes": { pi_writer: ["insert"], pi_admin: ["select"] },
  "ledger.job_runs": {
    pi_owner: ["select"], // the health read's definer reads runs as its owner
    pi_writer: ["insert"],
    pi_work: ["insert"],
    pi_admin: ["select", "insert"],
    pi_pipeline: ["select", "insert"],
  },
  "ledger.coverage_states": { pi_admin: ["select", "insert", "update"] },
};
export const COVERAGE_COLUMN_GRANTS: readonly string[] = ["state", "code", "since"].map(
  (column) => `ledger.coverage_states ${column} pi_admin UPDATE`,
);
export const isCoverageColumnGrant = (table: string, role: string, cell: string): boolean =>
  table === "ledger.coverage_states" && role === "pi_admin" && cell === "update";
// The three insert policies on ledger.job_runs, each its own job's rows.
export const COVERAGE_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.job_runs pi_writer_insert": { qual: null, check: "(job = 'sync'::text)" },
  "ledger.job_runs pi_work_insert": { qual: null, check: "(job = 'work_tick'::text)" },
  // And the timer's runs, and a timed-out run of any job.
  "ledger.job_runs pi_admin_insert": {
    qual: null,
    check:
      "((job = ANY (ARRAY['erase_settle'::text, 'extract'::text, 'dream'::text, 'reasoner'::text, 'outcome_test'::text, 'improvement_filing'::text, 'backup'::text, 'restore_drill'::text, 'canary'::text])) OR (code = 'timed_out'::text))",
  },
};
// Lens's mirror, two: the admin reads both; pi_owner's cells are what policy.serve_mirror,
// ledger.taint_citing, ledger.taint_mirror_entities and ledger.end_mirror do as pi_owner. A cursor
// is never updated. No other role holds anything on either.
export const MIRROR_TABLES: readonly string[] = ["ledger.mirror_entries", "ledger.mirror_cursors"];
export const MIRROR_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_owner", ("select" | "insert" | "update" | "delete")[]>>>
> = {
  "ledger.mirror_entries": { pi_admin: ["select"], pi_owner: ["select", "insert", "update", "delete"] },
  "ledger.mirror_cursors": { pi_admin: ["select"], pi_owner: ["select", "insert", "delete"] },
};
// Lens's saved calls, one: a moment group's saved call's members, which only `calls.save` writes
// and the removals delete, with vault.model_calls' cells; pi_restricted holds a copy of
// pi_pipeline's, made by the tests as for every table.
const MOMENT_CALL_TABLES: readonly string[] = ["vault.model_call_members"];
export const MOMENT_CALL_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_writer" | "pi_pipeline", ("all" | "select" | "insert" | "delete")[]>>>
> = {
  "vault.model_call_members": { pi_admin: ["all"], pi_writer: ["select", "delete"], pi_pipeline: ["select", "insert"] },
};
// The reader's columns of an anchor.
export const PROJECT_ANCHOR_READER_COLUMNS: readonly string[] = [
  "id",
  "project_id",
  "kind",
  "anchor_fp",
  "value_enc",
  "lifted_at",
  "compartments",
];
// The research page rows, made only by `pi research run`: the reader's policy on them is tested in
// research-database.db.test.ts, not by the stage 1 sweeps.
export const RESEARCH_KNOWLEDGE: readonly string[] = ["knowledge.pages"];
// The knowledge tables the reader has a policy on: every one but those of the lists the filter names.
export const KNOWLEDGE: readonly Table[] = tablesIn("knowledge").filter(
  (table) =>
    !OWNER_ONLY.includes(table.name) &&
    !ERASURE_TABLES.includes(table.name) &&
    !CONTACT_TABLES.includes(table.name) &&
    !OWNER_REST_TABLES.includes(table.name) &&
    !ORGANIZATION_TABLES.includes(table.name) &&
    !MENTION_TABLES.includes(table.name) &&
    !PROJECT_TABLES.includes(table.name) &&
    !AREA_TABLES.includes(table.name) &&
    !QUERY_TIME_TABLES.includes(table.name) &&
    !NAMED_ORG_TABLES.includes(table.name) &&
    !FORGETTING_TABLES.includes(table.name) &&
    !RESEARCH_KNOWLEDGE.includes(table.name) &&
    !PROMOTION_TABLES.includes(table.name) &&
    !LENS_TABLES.includes(table.name) &&
    // The chat lines, which no reader reads.
    table.name !== "knowledge.chat_lines",
);

// The research grants table, and its two cells on earlier tables, for the definer functions as
// pi_owner. pi_restricted's copy of pi_pipeline's is made by the tests. The two ledger tables are
// append-only: the admin selects and inserts, and updates a fetch's body_enc alone, by a column
// grant, for the `pages` erasure hook.
export const RESEARCH_TABLE_GRANTS: Readonly<
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
  "policy.research_settings": { pi_admin: ["all"], pi_owner: ["select"], pi_reader: ["select"] },
  "ledger.research_requests": { pi_admin: ["select", "insert"], pi_owner: ["select", "insert", "update"] },
  "ledger.research_fetches": { pi_admin: ["select", "insert", "update"] },
  "knowledge.pages": {
    pi_admin: ["all"],
    pi_writer: ["select", "insert", "delete"],
    pi_reader: ["select"],
    pi_pipeline: ["select"],
  },
};
export const RESEARCH_GRANTS_ON_EARLIER: Readonly<
  Record<string, Partial<Record<"pi_owner" | "pi_pipeline", ("select" | "insert")[]>>>
> = {
  // The pipeline's read of the owner's names, its policy returning the owner's entity's rows alone
  // (LASTING_KNOWLEDGE_CONDITIONS).
  "knowledge.aliases": { pi_owner: ["select"], pi_pipeline: ["select"] },
  "ledger.cards": { pi_owner: ["insert"] },
};
// The reader's columns: a page's but its names, and the settings' one switch; and the admin's
// update of a fetch's body_enc.
export const RESEARCH_COLUMN_GRANTS: readonly string[] = [
  ...[
    "id",
    "evidence_id",
    "request_id",
    "url_fp",
    "host_fp",
    "fetched_at",
    "media_type",
    "about_entity_id",
    "page_enc",
    "compartments",
  ].map((column) => `knowledge.pages ${column} pi_reader SELECT`),
  "policy.research_settings client_link_requests pi_reader SELECT",
  "ledger.research_fetches body_enc pi_admin UPDATE",
];
