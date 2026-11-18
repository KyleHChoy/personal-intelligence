import type { Belief } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  ClaimRecord,
  type EntityId,
  OWNER_PAGE_DEFAULT,
  OWNER_PAGE_MOST,
  type OwnerCursor,
  type OwnerPageArgs,
  type UntrustedString,
  type Who,
} from "@intelligence/contracts/personal";
import { beliefAt } from "@intelligence/personal-beliefs";
import { isMintedKey, isNamedKey } from "@intelligence/personal-core";
import { AdminError } from "../core/admin-error.ts";
import { readTime } from "../core/answer-time.ts";
import { ownerAudience } from "../core/audience.ts";
import { byText, type Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import type { Sealed } from "../core/seal.ts";
import { open } from "../core/seal.ts";
import { OWN_CONTACT_CLAIM, PERSON_OR_ORG_KINDS, SOURCE_NOT_HELD } from "../core/statements.ts";
import { openedUnder, type Tx } from "../core/tx.ts";
import { RELEASE_IN_FORCE } from "../core/visibility.ts";
import { hisNames } from "../identity/person-name-rows.ts";
import { readBeliefInputsUnder } from "../pipeline/belief-inputs.ts";
import { beliefId, storedBelief } from "../pipeline/pipeline-beliefs.ts";

// The foundation every owner read shares. Each owner read runs as pi_admin, whose row policies
// return every row, so it reads inside the owner's one audience (`ownerAudience`), gets beliefs
// only through `ownerBeliefs`, states in its own SQL the filters pi_reader's policies would have
// applied (the fragments below), pages (`ownerPage`, `pageOf`) and names people and organizations
// with one batched lookup (`ownerWho`). No reader statement runs here, as a structure test checks.
// Nothing here writes, and nothing is logged.

// A claim's record, its row opened under every one of its compartments with the key file.
export const claimRecordUnder = (keys: Keys, row: { id: string; compartments: string[]; content_enc: Sealed | null }) =>
  ClaimRecord.parse(JSON.parse(open(keys, row, "knowledge.claims.content_enc", "throw")));

// ---------------------------------------------------------------------------------------------
// One owner audience.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// One owner belief source: the one place an owner read gets beliefs. Every belief is computed when
// asked, by `beliefAt` over `policy.belief_inputs_under` under the owner's audience,
// as of now or of `asOf`, so a change in how beliefs are built changes no caller.
// ---------------------------------------------------------------------------------------------

// `id` is the belief's id as a row of it was keyed (pipeline-beliefs.ts `beliefId`); `support` its
// claims' stored ids, the keyed fingerprints of `belief.support`; `tier` its tier (`source` when
// none); `state`, `provenance` and `group` as a reader's item serves them; `phraseClaim` the stored
// id of the claim whose phrase renders it, null for none.
export type OwnerBelief = {
  id: string;
  factKey: string;
  state: string;
  support: string[];
  compartments: string[];
  tier: string;
  provenance: string;
  group: string | null;
  phraseClaim: string | null;
  belief: Belief;
};

// The owner's beliefs of the fact keys given, of every fact key of the claim types given (`{ types }`, a
// narrower read than every belief), or every one of their audience ("all"), by id, computed by `beliefAt`
// from policy.belief_inputs_under (pi_admin's EXECUTE grant on it) under the owner's audience, as of the
// read time (answer-time.ts) or `asOf`: claims by their first-known time, rulings in force then; today's
// identity groups and fact groupings.
export async function ownerBeliefs(
  tx: Tx,
  keys: readonly string[] | "all" | { types: readonly string[] },
  options: { asOf?: string } = {},
): Promise<OwnerBelief[]> {
  if (Array.isArray(keys) && keys.length === 0) return [];
  const audience = await ownerAudience(tx.query);
  if (audience.length === 0) return [];
  const asOf = options.asOf ?? (await readTime(tx.query)).toISOString();
  return beliefsAt(tx, audience, keys, asOf);
}

// policy.belief_inputs_under takes at most this many keys a call.
const INPUTS_MOST = 1000;

// Every fact key of the claim types `$3` among the owner's audience's claims first known by `$2`.
const KEYS_AT = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type = any ($3::text[]) and c.compartments <@ $1::text[] and c.first_known_at <= $2::timestamptz
  order by 1`;

// Each belief of the owner's audience, as `beliefAt` computes it.
async function beliefsAt(
  tx: Tx,
  audience: string[],
  keys: readonly string[] | "all" | { types: readonly string[] },
  asOf: string,
): Promise<OwnerBelief[]> {
  const types = keys === "all" ? BELIEF_TYPES : "types" in keys ? keys.types : null;
  const asked =
    types === null
      ? [...new Set(keys as readonly string[])]
      : (await tx.query<{ fact_key_fp: string }>(KEYS_AT, [audience, asOf, [...types]])).map((row) => row.fact_key_fp);
  const built = new Map<string, OwnerBelief>();
  for (let start = 0; start < asked.length; start += INPUTS_MOST) {
    const some = asked.slice(start, start + INPUTS_MOST);
    const inputs = await readBeliefInputsUnder(tx.query, tx.keys, audience, some, asOf);
    for (const record of beliefAt(inputs, audience, some, asOf)) {
      const id = beliefId(tx, record.factKeyFp, audience);
      const stored = storedBelief(tx, record);
      built.set(id, {
        id,
        factKey: record.factKeyFp,
        state: stored.state,
        support: stored.support,
        compartments: record.compartments,
        tier: stored.tier,
        provenance: record.provenance,
        group: stored.group,
        phraseClaim: stored.phraseClaim,
        belief: record.belief,
      });
    }
  }
  return [...built.values()].sort((a, b) => byText(a.id, b.id));
}

// ---------------------------------------------------------------------------------------------
// The reader's filters, stated, not inherited. pi_reader's policies hide held messages and
// documents, withheld people, ignored entities and releases not in force; pi_admin's return every
// row. An owner read keeps the ones it needs by these fragments, or its own SQL, and says which in
// its comment.
// ---------------------------------------------------------------------------------------------

// The people and organizations the owner's reads leave out, within their audience ($1): the
// branches of policy.withheld_entities(), stated as pi_admin. A person every account of whom is a
// role or bulk address; a person holding one of the owner's addresses; a person an ignore ruling in
// force covers by address, by domain or by an address a domain ruling was narrowed to; a person the
// owner's Remove hid (knowledge.person_hides), whose group the graph and the lists drop whole by
// any member; an organization a domain ruling covers.
const WITHHELD = `
  with live as (select r.subject, r.value_fps, r.address_fps from knowledge.ignore_rulings r where r.lifted_at is null),
  people as (
    select u.entity_id from knowledge.accounts u
    where u.kind in ('role', 'bulk') and u.compartments <@ $1::text[]
      and not exists (select 1 from knowledge.accounts a where a.entity_id = u.entity_id and a.compartments <@ $1::text[] and a.kind in ('email', 'shared'))
    union
    select a.entity_id from knowledge.accounts o join knowledge.entities e on e.id = o.entity_id and e.kind = 'owner'
      join knowledge.accounts a on a.value_fp = o.value_fp
    where o.compartments <@ $1::text[] and a.compartments <@ $1::text[]
    union
    select a.entity_id from live r, unnest(r.value_fps) as f (fp), knowledge.accounts a
    where r.subject = 'address' and a.value_fp = f.fp and a.compartments <@ $1::text[]
    union
    select a.entity_id from live r, unnest(r.value_fps) as f (fp), knowledge.accounts a
    where r.subject = 'domain' and a.domain_fp = f.fp and a.compartments <@ $1::text[]
    union
    select a.entity_id from live r, unnest(r.address_fps) as f (fp), knowledge.accounts a
    where r.subject = 'domain' and a.value_fp = f.fp and a.compartments <@ $1::text[]
    union
    select h.entity_id from knowledge.person_hides r, unnest(r.entity_ids) as h (entity_id) where r.lifted_at is null),
  orgs as (
    select d.entity_id from live r, unnest(r.value_fps) as f (fp), knowledge.domains d
    where r.subject = 'domain' and d.domain_fp = f.fp and d.compartments <@ $1::text[])
  select p.entity_id as id from people p join knowledge.entities e on e.id = p.entity_id and e.kind = 'person'
  union
  select o.entity_id from orgs o join knowledge.entities e on e.id = o.entity_id and e.kind = 'organization'
  order by 1`;

const withheldSets = new WeakMap<Query, Promise<ReadonlySet<string>>>();

// The withheld people and organizations, once per transaction, as `ownerAudience` is.
export function ownerWithheld(query: Query): Promise<ReadonlySet<string>> {
  let withheld = withheldSets.get(query);
  if (withheld === undefined) {
    withheld = ownerAudience(query).then(
      async (audience) => new Set((await query<{ id: string }>(WITHHELD, [audience])).map((row) => row.id)),
    );
    withheldSets.set(query, withheld);
  }
  return withheld;
}

// ---------------------------------------------------------------------------------------------
// Paging. A list read takes a cursor and a limit (default 50, at most 200) and answers
// `next`, null when no more exist. The cursor is the server's: the last row's place in the read's
// order, opaque, base64url. One the server did not issue is refused `invalid_argument`.
// ---------------------------------------------------------------------------------------------

export type OwnerPlace = readonly (string | number)[];
type OwnerPage = { limit: number; after: OwnerPlace | null };
// A dated page's place: a time, then an id.
export const fitsPlace = ([at, id, ...rest]: OwnerPlace): boolean =>
  rest.length === 0 &&
  Number.isInteger(at) &&
  (at as number) >= 0 &&
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 80;

export const cursorOf = (place: OwnerPlace): OwnerCursor => Buffer.from(JSON.stringify(place)).toString("base64url");

// `fits`: whether a decoded place has the shape the read's own places have, so a place of another
// read, or one a client made, is refused rather than compared.
export function ownerPage(args: OwnerPageArgs, fits: (place: OwnerPlace) => boolean): OwnerPage {
  const limit = Math.min(args.limit ?? OWNER_PAGE_DEFAULT, OWNER_PAGE_MOST);
  if (args.cursor === undefined) return { limit, after: null };
  try {
    const place: unknown = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(place) &&
      place.length > 0 &&
      place.every((one) => typeof one === "string" || (typeof one === "number" && Number.isFinite(one))) &&
      fits(place)
    )
      return { limit, after: place };
  } catch {
    // Refused below.
  }
  throw new AdminError("invalid_argument");
}

// Lexical order of two places, element by element: numbers as numbers, text by code point.
export function comparePlaces(a: OwnerPlace, b: OwnerPlace): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return byText(String(x), String(y));
  }
  return 0;
}

// One page of rows a read computed whole and ordered by `placeOf` ascending: those after the
// cursor, at most `limit`, and the cursor of the last when more follow.
export function pageOf<T>(
  rows: readonly T[],
  placeOf: (row: T) => OwnerPlace,
  page: OwnerPage,
): { rows: T[]; next: OwnerCursor | null } {
  const after = page.after;
  const rest = after === null ? rows : rows.filter((row) => comparePlaces(placeOf(row), after) > 0);
  const kept = rest.slice(0, page.limit);
  const last = kept.at(-1);
  return { rows: kept, next: rest.length > page.limit && last !== undefined ? cursorOf(placeOf(last)) : null };
}

// --------------------------------------------------------------------------------------------- Names. Every person
// or organization in an owner read's answer is a `Who`, from one batched lookup of at most eight statements whatever
// the number of ids, each within the owner's audience. As whoOf (read-who.ts) names them for a reader, with its
// filters stated: a person's name is the owner's own for them when the owner gave one, else the alias whose evidence
// is latest, a held message giving it no time; the address is the first account by id, a confirmed proposal's minted
// key skipped; an organization's address is its first domain, and its name the owner's unlifted one, else the
// `organization_name` of the newest role claim about it, else of the newest affiliation claim, from items pi_reader
// would serve (a message or document not held, a page, a capture, an unflagged agent record, the owner's own
// contact, a release in force) and naming no entity that is gone. As whoOf serves them: a person every account of
// whom in the owner's audience is a `profile:named/` key is `nameOnly`; an organization with a name row
// (knowledge.org_names) and no domain in that audience is `nameOnly`, named by that row when nothing else names it.
// The owner, and an id that is no person or organization, are left out. Withheld ids are named too: which rows a
// read shows is its own filter.
// ---------------------------------------------------------------------------------------------

const NAMES = `
  select t.entity_id, t.id, t.compartments, t.value_enc
  from (
    select s.entity_id, s.id, s.compartments, s.value_enc,
      row_number() over (partition by s.entity_id order by coalesce(m.sent_at, v.occurred_at, c.updated_at) desc nulls last, s.id) as place
    from knowledge.aliases s
    left join knowledge.messages m on m.evidence_id = s.evidence_id and not m.held
    left join knowledge.events v on v.evidence_id = s.evidence_id
    left join knowledge.contacts c on c.evidence_id = s.evidence_id
    where s.entity_id = any ($1::text[]) and s.compartments <@ $2::text[]
  ) t
  where t.place = 1
  order by t.entity_id, t.id`;

// The owner's name for a person, live, by their id or an account of theirs, within the owner's
// audience: it outranks every alias. Lowest row first.
const PERSON_NAMES = `${hisNames("e.id = any ($1::text[])", " and n.compartments <@ $2::text[]")}
  order by 1, 2`;

const ACCOUNTS = `
  select a.entity_id, a.id, a.compartments, a.value_enc from knowledge.accounts a
  where a.entity_id = any ($1::text[]) and a.compartments <@ $2::text[]
  order by a.entity_id, a.id`;

const DOMAINS = `
  select d.entity_id, d.id, d.compartments, d.domain_enc as value_enc from knowledge.domains d
  where d.entity_id = any ($1::text[]) and d.compartments <@ $2::text[]
  order by d.entity_id, d.id`;

const ORGANIZATION_NAMES = `
  select d.entity_id, n.id, n.compartments, n.name_enc as value_enc
  from knowledge.organization_names n
  join knowledge.domains d on d.domain_fp = n.domain_fp
  where d.entity_id = any ($1::text[]) and n.lifted_at is null and n.compartments <@ $2::text[]
  order by d.entity_id, n.id, d.id`;

// At most this many role or affiliation claims are opened for each organization, as
// organizationNamesOf's CLAIMS.
const CLAIMS_EACH = 20;

const CLAIM_NAMES = `
  select t.entity_id, t.id, t.compartments, t.content_enc as value_enc
  from (
    select n.entity_id, c.id, c.compartments, c.content_enc,
      row_number() over (partition by n.entity_id order by (c.type = 'role') desc, c.valid_from desc, c.id) as place
    from knowledge.claim_entities n
    join knowledge.claims c on c.id = n.claim_id
    left join knowledge.messages m on m.evidence_id = c.evidence_id
    left join knowledge.documents d on d.evidence_id = c.evidence_id
    left join knowledge.pages g on g.evidence_id = c.evidence_id
    left join knowledge.captures k on k.evidence_id = c.evidence_id
    where n.entity_id = any ($1::text[]) and c.type in ('role', 'affiliation') and c.compartments <@ $2::text[]
      and (${SOURCE_NOT_HELD} or g.id is not null or k.id is not null
        or (m.id is null and d.id is null and g.id is null and k.id is null
          and (c.released or c.evidence_id in (select w.evidence_id from ledger.agent_writes w where w.evidence_id is not null and w.flagged_at is null)
            or ${OWN_CONTACT_CLAIM})))
      and ${RELEASE_IN_FORCE}
      and not exists (
        select 1 from knowledge.claim_entities o
        where o.claim_id = c.id
          and (select e.id from knowledge.entities e where e.id = o.entity_id and e.kind in ('person', 'organization', 'project')) is null)
  ) t
  where t.place <= ${CLAIMS_EACH}
  order by t.entity_id, t.place`;

// A named organization's name rows, lowest id first.
const ORG_NAMES = `
  select o.entity_id, o.id, o.compartments, o.name_enc as value_enc from knowledge.org_names o
  where o.entity_id = any ($1::text[]) and o.compartments <@ $2::text[]
  order by o.entity_id, o.id`;

type NameRow = { entity_id: string; id: string; compartments: string[]; value_enc: Sealed };

export async function ownerWho(tx: Tx, ids: readonly string[]): Promise<Map<string, Who>> {
  const who = new Map<string, Who>();
  if (ids.length === 0) return who;
  const audience = await ownerAudience(tx.query);
  const entities = await tx.query<{ id: string; kind: "person" | "organization" }>(PERSON_OR_ORG_KINDS, [
    [...new Set(ids)],
  ]);
  const people = entities.filter((one) => one.kind === "person").map((one) => one.id);
  const organizations = entities.filter((one) => one.kind === "organization").map((one) => one.id);
  for (const { id, kind } of entities) who.set(id, { id: id as EntityId, kind, name: null, address: null });
  // A row whose compartments the key file lacks names nothing: it is never opened.
  const opens = (row: NameRow): boolean => row.compartments.every((one) => tx.keys.compartments.has(one));
  const open = (table: string, column: string, row: NameRow): string =>
    openedUnder(tx.keys, row.compartments, { table, id: row.id, column }, row.value_enc);
  const set = (rows: NameRow[], field: "name" | "address", value: (row: NameRow) => UntrustedString | null): void => {
    for (const row of rows) {
      const one = who.get(row.entity_id);
      if (one === undefined || one[field] !== null || !opens(row)) continue;
      one[field] = value(row);
    }
  };

  const read = async (statement: string, asked: string[]): Promise<NameRow[]> =>
    asked.length === 0 ? [] : tx.query<NameRow>(statement, [asked, audience]);
  const his = await read(PERSON_NAMES, people);
  const names = await read(NAMES, people);
  const accounts = await read(ACCOUNTS, people);
  const domains = await read(DOMAINS, organizations);
  const owned = await read(ORGANIZATION_NAMES, organizations);
  const claimed = await read(CLAIM_NAMES, organizations);
  const byName = await read(ORG_NAMES, organizations);
  set(his, "name", (row) => ({ untrusted: open("knowledge.person_names", "name_enc", row) }));
  set(names, "name", (row) => ({ untrusted: open("knowledge.aliases", "value_enc", row) }));
  // A person whose every account it opens is a named key.
  const keyedByName = new Map<string, boolean>();
  for (const row of accounts)
    if (opens(row))
      keyedByName.set(
        row.entity_id,
        (keyedByName.get(row.entity_id) ?? true) && isNamedKey(open("knowledge.accounts", "value_enc", row)),
      );
  set(accounts, "address", (row) => {
    const value = open("knowledge.accounts", "value_enc", row);
    return isMintedKey(value) ? null : { untrusted: value };
  });
  set(domains, "address", (row) => ({ untrusted: open("knowledge.domains", "domain_enc", row) }));
  set(owned, "name", (row) => ({ untrusted: open("knowledge.organization_names", "name_enc", row) }));
  set(claimed, "name", (row) => {
    const fields =
      (
        JSON.parse(open("knowledge.claims", "content_enc", row)) as {
          claim?: { content?: { fields?: Record<string, unknown> } };
        }
      ).claim?.content?.fields ?? {};
    const name = typeof fields.organization_name === "string" ? fields.organization_name.trim() : "";
    return fields.organization === row.entity_id && name !== "" ? { untrusted: name } : null;
  });
  for (const [id, named] of keyedByName) {
    const one = who.get(id);
    if (named && one?.kind === "person" && one.address === null) one.nameOnly = true;
  }
  set(byName, "name", (row) => ({ untrusted: open("knowledge.org_names", "name_enc", row) }));
  for (const row of byName) {
    const one = who.get(row.entity_id);
    if (one !== undefined && one.address === null && opens(row)) one.nameOnly = true;
  }
  return who;
}
