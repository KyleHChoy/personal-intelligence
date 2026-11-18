import type { Belief } from "@intelligence/contracts";
import { OPEN_BELIEF_STATUS } from "@intelligence/contracts/personal";
import { directionOf, dueOf } from "../core/commitment-rules.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { ownerTimeZone } from "../core/zone.ts";
import { lapsedCommitments } from "./read-beliefs.ts";

// Only the owner's zone is read whatever the page holds; no other statement runs without such a commitment, and none past it unless one has aged enough to
// lapse. A commitment between two others is thirdPartyLapsed's.
export async function lapsedOwnerSide(
  ctx: Ctx,
  found: readonly { row: { id: string; support: string[]; fact_key_fp: string }; belief: Belief }[],
  owner: string | undefined,
  at: Date,
): Promise<Map<string, string>> {
  // Read before anything the page holds decides, so an empty page sends the same statements (invariant 6).
  const zone = await ownerTimeZone(ctx);
  if (owner === undefined) return new Map();
  const sided = found.flatMap(({ row, belief }) => {
    if (belief.kind !== "commitment" || !OPEN_BELIEF_STATUS.has(belief.status)) return [];
    const direction = directionOf(belief.subject, belief.values.counterparty, owner);
    if (direction === null) return [];
    return [{ row, belief, direction, due: dueOf(belief.values) }];
  });
  return sided.length === 0 ? new Map() : lapsedCommitments(ctx, sided, at, zone);
}
