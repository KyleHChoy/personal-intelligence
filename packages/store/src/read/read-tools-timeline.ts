// get_timeline: an entity's or a project's mail, meetings, captured meetings, facts and work,
// merged newest first and collapsed, with what the call read.

import {
  type EntityId,
  type FactView,
  GetTimelineArgs,
  type MessageId,
  type PersonalView,
  type TaskView,
  type TimelineEntry,
  type TimelineView,
  type UntrustedString,
  VIEW_OF_SUBJECT,
  type WorkSession,
} from "@intelligence/contracts/personal";
import { DAY_MS, maskCredentials } from "@intelligence/personal-core";
import { byText, stamp } from "../core/db.ts";
import { ANCHOR_LINK_TYPE } from "../core/link-types.ts";
import { type ClientGroups, type Ctx, type Entity, epochSeconds, type Found, untrusted } from "../core/read-ctx.ts";
import { parsed, type ReadTool, timed } from "../core/read-tool.ts";
import { workViews } from "../core/work-time-read.ts";
import { zonedBounds } from "../core/zone.ts";
import { supportsOf } from "./computed-beliefs.ts";
import { OWNER_ENTITY } from "./read-beliefs.ts";
import { factsOf } from "./read-facts.ts";
import { loadGroups } from "./read-groups.ts";
import { projectTimelineMail } from "./read-project-page.ts";
import {
  type AnchorRun,
  CAPTURED_MEETINGS_OF,
  type CapturedRow,
  capturedMeetingsOf,
  collapseAnchorRuns,
  itemKindsOf,
  runEntry,
  UNLINKED_MEETINGS,
} from "./read-timeline.ts";
import { ENTITY_OR_PROJECT, PROJECT } from "./read-tools.ts";
import { MEETING_COLUMNS, type MeetingRow, meetingsOf } from "./read-who.ts";

const TIMELINE_ENTRIES = 100;

// A bound of the window is bound as seconds since the epoch, never as text: the contract's
// Timestamp has forms the server does not take (an offset past 15:59), and a
// statement that fails at its bind would end the call with no policy.calls row.
const AT = "to_timestamp";

// The messages with a row for the entity, in any role, newest first. Never a held one: an entry
// carries the subject, and a one-time code is often in a subject. The row policy returns no held
// row either way. Found in full from the entity's rows first, by id and time alone, then cut, and
// only the page's rows read whole by their ids: a cut beside the messages would let the planner
// walk every message in time order.
const TIMELINE_MAIL = `
  with mail as materialized (
    select m.id, m.sent_at
    from knowledge.messages m
    where m.evidence_id in (select i.evidence_id from knowledge.interaction_log i where i.entity_id = any($1))
      and not m.held and m.sent_at <= ${AT}($3) and ($2::float8 is null or m.sent_at >= ${AT}($2))
  )
  select m.id, m.sent_at, m.direction, m.subject_enc, m.thread_id_enc, m.compartments, m.evidence_id
  from knowledge.messages m
  where m.id in (select mail.id from mail order by mail.sent_at desc, mail.id limit $4)
  order by m.sent_at desc, m.id`;

// The events the entity, or a member of its group, takes part in, cancelled ones included,
// newest first, each once.
const TIMELINE_MEETINGS = `
  with meetings as materialized (
    select ${MEETING_COLUMNS}
    from knowledge.events v
    join knowledge.event_details d on d.event_id = v.id
    where v.id in (select p.event_id from knowledge.event_participants p where p.entity_id = any($1))
      and v.occurred_at <= ${AT}($3) and ($2::float8 is null or v.occurred_at >= ${AT}($2))
  )
  select meetings.* from meetings
  order by meetings.occurred_at desc, meetings.id
  limit $4`;

type MailRow = {
  id: string;
  sent_at: Date;
  direction: "inbound" | "outbound";
  subject_enc: unknown;
  thread_id_enc: unknown;
  compartments: string[];
  evidence_id: string;
};

// The entity's facts are merged in: the claims naming it in the window, as find_facts reads them,
// each at its time. A fact whose subject's view the client lacks (the owner's, for a client without
// self) is left out after the read, so the statements are the same whatever the
// views. Such a fact does not leave the timeline short while more facts remain within
// TIMELINE_FACT_SCAN: the facts are read once more, as for a run. Known limit: past
// TIMELINE_FACT_SCAN facts, a timeline may hold fewer entries than the limit allows, and a run
// reaching the last fact read is counted only to there.
const TIMELINE_FACT_SCAN = 400;
const PROJECT_TIMELINE_DAYS = 365;

async function getTimeline(
  ctx: Ctx,
  args: GetTimelineArgs,
  now: Date,
  views: readonly PersonalView[],
): Promise<Found<TimelineView> | null> {
  const [entity] = await ctx.run<Entity>(ENTITY_OR_PROJECT, [args.id]);
  if (entity === undefined) return null;
  // A project is one only with its project row, as get_entity reads it. With no `from`, its work
  // entries go back a year: the entries kept are at most 100 anyway.
  const isProject = entity.kind === "project";
  if (isProject && (!views.includes("work") || (await ctx.run(PROJECT, [entity.id])).length === 0)) return null;
  const until = args.to === undefined ? now.getTime() : Date.parse(args.to);
  const work = isProject
    ? (
        await workViews(
          ctx,
          {
            view: "timeline",
            project: entity.id,
            from: args.from === undefined ? until - PROJECT_TIMELINE_DAYS * DAY_MS : Date.parse(args.from),
            to: until,
          },
          now,
          [],
          undefined,
          supportsOf(ctx),
        )
      ).timeline
    : undefined;
  const limit = Math.min(args.limit ?? TIMELINE_ENTRIES, TIMELINE_ENTRIES);
  const groups = await loadGroups(ctx);
  const members = entity.kind === "person" ? groups.membersOf(entity.id) : [entity.id];
  const window = [
    members,
    args.from === undefined ? null : epochSeconds(new Date(args.from)),
    epochSeconds(args.to === undefined ? now : new Date(args.to)),
    limit,
  ];

  // A project has no meetings by participation. Its mail is its evidence's.
  const mail = await ctx.run<MailRow>(isProject ? projectTimelineMail(AT) : TIMELINE_MAIL, window);
  const events = isProject ? [] : await ctx.run<MeetingRow>(TIMELINE_MEETINGS, window);
  // The meetings Lens recorded and linked to no event, a person's by the participant claims naming
  // the entity or a member of its group, a project's by its link.
  const linked = work?.meetings.map((one) => one.capture) ?? [];
  const captured = isProject
    ? linked.length === 0
      ? []
      : await ctx.run<CapturedRow>(UNLINKED_MEETINGS, [linked])
    : await ctx.run<CapturedRow>(CAPTURED_MEETINGS_OF, window);
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const others = [
    ...mail.map((row) => ({ at: row.sent_at, id: row.id, mail: row })),
    ...events.map((row) => ({ at: row.occurred_at, id: row.id, event: row })),
    ...captured.map((row) => ({ at: row.started_at, id: row.id, captured: row })),
    ...(work?.sessions ?? []).map((session) => ({
      at: new Date(session.start),
      id: `${session.start} session`,
      session,
    })),
    ...(work?.tasks ?? []).map((change) => ({
      at: new Date(change.at),
      id: `${String(change.task.capture)} ${change.change}`,
      change,
    })),
  ];
  // A captured meeting holds its own link fact, which is not served beside it.
  const absorbed = new Set(captured.map((row) => row.id));
  // Adjacent link facts of one project and item kind are one entry, and the limit
  // counts entries after that, so the facts are read once more, TIMELINE_FACT_SCAN of them, when
  // the entries fall short of it or end in a link an unread fact could join. That also refills
  // what a view left out (below).
  let scan = limit;
  for (;;) {
    const found = await factsOf(
      ctx,
      {
        entity: entity.id as EntityId,
        ...(args.from === undefined ? {} : { from: args.from }),
        to: args.to ?? now.toISOString(),
        limit: scan,
      },
      { ...(owner === undefined ? {} : { ownerId: owner.id }), members },
    );
    const facts: FactView[] = [];
    const links = new Map<string, FactView[]>();
    for (const fact of found.value.facts) {
      if (!views.includes(VIEW_OF_SUBJECT[fact.subject.kind])) continue;
      const meeting =
        fact.type === ANCHOR_LINK_TYPE && fact.capture !== null && absorbed.has(fact.capture) ? fact.capture : null;
      if (meeting === null) facts.push(fact);
      else links.set(meeting, [...(links.get(meeting) ?? []), fact]);
    }
    // When more facts were left unread, one older than the oldest read could belong among those
    // kept: nothing older than it is kept, so the entries are a newest-first prefix.
    const oldest = found.value.facts.at(-1);
    const floor = found.value.more && oldest !== undefined ? Date.parse(oldest.at) : null;
    const merged = [...others, ...facts.map((fact) => ({ at: new Date(fact.at), id: fact.id, fact }))]
      .filter((one) => floor === null || one.at.getTime() >= floor)
      .sort((a, b) => b.at.getTime() - a.at.getTime() || byText(a.id, b.id));
    const kinds = await itemKindsOf(ctx, facts);
    const collapsed = collapseAnchorRuns(merged, kinds);
    // The entries reach the end of what was read, and it ends in a link an unread fact could join.
    const last = collapsed.at(-1);
    const open =
      collapsed.length === limit &&
      last !== undefined &&
      ("run" in last ||
        ("fact" in last &&
          last.fact.type === ANCHOR_LINK_TYPE &&
          last.fact.capture !== null &&
          kinds.has(last.fact.capture)));
    if (found.value.more && scan < TIMELINE_FACT_SCAN && (collapsed.length < limit || open)) {
      scan = TIMELINE_FACT_SCAN;
      continue;
    }
    return timelineEntries(ctx, collapsed.slice(0, limit), found.rowOf, groups, links);
  }
}

type TimelineItem = { at: Date; id: string } & (
  | { mail: MailRow }
  | { event: MeetingRow }
  | { captured: CapturedRow }
  | { fact: FactView }
  | { session: WorkSession }
  | { change: { at: string; change: "created" | "completed" | "reopened"; task: TaskView } }
);

// The kept items as entries, with what the call read.
async function timelineEntries(
  ctx: Ctx,
  kept: readonly (TimelineItem | AnchorRun)[],
  rowOf: ReadonlyMap<string, { evidenceId: string | null; factKeyFp: string }>,
  groups: ClientGroups,
  links: ReadonlyMap<string, readonly FactView[]>,
): Promise<Found<TimelineView>> {
  const meetings = await meetingsOf(
    ctx,
    kept.flatMap((one) => ("event" in one ? [one.event] : [])),
    groups,
  );
  const recorded = await capturedMeetingsOf(
    ctx,
    kept.flatMap((one) => ("captured" in one ? [one.captured] : [])),
    groups,
  );

  const sealed = (row: MailRow, column: "subject_enc" | "thread_id_enc"): UntrustedString | null =>
    row[column] === null
      ? null
      : untrusted(ctx, "knowledge.messages", column, {
          id: row.id,
          compartments: row.compartments,
          value_enc: row[column],
        });
  const shown: string[] = [];
  const entries = kept.flatMap((one): TimelineEntry[] => {
    if ("run" in one) return [runEntry(one)];
    if ("fact" in one) return [{ kind: "fact", at: one.fact.at, fact: one.fact }];
    if ("session" in one) return [{ kind: "work_session", at: one.session.start, session: one.session }];
    if ("change" in one) return [{ kind: "task", at: one.change.at, change: one.change.change, task: one.change.task }];
    if ("mail" in one) {
      // A message the source gave no thread is a thread of one: its own id.
      const thread = sealed(one.mail, "thread_id_enc") ?? { untrusted: one.id };
      shown.push(one.mail.evidence_id);
      // The entry carries no count.
      const subject = sealed(one.mail, "subject_enc");
      return [
        {
          kind: "email",
          id: one.id as MessageId,
          at: stamp(one.at),
          direction: one.mail.direction,
          subject: subject === null ? null : { untrusted: maskCredentials(subject.untrusted).text },
          thread,
        },
      ];
    }
    if ("captured" in one) {
      const entry = recorded.entries.get(one.id);
      if (entry === undefined) return [];
      shown.push(one.captured.evidence_id);
      return [entry];
    }
    const meeting = meetings.get(one.id);
    if (meeting === undefined) return [];
    shown.push(one.event.evidence_id);
    return [{ kind: "meeting", at: stamp(one.at), meeting }];
  });
  // A kept fact's message, page, capture item or contact was opened, as find_facts opens it:
  // bound, with its fact key, and so is each fact of a kept run and each link a kept captured
  // meeting holds. A finding's binds nothing, and adds its fact key alone. A captured meeting's
  // participant claims add their fact keys.
  const keptFacts = kept
    .flatMap((one) =>
      "run" in one ? one.run.facts : "fact" in one ? [one.fact] : "captured" in one ? (links.get(one.id) ?? []) : [],
    )
    .map((fact) => rowOf.get(fact.id))
    .filter((row) => row !== undefined);
  const bound = [...new Set(keptFacts.flatMap((row) => (row.evidenceId === null ? [] : [row.evidenceId])))];
  const factKeyFps = [...new Set([...keptFacts.map((row) => row.factKeyFp), ...recorded.factKeyFps])];
  return { value: { entries }, rows: entries.length, read: { bound, shown: [...new Set(shown)], factKeyFps } };
}

export const GET_TIMELINE_TOOL: ReadTool<GetTimelineArgs, TimelineView> = {
  tool: "get_timeline",
  parse: (args) => timed(parsed(GetTimelineArgs.safeParse(args))),
  work: async (ctx, valid, client, env) => getTimeline(ctx, await zonedBounds(ctx, valid), env.now(), client.views),
};
