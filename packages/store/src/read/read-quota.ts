import {
  type PersonalReadTool,
  READ_BUDGET,
  type ReadBudget,
  ReadBudgetRefusal,
} from "@intelligence/contracts/personal";
import { type Run, Unavailable } from "../core/read-ctx.ts";

// The read quota check: one call of
// policy.read_allowance with the tool's budget class, which counts the calling client's own rows
// only. Kept in a module of its own so the reader's call path names it once.

export const READ_ALLOWANCE = "select policy.read_allowance($1)";

// Whether the client may make this read: `ok`, or the window of the budget that is spent, the
// minute's or the day's, which the refusal names. Any other answer is a failure.
export function allowed(run: Run, tool: PersonalReadTool): Promise<"ok" | ReadBudgetRefusal> {
  return allowance(run, READ_BUDGET[tool]);
}

// The same check by budget class, for a work tool that reads (WORK_READ_BUDGET).
export async function allowance(run: Run, budget: ReadBudget): Promise<"ok" | ReadBudgetRefusal> {
  const [row] = await run<{ read_allowance: string }>(READ_ALLOWANCE, [budget]);
  if (row?.read_allowance === "ok") return "ok";
  const window = ReadBudgetRefusal.safeParse(row?.read_allowance);
  if (window.success) return window.data;
  throw new Unavailable();
}
