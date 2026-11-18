// No runtime role updates a label column. On each table below, each role named holds `update` on
// every column but the label columns, as column grants, where its cells in the other catalogues
// give it `update` on the table.
import type { Query } from "./connections.ts";

export const LABEL_COLUMNS = ["compartments", "readers", "audience", "bound"] as const;

const LABEL_FIXED: Readonly<Record<string, readonly string[]>> = {
  "knowledge.accounts": ["pi_admin", "pi_writer"],
  "knowledge.agent_anchors": ["pi_admin"],
  "knowledge.agent_time_rulings": ["pi_admin"],
  "knowledge.aliases": ["pi_admin", "pi_writer"],
  "knowledge.areas": ["pi_admin"],
  "knowledge.captures": ["pi_admin", "pi_writer"],
  "knowledge.contact_addresses": ["pi_admin", "pi_writer"],
  "knowledge.contacts": ["pi_admin", "pi_writer"],
  "knowledge.documents": ["pi_admin", "pi_writer"],
  "knowledge.domains": ["pi_admin", "pi_writer"],
  "knowledge.event_details": ["pi_admin", "pi_writer"],
  "knowledge.event_participants": ["pi_admin", "pi_writer"],
  "knowledge.events": ["pi_admin", "pi_writer"],
  "knowledge.interaction_log": ["pi_admin", "pi_writer"],
  "knowledge.mention_bindings": ["pi_admin"],
  "knowledge.messages": ["pi_admin", "pi_writer"],
  "knowledge.pages": ["pi_admin"],
  "knowledge.project_anchors": ["pi_admin"],
  "knowledge.project_bindings": ["pi_admin"],
  "knowledge.projects": ["pi_admin"],
  "knowledge.signatures": ["pi_admin", "pi_writer"],
  "knowledge.time_rulings": ["pi_admin"],
  "projections.goal_key_ranks": ["pi_admin"],
  "projections.goal_state": ["pi_admin"],
  "projections.planner_mission": ["pi_admin"],
  "projections.warmth_day_builds": ["pi_pipeline", "pi_restricted"],
  "vault.evidence_blobs": ["pi_admin", "pi_writer"],
  "vault.evidence_items": ["pi_admin", "pi_writer"],
  "vault.extraction_reviews": ["pi_admin"],
  "vault.extraction_runs": ["pi_admin"],
  "vault.listed_items": ["pi_admin", "pi_writer"],
  "vault.model_call_members": ["pi_admin"],
  "vault.model_calls": ["pi_admin"],
  "vault.model_usage": ["pi_admin"],
  "vault.pipeline_items": ["pi_admin", "pi_pipeline", "pi_restricted"],
  "vault.restrict_screens": ["pi_admin"],
  "vault.restriction_lifts": ["pi_admin"],
  "vault.restriction_requests": ["pi_admin"],
  "vault.sent_recipients": ["pi_admin", "pi_writer"],
  "vault.source_accounts": ["pi_admin", "pi_writer"],
  "vault.unmapped_claims": ["pi_admin"],
  "vault.unresolved_mentions": ["pi_admin"],
};

// Whether `role`'s `update` on `table` is held column by column, its label columns left out.
export const labelFixed = (table: string, role: string): boolean => LABEL_FIXED[table]?.includes(role) ?? false;

// Table privileges, as `table role PRIVILEGE`, without the updates held column by column.
export const withoutLabelUpdates = (lines: readonly string[]): string[] =>
  lines.filter((line) => {
    const [table = "", role = "", privilege] = line.split(" ");
    return privilege !== "UPDATE" || !labelFixed(table, role);
  });

// Those column grants, as `table column role UPDATE`, for the tables given (every one when none
// is), each table's columns read from the catalogue.
export async function labelFixedColumnGrants(query: Query, tables?: readonly string[]): Promise<string[]> {
  const grants: string[] = [];
  for (const [table, roles] of Object.entries(LABEL_FIXED)) {
    if (tables !== undefined && !tables.includes(table)) continue;
    const columns = await query<{ column: string }>(
      "select attname::text as column from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and attname <> all ($2::text[])",
      [table, LABEL_COLUMNS],
    );
    for (const role of roles) for (const { column } of columns) grants.push(`${table} ${column} ${role} UPDATE`);
  }
  return grants;
}
