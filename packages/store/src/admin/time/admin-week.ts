import { DateOnly } from "@intelligence/contracts";
import {
  type BudgetView,
  dayAfter,
  dayIn,
  type EventId,
  type HypothesisId,
  type LessonsView,
  OWNER_PAGE_MOST,
  type OwnerEvent,
  type SpendToday,
  startOfDay,
  type WeekEvents,
} from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stampOrNull } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { LESSON_CONFIRMED, latestRow } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { daysOf, MEETING_COLUMNS, type MeetingRow } from "../../read/read-who.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { spendOn } from "./admin-ledger.ts";

// The owner's week and their work's settings, each one pi_admin transaction that writes nothing.
// Lessons and the budget are read here only: changing them stays at a terminal ("Never in a
// browser").

const MICRO = 1_000_000;
const usdOf = (micro: string | number | null | undefined): number => Number(micro ?? 0) / MICRO;

// The most days one call may span, so the answer stays within one page.
const WEEK_EVENTS_DAYS = 31;
const EVENTS_MOST = 200;
// An all-day event's stored days are UTC midnights: asked for this much wider at each end, the
// widest a zone is from UTC, and kept by its days, as selfOf does.
const ZONE_REACH_MS = 14 * 60 * 60 * 1000;

// No agent read selects these columns: MEETING_COLUMNS, which every reader statement uses, does not name them.
export const EVENT_LINK_COLUMNS = "d.call_link_enc, d.invite_link_enc";
export type EventLinkRow = { call_link_enc: unknown; invite_link_enc: unknown };

// The links of an event row, each opened under the row's label and served as the source's untrusted
// text; absent where the row holds none. The server makes no link: the page links one only when its
// host is on the page's fixed list.
export function eventLinks(
  keys: AdminContext["keys"],
  row: Pick<MeetingRow, "id" | "compartments"> & EventLinkRow,
): Pick<OwnerEvent, "callLink" | "inviteLink"> {
  const open = (column: "call_link_enc" | "invite_link_enc") => {
    const sealed = row[column];
    if (sealed === null || sealed === undefined) return undefined;
    const coordinate = { table: "knowledge.event_details", id: row.id, column };
    return { untrusted: openedUnder(keys, row.compartments, coordinate, sealed) };
  };
  const [callLink, inviteLink] = [open("call_link_enc"), open("invite_link_enc")];
  return { ...(callLink === undefined ? {} : { callLink }), ...(inviteLink === undefined ? {} : { inviteLink }) };
}

// An event and its details within the compartments the key file holds but a restricted one, as work
// time reads; not cancelled, as get_self serves the coming week. Events hold no held flag or
// release.
const EVENTS = `
  select ${MEETING_COLUMNS}, ${EVENT_LINK_COLUMNS}
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where not d.cancelled and coalesce(d.ends_at, d.starts_at) >= $1 and d.starts_at < $2
    and v.compartments <@ $3::text[] and d.compartments <@ $3::text[]
  order by d.starts_at, v.id`;

// Where an event starts on the owner's clock, for the order: an all-day event at its first local
// day's start, since its stored start is a UTC midnight.
const localStart = (row: MeetingRow, zone: string | null): number => {
  const days = row.all_day ? daysOf(row.starts_at, row.ends_at) : null;
  return days === null ? (row.starts_at?.getTime() ?? 0) : startOfDay(days.date, zone);
};

// The organizer first, then by entity id, within the same compartments.
const PARTICIPANTS = `
  select p.event_id, p.entity_id from knowledge.event_participants p
  where p.event_id = any ($1::text[]) and p.compartments <@ $2::text[]
  order by p.event_id, p.participant_role = 'organizer' desc, p.entity_id`;

// The meetings of the local days `from` to `to` in the owner's zone, past and coming, in local start order,
// at most EVENTS_MOST, `more` when there were more. A timed event with no end is kept by its start.
// A participant the reader would hide (withheld) is left out, and the owner is never one
// (ownerWho). Five statements whatever the number of events, besides ownerWho's.
export function weekEvents(admin: AdminContext, from: string, to: string): Promise<WeekEvents> {
  if (
    !DateOnly.safeParse(from).success ||
    !DateOnly.safeParse(to).success ||
    to < from ||
    dayAfter(from, WEEK_EVENTS_DAYS) <= to
  ) {
    return Promise.reject(new AdminError("invalid_argument"));
  }
  return admin.transaction(async (query) => {
    const zone = await ownerZoneOf(query);
    const start = startOfDay(from, zone);
    const end = startOfDay(dayAfter(to), zone);
    const within = unrestrictedOf(admin.keys);
    const found = (
      await query<MeetingRow & EventLinkRow>(EVENTS, [
        new Date(start - ZONE_REACH_MS),
        new Date(end + ZONE_REACH_MS),
        within,
      ])
    )
      .filter((row) => {
        if (row.starts_at === null) return false;
        if (!row.all_day)
          return (
            (row.ends_at === null ? row.starts_at.getTime() >= start : row.ends_at.getTime() > start) &&
            row.starts_at.getTime() < end
          );
        const days = daysOf(row.starts_at, row.ends_at);
        return days !== null && days.lastDate >= from && days.date <= to;
      })
      .map((row) => ({ row, at: localStart(row, zone) }))
      .sort((a, b) => a.at - b.at || byText(a.row.id, b.row.id));
    const rows = found.slice(0, EVENTS_MOST).map((one) => one.row);
    const more = found.length > EVENTS_MOST;
    if (rows.length === 0) return { events: [], more };
    const withheld = await ownerWithheld(query);
    const listed = (
      await query<{ event_id: string; entity_id: string }>(PARTICIPANTS, [rows.map((row) => row.id), within])
    ).filter((one) => !withheld.has(one.entity_id));
    const who = await ownerWho({ query, keys: admin.keys }, [...new Set(listed.map((one) => one.entity_id))]);
    const events = rows.map((row): OwnerEvent => {
      const days = row.all_day ? daysOf(row.starts_at, row.ends_at) : null;
      return {
        id: row.id as EventId,
        title:
          row.title_enc === null
            ? null
            : {
                untrusted: openedUnder(
                  admin.keys,
                  row.compartments,
                  { table: "knowledge.event_details", id: row.id, column: "title_enc" },
                  row.title_enc,
                ),
              },
        startsAt: days === null ? stampOrNull(row.starts_at) : null,
        endsAt: days === null ? stampOrNull(row.ends_at) : null,
        allDay: row.all_day,
        ...(days ?? {}),
        cancelled: row.cancelled,
        participants: listed.flatMap((one) => (one.event_id === row.id ? (who.get(one.entity_id) ?? []) : [])),
        ...(row.owner_response === null ? {} : { response: row.owner_response }),
        ...eventLinks(admin.keys, row),
      };
    });
    return { events, more };
  });
}

type Settings = {
  max_runs_per_day: number;
  max_microusd_per_day: string;
  max_pending_cards: number;
  max_input_code_points: number;
  ceiling_microusd_per_token: number;
  max_output_tokens: number;
  lessons_every: number;
  planner: BudgetView["planner"];
  sweep_hour_utc: number;
};

const SETTINGS = `
  select max_runs_per_day, max_microusd_per_day, max_pending_cards, max_input_code_points,
    ceiling_microusd_per_token, max_output_tokens, lessons_every, planner, sweep_hour_utc
  from policy.work_settings`;

async function settingsOf(query: Query): Promise<Settings> {
  const [row] = await query<Settings>(SETTINGS);
  if (row === undefined) throw new Error("policy.work_settings has no row");
  return row;
}

// Today's spend in every lane, by the owner's local day in their zone, as the ledger counts a day
// (admin-ledger.ts spendOn): the work lane is every run's; extraction and the dream are their lanes
// of vault.model_usage, restricted usage left out. A cap is the setting `work budget` sets. Three statements. Extraction's cap is the host's
// environment, which the store does not read: null.
export function spendToday(admin: AdminContext): Promise<SpendToday> {
  return admin.transaction(async (query) => {
    const zone = await ownerZoneOf(query);
    const day = dayIn(admin.now(), zone);
    const settings = await settingsOf(query);
    const spent = new Map((await spendOn(admin, query, zone, day, day)).map((one) => [one.lane, one.usd]));
    return {
      day: day as SpendToday["day"],
      lanes: [
        { lane: "work", spentUsd: spent.get("work") ?? 0, capUsd: usdOf(settings.max_microusd_per_day) },
        { lane: "extraction", spentUsd: spent.get("extraction") ?? 0, capUsd: null },
        { lane: "dream", spentUsd: spent.get("dream") ?? 0, capUsd: relationRules().dream.usdPerNight },
      ],
    };
  });
}

// Every setting `work budget` sets, as it takes them. One statement.
export function budget(admin: AdminContext): Promise<BudgetView> {
  return admin.transaction(async (query) => {
    const row = await settingsOf(query);
    return {
      runs: row.max_runs_per_day,
      usd: usdOf(row.max_microusd_per_day),
      cards: row.max_pending_cards,
      inputChars: row.max_input_code_points,
      tokenPrice: row.ceiling_microusd_per_token,
      outputTokens: row.max_output_tokens,
      lessonsEvery: row.lessons_every,
      planner: row.planner,
      sweepHour: row.sweep_hour_utc,
    };
  });
}

// By its latest event, read once: a lesson in force (the rule of core/statements.ts LESSON_IN_FORCE, the
// owner's `confirmed`), or pending, still `open` on its card; untainted either way. Newest first. A
// lesson under a compartment the key file lacks is left out, never opened.
const LESSONS = `
  select h.id, h.compartments, h.body_enc, coalesce(h.applies_kinds, '{}') as kinds, coalesce(h.applies_roles, '{}') as roles,
    case when l.latest = '${LESSON_CONFIRMED}' then 'in_force' else 'pending' end as state
  from ledger.hypotheses h
  cross join lateral (${latestRow("r.event || '/' || r.by as latest, r.event", "hypothesis", "h.id")}) l
  where h.kind = 'lesson' and h.tainted_at is null and h.body_enc is not null and (l.latest = '${LESSON_CONFIRMED}' or l.event = 'open')
  order by h.created_at desc, h.id desc
  limit ${OWNER_PAGE_MOST}`;

export function lessons(admin: AdminContext): Promise<LessonsView> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      compartments: string[];
      body_enc: Sealed;
      kinds: string[];
      roles: string[];
      state: "in_force" | "pending";
    }>(LESSONS);
    return {
      lessons: rows
        .filter((row) => row.compartments.every((one) => admin.keys.compartments.has(one)))
        .map((row) => ({
          id: row.id as HypothesisId,
          state: row.state,
          kinds: row.kinds as LessonsView["lessons"][number]["kinds"],
          roles: row.roles,
          text: {
            untrusted: open(admin.keys, row, "ledger.hypotheses.body_enc", "throw"),
          },
        })),
    };
  });
}
