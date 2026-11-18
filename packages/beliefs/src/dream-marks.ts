import type { BeliefCheckMark, BeliefClaim, BeliefSettlement } from "@intelligence/contracts/personal";

// At read, pure: the agents' settlements an audience may apply, and whether a
// source check marks a belief unsupported. Both act only under a label the audience holds and only on
// claims this read holds (invariant 6), as readRelations does for a relation.

const at = (time: string): number => Date.parse(time);
const within = (audience: readonly string[], compartments: readonly string[]): boolean =>
  compartments.every((one) => audience.includes(one));

// A settlement as the build applies it: the claim ids it holds current and those it settles against.
export type ReadSettlement = { id: string; at: string; fromIds: string[]; toIds: string[] };

// The settlements made by `asOf`, under a label within the audience, naming two claims this read
// holds, newest first: the newest settlement of a pair is the one in force.
export function readSettlements(
  claims: readonly BeliefClaim[],
  settlements: readonly BeliefSettlement[],
  audience: readonly string[],
  asOf: string,
): ReadSettlement[] {
  const byKey = new Map<string, string[]>();
  for (const one of claims)
    for (const key of one.keys ?? []) byKey.set(key, [...new Set([...(byKey.get(key) ?? []), one.claim.id as string])]);
  const out: ReadSettlement[] = [];
  for (const one of settlements) {
    if (at(one.at) > at(asOf) || !within(audience, one.compartments)) continue;
    if (one.holds !== one.a && one.holds !== one.b) continue;
    const other = one.holds === one.a ? one.b : one.a;
    const fromIds = byKey.get(one.holds) ?? [];
    const toIds = byKey.get(other) ?? [];
    if (fromIds.length === 0 || toIds.length === 0) continue;
    out.push({ id: one.id, at: one.at, fromIds, toIds });
  }
  return out.sort((a, b) => at(b.at) - at(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// Whether the newest model check this audience may read on exactly the belief's claims found them
// not supporting it. A belief's claims are its support; a claim is on the check when one of its keys
// is, and the check names no key of a claim outside the support.
export function unsupportedFor(
  support: readonly string[],
  claimById: ReadonlyMap<string, BeliefClaim>,
  checks: readonly BeliefCheckMark[],
  audience: readonly string[],
  asOf: string,
): boolean {
  const keysOf = support.map((id) => claimById.get(id)?.keys ?? []);
  if (keysOf.some((keys) => keys.length === 0)) return false;
  const all = new Set(keysOf.flat());
  const exact = (mark: BeliefCheckMark): boolean =>
    mark.claimKeys.every((key) => all.has(key)) &&
    keysOf.every((keys) => keys.some((key) => mark.claimKeys.includes(key)));
  const newest = checks
    .filter((mark) => at(mark.at) <= at(asOf) && within(audience, mark.compartments) && exact(mark))
    .sort((a, b) => at(b.at) - at(a.at))[0];
  return newest !== undefined && newest.verdict !== "supported";
}
