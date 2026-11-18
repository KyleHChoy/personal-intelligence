import { createHash } from "node:crypto";
import type { BeliefClaim, FactGrouping, FactRuling, GroupingMode } from "@intelligence/contracts/personal";
import { FACT_GROUP_MAX } from "@intelligence/contracts/personal";
import { byText } from "@intelligence/personal-core";
import { claimTier, ranksAbove } from "./tier.ts";

// Which fact keys one audience builds as one fact, and which claim's phrase renders a belief. Pure:
// the store reads the rulings and the grouping rows; nothing here reads a model's words, and no
// grouping row outranks the owner (invariant 11).

// One audience's joined sets: each a set of two to FACT_GROUP_MAX fact key fingerprints, sorted,
// and the sets that were not joined (more than FACT_GROUP_MAX keys, or a pair the owner split
// inside the owner's own joins), counted.
export type JoinedSets = { sets: string[][]; refused: number };

const pairKey = (a: string, b: string): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

// The joined sets of one audience. `present` are the fact keys this audience builds a belief of
// (each with a kept claim); `covers` says whether the audience holds every compartment of a join
// or a grouping row. Every split binds every audience, whatever its label: a split
// only keeps two keys apart, which narrows and reveals nothing (invariant 5), while a split
// labelled with a compartment the audience lacks would otherwise let a grouping row join the pair
// the owner split. In order:
// 1. the owner's joins the audience may read connect their keys, transitively;
// 2. a set that holds a pair the owner split (their joins contradicting their split), or that holds
//    more than FACT_GROUP_MAX present keys, is not joined, and counted, until the owner lifts a ruling;
// 3. each accepted grouping row the audience may read joins its two keys, in `apply` mode, and in
//    every mode when code accepted it at rung 0 for equal key phrases, pair by pair in the order
//    of their keys, unless the owner split that pair, the join would bring a split pair together,
//    a set it touches was refused, or the set would pass FACT_GROUP_MAX keys.
// So a split holds against every grouping, and a join against every grouping row, whatever its
// band or state (invariant 11). Only present keys are members; an absent key a join names still
// connects the keys it was joined with, since the owner said they state one fact.
export function joinedSets(
  present: readonly string[],
  rulings: readonly FactRuling[],
  groupings: readonly FactGrouping[],
  mode: GroupingMode,
  covers: (compartments: readonly string[]) => boolean,
): JoinedSets {
  const here = new Set(present);
  const splitPairs = rulings.filter((one) => one.verdict === "split");
  const splits = new Set(splitPairs.map((one) => pairKey(one.a, one.b)));

  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(key, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const [x, y] = [find(a), find(b)].sort(byText) as [string, string];
    if (x !== y) parent.set(y, x);
  };
  for (const join of rulings.filter((one) => one.verdict === "join" && covers(one.compartments))) union(join.a, join.b);

  const members = (root: string): string[] => [...here].filter((key) => find(key) === root).sort(byText);
  const holdsSplit = (keys: ReadonlySet<string>): boolean =>
    splitPairs.some((one) => keys.has(one.a) && keys.has(one.b));
  const allOf = (root: string): Set<string> => new Set([...parent.keys(), ...here].filter((key) => find(key) === root));

  const refusedRoots = new Set<string>();
  for (const root of new Set([...parent.keys()].map(find))) {
    if (holdsSplit(allOf(root)) || members(root).length > FACT_GROUP_MAX) refusedRoots.add(root);
  }

  {
    const accepted = groupings
      .filter(
        (one) =>
          one.state === "accepted" &&
          (mode === "apply" || one.rung === 0) &&
          covers(one.audience) &&
          here.has(one.keys[0]) &&
          here.has(one.keys[1]) &&
          !splits.has(pairKey(one.keys[0], one.keys[1])),
      )
      .sort((a, b) => byText(a.keys.join("\n"), b.keys.join("\n")));
    for (const { keys } of accepted) {
      const [a, b] = [find(keys[0]), find(keys[1])];
      if (a === b || refusedRoots.has(a) || refusedRoots.has(b)) continue;
      const merged = new Set([...allOf(a), ...allOf(b)]);
      if (holdsSplit(merged) || [...merged].filter((key) => here.has(key)).length > FACT_GROUP_MAX) continue;
      union(a, b);
    }
  }

  const sets: string[][] = [];
  const roots = new Set(present.map(find));
  for (const root of [...roots].sort(byText)) {
    if (refusedRoots.has(root)) continue;
    const set = members(root);
    if (set.length >= 2) sets.push(set);
  }
  return { sets, refused: refusedRoots.size };
}

// The fingerprint a joined set's beliefs share, across labels, so a reader collapses
// their lines for a caller that sees both. A hash of the members' keyed fingerprints, which says
// nothing they do not.
export const groupOf = (members: readonly string[]): string =>
  createHash("sha256")
    .update(`fact_group\n${[...members].sort(byText).join("\n")}`, "utf8")
    .digest("hex");

const at = (time: string): number => Date.parse(time);

// Its id; undefined for none.
export function canonicalClaim(kept: readonly BeliefClaim[]): string | undefined {
  let best: { one: BeliefClaim; tier: ReturnType<typeof claimTier> } | undefined;
  for (const one of kept) {
    const tier = claimTier(one, true);
    if (best === undefined) {
      best = { one, tier };
      continue;
    }
    const higher = ranksAbove(tier, best.tier);
    const same = tier === best.tier;
    const newer = at(one.claim.validFrom) > at(best.one.claim.validFrom);
    const tied =
      at(one.claim.validFrom) === at(best.one.claim.validFrom) && byText(one.claim.id, best.one.claim.id) < 0;
    if (higher || (same && (newer || tied))) best = { one, tier };
  }
  return best?.one.claim.id;
}
