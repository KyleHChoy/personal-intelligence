// The owner's network graph: the one loader the map and paths share, over the owner's warmth rows,
// affiliations and the hops find_paths walks, built at each read.

import type { EntityId, FactId, IntroOffer, NetworkEdgeKind, ObservedTie, Who } from "@intelligence/contracts/personal";
import { AFFILIATION_HOP, RELATIONSHIP_HOP } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { byText } from "../../core/db.ts";
import { OWNER_ENTITY_FIRST, PERSON_OR_ORG_KINDS } from "../../core/statements.ts";
import type { Tx } from "../../core/tx.ts";
import type { ClientGroups, Ctx } from "../../read/read-ctx.ts";
import { loadPathHops } from "../../read/read-paths.ts";
import type { WarmthRow } from "../../read/read-warmth.ts";
import { ownerBeliefs, ownerWho, ownerWithheld } from "../admin-owner.ts";
import { ownerCtx } from "../owner-ctx.ts";
import { audiences, CLAIM_ORGANIZATIONS, CLAIMS, groupsIn } from "./admin-people.ts";
import { ownerWarmthRows } from "./admin-warmth.ts";

// The fact keys of the relationship and affiliation claims within the owner's audience: the beliefs
// the graph rests on, so no other belief is opened.
const LINK_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type in ('relationship', 'affiliation') and c.compartments <@ $1::text[]
  order by c.fact_key_fp`;

// The organizations on the domain of an account of the people given, within the owner's audience:
// get_entity's ORGANIZATIONS_OF, the people an organization holds by its domains.
const DOMAIN_ORGANIZATIONS = `
  select distinct a.entity_id as person, d.entity_id as organization from knowledge.accounts a
  join knowledge.domains d on d.domain_fp = a.domain_fp and d.compartments <@ $2::text[]
  join knowledge.entities e on e.id = d.entity_id and e.kind = 'organization'
  where a.entity_id = any ($1::text[]) and a.compartments <@ $2::text[]
  order by 1, 2`;

// A link rests on the claims it cites; an affiliation by an address's domain cites none (`fact`
// null), and only the map draws it: paths walk the claims' links alone here, and read the address's
// domain as a weak observed hop (read-observed.ts), as find_paths does. Every other kind is a hop
// of the one loader, with its weight, and an offer to introduce with its offer.
export type LinkKind = Exclude<NetworkEdgeKind, "tie" | ObservedTie>;
export type Link = {
  kind: LinkKind;
  a: string;
  b: string;
  facts: FactId[];
  fact: FactId | null;
  weight: number;
  offer?: IntroOffer;
};

export type Graph = {
  owner: string | null;
  // The owner's audience the graph was read under, and the hop loader's Ctx on this transaction.
  audience: readonly string[];
  ctx: Ctx;
  groups: ClientGroups;
  // The warmth rows neither withheld nor unnamed, by group id: the people the owner has a tie with,
  // as the map shows them.
  rows: Map<string, WarmthRow>;
  // Every warmth row not withheld, named or not: the owner's own ties, as paths walk them.
  ties: Map<string, WarmthRow>;
  withheld: ReadonlySet<string>;
  kinds: Map<string, "person" | "organization">;
  // Every link, the strongest first (`byStrength`), and each node's, in that order.
  links: Link[];
  linksOf: Map<string, Link[]>;
  // Whether the loader's bound left hops out (loadPathHops' `cut`).
  cut: boolean;
  // Every group and organization the rows and links name, named once (a person by any member's
  // alias). An id with no name here is unnamed: never a map node or a list row, only a hop of a
  // path. A named person or organization is `nameOnly` here.
  who: Map<string, Who>;
};

// A cold build on the deployed box stays under about 300 ms, and a kept graph was rarely reused, since a
// sync's writes moved its key between almost any two reads. Read by `pi web`'s Admin for the owner's reads
// alone: an agent's find_paths never reads it.
export async function graphOf(context: AdminContext, tx: Tx): Promise<Graph> {
  const audience = await audiences(tx.query);
  return loadGraph(context, tx, audience, context.now());
}

// The Who of each group id and organization: a person by their own id's name and address, else a
// member's (the first by id that has one), so a person whose alias another member holds is named.
// A group is `nameOnly` when every member named is (read-tools.ts groupWho's rule).
export async function groupWho(
  tx: Tx,
  ids: readonly string[],
  membersOf: (id: string) => readonly string[],
): Promise<Map<string, Who>> {
  const who = await ownerWho(tx, [...new Set(ids.flatMap((id) => [id, ...membersOf(id)]))]);
  const out = new Map<string, Who>();
  for (const id of ids) {
    const own = who.get(id);
    if (own === undefined) continue;
    const others =
      own.kind === "person"
        ? [...membersOf(id)]
            .filter((one) => one !== id)
            .sort(byText)
            .flatMap((one) => who.get(one) ?? [])
        : [];
    const { nameOnly: _own, ...rest } = own;
    const nameOnly = own.nameOnly === true && others.every((one) => one.nameOnly === true);
    out.set(id, {
      ...rest,
      name: own.name ?? others.find((one) => one.name !== null)?.name ?? null,
      address: own.address ?? others.find((one) => one.address !== null)?.address ?? null,
      ...(nameOnly ? { nameOnly: true as const } : {}),
    });
  }
  return out;
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

// The order links are taken in, the strongest first: by weight, then first-hand before second-hand,
// then by pair, a claim's link before an address's, so equal links always pick the same.
const KIND_ORDER: readonly LinkKind[] = [
  "relationship",
  "acquaintance",
  "connection",
  "intro_offer",
  "affiliation",
  "researched",
  "reported",
];
export const byStrength = (x: Link, y: Link): number =>
  y.weight - x.weight ||
  KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
  byText(pairKey(x.a, x.b), pairKey(y.a, y.b)) ||
  Number(x.fact === null) - Number(y.fact === null) ||
  byText(x.fact ?? "", y.fact ?? "");

// The claims given, newest first: which one a link's click opens.
const NEWEST = `select c.id from knowledge.claims c where c.id = any ($1::text[]) order by c.valid_from desc, c.id collate "C" desc`;

// The entities the claims given name, so a hop resting on a claim that names someone withheld is
// dropped, as NAMES_SHOWN drops it for a client whose token hides them.
const NAMED_BY =
  "select n.claim_id, n.entity_id from knowledge.claim_entities n where n.claim_id = any ($1::text[]) order by n.claim_id, n.entity_id";

// Ties between people are the hops of read-paths.ts' loadPathHops, run here under the owner's
// audience on their beliefs (its OwnerScope), so the map and paths walk what find_paths walks:
// relationships and acquaintances, offers to introduce, confirmed connections, and reports and
// research (second-hand, at their weight). Affiliations are the map's own: a belief's organization,
// or the one its claims name (claim_entities, as get_entity reads them, or a named organization's
// name rows, through the loader), and an address's domain.
async function loadGraph(
  context: AdminContext,
  tx: Tx,
  audience: { beliefs: string[]; warmth: string[] },
  now: Date,
): Promise<Graph> {
  const { query } = tx;
  const [owner] = await query<{ id: string }>(OWNER_ENTITY_FIRST);
  const groups = await groupsIn(query, audience.warmth);
  const withheld = await ownerWithheld(query);
  const held = (members: readonly string[]): boolean => members.some((one) => withheld.has(one));
  const rows = new Map<string, WarmthRow>();
  for (const row of await ownerWarmthRows(tx, now)) if (!held(row.members)) rows.set(row.entity_id, row);

  // Current affiliations, none disputed, each citing only the claims the reader's filters keep.
  const keys = (await query<{ fact_key_fp: string }>(LINK_KEYS, [audience.beliefs])).map((row) => row.fact_key_fp);
  const beliefs = await ownerBeliefs(tx, keys);
  const current = beliefs.flatMap((one) => {
    const { belief } = one;
    if (belief.kind !== "affiliation" || (belief.status !== "active" && belief.status !== "stale") || belief.disputed)
      return [];
    const other = belief.values.organization;
    // An affiliation that names its organization by name only finds it by its claims, below.
    return [
      { subject: belief.subject as string, other: typeof other === "string" ? other : null, support: one.support },
    ];
  });
  const order = (
    await query<{ id: FactId }>(CLAIMS, [[...new Set(current.flatMap((one) => one.support))], audience.beliefs])
  ).map((row) => row.id);
  const place = new Map(order.map((id, index) => [id, index]));
  const byName = current
    .filter((one) => one.other === null)
    .flatMap((one) => one.support.filter((id) => place.has(id as FactId)));
  // A claim that names one organization only: one naming several does not say which it is about.
  const named = new Map<string, string[]>();
  for (const row of byName.length === 0
    ? []
    : await query<{ claim_id: string; entity_id: string }>(CLAIM_ORGANIZATIONS, [byName])) {
    named.set(row.claim_id, [...(named.get(row.claim_id) ?? []), row.entity_id]);
  }
  const claimOrganization = new Map(
    [...named].flatMap(([claim, ids]) => (ids.length === 1 ? [[claim, ids[0] as string] as const] : [])),
  );
  const kinds = new Map(
    (
      await query<{ id: string; kind: "person" | "organization" }>(PERSON_OR_ORG_KINDS, [
        [...new Set(current.flatMap((one) => [one.subject, ...(one.other === null ? [] : [one.other])]))],
      ])
    ).map((row) => [row.id, row.kind]),
  );
  for (const id of claimOrganization.values()) kinds.set(id, "organization");

  const links: Link[] = [];
  const affiliated = new Set<string>();
  for (const one of current) {
    const cited = one.support
      .filter((id): id is FactId => place.has(id as FactId))
      .sort((x, y) => (place.get(x) as number) - (place.get(y) as number));
    const latest = cited[0];
    const other = one.other ?? cited.map((id) => claimOrganization.get(id)).find((id) => id !== undefined);
    if (
      latest === undefined ||
      other === undefined ||
      kinds.get(one.subject) !== "person" ||
      kinds.get(other) !== "organization" ||
      withheld.has(one.subject) ||
      withheld.has(other)
    )
      continue;
    const a = groups.idOf(one.subject);
    if (held(groups.membersOf(a))) continue;
    affiliated.add(pairKey(a, other));
    links.push({
      kind: "affiliation",
      a,
      b: other,
      facts: [...cited].sort(byText),
      fact: latest,
      weight: AFFILIATION_HOP,
    });
  }

  // The loader's hops, as pi_admin under the owner's audience: the owner read's Ctx runs its
  // statements on this transaction, which states the owner's audience (OwnerScope) where
  // pi_reader's policies would hold.
  const ctx = ownerCtx(query, tx.keys, context.log);
  const hops = await loadPathHops(ctx, (id) => groups.idOf(id) as EntityId, now, {
    audience: audience.beliefs,
    beliefs: {
      rows: beliefs.map((one) => ({ fact_key_fp: one.factKey, support: one.support })),
      beliefs: beliefs.map((one) => one.belief),
      ceiling: false,
    },
  });
  const cited = [
    ...new Set([...hops.ties.flatMap((tie) => tie.facts), ...hops.affiliations.flatMap((one) => one.facts)]),
  ];
  const newest = new Map((await query<{ id: FactId }>(NEWEST, [cited])).map((row, index) => [row.id, index]));
  const latestOf = (facts: readonly FactId[]): FactId | null =>
    [...facts].sort((x, y) => (newest.get(x) ?? Infinity) - (newest.get(y) ?? Infinity) || byText(x, y))[0] ?? null;
  const naming = new Set(
    (await query<{ claim_id: string; entity_id: string }>(NAMED_BY, [cited])).flatMap((row) =>
      withheld.has(row.entity_id) ? [row.claim_id] : [],
    ),
  );
  const shownFacts = (facts: readonly FactId[]): FactId[] => facts.filter((fact) => !naming.has(fact));
  for (const hop of hops.ties) {
    const tie = { ...hop, facts: shownFacts(hop.facts) };
    if (tie.facts.length === 0 || tie.a === tie.b || held(groups.membersOf(tie.a)) || held(groups.membersOf(tie.b)))
      continue;
    kinds.set(tie.a, "person");
    kinds.set(tie.b, "person");
    links.push({
      kind: tie.via ?? "relationship",
      a: tie.a,
      b: tie.b,
      facts: [...tie.facts].sort(byText),
      fact: latestOf(tie.facts),
      weight: tie.weight ?? RELATIONSHIP_HOP,
      ...(tie.offer === undefined ? {} : { offer: tie.offer }),
    });
  }
  // A named organization, resolved by its name rows, where no belief or claim_entities already
  // linked the pair.
  for (const hop of hops.affiliations) {
    const one = { ...hop, facts: shownFacts(hop.facts) };
    if (
      one.facts.length === 0 ||
      affiliated.has(pairKey(one.person, one.organization)) ||
      withheld.has(one.organization) ||
      held(groups.membersOf(one.person))
    )
      continue;
    affiliated.add(pairKey(one.person, one.organization));
    kinds.set(one.organization, "organization");
    links.push({
      kind: "affiliation",
      a: one.person,
      b: one.organization,
      facts: [...one.facts].sort(byText),
      fact: latestOf(one.facts),
      weight: AFFILIATION_HOP,
    });
  }
  // Each person of the owner's warmth rows with an address on an organization's domain: an
  // affiliation that cites no claim.
  const members = [...rows.values()].flatMap((row) => row.members);
  const byDomain = new Set<string>();
  for (const row of members.length === 0
    ? []
    : await query<{ person: string; organization: string }>(DOMAIN_ORGANIZATIONS, [members, audience.beliefs])) {
    const a = groups.idOf(row.person);
    if (withheld.has(row.organization) || byDomain.has(pairKey(a, row.organization))) continue;
    byDomain.add(pairKey(a, row.organization));
    kinds.set(row.organization, "organization");
    links.push({ kind: "affiliation", a, b: row.organization, facts: [], fact: null, weight: AFFILIATION_HOP });
  }
  links.sort(byStrength);
  const linksOf = new Map<string, Link[]>();
  for (const link of links) {
    for (const end of [link.a, link.b]) {
      const list = linksOf.get(end);
      if (list === undefined) linksOf.set(end, [link]);
      else list.push(link);
    }
  }
  // Named once: an unnamed person keeps no row (no list, no map node) but stays a hop of a path.
  const who = await groupWho(tx, [...new Set([...rows.keys(), ...links.flatMap((link) => [link.a, link.b])])], (id) =>
    groups.membersOf(id),
  );
  const ties = new Map(rows);
  for (const id of [...rows.keys()]) if (who.get(id)?.name == null) rows.delete(id);
  return {
    owner: owner?.id ?? null,
    audience: audience.beliefs,
    ctx,
    groups,
    rows,
    ties,
    withheld,
    kinds,
    links,
    linksOf,
    cut: hops.cut,
    who,
  };
}
// What a map node or a list row may be: an organization, or a person with a name. An organization
// known by its domain alone stays (the map says it is one); an unnamed person never shows.
export const shown = (who: Who | undefined): boolean =>
  who !== undefined && (who.kind === "organization" || who.name !== null);
export const named = (graph: Graph, id: string): boolean => shown(graph.who.get(id));
