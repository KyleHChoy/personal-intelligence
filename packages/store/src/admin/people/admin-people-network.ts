import { ownerZoneOf } from "../../core/zone.ts";
// The map and path views over the owner's network graph: the first load, one node's expand, and
// the weakest-hop paths to a person or an organization, with the nodes and edges they answer.

import {
  type EntityId,
  type FactId,
  NETWORK_FIRST_MOST,
  type NetworkArgs,
  type NetworkEdge,
  type NetworkNeighbours,
  type NetworkNode,
  type NetworkView,
  type OwnerPaths,
  startOfDay,
  TIERS,
  type Tier,
  tierPlace,
  type Who,
} from "@intelligence/contracts/personal";
import {
  AFFILIATION_HOP,
  type Affiliation,
  findPathsWithObserved,
  OWN_TIE_FLOOR,
  type Path,
  RELATIONSHIP_HOP,
  rankPathsByWeakestHop,
  secondDegreeRules,
  type Tie,
  type TieVia,
  warmthRules,
} from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query } from "../../core/db.ts";
import { PERSON_OR_ORG_KINDS } from "../../core/statements.ts";
import { loadObservedHops, type ObservedHops } from "../../read/read-observed.ts";
import type { WarmthRow } from "../../read/read-warmth.ts";
import { byStrength, type Graph, graphOf, groupWho, type Link, named, pairKey, shown } from "./admin-people-graph.ts";

// Best tier first, then the most warmth, then by id.
const byWarmth = (a: WarmthRow, b: WarmthRow): number =>
  tierPlace(a.tier) - tierPlace(b.tier) || Number(b.warmth) - Number(a.warmth) || byText(a.entity_id, b.entity_id);
// An own tie's weight: the tier's path weight from the rule table, as find_paths weighs the hop.
const tieWeight = (row: WarmthRow): number => Math.max(OWN_TIE_FLOOR, warmthRules().pathWeights[row.tier]);
// The order find_paths breaks ties by (read-warmth.ts warmthOrder): the tier's band, then warmth.
const tieOrder = (row: WarmthRow): number => (TIERS.length - tierPlace(row.tier)) * 1_000_000 + Number(row.warmth);

// The targets of the owner's active goals within their audience, read on each call, as the graph
// is.
const GOAL_TARGETS = `
  select distinct g.target_entity_id as id from projections.goal_state g
  where g.status = 'active' and g.target_entity_id is not null and g.compartments <@ $1::text[]
  order by 1`;

// The ids of the active goals' targets the owner's audience holds, for `pi outcomes`.
export const goalTargetIds = async (query: Query): Promise<string[]> =>
  (await query<{ id: string }>(GOAL_TARGETS, [await ownerAudience(query)])).map((row) => row.id);

async function goalTargets(query: Query, graph: Graph): Promise<ReadonlySet<string>> {
  const audience = await ownerAudience(query);
  return new Set(
    (await query<{ id: string }>(GOAL_TARGETS, [audience])).map((row) =>
      graph.kinds.get(row.id) === "organization" ? row.id : graph.groups.idOf(row.id),
    ),
  );
}

// Nodes for ids, named by the graph's names: no statement. A named person or organization is marked
// `nameOnly`, and a goal's target `goal`.
function nodesOf(graph: Graph, ids: readonly string[], goals: ReadonlySet<string>): NetworkNode[] {
  return ids.map((id): NetworkNode => {
    if (id === graph.owner)
      return { id: id as EntityId, kind: "owner", name: null, tier: null, dormant: false, warmth: null };
    const row = graph.ties.get(id);
    const who = graph.who.get(id);
    const kind = who?.kind === "organization" || graph.kinds.get(id) === "organization" ? "organization" : "person";
    return {
      id: id as EntityId,
      kind,
      name: who?.name ?? null,
      // The owner's reads hold it to their audience (ownerWho). A person's address stays off the map.
      ...(kind === "organization" && who?.address != null ? { address: who.address } : {}),
      tier: row?.tier ?? null,
      dormant: row?.dormant ?? false,
      warmth: row === undefined ? null : Number(row.warmth),
      ...(who?.nameOnly === true ? { nameOnly: true as const } : {}),
      ...(goals.has(id) ? { goal: true as const } : {}),
    };
  });
}

const linkEdge = (link: Link): NetworkEdge => ({
  from: link.a as EntityId,
  to: link.b as EntityId,
  kind: link.kind,
  ...(link.offer === undefined ? {} : { offer: link.offer }),
  weight: link.weight,
  fact: link.fact,
});

const DEFAULT_TIERS: readonly Tier[] = ["inner", "close", "regular"];

// A person or organization known by a name alone.
const nameOnly = (graph: Graph, id: string): boolean => graph.who.get(id)?.nameOnly === true;

// Then for each person shown, the people and organizations known by a name alone that their links reach,
// one hop out, at most `mapNamedPerNode` each, a goal's target first, then the strongest link: the rest by
// expand. `more` says someone was left out.
export function network(context: AdminContext, args: NetworkArgs = {}): Promise<NetworkView> {
  return context.transaction(async (query) => {
    const graph = await graphOf(context, { query, keys: context.keys });
    const goals = await goalTargets(query, graph);
    const tiers = new Set<Tier>(args.tiers ?? DEFAULT_TIERS);
    // `since` is the owner's local day's first instant.
    const since = args.since === undefined ? null : startOfDay(args.since, await ownerZoneOf(query));
    const limit = Math.min(args.limit ?? NETWORK_FIRST_MOST, NETWORK_FIRST_MOST);
    const candidates = [...graph.rows.values()]
      .filter(
        (row) =>
          tiers.has(row.tier) &&
          (since === null || (row.last_two_way_at !== null && new Date(row.last_two_way_at).getTime() >= since)),
      )
      .sort(byWarmth);
    const ids: string[] = graph.owner === null ? [] : [graph.owner];
    // Each organization the people given hold, with its first link to each, by how many people it
    // holds, then by id. One known by a name alone comes with the named nodes, below.
    const organizationsOf = (people: ReadonlySet<string>): [string, Link[]][] => {
      const held = new Map<string, Link[]>();
      for (const link of graph.links) {
        if (link.kind !== "affiliation" || !people.has(link.a) || !named(graph, link.b) || nameOnly(graph, link.b))
          continue;
        const links = held.get(link.b) ?? [];
        if (!links.some((one) => one.a === link.a)) held.set(link.b, [...links, link]);
      }
      return [...held].sort(([a, x], [b, y]) => y.length - x.length || byText(a, b));
    };
    // Organizations are bounded as people are: when people would fill the load, up to a quarter of
    // it is kept for the organizations the people shown hold, so a full map still shows them.
    const room = Math.max(0, limit - ids.length);
    const forOrganizations = Math.min(
      organizationsOf(new Set(candidates.slice(0, room).map((row) => row.entity_id))).length,
      Math.floor(limit / 4),
    );
    const people = candidates.slice(0, candidates.length >= room ? room - forOrganizations : room);
    ids.push(...people.map((row) => row.entity_id));
    const shown = new Set(ids);
    const edges: NetworkEdge[] =
      graph.owner === null
        ? []
        : people.map((row) => ({
            from: graph.owner as EntityId,
            to: row.entity_id as EntityId,
            kind: "tie",
            weight: tieWeight(row),
            fact: null,
          }));
    const links = graph.links;
    const seen = new Set<string>();
    const organizations = organizationsOf(shown);
    const kept = organizations.slice(0, Math.max(0, limit - ids.length));
    for (const [organization, held] of kept) {
      ids.push(organization);
      edges.push(...held.map(linkEdge));
    }
    const perNode = secondDegreeRules().mapNamedPerNode;
    let cut = false;
    for (const row of people) {
      const person = row.entity_id;
      const reach = new Map<string, Link>();
      for (const link of graph.linksOf.get(person) ?? []) {
        const other = link.a === person ? link.b : link.a;
        if (reach.has(other) || !nameOnly(graph, other) || !named(graph, other)) continue;
        reach.set(other, link);
      }
      const ranked = [...reach].sort(
        ([a, x], [b, y]) => Number(goals.has(b)) - Number(goals.has(a)) || byStrength(x, y),
      );
      if (ranked.length > perNode) cut = true;
      for (const [other, link] of ranked.slice(0, perNode)) {
        if (!shown.has(other)) {
          if (ids.length >= limit) {
            cut = true;
            continue;
          }
          ids.push(other);
          shown.add(other);
        }
        if (seen.has(pairKey(person, other))) continue;
        seen.add(pairKey(person, other));
        edges.push(linkEdge(link));
      }
    }
    for (const link of links) {
      if (link.kind === "affiliation" || !shown.has(link.a) || !shown.has(link.b) || seen.has(pairKey(link.a, link.b)))
        continue;
      seen.add(pairKey(link.a, link.b));
      edges.push(linkEdge(link));
    }
    return {
      nodes: nodesOf(graph, ids, goals),
      edges,
      more: candidates.length > people.length || organizations.length > kept.length || cut || graph.cut,
    };
  });
}

// The owner's own: every person they have a tie with. A person's: the owner, when they have a tie, the people any
// link of the loader names (a relationship, an acquaintance, an offer, a connection, a report, research; the
// strongest link to each) and the organizations they are affiliated with. An organization's: the people
// affiliated with it. A named node's: the people who named it. At most NETWORK_FIRST_MOST, the strongest edge
// first (the owner's ties in warmth order within a weight). A group member asked for stands for its group: the
// edges name the id asked. Null for an id that is no person or organization, or one withheld; empty for one with
// no neighbour.
export function networkExpand(context: AdminContext, node: EntityId): Promise<NetworkNeighbours | null> {
  return context.transaction(async (query) => {
    const graph = await graphOf(context, { query, keys: context.keys });
    const found: NetworkEdge[] = [];
    if (node === graph.owner) {
      for (const row of [...graph.rows.values()].sort(byWarmth))
        found.push({ from: node, to: row.entity_id as EntityId, kind: "tie", weight: tieWeight(row), fact: null });
    } else {
      const [entity] = await query<{ id: string; kind: "person" | "organization" }>(PERSON_OR_ORG_KINDS, [[node]]);
      if (entity === undefined || graph.withheld.has(node)) return null;
      const id = entity.kind === "person" ? graph.groups.idOf(node) : node;
      if (graph.groups.membersOf(id).some((one) => graph.withheld.has(one))) return null;
      // An unnamed person is no node of the map; one the graph does not hold (no tie, no link) is
      // named here, and has no neighbour.
      if (
        !shown(
          graph.who.get(id) ??
            (await groupWho({ query, keys: context.keys }, [id], (one) => graph.groups.membersOf(one))).get(id),
        )
      )
        return null;
      const row = graph.rows.get(id);
      if (row !== undefined && graph.owner !== null)
        found.push({ from: graph.owner as EntityId, to: node, kind: "tie", weight: tieWeight(row), fact: null });
      const seen = new Set<string>();
      for (const link of graph.linksOf.get(id) ?? []) {
        const other = link.a === id ? link.b : link.a;
        if (seen.has(other) || !named(graph, other)) continue;
        seen.add(other);
        const edge = linkEdge(link);
        found.push({ ...edge, from: edge.from === id ? node : edge.from, to: edge.to === id ? node : edge.to });
      }
    }
    const neighbour = (edge: NetworkEdge): string => (edge.from === node ? edge.to : edge.from);
    // A stable sort: equal weights keep the order found, the owner's ties by warmth and links by
    // strength.
    const edges = found.sort((x, y) => y.weight - x.weight).slice(0, NETWORK_FIRST_MOST);
    return { nodes: nodesOf(graph, edges.map(neighbour), await goalTargets(query, graph)), edges };
  });
}

// The walk's stand-in start for a path from someone else: no entity id has this shape.
const START = "start";

// What differs from find_paths: the owner's own ties are the people of their warmth rows but the one-way tier,
// not its interaction and contact query, so a saved contact the owner never wrote with or met is no first hop;
// a hop's weight is the tier's path weight. From someone else the owner's own ties are links like any other,
// so a path may pass through the owner. The walk also takes the hops code observes, under the owner's
// audience. Null for an id that is neither, a source that is no person, or an end withheld or unnamed, alike.
export function paths(context: AdminContext, target: EntityId, source?: EntityId): Promise<OwnerPaths | null> {
  return context.transaction(async (query) => {
    const tx = { query, keys: context.keys };
    const kinds = new Map(
      (
        await query<{ id: string; kind: "person" | "organization" }>(PERSON_OR_ORG_KINDS, [
          source === undefined ? [target] : [target, source],
        ])
      ).map((row) => [row.id, row.kind]),
    );
    if (!kinds.has(target) && source === undefined) return null;
    const graph = await graphOf(context, tx);
    // The owner is no person or organization of PERSON_OR_ORG_KINDS: as the source they are the path from the
    // owner, and as the target of a path from someone else, a person.
    const fromHim = source === undefined || source === graph.owner;
    const kind = target === graph.owner && !fromHim ? "person" : kinds.get(target);
    if (kind === undefined || (!fromHim && kinds.get(source) !== "person")) return null;
    const to = kind === "person" ? graph.groups.idOf(target) : target;
    const from = fromHim ? graph.owner : graph.groups.idOf(source);
    // An unnamed end is in no read (one the graph does not hold is named here); an unnamed hop is a
    // hop alone. The owner, at either end, needs no name.
    const ends = [to, from].filter((id): id is string => id !== null && id !== graph.owner);
    if (ends.some((id) => graph.groups.membersOf(id).some((one) => graph.withheld.has(one)))) return null;
    const unheld = ends.filter((id) => !graph.who.has(id));
    const found =
      unheld.length === 0 ? new Map<string, Who>() : await groupWho(tx, unheld, (id) => graph.groups.membersOf(id));
    if (!ends.every((id) => shown(graph.who.get(id) ?? found.get(id)))) return null;
    const owner = graph.owner;
    if (owner === null || from === null || from === to) return { paths: [] };
    const maxHops = secondDegreeRules().maxHops;
    const own = [...graph.ties.values()].filter((row) => row.tier !== "one-way");
    const strength = new Map(own.map((row) => [row.entity_id, tieWeight(row)] as const));
    const relationships: Tie<TieVia>[] = graph.links.flatMap((link) =>
      link.kind === "affiliation"
        ? []
        : [
            {
              a: link.a as EntityId,
              b: link.b as EntityId,
              facts: link.facts,
              ...(link.kind === "relationship" ? {} : { via: link.kind, weight: link.weight }),
              ...(link.offer === undefined ? {} : { offer: link.offer }),
            },
          ],
    );
    const affiliations: Affiliation[] = graph.links
      .filter((link) => link.kind === "affiliation" && link.fact !== null)
      .map((link) => ({ person: link.a as EntityId, organization: link.b as EntityId, facts: link.facts }));
    const observedFor = (ownTies: ReadonlySet<string>, walkHops: number): Promise<ObservedHops> =>
      loadObservedHops(graph.ctx, {
        owner,
        target: to,
        ownTies,
        ties: relationships,
        affiliations,
        walkHops,
        now: context.now(),
        groups: graph.groups,
        audience: graph.audience,
        withheld: graph.withheld,
      });
    let ranked: Path<TieVia>[];
    if (from === owner) {
      const ownTies = new Set(own.map((row) => row.entity_id as EntityId));
      const walked = findPathsWithObserved(
        { owner: owner as EntityId, target: to as EntityId, ownTies, ties: relationships, affiliations, maxHops },
        await observedFor(ownTies, maxHops - 1),
      );
      const order = new Map(own.map((row) => [row.entity_id, tieOrder(row)] as const));
      ranked = rankPathsByWeakestHop(walked.paths, strength, to as EntityId, kind === "organization", order);
    } else {
      // From someone else: the walk starts at a stand-in whose one own tie is the source, the hop
      // dropped after, so the bound counts hops from the source as from the owner. The owner's own
      // ties are ties of their weight; a link of the owner's own is left out, as the walk from the
      // owner leaves it out.
      const ties: Tie<TieVia>[] = [
        ...relationships.filter((tie) => tie.a !== owner && tie.b !== owner),
        ...own.map(
          (row): Tie<TieVia> => ({
            a: owner as EntityId,
            b: row.entity_id as EntityId,
            facts: [],
            weight: strength.get(row.entity_id) as number,
          }),
        ),
      ];
      const ownTies = new Set([from as EntityId]);
      const walked = findPathsWithObserved(
        {
          owner: START as EntityId,
          target: to as EntityId,
          ownTies,
          ties,
          affiliations: affiliations.filter((one) => one.person !== owner),
          maxHops: maxHops + 1,
        },
        await observedFor(ownTies, maxHops),
      );
      ranked = rankPathsByWeakestHop(
        walked.paths.map((path) => ({ ...path, hops: path.hops.slice(1) })),
        new Map(),
        to as EntityId,
        kind === "organization",
      );
    }
    // A hop between the owner and a person of their warmth rows is the owner's own tie, whichever
    // way it runs.
    const ownTie = (a: string, b: string): string | null =>
      a === owner && strength.has(b) ? b : b === owner && strength.has(a) ? a : null;
    const factOf = new Map<string, FactId | null>(
      graph.links
        .filter((link) => link.fact !== null)
        .map((link) => [`${link.kind} ${pairKey(link.a, link.b)}`, link.fact] as const),
    );
    // An observed hop may name someone the graph holds no name for.
    const onPaths = [...new Set(ranked.flatMap((path) => path.hops.flatMap((hop) => [hop.from, hop.to])))];
    const unnamed = onPaths.filter((id) => id !== START && id !== owner && !graph.who.has(id));
    const added = unnamed.length === 0 ? [] : [...(await groupWho(tx, unnamed, (id) => graph.groups.membersOf(id)))];
    const nodeOf = new Map(
      nodesOf(
        { ...graph, who: new Map([...graph.who, ...found, ...added]) },
        onPaths,
        await goalTargets(query, graph),
      ).map((one) => [one.id as string, one]),
    );
    return {
      paths: ranked.map((path) => ({
        nodes: [path.hops[0]?.from ?? from, ...path.hops.map((hop) => hop.to)].map(
          (id) => nodeOf.get(id as string) as NetworkNode,
        ),
        edges: path.hops.map((hop): NetworkEdge => {
          const tied = hop.via === "own_tie" ? hop.to : ownTie(hop.from, hop.to);
          if (tied !== null)
            return { from: hop.from, to: hop.to, kind: "tie", weight: strength.get(tied) ?? OWN_TIE_FLOOR, fact: null };
          const via: NetworkEdge["kind"] = hop.via === "own_tie" ? "relationship" : hop.via;
          return {
            from: hop.from,
            to: hop.to,
            kind: via,
            ...(hop.offer === undefined ? {} : { offer: hop.offer }),
            weight: hop.weight ?? (via === "affiliation" ? AFFILIATION_HOP : RELATIONSHIP_HOP),
            fact: factOf.get(`${via} ${pairKey(hop.from, hop.to)}`) ?? hop.facts[0] ?? null,
          };
        }),
        // A member's one hop to the organization that is the target counts for nothing: as strong as any.
        weakest: Number.isFinite(path.score) ? path.score : RELATIONSHIP_HOP,
      })),
    };
  });
}
