import type { Belief } from "@intelligence/contracts";
import {
  ClaimRecord,
  CONNECTION_TYPE,
  type EntityId,
  type FactId,
  FindPathsArgs,
  IntroOffer,
  OPEN_BELIEF_STATUS,
  type PathList,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  type Affiliation,
  distinctRoutes,
  findPathsWithObserved,
  hopWeight,
  MAX_LINKS,
  MAX_PATHS,
  RANKED_PATHS,
  rankPathsByWeakestHop,
  type StatedVia,
  secondDegreeRules,
  type Tie,
} from "@intelligence/personal-core/views";
import { orgNameFp } from "../core/org-names.ts";
import type { Found } from "../core/read-ctx.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import type { SealedRow } from "../core/seal.ts";
import { type AccountRow, served, servedJson } from "../core/served.ts";
import {
  inAudience,
  NAMES_SHOWN,
  namesShown,
  PEOPLE_OR_ORGS,
  PERSON_OR_ORG,
  RELEASE_IN_FORCE,
  sourceJoins,
  sourceShown,
} from "../core/visibility.ts";
import { audienceBeliefs } from "./read-beliefs.ts";
import { OWNER as OWNER_ACCOUNT } from "./read-fact-rows.ts";
import { loadGroups } from "./read-groups.ts";
import { namedOrgState, withheldNamed } from "./read-named.ts";
import { loadObservedHops, NO_OBSERVED, observedEvidence } from "./read-observed.ts";
import { organizationNames } from "./read-organizations.ts";
import { pathWeight, warmthOf, warmthOrder } from "./read-warmth.ts";
import { whoOf } from "./read-who.ts";

// find_paths' work: routes from the owner to one
// person, computed by code from rows the caller's token returns and nothing else. The owner's own
// ties come from the visible interaction rows, meetings and saved contacts; ties from the
// current relationship beliefs of the caller's audience, bridges from its current affiliation
// beliefs, each read in pages as get_commitments reads them; the walk is core's findPaths. The
// statements sent depend only on how many pages the audience fills, so a row the caller cannot
// see changes no path, score, order or `cut`. People are walked as the groups the token's rulings
// make. An own-tie hop weighs by the person's tier in the caller's
// audience, and paths of one score and length are ordered by tier, then warmth. A target may be an
// organization, reached through anyone at it; own ties are every person the owner has a tie with
// in any source, not only the last year's; and paths rank by their weakest hop (core's
// rankPathsByWeakestHop). Observed hops (read-observed.ts) join the walk here, never the loader: the
// packs' second degree reads the loader, and only what someone stated.

// The people the owner has a tie with by `$1`: mail both ways (the owner wrote to them and they wrote
// to the owner, each in a message the token returns, so never a held one, or one read by its headers
// alone, which has no message and can be held by nothing), at any time; a meeting that had
// started, was not cancelled, and that the owner did not decline or leave unanswered, at any time; or a
// saved contact, the imported ones (the CRM) included. A person the owner confirmed from an
// agent's proposal is a contact of that agent's people source (a `crm` source), so is here; the
// tier weighs the hop and orders paths, below. The packs' second degree reads the same.
//
// Who the owner wrote to comes first, from the outbound index, since a person's inbound rows are the
// many; each of them is then tested by one row each way, and the entity's policy runs once for each
// tie, never for each row of the log. This read took three seconds at the reference size, over every
// row of the log, and find_paths has one and a half.
const MAIL_RETURNED = (log: string): string =>
  `(${log}.channel = 'mail_headers' or exists (select 1 from knowledge.messages m where m.evidence_id = ${log}.evidence_id))`;
export const OWN_TIES = `
  with wrote as materialized (
    select distinct w.entity_id from knowledge.interaction_log w
    where w.direction = 'outbound' and w.occurred_at <= $1
  )
  select t.entity_id from (
    select w.entity_id
    from wrote w
    where exists (
        select 1 from knowledge.interaction_log o
        where o.entity_id = w.entity_id and o.direction = 'outbound' and o.occurred_at <= $1 and ${MAIL_RETURNED("o")})
      and exists (
        select 1 from knowledge.interaction_log i
        where i.entity_id = w.entity_id and i.direction = 'inbound' and i.entity_role = 'sender' and i.occurred_at <= $1 and ${MAIL_RETURNED("i")})
    union
    select p.entity_id
    from knowledge.event_participants p
    join knowledge.events v on v.id = p.event_id
    join knowledge.event_details d on d.event_id = v.id
    where not d.cancelled and d.starts_at <= $1
      and coalesce(d.owner_response, 'accepted') in ('accepted', 'tentative')
    union
    select a.entity_id
    from knowledge.contact_addresses a
  ) t
  join knowledge.entities e on e.id = t.entity_id and e.kind = 'person'
  order by t.entity_id`;

// The beliefs' supporting claims a hop may cite: those find_facts would return (read-facts.ts,
// FIND), with a message or a document that is not held, a finding's record the token returns, or
// one of the owner's own saved contacts, and naming no person or
// organization the token does not show. A released claim counts
// only while its release is in force.
const CLAIMS = `
  select c.id
  from knowledge.claims c
  ${sourceJoins(["message", "document"])}
  where c.id = any($1)
    and ${RELEASE_IN_FORCE}
    and ${sourceShown(["message", "document"], ["record", "contact"])}
    and ${namesShown(["person", "organization"])}
    and ${inAudience("c", "$2")}
  order by c.id, m.id, d.id`;

// The named organization each of `$1`'s claims names by name, through its
// name row and the organization's name rows under the claim's label, both as the token shows them.
const CLAIM_ORGS = `
  select distinct x.claim_id, o.entity_id
  from knowledge.claim_org_names x
  join knowledge.org_names o on o.name_fp = x.name_fp and o.compartments @> x.compartments and o.compartments <@ x.compartments
  where x.claim_id = any($1::text[])
  order by x.claim_id, o.entity_id`;

// The relation claims a hop may rest on without a belief, newest first, at
// most `$4`: an `intro_offer` (a third person's offer builds no belief), and a `relationship` whose
// speaker is neither side (a report, which builds none either), each in force, of the last
// `introOfferDays`, read like CLAIMS: of a message or a document that is not held, or a finding's
// record the token returns, with a release in force, naming no person or organization the token
// does not show. A meeting's claim counts once its meeting is linked to an event; a chat's, never
// linked, does not: a heard claim makes no hop.
const RELATION_CLAIMS = `
  select c.id, c.compartments, c.content_enc, c.fact_key_fp
  from knowledge.claims c
  ${sourceJoins(["message", "document", "linkedCapture"])}
  where c.type = any($1::text[]) and c.valid_from >= $2 and (c.valid_to is null or c.valid_to > $3)
    and ${RELEASE_IN_FORCE}
    -- An agent record's claim (a research fill's included, SD-R27) only while its
    -- record is one the token returns and not flagged: a quarantined fill's edges are not walked.
    and ${sourceShown(["message", "document", "linkedCapture"], ["record"])}
    and ${NAMES_SHOWN}
    and ${inAudience("c", "$5")}
  order by c.valid_from desc, c.id, m.id, d.id, k.id
  limit $4`;

// Each confirmed connection, a released claim whose release is in force
// (read-ties.ts' rule), naming no one the token does not show; by id, at most `$2`.
const CONNECTIONS = `
  select c.id, c.compartments, c.content_enc, c.fact_key_fp
  from knowledge.claims c
  where c.type = $1 and c.released
    and c.evidence_id in (select r.evidence_id from policy.released_records() r)
    and ${NAMES_SHOWN}
    and ${inAudience("c", "$3")}
  order by c.id
  limit $2`;

// The hops one walk may take, as the caller's token shows them: every tie between two people and
// every affiliation, the fact key of each fact a hop cites, and whether a bound left any out.
// `relationOf` is the relation each relationship, acquaintance or reported hop's facts state, for
// the packs' second-degree lines.
type PathHops = {
  ties: Tie<StatedVia>[];
  affiliations: Affiliation[];
  factKeyOf: Map<FactId, string>;
  relationOf: Map<FactId, string>;
  cut: boolean;
};

type ClaimRow = SealedRow<"knowledge.claims.content_enc"> & { fact_key_fp: string };
type Opened = { row: ClaimRow; record: ClaimRecord };

// The beliefs a walk stands on: each with its fact key and its supporting claims' stored ids.
type HopBeliefs = {
  rows: readonly { fact_key_fp: string; support: string[] }[];
  beliefs: readonly Belief[];
  ceiling: boolean;
};

// The owner's reads run the loader as pi_admin, whose row
// policies return every row: they pass the owner's audience, which the claim statements then state, and their
// beliefs, read by `ownerBeliefs`. A client's call passes neither, and its token's policies hold.
// pi_admin's policies hide no withheld person: the owner's read drops each hop whose claim names
// one itself (admin-people-graph.ts), as NAMES_SHOWN drops it for a client.
export type OwnerScope = { audience: readonly string[]; beliefs: HopBeliefs };

// The hop an open, undisputed belief makes, before a name-only organization resolves (`other`
// null), or null when it makes none.
type BeliefHop = {
  via: StatedVia | "affiliation";
  subject: string;
  other: string | null;
  fact: string;
  support: string[];
  relation: string | undefined;
  role: boolean;
};
function beliefHop(belief: Belief, row: HopBeliefs["rows"][number]): BeliefHop | null {
  if (!OPEN_BELIEF_STATUS.has(belief.status) || belief.disputed) return null;
  // A role at an organization says as much as an affiliation with it; it counts where no affiliation does.
  const atAnOrganization = belief.kind === "affiliation" || belief.kind === "role";
  const other =
    belief.kind === "relationship"
      ? belief.values.counterparty
      : atAnOrganization
        ? belief.values.organization
        : undefined;
  // An affiliation with no organization entity names its organization by name alone (a text, which
  // a belief's values never hold), and its supporting claims' name rows resolve it.
  const byName = atAnOrganization && other === undefined;
  if (typeof other !== "string" && !byName) return null;
  return {
    via: atAnOrganization ? "affiliation" : belief.values.relation === "acquaintance" ? "acquaintance" : "relationship",
    subject: belief.subject as string,
    other: typeof other === "string" ? other : null,
    fact: row.fact_key_fp,
    support: row.support,
    relation:
      belief.kind === "relationship" && typeof belief.values.relation === "string" ? belief.values.relation : undefined,
    role: belief.kind === "role",
  };
}

// A hop resting on a claim with no belief: its two people, how it was stated, its weight and the
// claim it cites with that claim's fact key.
type ClaimedHop = {
  a: string;
  b: string;
  via: StatedVia;
  offer?: IntroOffer;
  relation?: string;
  weight: number;
  fact: FactId;
  key: string;
};

// The hops the relation claims (newest first) and the confirmed connections make: each intro offer;
// a research fill's relation, a `researched` edge, the newest for each pair and relation; a report
// whose speaker is neither side, the newest for each pair and relation; and each connection.
function claimedHops(
  relations: readonly Opened[],
  connections: readonly Opened[],
  group: (id: string) => EntityId,
  rules: ReturnType<typeof secondDegreeRules>,
): ClaimedHop[] {
  const claimed: ClaimedHop[] = [];
  const reported = new Set<string>();
  const once = (key: string): boolean => {
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  };
  for (const { row, record } of relations) {
    const { subject, fields } = record.claim.content;
    const fact = row.id as FactId;
    if (record.claim.content.type === "intro_offer") {
      const offer = IntroOffer.safeParse(fields.offer);
      if (typeof fields.person !== "string" || !offer.success) continue;
      const weight = hopWeight("intro_offer", rules, offer.data);
      claimed.push({
        a: subject,
        b: fields.person,
        via: "intro_offer",
        offer: offer.data,
        weight,
        fact,
        key: row.fact_key_fp,
      });
      continue;
    }
    // A released connection is the connections' loop's.
    if (record.origin === "agent_research") {
      const other = record.claim.content.type === CONNECTION_TYPE ? fields.other : fields.counterparty;
      const relation = String(record.claim.content.type === CONNECTION_TYPE ? fields.kind : fields.relation);
      if (typeof other !== "string") continue;
      if (!once(`researched\n${[group(subject), group(other)].sort().join("\n")}\n${relation}`)) continue;
      const weight = hopWeight("researched", rules);
      claimed.push({ a: subject, b: other, via: "researched", relation, weight, fact, key: row.fact_key_fp });
      continue;
    }
    if (record.claim.content.type === CONNECTION_TYPE) continue;
    const counterparty = fields.counterparty;
    const speaker = record.claim.assertedBy;
    if (typeof counterparty !== "string" || speaker === undefined || speaker === subject || speaker === counterparty)
      continue;
    const relation = String(fields.relation);
    if (!once(`${[group(subject), group(counterparty)].sort().join("\n")}\n${relation}`)) continue;
    const weight = hopWeight("reported", rules);
    claimed.push({ a: subject, b: counterparty, via: "reported", relation, weight, fact, key: row.fact_key_fp });
  }
  for (const { row, record } of connections) {
    const other = record.claim.content.fields.other;
    if (typeof other !== "string") continue;
    const weight = hopWeight("connection", rules);
    claimed.push({
      a: record.claim.content.subject,
      b: other,
      via: "connection",
      weight,
      fact: row.id as FactId,
      key: row.fact_key_fp,
    });
  }
  return claimed;
}

// The one loader of hops, for find_paths and the owner's `paths` and
// `network`. To today's current relationship and affiliation beliefs of
// the caller's audience (none disputed) it adds: an `acquaintance` belief at `acquaintanceWeight`;
// each `intro_offer` claim at its offer's `introOfferWeight`, the hop marked with its offer; each
// confirmed connection at 1; and each reported relation, the newest for each pair and relation, at
// `reportedWeight`. Every person is named by their group (`group`). The statements sent are the
// same whatever the caller cannot see; every count read is bounded.
export async function loadPathHops(
  ctx: Ctx,
  group: (id: string) => EntityId,
  now: Date,
  owner?: OwnerScope,
): Promise<PathHops> {
  const rules = secondDegreeRules();
  const { rows, beliefs, ceiling } = owner?.beliefs ?? (await audienceBeliefs(ctx));
  const audience = owner === undefined ? null : [...owner.audience];
  const open = beliefs.flatMap((belief, index) => {
    const hop = beliefHop(belief, rows[index] as HopBeliefs["rows"][number]);
    return hop === null ? [] : [hop];
  });
  // One statement, sent whatever the beliefs hold: the organization each name-only claim resolves to.
  const resolved = new Map<string, string[]>();
  for (const row of await ctx.run<{ claim_id: string; entity_id: string }>(CLAIM_ORGS, [
    [...new Set(open.flatMap((one) => (one.other === null ? one.support : [])))],
  ])) {
    resolved.set(row.claim_id, [...(resolved.get(row.claim_id) ?? []), row.entity_id]);
  }
  // An affiliation whose claims resolve to one organization and no other bridges through it.
  const current = open.flatMap((one) => {
    if (one.other !== null) return [{ ...one, other: one.other }];
    const organizations = [...new Set(one.support.flatMap((id) => resolved.get(id) ?? []))];
    return organizations.length === 1 ? [{ ...one, other: organizations[0] as string }] : [];
  });

  const opened = (row: ClaimRow): Opened => {
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    return { row, record: parsed.data };
  };
  const since = new Date(now.getTime() - rules.introOfferDays * DAY_MS).toISOString();
  const relationRows = await ctx.run<ClaimRow>(RELATION_CLAIMS, [
    ["intro_offer", "relationship", CONNECTION_TYPE],
    since,
    now.toISOString(),
    MAX_LINKS + 1,
    audience,
  ]);
  const connectionRows = await ctx.run<ClaimRow>(CONNECTIONS, [CONNECTION_TYPE, MAX_LINKS + 1, audience]);
  let cut = ceiling || relationRows.length > MAX_LINKS || connectionRows.length > MAX_LINKS;
  const claimed = claimedHops(
    relationRows.slice(0, MAX_LINKS).map(opened),
    connectionRows.slice(0, MAX_LINKS).map(opened),
    group,
    rules,
  );

  // Each names only people and organizations the token shows, and cites only claims it returns.
  const named = [...current.flatMap((one) => [one.subject, one.other]), ...claimed.flatMap((one) => [one.a, one.b])];
  const entities = await ctx.run<{ id: string; kind: string }>(PEOPLE_OR_ORGS, [[...new Set(named)]]);
  const kinds = new Map(entities.map((row) => [row.id, row.kind]));
  const supports = [...new Set(current.flatMap((one) => one.support))];
  const visible = new Set((await ctx.run<{ id: FactId }>(CLAIMS, [supports, audience])).map((row) => row.id));
  const factKeyOf = new Map<FactId, string>();
  const relationOf = new Map<FactId, string>();
  const ties: Tie<StatedVia>[] = [];
  const affiliations: Affiliation[] = [];
  const stated = new Set<string>();
  for (const one of [...current].sort((a, b) => Number(a.role) - Number(b.role))) {
    const facts = one.support.filter((id): id is FactId => visible.has(id as FactId)).sort();
    if (facts.length === 0 || kinds.get(one.subject) !== "person") continue;
    const held = `${group(one.subject)}\n${one.other}`;
    if (one.role && stated.has(held)) continue;
    if (one.via === "affiliation") stated.add(held);
    if (one.via !== "affiliation" && kinds.get(one.other) === "person")
      ties.push({
        a: group(one.subject),
        b: group(one.other),
        facts,
        ...(one.via === "relationship" ? {} : { via: one.via, weight: hopWeight(one.via, rules) }),
      });
    else if (one.via === "affiliation" && kinds.get(one.other) === "organization")
      affiliations.push({ person: group(one.subject), organization: one.other as EntityId, facts });
    else continue;
    for (const fact of facts) {
      factKeyOf.set(fact, one.fact);
      if (one.relation !== undefined) relationOf.set(fact, one.relation);
    }
  }
  for (const one of claimed) {
    if (kinds.get(one.a) !== "person" || kinds.get(one.b) !== "person") continue;
    ties.push({
      a: group(one.a),
      b: group(one.b),
      facts: [one.fact],
      via: one.via,
      weight: one.weight,
      ...(one.offer === undefined ? {} : { offer: one.offer }),
    });
    factKeyOf.set(one.fact, one.key);
    if (one.relation !== undefined) relationOf.set(one.fact, one.relation);
  }
  if (ties.length > MAX_LINKS) cut = true;
  return { ties, affiliations, factKeyOf, relationOf, cut };
}

// Name-only organizations (no domain row the caller sees) that a name of `organization` also names, as
// the caller's token shows them.
const ALSO_NAMED = `
  select distinct o.entity_id
  from knowledge.org_names o
  where o.name_fp = any($1::text[]) and o.entity_id <> $2
    and not exists (select 1 from knowledge.domains d where d.entity_id = o.entity_id)
  order by o.entity_id`;

const TARGET_DOMAINS = `
  select d.domain_fp from knowledge.domains d where d.entity_id = $1 order by d.id`;

// A saved contact names their firm in words, so its claim binds to a name-only organization of those words,
// apart from the organization the firm's own domain makes . For a domain's organization
// as the target, the people at a name-only one of its very name are at it: a hop only, for this answer. Nothing
// is joined or stored, and the hop cites the person's own fact. Nothing goes the other way: a domain's
// organization holds its names in sealed claims, so a name-only target finds only those its name rows name.
async function alsoNamed(
  ctx: Ctx,
  target: string,
): Promise<{ ids: Set<string>; shown: string[]; factKeyFps: string[] }> {
  const domains = await ctx.run<{ domain_fp: string }>(TARGET_DOMAINS, [target]);
  if (domains.length === 0) return { ids: new Set(), shown: [], factKeyFps: [] };
  const named = await organizationNames(
    ctx,
    target,
    domains.map((row) => row.domain_fp),
    { contacts: false },
  );
  const fps = named.names.map((name) => orgNameFp(ctx.keys, name.untrusted));
  const rows = await ctx.run<{ entity_id: string }>(ALSO_NAMED, [fps, target]);
  // The names read only decide an answer when one of them matched.
  if (rows.length === 0) return { ids: new Set(), shown: [], factKeyFps: [] };
  return { ids: new Set(rows.map((row) => row.entity_id)), shown: named.shown, factKeyFps: named.factKeyFps };
}

// `statedOnly`: for a write's quick check of whether a path exists, within the write deadline.
export async function findPaths(
  ctx: Ctx,
  args: FindPathsArgs,
  now: Date,
  options: { statedOnly?: boolean } = {},
): Promise<Found<PathList> | null> {
  // A hidden target and an absent one answer alike, after the same one statement.
  const [target] = await ctx.run<{ id: EntityId; kind: "person" | "organization" }>(PERSON_OR_ORG, [args.target]);
  if (target === undefined) return null;
  const toOrganization = target.kind === "organization";
  const [owner] = await ctx.run<AccountRow & { entity_id: EntityId }>(OWNER_ACCOUNT, []);
  // Every person is walked as their group, named by its id, from the
  // rulings the token returns; a group of one is the person.
  const groups = await loadGroups(ctx);
  const group = (id: string): EntityId => groups.idOf(id) as EntityId;
  // A named person no relation claim or goal the caller sees names is
  // withheld, and answers as a hidden one.
  if (!toOrganization && (await withheldNamed(ctx, groups.membersOf(target.id)))) return null;
  // And a named organization no claim or goal the caller sees names.
  if (toOrganization && (await namedOrgState(ctx, target.id)).withheld) return null;
  const ownTies = new Set(
    (await ctx.run<{ entity_id: EntityId }>(OWN_TIES, [now.toISOString()])).map((row) => group(row.entity_id)),
  );
  const loaded = await loadPathHops(ctx, group, now);
  const { ties, factKeyOf, cut } = loaded;
  const same = toOrganization ? await alsoNamed(ctx, target.id) : { ids: new Set<string>(), shown: [], factKeyFps: [] };
  const affiliations = loaded.affiliations.map((one) =>
    same.ids.has(one.organization) ? { ...one, organization: target.id } : one,
  );

  // With no visible account of the owner's, there is no owner to start from. The bound is the rule
  // file's `maxHops` when the call names none.
  const maxHops = args.maxHops ?? secondDegreeRules().maxHops;
  const observed =
    owner === undefined || options.statedOnly === true
      ? NO_OBSERVED
      : await loadObservedHops(ctx, {
          owner: owner.entity_id,
          target: group(args.target),
          ownTies,
          ties,
          affiliations,
          walkHops: maxHops - 1,
          now,
          groups,
        });
  const walked =
    owner === undefined
      ? { paths: [], cut: false }
      : findPathsWithObserved(
          {
            owner: owner.entity_id,
            target: group(args.target),
            ownTies,
            ties,
            affiliations,
            maxHops,
            most: RANKED_PATHS,
          },
          observed,
        );
  // Ranked by the weakest hop. An own tie's hop weighs by its tier
  // (the rule table's path weights; no tier, core's floor), read for the paths' first hops alone;
  // among paths of one score and length, tier, then warmth, breaks the tie.
  const starts = [
    ...new Set(walked.paths.map((path) => path.hops[0]?.to).filter((id): id is EntityId => id !== undefined)),
  ];
  const owned = await warmthOf(ctx, groups, starts);
  const strength = new Map(
    [...owned].flatMap(([id, line]) => {
      const weight = pathWeight(line);
      return weight === undefined ? [] : [[id, weight] as const];
    }),
  );
  const order = new Map([...owned].map(([id, line]) => [id, warmthOrder(line)] as const));
  // Cut after ranking, so the answer's twenty are the closest routes, never the first by id; and at most a few through
  // one person or resting on one message, so they are different routes.
  const distinct = distinctRoutes(
    rankPathsByWeakestHop(walked.paths, strength, group(args.target), toOrganization, order),
    group(args.target),
  );
  const found = {
    paths: distinct.slice(0, MAX_PATHS),
    cut: walked.cut || observed.cut || walked.paths.length > Math.min(distinct.length, MAX_PATHS),
  };
  const named = [...new Set(found.paths.flatMap((path) => path.hops.flatMap((hop) => [hop.from, hop.to])))].filter(
    (id) => id !== owner?.entity_id,
  );
  const who = await whoOf(ctx, named, { fixed: true });
  const ownerWho: Who | undefined =
    owner === undefined
      ? undefined
      : {
          id: owner.entity_id,
          kind: "owner",
          name: null,
          address: served(ctx, owner, "knowledge.accounts.value_enc"),
        };
  const whoIs = (id: EntityId): Who => {
    const one = id === owner?.entity_id ? ownerWho : who.get(id);
    if (one === undefined) throw new Unavailable();
    return { ...one };
  };
  const paths = found.paths.map((path) => ({
    score: path.score,
    hops: path.hops.map((hop) => ({
      from: whoIs(hop.from),
      to: whoIs(hop.to),
      via: hop.via,
      ...(hop.offer === undefined ? {} : { offer: hop.offer }),
      ...(hop.seen === undefined ? {} : { observed: { weight: hop.weight ?? 0, ...hop.seen } }),
      facts: hop.facts,
    })),
  }));
  // The read set: the fact key of each belief or claim a hop cites, and a message or meeting of each
  // label an observed hop rests on, so what a run writes after this read carries those labels. No
  // evidence was opened.
  const cited = new Set(
    found.paths.flatMap((path) => path.hops.flatMap((hop) => hop.facts.map((fact) => factKeyOf.get(fact) as string))),
  );
  return {
    value: { paths, cut: found.cut || cut },
    rows: paths.length,
    read: {
      bound: [],
      shown: [
        ...new Set([
          ...found.paths.flatMap((path) =>
            path.hops.flatMap((hop) => (hop.seen === undefined ? [] : observedEvidence(observed, hop))),
          ),
          ...same.shown,
        ]),
      ].sort(),
      factKeyFps: [...new Set([...cited, ...same.factKeyFps])].sort(),
    },
  };
}

// Routes from the owner to one person, view `people`: a list tool,
// budgeted by rows.
export const FIND_PATHS_TOOL: ReadTool<FindPathsArgs, PathList> = {
  tool: "find_paths",
  parse: (args) => parsed(FindPathsArgs.safeParse(args)),
  work: (ctx, valid, _client, env) => findPaths(ctx, valid, env.now()),
};
