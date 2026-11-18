import type { Envelope } from "@intelligence/contracts";
import type {
  EntityId,
  EventId,
  MeetingView,
  SubjectKind,
  UntrustedString,
  Who,
} from "@intelligence/contracts/personal";
import { DAY_MS, isMintedKey, isNamedKey } from "@intelligence/personal-core";
import { byText, stampOrNull } from "../core/db.ts";
import type { ClientGroups } from "../core/read-ctx.ts";
import { type Ctx, noteServed, type Sealed, untrusted } from "../core/read-ctx.ts";
import { served } from "../core/served.ts";
import { PEOPLE_OR_ORGS } from "../core/visibility.ts";
import { hisNames } from "../identity/person-name-rows.ts";
import { organizationNamesOf, orgNamesOf } from "./read-organizations.ts";

// The two shapes every tool returns, each built only from rows the token returned. Every statement
// ends in an order that includes a unique key.

type Owned = Sealed & { entity_id: string };
type Named = Owned & { his: boolean };

// A person's name: the owner's own for them, a live knowledge.person_names row on one of their
// accounts, which outranks every alias; else the alias whose evidence is latest, by the time of the
// message or the event it cites, or the contact's updated_at for a contact's name (contacts and
// identity, "Who"), then by alias id. One row per entity; `his` says which table it is from. A held
// message gives no time, in words as well as by the row policy, so a reader's statement over its
// messages names the hold. With `within`, only rows whose compartments are within `$2` rank: the
// name a client cleared for exactly those compartments would be given. The reader never sends it;
// row-level security does this for a client.
const latestNames = (within: boolean): string => `
  select t.entity_id, t.id, t.compartments, t.value_enc, t.his
  from (
    select s.entity_id, s.id, s.compartments, s.value_enc, s.his,
      row_number() over (partition by s.entity_id order by s.his desc, s.at desc nulls last, s.id) as place
    from (
      select x.entity_id, x.id, x.compartments, x.value_enc, true as his, null::timestamptz as at
      from (${hisNames("e.id = any($1)", within ? " and n.compartments <@ $2::text[]" : "")}) x
      union all
      select s.entity_id, s.id, s.compartments, s.value_enc, false, coalesce(m.sent_at, v.occurred_at, c.updated_at)
      from knowledge.aliases s
      left join knowledge.messages m on m.evidence_id = s.evidence_id and not m.held
      left join knowledge.events v on v.evidence_id = s.evidence_id
      left join knowledge.contacts c on c.evidence_id = s.evidence_id
      where s.entity_id = any($1)${within ? " and s.compartments <@ $2::text[]" : ""}
    ) s
  ) t
  where t.place = 1
  order by t.entity_id, t.id`;
const LATEST_NAMES = latestNames(false);
const LATEST_NAMES_WITHIN = latestNames(true);

// Every account of each entity, lowest id first: the first is its address.
export const ACCOUNTS = `
  select a.entity_id, a.id, a.compartments, a.value_enc
  from knowledge.accounts a
  where a.entity_id = any($1)
  order by a.entity_id, a.id`;

const DOMAINS = `
  select d.entity_id, d.id, d.compartments, d.domain_enc as value_enc
  from knowledge.domains d
  where d.entity_id = any($1)
  order by d.entity_id, d.id`;

// Who each visible person or organization among `ids` is. The owner, and an id the token does
// not show, are left out. An organization's address is its domain and its name, the one
// organizationNamesOf gives. With `fixed`, every statement is sent whatever `ids` holds, so
// the statements of a call do not depend on how many people it names, or of which kind.
// With `within`, names are ranked among the aliases within those compartments only.
export async function whoOf(
  ctx: Ctx,
  ids: string[],
  options?: { fixed?: true; within?: readonly string[] },
): Promise<Map<string, Who>> {
  const who = new Map<string, Who>();
  const fixed = options?.fixed === true;
  if (ids.length === 0 && !fixed) return who;
  const entities = await ctx.run<{ id: string; kind: SubjectKind }>(PEOPLE_OR_ORGS, [ids]);
  const people = entities.filter((one) => one.kind === "person").map((one) => one.id);
  const organizations = entities.filter((one) => one.kind === "organization").map((one) => one.id);
  const names =
    people.length === 0 && !fixed
      ? []
      : options?.within === undefined
        ? await ctx.run<Named>(LATEST_NAMES, [people])
        : await ctx.run<Named>(LATEST_NAMES_WITHIN, [people, [...options.within]]);
  const accounts = people.length === 0 && !fixed ? [] : await ctx.run<Owned>(ACCOUNTS, [people]);
  const domains = organizations.length === 0 && !fixed ? [] : await ctx.run<Owned>(DOMAINS, [organizations]);
  // An organization's name, when one is known; its address is its domain.
  const named =
    organizations.length === 0 && !fixed
      ? new Map<string, UntrustedString>()
      : await organizationNamesOf(ctx, organizations, options?.within);
  const byName =
    organizations.length === 0 && !fixed
      ? new Map<string, { name: UntrustedString; evidence: string }>()
      : await orgNamesOf(ctx, organizations, options?.within);

  for (const { id, kind } of entities) who.set(id, { id: id as EntityId, kind, name: null, address: null });
  const keyedByName = new Map<string, boolean>();
  // Each entity's first row, by id, and no other is opened.
  const set = (rows: Owned[], field: "name" | "address", table: string, column: string): void => {
    for (const row of [...rows].sort((a, b) => byText(a.id, b.id))) {
      const one = who.get(row.entity_id);
      if (one === undefined || one[field] !== null) continue;
      const value = untrusted(ctx, table, column, row);
      if (table === "knowledge.accounts")
        keyedByName.set(row.entity_id, (keyedByName.get(row.entity_id) ?? true) && isNamedKey(value.untrusted));
      // A confirmed proposal's key is no address.
      if (field === "address" && isMintedKey(value.untrusted)) continue;
      one[field] = value;
    }
  };
  set(
    names.filter((row) => row.his),
    "name",
    "knowledge.person_names",
    "name_enc",
  );
  set(
    names.filter((row) => !row.his),
    "name",
    "knowledge.aliases",
    "value_enc",
  );
  set(accounts, "address", "knowledge.accounts", "value_enc");
  set(domains, "address", "knowledge.domains", "domain_enc");
  // A named person: a person with no address whose every account is a `profile:named/` key, so
  // every account was opened.
  for (const [id, named] of keyedByName) {
    const one = who.get(id);
    if (named && one?.kind === "person" && one.address === null) one.nameOnly = true;
  }
  for (const [id, name] of named) {
    const one = who.get(id);
    if (one !== undefined) one.name = name;
  }
  // The item its name came from goes into the call's read log (ctx.served) when the name is served.
  for (const [id, { name, evidence }] of byName) {
    const one = who.get(id);
    if (one === undefined || one.address !== null) continue;
    one.nameOnly = true;
    if (one.name !== null) continue;
    one.name = name;
    noteServed(ctx, { shown: [evidence] });
  }
  return who;
}

// An event with its details, as a tool's query selects it.
export type MeetingRow = {
  id: string;
  occurred_at: Date;
  starts_at: Date | null;
  ends_at: Date | null;
  all_day: boolean;
  cancelled: boolean;
  owner_response: NonNullable<MeetingView["response"]> | null;
  title_enc: Envelope | null;
  compartments: string[];
  evidence_id: string;
};

// The columns of a MeetingRow, from `knowledge.events v` and `knowledge.event_details d`.
export const MEETING_COLUMNS =
  "v.id, v.occurred_at, d.starts_at, d.ends_at, d.all_day, d.cancelled, d.owner_response, d.title_enc, d.compartments, v.evidence_id";

// One event by id, cancelled or not. A hidden id and an absent one return no row alike.
export const EVENT = `
  select ${MEETING_COLUMNS}
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where v.id = $1
  order by v.id`;

// The organizer first, then by entity id.
const PARTICIPANTS = `
  select p.event_id, p.entity_id, p.participant_role = 'organizer' as organizer
  from knowledge.event_participants p
  where p.event_id = any($1)
  order by p.event_id, organizer desc, p.entity_id`;

// Each event as a MeetingView. Its participants are the visible participant rows whose entity is
// visible; the owner is never one. With `groups`, a group is one participant, named by its id, and
// in the place of its first member: the organizer's when either is. An all-day event's days: its
// first, the UTC date of its stored start, and its last, the day before its end, which the calendar
// gives as the day after. Null without a start.
export function daysOf(starts: Date | null, ends: Date | null): { date: string; lastDate: string } | null {
  if (starts === null) return null;
  const date = starts.toISOString().slice(0, 10);
  const last =
    ends === null || ends.getTime() - DAY_MS < starts.getTime()
      ? date
      : new Date(ends.getTime() - DAY_MS).toISOString().slice(0, 10);
  return { date, lastDate: last };
}

// `instants`: an all-day event keeps its stored instants, as the Lens mirror serves it; every other
// caller is served its days.
export async function meetingsOf(
  ctx: Ctx,
  rows: MeetingRow[],
  groups?: ClientGroups,
  options: { instants?: boolean } = {},
): Promise<Map<string, MeetingView>> {
  const meetings = new Map<string, MeetingView>();
  if (rows.length === 0) return meetings;
  const listed = await ctx.run<{ event_id: string; entity_id: string }>(PARTICIPANTS, [rows.map((row) => row.id)]);
  const seen = new Set<string>();
  const participants = listed.flatMap((one) => {
    const entity = groups === undefined ? one.entity_id : groups.idOf(one.entity_id);
    const key = `${one.event_id} ${entity}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ event_id: one.event_id, entity_id: entity }];
  });
  const who = await whoOf(ctx, [...new Set(participants.map((one) => one.entity_id))]);
  for (const row of rows) {
    const days = row.all_day && options.instants !== true ? daysOf(row.starts_at, row.ends_at) : null;
    meetings.set(row.id, {
      id: row.id as EventId,
      title: row.title_enc === null ? null : served(ctx, row, "knowledge.event_details.title_enc"),
      startsAt: days === null ? stampOrNull(row.starts_at) : null,
      endsAt: days === null ? stampOrNull(row.ends_at) : null,
      allDay: row.all_day,
      ...(days ?? {}),
      cancelled: row.cancelled,
      participants: participants.flatMap((one) => (one.event_id === row.id ? (who.get(one.entity_id) ?? []) : [])),
      ...(row.owner_response === null ? {} : { response: row.owner_response }),
    });
  }
  return meetings;
}
