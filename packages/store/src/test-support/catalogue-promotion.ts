// The promotion gate and its intake: the admin sends, revokes and takes; the reader reads a taken
// claim within its clearance, which promotion.db.test.ts tests, not the stage 1 sweeps.
export const PROMOTION_TABLES: readonly string[] = ["ledger.promotions", "knowledge.promoted_claims"];
export const PROMOTION_TABLE_GRANTS: Readonly<
  Record<string, Partial<Record<"pi_admin" | "pi_reader", ("select" | "insert" | "update" | "delete")[]>>>
> = {
  "ledger.promotions": { pi_admin: ["select", "insert", "update"] },
  "knowledge.promoted_claims": { pi_admin: ["select", "insert", "delete"], pi_reader: ["select"] },
};
