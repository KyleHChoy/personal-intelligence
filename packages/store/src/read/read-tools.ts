import type { Envelope } from "@intelligence/contracts";
import {
  type EntityId,
  type EntityView,
  type PersonalView,
  SearchArgs,
  type SearchResult,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { isNamedKey } from "@intelligence/personal-core";
import { byText, stampOrNull } from "../core/db.ts";
import {
  type ClientGroups,
  type Ctx,
  type Entity,
  type Found,
  type Sealed,
  shownOnly,
  untrusted,
} from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { served } from "../core/served.ts";
import { HEADERS_ONLY_COUNT, MAIL_COUNTS } from "../core/statements.ts";
import { PEOPLE_OR_ORGS } from "../core/visibility.ts";
import { hisNames } from "../identity/person-name-rows.ts";
import { matchesOf } from "./read-facts.ts";
import { ORG_NAME_SERVED } from "./read-fragments.ts";
import { groupContactNames, groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { namedBy, namedOrgSeen, namedSeen } from "./read-named.ts";
import { bestMatch, byAddressThenRank, normalized, type Rank } from "./read-search.ts";
import { warmthOf, warmthOrder } from "./read-warmth.ts";

// The fixed queries of `search` and of what the read tools share. Each runs under the caller's token, so every count, rank and order here is over rows
// the token returned, and every statement ends in an order that includes a unique key. A tool returns its value and the number of top-level items in it, or null for an
// entity that is not there or not visible. This file holds what the tools share and search;
// get_self, get_entity and get_timeline are in read-tools-self.ts, read-tools-entity.ts and
// read-tools-timeline.ts.

type Owned = Sealed & { entity_id: string };

const SEARCH_RESULTS = 25;

// get_entity's: a person, an organization or a project, as the token shows it.
export const ENTITY_OR_PROJECT = `
  select e.id, e.kind from knowledge.entities e
  where e.id = $1 and e.kind in ('person', 'organization', 'project')
  order by e.id`;

// A project's own row, as the token shows it: four columns, never its readers.
export const PROJECT = `
  select p.id, p.status, p.name_enc, p.compartments
  from knowledge.projects p
  where p.id = $1
  order by p.id`;

export type Mail = {
  entity_id: string;
  inbound: number;
  outbound: number;
  // Only get_entity's statement reads it.
  headers_only?: number;
  first_at: Date | null;
  last_at: Date | null;
};

// get_entity's mail line from its row, or no mail when there is none. headersOnly is said only
// when some of the counted mail is held by its headers alone.
export function mailOf(row: Omit<Mail, "entity_id"> | undefined): EntityView["mail"] {
  const headersOnly = row?.headers_only ?? 0;
  return {
    inbound: row?.inbound ?? 0,
    outbound: row?.outbound ?? 0,
    ...(headersOnly > 0 ? { headersOnly } : {}),
    firstAt: stampOrNull(row?.first_at ?? null),
    lastAt: stampOrNull(row?.last_at ?? null),
  };
}

// The same per group: `$1` the visible people, `$2` each one's group id. A message two members
// share is counted once (as an entity's and a search's counts are). Search ranks by the two
// counts alone, so only get_entity's statement counts mail held by headers alone.
const groupMail = (extra: string) => `
  select g.grp as entity_id,
    ${MAIL_COUNTS},${extra}
    min(i.occurred_at) as first_at, max(i.occurred_at) as last_at
  from knowledge.interaction_log i
  join unnest($1::text[], $2::text[]) as g (entity, grp) on g.entity = i.entity_id
  group by g.grp
  order by g.grp`;
export const GROUP_MAIL = groupMail("");
export const ENTITY_MAIL = groupMail(`
    ${HEADERS_ONLY_COUNT},`);

export type Printed = Sealed & { value_fp: string };

// One row per fingerprint, the one with the lowest id, in order of those ids.
function firstOfEach<Row extends Printed>(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => byText(a.id, b.id))
    .filter((row) => !seen.has(row.value_fp) && seen.add(row.value_fp));
}

// The values opened, one per fingerprint, in order of each one's lowest row id.
export const inRowOrder = (ctx: Ctx, table: string, column: string, rows: Printed[]): UntrustedString[] =>
  firstOfEach(rows).map((row) => untrusted(ctx, table, column, row));

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

// The three reads of every visible row search matches on. Each reads its rows in a materialized
// CTE first and orders them after: asked for an order directly, the planner could walk an index
// that gives it (accounts_pkey, domains_pkey) over every compartment's rows, where the key-led
// index reads the visible ones alone.

// One row per name of each entity, for matching: the one with the lowest id. And the owner's live
// names for people, by an account of theirs, one per address
// (`his`).
export const CANDIDATE_NAMES = `
  with names as materialized (
    select s.entity_id, s.value_fp, s.id, s.compartments, s.value_enc, false as his
    from knowledge.aliases s
    union all
    select x.entity_id, x.id, x.id, x.compartments, x.value_enc, true
    from (${hisNames("e.kind = 'person'")}) x
  )
  select distinct on (names.entity_id, names.value_fp, names.his) names.entity_id, names.id, names.compartments, names.value_enc, names.his
  from names
  order by names.entity_id, names.value_fp, names.his, names.id`;

const CANDIDATE_ACCOUNTS = `
  with accounts as materialized (
    select a.entity_id, a.id, a.value_fp, a.compartments, a.value_enc
    from knowledge.accounts a
  )
  select accounts.* from accounts
  order by accounts.id`;

const CANDIDATE_DOMAINS = `
  with domains as materialized (
    select d.entity_id, d.id, d.domain_fp as value_fp, d.compartments, d.domain_enc as value_enc
    from knowledge.domains d
  )
  select domains.* from domains
  order by domains.id`;

// Every named organization's name row, one per name of each.
const CANDIDATE_ORG_NAMES = `
  with names as materialized (
    select o.entity_id, o.name_fp, o.id, o.compartments, o.name_enc as value_enc
    from knowledge.org_names o
    where ${ORG_NAME_SERVED}
  )
  select distinct on (names.entity_id, names.name_fp) names.entity_id, names.id, names.compartments, names.value_enc
  from names
  order by names.entity_id, names.name_fp, names.id`;

// Every project the token shows, its name opened to match; one the client's views do not cover (the
// work view) is left out after the read, so the statements do not depend on the
// views.
const CANDIDATE_PROJECTS = `
  select p.id, p.compartments, p.name_enc
  from knowledge.projects p
  order by p.id`;

type Candidate = Entity & {
  names: string[];
  sealed: (Owned & Printed)[];
  addresses: string[];
  name?: UntrustedString;
  nameOnly?: boolean;
};

// The names and addresses the token shows are opened and matched in memory. Who each result is,
// its latest name and its first address, is read for the results alone. The candidates are the
// entities the visible accounts and domains name: an entity is visible exactly when one of its
// accounts or domains is.
// With a match mode the need or capability claims instead: read-facts.ts, matchesOf.
// Said on a name no one the caller sees holds, in the same words whether it is absent or hidden. An address, a
// domain or a number is no name, and nor are a letter or two. A project is one the owner or an agent made, so a name mail uses may be none.
const NO_NAME_HELD =
  "No person, organization or project you can see holds this name. A project is one the owner or an agent made, so a name used in mail or on a calendar need not be one.";

// Every entity the visible accounts, domains and organization names name, with its names opened
// and its addresses sealed, and every project the token shows when the views cover work.
async function candidatesOf(ctx: Ctx, views: readonly PersonalView[]): Promise<Map<string, Candidate>> {
  const names = await ctx.run<Owned & { his: boolean }>(CANDIDATE_NAMES, []);
  const accounts = await ctx.run<Owned & Printed>(CANDIDATE_ACCOUNTS, []);
  const domains = await ctx.run<Owned & Printed>(CANDIDATE_DOMAINS, []);
  const orgNames = await ctx.run<Owned>(CANDIDATE_ORG_NAMES, []);
  const named = [...new Set([...accounts, ...domains, ...orgNames].map((row) => row.entity_id))].sort(byText);
  const candidates = new Map<string, Candidate>();
  for (const entity of await ctx.run<Entity>(PEOPLE_OR_ORGS, [named]))
    candidates.set(entity.id, { ...entity, names: [], sealed: [], addresses: [] });

  for (const row of names) {
    const one = candidates.get(row.entity_id);
    if (one?.kind === "person")
      one.names.push(
        normalized(
          (row.his
            ? untrusted(ctx, "knowledge.person_names", "name_enc", row)
            : untrusted(ctx, "knowledge.aliases", "value_enc", row)
          ).untrusted,
        ),
      );
  }
  // The owner's own accounts come back too; they are no candidate's, and are not opened.
  for (const row of accounts) {
    const one = candidates.get(row.entity_id);
    if (one?.kind === "person") one.sealed.push(row);
  }
  for (const row of domains) {
    const one = candidates.get(row.entity_id);
    if (one?.kind === "organization") one.sealed.push(row);
  }
  // A named organization is matched by its names; with no domain it is
  // known by them alone.
  for (const row of orgNames) {
    const one = candidates.get(row.entity_id);
    if (one?.kind === "organization")
      one.names.push(normalized(untrusted(ctx, "knowledge.org_names", "name_enc", row).untrusted));
  }
  for (const row of await ctx.run<Sealed & { name_enc: Envelope }>(CANDIDATE_PROJECTS, [])) {
    if (!views.includes("work")) continue;
    const name = served(ctx, row, "knowledge.projects.name_enc");
    candidates.set(row.id, {
      id: row.id,
      kind: "project",
      names: [normalized(name.untrusted)],
      sealed: [],
      addresses: [],
      name,
    });
  }
  return candidates;
}

// One candidate for a group, before any match, rank or limit: a group's names are its members' names
// (its contact names join at the match), its addresses its members' addresses.
function byGroup(
  candidates: Iterable<Candidate>,
  groups: ClientGroups,
): Map<string, Candidate & { members: string[] }> {
  const merged = new Map<string, Candidate & { members: string[] }>();
  for (const one of candidates) {
    const key = one.kind === "person" ? groups.idOf(one.id) : one.id;
    const known = merged.get(key) ?? {
      id: key,
      kind: one.kind,
      names: [],
      sealed: [],
      addresses: [],
      members: one.kind === "person" ? groups.membersOf(one.id) : [one.id],
      ...(one.name === undefined ? {} : { name: one.name }),
    };
    known.names.push(...one.names);
    known.sealed.push(...one.sealed);
    merged.set(key, known);
  }
  return merged;
}

export async function search(ctx: Ctx, args: SearchArgs, views: readonly PersonalView[]): Promise<Found<SearchResult>> {
  if (args.mode === "needs" || args.mode === "capabilities") return matchesOf(ctx, { ...args, mode: args.mode }, views);
  const query = normalized(args.query);
  const candidates = await candidatesOf(ctx, views);
  const groups = await loadGroups(ctx);
  const merged = byGroup(candidates.values(), groups);

  const matched: { one: Candidate & { members: string[] }; rank: Rank }[] = [];
  const memberLists = [...merged.values()].map((one) => one.members);
  const contactNames = await groupContactNames(ctx, memberLists);
  for (const [i, one] of [...merged.values()].entries()) {
    // One per address; a project has none.
    const [table, column] =
      one.kind === "person" ? ["knowledge.accounts", "value_enc"] : ["knowledge.domains", "domain_enc"];
    if (one.kind !== "project") {
      const opened = inRowOrder(ctx, table, column, one.sealed).map((address) => address.untrusted);
      // A person whose every account is a named key; a key is matched as
      // no address.
      one.nameOnly =
        (one.kind === "person" && namedBy(opened)) ||
        (one.kind === "organization" && opened.length === 0 && one.names.length > 0);
      one.addresses = opened.filter((address) => !isNamedKey(address)).map(normalized);
    }
    if (one.members.length > 1) one.names.push(...(contactNames[i] ?? []).map((named) => normalized(named.name)));
    const rank = bestMatch(query, one);
    if (rank !== null) matched.push({ one, rank });
  }
  // A named person, or a named organization, that no relation claim or goal the caller sees names
  // is withheld. Each is read only when one matched, from rows the caller sees.
  const orgsOnly = matched.flatMap(({ one }) => (one.nameOnly === true && one.kind === "organization" ? [one.id] : []));
  const orgsSeen = orgsOnly.length === 0 ? new Set<string>() : await namedOrgSeen(ctx, orgsOnly);
  const nameOnly = matched.filter(({ one }) => one.nameOnly === true && one.kind === "person");
  const members = nameOnly.flatMap(({ one }) => one.members);
  const seen = nameOnly.length === 0 ? new Set<string>() : await namedSeen(ctx, members);
  const withheld = new Set([
    ...orgsOnly.filter((id) => !orgsSeen.has(id)),
    ...nameOnly.filter(({ one }) => !one.members.some((member) => seen.has(member))).map(({ one }) => one.id),
  ]);
  const kept = matched.filter(({ one }) => !withheld.has(one.id));

  // The count that ranks is the visible one, each message once for a group. An organization has
  // no mail.
  const people = kept.filter(({ one }) => one.kind === "person");
  const map = people.flatMap(({ one }) => one.members.map((member) => [member, one.id] as const));
  const mailArgs = [map.map(([member]) => member), map.map(([, group]) => group)];
  const mailRows = map.length === 0 ? [] : await ctx.run<Mail>(GROUP_MAIL, mailArgs);
  const mail = new Map(mailRows.map((row) => [row.entity_id, row]));
  // Within a match rank, people by tier, then `warmth`, from the caller's audience's stored rows,
  // before the page is cut; one read for every matched person.
  const peopleIds = people.map(({ one }) => one.id);
  const warmth = await warmthOf(ctx, groups, peopleIds);
  const page = kept
    .map(({ one, rank }) => ({
      one,
      id: one.id,
      rank,
      emails: (mail.get(one.id)?.inbound ?? 0) + (mail.get(one.id)?.outbound ?? 0),
      warmth: warmthOrder(warmth.get(one.id)),
      nameOnly: one.nameOnly === true,
    }))
    .sort(byAddressThenRank)
    .slice(0, Math.min(args.limit ?? SEARCH_RESULTS, SEARCH_RESULTS));

  const pageIds = page.map(({ id }) => id);
  const who = await groupWho(ctx, groups, pageIds);
  const results = page.map(({ one }) => ({
    id: one.id as EntityId,
    kind: one.kind,
    name: one.name ?? who.get(one.id)?.name ?? null,
    address: who.get(one.id)?.address ?? null,
    ...(who.get(one.id)?.nameOnly === true ? { nameOnly: true as const } : {}),
    lastInteractionAt: stampOrNull(mail.get(one.id)?.last_at ?? null),
  }));
  const note =
    results.length === 0 && query.length >= 3 && !/[@.]/.test(query) && /\p{L}/u.test(query)
      ? { note: NO_NAME_HELD }
      : {};
  return { value: { results, ...note }, rows: results.length, read: shownOnly([]) };
}

export const SEARCH_TOOL: ReadTool<SearchArgs, SearchResult> = {
  tool: "search",
  parse: (args) => parsed(SearchArgs.safeParse(args)),
  work: (ctx, valid, client) => search(ctx, valid, client.views),
};
