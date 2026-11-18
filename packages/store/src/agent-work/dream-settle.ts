import type { DreamFindingBrief } from "@intelligence/contracts/personal";
import { beliefSettlementId } from "../core/ids.ts";
import { derivedId } from "../core/work-refs.ts";
import type { Ctx } from "../read/read-ctx.ts";

// A dream_finding task's side of its brief and of report_move: the finding's two
// facts as the read tools serve them, and the one write of the agent's settlement. Code checks; the
// agent only says which holds, and the definer decides whether it is taken.

// The task's finding under the caller's token, or null when the caller can't see it or a claim is gone.
export async function dreamFindingBrief(ctx: Ctx, opportunity: string): Promise<DreamFindingBrief | null> {
  const [row] = await ctx.run<{ finding: string; a_claim: string | null; b_claim: string | null }>(
    "select finding, a_claim, b_claim from ledger.dream_finding_brief($1)",
    [opportunity],
  );
  if (row === undefined || row.a_claim === null || row.b_claim === null) return null;
  return { finding: row.finding, a: row.a_claim, b: row.b_claim };
}

// The settlement, in the report's transaction, through the one definer. Its request id is the
// report's, so a retried report replays it. `settled` or `ok` (a replay) is taken; anything else is a
// refusal, and nothing was written.
export async function writeSettlement(
  ctx: Ctx,
  settle: {
    opportunity: string;
    move: string;
    finding: string;
    holds: "a" | "b";
    cited: { kind: string; id: string }[];
  },
  requestId: string,
): Promise<string> {
  const request = derivedId(`${requestId}\nsettle`, 43);
  const [row] = await ctx.run<{ code: string }>("select ledger.settle_belief($1, $2, $3, $4, $5, $6, $7, $8) as code", [
    beliefSettlementId(),
    request,
    settle.opportunity,
    settle.move,
    settle.finding,
    settle.holds,
    settle.cited.map((one) => one.kind),
    settle.cited.map((one) => one.id),
  ]);
  return row?.code ?? "not_found";
}
