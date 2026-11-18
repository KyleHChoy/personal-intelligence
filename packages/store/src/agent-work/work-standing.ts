import type { OpportunityView } from "@intelligence/contracts/personal";
import { type GapStanding, gapWeight } from "@intelligence/personal-core/planner";
import { bySoonest } from "../core/work-views.ts";
import { type Ctx, Unavailable } from "../read/read-ctx.ts";

// The order an agent is offered tasks: deterministic, and read within that
// agent's own clearance, so nothing it cannot see moves it (invariant 6). Two agents may differ.
//
// First what has a date, soonest first, as ever: it is the owner's own day. Then the rest, those whose
// trigger's work was used first: work the owner dropped or nobody used goes later, and nothing leaves
// the board. An opportunity keeps its place by date alone.

const STANDING = "select trigger, scored, used, kept, dropped from ledger.task_standing($1, '{}')";
export type TaskStandingRow = GapStanding & { trigger: string };

// How long the board's order may take of the call's reply deadline. It is a nicety: any failure, a timeout
// among them, leaves the order by date alone and never fails the call.
const STANDING_MS = 150;

export async function standingRows(ctx: Pick<Ctx, "run" | "log">, since: string): Promise<TaskStandingRow[]> {
  await ctx.run("savepoint board_order", []);
  await ctx.run(`set local statement_timeout = ${STANDING_MS}`, []);
  let rows: TaskStandingRow[] = [];
  try {
    rows = await ctx.run<TaskStandingRow>(STANDING, [since]);
  } catch (error) {
    ctx.log.warn({
      event: "board_order_fallback",
      code: (error instanceof Unavailable ? error.sqlstate : undefined) ?? "failed",
    });
  }
  // Rolled back either way: the read wrote nothing, and this ends the shorter timeout.
  await ctx.run("rollback to savepoint board_order", []);
  await ctx.run("release savepoint board_order", []);
  return rows;
}

export function byStanding(rows: readonly TaskStandingRow[]): (a: OpportunityView, b: OpportunityView) => number {
  const weights = new Map(rows.map((row) => [row.trigger, gapWeight(row)]));
  const weightOf = (view: OpportunityView): number =>
    view.tier === "task" ? (weights.get(view.gap?.trigger ?? view.kind) ?? 1) : 1;
  return (a, b) => {
    if (a.dueAt !== null || b.dueAt !== null) return bySoonest(a, b);
    return weightOf(b) - weightOf(a) || bySoonest(a, b);
  };
}
