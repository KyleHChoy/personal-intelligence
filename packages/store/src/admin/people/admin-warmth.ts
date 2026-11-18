import type { Timestamp } from "@intelligence/contracts";
import {
  EntityId,
  type OwnerCursor,
  TIERS,
  type Tier,
  type TierSource,
  type WarmthChannel,
  type Who,
} from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import { warmthRules } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query, stamp, stampOrNull } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { hisNames } from "../../identity/person-name-rows.ts";
import { audienceGroups } from "../../identity/warmth-build.ts";
import { rankWarmth } from "../../identity/warmth-days.ts";
import { cursorOf, type OwnerPlace, ownerPage, ownerWithheld } from "../admin-owner.ts";

// The owner's two warmth commands, `pia people tiers` and `pia people warmth`, read-only, as pi_admin,
// ranked at read from the per-label days. Both read the owner's own audience, named in the answer, and
// nothing wider. Nothing here writes, and nothing is logged but by ids.
//
// The reader's filters they keep: the build already leaves out machines and the people the owner's
// ignore rulings covered when it ran; `peopleTiers` also leaves out every group no member of which
// has a name and every group with a member withheld now (`ownerWithheld`: an ignore ruled since the
// build, a Remove's hide, an address of the owner's own), as list_people's row policy would.
// `personWarmth` answers the person the owner names, withheld or not: they asked for that one. No
// held message or release is read.

// One stored row, every field the build wrote.
export type WarmthRowView = {
  entity: EntityId;
  name: string | null;
  members: EntityId[];
  tier: Tier;
  tierSource: TierSource;
  dormant: boolean;
  warmth: number;
  active: number;
  depth: number;
  twoWay: boolean;
  firstTwoWayAt: Timestamp | null;
  lastTwoWayAt: Timestamp | null;
  replyRate: number | null;
  replyHours: number | null;
  theyStart: number | null;
  channels: WarmthChannel[];
  ruleVersion: number;
  builtAt: Timestamp;
  compartments: string[];
};

// The audience read, when one was built: its clearance, its build, and whether a removal emptied
// it since (`rebuilding`).
type WarmthAudienceView = { audience: string[]; builtAt: Timestamp; people: number; rebuilding: boolean };

// `next`: the cursor of the next page, when a limit was given and more rows follow.
export type PeopleTiersView = {
  audience: WarmthAudienceView | null;
  people: WarmthRowView[];
  next: OwnerCursor | null;
};
// Where each row's person works, read in the page's own transaction by the caller's reader
// (admin-people.ts `workplacesIn`), so the rows and their organizations agree.
type Workplaces = (tx: Tx, rows: readonly WarmthRowView[]) => Promise<Map<string, Who>>;
type PersonWarmthView = { audience: WarmthAudienceView | null; person: EntityId; row: WarmthRowView | null };

// Without a limit, every row (the terminal's); with one, a page from `cursor` (the page's).
export type TiersFilter = { tier?: Tier; dormant?: boolean; limit?: number; cursor?: OwnerCursor };

// The newest per-label day build within the owner's audience (core/audience.ts),
// how many labels, and whether a removal emptied one since. One statement.
const BUILD = `
  select max(b.built_at) as built_at, count(*)::int as labels, bool_or(b.removed_at is not null) as removed
  from projections.warmth_day_builds b where b.compartments <@ $1::text[]`;

// The groups among `$1` any member of which has a name under a label within `$2`.
const NAMED = `
  select x.id from unnest($1::text[]) as x (id)
  where exists (select 1 from knowledge.aliases s where s.entity_id = x.id and s.compartments <@ $2::text[])
    or exists (${hisNames("e.id = x.id", " and n.compartments <@ $2::text[]")})
  order by x.id`;

// Each entity's name under a label the keys open ($2): the owner's own for them first, else its
// lowest alias. One row an entity, so only the name read is opened.
const NAMES = `
  select distinct on (s.entity_id) s.entity_id, s.id, s.compartments, s.value_enc, s.his from (
    select x.entity_id, x.id, x.compartments, x.value_enc, true as his
    from (${hisNames("e.id = any ($1::text[])", " and n.compartments <@ $2::text[]")}) x
    union all
    select s.entity_id, s.id, s.compartments, s.value_enc, false from knowledge.aliases s
    where s.entity_id = any ($1::text[]) and s.compartments <@ $2::text[]
  ) s
  order by s.entity_id, s.his desc, s.id`;

type Row = {
  entity_id: string;
  members: string[];
  tier: Tier;
  tier_source: TierSource;
  dormant: boolean;
  warmth: number | string;
  active: number | string;
  depth: number | string;
  two_way: boolean;
  first_two_way_at: Date | null;
  last_two_way_at: Date | null;
  reply_rate: number | string | null;
  reply_hours: number | string | null;
  they_start: number | string | null;
  channels: WarmthChannel[];
  rule_version: number;
  built_at: Date;
  compartments: string[];
};

const orNull = (value: number | string | null): number | null => (value === null ? null : Number(value));

// The owner's audience and its newest day build, or null before the first. `people` is the labels built.
export async function ownerBuild(query: Query): Promise<WarmthAudienceView | null> {
  const audience = await ownerAudience(query);
  if (audience.length === 0) return null;
  const [build] = await query<{ built_at: Date | null; labels: number; removed: boolean | null }>(BUILD, [audience]);
  return build?.built_at === null || build === undefined
    ? null
    : { audience, builtAt: stamp(build.built_at), people: build.labels, rebuilding: build.removed === true };
}

// The owner's whole ranking, ranked at read (identity/warmth-days.ts rankWarmth) by the groups of
// their audience's rulings, one row a person, in id order. None while
// `rebuilding`.
export async function ownerRows(tx: Tx, audience: WarmthAudienceView, now: Date): Promise<Row[]> {
  if (audience.rebuilding) return [];
  const groups = await audienceGroups(tx.query, audience.audience);
  const ranked = await rankWarmth(tx, { kind: "owner" }, audience.audience, groups, { today: now });
  if (ranked === "rebuilding") return [];
  const builtAt = new Date(audience.builtAt);
  const at = (value: string | null): Date | null => (value === null ? null : new Date(value));
  return [...ranked.values()]
    .map((row) => ({
      ...row,
      first_two_way_at: at(row.first_two_way_at),
      last_two_way_at: at(row.last_two_way_at),
      rule_version: warmthRules().version,
      built_at: builtAt,
    }))
    .sort((a, b) => byText(a.entity_id, b.entity_id));
}

// The owner's rows ranked at read, none before a build: for the counts that read them whole.
export async function ownerWarmthRows(tx: Tx, now: Date): Promise<Row[]> {
  const build = await ownerBuild(tx.query);
  return build === null ? [] : ownerRows(tx, build, now);
}

// Tier order, then the most warmth, then id: TIERS_PAGE's order, as placeOf states a row's place.
const byPlace = (a: Row, b: Row): number => {
  const [x, y] = [placeOf(a), placeOf(b)];
  return x[0] - y[0] || y[1] - x[1] || byText(x[2], y[2]);
};
const pastPlace = (row: Row, after: [number, number, string]): boolean => {
  const [tier, warmth, id] = placeOf(row);
  return tier !== after[0] ? tier > after[0] : warmth !== after[1] ? warmth < after[1] : byText(id, after[2]) > 0;
};

// A row's place in TIERS_PAGE's order: its tier's place from 1, its warmth, its id.
const placeOf = (row: Row): [number, number, string] => [
  TIERS.indexOf(row.tier) + 1,
  Number(row.warmth),
  row.entity_id,
];

// Each row's name, by its group: its own entity's name, the owner's or its lowest alias, else the
// name of its first member by id that has one; the owner's name for any member first. One
// statement, one name opened a row.
export async function namesOf(
  query: Query,
  keys: Keys,
  rows: readonly { entity_id: string; members: readonly string[] }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(rows.flatMap((row) => [row.entity_id, ...row.members]))];
  if (ids.length === 0) return out;
  type Alias = { entity_id: string; id: string; compartments: string[]; value_enc: Sealed; his: boolean };
  const aliases = new Map(
    (await query<Alias>(NAMES, [ids, [...keys.compartments]])).map((row) => [row.entity_id, row]),
  );
  for (const row of rows) {
    const members = [row.entity_id, ...[...row.members].sort(byText)];
    const his = members.flatMap((one) => (aliases.get(one)?.his === true ? [aliases.get(one) as Alias] : []))[0];
    const alias = his ?? aliases.get(row.entity_id) ?? members.flatMap((one) => aliases.get(one) ?? [])[0];
    if (alias === undefined) continue;
    const at = alias.his
      ? { table: "knowledge.person_names", id: alias.id, column: "name_enc" }
      : { table: "knowledge.aliases", id: alias.id, column: "value_enc" };
    out.set(row.entity_id, openedUnder(keys, alias.compartments, at, alias.value_enc));
  }
  return out;
}

const viewOf = (row: Row, names: ReadonlyMap<string, string>): WarmthRowView => ({
  entity: row.entity_id as EntityId,
  name: names.get(row.entity_id) ?? null,
  members: [...row.members].sort(byText) as EntityId[],
  tier: row.tier,
  tierSource: row.tier_source,
  dormant: row.dormant,
  warmth: Number(row.warmth),
  active: Number(row.active),
  depth: Number(row.depth),
  twoWay: row.two_way,
  firstTwoWayAt: stampOrNull(row.first_two_way_at),
  lastTwoWayAt: stampOrNull(row.last_two_way_at),
  replyRate: orNull(row.reply_rate),
  replyHours: orNull(row.reply_hours),
  theyStart: orNull(row.they_start),
  channels: row.channels,
  ruleVersion: row.rule_version,
  builtAt: stamp(row.built_at),
  compartments: row.compartments,
});

// `pia people tiers`: the owner's view in tier order, then warmth, filtered; every row without a limit,
// and a page from the cursor with one. A cursor the server did not issue is refused
// `invalid_argument`.
export async function peopleTiers(
  context: AdminContext,
  filter: TiersFilter,
  workplaces: Workplaces,
): Promise<PeopleTiersView & { people: (WarmthRowView & { organization: Who | null })[] }> {
  const after = filter.cursor === undefined ? null : afterOf(filter.cursor);
  return context.transaction(async (query) => {
    const audience = await ownerBuild(query);
    if (audience === null) return { audience, people: [], next: null };
    const withheld = await ownerWithheld(query);
    const all = (await ownerRows({ query, keys: context.keys }, audience, context.now())).filter(
      (row) =>
        (filter.tier === undefined || row.tier === filter.tier) &&
        (filter.dormant === undefined || row.dormant === filter.dormant) &&
        !row.members.some((one) => withheld.has(one)) &&
        (after === null || pastPlace(row, after)),
    );
    const within = audience.audience.filter((one) => context.keys.compartments.has(one));
    const named = new Set(
      (await query<{ id: string }>(NAMED, [all.flatMap((row) => row.members), within])).map((row) => row.id),
    );
    const sorted = all.filter((row) => row.members.some((one) => named.has(one))).sort(byPlace);
    const rows = filter.limit === undefined ? sorted : sorted.slice(0, filter.limit + 1);
    const page = filter.limit === undefined ? rows : rows.slice(0, filter.limit);
    const last = page.at(-1);
    const names = await namesOf(query, context.keys, page);
    const people = page.map((row) => viewOf(row, names));
    const next = rows.length > page.length && last !== undefined ? cursorOf(placeOf(last)) : null;
    // While a removal empties the build, no row names a workplace.
    const works = audience.rebuilding
      ? new Map<string, Who>()
      : await workplaces({ query, keys: context.keys }, people);
    return { audience, people: people.map((row) => ({ ...row, organization: works.get(row.entity) ?? null })), next };
  });
}

// A tiers cursor's place, as placeOf made it.
function afterOf(cursor: OwnerCursor): [number, number, string] {
  const fits = ([tier, warmth, id, ...rest]: OwnerPlace): boolean =>
    rest.length === 0 &&
    Number.isInteger(tier) &&
    (tier as number) >= 1 &&
    (tier as number) <= TIERS.length &&
    typeof warmth === "number" &&
    warmth >= 0 &&
    EntityId.safeParse(id).success;
  const [tier, warmth, id] = ownerPage({ cursor }, fits).after ?? [];
  return [tier as number, warmth as number, id as string];
}

// `pia people warmth <person>`: one person's stored row in the owner's whole view, by entity id or by
// address; the row of the group the person was in when it was built. Throws AdminError
// "not_found" for an address no person holds.
export function personWarmth(context: AdminContext, person: string): Promise<PersonWarmthView> {
  return context.transaction(async (query) => {
    let id: string | undefined;
    if (EntityId.safeParse(person).success) id = person;
    else {
      const address = normalizeAddress(person);
      if (address === null) throw new AdminError("not_found");
      const [holder] = await query<{ entity_id: string }>(
        "select a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 and e.kind = 'person' order by a.id limit 1",
        [fingerprint(context.keys, "address", address)],
      );
      id = holder?.entity_id;
    }
    if (id === undefined) throw new AdminError("not_found");
    const audience = await ownerBuild(query);
    if (audience === null) return { audience, person: id as EntityId, row: null };
    const row = (await ownerRows({ query, keys: context.keys }, audience, context.now())).find((one) =>
      one.members.includes(id as string),
    );
    const names = await namesOf(query, context.keys, row === undefined ? [] : [row]);
    return { audience, person: id as EntityId, row: row === undefined ? null : viewOf(row, names) };
  });
}
