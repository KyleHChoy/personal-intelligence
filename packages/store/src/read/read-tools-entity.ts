// get_entity: the card of a person, a group, an organization or a project, an own contact's
// use-only details, and the person parts that `about` serves beside its beliefs.

import type {
  CompiledFacts,
  ConnectionView,
  ContactDetails,
  EntityId,
  EntityView,
  GetEntityArgs,
  KnownVia,
  MeetingView,
  NextStep,
  OwnerTieView,
  OwnerWordsView,
  PersonalView,
  PersonLinkView,
  WarmthLine,
  Who,
} from "@intelligence/contracts/personal";
import { dayIn, PERSON_SAME_NAME } from "@intelligence/contracts/personal";
import { isMintedKey } from "@intelligence/personal-core";
import {
  currentStanding,
  type Finding,
  reportsNaming,
  reportsOfPersonsMeeting,
  reportsOfProject,
  titleSaysMoving,
} from "@intelligence/personal-core/views";
import { dueOf } from "../core/commitment-rules.ts";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { ORGANIZATION_TYPES } from "../core/org-names.ts";
import {
  type ClientGroups,
  type Ctx,
  type Entity,
  type Found,
  mergeReads,
  type ReadSet,
  type Sealed,
  untrusted,
} from "../core/read-ctx.ts";
import { workViews } from "../core/work-time-read.ts";
import { ownerTimeZone } from "../core/zone.ts";
import { hisNames } from "../identity/person-name-rows.ts";
import { supportsOf } from "./computed-beliefs.ts";
import { chatRemarks, OWNER_ENTITY } from "./read-beliefs.ts";
import { compiledFactsOf, projectFactsOf } from "./read-compiled.ts";
import { namesTest, readsFindings, recentFindings } from "./read-findings.ts";
import { NAMED_ORG_CLAIMS, ORGANIZATION_CLAIM_SEEN } from "./read-fragments.ts";
import { groupContactNames, groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { linksOf, ownerWordsOf, type SealedWords } from "./read-links.ts";
import { mentionedByOf, namedBy, namedOrgState, namedSeen } from "./read-named.ts";
import { projectOpenItems } from "./read-open-items.ts";
import { organizationNames, orgNameList } from "./read-organizations.ts";
import { cardOf } from "./read-people.ts";
import {
  closeTieSawNothing,
  closeTieUnread,
  groupChatNewer,
  lastIsFromThem,
  lastThreadOf,
  meetingPointer,
  nextStepOf,
  type OpenWithThem,
  ownerStatedClose,
  personLead,
  statedClose,
  threadPointer,
} from "./read-person-lead.ts";
import { projectPage } from "./read-project-page.ts";
import { projectStandingOf } from "./read-project-status.ts";
import { normalized } from "./read-search.ts";
import { tiesFor } from "./read-ties.ts";
import { ENTITY_MAIL, ENTITY_OR_PROJECT, inRowOrder, type Mail, mailOf, PROJECT, type Printed } from "./read-tools.ts";
import { warmthOf } from "./read-warmth.ts";
import { MEETING_COLUMNS, type MeetingRow, meetingsOf, whoOf } from "./read-who.ts";

const ORGANIZATION_PEOPLE = 50;

// A person alone, for person_brief: an organization's id is as one that is not there, and so is
// the owner's. The same columns as ENTITY_OR_PROJECT.
const PERSON = `
  select e.id, e.kind from knowledge.entities e
  where e.id = $1 and e.kind = 'person'
  order by e.id`;

// The visible `own` contacts with an address row for a visible
// member, newest first, then by id, at most DETAIL_CONTACTS. A contact of an employer compartment
// is never served as details.
export const DETAIL_CONTACTS = 5;
const DETAILS = `
  select c.id, c.compartments, c.facts_enc as value_enc, c.evidence_id
  from knowledge.contacts c
  where c.compartments = array['own']::text[]
    and exists (select 1 from knowledge.contact_addresses a where a.contact_id = c.id and a.entity_id = any($1))
  order by c.updated_at desc, c.id
  limit ${DETAIL_CONTACTS}`;

type SealedContact = {
  names?: string[];
  phones?: { value: string; type: string | null }[];
  organizations?: { name: string | null; title: string | null }[];
  birthday?: { month: number; day: number } | null;
};

// Each contact opened under the caller's keys, every value wrapped as untrusted, and the evidence
// of each, which the read log records as shown. And the same contacts' links, whose evidence is
// bound, and the owner's words about the person.
type Details = {
  details: ContactDetails[];
  links: PersonLinkView[];
  ownerWords: OwnerWordsView[];
  shown: string[];
  bound: string[];
};
// A saved contact's details reach a client, since the owner allowed it and the outbound gate checks a
// draft for contact fields. Only an `own` contact's, each marked
// use-only.
async function detailsOf(ctx: Ctx, members: readonly string[]): Promise<Details> {
  const rows = await ctx.run<Sealed & { evidence_id: string }>(DETAILS, [members]);
  const wrap = (value: string | null | undefined) =>
    value === null || value === undefined ? null : { untrusted: value };
  const opened = rows.map(
    (row) =>
      JSON.parse(untrusted(ctx, "knowledge.contacts", "facts_enc", row).untrusted) as SealedContact & SealedWords,
  );
  const links = await linksOf(
    ctx,
    rows.map((row) => row.evidence_id),
    members,
  );
  const details = opened.map((facts) => ({
    disclosure: "use_only" as const,
    names: (facts.names ?? []).map((name) => ({ untrusted: name })),
    phones: (facts.phones ?? []).map((phone) => ({ value: { untrusted: phone.value }, type: wrap(phone.type) })),
    organizations: (facts.organizations ?? []).map((one) => ({ name: wrap(one.name), title: wrap(one.title) })),
    birthday: facts.birthday ?? null,
  }));
  // The owner's words bind each contact that holds some, as a link binds its claim's, so an erasure
  // of the person reaches what was written after reading them.
  const ownerWords = ownerWordsOf(opened);
  const worded =
    ownerWords.length === 0
      ? []
      : rows
          .filter((_, i) => (opened[i]?.imported?.tags?.length ?? 0) + (opened[i]?.imported?.notes?.length ?? 0) > 0)
          .map((row) => row.evidence_id);
  return {
    details,
    links: links.links,
    ownerWords,
    shown: rows.map((row) => row.evidence_id),
    bound: [...new Set([...links.bound, ...worded])],
  };
}

// `facts` is optional in the contract; entityOf still serves it.
type FactsEntity = EntityView & { facts: CompiledFacts };

// Every alias, and the owner's live names for the person by an account of theirs (`his`), the
// owner's first.
const NAMES = `
  select t.id, t.compartments, t.value_enc, t.his from (
    select s.id, s.compartments, s.value_enc, false as his
    from knowledge.aliases s
    where s.entity_id = any($1)
    union all
    select distinct x.id, x.compartments, x.value_enc, true
    from (${hisNames("e.id = any($1)")}) x
  ) t
  order by t.his desc, t.id`;

const ADDRESSES = `
  select a.id, a.value_fp, a.compartments, a.value_enc
  from knowledge.accounts a
  where a.entity_id = any($1)
  order by a.id`;

// Other people the caller sees who hold one of these whole names, under its fingerprint.
const OTHERS_OF_NAME = `
  select distinct s.entity_id
  from knowledge.aliases s
  join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
  where s.value_fp = any($1::text[]) and not (s.entity_id = any($2::text[]))
  order by s.entity_id
  limit $3`;

// A name is also shown from two places with no alias and no fingerprint the reader may read: the owner's live names, and
// a contact of two addresses, which names the group its addresses are joined in. Each is opened and compared in code,
// as `search` finds them, and only for a card that asks.
const OWNER_NAMES = `
  select n.id, n.compartments, n.name_enc as value_enc
  from knowledge.person_names n
  where n.lifted_at is null
  order by n.id`;
const OWNER_NAMED = `
  select distinct x.entity_id
  from (${hisNames("e.kind = 'person' and not (e.id = any($1::text[]))", " and n.id = any($2::text[])")}) x
  order by x.entity_id`;

async function othersOfName(
  ctx: Ctx,
  groups: ClientGroups,
  id: string,
  names: readonly string[],
  members: readonly string[],
): Promise<Who[]> {
  const whole = names.map((name) => name.trim()).filter((name) => /\s/.test(name));
  if (whole.length === 0) return [];
  const rows = await ctx.run<{ entity_id: string }>(OTHERS_OF_NAME, [
    whole.map((name) => fingerprint(ctx.keys, "name", name)),
    [...members],
    PERSON_SAME_NAME * 2,
  ]);
  const asked = new Set(whole.map(normalized));
  const ownNames = (await ctx.run<Sealed>(OWNER_NAMES, [])).filter((row) =>
    asked.has(normalized(untrusted(ctx, "knowledge.person_names", "name_enc", row).untrusted)),
  );
  const ownerNamed =
    ownNames.length === 0
      ? []
      : await ctx.run<{ entity_id: string }>(OWNER_NAMED, [[...members], ownNames.map((row) => row.id)]);
  const joined = [...new Set(groups.joined.map(([, group]) => group))].filter((group) => group !== id);
  const namesOfJoined = await groupContactNames(
    ctx,
    joined.map((group) => groups.membersOf(group)),
  );
  const contactNamed = joined.filter((_, index) =>
    namesOfJoined[index]?.some((one) => asked.has(normalized(one.name))),
  );
  const ids = [
    ...new Set([...[...rows, ...ownerNamed].map((row) => groups.idOf(row.entity_id)), ...contactNamed]),
  ].filter((other) => other !== id);
  const who = await groupWho(ctx, groups, ids);
  // Never someone known by a name alone: such a person holds no chat, and is withheld where no claim the
  // caller sees names them.
  return ids
    .flatMap((other) => who.get(other) ?? [])
    .filter((one) => one.nameOnly !== true)
    .slice(0, PERSON_SAME_NAME);
}

const DOMAINS = `
  select d.id, d.domain_fp as value_fp, d.compartments, d.domain_enc as value_enc
  from knowledge.domains d
  where d.entity_id = $1
  order by d.id`;

// The organizations with a domain that one of the person's accounts is on, lowest id first.
const ORGANIZATIONS_OF = `
  select d.entity_id, d.id
  from knowledge.domains d
  where d.domain_fp in (select a.domain_fp from knowledge.accounts a where a.entity_id = any($1))
  order by d.entity_id, d.id`;

// The people with an account on one of the organization's domains, by id. Each found in full
// first, and each entity read by its id; then the first by id. A cut in the same select as the
// accounts would let the planner walk every account in id order.
const PEOPLE_OF = `
  with people as materialized (
    select distinct a.entity_id
    from knowledge.accounts a
    where a.domain_fp in (select d.domain_fp from knowledge.domains d where d.entity_id = $1)
      and (select e.kind from knowledge.entities e where e.id = a.entity_id) = 'person'
  )
  select people.entity_id from people
  order by people.entity_id
  limit $2`;

// The people a named organization's claims the caller sees are
// about, by id, as PEOPLE_OF bounds them.
const NAMED_ORG_PEOPLE = `
  with people as materialized (
    select distinct p.entity_id
    from ${NAMED_ORG_CLAIMS}
    join knowledge.claim_entities p on p.claim_id = c.id
    where o.entity_id = any($1::text[]) and ${ORGANIZATION_CLAIM_SEEN}
      and (select e.kind from knowledge.entities e where e.id = p.entity_id) = 'person'
  )
  select people.entity_id from people
  order by people.entity_id
  limit $3`;

// The latest meeting that started before now, and the earliest that starts at or after it.
// Cancelled meetings, and those with no start, are neither; a past invite the owner declined or left
// unanswered is no last meeting, though an upcoming one may still be the next. A meeting of two members of a group
// is one row: the participants are a condition, not a join. The entity's meetings are found in
// full first, from its participant rows, and the two are picked from them: a cut beside the
// details would let the planner walk every meeting in time order.
const MEETINGS_AROUND = `
  with around as materialized (
    select ${MEETING_COLUMNS}
    from knowledge.events v
    join knowledge.event_details d on d.event_id = v.id
    where v.id in (select p.event_id from knowledge.event_participants p where p.entity_id = any($1)) and not d.cancelled
  )
  select t.* from (
    (select 'last' as slot, around.* from around
     where around.starts_at < $2 and coalesce(around.owner_response, 'accepted') in ('accepted', 'tentative')
     order by around.starts_at desc, around.id
     limit 1)
    union all
    (select 'next' as slot, around.* from around
     where around.starts_at >= $2
     order by around.starts_at, around.id
     limit 1)
  ) t
  order by t.slot, t.id`;

// What get_commitments({ with }) lists of `commitments`: the owner on one side
// and the person on the other, less a courtesy that lapsed. No reader's withholding is asked: a person
// the caller is served is not withheld. Past the scan of a person's beliefs it counts what was read.
async function openWithThem(
  ctx: Ctx,
  commitments: Awaited<ReturnType<typeof compiledFactsOf>>["commitments"],
  lapsed: ReadonlyMap<string, string>,
  members: readonly string[],
  remarksToo: boolean,
): Promise<OpenWithThem[]> {
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const withThem = commitments.flatMap(({ row, belief }) => {
    const other = typeof belief.values.counterparty === "string" ? belief.values.counterparty : null;
    const between =
      (members.includes(belief.subject) && other === owner?.id) ||
      (belief.subject === owner?.id && other !== null && members.includes(other));
    if (!between) return [];
    return [
      {
        row,
        belief,
        direction: belief.subject === owner?.id ? ("owed_by_owner" as const) : ("owed_to_owner" as const),
        due: dueOf(belief.values),
      },
    ];
  });
  const open = withThem.filter((one) => !lapsed.has(one.row.id));
  const remarks = remarksToo
    ? await chatRemarks(
        ctx,
        open.filter((one) => one.due === null && one.direction === "owed_to_owner"),
      )
    : new Set<string>();
  return open.map((one) => ({
    fact: one.row.fact_key_fp,
    direction: one.direction,
    due: one.due,
    ...(remarks.has(one.row.id) ? { remark: true } : {}),
  }));
}

// A meeting's step, with a finding that says its day changed in its own field.
async function stepWithReport(
  ctx: Ctx,
  findings: readonly Finding[],
  named: (sentence: string) => boolean,
  given: NextStep | undefined,
  title: string | undefined,
): Promise<NextStep | undefined> {
  if (given?.kind !== "meeting") return given;
  const step = titleSaysMoving(title) ? { ...given, moving: true as const } : given;
  if (step.at === undefined || findings.length === 0) return step;
  const reported = reportsOfPersonsMeeting(findings, dayIn(new Date(step.at), await ownerTimeZone(ctx)), named);
  return reported.length === 0 ? step : { ...step, reported };
}

// `card` (get_entity alone): the cap, current standing, tie strength and knownVia.
type EntityOptions =
  | { brief: true; views: readonly PersonalView[]; nextStep?: boolean }
  | { brief: false; views: readonly PersonalView[]; card?: boolean; tools?: readonly string[] };

// get_entity's value, and the evidence id of each meeting and cited or listed message by its id,
// which a pack logs for those it shows. `brief` (person_brief) finds a person alone and
// compiles their beliefs without the claims in none, which a brief does not show, so its facts'
// `more` says only that beliefs were cut.
export async function entityOf(
  ctx: Ctx,
  args: GetEntityArgs,
  now: Date,
  options: EntityOptions,
): Promise<EntityRead | null> {
  const [entity] = await ctx.run<Entity>(options.brief ? PERSON : ENTITY_OR_PROJECT, [args.id]);
  if (entity === undefined) return null;
  // A project, only to a client with the work view; to any other it is not_found after the one
  // statement a hidden project sends too, before any group is read.
  if (entity.kind === "project") {
    if (options.brief || !options.views.includes("work")) return null;
    return projectEntity(ctx, entity.id as EntityId, now, options.card === true, options);
  }
  const groups = await loadGroups(ctx);
  if (entity.kind === "organization")
    return organizationEntity(ctx, entity, now, !options.brief && options.card === true);
  return personEntity(ctx, entity, groups, now, options);
}

type EntityRead = Found<FactsEntity> & { evidenceOf: ReadonlyMap<string, string>; members: readonly string[] };

// The compiled facts' read set, with every other part a card served merged in.
const withCompiled = <R extends ReadSet>(read: R, ...parts: readonly (Partial<ReadSet> | undefined)[]): R => ({
  ...read,
  ...mergeReads(read, ...parts),
});

async function projectEntity(
  ctx: Ctx,
  id: EntityId,
  now: Date,
  card: boolean,
  options: { views: readonly PersonalView[]; tools?: readonly string[] },
): Promise<EntityRead | null> {
  const [row] = await ctx.run<Sealed & { status: NonNullable<EntityView["status"]>; name_enc: unknown }>(PROJECT, [id]);
  if (row === undefined) return null;
  const name = untrusted(ctx, "knowledge.projects", "name_enc", { ...row, value_enc: row.name_enc });
  const compiled = await projectFactsOf(ctx, { id, kind: "project", name, address: null }, options.views);
  // A project's time on its card, an active project's alone.
  const time =
    card && row.status === "active"
      ? (await workViews(ctx, { view: "project", project: id, days: 30 }, now, [], undefined, supportsOf(ctx))).project
          ?.time
      : undefined;
  // The project's lines of what the owner owes, on get_entity's card alone.
  const open = card ? await projectOpenItems(ctx, id, now) : undefined;
  const page = card ? await projectPage(ctx, id) : undefined;
  // Where it stands, by the owner's word, a source's and an agent's, in that order.
  const standing = await projectStandingOf(ctx, id);
  // What agents wrote of it, beside its record, as a person's: read at each card, moving nothing.
  const reported =
    card && readsFindings(options.views, options.tools ?? [])
      ? reportsOfProject(await recentFindings(ctx, now), id, name.untrusted, namesTest([name.untrusted], []))
      : [];
  return {
    value: {
      ...(open === undefined || open.value.items.length === 0 ? {} : { openItems: open.value }),
      ...(reported.length === 0 ? {} : { reported }),
      id,
      kind: "project",
      names: [name],
      addresses: [],
      organization: null,
      people: page?.people ?? [],
      mail: page?.mail ?? mailOf(undefined),
      lastMeeting: null,
      nextMeeting: null,
      details: [],
      shared: false,
      facts: compiled.facts,
      status: row.status,
      ...(standing === null ? {} : { projectStatus: standing.standing }),
      ...(time === undefined ? {} : { time }),
    },
    rows: 1,
    read: withCompiled(
      compiled.read,
      open?.read,
      { shown: reported.map((one) => one.record as string) },
      standing === null ? undefined : { shown: standing.shown, bound: standing.bound },
    ),
    evidenceOf: compiled.evidenceOf,
    members: [id],
  };
}

async function organizationEntity(ctx: Ctx, entity: Entity, now: Date, card: boolean): Promise<EntityRead | null> {
  const id = entity.id as EntityId;
  // A named organization no claim or goal the caller sees names is withheld, as a hidden one; one
  // shown is served nameOnly, by its name rows, with the people whose claims the caller sees name it.
  const byName = await namedOrgState(ctx, id);
  if (byName.withheld) return null;
  const domains = await ctx.run<Printed>(DOMAINS, [id]);
  const named = await organizationNames(ctx, id, [...new Set(domains.map((row) => row.value_fp))], {
    contacts: true,
  });
  if (byName.nameOnly) {
    const rows = await orgNameList(ctx, id);
    named.names = [...new Map([...named.names, ...rows.names].map((name) => [name.untrusted, name])).values()];
    named.shown = [...new Set([...named.shown, ...rows.shown])];
  }
  const people = byName.nameOnly
    ? await ctx.run<{ entity_id: string }>(NAMED_ORG_PEOPLE, [[id], ORGANIZATION_TYPES, ORGANIZATION_PEOPLE])
    : await ctx.run<{ entity_id: string }>(PEOPLE_OF, [id, ORGANIZATION_PEOPLE]);
  const who = await whoOf(
    ctx,
    people.map((one) => one.entity_id),
  );
  const compiled = await compiledFactsOf(ctx, entity, [entity.id], { claims: true, card, now });
  const served = mergeReads(compiled.read, named);
  return {
    value: {
      id,
      kind: "organization",
      ...(byName.nameOnly ? { nameOnly: true as const } : {}),
      names: named.names,
      addresses: inRowOrder(ctx, "knowledge.domains", "domain_enc", domains),
      organization: null,
      people: people.flatMap((one) => who.get(one.entity_id) ?? []),
      mail: mailOf(undefined),
      lastMeeting: null,
      nextMeeting: null,
      // An own contact's organization, use-only.
      details: named.details,
      shared: false,
      facts: compiled.facts,
    },
    rows: 1,
    // The claims and contacts its names were served from.
    read: { ...compiled.read, shown: served.shown, factKeyFps: served.factKeyFps },
    evidenceOf: compiled.evidenceOf,
    members: [entity.id],
  };
}

// Every name of a person: the owner's live names for them by an account of theirs first, then their
// aliases and their group's contact names in text order, each once.
async function personNamesOf(ctx: Ctx, members: readonly string[]): Promise<string[]> {
  const rows = await ctx.run<Sealed & { his: boolean }>(NAMES, [members]);
  const his = rows
    .filter((row) => row.his)
    .map((row) => untrusted(ctx, "knowledge.person_names", "name_enc", row).untrusted);
  const aliases = rows
    .filter((row) => !row.his)
    .map((row) => untrusted(ctx, "knowledge.aliases", "value_enc", row).untrusted);
  return [
    ...new Set([
      ...his,
      ...[...aliases, ...((await groupContactNames(ctx, [members]))[0] ?? []).map((one) => one.name)].sort(byText),
    ]),
  ];
}

// What a person's lead is read from, beside the parts of the card read before it.
type LeadParts = Readonly<{
  groups: ClientGroups;
  id: EntityId;
  members: readonly string[];
  names: readonly string[];
  addresses: readonly string[];
  card: boolean;
  options: EntityOptions;
  compiled: Awaited<ReturnType<typeof compiledFactsOf>>;
  people: Awaited<ReturnType<typeof cardOf>> | undefined;
  ties: Awaited<ReturnType<typeof tiesFor>>;
  meeting: Awaited<ReturnType<typeof mailAndMeetings>>["meeting"];
  now: Date;
}>;

// What a person's page leads with, and the last thread and agents' reports it was read from.
async function leadOf(ctx: Ctx, parts: LeadParts) {
  const { groups, id, members, card, options, compiled, ties, meeting, now } = parts;
  const lastThread = await lastThreadOf(ctx, members, now);
  // What agents reported of a person, beside the fields, on a card alone: a meeting's attendees and a
  // brief's person would each be one more read of the newest findings.
  const findings =
    !options.brief && card && readsFindings(options.views, options.tools ?? []) ? await recentFindings(ctx, now) : [];
  const namesThem = namesTest(parts.names, parts.addresses);
  const reported = reportsNaming(findings, namesThem);
  // What get_commitments reads as lapsed, the card's lines already read as lapsed, from the one read
  // of it.
  const work = options.views.includes("work");
  const withThem = await openWithThem(ctx, compiled.commitments, compiled.lapsed, members, work);
  // The tier a card has read; a brief's alone. The count only for a client that holds the Work view,
  // which get_commitments needs: a function of the registration, whatever the owner has.
  const warmth = parts.people === undefined ? (await warmthOf(ctx, groups, [id])).get(id) : parts.people.warmth;
  const open = work ? withThem : null;
  const pointer = lastThread === undefined ? null : threadPointer(lastThread);
  const lastTwoWayChat = warmth?.channels?.includes("chat") === true;
  const closeness = ties.toOwner?.closeness;
  const steps = card || (options.brief && options.nextStep === true);
  // A close tie's line is asked whether it is out of date, once, so no contact can be told from a line that
  // has not caught up. A person with no line at all has had nothing to catch up with, if this says so.
  const reading =
    steps && statedClose(warmth, closeness) && warmth?.rebuilding !== true && warmth?.stale !== true
      ? { ...warmth, chatNewer: await groupChatNewer(ctx, members) }
      : warmth;
  // The owner stated them close and the line saw nothing: the contact may sit on another record of this name.
  const sameName =
    card && closeTieSawNothing(reading, closeness) ? await othersOfName(ctx, groups, id, parts.names, members) : [];
  const built = personLead({
    tier: warmth?.tier ?? null,
    tie: ties.toOwner?.relation ?? null,
    openCommitments: open?.length ?? null,
    lastThread: pointer,
    lastMeeting: meeting("last"),
    current: compiled.current ?? currentStanding(compiled.facts.beliefs),
    lastTwoWay:
      warmth?.lastTwoWayAt === undefined || warmth.lastTwoWayAt === null
        ? undefined
        : { at: warmth.lastTwoWayAt, chat: lastTwoWayChat },
    // A card's and a person's brief; an attendee's lead stays the pointers, one read per attendee less.
    nextStep: steps
      ? await stepWithReport(
          ctx,
          findings,
          namesThem,
          nextStepOf({
            commitments: open ?? [],
            nextMeeting: meetingPointer(meeting("next")),
            lastThread: pointer,
            lastFromThem: lastThread !== undefined && (await lastIsFromThem(ctx, lastThread.id, members)),
            lastMeeting: meetingPointer(meeting("last")),
            lastTwoWayAt: warmth?.lastTwoWayAt ?? null,
            lastTwoWayChat,
            closeTie: ownerStatedClose(reading, closeness),
            unread: closeTieUnread(reading, closeness),
            now,
          }),
          meeting("next")?.title?.untrusted,
        )
      : undefined,
    reported,
  });
  return { lead: sameName.length === 0 ? built : { ...built, sameName }, lastThread, reported };
}

async function personEntity(
  ctx: Ctx,
  entity: Entity,
  groups: ClientGroups,
  now: Date,
  options: EntityOptions,
): Promise<EntityRead | null> {
  // Any member's id answers for its group, named by its lowest visible member's id.
  const members = groups.membersOf(entity.id);
  const id = groups.idOf(entity.id) as EntityId;
  const names = await personNamesOf(ctx, members);
  const addresses = await ctx.run<Printed>(ADDRESSES, [members]);
  const opened = inRowOrder(ctx, "knowledge.accounts", "value_enc", addresses);
  // A named person, every account a named key, is served only where a relation claim or a goal the
  // caller sees names them, and then with the claims naming them.
  const texts = opened.map((one) => one.untrusted);
  const named = namedBy(texts);
  if (named && (await namedSeen(ctx, members)).size === 0) return null;
  const mentions = named ? await mentionedByOf(ctx, groups, members) : undefined;
  // A person's organization is its lowest; a group's, the one organization when every member that
  // maps to one maps to the same, and none otherwise. It is where an address is, never a role: the
  // lead does not take it.
  const organizations = [
    ...new Set((await ctx.run<{ entity_id: string }>(ORGANIZATIONS_OF, [members])).map((row) => row.entity_id)),
  ];
  const [organization] = members.length === 1 || organizations.length === 1 ? organizations : [];
  const mailDomain = organization === undefined ? undefined : (await whoOf(ctx, [organization])).get(organization);
  const { mail, around, meetings, meeting } = await mailAndMeetings(ctx, groups, id, members, now);
  // A group's compiled facts are one list, each fact of the group once.
  const card = !options.brief && options.card === true;
  const compiled = await compiledFactsOf(ctx, entity, members, { claims: !options.brief, groups, card, now });
  const people = card ? await cardOf(ctx, groups, id, members, now) : undefined;
  const details = await detailsOf(ctx, members);
  const ties = await tiesFor(ctx, members);
  const parts = { groups, id, members, names, addresses: texts, card, options, compiled, people, ties, meeting, now };
  const { lead, lastThread, reported } = await leadOf(ctx, parts);

  return {
    value: {
      id,
      kind: "person",
      lead,
      names: names.map((name) => ({ untrusted: name })),
      // A confirmed proposal's key is no address.
      addresses: opened.filter((one) => !isMintedKey(one.untrusted)),
      ...(mentions === undefined ? {} : { nameOnly: true as const, mentionedBy: mentions.mentionedBy }),
      organization: mailDomain ?? null,
      people: [],
      mail,
      lastMeeting: meeting("last"),
      nextMeeting: meeting("next"),
      details: details.details,
      shared: groups.shared(entity.id),
      facts: compiled.facts,
      ...(people === undefined
        ? {}
        : {
            current: compiled.current ?? {},
            ...(people.warmth === undefined ? {} : { warmth: people.warmth }),
            knownVia: people.knownVia,
          }),
      ...(details.links.length === 0 ? {} : { links: details.links }),
      ...(details.ownerWords.length === 0 ? {} : { ownerWords: details.ownerWords }),
      ...(ties.toOwner === undefined ? {} : { toOwner: ties.toOwner }),
      ...(ties.connections.length === 0 ? {} : { connections: ties.connections }),
    },
    rows: 1,
    read: withCompiled(
      compiled.read,
      { factKeyFps: ties.factKeyFps },
      { factKeyFps: mentions?.factKeyFps ?? [] },
      {
        factKeyFps: lead?.nextStep?.fact === undefined ? [] : [lead.nextStep.fact],
        bound: details.bound,
        shown: [
          ...around.filter((row) => meetings.has(row.id)).map((row) => row.evidence_id),
          ...(people?.shown ?? []),
          ...details.shown,
          ...(lastThread === undefined ? [] : [lastThread.evidence_id]),
          ...reported.map((one) => one.record as string),
          ...(lead?.nextStep?.reported ?? []).map((one) => one.record as string),
        ],
      },
    ),
    evidenceOf: new Map([
      ...compiled.evidenceOf,
      ...around.map((row) => [row.id, row.evidence_id] as const),
      ...(lastThread === undefined ? [] : [[lastThread.id, lastThread.evidence_id] as const]),
    ]),
    // The visible members a group is read by, for a pack that reads more of the person.
    members,
  };
}

// A person's mail with the owner and the meetings around `at`, by the one statement of each, in
// this order: what get_entity and `about` both lead with.
async function mailAndMeetings(ctx: Ctx, groups: ClientGroups, id: string, members: readonly string[], at: Date) {
  const [row] = await ctx.run<Mail>(ENTITY_MAIL, [members, members.map(() => id)]);
  const around = await ctx.run<MeetingRow & { slot: "last" | "next" }>(MEETINGS_AROUND, [members, at.toISOString()]);
  const meetings = await meetingsOf(ctx, around, groups);
  const meeting = (slot: "last" | "next") => meetings.get(around.find((one) => one.slot === slot)?.id ?? "") ?? null;
  const mail = mailOf(row);
  return { mail, around, meetings, meeting };
}

// The parts of a person `about` serves beside its beliefs, read by the statements entityOf sends
// for them, as of `at`: the mail, the last meeting before it and the next at or after it, the
// warmth line and how the owner knows them (cardOf), the confirmed tie and connections (tiesFor),
// and the links of the owner's own contacts (linksOf, as detailsOf reads them). Every part is a row
// the caller's token returns; the read set is what they serve.
type PersonHead = {
  mail: EntityView["mail"];
  lastMeeting: MeetingView | null;
  nextMeeting: MeetingView | null;
  warmth: WarmthLine | null;
  knownVia: KnownVia;
  toOwner: OwnerTieView | null;
  connections: ConnectionView[];
  links: PersonLinkView[];
  read: ReadSet;
};

export async function personHead(
  ctx: Ctx,
  groups: ClientGroups,
  id: string,
  members: readonly string[],
  at: Date,
): Promise<PersonHead> {
  const { mail, around, meetings, meeting } = await mailAndMeetings(ctx, groups, id, members, at);
  const people = await cardOf(ctx, groups, id, members, at);
  const contacts = await ctx.run<Sealed & { evidence_id: string }>(DETAILS, [members]);
  const links = await linksOf(
    ctx,
    contacts.map((row) => row.evidence_id),
    members,
  );
  const ties = await tiesFor(ctx, members);
  return {
    mail,
    lastMeeting: meeting("last"),
    nextMeeting: meeting("next"),
    warmth: people.warmth ?? null,
    knownVia: people.knownVia,
    toOwner: ties.toOwner ?? null,
    connections: ties.connections,
    links: links.links,
    read: {
      bound: [...new Set(links.bound)],
      shown: [
        ...new Set([...around.filter((row) => meetings.has(row.id)).map((row) => row.evidence_id), ...people.shown]),
      ],
      factKeyFps: [...new Set(ties.factKeyFps)],
    },
  };
}
