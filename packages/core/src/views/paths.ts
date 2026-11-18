// The routes from the owner to one person, found by code over what the caller can see. Nothing here
// reads a database, a key or a clock: the store hands in the owner's own ties and the ties and
// affiliations of current beliefs, and this walks them. Every order, count, score and `cut` comes
// from those rows alone, so a row the caller cannot see changes nothing.
//
// The owner has an entity, so every path starts with the owner's own tie as its first hop (`own_tie`, citing no fact: an own tie rests on mail and
// meetings, not a belief), and `maxHops` counts that hop. A hop cites fact ids, not passages, and
// names entity ids, not handles. The answer says whether a bound cut the walk short.
import {
  type EntityId,
  type FactId,
  type IntroOffer,
  isObservedTie,
  type ObservedBasis,
  type PathTie,
  type SecondDegreeRules,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";

// `relationship` is a current relationship belief of any relation but `acquaintance`;
// `acquaintance` one of that relation; `intro_offer` an offer claim, with its `offer`; `connection`
// a confirmed connection; `reported` and `researched` a third party's report and a research fill's;
// `shared_thread` and `met_together` read by code from mail and meetings.
export type TieVia = Exclude<PathTie, "own_tie" | "affiliation" | "same_domain">;
export type ObservedVia = Extract<TieVia, "shared_thread" | "met_together">;
export type StatedVia = Exclude<TieVia, ObservedVia>;
// What an observed hop rests on, with no weight: the hop's own `weight` holds that.
type ObservedSeen = Omit<ObservedBasis, "weight">;
// A tie between two people, either way. With no `via` it is a relationship; with no `weight`,
// RELATIONSHIP_HOP. `V`, the kinds a caller hands in: relationships alone unless it says more.
export type Tie<V extends TieVia = "relationship"> = {
  a: EntityId;
  b: EntityId;
  facts: FactId[];
  via?: V;
  offer?: IntroOffer;
  weight?: number;
  seen?: ObservedSeen;
};
// A person's current affiliation with an organization. Two people who share one are bridged. With `via`, code read
// it from an address on the organization's domain, and `weight` is that hop's.
export type Affiliation = {
  person: EntityId;
  organization: EntityId;
  facts: FactId[];
  via?: "same_domain";
  weight?: number;
};
// One hop: `offer` an intro_offer hop's alone, `weight` its tie's (absent: its kind's fixed strength),
// `seen` an observed hop's alone.
export type PathHop<V extends TieVia = "relationship"> = {
  from: EntityId;
  to: EntityId;
  via: "own_tie" | "affiliation" | "same_domain" | V;
  facts: FactId[];
  offer?: IntroOffer;
  weight?: number;
  seen?: ObservedSeen;
};
export type Path<V extends TieVia = "relationship"> = { score: number; hops: PathHop<V>[] };

// The most paths one answer holds. find_paths and the owner's own paths take their hop limit from
// the rule file's `maxHops` (4).
export const MAX_PATHS = 20;
// The most paths find_paths ranks before it cuts to MAX_PATHS.
export const RANKED_PATHS = 200;
// The bounds of one call. At most MAX_LINKS ties and as many affiliations are walked, the first
// by their entities' ids; and the walk looks at no more than MAX_STEPS neighbours in all. An
// organization is a hub the walk passes through, so a large one costs what its members cost
// once, never every pair of them.
export const MAX_LINKS = 5_000;
export const MAX_STEPS = 10_000;

// A domain's hop rests on an address: no message or meeting to count or point at.
const NO_SEEN: ObservedSeen = Object.freeze({ count: 0, lastAt: null, ref: null });

const pairKey = (a: string, b: string): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

// Each fact once, in a fixed order.
const merged = (lists: FactId[][]): FactId[] => [...new Set(lists.flat())].sort(byText);

// The first `MAX_LINKS` of a list, by a key of each, so the order they came in never matters;
// and whether any was left out.
function bounded<T>(list: T[], key: (entry: T) => string): { kept: T[]; cut: boolean } {
  const kept = list
    .map((entry) => ({ entry, key: key(entry) }))
    .sort((x, y) => byText(x.key, y.key))
    .slice(0, MAX_LINKS)
    .map(({ entry }) => entry);
  return { kept, cut: list.length > MAX_LINKS };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const held = map.get(key);
  if (held === undefined) map.set(key, [value]);
  else held.push(value);
}

export type PathInput<V extends TieVia = "relationship"> = {
  owner: EntityId;
  target: EntityId;
  // The people the owner exchanged mail with both ways, or met, lately.
  ownTies: ReadonlySet<EntityId>;
  ties: Tie<V>[];
  affiliations: Affiliation[];
  // At most this many hops, the own tie included.
  maxHops: number;
  // The walk stops, and paths come back, at this many, for a caller that ranks them itself and cuts to
  // MAX_PATHS after: the walk knows no one's closeness, so its own cut would fall by the entities' ids.
  // MAX_PATHS when none is named. The bounds on links and steps stay as they are.
  most?: number;
};

// A person's organizations, each with its stated affiliations' facts and the weight of a domain's.
type Held = { stated: FactId[][]; domain?: number };
type Orgs = ReadonlyMap<string, ReadonlyMap<string, Held>>;

// The organizations two people share: both stated, or held by either through an address alone.
const sharedOrgs = (
  orgsOf: Orgs,
  from: string,
  to: string,
): { stated: FactId[][]; half: FactId[][]; domain: number | null } => {
  const theirs = orgsOf.get(to);
  const out = { stated: [] as FactId[][], half: [] as FactId[][], domain: null as number | null };
  for (const [organization, held] of orgsOf.get(from) ?? []) {
    const other = theirs?.get(organization);
    if (other === undefined) continue;
    if (held.stated.length > 0 && other.stated.length > 0) out.stated.push(...held.stated, ...other.stated);
    else {
      out.half.push(...held.stated, ...other.stated);
      out.domain = Math.max(out.domain ?? 0, held.domain ?? 0, other.domain ?? 0);
    }
  }
  return out;
};

// The hop between two people of a route: their strongest tie, else the organization they share.
function hopOf<V extends TieVia>(
  tiesOfPair: ReadonlyMap<string, Tie<V>[]>,
  orgsOf: Orgs,
  target: EntityId,
  from: string,
  to: string,
): PathHop<V> {
  const ends = { from: from as EntityId, to: to as EntityId };
  const shared = sharedOrgs(orgsOf, from, to);
  const pair = tiesOfPair.get(pairKey(from, to));
  const kindOf = (tie: Tie<V>): string => `${tie.via ?? "relationship"}\n${tie.offer ?? ""}`;
  const chosen =
    pair === undefined
      ? undefined
      : ([...pair].sort(
          (x, y) => (y.weight ?? RELATIONSHIP_HOP) - (x.weight ?? RELATIONSHIP_HOP) || byText(kindOf(x), kindOf(y)),
        )[0] as Tie<V>);
  // A stated organization both share stands over a tie code only observed.
  if (pair !== undefined && chosen !== undefined && !(chosen.seen !== undefined && shared.stated.length > 0)) {
    return {
      ...ends,
      // A tie with no kind is a relationship, which every caller's kinds hold.
      via: chosen.via ?? ("relationship" as V),
      facts: merged(pair.filter((tie) => kindOf(tie) === kindOf(chosen)).map((tie) => tie.facts)),
      ...(chosen.offer === undefined ? {} : { offer: chosen.offer }),
      ...(chosen.weight === undefined ? {} : { weight: chosen.weight }),
      ...(chosen.seen === undefined ? {} : { seen: chosen.seen }),
    };
  }
  // A member to the organization that is the target: their affiliations with it. Through an
  // address alone, it is a domain's hop.
  const atTarget = to === target ? orgsOf.get(from)?.get(to) : undefined;
  if (atTarget !== undefined) {
    if (atTarget.stated.length > 0) return { ...ends, via: "affiliation", facts: merged(atTarget.stated) };
    return { ...ends, via: "same_domain", facts: [], weight: atTarget.domain ?? AFFILIATION_HOP, seen: NO_SEEN };
  }
  if (shared.stated.length > 0 || shared.domain === null)
    return { ...ends, via: "affiliation", facts: merged(shared.stated) };
  // One side's stated affiliation is part of what the hop rests on: it is cited, so its label is read.
  return { ...ends, via: "same_domain", facts: merged(shared.half), weight: shared.domain, seen: NO_SEEN };
}

// Every simple path of at most `maxHops` hops from the owner, through a person the owner has an
// own tie to, to `target`, passing no other such person, walked a layer at a time from the
// target. A target the owner has an own tie to is one path of that hop alone. Shorter paths
// score higher; among equals, the order of the entities' ids decides. The owner is never a hop
// inside the walk: a tie or an affiliation of the owner's is left out.
export function findPaths<V extends TieVia = "relationship">(input: PathInput<V>): { paths: Path<V>[]; cut: boolean } {
  const { owner, target, ownTies } = input;
  const walkHops = input.maxHops - 1;
  const most = input.most ?? MAX_PATHS;
  // A tie of one person to themself, and a tie or an affiliation of the owner's, is left out
  // before the bound, so none uses up a place.
  const ties = bounded(
    input.ties.filter((tie) => tie.a !== tie.b && tie.a !== owner && tie.b !== owner),
    (entry) => `${pairKey(entry.a, entry.b)}\n${JSON.stringify(entry.facts)}\n${entry.via ?? ""}\n${entry.offer ?? ""}`,
  );
  const affiliations = bounded(
    input.affiliations.filter((affiliation) => affiliation.person !== owner),
    (entry) => `${entry.person}\n${entry.organization}\n${JSON.stringify(entry.facts)}\n${entry.via ?? ""}`,
  );
  let cut = ties.cut || affiliations.cut;

  const tiesOfPair = new Map<string, Tie<V>[]>();
  const tied = new Map<string, Set<string>>();
  for (const tie of ties.kept) {
    push(tiesOfPair, pairKey(tie.a, tie.b), tie);
    tied.set(tie.a, (tied.get(tie.a) ?? new Set()).add(tie.b));
    tied.set(tie.b, (tied.get(tie.b) ?? new Set()).add(tie.a));
  }
  // Each person's organizations: the stated affiliations' facts, and the weight of a domain's, if any.
  const orgsOf = new Map<string, Map<string, Held>>();
  const membersOf = new Map<string, Set<string>>();
  for (const { person, organization, facts, via, weight } of affiliations.kept) {
    const orgs = orgsOf.get(person) ?? new Map<string, Held>();
    const held = orgs.get(organization) ?? { stated: [] };
    if (via === "same_domain") held.domain = weight ?? AFFILIATION_HOP;
    else held.stated.push(facts);
    orgs.set(organization, held);
    orgsOf.set(person, orgs);
    membersOf.set(organization, (membersOf.get(organization) ?? new Set()).add(person));
  }
  const sorted = (sets: Map<string, Set<string>>) =>
    new Map([...sets].map(([key, set]) => [key, [...set].sort(byText)]));
  const tiesOf = sorted(tied);
  const members = sorted(membersOf);

  // The neighbours of one person: their ties, then the people their organizations bridge them to. A
  // tie stands over a bridge between the same two. A target that is an organization has its members
  // as neighbours, so a route reaches anyone at it.
  function* neighbours(from: string): Generator<string> {
    if (from === target) yield* members.get(target) ?? [];
    const near = tied.get(from);
    yield* tiesOf.get(from) ?? [];
    const bridged = new Set<string>();
    for (const organization of [...(orgsOf.get(from)?.keys() ?? [])].sort(byText)) {
      // The target organization bridges no one: its members are each a route's end already.
      if (organization === target) continue;
      for (const other of members.get(organization) ?? []) {
        if (other === from || near?.has(other) || bridged.has(other)) continue;
        bridged.add(other);
        yield other;
      }
    }
  }

  // Each route is target, ..., start. A route ends at the first person the owner has an own tie
  // to: a longer one through them would only add hops.
  const found: string[][] = [];
  let frontier: string[][] = [[target]];
  let steps = 0;
  walk: for (let depth = 0; depth <= walkHops && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const route of frontier) {
      const last = route[route.length - 1] as string;
      if (ownTies.has(last as EntityId)) {
        found.push(route);
        continue;
      }
      if (depth === walkHops) continue;
      for (const other of neighbours(last)) {
        if (++steps > MAX_STEPS) {
          cut = true;
          break walk;
        }
        if (!route.includes(other)) next.push([...route, other]);
      }
    }
    // Later layers hold only longer paths: past the bound, they are cut.
    if (found.length >= most) {
      if (found.length > most || next.length > 0) cut = true;
      break;
    }
    frontier = next;
  }

  const views = found.map((back) => {
    const route = [...back].reverse();
    const start = route[0] as EntityId;
    const hops: PathHop<V>[] = [
      { from: owner, to: start, via: "own_tie", facts: [] },
      ...route.slice(1).map((to, i) => hopOf(tiesOfPair, orgsOf, target, route[i] as string, to)),
    ];
    return { key: route.join("\n"), path: { score: 1 / (hops.length + 1), hops } };
  });
  views.sort((x, y) => y.path.score - x.path.score || byText(x.key, y.key));
  return { paths: views.slice(0, most).map(({ path }) => path), cut };
}

// Every stated path comes first; a route found by both is the stated one.
export function findPathsWithObserved<V extends TieVia>(
  input: PathInput<V>,
  observed: { ties: Tie<V>[]; domains: Affiliation[] },
): { paths: Path<V>[]; cut: boolean } {
  const stated = findPaths(input);
  if (observed.ties.length === 0 && observed.domains.length === 0) return stated;
  const all = findPaths({
    ...input,
    ties: [...input.ties, ...observed.ties],
    affiliations: [...input.affiliations, ...observed.domains],
  });
  const routeOf = (path: Path<V>): string => path.hops.map((hop) => hop.to).join("\n");
  const known = new Set(stated.paths.map(routeOf));
  const paths = [...stated.paths, ...all.paths.filter((path) => !known.has(routeOf(path)))];
  return { paths: paths.slice(0, input.most ?? MAX_PATHS), cut: stated.cut || all.cut || paths.length > MAX_PATHS };
}

// The strength of each kind of hop, and a path's score, its weakest hop's. An own tie is as strong as
// the owner's tie with that person, and never below OWN_TIE_FLOOR: a saved contact or old mail is
// still a tie. A stated relationship and a shared organization have no measure of their own, so each
// counts a fixed strength. The hop from a member to the organization that is the target is no tie
// between people and counts for nothing; a hop there by an address alone counts its weight, since
// nobody says they are a member. Provisional, the owner's to tune.
export const OWN_TIE_FLOOR = 0.1;
export const RELATIONSHIP_HOP = 1;
export const AFFILIATION_HOP = 0.5;

export function hopWeight(
  via: StatedVia,
  rules: Pick<SecondDegreeRules, "acquaintanceWeight" | "introOfferWeight" | "reportedWeight">,
  offer?: IntroOffer,
): number {
  if (via === "acquaintance") return rules.acquaintanceWeight;
  if (via === "intro_offer") return rules.introOfferWeight[offer ?? "suggested"];
  if (via === "reported" || via === "researched") return rules.reportedWeight;
  return RELATIONSHIP_HOP;
}

// Paths resting on stated relations alone first, then by the strength of their weakest hop, then the fewest hops,
// then the strength of their own tie, then as given; each path's score set to its weakest hop's, two decimals. `own`
// is the strength of the owner's tie with each person, read for the paths given alone (E8). `order`, when given, is
// each person's tieOrder (the owner's confirmed closeness before the score) and takes the own tie's place as the
// third key; the score stays the weakest hop's.
export function rankPathsByWeakestHop<P extends Path<TieVia>>(
  paths: readonly P[],
  own: ReadonlyMap<string, number>,
  target: EntityId,
  targetIsOrganization: boolean,
  order?: ReadonlyMap<string, number>,
): P[] {
  const ownOf = (path: P): number => Math.max(OWN_TIE_FLOOR, own.get(path.hops[0]?.to ?? "") ?? 0);
  const orderOf = (path: P): number => (order === undefined ? ownOf(path) : (order.get(path.hops[0]?.to ?? "") ?? 0));
  const strength = (path: P, hop: PathHop<TieVia>): number | null =>
    hop.via === "own_tie"
      ? ownOf(path)
      : targetIsOrganization && hop.to === target && hop.via === "affiliation"
        ? null
        : (hop.weight ?? (hop.via === "affiliation" ? AFFILIATION_HOP : RELATIONSHIP_HOP));
  const observed = (path: P): number => Number(path.hops.some((hop) => isObservedTie(hop.via)));
  return paths
    .map((path, index) => {
      const counted = path.hops.map((hop) => strength(path, hop)).filter((one): one is number => one !== null);
      return { path: { ...path, score: Math.round(Math.min(...counted) * 100) / 100 }, index, own: orderOf(path) };
    })
    .sort(
      (x, y) =>
        observed(x.path) - observed(y.path) ||
        y.path.score - x.path.score ||
        x.path.hops.length - y.path.hops.length ||
        y.own - x.own ||
        x.index - y.index,
    )
    .map(({ path }) => path);
}

// A list of twenty ways through one person or one message's recipients is one route, shown twenty times. Walking a ranked
// list best first, a path stands while no person in its middle, and no message an observed hop rests on,
// has already been used this many times: so the list holds different routes and each is the best of its
// kind. The target is no one's middle, and a list this leaves short says `cut`.
const ROUTES_THROUGH_ONE = 3;
export function distinctRoutes<P extends Path<TieVia>>(paths: readonly P[], target: EntityId): P[] {
  const used = new Map<string, number>();
  return paths.filter((path) => {
    const keys = [
      ...new Set(
        path.hops.flatMap((hop) => [...(hop.to === target ? [] : [hop.to]), ...(hop.seen?.ref ? [hop.seen.ref] : [])]),
      ),
    ];
    if (keys.some((key) => (used.get(key) ?? 0) >= ROUTES_THROUGH_ONE)) return false;
    for (const key of keys) used.set(key, (used.get(key) ?? 0) + 1);
    return true;
  });
}
