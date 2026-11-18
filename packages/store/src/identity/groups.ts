import type { IdentityBasis, IdentityException } from "@intelligence/contracts/personal";
import type { IdentityRuling } from "../core/identity-rulings.ts";

// The one computation of who the owner's rulings join, and the one rule for whether a pair may
// hold an identity card. Pure: no database, no
// key. The owner's checks and the sweep hand it every ruling; the reader, the rulings its token
// can read. Fingerprints are compared as they are given.

export type { IdentityRuling };

export type Groups = {
  // Each fingerprint a ruling joins, to its group's key (the group's least fingerprint).
  readonly keyOf: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, ReadonlySet<string>>;
  // The ids of the same rulings that join each group, sorted.
  readonly joinedBy: ReadonlyMap<string, readonly string[]>;
  readonly owner: ReadonlySet<string>;
};

const live = (ruling: IdentityRuling): boolean => ruling.liftedAt === null;

// Unlifted same rulings, directly or through others; a ruling that names an owner fingerprint
// joins nothing.
export function groupsOf(rulings: readonly IdentityRuling[], ownerFps: readonly string[]): Groups {
  const owner = new Set(ownerFps);
  const parent = new Map<string, string>();
  const find = (fp: string): string => {
    let root = fp;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(fp, root);
    return root;
  };
  const joins = joining(rulings, owner);
  for (const one of joins) {
    const [a, b] = [find(one.aFp), find(one.bFp ?? one.aFp)];
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    // The lesser root stays the root, so a group's key does not depend on the rulings' order.
    if (a !== b) a < b ? parent.set(b, a) : parent.set(a, b);
  }
  const keyOf = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  for (const fp of parent.keys()) {
    const key = find(fp);
    keyOf.set(fp, key);
    members.set(key, (members.get(key) ?? new Set()).add(fp));
  }
  const joinedBy = new Map<string, string[]>();
  for (const one of joins) {
    const key = keyOf.get(one.aFp) ?? one.aFp;
    joinedBy.set(key, [...(joinedBy.get(key) ?? []), one.id].sort());
  }
  return { keyOf, members, joinedBy, owner };
}

const joining = (rulings: readonly IdentityRuling[], owner: ReadonlySet<string>): IdentityRuling[] =>
  rulings.filter(
    (one) => live(one) && one.verdict === "same" && one.bFp !== null && !owner.has(one.aFp) && !owner.has(one.bFp),
  );

// The rulings of a shortest chain of joins from one fingerprint to another, in order, or undefined
// when no chain joins them. Any way of setting the two apart lifts one of these.
export function pathBetween(
  groups: Groups,
  rulings: readonly IdentityRuling[],
  a: string,
  b: string,
): string[] | undefined {
  const joins = joining(rulings, groups.owner);
  const from = new Map<string, { fp: string; ruling: string } | null>([[a, null]]);
  const queue = [a];
  for (let at = queue.shift(); at !== undefined && !from.has(b); at = queue.shift()) {
    for (const one of joins) {
      const next = one.aFp === at ? one.bFp : one.bFp === at ? one.aFp : null;
      if (next === null || from.has(next)) continue;
      from.set(next, { fp: at, ruling: one.id });
      queue.push(next);
    }
  }
  if (!from.has(b)) return undefined;
  const path: string[] = [];
  for (let step = from.get(b); step !== null && step !== undefined; step = from.get(step.fp)) path.unshift(step.ruling);
  return path;
}

// The fingerprints in a fingerprint's group: itself alone when no ruling joins it.
export const groupOf = (groups: Groups, fp: string): ReadonlySet<string> =>
  groups.members.get(groups.keyOf.get(fp) ?? "") ?? new Set([fp]);

const keyFor = (groups: Groups, fp: string): string => groups.keyOf.get(fp) ?? fp;

// The unlifted different rulings between two groups.
function differentBetween(
  rulings: readonly IdentityRuling[],
  one: ReadonlySet<string>,
  other: ReadonlySet<string>,
): string[] {
  return rulings
    .filter((ruling) => live(ruling) && ruling.verdict === "different" && ruling.bFp !== null)
    .filter(
      (ruling) =>
        (one.has(ruling.aFp) && other.has(ruling.bFp ?? "")) || (other.has(ruling.aFp) && one.has(ruling.bFp ?? "")),
    )
    .map((ruling) => ruling.id)
    .sort();
}

// Whether the pair is already one person (with the rulings that join it), already two by a
// different ruling, directly or through the groups, or open.
export function settles(
  groups: Groups,
  rulings: readonly IdentityRuling[],
  a: string,
  b: string,
): { by: "same" | "different"; rulings: string[] } | { by: "open" } {
  const key = keyFor(groups, a);
  if (key === keyFor(groups, b) && groups.joinedBy.has(key))
    return { by: "same", rulings: [...(groups.joinedBy.get(key) ?? [])] };
  const differ = differentBetween(rulings, groupOf(groups, a), groupOf(groups, b));
  return differ.length > 0 ? { by: "different", rulings: differ } : { by: "open" };
}

// Whether a new ruling would put a different pair in one group, or rule different inside one.
export function conflict(
  groups: Groups,
  rulings: readonly IdentityRuling[],
  a: string,
  b: string,
  verdict: "same" | "different",
): boolean {
  const [one, other] = [groupOf(groups, a), groupOf(groups, b)];
  if (verdict === "different") return keyFor(groups, a) === keyFor(groups, b) && groups.joinedBy.has(keyFor(groups, a));
  const together = new Set([...one, ...other]);
  return differentBetween(rulings, together, together).length > 0;
}

// Why an eligible pair is carded instead of merged, or undefined when the owner's standing rule
// merges it: anyone in either group named in a `different` ruling in force (the owner's no stands), or in a
// lifted `same` (the owner's split, or a lifted policy merge); on the name basis a name the owner has set two
// holders of apart within the pair's labels (`namesakes`, namesakesRuled); and on the name and
// local-part bases a person not established within them. The one place the exceptions are written;
// ledger.policy_merge checks them again after its lock, and can only refuse.
export function exceptionOf(
  groups: Groups,
  rulings: readonly IdentityRuling[],
  a: string,
  b: string,
  basis: IdentityBasis,
  namesakes: boolean,
  established: boolean,
): IdentityException | undefined {
  const members = new Set([...groupOf(groups, a), ...groupOf(groups, b)]);
  const names = (ruling: IdentityRuling): boolean =>
    members.has(ruling.aFp) || (ruling.bFp !== null && members.has(ruling.bFp));
  if (
    rulings.some((ruling) => live(ruling) && ruling.verdict === "different" && ruling.byAgent !== true && names(ruling))
  )
    return "ruled_different";
  if (
    rulings.some(
      (ruling) => !live(ruling) && ruling.verdict === "same" && ruling.liftedByDeletion !== true && names(ruling),
    )
  )
    return "lifted_before";
  if (basis === "name" && namesakes) return "common_name";
  if (basis !== "contact" && !established) return "unestablished";
  return undefined;
}

// Whether a name's holders, each given by its addresses, are two people by the owner's word: a different in
// force, or a same the owner lifted, between an address of one holder and of another. Records alone,
// however many, are one person's.
export function namesakesRuled(rulings: readonly IdentityRuling[], holders: readonly (readonly string[])[]): boolean {
  const holderOf = new Map<string, number>();
  holders.forEach((fps, index) => {
    for (const fp of fps) holderOf.set(fp, index);
  });
  return rulings.some((ruling) => {
    if (ruling.bFp === null || !(live(ruling) ? ruling.verdict === "different" : ruling.verdict === "same"))
      return false;
    if (live(ruling) ? ruling.byAgent === true : ruling.liftedByDeletion === true) return false;
    const [a, b] = [holderOf.get(ruling.aFp), holderOf.get(ruling.bFp)];
    return a !== undefined && b !== undefined && a !== b;
  });
}

// Not for the owner, nor an address an unlifted shared ruling names, nor a pair a ruling in force
// already settles.
export function eligible(groups: Groups, rulings: readonly IdentityRuling[], a: string, b: string): boolean {
  if (a === b || groups.owner.has(a) || groups.owner.has(b)) return false;
  const shared = new Set(rulings.filter((one) => live(one) && one.verdict === "shared").map((one) => one.aFp));
  if (shared.has(a) || shared.has(b)) return false;
  return settles(groups, rulings, a, b).by === "open";
}
