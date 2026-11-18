import {
  type CardLoadSeries,
  dayAfter,
  dayIn,
  type LedgerDay,
  LedgerEvent,
  type LedgerFeed,
  type LedgerLanes,
  type LedgerSpan,
  LedgerSpan as LedgerSpanShape,
  type OpportunityId,
  type OwnerPageArgs,
  type SpendLane,
  type SpendSeries,
} from "@intelligence/contracts/personal";
import { SHOWN_TO_OWNER } from "../../cards/asked-less.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import type { Query } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { cursorOf, ownerPage } from "../admin-owner.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { cardsShown } from "../cards/admin-queue.ts";

// The owner's ledger, as pi_admin: a day's tally and lanes, the feed of ledger events, the event
// stream's polls, and the spend and card-load series. Ids, codes, times and counts, and beside the
// feed the summaries of its opportunities, opened as agentActivity opens them; no other body is
// opened.
//
// Filters stated, not inherited from the reader's policies. The ledger is the owner's own record, which
// pi_admin reads whole; a ledger row counts here when its label is within the key file's
// compartments but the restricted ones, which stay in the terminal (`restricted *`), as work time
// reads them. A claim counts only within the one owner audience. Spend is counted by the owner's local day
// (spendOn), as the Today room's spendToday counts it: the budget's two pools, and the extraction
// and dream lanes but restricted usage. Exposures are not in the feed: they carry a day, no time
// and no event id, so they have no place in a feed paged by event id. Nothing here writes or logs.

const within = (admin: AdminContext): string[] => unrestrictedOf(admin.keys);

// The owner's day's bounds: $1 the date, $2 the zone.
const DAY =
  "select ($1::date::timestamp at time zone $2) as start, (($1::date + 1)::timestamp at time zone $2) as stop";
// The owner's zone, null while unset or unknown to this runtime, which a day reads as UTC. The same
// reading as core/zone.ts's ownerZoneOf.
// ---------------------------------------------------------------------------------------------
// One event, as the feed and the stream serve it. `by` names a client by its name, never its id;
// `work` is the run, the opportunity, or the opportunity a move, card or draft belongs to.
// ---------------------------------------------------------------------------------------------

// `$within` is the statement's parameter holding the ledger's compartments: a row a lookup reads
// is within them too.
const eventColumns = (within: string): string => `
  e.id, e.at, e.row_kind, e.row_id, e.event, e.code,
  case when e.by like 'client:%' then (select 'client:' || k.name from policy.clients k where k.id = substr(e.by, 8)) else e.by end as by,
  case e.row_kind
    when 'run' then e.row_id
    when 'opportunity' then e.row_id
    when 'move' then (select m.opportunity_id from ledger.moves m where m.id = e.row_id and m.compartments <@ ${within}::text[])
    when 'card' then (
      select case c.target_kind
        when 'opportunity' then c.target_id
        when 'move' then (select m.opportunity_id from ledger.moves m where m.id = c.target_id and m.compartments <@ ${within}::text[])
        else c.run_id end
      from ledger.cards c where c.id = e.row_id and c.compartments <@ ${within}::text[])
    when 'draft' then (select d.opportunity_id from ledger.drafts d where d.id = e.row_id and d.compartments <@ ${within}::text[])
  end as work`;

type EventRow = {
  id: string;
  at: Date;
  row_kind: string;
  row_id: string;
  event: string;
  code: string | null;
  by: string | null;
  work: string | null;
};

const BY = LedgerEvent.shape.by;
const WORK = LedgerEvent.shape.work;

const eventOf = (row: EventRow): LedgerEvent => {
  const by = BY.safeParse(row.by);
  const work = WORK.safeParse(row.work);
  return {
    id: Number(row.id),
    at: row.at.toISOString(),
    row: { kind: row.row_kind, id: row.row_id },
    event: row.event,
    code: row.code,
    by: by.success ? by.data : null,
    work: work.success ? work.data : null,
  };
};

// Three statements.
// ---------------------------------------------------------------------------------------------

const FEED = `
  select ${eventColumns("$1")} from ledger.record_events e
  where e.compartments <@ $1::text[] and ($2::bigint is null or e.id < $2::bigint)
  order by e.id desc
  limit $3`;

// The summaries of the page's opportunities, untainted and within the ledger's compartments.
const SUMMARIES = `
  select o.id, o.compartments, o.body_enc from ledger.opportunities o
  where o.id = any ($1::text[]) and o.tainted_at is null and o.body_enc is not null and o.compartments <@ $2::text[]`;

export async function ledgerFeed(admin: AdminContext, args: OwnerPageArgs = {}): Promise<LedgerFeed> {
  const page = ownerPage(
    args,
    (place) => place.length === 1 && Number.isSafeInteger(place[0]) && (place[0] as number) > 0,
  );
  return admin.transaction(async (query) => {
    const rows = await query<EventRow>(FEED, [within(admin), page.after?.[0] ?? null, page.limit + 1]);
    const events = rows.slice(0, page.limit).map(eventOf);
    const last = events.at(-1);
    const ids = [...new Set(events.flatMap((event) => (event.work?.startsWith("opp_") ? [event.work] : [])))];
    const opened =
      ids.length === 0
        ? []
        : await query<{ id: string; compartments: string[]; body_enc: Sealed }>(SUMMARIES, [ids, within(admin)]);
    const works = opened.flatMap((row) => {
      // A summary is opened only under every compartment of its row, as agentActivity opens it.
      const summary =
        row.compartments.length === 0 ? null : open(admin.keys, row, "ledger.opportunities.body_enc", "withheld");
      return summary === null || summary === ""
        ? []
        : [{ work: row.id as OpportunityId, summary: { untrusted: summary } }];
    });
    // The cards the page's events are on, each as the card read shows it: those the owner's
    // decisions answered, and those the system raised or withdrew.
    const named = [...new Set(events.flatMap((event) => (event.row.kind === "card" ? [event.row.id] : [])))];
    const cards = await cardsShown(admin, query, named, within(admin));
    return { events, works, cards, next: rows.length > page.limit && last !== undefined ? cursorOf([last.id]) : null };
  });
}

// An identity value is given at insert, not at commit, so an event can commit after one with a
// higher id that was already delivered. Each poll reads the events above the cursor and again those
// of the last 30 seconds at or below it, and delivers each id once: `delivered` is every id the
// last poll returned, which covers every id of the window that was delivered. A stream's first
// poll, and a reconnect's, delivers the window at or below its cursor too, so an event that
// committed late is not lost; the page keeps each id once. An event whose transaction ran longer
// than the window before it committed is not delivered (R-L4's bound); the feed still holds it. At
// most 1 000 window rows and 200 new ones a poll. One statement.
// ---------------------------------------------------------------------------------------------

const EVENTS_LAG_SECONDS = 30;
const EVENTS_EACH = 200;

const EVENTS_WINDOW_MOST = 1_000;

type EventCursor = { after: number; delivered: readonly number[] };

export const eventCursor = (after: number): EventCursor => ({ after, delivered: [] });

const EVENTS = `
  select * from (
    (select ${eventColumns("$2")} from ledger.record_events e
     where e.id <= $1::bigint and e.at >= now() - make_interval(secs => ${EVENTS_LAG_SECONDS}) and e.compartments <@ $2::text[]
     order by e.id desc limit ${EVENTS_WINDOW_MOST})
    union all
    (select ${eventColumns("$2")} from ledger.record_events e
     where e.id > $1::bigint and e.compartments <@ $2::text[]
     order by e.id limit ${EVENTS_EACH})
  ) x
  order by x.id`;

export function ledgerEvents(
  admin: AdminContext,
  cursor: EventCursor,
): Promise<{ events: LedgerEvent[]; cursor: EventCursor }> {
  return admin.transaction(async (query) => {
    const rows = await query<EventRow>(EVENTS, [cursor.after, within(admin)]);
    const seen = new Set(cursor.delivered);
    const ids = rows.map((row) => Number(row.id));
    const fresh = rows.filter((_row, index) => !seen.has(ids[index] as number));
    const after = ids.reduce((most, id) => Math.max(most, id), cursor.after);
    return { events: fresh.map(eventOf), cursor: { after, delivered: ids } };
  });
}

// ---------------------------------------------------------------------------------------------
// Spend by the owner's local day and lane, never by the UTC day, as spendToday counts it: work, the
// budget's one pool as ledger.spend_on counts it, each model call by when it was made, inside the owner's day's bounds in their zone ($3); extraction and dream, their lanes
// of vault.model_usage within $4, the compartments but the restricted ones. A usage row keeps a
// calendar date and no time of day by design (pipeline-calls.ts recordUsageRow: its id holds no
// time either), so those two lanes count the rows of the date that names the owner's day. Every day and
// lane, zero included. One statement.
// ---------------------------------------------------------------------------------------------

const SPEND = `
  with d as (
    select g::date as day, (g::date::timestamp at time zone $3) as start, ((g::date + 1)::timestamp at time zone $3) as stop
    from generate_series($1::date, $2::date, interval '1 day') g)
  select d.day::text as day,
    (select sum(s.cost_microusd) from ledger.run_steps s join ledger.runs r on r.id = s.run_id
     where s.kind = 'model_call' and s.created_at >= d.start and s.created_at < d.stop) as work,
    (select sum(u.cost_microusd) from vault.model_usage u where u.day = d.day and u.lane = 'extract' and u.compartments <@ $4::text[]) as extraction,
    (select sum(u.cost_microusd) from vault.model_usage u where u.day = d.day and u.lane = 'dream' and u.compartments <@ $4::text[]) as dream
  from d
  order by d.day`;

const LANES: readonly SpendLane[] = ["work", "extraction", "dream"];

// The owner's local days `from` to `to`, in their zone (UTC while unset).
export const spendOn = async (
  admin: AdminContext,
  query: Query,
  zone: string | null,
  from: string,
  to: string,
): Promise<{ day: string; lane: SpendLane; usd: number }[]> =>
  (
    await query<{ day: string } & Record<SpendLane, string | null>>(SPEND, [from, to, zone ?? "UTC", within(admin)])
  ).flatMap((row) => LANES.map((lane) => ({ day: row.day, lane, usd: Number(row[lane] ?? 0) / 1_000_000 })));

// Four statements: the owner's zone, their audience, the counts, spend.
// ---------------------------------------------------------------------------------------------

// $3 the ledger's compartments, $4 the owner's audience. Items read: the distinct items shown to
// agents.
const COUNTS = `
  with w as (${DAY})
  select
    (select count(*) from ledger.runs r, w where r.created_at >= w.start and r.created_at < w.stop and r.compartments <@ $3::text[])::int as runs,
    (select count(*) from ledger.moves m, w where m.created_at >= w.start and m.created_at < w.stop and m.compartments <@ $3::text[])::int as moves,
    (select count(distinct x) from ledger.read_log l cross join unnest(l.shown) as x, w
     where l.read_at >= w.start and l.read_at < w.stop and l.compartments <@ $3::text[])::int as items_read,
    (select count(*) from knowledge.claims c, w where c.created_at >= w.start and c.created_at < w.stop and c.compartments <@ $4::text[])::int as claims_made,
    (select count(*) filter (where d.kind <> 'send') from knowledge.owner_decisions d, w
     where d.decided_at >= w.start and d.decided_at < w.stop and d.compartments <@ $3::text[])::int as decisions,
    (select count(*) filter (where d.kind = 'send') from knowledge.owner_decisions d, w
     where d.decided_at >= w.start and d.decided_at < w.stop and d.compartments <@ $3::text[])::int as sends`;

export function ledgerDay(admin: AdminContext, day: string): Promise<LedgerDay> {
  return admin.transaction(async (query) => {
    const zone = (await ownerZoneOf(query)) ?? "UTC";
    const audience = await ownerAudience(query);
    const [counts] = await query<{
      runs: number;
      moves: number;
      items_read: number;
      claims_made: number;
      decisions: number;
      sends: number;
    }>(COUNTS, [day, zone, within(admin), audience]);
    if (counts === undefined) throw new Error("ledger: no counts");
    const spend = (await spendOn(admin, query, zone, day, day)).map(({ lane, usd }) => ({ lane, usd }));
    return {
      day,
      runs: counts.runs,
      moves: counts.moves,
      spend,
      itemsRead: counts.items_read,
      claimsMade: counts.claims_made,
      decisions: counts.decisions,
      sends: counts.sends,
    };
  });
}

// A run is the reasoner's, from its first event to the first that ends it; a move is its agent's, from
// plan_move (`cleared`) to its report; a sync is the pipeline's, with what it read: the sums of the sync
// outcomes its accounts recorded while it ran. A span shows on the day it overlaps. Runs and moves are
// found by an event of theirs in the seven days before the day's end. A move never reported carries its
// agent's last step on the work since its plan (the move's own events and the opportunity's by the same
// author), and, while it may still report, when the claim it was planned under runs out: its agent holds
// the work's lease, taken before the plan and live at $4 (the read's now), and no later move was planned on
// the work. Such a move shows on the days from its plan to its last step, or to now while held, never to
// now for days after its agent went quiet. The identity service and the owner's decisions keep no spans in
// the ledger, so they have no lane yet. Two statements.
// ---------------------------------------------------------------------------------------------

const LANES_SQL = `
  with w as (${DAY}),
  near as (
    select distinct e.row_kind, e.row_id from ledger.record_events e, w
    where e.row_kind in ('run', 'move') and e.at >= w.start - interval '7 days' and e.at < w.stop and e.compartments <@ $3::text[]),
  spans as (
    select e.row_kind, e.row_id, min(e.at) as from_at,
      min(e.at) filter (where (e.row_kind = 'run' and e.event not in ('queued', 'running')) or (e.row_kind = 'move' and e.event <> 'cleared')) as to_at,
      (array_agg(e.by order by e.id))[1] as by
    from near n join ledger.record_events e on e.row_kind = n.row_kind and e.row_id = n.row_id and e.compartments <@ $3::text[]
    group by e.row_kind, e.row_id),
  -- The day's sync outcomes, read once for every sync of the day (a sync that began the day
  -- before counts the outcomes it recorded then).
  outcomes as (
    select o.id, o.started_at, o.decided, o.stored, o.junk, o.held, o.removed from vault.sync_outcomes o, w
    where o.started_at >= w.start - interval '1 day' and o.started_at < w.stop and o.compartments <@ $3::text[]),
  -- A move never reported: its last step, and its claim's end while it may still report.
  quiet as (
    select s.row_id, m.opportunity_id,
      greatest(s.from_at, (select max(o.at) from ledger.record_events o
                           where o.row_kind = 'opportunity' and o.row_id = m.opportunity_id and o.by = s.by and o.at >= s.from_at and o.compartments <@ $3::text[]
                             -- Its agent's steps while it held the work: before the work left it
                             -- and before a later move was planned on it.
                             and o.at < coalesce((select min(x.at) from ledger.record_events x
                                                  where x.row_kind = 'opportunity' and x.row_id = m.opportunity_id and x.at >= s.from_at and x.event <> 'claimed'
                                                    and x.compartments <@ $3::text[]), 'infinity')
                             and o.at < coalesce((select min(n.created_at) from ledger.moves n
                                                  where n.opportunity_id = m.opportunity_id and n.created_at > m.created_at), 'infinity'))) as last_at,
      (select l.lease_until from ledger.assignments a join queue.leases l on l.resource_kind = 'opportunity' and l.resource_id = m.opportunity_id and l.holder = a.client_id
       where a.id = m.assignment_id and l.lease_until >= $4::timestamptz and l.first_taken_at <= s.from_at
         and not exists (select 1 from ledger.moves n where n.opportunity_id = m.opportunity_id and n.id <> m.id and n.created_at > m.created_at)) as held_until
    from spans s join ledger.moves m on m.id = s.row_id and m.compartments <@ $3::text[]
    where s.row_kind = 'move' and s.to_at is null),
  shown as (
    select s.*, q.opportunity_id, q.last_at, q.held_until from spans s left join quiet q on s.row_kind = 'move' and q.row_id = s.row_id)
  select case when s.row_kind = 'run' then 'reasoner' else (select 'client:' || k.name from policy.clients k where s.by like 'client:%' and k.id = substr(s.by, 8)) end as worker,
    s.from_at, s.to_at,
    case when s.row_kind = 'run' then s.row_id
      else coalesce(s.opportunity_id, (select m.opportunity_id from ledger.moves m where m.id = s.row_id and m.compartments <@ $3::text[])) end as work,
    null::json as read, null as code, s.last_at, s.held_until
  from shown s, w where s.from_at < w.stop
    and (s.to_at >= w.start or s.held_until is not null or (s.to_at is null and (s.row_kind = 'run' or s.last_at >= w.start)))
  union all
  select 'pipeline', j.started_at, j.ended_at, null,
    case when count(o.id) = 0 then null else json_build_object('decided', sum(o.decided), 'stored', sum(o.stored), 'junk', sum(o.junk),
      'held', sum(o.held), 'removed', sum(o.removed)) end,
    j.code, null::timestamptz, null::timestamptz
  from ledger.job_runs j cross join w
  left join outcomes o on o.started_at >= j.started_at and o.started_at <= j.ended_at
  where j.job = 'sync' and j.started_at < w.stop and j.ended_at >= w.start
  group by j.id, j.started_at, j.ended_at, j.code
  order by 2, 1, 4`;

export function ledgerLanes(admin: AdminContext, day: string): Promise<LedgerLanes> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      worker: string | null;
      from_at: Date;
      to_at: Date | null;
      work: string | null;
      read: Record<string, number> | null;
      code: string | null;
      last_at: Date | null;
      held_until: Date | null;
    }>(LANES_SQL, [day, (await ownerZoneOf(query)) ?? "UTC", within(admin), admin.now().toISOString()]);
    const spans: LedgerSpan[] = [];
    for (const row of rows) {
      // A sync with what it read, none where it recorded no outcome, and how it ended.
      const read = {
        ...(row.read === null ? {} : { read: row.read }),
        ...(row.code === null ? {} : { code: row.code }),
      };
      // A move never reported: its last step, and its claim's end while it may still report.
      const quiet = {
        ...(row.last_at === null ? {} : { lastStep: row.last_at.toISOString() }),
        ...(row.held_until === null ? {} : { heldUntil: row.held_until.toISOString() }),
      };
      // A move whose client is gone has no lane to show it on.
      const span = LedgerSpanShape.safeParse({
        worker: row.worker,
        from: row.from_at.toISOString(),
        to: row.to_at?.toISOString() ?? null,
        work: row.work,
        ...read,
        ...quiet,
      });
      if (span.success) spans.push(span.data);
    }
    return { day, spans };
  });
}

// Spend by their day, as spendOn counts it; pending cards at the end of each of their days, and
// today's at now, so its last point is the count the waiting list shows (the queue's WAITING rule),
// rebuilt from the cards' events: a card counts while its latest event is `pending`, it has not
// expired (its time, or its days after it waited, as the queue reads them) and it was not tainted.
// Two statements each: the owner's zone, the series.
// ---------------------------------------------------------------------------------------------

export function spendSeries(admin: AdminContext, days: number): Promise<SpendSeries> {
  return admin.transaction(async (query) => {
    const zone = await ownerZoneOf(query);
    const today = dayIn(admin.now(), zone);
    return { days: await spendOn(admin, query, zone, dayAfter(today, 1 - days), today) };
  });
}

const CARD_LOAD = `
  with ends as (
    select d::date as day, least(((d::date + 1)::timestamp at time zone $3), $5::timestamptz) as stop
    from generate_series($1::date - ($2::int - 1), $1::date, interval '1 day') d),
  spans as (
    select e.event, e.at, lead(e.at) over (partition by e.row_id order by e.id) as until,
      coalesce(c.expires_at, e.at + make_interval(days => c.expires_after_days)) as expires_at, c.tainted_at,
      c.kind, c.case_key, c.created_at, c.id, c.compartments, c.expires_after_days, c.target_kind, c.target_id
    from ledger.record_events e join ledger.cards c on c.id = e.row_id
    where e.row_kind = 'card' and c.compartments <@ $4::text[] and e.at < (select max(n.stop) from ends n))
  select n.day::text as day, count(s.at)::int as pending
  from ends n left join spans s
    on s.event = 'pending' and s.at < n.stop and (s.until is null or s.until >= n.stop) and (s.expires_at is null or s.expires_at > n.stop)
      and (s.tainted_at is null or s.tainted_at >= n.stop)
      and ${SHOWN_TO_OWNER("n.stop", "s")}
  group by n.day
  order by n.day`;

export function cardLoadSeries(admin: AdminContext, days: number): Promise<CardLoadSeries> {
  return admin.transaction(async (query) => {
    const zone = await ownerZoneOf(query);
    return {
      days: await query<{ day: string; pending: number }>(CARD_LOAD, [
        dayIn(admin.now(), zone),
        days,
        zone ?? "UTC",
        within(admin),
        admin.now().toISOString(),
      ]),
    };
  });
}
