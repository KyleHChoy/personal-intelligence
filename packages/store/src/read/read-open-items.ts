import type { Envelope } from "@intelligence/contracts";
import {
  AgentRecordId,
  CaptureId,
  type ClientView,
  type CommitmentItem,
  DocumentId,
  dayIn,
  GetOpenItemsArgs,
  isSystemNotice,
  MessageId,
  OPEN_ITEMS_MOST,
  type OpenItem,
  type OpenItemEnding,
  type OpenItems,
  PROJECT_OPEN_ITEMS,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  composeOpenItems,
  type EventInput,
  isReminderEvent,
  normalizedLine,
  type OpenInputs,
  PAST_DUE_WINDOW_DAYS,
  type PlanInput,
  saysDeadline,
  saysDeadlineToOwner,
  withItemReports,
} from "@intelligence/personal-core/views";
import { fingerprint } from "../core/fingerprint.ts";
import type { Found, ReadSet } from "../core/read-ctx.ts";
import { type Ctx, mergeReads, readOfRests, sortedRead } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import type { Sealed } from "../core/seal.ts";
import { served } from "../core/served.ts";
import { inAudience, namesShown, RELEASE_IN_FORCE } from "../core/visibility.ts";
import { ownerTimeZone, ZONE_REACH_MS } from "../core/zone.ts";
import { asOfOf, beliefsAt } from "./computed-beliefs.ts";
import type { AudienceRead } from "./read-beliefs.ts";
import { commitmentsOf, OWNER_ENTITY } from "./read-beliefs.ts";
import { claimRecordOf, projectRowWho, seconds } from "./read-fact-rows.ts";
import { readsFindings, recentFindings } from "./read-findings.ts";
import { capText } from "./read-self.ts";
import { daysOf, MEETING_COLUMNS, type MeetingRow } from "./read-who.ts";

// Every row comes from a statement run under the caller's own token, whose row policies return only
// what it may see. The owner's reads run as pi_admin, whose policies return everything, so each table
// of each statement also states their audience, and `withheld` who they took out, rather than leaving
// either to the reader's policy. Core keeps, dates and orders those rows alone, so a row the caller
// cannot see moves no item, no order and no `more`.

// How far back a plan or a next step is read from, by when it was said, and the most of each read:
// the newest. A plan said longer ago than this and dated still to come is missed, and `more` says when
// the rows ran out first.
const OPEN_ITEM_SCAN_DAYS = 90;
const OPEN_ITEM_SCAN_ROWS = 500;
// How far ahead the calendar is read: its reminders, and the lines a plan may restate. Past this, no
// reminder is an item yet and a plan is taken at its word.
const OPEN_ITEM_HORIZON_DAYS = 45;
// How far back it is read: past the window a reminder stays open in, for what lately lapsed.
const OPEN_ITEM_CALENDAR_BACK_DAYS = 7;
// The most commitments joined: every open one, in practice.
const OPEN_ITEM_COMMITMENTS = 200;

// A claim names no one the caller is not shown: find_facts' rule, with who the owner took out stated.
const NAMES_SHOWN = namesShown(["owner", "person", "organization", "project"], "$4");

type FactRow = {
  id: string;
  fact_key_fp: string;
  valid_from: Date;
  content_enc: Sealed;
  compartments: string[];
  evidence_id: string;
};

// Who sent a plan's message: a person's own authenticated mail alone.
const SENDER = `case when p.direction = 'inbound' and p.bulk is not true and p.auth = 'pass' then
      (select i.entity_id from knowledge.interaction_log i
        where i.evidence_id = c.evidence_id and i.direction = 'inbound' and i.entity_role = 'sender' and ${inAudience("i", "$3")}
        order by i.entity_id, i.id limit 1) end`;

// The plans said since `$1`, the newest first, with where each can be read. A plan an agent wrote waits
// for the owner's confirm, its release, as every claim about them does; a held message's is left out, and so is
// one whose mail failed authentication, as the owed replies leave it out. What passed is read for a receipt.
// Who sent a message, so a person's line of their own mail can be told from a line about someone else.
export const PLANS = `
  with found as materialized (
    select c.id, c.valid_from, m.id as message_id, m.direction, m.thread_fp, m.bulk, m.sender_fp, m.auth, d.id as document_id, k.id as capture_id
    from knowledge.claims c
    left join knowledge.messages m on m.evidence_id = c.evidence_id and not m.held and not m.restricting and m.auth <> 'fail' and ${inAudience("m", "$3")}
    left join knowledge.documents d on d.evidence_id = c.evidence_id and not d.held and ${inAudience("d", "$3")}
    left join knowledge.captures k on k.evidence_id = c.evidence_id and ${inAudience("k", "$3")}
    where c.type = 'plan' and c.valid_from >= to_timestamp($1) and ${inAudience("c", "$3")}
      and (m.id is not null or d.id is not null or k.id is not null or c.released)
      and ${RELEASE_IN_FORCE}
      and ${NAMES_SHOWN}
    order by c.valid_from desc, c.id, m.id, d.id, k.id
    limit $2
  )
  select c.id, c.fact_key_fp, c.valid_from, c.content_enc, c.compartments, c.evidence_id,
    p.message_id, p.direction, p.thread_fp, p.bulk, p.sender_fp, p.auth, p.document_id, p.capture_id,
    ${SENDER} as sender_entity,
    exists (select 1 from knowledge.interaction_log o
            where o.entity_id = ${SENDER} and o.direction = 'outbound' and ${inAudience("o", "$3")}) as sender_written
  from found p
  join knowledge.claims c on c.id = p.id
  order by p.valid_from desc, c.id, p.message_id, p.document_id, p.capture_id`;
type PlanRow = FactRow & {
  message_id: string | null;
  direction: "inbound" | "outbound" | null;
  thread_fp: string | null;
  bulk: boolean | null;
  sender_fp: string | null;
  auth: string | null;
  document_id: string | null;
  capture_id: string | null;
  sender_entity: string | null;
  sender_written: boolean;
};

// The owner's latest message on each of these threads, of those the caller can read. A held one moves
// nothing, as it serves nothing. By the sent-time index within the plans' window: no index leads with
// the thread.
const OWN_REPLIES = `
  select m.thread_fp, max(m.sent_at) as replied_at
  from knowledge.messages m
  where m.thread_fp = any($1::text[]) and m.direction = 'outbound' and m.sent_at >= to_timestamp($2)
    and not m.held and not m.restricting and ${inAudience("m", "$3")}
  group by m.thread_fp
  order by m.thread_fp`;

// The dated situations still running or a little past, the newest first, with where each can be read:
// its message, document or capture, or an agent's unflagged record. Only those saying a deadline
// become items.
const DATED_SITUATIONS = `
  with found as materialized (
    select c.id, c.valid_from, m.id as message_id, m.direction, d.id as document_id, k.id as capture_id, w.id as record_id, w.client_name
    from knowledge.claims c
    left join knowledge.messages m on m.evidence_id = c.evidence_id and not m.held and not m.restricting and m.auth <> 'fail' and ${inAudience("m", "$3")}
    left join knowledge.documents d on d.evidence_id = c.evidence_id and not d.held and ${inAudience("d", "$3")}
    left join knowledge.captures k on k.evidence_id = c.evidence_id and ${inAudience("k", "$3")}
    left join ledger.agent_writes w on w.evidence_id = c.evidence_id and w.flagged_at is null and ${inAudience("w", "$5")}
    where c.type = 'situation' and c.valid_to >= to_timestamp($1) and not c.closes and ${inAudience("c", "$3")}
      and (m.id is not null or d.id is not null or k.id is not null or w.id is not null)
      and ${RELEASE_IN_FORCE}
      and ${NAMES_SHOWN}
    order by c.valid_from desc, c.id, m.id, d.id, k.id, w.id
    limit $2
  )
  select c.id, c.fact_key_fp, c.valid_from, c.content_enc, c.compartments, c.evidence_id,
    p.message_id, p.direction, p.document_id, p.capture_id, p.record_id, p.client_name
  from found p
  join knowledge.claims c on c.id = p.id
  order by p.valid_from desc, c.id, p.message_id, p.document_id, p.capture_id, p.record_id`;
type SituationRow = Omit<PlanRow, "thread_fp" | "bulk" | "sender_fp" | "auth" | "sender_entity" | "sender_written"> & {
  record_id: string | null;
  client_name: string | null;
};

// The beliefs of these fact keys, computed under the caller's clearance (the owner's audience for
// an owner read): a situation the owner or a later statement closed is no item. One past its date
// stays, as any deadline stays a little past due.

// The next steps agents reported since `$1`, the newest first, each with its record, unflagged.
const NEXT_STEPS = `
  with found as materialized (
    select c.id, c.valid_from, w.id as record_id, w.client_name
    from knowledge.claims c
    join ledger.agent_writes w on w.evidence_id = c.evidence_id and w.flagged_at is null and ${inAudience("w", "$3")}
    where c.type = 'project.next_step' and c.valid_from >= to_timestamp($1) and ${inAudience("c", "$3")}
      and ${RELEASE_IN_FORCE}
      and ($5::text is null or exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id and x.entity_id = $5))
      and ${NAMES_SHOWN}
    order by c.valid_from desc, c.id, w.id
    limit $2
  )
  select c.id, c.fact_key_fp, c.valid_from, c.content_enc, c.compartments, c.evidence_id, p.record_id, p.client_name
  from found p
  join knowledge.claims c on c.id = p.id
  order by p.valid_from desc, c.id, p.record_id`;
type StepRow = FactRow & { record_id: string; client_name: string };

// Of these records, those a live correction replaced. A client reads through its own definer. The owner
// has no client, and states the chain: a later record with a body, unflagged, within their audience.
const CORRECTED_FOR_CLIENT = "select l.root from policy.live_corrections($1::text[]) l order by l.root";
const CORRECTED_FOR_OWNER = `
  with recursive later (root, id, live) as (
    select x.supersedes, x.id, x.body_enc is not null from ledger.agent_writes x
    where x.supersedes = any($1::text[]) and x.flagged_at is null and x.compartments <@ $2::text[]
    union
    select l.root, x.id, x.body_enc is not null from later l
    join ledger.agent_writes x on x.supersedes = l.id and x.flagged_at is null and x.compartments <@ $2::text[]
  )
  select l.root from later l where l.live order by l.root`;

// Every event in the window that is not cancelled, with the other people on it the caller is shown.
const EVENTS = `
  select ${MEETING_COLUMNS},
    (select count(*)::int from knowledge.event_participants p
      where p.event_id = v.id and ${inAudience("p", "$3")}
        and (select e.kind from knowledge.entities e where e.id = p.entity_id) in ('person', 'organization')) as others
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where not d.cancelled and d.starts_at < to_timestamp($2) and d.ends_at > to_timestamp($1)
    and ${inAudience("v", "$3")} and ${inAudience("d", "$3")}
  order by d.starts_at, v.id`;
type EventRow = MeetingRow & { others: number };

const CLOSES = "select item_key, match_key, ending, at, due from policy.open_item_closes($1::text[])";

// The projects each commitment's claims are bound to, and the names of projects, as the token shows them.
const BOUND_PROJECTS = `
  select c.fact_key_fp, b.project_id
  from knowledge.claims c
  join knowledge.project_bindings b on b.claim_id = c.id and b.undone_at is null and ${inAudience("b", "$2")}
  where c.fact_key_fp = any($1::text[]) and ${inAudience("c", "$2")}
  order by c.fact_key_fp, b.project_id, c.id, b.id`;
const PROJECT_NAMES = `
  select p.id, p.compartments, p.name_enc from knowledge.projects p
  where p.id = any($1::text[]) and ${inAudience("p", "$2")}
  order by p.id`;

// What the caller reads. `audience` and `withheld` are the owner's own statement of what pi_reader's
// row policies hold; each client's is null and empty. `self`, `work` and `people` are the client's views.
type OpenScope = {
  audience: string[] | null;
  // The owner's audience with the agents' compartments: a finding's label names its agent, whom no
  // belief's audience need hold. A client's token holds this itself.
  findings: string[] | null;
  withheld: readonly string[];
  self: boolean;
  work: boolean;
  // A line filed under a person reads only with their view.
  people?: boolean;
  // One project's next steps alone, for its page.
  project?: string;
};

// What an item rests on, for the read log.
type Rests = { bound: string[]; shown: string[]; fact: string | null; match: string | null };

// An item's id and what its words match, both keyed fingerprints: a fact key names a thread or a report
// and not one statement in it, so two steps of one report share it, and the same step in a new record
// does not. Keyed, as every fingerprint of a source's words is, so a stored close gives no words away.
const itemId = (ctx: Ctx, fact: string, what: string): string =>
  fingerprint(ctx.keys, "open_item", `item\n${fact}\n${normalizedLine(what)}`);
const matchOf = (ctx: Ctx, scope: string, what: string): string =>
  fingerprint(ctx.keys, "open_item", `match\n${scope}\n${normalizedLine(what)}`);

export type OpenRead = {
  items: OpenItem[];
  lapsed: { key: string; at: number }[];
  // A source ran past what is read of it.
  cut: boolean;
  // The items' ids that a person's own mail gave the owner, for `pia outcomes`.
  fromPeople: ReadonlySet<string>;
  // Of those, from a person the owner has never written to: what next ranks them after a reply owed.
  strangers: ReadonlySet<string>;
  rests: ReadonlyMap<string, Rests>;
};

const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

async function projectWho(ctx: Ctx, scope: OpenScope, ids: readonly string[]): Promise<Map<string, Who>> {
  const rows = await ctx.run<{ id: string; compartments: string[]; name_enc: Envelope }>(PROJECT_NAMES, [
    [...new Set(ids)],
    scope.audience,
  ]);
  return new Map(rows.map((row) => [row.id, projectRowWho(ctx, row)]));
}

// An event as core reads it. A title is required of an item, so one with none is read as no event.
function eventOf(ctx: Ctx, row: EventRow, zone: string | null): EventInput | null {
  if (row.starts_at === null || row.ends_at === null || row.title_enc === null) return null;
  const title = served(ctx, row, "knowledge.event_details.title_enc").untrusted;
  const days = row.all_day ? daysOf(row.starts_at, row.ends_at) : null;
  const minutes = Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000);
  return {
    id: row.id,
    title,
    day: days?.date ?? dayIn(row.starts_at, zone),
    due: days?.date ?? row.starts_at.toISOString(),
    allDay: row.all_day,
    days: days === null ? 1 : Math.round((Date.parse(days.lastDate) - Date.parse(days.date)) / DAY_MS) + 1,
    minutes,
    others: row.others,
    declined: row.owner_response === "declined",
  };
}

// The stored sources, joined: `commitments`, each caller's own read of them; the plans, next steps and
// calendar events by the statements above, as the scope's views allow; and the owner's closes.
export async function readOpenItems(
  ctx: Ctx,
  scope: OpenScope,
  now: Date,
  commitments: { items: readonly CommitmentItem[]; evidenceOf?: ReadonlyMap<string, string>; more: boolean },
): Promise<OpenRead> {
  const [ownerRow] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  if (ownerRow === undefined)
    return { items: [], lapsed: [], cut: false, fromPeople: new Set(), strangers: new Set(), rests: new Map() };
  const owner = { id: ownerRow.id, kind: "owner", name: null, address: null } as Who;
  const zone = await ownerTimeZone(ctx);
  const since = seconds(new Date(now.getTime() - OPEN_ITEM_SCAN_DAYS * DAY_MS).toISOString());
  const withheld = [...scope.withheld];
  const rests = new Map<string, Rests>();
  const fromPeople = new Set<string>();
  const strangers = new Set<string>();

  const planRows = scope.self
    ? await ctx.run<PlanRow>(PLANS, [since, OPEN_ITEM_SCAN_ROWS, scope.audience, withheld])
    : [];
  const stepRows = scope.work
    ? await ctx.run<StepRow>(NEXT_STEPS, [since, OPEN_ITEM_SCAN_ROWS, scope.findings, withheld, scope.project ?? null])
    : [];
  const corrected =
    stepRows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await ctx.run<{ root: string }>(
              scope.audience === null ? CORRECTED_FOR_CLIENT : CORRECTED_FOR_OWNER,
              scope.audience === null
                ? [[...new Set(stepRows.map((row) => row.record_id))]]
                : [[...new Set(stepRows.map((row) => row.record_id))], scope.findings],
            )
          ).map((row) => row.root),
        );

  const threads = [...new Set(planRows.flatMap((row) => (row.thread_fp === null ? [] : [row.thread_fp])))];
  const replies = new Map(
    threads.length === 0
      ? []
      : (await ctx.run<{ thread_fp: string; replied_at: Date }>(OWN_REPLIES, [threads, since, scope.audience])).map(
          (row) => [row.thread_fp, row.replied_at.getTime()] as const,
        ),
  );
  const plans: PlanInput[] = planRows.flatMap((row) => {
    const record = claimRecordOf(ctx, row);
    const { fields, subject } = record.claim.content;
    const what = textOf(fields.what);
    const repliedAt = row.thread_fp === null ? undefined : replies.get(row.thread_fp);
    if (what === null) return [];
    // A person's mail giving the owner a deadline is filed with that person as its subject, and is the owner's
    // to meet all the same: only their own mail, to the owner, authenticated and not bulk (`sender_entity`), in
    // words that say it.
    const ownersDeadline =
      scope.people === true &&
      record.subjectKind === "person" &&
      !isSystemNotice(record) &&
      (subject as string) === row.sender_entity &&
      saysDeadlineToOwner(what);
    // A plan's subject is who proposed or confirmed it, so one a person proposed to the owner names the owner as
    // its counterparty: the owner's arrangement all the same, read, as any line filed under a person, with their view.
    const ownersPlan =
      (record.subjectKind === "owner" && (subject as string) === owner.id) ||
      (scope.people === true && record.subjectKind === "person" && fields.counterparty === owner.id);
    if (!ownersDeadline && !ownersPlan) return [];
    // A document's fact binds nothing, as find_facts' (`binds`).
    const binds = row.message_id !== null || row.capture_id !== null;
    const key = itemId(ctx, row.fact_key_fp, what);
    const match = matchOf(ctx, "plan", what);
    if (ownersDeadline) fromPeople.add(key);
    if (ownersDeadline && !row.sender_written) strangers.add(key);
    // Rows come newest first, and the newest is the statement served.
    if (!rests.has(key))
      rests.set(key, { bound: binds ? [row.evidence_id] : [], shown: [], fact: row.fact_key_fp, match });
    return [
      {
        key,
        match,
        at: row.valid_from.getTime(),
        what,
        when: fields.when,
        ownMail: row.direction === "outbound",
        ...(row.bulk === true || isSystemNotice(record) ? { bulk: true } : {}),
        ...(row.sender_fp === null ? {} : { sender: row.sender_fp }),
        ...(row.auth === "pass" ? { authed: true } : {}),
        ...(row.thread_fp === null ? {} : { thread: row.thread_fp }),
        ...(repliedAt === undefined ? {} : { repliedAt }),
        refs: {
          ...(row.message_id === null ? {} : { message: MessageId.parse(row.message_id) }),
          ...(row.document_id === null ? {} : { document: DocumentId.parse(row.document_id) }),
          ...(row.capture_id === null ? {} : { capture: CaptureId.parse(row.capture_id) }),
        },
      },
    ];
  });

  // Dated situations whose words say a deadline, as plans: their `until` is the date. One an agent
  // reported is served with its record, which says nobody has confirmed it, as a next step is.
  const situationRows = scope.self
    ? await ctx.run<SituationRow>(DATED_SITUATIONS, [
        (now.getTime() - (PAST_DUE_WINDOW_DAYS + 1) * DAY_MS) / 1000,
        OPEN_ITEM_SCAN_ROWS,
        scope.audience,
        withheld,
        scope.findings,
      ])
    : [];
  const situationsSaid = situationRows.flatMap((row) => {
    const record = claimRecordOf(ctx, row);
    const { fields, subject } = record.claim.content;
    const what = textOf(fields.what);
    if (what === null || !saysDeadline(what) || record.subjectKind !== "owner" || (subject as string) !== owner.id)
      return [];
    return [{ row, what, until: fields.until }];
  });
  const situationBeliefs = await beliefsAt(
    ctx,
    situationsSaid.map((one) => one.row.fact_key_fp),
    await asOfOf(ctx),
    { audience: scope.audience },
  );
  const ended = new Set(
    situationBeliefs.flatMap((one) => (one.belief.status === "closed" ? [one.row.fact_key_fp] : [])),
  );
  const situations: PlanInput[] = situationsSaid.flatMap(({ row, what, until }) => {
    if (ended.has(row.fact_key_fp)) return [];
    const binds = row.message_id !== null || row.capture_id !== null;
    const key = itemId(ctx, row.fact_key_fp, what);
    const match = matchOf(ctx, "plan", what);
    if (!rests.has(key))
      rests.set(key, {
        bound: binds ? [row.evidence_id] : [],
        shown: row.record_id === null ? [] : [row.record_id],
        fact: row.fact_key_fp,
        match,
      });
    return [
      {
        key,
        match,
        at: row.valid_from.getTime(),
        what,
        when: until,
        ownMail: row.direction === "outbound",
        refs: {
          ...(row.message_id === null ? {} : { message: MessageId.parse(row.message_id) }),
          ...(row.document_id === null ? {} : { document: DocumentId.parse(row.document_id) }),
          ...(row.capture_id === null ? {} : { capture: CaptureId.parse(row.capture_id) }),
          ...(row.record_id === null ? {} : { record: AgentRecordId.parse(row.record_id) }),
          ...(row.record_id === null || row.client_name === null ? {} : { agent: row.client_name }),
        },
      },
    ];
  });

  const steps = stepRows.flatMap((row) => {
    if (corrected.has(row.record_id)) return [];
    const record = claimRecordOf(ctx, row);
    const { fields, subject } = record.claim.content;
    const what = textOf(fields.what);
    if (what === null || fields.who !== owner.id) return [];
    return [{ row, what, subject, due: fields.due }];
  });

  const windowFrom = now.getTime() - OPEN_ITEM_CALENDAR_BACK_DAYS * DAY_MS - ZONE_REACH_MS;
  const windowTo = now.getTime() + OPEN_ITEM_HORIZON_DAYS * DAY_MS + ZONE_REACH_MS;
  const eventRows = scope.self
    ? await ctx.run<EventRow>(EVENTS, [windowFrom / 1000, windowTo / 1000, scope.audience])
    : [];
  const events = eventRows.flatMap((row) => {
    const event = eventOf(ctx, row, zone);
    if (event === null) return [];
    if (isReminderEvent(event)) rests.set(row.id, { bound: [], shown: [row.evidence_id], fact: null, match: null });
    return [event];
  });

  const held = commitments.items;
  const bound = await ctx.run<{ fact_key_fp: string; project_id: string }>(BOUND_PROJECTS, [
    held.map((one) => one.belief.fact),
    scope.audience,
  ]);
  const projects = await projectWho(ctx, scope, [
    ...steps.map((one) => one.subject),
    ...bound.map((row) => row.project_id),
  ]);
  const projectOf = new Map(bound.map((row) => [row.fact_key_fp, projects.get(row.project_id)]));

  const nextSteps: OpenInputs["nextSteps"] = steps.flatMap((one) => {
    const project = projects.get(one.subject);
    if (project === undefined) return [];
    const key = itemId(ctx, one.row.fact_key_fp, one.what);
    const match = matchOf(ctx, `step\n${project.id}`, one.what);
    if (!rests.has(key)) rests.set(key, { bound: [], shown: [one.row.record_id], fact: one.row.fact_key_fp, match });
    return [
      {
        key,
        match,
        agent: one.row.client_name,
        what: one.what,
        due: one.due,
        at: one.row.valid_from.getTime(),
        evidence: one.row.evidence_id,
        project,
        refs: { record: AgentRecordId.parse(one.row.record_id), agent: one.row.client_name },
      },
    ];
  });

  const commitmentInputs = held.flatMap((one) => {
    const whoActs = one.direction === "owed_by_owner" ? owner : one.counterparty;
    if (whoActs === null) return [];
    const via = one.message ?? one.capture;
    const evidence = via === null ? undefined : commitments.evidenceOf?.get(via);
    rests.set(one.belief.fact, {
      bound: evidence === undefined ? [] : [evidence],
      shown: [],
      fact: one.belief.fact,
      match: null,
    });
    return [
      {
        key: one.belief.fact,
        what: one.what?.untrusted ?? null,
        due: one.due,
        whoActs,
        project: projectOf.get(one.belief.fact) ?? null,
        refs: {
          ...(one.message === null ? {} : { message: one.message }),
          ...(one.capture === null ? {} : { capture: one.capture }),
        },
      },
    ];
  });

  const asked = [...new Set([...rests].flatMap(([key, rest]) => (rest.match === null ? [key] : [key, rest.match])))];
  const closes = await ctx.run<{
    item_key: string;
    match_key: string | null;
    ending: OpenItemEnding;
    at: string;
    due: string | null;
  }>(CLOSES, [asked]);
  const { items, lapsed } = composeOpenItems(
    {
      owner,
      commitments: commitmentInputs,
      nextSteps,
      plans: [...plans, ...situations],
      events,
      closes: closes.map((row) => ({
        key: row.item_key,
        match: row.match_key,
        ending: row.ending,
        at: row.at,
        due: row.due,
      })),
    },
    now,
    zone,
  );
  return {
    items: items.map((one) => ({
      ...one,
      what: one.what === null ? null : { untrusted: capText(one.what.untrusted) },
    })),
    lapsed,
    cut:
      commitments.more ||
      planRows.length >= OPEN_ITEM_SCAN_ROWS ||
      stepRows.length >= OPEN_ITEM_SCAN_ROWS ||
      situationRows.length >= OPEN_ITEM_SCAN_ROWS,
    fromPeople,
    strangers,
    rests,
  };
}

// The first `most` items, whether more were left, and the read log's rows for those served alone.
export function servedOpenItems(
  read: OpenRead,
  most: number,
): Found<OpenItems> & {
  read: ReadSet;
  evidenceOf: ReadonlyMap<string, string>;
  factKeyOf: ReadonlyMap<string, string>;
} {
  const items = read.items.slice(0, most);
  const rests = items.flatMap((one) => {
    const found = read.rests.get(one.source.id);
    return found === undefined ? [] : [found];
  });
  return {
    value: { items, more: read.cut || read.items.length > most },
    rows: items.length,
    read: sortedRead(readOfRests(rests)),
    factKeyOf: new Map(
      items.flatMap((one) => {
        const fact = read.rests.get(one.source.id)?.fact;
        return fact === undefined || fact === null ? [] : [[one.source.id, fact] as const];
      }),
    ),
    // Each item's id to what a pack, which binds nothing, logs it as shown.
    evidenceOf: new Map(
      items.flatMap((one) => {
        const found = read.rests.get(one.source.id);
        const shown = found?.bound[0] ?? found?.shown[0];
        return shown === undefined ? [] : [[one.source.id, shown] as const];
      }),
    ),
  };
}

// The caller's own open items: its commitments by the reader's read, with `read` when the call
// already read the audience's beliefs.
export async function openItemsOf(
  ctx: Ctx,
  views: readonly string[],
  now: Date,
  read: AudienceRead,
): Promise<OpenRead> {
  const work = views.includes("work");
  const commitments = work
    ? await commitmentsOf(ctx, { state: "open", limit: OPEN_ITEM_COMMITMENTS, lapseAt: now }, read)
    : undefined;
  return readOpenItems(
    ctx,
    {
      audience: null,
      findings: null,
      withheld: [],
      self: views.includes("self"),
      work,
      people: views.includes("people"),
    },
    now,
    commitments === undefined
      ? { items: [], more: false }
      : { items: commitments.commitments, evidenceOf: commitments.evidenceOf, more: commitments.more },
  );
}

// A project's next steps for the owner, for its page: no calendar, no plan and no commitment is read,
// so the page keeps its one-entity deadline.
export async function projectOpenItems(
  ctx: Ctx,
  project: string,
  now: Date,
): Promise<Found<OpenItems> & { read: ReadSet }> {
  const read = await readOpenItems(
    ctx,
    { audience: null, findings: null, withheld: [], self: false, work: true, project },
    now,
    { items: [], more: false },
  );
  return servedOpenItems(read, PROJECT_OPEN_ITEMS);
}

export const GET_OPEN_ITEMS_TOOL: ReadTool<GetOpenItemsArgs, OpenItems> = {
  tool: "get_open_items",
  parse: (args) => parsed(GetOpenItemsArgs.safeParse(args)),
  work: async (ctx, valid, client: ClientView, env) => {
    const read = await openItemsOf(ctx, client.views, env.now(), "fresh");
    const served = servedOpenItems(read, valid.limit ?? OPEN_ITEMS_MOST);
    if (!readsFindings(client.views, client.tools)) return served;
    const items = withItemReports(served.value.items, await recentFindings(ctx, env.now()), await ownerTimeZone(ctx));
    return {
      ...served,
      value: { ...served.value, items },
      read: {
        ...served.read,
        shown: mergeReads(served.read, {
          shown: items.flatMap((item) => (item.reported ?? []).map((one) => one.record as string)),
        }).shown,
      },
    };
  },
};
