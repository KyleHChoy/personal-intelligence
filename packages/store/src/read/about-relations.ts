import type { AppliedRelation } from "@intelligence/contracts/personal";
import type { ReadRelation } from "@intelligence/personal-beliefs";

// The relations that applied to one belief as `about` serves them: each relation the read applied with
// one end among the belief's own claims, by its id, kind and judge, between the first pair of its
// claims the caller may be cited. `servedId` is a claim's id as its citation names it, or null for a
// claim the caller may not be cited, so a relation is served only when the caller sees both of its
// claims (invariant 6). Pure.
export function beliefRelations(
  applied: readonly ReadRelation[],
  support: readonly string[],
  servedId: (claimId: string) => string | null,
): AppliedRelation[] {
  const own = new Set(support);
  return applied.flatMap((relation) => {
    for (const fromId of relation.fromIds)
      for (const toId of relation.toIds) {
        if (fromId === toId || !(own.has(fromId) || own.has(toId))) continue;
        const [from, to] = [servedId(fromId), servedId(toId)];
        if (from === null || to === null) continue;
        return [{ id: relation.id, from, to, kind: relation.kind, judge: relation.judge }];
      }
    return [];
  });
}
