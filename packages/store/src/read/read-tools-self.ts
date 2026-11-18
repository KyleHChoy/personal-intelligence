// get_self: the owner's addresses and time zone, the week's meetings, the contacts ranked over
// ninety days, and the head the packs and the run's self block read too.

import {
  type AccountKind,
  type ApplicationSign,
  type BeliefLine,
  type ContactCount,
  GetSelfArgs,
  OPEN_ITEMS_SHOWN,
  type SelfView,
  TIERS,
  type Tier,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import { type Finding, rankGoals, withItemReports } from "@intelligence/personal-core/views";
import { byText } from "../core/db.ts";
import {
  type ClientGroups,
  type Ctx,
  type Found,
  mergeReads,
  type ReadSet,
  readOfRests,
  untrusted,
} from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { DIRECT_INTERACTION } from "../core/statements.ts";
import { workViews } from "../core/work-time-read.ts";
import { allDaySpan, ownerTimeZone, ZONE_REACH_MS } from "../core/zone.ts";
import { supportsOf } from "./computed-beliefs.ts";
import { applicationsOf } from "./read-applications.ts";
import { type AudienceBeliefs, audienceBeliefs } from "./read-beliefs.ts";
import { selfChangesOf, statedFactsOf } from "./read-compiled.ts";
import { nextAccess, readsBodies, readsFindings, recentFindings } from "./read-findings.ts";
import { OWNER_ADDRESSES, WROTE_TO_MAX_RECIPIENTS } from "./read-fragments.ts";
import { goalRanks, listGoals } from "./read-goals.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { nextMovesOf } from "./read-next.ts";
import { type OpenRead, openItemsOf, servedOpenItems } from "./read-open-items.ts";
import { boundHead, selfSectionsOf } from "./read-self.ts";
import { fitSelfPage } from "./read-self-fit.ts";
import { inRowOrder, type Printed } from "./read-tools.ts";
import { clientRanking, type WarmthRow, warmthOf, warmthOrder } from "./read-warmth.ts";
import { MEETING_COLUMNS, type MeetingRow, meetingsOf } from "./read-who.ts";

const UPCOMING_DAYS = 7;
const CONTACTS = 20;
// get_self serves at most this many of the week's meetings, the
// earliest first, so it fits the reasoner's result cap (self-sizes.test.ts). Packs keep their own.
export const SELF_MEETINGS = 10;

const daysFrom = (now: Date, days: number): string => new Date(now.getTime() + days * DAY_MS).toISOString();

// Not cancelled, ending after `$1` and starting before `$2`. A null time is in neither. selfOf
// asks for fourteen hours more at each end, the widest a zone is from UTC, since an all-day
// event's stored days are UTC midnights and it is kept by its days in the owner's zone;
// code then keeps what ends after now and starts within seven days.
const UPCOMING = `
  select ${MEETING_COLUMNS}
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where not d.cancelled and d.ends_at > $1 and d.starts_at < $2
  order by d.starts_at, v.id`;

// Distinct messages among each person's direct rows, over ninety days and over the last thirty,
// and those the owner sent to at most `$6` recipients, counted as the message's outbound rows.
// Every row of one message carries the message's label, direction and time, so a client that
// sees one sees them all, and the count is the same for every client that sees the message.
// The window's direct rows are read once, first, by the key-led index on the time: a co-recipient's row on mail the owner received is in neither
// count, and on a list it is most of the window's rows. Each message's recipients are counted among them: a lookup of each message's rows by its
// evidence id would take the index on the evidence id alone. Counted per entity, or per group
// under its id (`$4` its members, `$5` their group's id), each message once; each entity counted
// is then looked up by its id, so that the entities are read by their primary key alone: a
// join from the entities would read every one of them. A group's id is a member's, a person's,
// so its kind is the members'.
const CONTACT_EMAILS = `
  with recent as materialized (
    select i.entity_id, i.evidence_id, i.occurred_at, i.direction, i.entity_role
    from knowledge.interaction_log i
    where i.occurred_at >= $1 and i.occurred_at <= $3 and ${DIRECT_INTERACTION}
  ),
  sends as (
    select r.evidence_id from recent r
    where r.direction = 'outbound'
    group by r.evidence_id
    having count(*) <= $6
  )
  select t.entity_id, t.emails30d, t.emails90d, t.wrote_to90d from (
    select k.entity_id,
      count(distinct i.evidence_id) filter (where i.occurred_at >= $2)::int as emails30d,
      count(distinct i.evidence_id)::int as emails90d,
      count(distinct s.evidence_id)::int as wrote_to90d
    from recent i
    left join sends s on s.evidence_id = i.evidence_id
    left join unnest($4::text[], $5::text[]) as g (entity, grp) on g.entity = i.entity_id
    cross join lateral (select coalesce(g.grp, i.entity_id) as entity_id) as k
    group by k.entity_id
  ) t
  where (select e.kind from knowledge.entities e where e.id = t.entity_id) = 'person'
  order by t.entity_id`;

const CONTACT_MEETINGS = `
  select t.entity_id, t.meetings90d from (
    select k.entity_id, count(distinct v.id)::int as meetings90d
    from knowledge.event_participants p
    join knowledge.events v on v.id = p.event_id
    join knowledge.event_details d on d.event_id = v.id
    left join unnest($3::text[], $4::text[]) as g (entity, grp) on g.entity = p.entity_id
    cross join lateral (select coalesce(g.grp, p.entity_id) as entity_id) as k
    where not d.cancelled and d.starts_at >= $1 and d.starts_at <= $2
    group by k.entity_id
  ) t
  where (select e.kind from knowledge.entities e where e.id = t.entity_id) = 'person'
  order by t.entity_id`;

// The accounts of the people `$1`, each with whether a visible bulk message came from it in the
// ninety days (`$2` to `$3`), one held from agents aside, as find_messages leaves it out. The
// window's bulk senders are read once, first, from the key-led index on the time that holds them
// (messages_key_sent_senders): a lookup of each account's messages by its address would take the
// index on the sender alone.
const CONTACT_ACCOUNTS = `
  with bulk as materialized (
    select distinct m.sender_fp from knowledge.messages m
    where m.bulk and not m.held and m.sent_at >= $2 and m.sent_at <= $3
  )
  select a.id, a.entity_id, a.compartments, a.value_enc, a.value_fp,
    exists (select 1 from bulk b where b.sender_fp = a.value_fp) as bulk_sender,
    a.kind, exists (select 1 from knowledge.identity_rulings r where r.a_fp = a.value_fp and r.verdict = 'person') as person
  from knowledge.accounts a
  where a.entity_id = any($1)
  order by a.id`;

// The people warmth says are close though mail may not: two-way contact since ninety days ago with chat among
// their channels (a row holds one last two-way time, of any channel), or, for a client that holds the people
// view, a tier the owner set among the closest two. Closest first, at most CLOSE_READ, so someone the owner
// only chats with or stated close is a candidate whatever the ninety days' mail holds. The caller's ranking
// alone, as every warmth read.
const STATED_CLOSE: readonly Tier[] = ["inner", "close"];
// Enough to fill the list when some of them are left out below.
const CLOSE_READ = CONTACTS * 2;

type Counts = { emails30d: number; emails90d: number; meetings90d: number };

// Where a contact ranks before its counts do: 0 the owner wrote to it (on a message to at most
// WROTE_TO_MAX_RECIPIENTS), met it or chatted both ways with it in the ninety days, or, for a client that
// may learn it, stated it close; 1 the rest. A machine's is left out:
// an account that is not a person's, by its stored kind or by addressKind's list, unless the
// owner ruled the address a person's, or, for one of the rest, an
// address bulk mail came from in the ninety days, since the owner writing to someone outweighs a
// mailing list they post to. So is one that holds an address of the owner's own, the owner's other account.
const WROTE_OR_MET = 0;
const OTHERS = 1;

// get_self's head, and the evidence id of each upcoming meeting, which a pack logs for those it
// shows.
type SelfFound = Found<SelfView> & { evidenceOf: ReadonlyMap<string, string> };

const NO_CHANGES = { changes: [], read: { bound: [], shown: [], factKeyFps: [] } };

// The head (addresses, time zone, seven days of meetings, contacts,
// `changes`), the goals the owner set as the token returns them (a client that holds list_goals and
// the Work view, or the reasoner: the goals' row policy), and `sections`, from one reading of the
// audience's beliefs. get_self serves no `stated`: the packs and the planner's self block compile
// the owner's beliefs themselves (statedFactsOf), and never through get_self. At most SELF_MEETINGS
// meetings, each as boundHead cuts it, and each change's words cut as a line's, so get_self is
// bounded.
export async function getSelf(
  ctx: Ctx,
  now: Date,
  args: GetSelfArgs = {},
  views: readonly string[] = [],
  tools: readonly string[] = [],
): Promise<Found<SelfView>> {
  const history = args.history === true;
  if (args.moves !== true && args.work === true) return workAlone(ctx, now, views);
  const read = await audienceBeliefs(ctx);
  if (args.moves === true) return movesAlone(ctx, now, read, views, tools);
  if (args.domain !== undefined) return domainAlone(ctx, now, read, args.domain, history, views, tools);
  return wholePage(ctx, now, read, history, views, tools);
}

// What a client holding the Self and the Work views is served of observed work.
const servesTheWork = (views: readonly string[]): boolean => views.includes("self") && views.includes("work");
// The goals in the owner's order; their ranks are read here, after whatever the caller read first.
const rankedGoals = async (ctx: Ctx, listed: Awaited<ReturnType<typeof listGoals>>) =>
  rankGoals(listed.value.goals, await goalRanks(ctx, listed.value.goals));
// A view that serves none of the page, its fields in the page's order.
const emptyHead = (timeZone: string | null) => ({
  addresses: [],
  timeZone,
  upcoming: [],
  contacts: [],
  sections: [],
  changes: [],
});

// One domain is asked for that section, with the goals and what changed: the addresses, the week, the
// contacts, the open items and the work stay with a call that asks for them, and `domain` says so.
async function domainAlone(
  ctx: Ctx,
  now: Date,
  read: AudienceBeliefs,
  domain: NonNullable<GetSelfArgs["domain"]>,
  history: boolean,
  views: readonly string[],
  tools: readonly string[],
): Promise<Found<SelfView>> {
  const timeZone = await ownerTimeZone(ctx);
  const section = await selfSectionsOf(ctx, read, { history, now, domain });
  const changed = await selfChangesOf(ctx, read, now, timeZone);
  const listed = await listGoals(ctx, {}, now, "set");
  const mail = views.includes("people");
  // What the owner is applying to is career's, its dated items included.
  const openRead = domain === "career" ? await openItemsOf(ctx, views, now, read) : undefined;
  const findings = openRead !== undefined && readsFindings(views, tools) ? await recentFindings(ctx, now) : [];
  const applied =
    openRead === undefined
      ? undefined
      : await signsOf(ctx, now, openRead, { mail, tools, lines: section.applicationLines, findings });
  const withheldHere = [
    ...(listed.withheld ? ["goals" as const] : []),
    ...(applied !== undefined && !mail ? ["applications" as const] : []),
  ];
  return {
    value: {
      goals: await rankedGoals(ctx, listed),
      ...(withheldHere.length === 0 ? {} : { withheld: withheldHere }),
      domain,
      addresses: [],
      timeZone,
      upcoming: [],
      contacts: [],
      sections: section.sections,
      ...(section.housekeeping === undefined ? {} : { housekeeping: section.housekeeping }),
      ...(applied === undefined ? {} : { applications: applied.signs }),
      changes: changed.changes,
    },
    rows: section.rows + changed.changes.length + listed.rows + (applied?.signs.length ?? 0),
    read: { ...mergeReads(section.read, changed.read, applied?.read), goals: listed.read.goals ?? [] },
  };
}

async function wholePage(
  ctx: Ctx,
  now: Date,
  read: AudienceBeliefs,
  history: boolean,
  views: readonly string[],
  tools: readonly string[],
): Promise<Found<SelfView>> {
  const {
    evidenceOf: _evidenceOf,
    value: head,
    ...found
  } = await selfOf(ctx, now, { read, meetings: SELF_MEETINGS, tiers: views.includes("people") });
  const page = await selfSectionsOf(ctx, read, { history, now });
  const goals = await listGoals(ctx, {}, now, "set");
  // Observed work, for a client holding the Self and the Work views; the owner's stated
  // goals stay in the head, apart. Its capture items join this call's read log.
  const servesWork = servesTheWork(views);
  const work = servesWork
    ? (await workViews(ctx, { view: "now" }, now, [], undefined, supportsOf(ctx))).now
    : undefined;
  const mail = views.includes("people");
  // What the registration leaves out, from the registration alone: never from what the owner has.
  const withheld = [
    ...(goals.withheld ? ["goals" as const] : []),
    ...(servesWork ? [] : ["work" as const]),
    ...(mail ? [] : ["applications" as const]),
  ];
  // What the owner owes and what is overdue, from this call's reading of beliefs.
  const openRead = await openItemsOf(ctx, views, now, read);
  const open = servedOpenItems(openRead, OPEN_ITEMS_SHOWN);
  // What agents reported, beside what the sources say. It moves nothing.
  const findings = readsFindings(views, tools) ? await recentFindings(ctx, now) : [];
  const items = withItemReports(open.value.items, findings, head.timeZone);
  const itemReports = items.flatMap((item) => (item.reported ?? []).map((one) => one.record as string));
  const applied = await signsOf(ctx, now, openRead, { mail, tools, lines: page.applicationLines, findings });
  const ranked = await rankedGoals(ctx, goals);
  // What next: from this call's own reads, and the reply and meeting it adds.
  const next = await nextMovesOf(ctx, now, {
    ...nextAccess(views, tools),
    open: openRead,
    findings,
    zone: head.timeZone,
    marks: true,
  });
  // Priorities first, and what this client is not shown beside them, so an empty list is never read
  // as none; then cut to what one client's inline read can hold.
  const value = fitSelfPage(
    {
      goals: ranked,
      ...(withheld.length === 0 ? {} : { withheld }),
      next: next.value,
      openItems: { ...open.value, items },
      ...boundHead(head),
      sections: page.sections,
      ...(page.housekeeping === undefined ? {} : { housekeeping: page.housekeeping }),
      ...(applied.signs.length === 0 ? {} : { applications: applied.signs }),
      ...(work === undefined ? {} : { work }),
    },
    { keepLines: history },
  );
  const kept = page.accountFor({ sections: value.sections, notices: value.housekeeping?.lines ?? [] });
  const nextRead = next.readOf(value.next?.moves ?? []);
  return {
    value,
    rows: found.rows + kept.rows + goals.rows + open.rows + applied.signs.length + next.value.moves.length,
    read: {
      ...mergeReads(found.read, kept.read, open.read, applied.read, { shown: itemReports }, nextRead),
      goals: goals.read.goals ?? [],
    },
  };
}

// `next` alone, with room for every move, for a caller told `more`. It reads what the block needs
// and none of the page, so its goal's step stands on the stated lines and dated items, and not on subject lines.
async function movesAlone(
  ctx: Ctx,
  now: Date,
  read: AudienceBeliefs,
  views: readonly string[],
  tools: readonly string[],
): Promise<Found<SelfView>> {
  const timeZone = await ownerTimeZone(ctx);
  const listed = await listGoals(ctx, {}, now, "set");
  const goals = await rankedGoals(ctx, listed);
  const open = await openItemsOf(ctx, views, now, read);
  const stated = await statedFactsOf(ctx, read);
  const next = await nextMovesOf(ctx, now, {
    ...nextAccess(views, tools),
    open,
    findings: readsFindings(views, tools) ? await recentFindings(ctx, now) : [],
    zone: timeZone,
    whole: true,
    marks: true,
  });
  const served = next.readOf(next.value.moves);
  return {
    value: {
      goals,
      ...(listed.withheld ? { withheld: ["goals" as const] } : {}),
      next: next.value,
      ...emptyHead(timeZone),
    },
    rows: listed.rows + next.value.moves.length,
    read: {
      bound: [...new Set([...served.bound, ...served.factKeyFps.flatMap((fact) => stated.boundOf.get(fact) ?? [])])],
      shown: served.shown,
      factKeyFps: served.factKeyFps,
      goals: listed.read.goals ?? [],
    },
  };
}

// `work` alone and whole, for a caller told `more`. The same views serve it, and it reads none of the
// page. The goals stay, as `moves` and `domain` keep them, so an empty list is never read as none.
async function workAlone(ctx: Ctx, now: Date, views: readonly string[]): Promise<Found<SelfView>> {
  const listed = await listGoals(ctx, {}, now, "set");
  const servesWork = servesTheWork(views);
  const work = servesWork
    ? (await workViews(ctx, { view: "now", whole: true }, now, [], undefined, supportsOf(ctx))).now
    : undefined;
  const withheld = [...(listed.withheld ? ["goals" as const] : []), ...(servesWork ? [] : ["work" as const])];
  return {
    value: {
      goals: await rankedGoals(ctx, listed),
      ...(withheld.length === 0 ? {} : { withheld }),
      ...emptyHead(await ownerTimeZone(ctx)),
      ...(work === undefined ? {} : { work }),
    },
    rows: listed.rows + 1,
    read: { bound: [], shown: [], factKeyFps: [], goals: listed.read.goals ?? [] },
  };
}

// The application signs, from every open item and not only those a page shows, each item a
// sign rests on in the read log as a served item is.
async function signsOf(
  ctx: Ctx,
  now: Date,
  openRead: OpenRead,
  input: { mail: boolean; tools: readonly string[]; lines: readonly BeliefLine[]; findings: readonly Finding[] },
): Promise<{ signs: ApplicationSign[]; read: ReadSet }> {
  const { signs, read } = await applicationsOf(ctx, now, {
    mail: input.mail,
    bodies: readsBodies(input.mail, input.tools),
    lines: input.lines,
    openItems: openRead.items,
    findings: input.findings,
    ownerNoes: input.tools.includes("list_opportunities"),
  });
  const rests = signs.flatMap((sign) => openRead.rests.get(sign.fact ?? sign.event ?? "") ?? []);
  return { signs, read: mergeReads(read, readOfRests(rests)) };
}

// An event's span as `upcoming` compares it: its instants, or an all-day event's days in the
// owner's zone. Null for an event with no start or no end.
function spanOf(row: MeetingRow, zone: string | null): { start: number; end: number } | null {
  if (row.starts_at === null || row.ends_at === null) return null;
  return row.all_day
    ? allDaySpan(row.starts_at, row.ends_at, zone)
    : { start: row.starts_at.getTime(), end: row.ends_at.getTime() };
}

// The head of get_self, which the packs and the run's self block read too. `read`, the audience's
// beliefs get_self read: `changes` is read from it; without it, none is
// read, so a pack's statements are those it sent before. `meetings`: at most that many, the
// earliest first, and only theirs read and logged.
// `tiers`, whether the owner's confirmed closeness orders the contacts and chat makes a contact, only for a client
// that holds the people view, which reads the ties themselves; a self-only client gets the order by
// `warmth` alone, so it learns no tier, no chat-only person and no
// confirmed closeness, it cannot read.
export async function selfOf(
  ctx: Ctx,
  now: Date,
  options: { read?: AudienceBeliefs; meetings?: number; tiers?: boolean } = {},
): Promise<SelfFound> {
  const at = now.toISOString();
  const addresses = await ctx.run<Printed>(OWNER_ADDRESSES, []);
  const ownAddresses = new Set(addresses.map((row) => row.value_fp));

  const timeZone = await ownerTimeZone(ctx);
  const horizon = now.getTime() + UPCOMING_DAYS * DAY_MS;
  const reach = (ms: number): string => new Date(ms).toISOString();
  const coming = (
    await ctx.run<MeetingRow>(UPCOMING, [reach(now.getTime() - ZONE_REACH_MS), reach(horizon + ZONE_REACH_MS)])
  )
    .flatMap((row) => {
      const span = spanOf(row, timeZone);
      return span !== null && span.end > now.getTime() && span.start < horizon ? [{ row, start: span.start }] : [];
    })
    .sort((a, b) => a.start - b.start || byText(a.row.id, b.row.id))
    .slice(0, options.meetings)
    .map((one) => one.row);
  const groups = await loadGroups(ctx);
  const meetings = await meetingsOf(ctx, coming, groups);
  const { counts, wroteTo } = await contactCounts(ctx, now, groups, options.tiers === true);
  const since90 = daysFrom(now, -90);
  // Read for every candidate, so which one is a machine's or the owner's turns on visible rows alone.
  const accounts = await ctx.run<
    Printed & { entity_id: string; bulk_sender: boolean; kind: AccountKind; person: boolean }
  >(CONTACT_ACCOUNTS, [[...counts.keys()].flatMap((id) => groups.membersOf(id)), since90, at]);
  const machine = new Set(
    accounts
      .filter((row) => {
        if (row.kind !== "email" && row.kind !== "shared") return true;
        const address = untrusted(ctx, "knowledge.accounts", "value_enc", row).untrusted;
        return addressKind(address, row.person ? "person" : null) !== "email";
      })
      .map((row) => row.entity_id),
  );
  const bulkSender = new Set(accounts.filter((row) => row.bulk_sender).map((row) => row.entity_id));
  const owners = new Set(accounts.filter((row) => ownAddresses.has(row.value_fp)).map((row) => row.entity_id));
  // A machine's and the owner's own are out first. One read of warmth for the rest: they are the ninety
  // days' direct correspondents and the closest by warmth, already read above.
  const kept = [...counts].filter(([id]) => !groups.membersOf(id).some((one) => machine.has(one) || owners.has(one)));
  const warmth = await warmthOf(
    ctx,
    groups,
    kept.map(([id]) => id),
  );
  const chattedAt = (id: string): string | undefined => {
    if (options.tiers !== true) return undefined;
    const line = warmth.get(id);
    const at = line?.lastTwoWayAt ?? null;
    return line?.channels?.includes("chat") === true && at !== null && at >= since90 ? at : undefined;
  };
  const statedClose = (id: string): boolean => {
    const line = warmth.get(id);
    return (
      options.tiers === true &&
      line?.tierSource === "owner" &&
      line.tier !== null &&
      line.tier !== undefined &&
      STATED_CLOSE.includes(line.tier)
    );
  };
  const placeOf = (id: string, count: Counts): number | null => {
    const twoWay = wroteTo.has(id) || count.meetings90d > 0 || chattedAt(id) !== undefined || statedClose(id);
    if (!twoWay && groups.membersOf(id).some((one) => bulkSender.has(one))) return null;
    return twoWay ? WROTE_OR_MET : OTHERS;
  };
  const placed = kept.flatMap(([id, count]) => {
    const place = placeOf(id, count);
    return place === null ? [] : [[id, count, place] as const];
  });
  const tie = (id: string): number => warmthOrder(warmth.get(id), options.tiers === true);
  const top = placed
    .sort(
      ([a, x, p], [b, y, q]) =>
        p - q ||
        tie(b) - tie(a) ||
        y.emails30d - x.emails30d ||
        y.emails90d - x.emails90d ||
        y.meetings90d - x.meetings90d ||
        byText(a, b),
    )
    .slice(0, CONTACTS);
  const who = await groupWho(
    ctx,
    groups,
    top.map(([id]) => id),
  );
  const contacts = top.flatMap(([id, count]): ContactCount[] => {
    const one = who.get(id);
    const chat = chattedAt(id);
    return one === undefined ? [] : [{ ...one, ...count, ...(chat === undefined ? {} : { lastTwoWayAt: chat }) }];
  });

  const upcoming = coming.flatMap((row) => meetings.get(row.id) ?? []);
  // The owner's beliefs that closed or expired lately, from get_self's one reading
  // of the audience's beliefs.
  const changed = options.read === undefined ? NO_CHANGES : await selfChangesOf(ctx, options.read, now, timeZone);
  return {
    value: {
      addresses: inRowOrder(ctx, "knowledge.accounts", "value_enc", addresses),
      timeZone,
      upcoming,
      contacts,
      changes: changed.changes,
    },
    rows: upcoming.length + contacts.length + changed.changes.length,
    // A served finding's agent record is shown by its own id.
    read: {
      bound: changed.read.bound,
      shown: [
        ...new Set([
          ...changed.read.shown,
          ...coming.filter((row) => meetings.has(row.id)).map((row) => row.evidence_id),
        ]),
      ],
      factKeyFps: changed.read.factKeyFps,
    },
    evidenceOf: new Map(coming.map((row) => [row.id, row.evidence_id])),
  };
}

// The ninety days' counts of each candidate contact, by entity or by its group's id, and those the
// owner wrote to. With `tiers`, the closest by warmth are candidates too, with no counts of their own.
async function contactCounts(
  ctx: Ctx,
  now: Date,
  groups: ClientGroups,
  tiers: boolean,
): Promise<{ counts: Map<string, Counts>; wroteTo: Set<string> }> {
  const at = now.toISOString();
  const since90 = daysFrom(now, -90);
  const joined = [groups.joined.map(([member]) => member), groups.joined.map(([, group]) => group)];
  const counts = new Map<string, Counts>();
  const countsOf = (id: string): Counts => {
    const known = counts.get(id) ?? { emails30d: 0, emails90d: 0, meetings90d: 0 };
    counts.set(id, known);
    return known;
  };
  const wroteTo = new Set<string>();
  for (const row of await ctx.run<{ entity_id: string; emails30d: number; emails90d: number; wrote_to90d: number }>(
    CONTACT_EMAILS,
    [since90, daysFrom(now, -30), at, ...joined, WROTE_TO_MAX_RECIPIENTS],
  )) {
    Object.assign(countsOf(row.entity_id), { emails30d: row.emails30d, emails90d: row.emails90d });
    if (row.wrote_to90d > 0) wroteTo.add(row.entity_id);
  }
  for (const row of await ctx.run<{ entity_id: string; meetings90d: number }>(CONTACT_MEETINGS, [
    since90,
    at,
    ...joined,
  ])) {
    countsOf(row.entity_id).meetings90d = row.meetings90d;
  }
  // Only for a client that holds the people view: a self-only client's list is its correspondents, as it was.
  if (tiers) {
    const ranking = await clientRanking(ctx, groups);
    const close = (row: WarmthRow): boolean =>
      (row.channels.includes("chat") &&
        row.last_two_way_at !== null &&
        new Date(row.last_two_way_at) >= new Date(since90)) ||
      (row.tier_source === "owner" && STATED_CLOSE.includes(row.tier));
    const order = (a: WarmthRow, b: WarmthRow): number =>
      TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
      Number(b.warmth) - Number(a.warmth) ||
      byText(a.entity_id, b.entity_id);
    for (const row of ranking === "rebuilding" ? [] : ranking.filter(close).sort(order).slice(0, CLOSE_READ))
      countsOf(groups.idOf(row.entity_id));
  }
  return { counts, wroteTo };
}

export const GET_SELF_TOOL: ReadTool<GetSelfArgs, SelfView> = {
  tool: "get_self",
  parse: (args) => parsed(GetSelfArgs.safeParse(args)),
  work: (ctx, valid, client, env) => getSelf(ctx, env.now(), valid, client.views, client.tools),
};
