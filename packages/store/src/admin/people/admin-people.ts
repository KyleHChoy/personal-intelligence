import {
  ClaimRecord,
  dayIn,
  type EntityId,
  type FactId,
  type OwnerTimeline,
  type OwnerTimelineArgs,
  type OwnerTimelineEntry,
  type PersonPanel,
  type RulingId,
  type Tier,
  type Who,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import { dueLapsed, lastStood } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { OWNER_ENTITY_FIRST, PERSON_OR_ORG_KINDS, SOURCE_NOT_HELD } from "../../core/statements.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { RELEASE_IN_FORCE } from "../../core/visibility.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { OWNER_REOPENS, reopenedAtOf } from "../../read/read-beliefs.ts";
import type { ClientGroups } from "../../read/read-ctx.ts";
import { type GroupRulingRow, groupsFromRows } from "../../read/read-groups.ts";
import { groupLine } from "../../read/read-warmth.ts";
import { cursorOf, fitsPlace, ownerBeliefs, ownerPage, ownerWho, ownerWithheld } from "../admin-owner.ts";
import { captureTitle } from "../search/admin-items.ts";
import { claimWords } from "../search/admin-search-items.ts";
import { personPanelLead } from "./admin-person-lead.ts";
import {
  ownerBuild,
  ownerWarmthRows,
  type PeopleTiersView,
  peopleTiers,
  type TiersFilter,
  type WarmthRowView,
} from "./admin-warmth.ts";

// The people reads of the owner's dashboard, as pi_admin, inside the owner's audience
// (`ownerAudience`), beliefs only through `ownerBeliefs`, people named by `ownerWho`. Nothing here
// writes, and nothing is logged.
//
// While the owner's audience has no build, or a removal emptied their warmth build since, a read
// refuses `rebuilding` (AdminError), which the page shows as that state.
//
// The reader's filters each keeps, stated in its own SQL: every row within the owner's audience; no
// held message or document; a released claim only while its release is in force; no claim naming
// an entity that is gone. The graph (network, expand, paths) also leaves out every withheld person
// and organization (`ownerWithheld`); the panel and the timeline answer the one the owner names,
// withheld or not, as `pia people warmth` does: they asked for that one.
//
// The owner's network graph is in admin-people-graph.ts, and the map and path views over it in
// admin-people-network.ts; both stand on the audiences, groups and statements here.

// ---------------------------------------------------------------------------------------------
// The shared foundation: the owner's warmth build and their groups.
// ---------------------------------------------------------------------------------------------

const rebuilding = (): AdminError => new AdminError("rebuilding");

// The audiences the reads stand on: the owner's belief audience and their warmth build's. Either
// missing, or the build emptied by a removal, is `rebuilding`.
export async function audiences(query: Query): Promise<{ beliefs: string[]; warmth: string[] }> {
  const beliefs = await ownerAudience(query);
  const build = await ownerBuild(query);
  if (beliefs.length === 0 || build === null || build.rebuilding) throw rebuilding();
  return { beliefs, warmth: build.audience };
}

// The owner's groups, by their identity rulings in force within the warmth build's audience: the
// rulings the build grouped its rows by (warmth-build.ts), so a row's members are its group's.
const RULINGS = `
  select r.verdict, r.a_fp, r.b_fp,
    array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
          where a.value_fp = r.a_fp and a.compartments <@ $1::text[] order by a.entity_id) as a_people,
    array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
          where a.value_fp = r.b_fp and a.compartments <@ $1::text[] order by a.entity_id) as b_people
  from knowledge.identity_rulings r
  where r.lifted_at is null and r.verdict in ('same', 'shared')
  order by r.a_fp, r.b_fp nulls first, r.verdict`;

export const groupsIn = async (query: Query, audience: readonly string[]): Promise<ClientGroups> =>
  groupsFromRows(await query<GroupRulingRow>(RULINGS, [audience]));

// The entities one person's group holds, as the person panel counts them; the person alone while no
// warmth build stands.
export async function groupMembers(query: Query, entity: string): Promise<string[]> {
  const build = await ownerBuild(query);
  return build === null ? [entity] : (await groupsIn(query, build.audience)).membersOf(entity);
}

// The entities one person's group holds by the owner's identity rulings in force now, within their
// audience: what the owner's name for them is written over, so a join made since the last warmth
// build is named too.
export async function currentGroupMembers(query: Query, entity: string): Promise<string[]> {
  return (await groupsIn(query, await ownerAudience(query))).membersOf(entity);
}

// The supporting claims a link may cite, newest first: within the owner's audience, from a message or a
// document that is not held, or a finding's record that is unflagged, a release in force, and
// naming only people and organizations (find_paths' CLAIMS, stated as pi_admin).
export const CLAIMS = `
  select c.id from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  where c.id = any ($1::text[]) and c.compartments <@ $2::text[]
    and ${RELEASE_IN_FORCE}
    and (${SOURCE_NOT_HELD}
      or (m.id is null and d.id is null and exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is null)))
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id
        and not exists (select 1 from knowledge.entities e where e.id = n.entity_id and e.kind in ('person', 'organization')))
  order by c.valid_from desc, c.id collate "C" desc`;

// The organizations the cited claims of an affiliation name, when its belief names its organization
// by name only (a saved contact's, an import's), as get_entity's organizations read them.
export const CLAIM_ORGANIZATIONS = `
  select n.claim_id, n.entity_id from knowledge.claim_entities n
  join knowledge.entities e on e.id = n.entity_id and e.kind = 'organization'
  where n.claim_id = any ($1::text[])
  order by n.claim_id, n.entity_id`;

// The fact keys of the affiliation claims, within the owner's audience, that name one of the people
// given.
const AFFILIATION_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  join knowledge.claim_entities n on n.claim_id = c.id
  where c.type = 'affiliation' and c.compartments <@ $1::text[] and n.entity_id = any ($2::text[])
  order by c.fact_key_fp`;

// An affiliation the owner works at; one stating no relation counts.
const WORKS: ReadonlySet<string> = new Set(["employee", "founder", "owner", "contractor"]);

// An affiliation is found by a claim naming the person (claim_entities), as the extraction writes
// every subject. An address on an organization's domain is no belief, and names none. Keyed by each
// row's entity; a person with none is left out.
export async function workplacesIn(
  tx: Tx,
  people: readonly { entity: string; members: readonly string[] }[],
): Promise<Map<string, Who>> {
  const { query } = tx;
  const rowOf = new Map(people.flatMap((row) => [row.entity, ...row.members].map((id) => [id, row.entity] as const)));
  const audience = rowOf.size === 0 ? [] : await ownerAudience(query);
  if (audience.length === 0) return new Map();
  const keys = (await query<{ fact_key_fp: string }>(AFFILIATION_KEYS, [audience, [...rowOf.keys()]])).map(
    (row) => row.fact_key_fp,
  );
  if (keys.length === 0) return new Map();
  const withheld = await ownerWithheld(query);
  const current = (await ownerBeliefs(tx, keys)).flatMap((one) => {
    const { belief } = one;
    const row = rowOf.get(belief.subject as string);
    const relation = belief.values.relation;
    if (
      row === undefined ||
      withheld.has(belief.subject as string) ||
      belief.kind !== "affiliation" ||
      (belief.status !== "active" && belief.status !== "stale") ||
      belief.disputed
    )
      return [];
    if (typeof relation === "string" && !WORKS.has(relation)) return [];
    const organization = belief.values.organization;
    return [{ row, organization: typeof organization === "string" ? organization : null, support: one.support }];
  });
  const order = (
    await query<{ id: FactId }>(CLAIMS, [[...new Set(current.flatMap((one) => one.support))], audience])
  ).map((row) => row.id);
  const place = new Map(order.map((id, index) => [id as string, index]));
  const byName = current
    .filter((one) => one.organization === null)
    .flatMap((one) => one.support.filter((id) => place.has(id)));
  const named = new Map<string, string[]>();
  for (const row of byName.length === 0
    ? []
    : await query<{ claim_id: string; entity_id: string }>(CLAIM_ORGANIZATIONS, [byName]))
    named.set(row.claim_id, [...(named.get(row.claim_id) ?? []), row.entity_id]);
  const organizations = new Set(
    (
      await query<{ id: string; kind: string }>(PERSON_OR_ORG_KINDS, [
        [
          ...new Set([
            ...current.flatMap((one) => (one.organization === null ? [] : [one.organization])),
            ...[...named.values()].flat(),
          ]),
        ],
      ])
    ).flatMap((row) => (row.kind === "organization" ? [row.id] : [])),
  );
  const best = new Map<string, { organization: string; rank: number }>();
  for (const one of current) {
    const cited = one.support
      .filter((id) => place.has(id))
      .sort((x, y) => (place.get(x) as number) - (place.get(y) as number));
    const latest = cited[0];
    const organization = one.organization ?? cited.map((id) => named.get(id)).find((ids) => ids?.length === 1)?.[0];
    if (
      latest === undefined ||
      organization === undefined ||
      !organizations.has(organization) ||
      withheld.has(organization)
    )
      continue;
    const rank = place.get(latest) as number;
    const was = best.get(one.row);
    if (was === undefined || rank < was.rank || (rank === was.rank && organization < was.organization))
      best.set(one.row, { organization, rank });
  }
  const who = await ownerWho(tx, [...new Set([...best.values()].map((one) => one.organization))]);
  return new Map(
    [...best].flatMap(([row, { organization }]) => {
      const named = who.get(organization);
      return named === undefined ? [] : [[row, named] as const];
    }),
  );
}

// The fingerprints of the group's addresses within the owner's audience.
const FPS =
  "select distinct a.value_fp from knowledge.accounts a where a.entity_id = any ($1::text[]) and a.compartments <@ $2::text[] order by a.value_fp";
const DOMAIN_FPS =
  "select distinct a.domain_fp from knowledge.accounts a where a.entity_id = any ($1::text[]) and a.compartments <@ $2::text[] and a.domain_fp is not null order by a.domain_fp";

// The owner's tier ruling in force on any of them, the newest.
const RULED_TIER = `
  select r.tier from knowledge.tier_rulings r
  where r.lifted_at is null and r.value_fps && $1::text[]
  order by r.created_at desc, r.ruling_id collate "C" desc
  limit 1`;

// The owner's identity rulings in force on any of them, oldest first.
const IDENTITY_RULINGS = `
  select r.ruling_id from knowledge.identity_rulings r
  where r.lifted_at is null and (r.a_fp = any ($1::text[]) or r.b_fp = any ($1::text[]))
  order by r.created_at, r.ruling_id collate "C"`;

// The owner's ignore ruling in force that covers the person, by address, by domain or by an address
// a domain ruling was narrowed to, or the owner's Remove's hide of a member of their group ($3): a
// Remove first, so the panel's Bring back lifts that Remove, then the newest.
const IGNORE_RULING = `
  select t.ruling_id from (
    select r.ruling_id, r.created_at, exists (select 1 from knowledge.person_hides h where h.ruling_id = r.ruling_id) as hide from knowledge.ignore_rulings r
    where r.lifted_at is null
      and ((r.subject = 'address' and r.value_fps && $1::text[])
        or (r.subject = 'domain' and (r.value_fps && $2::text[] or r.address_fps && $1::text[])))
    union
    select h.ruling_id, h.created_at, true from knowledge.person_hides h where h.lifted_at is null and h.entity_ids && $3::text[]
  ) t
  order by t.hide desc, t.created_at desc, t.ruling_id collate "C" desc
  limit 1`;

// The fact keys of the commitment claims naming a member, within the owner's audience.
const COMMITMENT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
  where c.type = 'commitment' and n.entity_id = any ($1::text[]) and c.compartments <@ $2::text[]
  order by c.fact_key_fp`;

// The owner's name for them in force: the row the reads name them by, the lowest id.
const NAME_RULING =
  "select n.ruling_id from knowledge.person_names n where n.lifted_at is null and (n.entity_ids && $1::text[] or n.value_fps && $2::text[]) order by n.id limit 1";

// The panel's header and figures: who, the warmth line of the person's group, the owner's tier
// ruling, the open commitments each way, and the owner's identity, ignore and name rulings on the
// person. Null for an id that is no person.
export function person(context: AdminContext, entity: EntityId): Promise<PersonPanel | null> {
  return context.transaction(async (query) => {
    const tx = { query, keys: context.keys };
    const [found] = await query<{ id: string; kind: string }>(PERSON_OR_ORG_KINDS, [[entity]]);
    if (found?.kind !== "person") return null;
    const audience = await audiences(query);
    const groups = await groupsIn(query, audience.warmth);
    const members = groups.membersOf(entity);
    const rows = (await ownerWarmthRows(tx, context.now())).filter((row) =>
      row.members.some((one) => members.includes(one)),
    );
    const fps = (await query<{ value_fp: string }>(FPS, [members, audience.beliefs])).map((row) => row.value_fp);
    const domains = (await query<{ domain_fp: string }>(DOMAIN_FPS, [members, audience.beliefs])).map(
      (row) => row.domain_fp,
    );
    const [ruled] = fps.length === 0 ? [] : await query<{ tier: Tier }>(RULED_TIER, [fps]);
    const identity = fps.length === 0 ? [] : await query<{ ruling_id: RulingId }>(IDENTITY_RULINGS, [fps]);
    const [ignore] = await query<{ ruling_id: RulingId }>(IGNORE_RULING, [fps, domains, members]);
    const [named] = await query<{ ruling_id: RulingId }>(NAME_RULING, [members, fps]);

    const [owner] = await query<{ id: string }>(OWNER_ENTITY_FIRST);
    const mine = new Set(members);
    const keys = (await query<{ fact_key_fp: string }>(COMMITMENT_KEYS, [members, audience.beliefs])).map(
      (row) => row.fact_key_fp,
    );
    const commitments = { owedByOwner: 0, owedToOwner: 0 };
    const now = context.now();
    const zone = await ownerZoneOf(query);
    const reopened = reopenedAtOf(await query<{ fact_fp: string; at: string }>(OWNER_REOPENS, [keys]));
    for (const { belief, factKey } of await ownerBeliefs(tx, keys)) {
      if (belief.kind !== "commitment" || (belief.status !== "active" && belief.status !== "stale")) continue;
      const due = belief.values.due === undefined ? null : String(belief.values.due);
      if (dueLapsed(due, lastStood(belief.lastConfirmedAt, reopened.get(factKey)), now, zone)) continue;
      const counterparty = typeof belief.values.counterparty === "string" ? belief.values.counterparty : null;
      if (belief.subject === owner?.id && counterparty !== null && mine.has(counterparty)) commitments.owedByOwner += 1;
      else if (mine.has(belief.subject as string) && counterparty === owner?.id) commitments.owedToOwner += 1;
    }
    const who = (await ownerWho(tx, [entity])).get(entity) ?? {
      id: entity,
      kind: "person" as const,
      name: null,
      address: null,
    };
    return {
      who,
      warmth: groupLine(rows, members) ?? null,
      ruledTier: ruled?.tier ?? null,
      commitments,
      lead: await personPanelLead(tx, members, audience.beliefs, context.now()),
      identityRulings: identity.map((row) => row.ruling_id),
      ignoreRuling: ignore?.ruling_id ?? null,
      nameRuling: named?.ruling_id ?? null,
    };
  });
}

// Every statement takes the group's members ($1), the owner's audience ($2), the cursor's place ($3 its
// time in milliseconds, $4 its id), now ($5, milliseconds) and how many to read ($6), and answers
// newest first: time to the millisecond, then id under "C", both descending.
const ms = (column: string): string => `date_trunc('milliseconds', ${column})`;
const before = (at: string, id: string): string =>
  `${ms(at)} <= to_timestamp($5::float8 / 1000) and ($3::float8 is null or (${ms(at)}, ${id} collate "C") < (to_timestamp($3::float8 / 1000), $4::text collate "C"))`;
const newest = (id: string): string => `order by 2 desc, ${id} collate "C" desc limit $6`;

// Mail with a row for a member, never a held one.
const MAIL = `
  select m.id, ${ms("m.sent_at")} as at, m.subject_enc as value_enc, m.compartments from knowledge.messages m
  where m.evidence_id in (select i.evidence_id from knowledge.interaction_log i where i.entity_id = any ($1::text[]))
    and not m.held and m.compartments <@ $2::text[] and ${before("m.sent_at", "m.id")}
  ${newest("m.id")}`;

// Calendar events a member takes part in, cancelled ones included, as get_timeline's.
const MEETINGS = `
  select v.id, ${ms("v.occurred_at")} as at, d.title_enc as value_enc, d.compartments from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where v.id in (select p.event_id from knowledge.event_participants p where p.entity_id = any ($1::text[]) and p.compartments <@ $2::text[])
    and v.compartments <@ $2::text[] and d.compartments <@ $2::text[] and ${before("v.occurred_at", "v.id")}
  ${newest("v.id")}`;

// Meetings Lens recorded and linked to no event, by the participant claims naming a member, with
// their sealed facts, which hold the title the app or its calendar entry gave.
const CAPTURED = `
  select k.id, ${ms("k.started_at")} as at, k.facts_enc as value_enc, k.compartments from knowledge.captures k
  where k.kind = 'meeting' and k.event_id is null and k.compartments <@ $2::text[]
    and k.evidence_id in (
      select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where c.type = 'capture.person' and n.entity_id = any ($1::text[]) and c.compartments <@ $2::text[])
    and ${before("k.started_at", "k.id")}
  ${newest("k.id")}`;

// iMessage lines with a member, each line once whatever members it names. No text is stored.
const CHAT = `
  select t.id, t.at from (
    select distinct on (l.evidence_id, l.line) l.id, ${ms("l.occurred_at")} as at from knowledge.chat_lines l
    where l.entity_id = any ($1::text[]) and l.compartments <@ $2::text[] and ${before("l.occurred_at", "l.id")}
    order by l.evidence_id, l.line, l.id collate "C"
  ) t
  ${newest("t.id")}`;

// Claims naming a member, as the reader's filters keep them (no held item, no flagged agent record,
// a release in force, no gone entity); not a participant claim, which a meeting entry stands for.
const FACTS = `
  select c.id, ${ms("c.valid_from")} as at, c.content_enc as value_enc, c.compartments from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any ($1::text[]))
    and c.type <> 'capture.person' and c.compartments <@ $2::text[] and ${RELEASE_IN_FORCE}
    and (m.id is null or not m.held) and (d.id is null or not d.held)
    and not exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is not null)
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id and not exists (select 1 from knowledge.entities e where e.id = n.entity_id))
    and ${before("c.valid_from", "c.id")}
  ${newest("c.id")}`;

type TimelineRow = { id: string; at: Date; value_enc?: Sealed; compartments?: string[] };
type Item = { kind: OwnerTimelineEntry["kind"]; id: string; at: number; title: (() => string | null) | null };

// Newest first: time descending, then id descending by code point, as the statements order.
const byNewest = (a: Item, b: Item): number => b.at - a.at || byText(b.id, a.id);

// A person's or an organization's timeline, a month a page, newest first: the month of the newest
// entry after the cursor, at most `limit` of its entries, and `next` while any entry is left, in
// this month or an older one. Each kind reads at most `limit + 1` rows past the cursor, so the page
// is exact. Mail, meeting and recorded meeting titles opened, a mail subject and a recording's
// title masked as find_messages masks a subject; a fact's title its claim's words (so a row says
// what it is), only for the page's entries; its whole text is the fact's own read (`factShow`).
// Null for an id that is neither.
export async function timeline(context: AdminContext, args: OwnerTimelineArgs): Promise<OwnerTimeline | null> {
  const page = ownerPage(
    {
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    },
    fitsPlace,
  );
  return context.transaction(async (query) => {
    const [entity] = await query<{ id: string; kind: "person" | "organization" }>(PERSON_OR_ORG_KINDS, [[args.entity]]);
    if (entity === undefined) return null;
    const audience = await audiences(query);
    const members =
      entity.kind === "person" ? (await groupsIn(query, audience.warmth)).membersOf(entity.id) : [entity.id];
    const now = context.now();
    const values = [
      members,
      audience.beliefs,
      page.after?.[0] ?? null,
      page.after?.[1] ?? null,
      now.getTime(),
      page.limit + 1,
    ];
    const read = (statement: string): Promise<TimelineRow[]> => query<TimelineRow>(statement, values);
    const sealed = (table: string, column: string, row: TimelineRow, mask: boolean) => (): string | null => {
      if (row.value_enc === null || row.value_enc === undefined || row.compartments === undefined) return null;
      const text = openedUnder(context.keys, row.compartments, { table, id: row.id, column }, row.value_enc);
      return mask ? maskCredentials(text).text : text;
    };
    const items: Item[] = [
      ...(await read(MAIL)).map(
        (row): Item => ({
          kind: "mail",
          id: row.id,
          at: row.at.getTime(),
          title: sealed("knowledge.messages", "subject_enc", row, true),
        }),
      ),
      ...(await read(MEETINGS)).map(
        (row): Item => ({
          kind: "meeting",
          id: row.id,
          at: row.at.getTime(),
          title: sealed("knowledge.event_details", "title_enc", row, false),
        }),
      ),
      ...(await read(CAPTURED)).map((row): Item => {
        const readSealed = sealed("knowledge.captures", "facts_enc", row, false);
        return {
          kind: "captured_meeting",
          id: row.id,
          at: row.at.getTime(),
          title: () => {
            try {
              return captureTitle(readSealed() ?? "{}");
            } catch {
              return null;
            }
          },
        };
      }),
      ...(await read(CHAT)).map((row): Item => ({ kind: "imessage", id: row.id, at: row.at.getTime(), title: null })),
      ...(await read(FACTS)).map((row): Item => {
        const readSealed = sealed("knowledge.claims", "content_enc", row, false);
        return {
          kind: "fact",
          id: row.id,
          at: row.at.getTime(),
          title: () => {
            try {
              const words = claimWords(ClaimRecord.parse(JSON.parse(readSealed() ?? "")));
              return words === "" ? null : maskCredentials(words).text;
            } catch {
              return null;
            }
          },
        };
      }),
    ].sort(byNewest);
    const zoneName = await ownerZoneOf(query);
    const monthOf = (at: number): string => dayIn(new Date(at), zoneName).slice(0, 7);
    const month = monthOf(items[0]?.at ?? now.getTime());
    const kept = items.filter((item) => monthOf(item.at) === month).slice(0, page.limit);
    const last = kept.at(-1);
    const entries = kept.map((item): OwnerTimelineEntry => {
      const title = item.title?.() ?? null;
      return {
        kind: item.kind,
        id: item.id,
        at: stamp(new Date(item.at)),
        title: title === null ? null : { untrusted: title },
      };
    });
    return {
      month,
      entries,
      next: items.length > kept.length && last !== undefined ? cursorOf([last.at, last.id]) : null,
    };
  });
}

// `pia people tiers` with where each person works, in the same transaction; null for none, and on
// every row while a removal has emptied the warmth build.
export type PeopleTiersWithWork = Omit<PeopleTiersView, "people"> & {
  people: (WarmthRowView & { organization: Who | null })[];
};
export function peopleTiersWithWork(context: AdminContext, filter: TiersFilter = {}): Promise<PeopleTiersWithWork> {
  return peopleTiers(context, filter, workplacesIn);
}
