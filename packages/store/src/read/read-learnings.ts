import type { Timestamp } from "@intelligence/contracts";
import { type ClientView, LEARNING_SAY, type LearningScope, type PackItem } from "@intelligence/contracts/personal";
import { type Ctx, servedOrNull, Unavailable } from "../core/read-ctx.ts";

// agent_bootstrap@15's learnings: the learnings active for the caller, of scope general or a role it
// holds, by ledger.agent_learnings_for, which gates the caller as file_learning does and reads only
// rows within its clearance and keys (invariant 6). Each is its id, its scope, its statement and its
// rule, opened under its own label and served as untrusted; never its evidence. The function refuses
// a client without file_learning, so a client without it is not asked at all, as a section whose
// view it lacks is not.
type LearningItem = Extract<PackItem, { kind: "learning" }>;

const LEARNINGS = "select id, scope, compartments, statement_enc, rule_enc from ledger.agent_learnings_for($1)";

type Row = {
  id: LearningItem["id"];
  scope: LearningScope;
  compartments: string[];
  statement_enc: unknown;
  rule_enc: unknown;
};

export const learningsServed = (client: ClientView): boolean => client.tools.includes("file_learning");

export async function learningsOf(ctx: Ctx, client: ClientView, cap: number, asOf: Timestamp): Promise<LearningItem[]> {
  const rows = await ctx.run<Row>(LEARNINGS, [cap]);
  return rows.map((row): LearningItem => {
    // A row whose label is outside the clearance reached this process through a function written
    // wrongly: the second barrier, as for a pack's records.
    if (!row.compartments.every((compartment) => client.compartments.includes(compartment))) throw new Unavailable();
    const openColumn = (column: "statement_enc" | "rule_enc") =>
      servedOrNull(ctx.keys, row.compartments, { table: "ledger.agent_learnings", id: row.id, column }, row[column]);
    return {
      id: row.id,
      section: "learnings",
      required: false,
      provenance: "agent_reported",
      asOf,
      kind: "learning",
      scope: row.scope,
      statement: openColumn("statement_enc"),
      rule: openColumn("rule_enc"),
      say: LEARNING_SAY,
    };
  });
}
