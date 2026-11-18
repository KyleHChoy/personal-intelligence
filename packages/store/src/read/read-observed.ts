import type { EntityId, EventId, MessageId } from "@intelligence/contracts/personal";
import { CONSUMER_DOMAINS } from "@intelligence/personal-core";
import {
  type Affiliation,
  type ObservedVia,
  secondDegreeRules,
  type Tie,
  type TieVia,
} from "@intelligence/personal-core/views";
import { byText, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { inAudience } from "../core/visibility.ts";

// Computed at each read, stored nowhere, with no model. Every row comes from a statement run under
// the caller's own token, whose row policies return only what it may see; the owner's reads run as
// pi_admin, whose policies return everything, so each table of each statement also states their
// audience, and the message's held and restricting flags are stated rather than left to the reader's
// policy. Every count and bound below counts those rows alone, so a row the caller cannot see moves
// no hop, no bound and no `cut`.
//
// The walk runs from the target outwards, a layer of a few people at a time, so a read touches the
// mail of those few people and never every pair in the store.

// More people than this on one thread, as the messages a person shares show it, or at one meeting,
// says nothing of any two of them; nor does a domain holding more than DOMAIN_MAX_PEOPLE people.
export const THREAD_MAX_PEOPLE = 10;
export const MEETING_MAX_PEOPLE = 10;
export const DOMAIN_MAX_PEOPLE = 100;
// The people of one layer read, and the newest messages or meetings a layer reads for them. Past
// either, the answer says `cut`.
export const FRONTIER_MOST = 25;
export const LAYER_ROWS_MOST = 2_000;

const within = (alias: string): string => inAudience(alias, "$4");

// A person the caller can see: the entity policy hides anyone withheld from a client, and `withheld`
// is who the owner's read, whose policies return everyone, states.
const PERSON = (column: string, withheld: string): string => `
  exists (select 1 from knowledge.entities e where e.id = ${column} and e.kind = 'person')
  and not (${column} = any(${withheld}::text[]))`;

// With an address of their own: a role, bulk or shared address is nobody's.
const HAS_ADDRESS = (column: string): string =>
  `exists (select 1 from knowledge.accounts a where a.entity_id = ${column} and a.kind = 'email' and ${within("a")})`;

// The people on the newest `$2` primary messages, neither held, bulk nor restricting, of the people
// `$1`: a row for each label, with the newest message of it, so the read set can name something of every
// label a hop rests on. A thread that names more than `$3` people the caller can see on those messages
// is left out whole. `scanned` is how many of the `$2` were read, in a row of its own when nothing else
// came back.
//
// The bound counts only messages the caller may read, so a held one neither takes a place nor says `cut`.
// A person's interactions are sorted first and the message read for each by a lateral, which keeps that
// order and stops at the bound; each later step is materialized and a thread's size is a window, not a
// join: the planner has no row estimate through these policies, and a nested loop over a grouped thread
// list took over a minute at the reference size.
const THREAD_PEERS = `
  with mine as materialized (
    select i.seed, m.id, m.evidence_id, m.sent_at, m.compartments as label, coalesce(m.thread_fp, m.id) as thread
    from (
      select x.entity_id as seed, x.evidence_id, x.occurred_at
      from knowledge.interaction_log x
      where x.entity_id = any($1::text[]) and x.channel = 'email' and x.occurred_at <= $5 and ${within("x")}
      order by x.occurred_at desc, x.evidence_id, x.entity_id
      offset 0
    ) i
    cross join lateral (
      select y.id, y.evidence_id, y.sent_at, y.compartments, y.thread_fp from knowledge.messages y
      where y.evidence_id = i.evidence_id
        and not y.held and not y.bulk and not y.restricting and y.category = 'primary' and ${within("y")}
    ) m
    limit $2
  ),
  peers as materialized (
    select distinct mine.seed, mine.thread, mine.id, mine.evidence_id, mine.sent_at, mine.label, i.entity_id as peer
    from mine
    join knowledge.interaction_log i on i.evidence_id = mine.evidence_id
    where i.entity_id <> mine.seed and ${within("i")} and ${PERSON("i.entity_id", "$6")}
  ),
  sized as (
    select p.*, dense_rank() over (partition by p.seed, p.thread order by p.peer)
        + dense_rank() over (partition by p.seed, p.thread order by p.peer desc) - 1 as others
    from peers p
  ),
  shared as materialized (
    select z.seed, z.peer, z.label, count(distinct z.id)::int as seen, max(z.sent_at) as last_at,
      (array_agg(z.id order by z.sent_at desc, z.id))[1] as ref,
      (array_agg(z.evidence_id order by z.sent_at desc, z.id))[1] as evidence_id
    from sized z
    where z.others + 1 <= $3
    group by z.seed, z.peer, z.label
  )
  select (select count(*) from mine)::int as scanned, s.seed, s.peer, s.seen, s.last_at, s.ref, s.evidence_id
  from (select 1) as one
  left join shared s on ${HAS_ADDRESS("s.peer")}
  order by s.seed, s.peer`;

// The people at the newest `$2` meetings of the people `$1`: started, not cancelled, and with at most
// `$3` people the caller can see. Whatever the owner answered: everyone at a meeting they kept is their
// own tie already, so the meetings that add a route are those they declined or did not answer, which
// still show who else was asked.
const MEETING_PEERS = `
  with mine as materialized (
    select p.entity_id as seed, v.id, v.evidence_id, v.compartments as label, d.starts_at
    from knowledge.event_participants p
    join knowledge.events v on v.id = p.event_id
    join knowledge.event_details d on d.event_id = v.id
    where p.entity_id = any($1::text[]) and not d.cancelled and d.starts_at <= $5
      and ${within("p")} and ${within("v")} and ${within("d")}
    order by d.starts_at desc, v.id, p.entity_id
    limit $2
  ),
  present as materialized (
    select distinct x.event_id, x.entity_id from knowledge.event_participants x
    where x.event_id in (select mine.id from mine) and ${within("x")} and ${PERSON("x.entity_id", "$6")}
  ),
  narrow as materialized (
    select x.event_id from present x
    group by x.event_id
    having count(*) <= $3
  ),
  shared as materialized (
    select mine.seed, x.entity_id as peer, mine.label, count(distinct mine.id)::int as seen, max(mine.starts_at) as last_at,
      (array_agg(mine.id order by mine.starts_at desc, mine.id))[1] as ref,
      (array_agg(mine.evidence_id order by mine.starts_at desc, mine.id))[1] as evidence_id
    from mine
    join narrow n on n.event_id = mine.id
    join present x on x.event_id = mine.id and x.entity_id <> mine.seed
    group by mine.seed, x.entity_id, mine.label
  )
  select (select count(*) from mine)::int as scanned, s.seed, s.peer, s.seen, s.last_at, s.ref, s.evidence_id
  from (select 1) as one
  left join shared s on ${HAS_ADDRESS("s.peer")}
  order by s.seed, s.peer`;

// The people on each organization's domain, for the organizations `$1` are or hold an address at: never
// a domain in `$3`, never one holding more than `$2` people the caller can see, each address a person's
// own and under the label of the domain's row. Such a hop says something of a third party under that
// label, so a person comes with their newest message under it, which the read set binds, or not at all.
const DOMAIN_PEOPLE = `
  with hubs as materialized (
    select distinct d.entity_id as organization, d.domain_fp, d.compartments as label
    from knowledge.domains d
    join knowledge.entities o on o.id = d.entity_id and o.kind = 'organization'
    where d.domain_fp <> all($3::text[]) and ${within("d")}
      and (d.entity_id = any($1::text[]) or d.domain_fp in (
        select a.domain_fp from knowledge.accounts a
        where a.entity_id = any($1::text[]) and a.kind = 'email' and ${within("a")}))
  ),
  people as materialized (
    select distinct h.organization, h.label, a.entity_id as person
    from hubs h
    join knowledge.accounts a on a.domain_fp = h.domain_fp and a.compartments = h.label and a.kind = 'email' and ${within("a")}
    where ${PERSON("a.entity_id", "$5")}
  ),
  narrow as materialized (
    select p.organization from people p
    group by p.organization
    having count(distinct p.person) <= $2
  )
  select p.organization, p.person, ev.evidence_id
  from people p
  join narrow n on n.organization = p.organization
  cross join lateral (
    select i.evidence_id
    from knowledge.interaction_log i
    join knowledge.messages m on m.evidence_id = i.evidence_id
    where i.entity_id = p.person and i.compartments = p.label and i.occurred_at <= $6
      and m.compartments = p.label and not m.held and not m.restricting
    order by i.occurred_at desc, i.evidence_id
    limit 1
  ) ev
  order by p.organization, p.person, ev.evidence_id`;

// Named for the measurement of their plans at the reference size.
export const OBSERVED_STATEMENTS = { THREAD_PEERS, MEETING_PEERS, DOMAIN_PEOPLE } as const;

type PeerRow = {
  scanned: number;
  seed: string | null;
  peer: string | null;
  seen: number;
  last_at: Date;
  ref: MessageId | EventId;
  evidence_id: string;
};

type ObservedInput = {
  owner: string;
  target: string;
  ownTies: ReadonlySet<string>;
  // The stated hops the walk has already: a layer follows them too, so a route may mix the two.
  ties: readonly Tie<TieVia>[];
  affiliations: readonly Affiliation[];
  walkHops: number;
  now: Date;
  groups: { idOf(id: string): string; membersOf(id: string): string[] };
  // The owner's reads: their audience and who is withheld from them. A client's call passes neither,
  // and its token's policies hold.
  audience?: readonly string[];
  withheld?: ReadonlySet<string>;
};

export type ObservedHops = {
  ties: Tie<TieVia>[];
  domains: Affiliation[];
  // An evidence id of each label a thread or meeting hop rests on, by the hop's kind and two people,
  // and of each label a person is at an organization by: the read log records them as shown (observedEvidence).
  evidenceOf: Map<string, readonly string[]>;
  domainEvidence: Map<string, Map<string, Set<string>>>;
  cut: boolean;
};

const noObserved = (): ObservedHops => ({
  ties: [],
  domains: [],
  evidenceOf: new Map(),
  domainEvidence: new Map(),
  cut: false,
});
export const NO_OBSERVED: ObservedHops = Object.freeze(noObserved());

const tieKey = (via: string, a: string, b: string): string => `${via}\n${a < b ? `${a}\n${b}` : `${b}\n${a}`}`;

// What one hop of a path rests on, for the read log: one message can be the newest of many hops, so a
// hop is looked up by its kind and its two ends. A domain's hop binds both people at each organization
// they share, or the one at the organization that is the target.
export function observedEvidence(
  observed: ObservedHops,
  hop: { via: string; from: string; to: string },
): readonly string[] {
  if (hop.via !== "same_domain") return observed.evidenceOf.get(tieKey(hop.via, hop.from, hop.to)) ?? [];
  const mine = observed.domainEvidence.get(hop.from);
  const theirs = observed.domainEvidence.get(hop.to);
  const direct = mine?.get(hop.to);
  if (direct !== undefined) return [...direct];
  return [...(mine ?? [])].flatMap(([organization, evidence]) => {
    const other = theirs?.get(organization);
    return other === undefined ? [] : [...evidence, ...other];
  });
}

export async function loadObservedHops(ctx: Ctx, input: ObservedInput): Promise<ObservedHops> {
  const { groups, owner, ownTies } = input;
  const weights = secondDegreeRules().observedWeight;
  const audience = input.audience === undefined ? null : [...input.audience];
  const withheld = [...(input.withheld ?? [])];
  const hidden = (id: string): boolean =>
    id === owner || groups.membersOf(id).some((one) => input.withheld?.has(one) === true);
  const free = CONSUMER_DOMAINS.map((domain) => fingerprint(ctx.keys, "domain", domain));

  const near = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    near.set(a, (near.get(a) ?? new Set()).add(b));
    near.set(b, (near.get(b) ?? new Set()).add(a));
  };
  for (const tie of input.ties) link(tie.a, tie.b);
  const orgsOf = new Map<string, Set<string>>();
  const membersOf = new Map<string, Set<string>>();
  const atOrganization = (person: string, organization: string): void => {
    orgsOf.set(person, (orgsOf.get(person) ?? new Set()).add(organization));
    membersOf.set(organization, (membersOf.get(organization) ?? new Set()).add(person));
  };
  for (const one of input.affiliations) atOrganization(one.person, one.organization);

  const found = new Map<string, Tie<TieVia>>();
  const domains = new Map<string, Affiliation>();
  const domainEvidence = new Map<string, Map<string, Set<string>>>();
  const labelsOf = new Map<string, { evidence: Set<string>; bySeed: Map<string, number> }>();
  let cut = false;

  const add = (via: ObservedVia, rows: readonly PeerRow[]): void => {
    if ((rows[0]?.scanned ?? 0) >= LAYER_ROWS_MOST) cut = true;
    for (const row of rows) {
      if (row.seed === null || row.peer === null) continue;
      const a = groups.idOf(row.seed);
      const b = groups.idOf(row.peer);
      if (a === b || hidden(a) || hidden(b)) continue;
      const key = tieKey(via, a, b);
      const held = found.get(key);
      const basis = labelsOf.get(key) ?? { evidence: new Set(), bySeed: new Map() };
      basis.evidence.add(row.evidence_id);
      // A row for each label from each end: the same messages seen from both ends count once.
      basis.bySeed.set(row.seed, (basis.bySeed.get(row.seed) ?? 0) + row.seen);
      labelsOf.set(key, basis);
      const lastAt = stamp(row.last_at);
      const newer = held?.seen?.lastAt == null || lastAt > held.seen.lastAt;
      found.set(key, {
        a: a as EntityId,
        b: b as EntityId,
        facts: [],
        via,
        weight: weights[via],
        seen: {
          count: Math.max(...basis.bySeed.values()),
          lastAt: newer ? lastAt : (held?.seen?.lastAt ?? null),
          ref: newer ? row.ref : (held?.seen?.ref ?? null),
        },
      });
      link(a, b);
    }
  };

  // The owner reaches no one here: everyone they have mail with shares it with them.
  if (hidden(input.target)) return noObserved();
  const seen = new Set<string>([input.target]);
  let frontier = [input.target];
  for (let depth = 0; depth < input.walkHops; depth++) {
    // A route ends at the first person the owner has a tie with.
    const open = frontier.filter((id) => !ownTies.has(id)).sort(byText);
    if (open.length === 0) break;
    if (open.length > FRONTIER_MOST) cut = true;
    const seeds = open.slice(0, FRONTIER_MOST);
    const members = [...new Set(seeds.flatMap((id) => [id, ...groups.membersOf(id)]))];
    const at = input.now.toISOString();
    add(
      "shared_thread",
      await ctx.run<PeerRow>(THREAD_PEERS, [members, LAYER_ROWS_MOST, THREAD_MAX_PEOPLE, audience, at, withheld]),
    );
    add(
      "met_together",
      await ctx.run<PeerRow>(MEETING_PEERS, [members, LAYER_ROWS_MOST, MEETING_MAX_PEOPLE, audience, at, withheld]),
    );
    // A seed's stated organizations too: their domains may hold someone no one stated is there.
    const stated = seeds.flatMap((id) => [...(orgsOf.get(id) ?? [])]);
    for (const row of await ctx.run<{ organization: string; person: string; evidence_id: string }>(DOMAIN_PEOPLE, [
      [...new Set([...members, ...stated])],
      DOMAIN_MAX_PEOPLE,
      free,
      audience,
      withheld,
      at,
    ])) {
      const person = groups.idOf(row.person);
      if (hidden(row.organization) || hidden(person)) continue;
      atOrganization(person, row.organization);
      domains.set(`${person}\n${row.organization}`, {
        person: person as EntityId,
        organization: row.organization as EntityId,
        facts: [],
        via: "same_domain",
        weight: weights.same_domain,
      });
      const held = domainEvidence.get(person) ?? new Map<string, Set<string>>();
      held.set(row.organization, (held.get(row.organization) ?? new Set()).add(row.evidence_id));
      domainEvidence.set(person, held);
    }
    const next = new Set<string>();
    for (const id of seeds) {
      for (const other of near.get(id) ?? []) next.add(other);
      for (const other of membersOf.get(id) ?? []) next.add(other);
      for (const organization of orgsOf.get(id) ?? [])
        for (const other of membersOf.get(organization) ?? []) next.add(other);
    }
    frontier = [...next].filter((id) => !seen.has(id) && !hidden(id));
    for (const id of frontier) seen.add(id);
  }
  const evidenceOf = new Map<string, readonly string[]>();
  for (const key of found.keys()) evidenceOf.set(key, [...(labelsOf.get(key)?.evidence ?? [])]);
  return { ties: [...found.values()], domains: [...domains.values()], evidenceOf, domainEvidence, cut };
}
