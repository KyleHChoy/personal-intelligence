import {
  AGENT_GUIDE_VERSION,
  AGENT_RECORD_SAY,
  AGENT_STANDING_SAY,
  type AttendeeBrief,
  agentGuideFor,
  agentRecordEmpty,
  BuildContextPackArgs,
  type ClientView,
  type CompiledBelief,
  type CompiledFacts,
  type ContextPack,
  type EntityId,
  type EventId,
  type MessageId,
  OPEN_BELIEF_STATUS,
  PACK_VIEW,
  type PackItem,
  type PackSection,
  PersonalReadTool,
  PersonalWorkTool,
  TOOL_VIEW,
  WORK_TOOL_VIEW,
} from "@intelligence/contracts/personal";
import {
  assemblePack,
  currentOf,
  type PackTemplate,
  SELECTOR_IN_ORDER,
  templateFor,
} from "@intelligence/personal-core/views";
import { stamp, stampOrNull } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Found } from "../core/read-ctx.ts";
import { type Ctx, epochSeconds, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { MAIL_COUNTS } from "../core/statements.ts";
import { workViews } from "../core/work-time-read.ts";
import { unreportedOf } from "../core/work-unreported.ts";
import { supportsOf } from "./computed-beliefs.ts";
import { ownRecordOf, ownStandingOf } from "./read-agent-record.ts";
import { type AudienceRead, audienceBeliefs, commitmentsOf } from "./read-beliefs.ts";
import { attendeeFactsOf, statedFactsOf } from "./read-compiled.ts";
import { SHOWN as GOALS_SHOWN } from "./read-goals.ts";
import { knownIssuesOf, knownIssuesServed } from "./read-known-issues.ts";
import { learningsOf, learningsServed } from "./read-learnings.ts";
import { factsOf, SUMMARY_COLUMNS, type SummaryRow, summaryOf } from "./read-messages.ts";
import { openItemsOf, servedOpenItems } from "./read-open-items.ts";
import {
  HANDOFF,
  meetingItem,
  NOTES_LEFT_OUT,
  PREFERENCES,
  type PreferenceRow,
  packEntity,
  preferenceItem,
  type RecordRow,
  recordItem,
  sectionOf,
} from "./read-pack-items.ts";
import { projectBrief } from "./read-pack-project.ts";
import { secondDegreeSection } from "./read-pack-second-degree.ts";
import { heldWork, WORK_HANDOFFS } from "./read-pack-work.ts";
import { LAST_THREADS, type LastThreadRow, threadPointer } from "./read-person-lead.ts";
import { capturePointer, LAST_CAPTURES, type LastCaptureRow, prepNotes } from "./read-prep-notes.ts";
import { entityOf } from "./read-tools-entity.ts";
import { selfOf } from "./read-tools-self.ts";
import { EVENT, type MeetingRow, meetingsOf } from "./read-who.ts";

// Reader.buildContextPack's work, run inside the call's one repeatable-read transaction under the client's token:
// one fixed query for each part, each ending in an order with a unique key; the assembly; the
// session; policy.log_pack. Every item is a row the token returned, and every count is over
// such rows. The read set handed back is computed from the
// assembled pack's items, after the cut, so a row read and cut is logged nowhere.

// The latest messages with each attendee.
const PER_ATTENDEE = 5;

const LOG_PACK = "select policy.log_pack($1, $2, $3, $4, $5, $6)";

// As get_entity's mail: distinct messages among each entity's direct rows, by direction, and the
// last time of any of its rows.
const MAIL = `
  select i.entity_id,
    ${MAIL_COUNTS},
    max(i.occurred_at) as last_at
  from knowledge.interaction_log i
  where i.entity_id = any($1)
  group by i.entity_id
  order by i.entity_id`;

// Each entity's latest meeting that started before the pack's time, is not cancelled and is not
// this event.
const LAST_MEETINGS = `
  select distinct on (p.entity_id) p.entity_id, d.starts_at as last_meeting_at, v.id, v.evidence_id
  from knowledge.event_participants p
  join knowledge.events v on v.id = p.event_id
  join knowledge.event_details d on d.event_id = v.id
  where p.entity_id = any($1) and not d.cancelled and d.starts_at < $2 and v.id <> $3
  order by p.entity_id, d.starts_at desc, v.id`;

// The five latest messages with each attendee, in any role, up to the pack's time: one row per
// message, newest first, then by id. A bulk message has no interaction row, so none is here.
// Each attendee's messages are found in full from its visible rows, ranked, and only then cut: a
// cut beside the messages would let the planner walk the messages of every compartment in time order. So the work grows with the attendees' visible mail, where
// the walk stopped at five each; the price of reading no hidden row. `picked` is materialized
// too, for the last cut: without it the planner could walk the messages in time order and test
// each against the picked ids.
const RECENT_MESSAGES = `
  with mine as materialized (
    select i.entity_id, n.id, n.sent_at
    from knowledge.interaction_log i
    join knowledge.messages n on n.evidence_id = i.evidence_id
    where i.entity_id = any($1::text[]) and not n.held and n.sent_at <= to_timestamp($2)
    group by i.entity_id, n.id, n.sent_at
  ),
  picked as materialized (
    select ${SUMMARY_COLUMNS}
    from knowledge.messages m
    where m.id in (
      select r.id from (
        select mine.id, row_number() over (partition by mine.entity_id order by mine.sent_at desc, mine.id) as place
        from mine
      ) r
      where r.place <= $3)
  )
  select picked.* from picked
  order by picked.sent_at desc, picked.id
  limit $4`;

// What the call answers: a pack, a refusal for the purpose's view, or null for an event that is
// not there or not visible.
type PackOutcome = Found<ContextPack> | "not_permitted" | null;

// `factKeyOf`: the fact key each second-degree line's cited claim is read under, by the item's id.
type Built = {
  // The beliefs a person's `lead` serves the words of, whether or not the facts section keeps them.
  leadBeliefs?: readonly CompiledBelief[];
  sections: Partial<Record<PackSection, PackItem[]>>;
  evidenceOf: ReadonlyMap<string, string>;
  cut: boolean;
  factKeyOf?: ReadonlyMap<string, string>;
  // What each held piece of work, or a project_brief's project, shows, and the goals it returns,
  // by its item's id.
  shownOf?: ReadonlyMap<string, string[]>;
  goalsOf?: ReadonlyMap<string, string[]>;
};

// Version 2's commitments: the open ones, in
// get_commitments' order, asked for the cap and one more, so that a 21st makes the required section
// longer than its cap and the assembly cuts it and sets truncated. When the function itself
// answered `more`, at its limit or at the ceiling, the reader says the list was cut. A client
// without the section's view is not asked about beliefs at all. A section with `lapse` serves no
// lapsed courtesy as open.
async function commitmentsSection(
  ctx: Ctx,
  client: ClientView,
  template: PackTemplate,
  now: Date,
  other: readonly string[] | undefined,
  read: AudienceRead,
): Promise<Omit<Built, "sections"> & { items: PackItem[] }> {
  const section = sectionOf(template, "commitments");
  if (!client.views.includes(section.view)) return { items: [], evidenceOf: new Map(), cut: false };
  const found = await commitmentsOf(
    ctx,
    {
      state: "open",
      limit: section.cap + 1,
      sourceFirst: section.order === "source_first",
      ...(other === undefined ? {} : { with: other }),
      ...(section.lapse === "courtesy" ? { lapseAt: now } : {}),
    },
    read,
  );
  const items = found.commitments.map(
    (commitment): PackItem => ({
      id: commitment.belief.fact,
      section: "commitments",
      required: section.required,
      provenance: commitment.belief.provenance,
      asOf: commitment.belief.confirmedAt,
      kind: "commitment",
      commitment,
    }),
  );
  return { items, evidenceOf: found.evidenceOf, cut: found.more };
}

// A facts section: the compiled beliefs `compile` gives that `keep` keeps, in
// their order, each an item whose id is its belief's fact. agent_bootstrap's are the owner's
// open stated beliefs, meeting_prep's each attendee's, and person_brief's the person's. The
// section's cap is the assembly's to apply. A client without the section's view is not asked
// about beliefs at all.
async function factsSection(
  client: ClientView,
  template: PackTemplate,
  compile: () => Promise<{ facts: CompiledFacts; evidenceOf: ReadonlyMap<string, string> }>,
  keep: (belief: CompiledBelief) => boolean = () => true,
): Promise<{ items: PackItem[]; evidenceOf: ReadonlyMap<string, string>; more: boolean }> {
  const section = sectionOf(template, "facts");
  if (!client.views.includes(section.view)) return { items: [], evidenceOf: new Map(), more: false };
  const found = await compile();
  const items = found.facts.beliefs.filter(keep).map(
    (belief): PackItem => ({
      id: belief.fact,
      section: "facts",
      required: section.required,
      provenance: belief.provenance,
      asOf: belief.confirmedAt,
      kind: "belief",
      belief,
    }),
  );
  return { items, evidenceOf: found.evidenceOf, more: found.facts.more };
}

// A recent_messages section: each message an item, its evidence id added to `evidenceOf`.
function messageItems(
  ctx: Ctx,
  messages: SummaryRow[],
  required: boolean,
  evidenceOf: Map<string, string>,
): PackItem[] {
  return messages.map((one): PackItem => {
    evidenceOf.set(one.id, one.evidence_id);
    const message = summaryOf(ctx, one, factsOf(ctx, one));
    return {
      id: message.id as MessageId,
      section: "recent_messages",
      required,
      provenance: "source",
      asOf: message.at,
      kind: "message",
      message,
    };
  });
}

// The tools the client's guide may name, as the agent API offers them: a tool it holds whose view it
// holds too.
const guidedTools = (client: ClientView): string[] =>
  client.tools.filter((name) => {
    const read = PersonalReadTool.safeParse(name);
    if (read.success) return client.views.includes(TOOL_VIEW[read.data]);
    return !PersonalWorkTool.safeParse(name).success || client.views.includes(WORK_TOOL_VIEW);
  });

// Whether a template's section is one the client will be served.
const serves = (client: ClientView, template: PackTemplate, name: PackSection): boolean =>
  template.sections.some((one) => one.name === name && client.views.includes(one.view));

// A row whose label is outside the clearance reached this process through a row policy written
// wrongly: the second barrier of invariant 7, and the call answers unavailable before any key is tried.
function inClearance(client: ClientView, row: { compartments: readonly string[] }): void {
  if (!row.compartments.every((compartment) => client.compartments.includes(compartment))) throw new Unavailable();
}

// The audience's beliefs, read once for a pack that serves both its commitments and its facts; each
// reads its own otherwise.
const sharedRead = async (ctx: Ctx, client: ClientView, template: PackTemplate): Promise<AudienceRead> =>
  serves(client, template, "commitments") && serves(client, template, "facts") ? await audienceBeliefs(ctx) : "fresh";

// What agent_bootstrap tells the agent of itself: the guide, code's own text and never a stored row,
// first after the standing; its standing; and its own record, when it holds anything.
const agentOwnItems = (
  client: ClientView,
  asOf: string,
  standing: Awaited<ReturnType<typeof ownStandingOf>> | null,
  own: Awaited<ReturnType<typeof ownRecordOf>> | null,
): Pick<Built["sections"], "guide" | "standing" | "record"> => ({
  guide: [
    {
      id: AGENT_GUIDE_VERSION,
      section: "guide",
      required: true,
      asOf,
      kind: "guide",
      text: agentGuideFor(guidedTools(client)),
    },
  ],
  standing:
    standing === null
      ? []
      : [
          {
            id: "standing",
            section: "standing",
            required: false,
            provenance: "source",
            asOf,
            kind: "standing",
            standing,
            say: AGENT_STANDING_SAY,
          },
        ],
  record:
    own === null || agentRecordEmpty(own)
      ? []
      : [
          {
            id: "record",
            section: "record",
            required: false,
            provenance: "source",
            asOf,
            kind: "own_record",
            record: own,
            say: AGENT_RECORD_SAY,
          },
        ],
});

// The caller's moves cleared and never reported, of the stages a report closes.
const unreportedItems = (unreported: Awaited<ReturnType<typeof unreportedOf>>, asOf: string): PackItem[] =>
  unreported.flatMap((one) =>
    one.stage === "investigate" || one.stage === "prepare"
      ? [
          {
            id: one.move,
            section: "unreported" as const,
            required: false,
            provenance: "source" as const,
            asOf,
            kind: "unreported_move" as const,
            opportunity: one.opportunity,
            stage: one.stage,
            say: one.say,
          },
        ]
      : [],
  );

async function agentBootstrap(ctx: Ctx, client: ClientView, template: PackTemplate, now: Date): Promise<Built> {
  const asOf = stamp(now);
  const self = await selfOf(ctx, now, { tiers: client.views.includes("people") });
  const owner = sectionOf(template, "owner");
  const upcoming = sectionOf(template, "upcoming");
  const contacts = sectionOf(template, "contacts");
  const handoff = sectionOf(template, "handoff");
  const notes = sectionOf(template, "notes");
  const [latest] = await ctx.run<RecordRow>(HANDOFF, [client.name]);
  // The work the caller holds, each with its latest progress, and the latest handoff note of each
  // beside the caller's own latest.
  const mine = serves(client, template, "my_work")
    ? await heldWork(ctx, sectionOf(template, "my_work"), asOf)
    : undefined;
  const handed = mine === undefined || mine.ids.length === 0 ? [] : await ctx.run<RecordRow>(WORK_HANDOFFS, [mine.ids]);
  const handoffs = [
    ...(latest === undefined ? [] : [latest]),
    ...handed.filter((row) => row.id !== latest?.id).sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
  ].slice(0, handoff.cap);
  const noted = await ctx.run<RecordRow>(NOTES_LEFT_OUT, [notes.cap]);
  const records = (rows: RecordRow[], one: typeof notes): PackItem[] =>
    rows.flatMap((row) => {
      inClearance(client, row);
      return recordItem(ctx, row, one.name, one.required, one.cutChars) ?? [];
    });
  // The owner's open commitments, on either side, and the owner's open stated beliefs, from the
  // audience's beliefs read once for both.
  const read = await sharedRead(ctx, client, template);
  const commitments = await commitmentsSection(ctx, client, template, now, undefined, read);
  // The owner's open beliefs, compiled as get_self's `stated` was, in compileFacts' order (a
  // commitment is never in it: the commitments section serves those). The section shows beliefs
  // alone: no claim is read.
  const isOpen = (belief: CompiledBelief): boolean => OPEN_BELIEF_STATUS.has(belief.status);
  const facts = await factsSection(client, template, () => statedFactsOf(ctx, read), isOpen);
  // The client's own confirmed client-scoped preferences, each shown by its evidence id.
  const preferences = sectionOf(template, "preferences");
  const preferred = await ctx.run<PreferenceRow>(PREFERENCES, []);
  const preferenceEvidence = new Map(
    preferred.flatMap((row) => (row.evidence_id === null ? [] : [[row.record_id, row.evidence_id] as const])),
  );
  // get_self's `work`, for a client holding the work view; its capture items join this call's read log.
  const work = serves(client, template, "work")
    ? (await workViews(ctx, { view: "now" }, now, [], undefined, supportsOf(ctx))).now
    : undefined;
  // What the owner owes and what is overdue.
  const open = serves(client, template, "open_items")
    ? servedOpenItems(await openItemsOf(ctx, client.views, now, read), sectionOf(template, "open_items").cap)
    : undefined;
  // The caller's moves cleared and never reported.
  const unreported = serves(client, template, "unreported") ? await unreportedOf(ctx) : [];
  // The caller's standing over the last seven days, whatever it holds, and its own record.
  const standing = serves(client, template, "standing") ? await ownStandingOf(ctx, now) : null;
  const own = serves(client, template, "record") ? await ownRecordOf(ctx, now) : null;
  // The known issues of the tools and sources, for a client that may list the defects; one that may
  // not is not asked.
  const known =
    serves(client, template, "known_issues") && knownIssuesServed(client)
      ? await knownIssuesOf(ctx, client, sectionOf(template, "known_issues").cap, asOf)
      : [];
  // The learnings active for the caller's scope, for a client that may file one; one that may not is
  // not asked.
  const learnings =
    serves(client, template, "learnings") && learningsServed(client)
      ? await learningsOf(ctx, client, sectionOf(template, "learnings").cap, asOf)
      : [];
  const sections: Partial<Record<PackSection, PackItem[]>> = {
    ...agentOwnItems(client, asOf, standing, own),
    known_issues: known,
    learnings,
    owner: self.value.addresses.map((value, index) => ({
      id: `address:${index}`,
      section: "owner",
      required: owner.required,
      provenance: "source",
      asOf,
      kind: "address",
      value,
    })),
    handoff: records(handoffs, handoff),
    upcoming: self.value.upcoming.map((meeting) => meetingItem(meeting, "upcoming", upcoming.required, asOf)),
    commitments: commitments.items,
    facts: facts.items,
    preferences: preferred.flatMap((row) => {
      inClearance(client, row);
      return preferenceItem(ctx, row, preferences.required) ?? [];
    }),
    contacts: self.value.contacts.map((contact) => ({
      id: contact.id,
      section: "contacts",
      required: contacts.required,
      provenance: "source",
      asOf,
      kind: "contact",
      contact,
    })),
    notes: records(noted, notes),
    work:
      work === undefined
        ? []
        : [
            {
              id: "work",
              section: "work",
              required: sectionOf(template, "work").required,
              provenance: "source",
              asOf,
              kind: "work",
              work,
            },
          ],
    open_items: (open?.value.items ?? []).map((openItem) => ({
      id: openItem.source.id,
      section: "open_items" as const,
      required: false,
      provenance: "source" as const,
      asOf,
      kind: "open_item" as const,
      openItem,
    })),
    my_work: mine?.items ?? [],
    unreported: unreportedItems(unreported, asOf),
  };
  return {
    sections,
    evidenceOf: new Map([
      ...self.evidenceOf,
      ...commitments.evidenceOf,
      ...facts.evidenceOf,
      ...preferenceEvidence,
      ...(open?.evidenceOf ?? []),
    ]),
    cut: commitments.cut,
    ...(open === undefined ? {} : { factKeyOf: open.factKeyOf }),
    ...(mine === undefined ? {} : { shownOf: mine.shownOf, goalsOf: mine.goalsOf }),
  };
}

// What the four statements behind the attendees' briefs found, each by entity: the mail counts, the
// latest meeting before the pack's time that is not this event, the latest thread and the latest
// capture.
type AttendeeRows = {
  mail: ReadonlyMap<string, { entity_id: string; inbound: number; outbound: number; last_at: Date | null }>;
  last: ReadonlyMap<string, { entity_id: string; last_meeting_at: Date; id: string; evidence_id: string }>;
  threads: ReadonlyMap<string, LastThreadRow & { entity_id: string }>;
  captures: ReadonlyMap<string, LastCaptureRow>;
};

// The four statements, in that order; none at all for a meeting with no visible attendee.
async function attendeeRowsOf(ctx: Ctx, ids: string[], asOf: string, event: string): Promise<AttendeeRows> {
  const byEntity = async <R extends { entity_id: string }>(text: string, values: unknown[]): Promise<Map<string, R>> =>
    new Map((ids.length === 0 ? [] : await ctx.run<R>(text, values)).map((one) => [one.entity_id, one]));
  return {
    mail: await byEntity(MAIL, [ids]),
    last: await byEntity(LAST_MEETINGS, [ids, asOf, event]),
    threads: await byEntity(LAST_THREADS, [ids, asOf]),
    captures: await byEntity(LAST_CAPTURES, [ids, asOf]),
  };
}

// One attendee's brief, from what the four statements found of them.
function attendeeBrief(who: AttendeeBrief["who"], rows: AttendeeRows): AttendeeBrief {
  const counts = rows.mail.get(who.id);
  const met = rows.last.get(who.id);
  const thread = rows.threads.get(who.id);
  return {
    who,
    inbound: counts?.inbound ?? 0,
    outbound: counts?.outbound ?? 0,
    lastAt: stampOrNull(counts?.last_at ?? null),
    lastMeetingAt: stampOrNull(met?.last_meeting_at ?? null),
    lastMeeting: met === undefined ? null : { meeting: met.id as EventId, at: stamp(met.last_meeting_at) },
    lastThread: thread === undefined ? null : threadPointer(thread),
    lastCapture: capturePointer(rows.captures.get(who.id)) as AttendeeBrief["lastCapture"],
  };
}

async function meetingPrep(
  ctx: Ctx,
  client: ClientView,
  template: PackTemplate,
  event: string,
  now: Date,
): Promise<Built | null> {
  const asOf = stamp(now);
  const [row] = await ctx.run<MeetingRow>(EVENT, [event]);
  if (row === undefined) return null;
  const meeting = (await meetingsOf(ctx, [row])).get(row.id);
  if (meeting === undefined) return null;
  const attendees = sectionOf(template, "attendees");
  const recent = sectionOf(template, "recent_messages");
  const who = meeting.participants;
  const ids = who.map((one) => one.id);

  const rows = await attendeeRowsOf(ctx, ids, asOf, row.id);
  const briefs = who.map(
    (one): PackItem => ({
      id: one.id,
      section: "attendees",
      required: attendees.required,
      provenance: "source",
      asOf,
      kind: "attendee",
      attendee: attendeeBrief(one, rows),
    }),
  );

  const shownIds = ids.slice(0, attendees.cap);
  const messages =
    shownIds.length === 0
      ? []
      : await ctx.run<SummaryRow>(RECENT_MESSAGES, [shownIds, epochSeconds(now), PER_ATTENDEE, recent.cap]);
  // The open commitments whose other party is any visible participant, not only the 25 shown;
  // from version 4, what is believed of each attendee shown. The audience's beliefs are read once
  // for both.
  const read = await sharedRead(ctx, client, template);
  const commitments = await commitmentsSection(ctx, client, template, now, ids, read);
  const facts = await factsSection(client, template, () => attendeeFactsOf(ctx, who.slice(0, attendees.cap), read));
  // From version 6: the people each attendee shown reaches.
  const second = await secondDegreeSection(ctx, client, template, shownIds, ids, now);
  const evidenceOf = new Map<string, string>([
    [row.id, row.evidence_id],
    ...commitments.evidenceOf,
    ...facts.evidenceOf,
    ...[...rows.last.values(), ...rows.threads.values(), ...rows.captures.values()].map(
      (one) => [one.id, one.evidence_id] as const,
    ),
  ]);
  const summaries = messageItems(ctx, messages, recent.required, evidenceOf);
  return {
    sections: {
      event: [meetingItem(meeting, "event", sectionOf(template, "event").required, asOf)],
      attendees: briefs,
      notes: await prepNotes(ctx, client, template, who.slice(0, attendees.cap)),
      commitments: commitments.items,
      second_degree: second.items,
      facts: facts.items,
      recent_messages: summaries,
    },
    evidenceOf,
    // The audience's beliefs past their ceiling cut the attendees' facts as well as the
    // commitments.
    cut: commitments.cut || facts.more,
    factKeyOf: second.factKeyOf,
  };
}

// person_brief@1: the person as get_entity gives them, without the facts, which the facts section
// serves (every compiled belief but a commitment, closed ones included, in compileFacts' order);
// the open commitments between them and the owner; their latest messages. A hidden id, an absent
// one, an organization's and the owner's id answer null after one statement alike. The beliefs are compiled without the claims in none, so their
// `more` says only that beliefs were cut, and the pack is then truncated, as it is past the facts
// section's cap.
async function personBrief(
  ctx: Ctx,
  client: ClientView,
  template: PackTemplate,
  entity: string,
  now: Date,
): Promise<Built | null> {
  const asOf = stamp(now);
  const found = await entityOf(ctx, { id: entity as EntityId }, now, {
    brief: true,
    views: client.views,
    nextStep: true,
  });
  if (found === null) return null;
  const person = packEntity(found.value);
  const compiledFacts = found.value.facts;
  const recent = sectionOf(template, "recent_messages");
  // A contact group's every visible member, as get_entity and get_timeline read it.
  const members = [...found.members];
  const messages = await ctx.run<SummaryRow>(RECENT_MESSAGES, [members, epochSeconds(now), recent.cap, recent.cap]);
  const commitments = await commitmentsSection(ctx, client, template, now, members, "fresh");
  const facts = await factsSection(
    client,
    template,
    async () => ({ facts: compiledFacts, evidenceOf: found.evidenceOf }),
    (belief) => belief.kind !== "commitment",
  );
  // From version 3: the people the person reaches.
  const second = await secondDegreeSection(ctx, client, template, [person.id], members, now);
  const evidenceOf = new Map<string, string>([...found.evidenceOf, ...commitments.evidenceOf]);
  const summaries = messageItems(ctx, messages, recent.required, evidenceOf);
  return {
    sections: {
      person: [
        {
          id: person.id,
          section: "person",
          required: sectionOf(template, "person").required,
          provenance: "source",
          asOf,
          kind: "entity",
          entity: person,
        },
      ],
      facts: facts.items,
      commitments: commitments.items,
      second_degree: second.items,
      recent_messages: summaries,
    },
    evidenceOf,
    cut: commitments.cut || facts.more,
    factKeyOf: second.factKeyOf,
    leadBeliefs: Object.values(currentOf(compiledFacts.beliefs)),
  };
}

async function buildPack(ctx: Ctx, client: ClientView, args: BuildContextPackArgs, now: Date): Promise<PackOutcome> {
  if (!client.views.includes(PACK_VIEW[args.purpose])) return "not_permitted";
  const template = templateFor(args.purpose);
  const built: Built | "not_permitted" | null =
    args.purpose === "agent_bootstrap"
      ? await agentBootstrap(ctx, client, template, now)
      : args.purpose === "meeting_prep"
        ? await meetingPrep(ctx, client, template, args.event ?? "", now)
        : args.purpose === "person_brief"
          ? await personBrief(ctx, client, template, args.entity ?? "", now)
          : await projectBrief(ctx, client, sectionOf(template, "project"), args.project ?? "", now);
  if (built === null || built === "not_permitted") return built;
  // A section whose view the client lacks is left out, as an empty one is.
  const sections = Object.fromEntries(
    template.sections
      .filter((one) => client.views.includes(one.view))
      .map((one) => [one.name, built.sections[one.name] ?? []]),
  );
  const assembled = assemblePack(template, { asOf: stamp(now), sections, cut: built.cut });
  // What the registration leaves out, from the registration alone: never from what the owner has.
  // Outside the hash, which is the items'.
  const [gate] = await ctx.run<{ shown: boolean | null }>(GOALS_SHOWN, []);
  const withheld = [
    ...template.sections.filter((one) => !client.views.includes(one.view)).map((one) => one.name),
    ...(gate?.shown === true ? [] : ["goals" as const]),
  ];
  const pack = withheld.length === 0 ? assembled : { ...assembled, withheld };

  // What the pack shows by id, after the cut: meetings and messages by their evidence ids, agent
  // records by their own, each commitment's message by its evidence id with the commitment's fact
  // among the fact keys, each belief's fact with the message of each cite that has one, a person's
  // last and next meetings by their evidence ids, each preference by its record's evidence id, and
  // each commitment's and each belief cite's capture item by its evidence id. An item
  // cut from its section is in neither. A pack binds nothing.
  const evidence = (id: string | null): string[] => (id === null ? [] : [built.evidenceOf.get(id) ?? []].flat());
  const cited = (belief: CompiledBelief): string[] =>
    belief.cites.flatMap((cite) => ("message" in cite ? evidence(cite.message ?? cite.capture) : []));
  const leadBeliefs = built.leadBeliefs ?? [];
  const shownOfItems = pack.items.flatMap((item) =>
    item.kind === "record"
      ? [item.id]
      : item.kind === "meeting" || item.kind === "message"
        ? evidence(item.id)
        : item.kind === "commitment"
          ? evidence(item.commitment.message ?? item.commitment.capture)
          : item.kind === "belief"
            ? cited(item.belief)
            : item.kind === "entity"
              ? [
                  ...evidence(item.entity.lastMeeting?.id ?? null),
                  ...evidence(item.entity.nextMeeting?.id ?? null),
                  ...evidence(item.entity.lead?.lastThread?.message ?? null),
                ]
              : item.kind === "preference" || item.kind === "open_item"
                ? evidence(item.id)
                : item.kind === "attendee"
                  ? [
                      ...evidence(item.attendee.lastMeeting?.meeting ?? null),
                      ...evidence(item.attendee.lastThread?.message ?? null),
                      ...evidence(item.attendee.lastCapture?.capture ?? null),
                    ]
                  : item.kind === "held_work" || item.kind === "project"
                    ? (built.shownOf?.get(item.id) ?? [])
                    : item.kind === "address" ||
                        item.kind === "contact" ||
                        item.kind === "guide" ||
                        item.kind === "second_degree" ||
                        item.kind === "unreported_move" ||
                        item.kind === "own_record" ||
                        item.kind === "standing" ||
                        item.kind === "known_issue" ||
                        item.kind === "learning" ||
                        item.kind === "work"
                      ? []
                      : noItemKindLeft(item),
  );
  // Each second-degree line's cited claim by its fact key, as find_paths
  // logs a hop's, and the goal it names by id. No evidence was opened.
  const lines = pack.items.flatMap((item) => (item.kind === "second_degree" ? [item] : []));
  const factKeyFps = [
    ...new Set([
      ...pack.items.flatMap((item) =>
        item.kind === "commitment" || item.kind === "belief"
          ? [item.id]
          : item.kind === "open_item"
            ? [built.factKeyOf?.get(item.id) ?? []].flat()
            : [],
      ),
      ...lines.flatMap((item) => [built.factKeyOf?.get(item.id) ?? []].flat()),
      ...leadBeliefs.map((belief) => belief.fact),
      // A person's next step names a commitment the section may have cut.
      ...pack.items.flatMap((item) => (item.kind === "entity" ? (item.entity.lead?.nextStep?.fact ?? []) : [])),
    ]),
  ];
  const goals = [
    ...new Set([
      ...lines.flatMap((item) => (item.line.goal === undefined ? [] : [item.line.goal.id as string])),
      ...pack.items.flatMap((item) =>
        item.kind === "held_work" || item.kind === "project" ? (built.goalsOf?.get(item.id) ?? []) : [],
      ),
    ]),
  ].sort();
  const session = await ctx.session();
  await ctx.run(LOG_PACK, [
    session,
    pack.purpose,
    pack.template,
    SELECTOR_IN_ORDER,
    fingerprint(ctx.keys, "content_hash", pack.hash),
    pack.items.map((item) => item.id),
  ]);
  return {
    value: pack,
    rows: pack.items.length,
    read: {
      bound: [],
      shown: [...new Set([...shownOfItems, ...leadBeliefs.flatMap(cited)])],
      factKeyFps,
      ...(goals.length === 0 ? {} : { goals }),
    },
  };
}

// A pack item's kind no read set above names does not compile, so a new kind cannot log nothing.
function noItemKindLeft(item: never): string[] {
  throw new Error(`a pack item of no known kind: ${JSON.stringify(item)}`);
}

// A context pack: the purpose's view, the fixed
// queries, the assembly, the session and policy.log_pack, inside the call's one transaction.
export const BUILD_CONTEXT_PACK_TOOL: ReadTool<BuildContextPackArgs, ContextPack> = {
  tool: "build_context_pack",
  parse: (args) => parsed(BuildContextPackArgs.safeParse(args)),
  work: (ctx, valid, client, env) => buildPack(ctx, client, valid, env.now()),
};
