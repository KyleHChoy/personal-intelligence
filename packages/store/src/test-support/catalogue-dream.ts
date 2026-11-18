// Dreaming's tables, each with pi_restricted's copy of the Pipeline's cells and pi_owner's for the
// definers. The owner's lines and models, set by pi_admin and read by both workers; a subject's last
// review and a night's counts, the workers' to write; a finding, filed by a worker and erased by
// pi_admin; a settlement, written by ledger.settle_belief alone, its lift pi_admin's (a column grant); a
// dream merge's candidate, filed by a worker and moved on and erased by pi_admin.
export const DREAM_TABLE_GRANTS: Readonly<
  Record<
    string,
    Partial<
      Record<
        "pi_admin" | "pi_owner" | "pi_pipeline" | "pi_restricted",
        ("all" | "select" | "insert" | "update" | "delete")[]
      >
    >
  >
> = {
  "policy.dream_lines": {
    pi_admin: ["select", "insert"],
    pi_pipeline: ["select"],
    pi_restricted: ["select"],
    pi_owner: ["all"],
  },
  "policy.dream_models": {
    pi_admin: ["select", "insert"],
    pi_pipeline: ["select"],
    pi_restricted: ["select"],
    pi_owner: ["all"],
  },
  "ledger.dream_subjects": {
    pi_pipeline: ["select", "insert", "update"],
    pi_restricted: ["select", "insert", "update"],
    pi_admin: ["select"],
    pi_owner: ["all"],
  },
  "ledger.dream_nights": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select"],
    pi_owner: ["all"],
  },
  "ledger.dream_findings": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select", "delete"],
    pi_owner: ["all"],
  },
  "ledger.belief_settlements": {
    pi_pipeline: ["select"],
    pi_restricted: ["select"],
    pi_admin: ["select", "update", "delete"],
    pi_owner: ["all"],
  },
  "ledger.dream_identity_candidates": {
    pi_pipeline: ["select", "insert"],
    pi_restricted: ["select", "insert"],
    pi_admin: ["select", "update", "delete"],
    pi_owner: ["all"],
  },
};
// pi_admin's updates of a settlement's lift and of a candidate's state, by column.
export const DREAM_COLUMN_GRANTS: readonly string[] = [
  "ledger.belief_settlements lifted_at pi_admin UPDATE",
  // The dream pass's upsert sets its review time alone.
  ...["pi_pipeline", "pi_restricted"].map((role) => `ledger.dream_subjects dreamed_at ${role} UPDATE`),
  ...["state", "code", "updated_at"].map((column) => `ledger.dream_identity_candidates ${column} pi_admin UPDATE`),
];
export const isDreamColumnGrant = (table: string, role: string, cell: string): boolean =>
  cell === "update" &&
  ((role === "pi_admin" && (table === "ledger.belief_settlements" || table === "ledger.dream_identity_candidates")) ||
    ((role === "pi_pipeline" || role === "pi_restricted") && table === "ledger.dream_subjects"));
const UNRESTRICTED = { qual: "(NOT policy.is_restricted(compartments))", check: null };
export const DREAM_CONDITIONS: Readonly<Record<string, { qual: string | null; check: string | null }>> = {
  "ledger.dream_findings pi_admin_select": UNRESTRICTED,
  "ledger.belief_settlements pi_admin_select": UNRESTRICTED,
  "ledger.dream_identity_candidates pi_admin_select": UNRESTRICTED,
  "ledger.dream_identity_candidates pi_pipeline_insert": { qual: null, check: "(state = 'filed'::text)" },
};
