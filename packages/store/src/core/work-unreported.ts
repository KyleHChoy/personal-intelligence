import type { MoveId, OpportunityId, Stage } from "@intelligence/contracts/personal";
import type { Ctx } from "./read-ctx.ts";
import { moveStatus } from "./statements.ts";
import { OWN_CLEARED_MOVE } from "./work-refs.ts";

// The caller's own moves that were cleared and never reported, under its token: each one's move,
// opportunity and stage, oldest first, at most UNREPORTED_MOST. The tick closes one failed once
// the caller holds no live lease on its opportunity (dispatch-read.ts unreportedMoves); until then
// list_opportunities (scope mine) and agent_bootstrap list it, with "report or release". An
// owner_question's move is never reported (answer_owner_question ends it), so never listed.
const UNREPORTED_MOST = 20;
const UNREPORTED_OF_CALLER = `
  select m.id as move, m.opportunity_id as opportunity, m.stage from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id and o.kind <> 'owner_question'
  where ${OWN_CLEARED_MOVE}
    and (${moveStatus()}) = 'cleared'
  order by m.id collate "C" limit ${UNREPORTED_MOST}`;

export type Unreported = { move: MoveId; opportunity: OpportunityId; stage: Stage; say: "report or release" };
export const unreportedOf = async (ctx: Ctx): Promise<Unreported[]> =>
  (await ctx.run<{ move: MoveId; opportunity: OpportunityId; stage: Stage }>(UNREPORTED_OF_CALLER, [])).map((row) => ({
    ...row,
    say: "report or release",
  }));
