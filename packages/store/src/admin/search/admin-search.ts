import {
  OWNER_PAGE_DEFAULT,
  type OwnerSearchResult,
  TIERS,
  type Tier,
  type Who,
} from "@intelligence/contracts/personal";
import { isMintedKey } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";
import { normalized } from "../../read/read-search.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";
import { ownerBuild, ownerRows } from "../people/admin-warmth.ts";

// The owner's search as they type: people and organizations by name prefix, address or domain,
// ranked by match then warmth, from a name index `pi web` holds in memory, so a keystroke opens no
// alias. The index is the Admin's (`NameIndex`), dropped with it when `pi web` stops.
//
// It is rebuilt whenever what it was built from changes, by whatever process changed it: each
// search first reads one stamp (STAMP) over the rows it is built from, ids, owners and labels only,
// nothing opened, and rebuilds when it differs. An identity change (a merge moves an alias, a new
// account, a domain, an ignore ruling) and an erasure (it removes aliases, accounts and the claims
// that named an organization) change the stamp, so an erased person leaves the index at the next
// keystroke (invariant 10).
//
// Within the owner's audience only: a row is read only when its label is within it and the key file
// opens it. The reader's filter it keeps: the withheld people and organizations (`ownerWithheld`),
// whom list_people and search leave out; the owner is left out too. No held message or release is
// read: names are `ownerWho`'s. The term is never logged, and nothing here logs.

export type Entry = { who: Who; names: string[]; addresses: string[]; domains: string[] };
type NameIndex = { stamp: string; entries: Entry[] };
// Held by the Admin for its lifetime: the last index built, or none, and the build under way, so
// keystrokes that meet one change build once. The Admin's erasures drop the index at once.
export type NameIndexHolder = {
  index: NameIndex | null;
  building?: { stamp: string; index: Promise<NameIndex> } | undefined;
};

export function dropNameIndex(holder: NameIndexHolder): void {
  holder.index = null;
  holder.building = undefined;
}

// Ids, owners, kinds and labels of every row within the owner's audience ($1) the index reads; of
// the ignore rulings that decide who is withheld; and of the role and affiliation claims that name
// organizations. A count and an order-free sum of hashes, so no sort. A row outside the owner's
// audience changes nothing the owner sees, their search's timing included (invariant 6). Display
// names follow
// ownerWho's rules as of the last build; what changes only which alias is shown (a message held
// since) waits for the next change here.
const STAMP = `
  select count(*)::text || ':' || coalesce(sum(hashtextextended(t.line, 0)::numeric), 0)::text as stamp from (
    select 'e ' || e.id || ' ' || e.kind as line from knowledge.entities e
    union all select 'a ' || s.id || ' ' || s.entity_id from knowledge.aliases s where s.compartments <@ $1::text[]
    union all select 'c ' || a.id || ' ' || a.entity_id || ' ' || a.kind from knowledge.accounts a where a.compartments <@ $1::text[]
    union all select 'd ' || d.id || ' ' || d.entity_id from knowledge.domains d where d.compartments <@ $1::text[]
    union all select 'n ' || n.id || ' ' || (n.lifted_at is null)::text from knowledge.organization_names n where n.compartments <@ $1::text[]
    union all select 'p ' || n.id || ' ' || (n.lifted_at is null)::text from knowledge.person_names n where n.compartments <@ $1::text[]
    union all select 'i ' || r.ruling_id || ' ' || (r.lifted_at is null)::text || ' ' || coalesce(array_to_string(r.address_fps, ','), '') from knowledge.ignore_rulings r
    union all select 'h ' || h.ruling_id || ' ' || (h.lifted_at is null)::text from knowledge.person_hides h
    union all select 'k ' || c.id || ' ' || c.released::text from knowledge.claims c where c.type in ('role', 'affiliation') and c.compartments <@ $1::text[]
  ) t`;

const ENTITIES = "select e.id from knowledge.entities e where e.kind in ('person', 'organization') order by e.id";

// Every alias, account, domain and live organization name the owner gave, within the audience ($1).
const VALUES = `
  select 'name' as field, s.entity_id, s.id, s.compartments, s.value_enc, 'knowledge.aliases' as at, 'value_enc' as col from knowledge.aliases s where s.compartments <@ $1::text[]
  union all
  select 'address', a.entity_id, a.id, a.compartments, a.value_enc, 'knowledge.accounts', 'value_enc' from knowledge.accounts a where a.compartments <@ $1::text[]
  union all
  select 'domain', d.entity_id, d.id, d.compartments, d.domain_enc, 'knowledge.domains', 'domain_enc' from knowledge.domains d where d.compartments <@ $1::text[]
  union all
  select 'name', d.entity_id, n.id, n.compartments, n.name_enc, 'knowledge.organization_names', 'name_enc' from knowledge.organization_names n
    join knowledge.domains d on d.domain_fp = n.domain_fp
    where n.lifted_at is null and n.compartments <@ $1::text[] and d.compartments <@ $1::text[]
  order by 2, 3`;

async function build(context: AdminContext, query: Query, audience: string[], stamp: string): Promise<NameIndex> {
  const withheld = await ownerWithheld(query);
  const ids = (await query<{ id: string }>(ENTITIES)).map((row) => row.id).filter((id) => !withheld.has(id));
  const who = await ownerWho({ query, keys: context.keys }, ids);
  const entries = new Map<string, Entry>();
  for (const [id, one] of who) {
    // A person with no name is no hit: only an address could match them.
    if (one.kind === "person" && one.name === null) continue;
    const entry: Entry = { who: one, names: [], addresses: [], domains: [] };
    if (one.name !== null) entry.names.push(normalized(one.name.untrusted));
    entries.set(id, entry);
  }
  const rows = await query<{
    field: "name" | "address" | "domain";
    entity_id: string;
    id: string;
    compartments: string[];
    value_enc: Sealed;
    at: string;
    col: string;
  }>(VALUES, [audience]);
  for (const row of rows) {
    const entry = entries.get(row.entity_id);
    if (entry === undefined || !row.compartments.every((one) => context.keys.compartments.has(one))) continue;
    const value = openedUnder(
      context.keys,
      row.compartments,
      { table: row.at, id: row.id, column: row.col },
      row.value_enc,
    );
    // A confirmed proposal's minted key is no address the owner could type.
    if (row.field === "address" && isMintedKey(value)) continue;
    const kept = normalized(value);
    const list = row.field === "name" ? entry.names : row.field === "address" ? entry.addresses : entry.domains;
    if (kept !== "" && !list.includes(kept)) list.push(kept);
  }
  return { stamp, entries: [...entries.values()] };
}

// The match tiers, best first: 0, a word of a name is the term (a term of several words, a run of a
// name's words); 1, a name starts with it: a first name, or a full name; 2, a later word of a name
// starts with it: a surname; 3, a name holds it anywhere; 4, an address holds it; 5, an
// organization's domain does. So for "jon", "Jon Avery" and "Jonathan Ruiz" come before "Wade
// Jonsen". The term and the values are normalized.
export type Match = { rank: 0 | 1 | 2 | 3 | 4 | 5; match: "name" | "address" | "domain" };

// A person's name stored surname first, "Jonsen, Wade" (an address book's or a sender's), starts
// with the first name for tiers 1 and 2, so its surname is a later word as in "Wade Jonsen"; the
// name as stored still matches whole and anywhere. An organization's name ("Example, Inc.") is
// read as stored.
const firstNameFirst = (name: string): string => {
  const [last, first, ...rest] = name.split(",").map((part) => part.trim());
  return first === undefined || first === "" || last === "" || rest.length > 0 ? name : `${first} ${last}`;
};

export function matchOf(
  term: string,
  entry: Pick<Entry, "names" | "addresses" | "domains"> & { who?: Pick<Who, "kind"> },
): Match | null {
  const shown = entry.who?.kind === "person" ? entry.names.map(firstNameFirst) : entry.names;
  const names = [...new Set([...entry.names, ...shown])];
  const size = term.split(" ").length;
  const words = (list: string[]) => list.map((name) => name.split(" "));
  const from = (one: string[], at: number): string => one.slice(at).join(" ");
  if (words(names).some((one) => one.some((_, at) => one.slice(at, at + size).join(" ") === term)))
    return { rank: 0, match: "name" };
  if (shown.some((name) => name.startsWith(term))) return { rank: 1, match: "name" };
  if (words(shown).some((one) => one.some((_, at) => at > 0 && from(one, at).startsWith(term))))
    return { rank: 2, match: "name" };
  if (names.some((name) => name.includes(term))) return { rank: 3, match: "name" };
  if (entry.addresses.some((address) => address.includes(term))) return { rank: 4, match: "address" };
  if (entry.domains.some((domain) => domain.includes(term))) return { rank: 5, match: "domain" };
  return null;
}

// A person's line in the owner's warmth build: the tier, the last two-way contact (ms) and the warmth.
export type Line = { tier: Tier; last: number | null; warmth: number };

// Every entry the term matches, each with its match, once a keystroke.
export type Found = { who: Who } & Match;
export const matching = (
  term: string,
  entries: readonly Pick<Entry, "who" | "names" | "addresses" | "domains">[],
): Found[] =>
  entries.flatMap((entry) => {
    const match = matchOf(term, entry);
    return match === null ? [] : [{ who: entry.who, ...match }];
  });

// The matches, best first: by match tier, then warmth tier (none last), then the most recent
// two-way contact (none last), then warmth, then id.
export function ranked(
  matches: readonly Found[],
  lines: ReadonlyMap<string, Line>,
): { who: Who; match: Match["match"] }[] {
  const place = (id: string): number => {
    const tier = lines.get(id)?.tier;
    return tier === undefined ? TIERS.length : TIERS.indexOf(tier);
  };
  const last = (id: string): number => lines.get(id)?.last ?? Number.NEGATIVE_INFINITY;
  const found = [...matches];
  found.sort(
    (a, b) =>
      a.rank - b.rank ||
      place(a.who.id) - place(b.who.id) ||
      (last(a.who.id) === last(b.who.id) ? 0 : last(b.who.id) > last(a.who.id) ? 1 : -1) ||
      (lines.get(b.who.id)?.warmth ?? 0) - (lines.get(a.who.id)?.warmth ?? 0) ||
      byText(a.who.id, b.who.id),
  );
  return found.map(({ who, match }) => ({ who, match }));
}

// Every match is ordered before the page is cut, all of them within the owner's audience.
export function ownerSearch(context: AdminContext, holder: NameIndexHolder, term: string): Promise<OwnerSearchResult> {
  const wanted = normalized(term);
  if (wanted === "") return Promise.resolve({ hits: [] });
  return context.transaction(async (query) => {
    const audience = await ownerAudience(query);
    const [{ stamp } = { stamp: "" }] = await query<{ stamp: string }>(STAMP, [audience]);
    const key = `${audience.join(",")}|${stamp}`;
    let index = holder.index;
    if (index?.stamp !== key) {
      if (holder.building?.stamp !== key) {
        const building = { stamp: key, index: build(context, query, audience, key) };
        holder.building = building;
        building.index.then(
          (built) => {
            if (holder.building === building) [holder.index, holder.building] = [built, undefined];
          },
          () => {
            if (holder.building === building) holder.building = undefined;
          },
        );
      }
      index = await holder.building.index;
    }

    const found = matching(wanted, index.entries);
    const people = found.filter((one) => one.who.kind === "person").map((one) => one.who.id);
    const lines = new Map<string, Line>();
    const warmthBuild = people.length === 0 ? null : await ownerBuild(query);
    if (warmthBuild !== null) {
      const asked = new Set<string>(people);
      for (const row of (await ownerRows({ query, keys: context.keys }, warmthBuild, context.now())).filter((one) =>
        one.members.some((member) => asked.has(member)),
      )) {
        for (const member of row.members)
          lines.set(member, {
            tier: row.tier,
            last: row.last_two_way_at?.getTime() ?? null,
            warmth: Number(row.warmth),
          });
      }
    }
    return {
      hits: ranked(found, lines)
        .slice(0, OWNER_PAGE_DEFAULT)
        .map((one) => ({ who: one.who, tier: lines.get(one.who.id)?.tier ?? null, match: one.match })),
    };
  });
}
