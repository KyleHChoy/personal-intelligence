import { z } from "zod";
import { BeliefStatus } from "../belief.ts";
import { DateOnly, Timestamp } from "../ids.ts";
import { BeliefKind } from "../ontology.ts";
import { KNOWN_ISSUE_ITEM } from "./agent-mail.ts";
import { AGENT_RECORD_SAY, AGENT_STANDING_SAY, AgentRecord, AgentStanding } from "./agent-record.ts";
import { AgentRecordKind } from "./agent-records.ts";
import { CommitmentEnding } from "./commitment-close.ts";
import { PathTie } from "./evidence-reads.ts";
import {
  AffiliationRelation,
  ConsentSubject,
  ContactChannel,
  ContactRuleKind,
  IntroOffer,
  PreferencePolarity,
  ProjectStatus,
  RelationshipRelation,
} from "./fact-vocabulary.ts";
import {
  AgentRecordId,
  CaptureId,
  ClientName,
  EntityId,
  EventId,
  GoalId,
  Handle,
  MessageId,
  MoveId,
  OpportunityId,
  RulingId,
} from "./ids.ts";
import { BeliefTier, LifeDomain, SELF_SECTION_LINES, SELF_SECTION_PEOPLE, SectionDomain } from "./knowledge-model.ts";
import { LEARNING_ITEM } from "./learnings.ts";
import { AGENT_REPORTS_SHOWN, AgentReport, OpenItem, ShownOpenItems } from "./open-items.ts";
import { ProjectTime, WorkNow } from "./packs-work-time.ts";
import { ConnectionView, OwnerTieView, PERSON_CONNECTIONS, TieRelation } from "./people-ties.ts";
import { Hex64 } from "./primitives.ts";
import { ProjectStanding } from "./projects.ts";
import { type PersonalView, SubjectKind } from "./subjects.ts";
import { FactId, FactType, PersonalContextPackPurpose, UntrustedString } from "./tools-args.ts";
import {
  CaptureFactView,
  ContactCount,
  ContactDetails,
  FactSource,
  FactView,
  MeetingView,
  MessageSummary,
  OwnerWordsView,
  PersonLinkView,
  Provenance,
  Who,
  WorkedOn,
} from "./tools-views.ts";
import { Tier, WarmthLine } from "./warmth.ts";
import { OpportunityView, PersonalWorkResults } from "./work.ts";
import { WorkHold } from "./work-progress.ts";

// Context packs, and the commitments get_commitments returns and a pack holds. In a file of their
// own, not the tools files: a pack and a belief carry a provenance, which agent-records.ts re-exports, and
// the tools files must import nothing that imports them back.

// The view each purpose needs besides the tool's own.
export const PACK_VIEW: Readonly<Record<PersonalContextPackPurpose, PersonalView>> = Object.freeze({
  agent_bootstrap: "self",
  meeting_prep: "people",
  person_brief: "people",
  project_brief: "work",
});

// `guide`, agent_bootstrap@7's first section, the agent guide. `work`, agent_bootstrap@8's, the
// owner's observed work. `second_degree`, from meeting_prep@6's and person_brief@3's, the people
// each attendee (or the person) reaches whom the owner has no tie with. `unreported`,
// agent_bootstrap@10's, the caller's moves cleared and never reported. `my_work`,
// agent_bootstrap@12's, the work the caller holds, parked work with it, each with its latest
// progress. `project`, project_brief@1's, one project as get_project answers it. `record`,
// agent_bootstrap@13's, the caller's own record. `known_issues`, agent_bootstrap@14's, the defects
// of the tools and sources the defect role is working on. `learnings`, agent_bootstrap@15's, what
// agents learned about working here. `standing`, agent_bootstrap@16's first, the caller's bets and
// questions over the last seven days.
export const PackSection = z.enum([
  "open_items",
  "owner",
  "handoff",
  "upcoming",
  "contacts",
  "notes",
  "event",
  "attendees",
  "recent_messages",
  "commitments",
  "preferences",
  "facts",
  "person",
  "guide",
  "work",
  "second_degree",
  "unreported",
  "my_work",
  "project",
  "record",
  "known_issues",
  "learnings",
  "standing",
]);
export type PackSection = z.infer<typeof PackSection>;

const count = z.number().int().nonnegative();
// Credential-shaped values masked in the text a result carries.
const masked = z.number().int().positive();

// `chars` is the whole body's length; `cut` says the body shown is shorter; a removed agent
// record has a null body and `chars` 0.
export const AgentRecordView = z
  .strictObject({
    id: AgentRecordId.or(Handle),
    kind: AgentRecordKind,
    client: ClientName,
    at: Timestamp,
    body: UntrustedString.nullable(),
    chars: count,
    cut: z.boolean(),
    removed: z.boolean(),
    masked: masked.optional(),
  })
  .refine((view) => !view.removed || (view.body === null && view.chars === 0 && !view.cut), {
    message: "a removed record has no body",
  });
export type AgentRecordView = z.infer<typeof AgentRecordView>;

// Where the last message or meeting with a person is: ids a read takes (read_item walks a message's
// thread) and a time, never words about what was said.
export const ThreadPointer = z.strictObject({ message: MessageId.or(Handle), at: Timestamp });
export type ThreadPointer = z.infer<typeof ThreadPointer>;
export const MeetingPointer = z.strictObject({ meeting: EventId.or(Handle), at: Timestamp });
export type MeetingPointer = z.infer<typeof MeetingPointer>;
const CapturePointer = z.strictObject({ capture: CaptureId.or(Handle), at: Timestamp });

export const AttendeeBrief = z.strictObject({
  who: Who,
  inbound: count,
  outbound: count,
  lastAt: Timestamp.nullable(),
  lastMeetingAt: Timestamp.nullable(),
  // From meeting_prep@7: where the last meeting with them and the last thread with them are.
  lastMeeting: MeetingPointer.nullable().optional(),
  lastThread: ThreadPointer.nullable().optional(),
  // From meeting_prep@8: the last captured meeting with them: find_facts names it on the facts it gave. Null with none.
  lastCapture: CapturePointer.nullable().optional(),
});
export type AttendeeBrief = z.infer<typeof AttendeeBrief>;

// A fingerprint, or for a client in session mode a one-time handle.
const fingerprintOrHandle = Hex64.or(Handle);

// A belief as a client cites it: its keyed fact key fingerprint and its state fingerprint, both
// opaque. A belief's version is served to no client. `reviewAfter` is the shared belief's: the next
// moment the lifecycle looks at it again with no new claim, null when it has none.
export const BeliefItem = z.strictObject({
  fact: fingerprintOrHandle,
  state: fingerprintOrHandle,
  kind: BeliefKind,
  type: FactType,
  status: BeliefStatus,
  disputed: z.boolean(),
  provenance: Provenance,
  // Its best supporting claim's tier among the claims of the caller's own clearance, computed with
  // the belief. Optional: an older item has none.
  tier: BeliefTier.optional(),
  // The joined set the belief belongs to, shared by the beliefs of one set across labels, so a
  // reader collapses their lines for a caller that sees both. Optional: a belief in no joined set
  // has none.
  group: fingerprintOrHandle.optional(),
  confirmedAt: Timestamp,
  reviewAfter: Timestamp.nullable(),
});
export type BeliefItem = z.infer<typeof BeliefItem>;

// A claim a compiled belief cites (`CompiledFacts`): a FactView, a finding's with `message` null as
// find_facts serves it, or, for a claim whose message did not come back to the caller, a held cite
// with no text: FactView's text fields are required, and a held message's commitment is served
// without its words. Its `fact` is the claim's id, or for a client in session mode a one-time
// handle.
export const HeldCite = z.strictObject({
  held: z.literal(true),
  fact: FactId.or(Handle),
  type: FactType,
  at: Timestamp,
});
export type HeldCite = z.infer<typeof HeldCite>;
export const Cite = z.union([FactView, HeldCite]);
export type Cite = z.infer<typeof Cite>;

// A belief as a compiled view serves it: a BeliefItem with its subject, its typed values and the claims
// it cites. A belief holds no text: a title, a need's words or a rule's wording are read from `cites`,
// latest first, at most three. A belief all of whose cited claims are held is still served, with held
// cites only.
const when = z.union([DateOnly, Timestamp]);
const compiled = <K extends string, V extends z.ZodRawShape>(kind: K, values: V) =>
  z.strictObject({
    ...BeliefItem.shape,
    kind: z.literal(kind),
    subject: Who,
    values: z.strictObject(values),
    cites: z.array(Cite).min(1).max(3),
  });

// The belief of a confirmed title link: a project's, citing its capture.project claims, which name
// the item. It has no typed value: its subject is the project and its cites' `capture` the item.
// Declared on its own, since lens_mirror@1 serves it too (MirrorEntry), and before CompiledBelief,
// which holds it.
export const CaptureProjectBelief = z.strictObject({
  ...BeliefItem.shape,
  kind: z.literal("capture_project"),
  type: z.literal("capture.project"),
  subject: Who,
  values: z.strictObject({}),
  cites: z
    .array(CaptureFactView)
    .min(1)
    .max(3)
    .refine((cites) => cites.every((cite) => cite.type === "capture.project"), {
      message: "a capture_project belief cites capture.project claims",
    }),
});
export type CaptureProjectBelief = z.infer<typeof CaptureProjectBelief>;

export const CompiledBelief = z.discriminatedUnion("kind", [
  compiled("commitment", { counterparty: Who, due: when.optional() }),
  compiled("role", { organization: Who.optional() }),
  compiled("affiliation", { relation: AffiliationRelation, organization: Who.optional() }),
  compiled("relationship", { counterparty: Who, relation: RelationshipRelation }),
  // An owner-side belief built from version 4 claims holds its life domain among its typed values,
  // and a situation its `momentary`.
  compiled("need", { by: when.optional(), domain: LifeDomain.optional() }),
  compiled("capability", { domain: LifeDomain.optional() }),
  compiled("goal", { by: when.optional(), domain: LifeDomain.optional() }),
  compiled("preference", { polarity: PreferencePolarity, domain: LifeDomain.optional() }),
  compiled("constraint", { until: when.optional(), domain: LifeDomain.optional() }),
  compiled("situation", { until: when.optional(), domain: LifeDomain.optional(), momentary: z.boolean().optional() }),
  // Their typed values; the words are their cites'.
  compiled("view", { domain: LifeDomain.optional() }),
  compiled("status", { since: when.optional(), domain: LifeDomain.optional() }),
  compiled("visited", { when: when.optional(), domain: LifeDomain.optional() }),
  compiled("consent", { about: ConsentSubject, to: Who.optional() }),
  compiled("contact_rule", { rule: ContactRuleKind, channel: ContactChannel, until: when.optional() }),
  compiled("project_status", { status: ProjectStatus }),
  compiled("decision", {}),
  CaptureProjectBelief,
]);
export type CompiledBelief = z.infer<typeof CompiledBelief>;

// One entity's compiled facts: its beliefs, and, newest first, at most twenty claims that count
// in no belief. `more` says either list was cut.
export const CompiledFacts = z.strictObject({
  beliefs: z.array(CompiledBelief).max(200),
  claims: z.array(FactView).max(20),
  more: z.boolean(),
});
export type CompiledFacts = z.infer<typeof CompiledFacts>;

// get_beliefs' answer: at most `limit` beliefs in compileFacts' order, and whether more
// matched or the reading stopped at the audience's ceiling.
export const BeliefList = z.strictObject({ beliefs: z.array(CompiledBelief).max(50), more: z.boolean() });
export type BeliefList = z.infer<typeof BeliefList>;

// A person's one current role and affiliation, picked at read time from the beliefs `facts` serves
// (always among them). `since` is the earliest time among the belief's cites; a role's title and an
// organization named only by name are its latest cite's, under untrusted, null when that cite is
// held. No fingerprint: the wire form serves none that no tool takes.
const CurrentRole = z.strictObject({
  title: UntrustedString.nullable(),
  organization: Who.nullable(),
  organizationName: UntrustedString.nullable(),
  since: Timestamp,
});
const CurrentAffiliation = z.strictObject({
  relation: AffiliationRelation,
  organization: Who.nullable(),
  organizationName: UntrustedString.nullable(),
  since: Timestamp,
});
export const CurrentStanding = z.strictObject({
  role: CurrentRole.optional(),
  affiliation: CurrentAffiliation.optional(),
});
export type CurrentStanding = z.infer<typeof CurrentStanding>;

// How the owner knows the person, each part with its date and a ref the caller can read: the first
// direct message, the meetings both attended (the first of them), the organization of a mail domain
// both hold an address on (it has no date), and the people most often on the same messages, at most
// three. `sharedMailDomain` says where both addresses are, never a role or an employer, past or
// current: that is `current` alone.
export const KnownVia = z.strictObject({
  firstThread: z.strictObject({ at: Timestamp, message: MessageId.or(Handle) }).nullable(),
  meetings: z.strictObject({ count, firstAt: Timestamp, first: EventId.or(Handle) }).nullable(),
  sharedMailDomain: Who.nullable(),
  coRecipients: z
    .array(z.strictObject({ who: Who, messages: count, lastAt: Timestamp, message: MessageId.or(Handle) }))
    .max(3),
});
export type KnownVia = z.infer<typeof KnownVia>;

// One belief rendered as one line by code, from its kind's template, its typed values and the phrase of the cite
// it is rendered from, so every word is code's but that phrase and the names a source gave. `fact` is the
// belief's, as find_facts' `belief` takes it. `domain` is the belief's own, null for a kind with none. `tier` is
// null for a belief built without one. `since` is the earliest of the cites it was rendered with, `at` the newest;
// `until` (a constraint, situation or contact rule) or `by` (a goal, need or commitment) is its typed value;
// `cites` how many cites it was rendered with; `channel` the agent that relayed the phrase, when the owner's words
// came through one. `notice`, exactly on a line of the `system_notice` tier, says which notice it was rendered
// from: its sender's address and its subject line, each null when the caller's token does not return the message
// (a held one), and `sentAt`, the notice's sent time (its cite's `at`, the message's sent time, never when it was
// stored).
const lineWhen = z.union([DateOnly, Timestamp]);
export const LineNotice = z.strictObject({
  from: UntrustedString.nullable(),
  subject: UntrustedString.nullable(),
  sentAt: Timestamp,
});
export type LineNotice = z.infer<typeof LineNotice>;
export const BeliefLine = z
  .strictObject({
    fact: fingerprintOrHandle,
    kind: BeliefKind,
    domain: LifeDomain.nullable(),
    line: UntrustedString,
    tier: BeliefTier.nullable(),
    status: BeliefStatus,
    since: Timestamp,
    at: Timestamp,
    until: lineWhen.optional(),
    by: lineWhen.optional(),
    cites: z.number().int().min(1),
    channel: ClientName.optional(),
    notice: LineNotice.optional(),
    // True when a passing state has not been said again for long enough that it may no longer hold.
    // Code reads it from the line's own dates, on a first read alone, and it ranks low.
    stale: z.literal(true).optional(),
    // The day the line's own words name, which has passed: it reads as past. Set with `stale`.
    pastOn: DateOnly.optional(),
    // A phrase too short to say what it means, served in a domain's read: read its source first.
    thin: z.literal(true).optional(),
  })
  .refine((line) => line.until === undefined || line.by === undefined, {
    message: "a line has an until or a by, never both",
  })
  .refine((line) => (line.tier === "system_notice") === (line.notice !== undefined), {
    message: "a notice exactly on a system_notice line",
    path: ["notice"],
  });
export type BeliefLine = z.infer<typeof BeliefLine>;

// One section of the self page: a life domain's lines, or `unsorted`'s, and the people most present
// in that domain's claims, by the count of claims the caller read that name them. `activeAt` is the
// newest line's `at`; `more` says lines or people were cut. Without get_self's `domain`, at most
// SELF_SECTION_LINES lines; with it, that many of each kind.
export const SectionPerson = z.strictObject({ who: Who, claims: z.number().int().min(1) });
export type SectionPerson = z.infer<typeof SectionPerson>;
export const SelfSection = z.strictObject({
  domain: SectionDomain,
  lines: z.array(BeliefLine).max(SELF_SECTION_LINES * BeliefKind.options.length),
  people: z.array(SectionPerson).max(SELF_SECTION_PEOPLE),
  activeAt: Timestamp,
  more: z.boolean(),
  // Stale lines this section holds that the cut left off: they rank last, so a page can show none of them.
  // Absent means none, which tells that apart from a mark nobody serves. Its `domain` read lists them, marked.
  staleLeftOff: count.optional(),
  // The owner's own constraints the whole page could not hold, though they are kept before any other line.
  // Absent means none. Its `domain` read lists them.
  constraintsLeftOff: count.optional(),
});
export type SelfSection = z.infer<typeof SelfSection>;

// A card holds at most thirty lines.
export const ENTITY_LINES = 30;
// A card's links and the owner's words about the person, at most.
export const PERSON_LINKS = 20;
export const OWNER_WORDS = 60;

// One relation claim naming a named person, as get_entity's `mentionedBy` serves it: who said it,
// the relation or the offer (exactly one), the fact and its date. `heard` marks a meeting's or a
// moment's claim, which builds no belief and makes no hop.
export const MentionedBy = z
  .strictObject({
    by: Who,
    relation: RelationshipRelation.optional(),
    offer: IntroOffer.optional(),
    fact: FactId.or(Handle),
    at: Timestamp,
    heard: z.literal(true).optional(),
  })
  .refine((one) => (one.relation === undefined) !== (one.offer === undefined), {
    message: "a relation or an offer, exactly one",
  });
export type MentionedBy = z.infer<typeof MentionedBy>;

// What stands next with a person, computed by code at each read and stored nowhere: the one open thing
// the stored rows show, as a pointer and never as advice. In order: a commitment the owner owes, a
// meeting ahead, their last message with nothing from the owner since, a commitment owed to the owner,
// else how long since the last contact: `in_touch` while it is recent, `quiet` after. Absent when no
// row says any.
export const NextStep = z.strictObject({
  // `channel_unseen`: the owner stated a close tie and no two-way chat with them reaches this system, so
  // the silence says nothing of them; `at`, `days` and `via` are only what it can see.
  kind: z.enum(["owed_by_owner", "meeting", "unanswered", "owed_to_owner", "in_touch", "quiet", "channel_unseen"]),
  // The commitment's belief, which find_facts' `belief` and close_commitment take, and its due date.
  fact: fingerprintOrHandle.optional(),
  due: z.union([DateOnly, Timestamp]).optional(),
  message: MessageId.or(Handle).optional(),
  meeting: EventId.or(Handle).optional(),
  // The message's or the meeting's time, or the last contact's.
  at: Timestamp.optional(),
  // Whole days since the last contact, and the channel it was on.
  days: count.optional(),
  via: z.enum(["message", "meeting", "chat"]).optional(),
  // A meeting's: a finding naming this person and this day that says it changed. Unconfirmed: the slot stays
  // what the calendar says, and this says not to take it as firm.
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
  // A meeting's: its own title says it is being moved or called off. The slot stays the calendar's.
  moving: z.literal(true).optional(),
});
export type NextStep = z.infer<typeof NextStep>;

// What a person's page leads with, first on get_entity and on person_brief's person, over rows the caller's token
// returns. `tier` the caller's audience's warmth tier; `tie` the relation the owner confirmed; `openCommitments` the
// open ones between them and the owner that get_commitments({ with }) lists, null for a client without the Work
// view, whatever the owner has; `lastContact` which of the pointers, or a two-way chat, is newer; `role` and
// `organization` the current role's or affiliation's words, null when unknown or held: never the domain of an
// address.
export const PERSON_SAME_NAME = 3;
export const PersonLead = z.strictObject({
  tier: Tier.nullable(),
  tie: TieRelation.nullable(),
  openCommitments: count.nullable(),
  lastContact: z.enum(["message", "meeting", "chat"]).nullable(),
  lastThread: ThreadPointer.nullable(),
  lastMeeting: MeetingPointer.nullable(),
  // When the last contact was a two-way chat, its time: no pointer names a chat.
  lastChatAt: Timestamp.optional(),
  role: UntrustedString.nullable(),
  organization: UntrustedString.nullable(),
  nextStep: NextStep.optional(),
  // What agents reported naming this person, newest first, unconfirmed: beside the fields, never moving one.
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
  // The owner stated this tie is close and its warmth line saw nothing: other people the caller can see
  // under this person's whole name, where the contact may sit. Nobody is joined by this.
  sameName: z.array(Who).min(1).max(PERSON_SAME_NAME).optional(),
});
export type PersonLead = z.infer<typeof PersonLead>;

// get_entity's answer. In this file, not tools-views.ts, since `facts` holds beliefs, which carry a
// provenance (see above).
export const EntityView = z.strictObject({
  // A project's open items, a line each, for a client with the Work view.
  openItems: ShownOpenItems.optional(),
  // A project's alone: what agents' findings say naming it or filed under it, newest first, unconfirmed:
  // beside its status, never moving it. A person's are on `lead`.
  reported: z.array(AgentReport).min(1).max(AGENT_REPORTS_SHOWN).optional(),
  // A project's alone: where it stands, who said so and when, and the latest word of each other
  // tier that says otherwise. `status` beside it is the project's own row: active, closed or
  // merged.
  projectStatus: ProjectStanding.optional(),
  id: EntityId.or(Handle),
  kind: SubjectKind,
  // A person's only, so it leads what a reader takes first.
  lead: PersonLead.optional(),
  // A named person, known by a name alone.
  nameOnly: z.literal(true).optional(),
  // At most 10 relation claims naming a named person, newest first.
  mentionedBy: z.array(MentionedBy).max(10).optional(),
  names: z.array(UntrustedString),
  addresses: z.array(UntrustedString),
  // A person's: the organization of the domain their address is on, where the address is and never a
  // role; the current one is `lead` and `current`.
  organization: Who.nullable(),
  people: z.array(Who),
  // headersOnly: how many of the counted messages are held by their headers alone: they have no
  // stored message, so find_messages, read_message and get_timeline return none of them. Left out
  // when none are.
  mail: z.strictObject({
    inbound: count,
    outbound: count,
    headersOnly: z.number().int().positive().optional(),
    firstAt: Timestamp.nullable(),
    lastAt: Timestamp.nullable(),
  }),
  lastMeeting: MeetingView.nullable(),
  nextMeeting: MeetingView.nullable(),
  // A saved contact's details, each marked use-only: for an `own` contact only.
  details: z.array(ContactDetails).max(5),
  // Whether the owner marked an address of the person shared by several people.
  shared: z.boolean(),
  // `lines`, the card's beliefs as lines by section, replace `facts`; full cites come from
  // find_facts' `belief`.
  facts: CompiledFacts.optional(),
  lines: z.array(BeliefLine).max(ENTITY_LINES).optional(),
  // Beside `lines`, whether the person's beliefs were cut to fit them.
  more: z.boolean().optional(),
  // A project's status, the owner's (active, merged or closed). Only a project carries it.
  status: z.enum(["active", "merged", "closed"]).optional(),
  // A person's card on get_entity alone; no other read serves them.
  current: CurrentStanding.optional(),
  // The person's warmth tier from the caller's audience.
  warmth: WarmthLine.optional(),
  knownVia: KnownVia.optional(),
  // A person's links, use-only, and the owner's own words about them (an import's
  // tags and notes), from the owner's own (`own`) contacts the details come from. A person's only.
  links: z.array(PersonLinkView).max(PERSON_LINKS).optional(),
  ownerWords: z.array(OwnerWordsView).max(OWNER_WORDS).optional(),
  // The person's confirmed tie to the owner and typed links, each from a confirmed
  // agent proposal released to `own`. A person's only, and only when there are some.
  toOwner: OwnerTieView.optional(),
  connections: z.array(ConnectionView).max(PERSON_CONNECTIONS).optional(),
  // A project's time, a project's only.
  time: ProjectTime.optional(),
});
export type EntityView = z.infer<typeof EntityView>;

// An entity as a pack's item (person_brief's `person` section): get_entity's answer without
// its `facts`, which the pack's own `facts` section serves, cut to that section's cap, and its
// `lines`, the same beliefs as lines, with their `more`.
export const PackEntity = EntityView.omit({ facts: true, lines: true, more: true });
export type PackEntity = z.infer<typeof PackEntity>;

// One commitment with the owner on one side. `counterparty` is the party that is not the owner;
// `what` and `message` come from the belief's latest supporting claim, and are null when its
// message is not returned (a held one). A commitment cited by a meeting names the capture item and
// its span, as FactView does.
export const CommitmentItem = z
  .strictObject({
    belief: BeliefItem,
    direction: z.enum(["owed_by_owner", "owed_to_owner"]),
    counterparty: Who.nullable(),
    due: z.union([DateOnly, Timestamp]).nullable(),
    what: UntrustedString.nullable(),
    message: MessageId.or(Handle).nullable(),
    capture: CaptureId.or(Handle).nullable(),
    segment: z
      .strictObject({ from: count, to: count })
      .refine((span) => span.to >= span.from, { message: "a span ends after it starts" })
      .nullable(),
    // Which kind of source its latest claim came from, set only when that claim's message or capture
    // item came back to the caller; absent otherwise, so a held message's says nothing.
    source: FactSource.optional(),
    // When a closed commitment was said closed, when it was done by the owner's own completion,
    // mail or answer and from what, and the advisory minutes worked on its targets. "Said closed,
    // not kept". Null for a commitment that is not closed. Optional, so an older item still parses.
    closedAt: Timestamp.nullable().optional(),
    doneAt: Timestamp.nullable().optional(),
    // The first day a commitment was no longer open because its date or its courtesy passed in
    // silence: nobody closed it, and its belief still reads active. Absent for anything else.
    lapsed: DateOnly.optional(),
    doneBy: z
      .union([
        z.strictObject({ message: MessageId.or(Handle) }),
        z.strictObject({ capture: CaptureId.or(Handle), segment: count }),
        z.strictObject({ answer: AgentRecordId.or(Handle) }),
        // The owner's own close at their terminal (`pi commitments close`), by its decision.
        z.strictObject({ close: RulingId.or(Handle) }),
      ])
      .nullable()
      .optional(),
    // Who closed a closed commitment: an agent by its close (whose words are its own,
    // never the owner's), the owner at their terminal, or a source's reversal (mail, a meeting, the
    // owner's answer). Null when it is not closed or no closing claim is visible. `ending` is the
    // close's, when an agent or the owner closed it.
    closedBy: z
      .union([
        z.strictObject({ agent: ClientName.or(Handle), close: AgentRecordId.or(Handle) }),
        z.strictObject({ owner: z.literal(true), close: RulingId.or(Handle) }),
        z.strictObject({ source: z.literal(true) }),
      ])
      .nullable()
      .optional(),
    ending: CommitmentEnding.nullable().optional(),
    workedOn: WorkedOn.nullable().optional(),
  })
  .refine((one) => one.message === null || one.capture === null, {
    message: "a commitment has a message or a capture item, never both",
  })
  .refine((one) => one.segment === null || one.capture !== null, {
    message: "a segment only with a capture item",
    path: ["segment"],
  });
export type CommitmentItem = z.infer<typeof CommitmentItem>;

export const CommitmentList = z.strictObject({ commitments: z.array(CommitmentItem), more: z.boolean() });
export type CommitmentList = z.infer<typeof CommitmentList>;

// One line of the second degree, rendered by code from a claim or a belief, never model text.
// `through` is the attendee (meeting_prep) or the person (person_brief); `person` someone they
// reach whom the owner has no own tie with (`nameOnly` where known by a name alone); `tie` the
// hop's kind, with the relation or the offer where it has one; `fact` the claim cited and `at` its
// date; `goal` the active goal that targets the person, where one does. `heard` marks a meeting's
// or a chat's claim not linked to an event: listed, never a hop.
export const SecondDegreeTie = PathTie.exclude([
  "own_tie",
  "affiliation",
  "shared_thread",
  "same_domain",
  "met_together",
]);
export type SecondDegreeTie = z.infer<typeof SecondDegreeTie>;
export const SecondDegreeLine = z
  .strictObject({
    through: Who,
    person: Who,
    tie: SecondDegreeTie,
    relation: RelationshipRelation.optional(),
    offer: IntroOffer.optional(),
    fact: FactId.or(Handle),
    at: Timestamp,
    heard: z.literal(true).optional(),
    goal: z.strictObject({ id: GoalId.or(Handle), statement: UntrustedString }).optional(),
  })
  .refine((one) => (one.tie === "intro_offer") === (one.offer !== undefined), {
    message: "an offer exactly on an intro_offer",
  });
export type SecondDegreeLine = z.infer<typeof SecondDegreeLine>;

// An item's id is the id of the row it shows; an address's is `address:<n>`, a second-degree
// line's `second_degree:<n>`, a commitment's its belief's fact.
const item = {
  id: z.string().min(1),
  section: PackSection,
  required: z.boolean(),
  provenance: Provenance,
  asOf: Timestamp,
};

export const PackItem = z.discriminatedUnion("kind", [
  z.strictObject({ ...item, kind: z.literal("address"), value: UntrustedString }),
  // `cut` says the participant list shown is shorter than the meeting's.
  z.strictObject({ ...item, kind: z.literal("meeting"), meeting: MeetingView, cut: z.boolean() }),
  z.strictObject({ ...item, kind: z.literal("contact"), contact: ContactCount }),
  z.strictObject({ ...item, kind: z.literal("attendee"), attendee: AttendeeBrief }),
  z.strictObject({ ...item, kind: z.literal("message"), message: MessageSummary }),
  z.strictObject({ ...item, kind: z.literal("record"), record: AgentRecordView }),
  z.strictObject({ ...item, kind: z.literal("commitment"), commitment: CommitmentItem }),
  // A preference the owner confirmed for this client alone; its id is its agent record's.
  z.strictObject({
    ...item,
    kind: z.literal("preference"),
    id: AgentRecordId.or(Handle),
    what: UntrustedString,
    polarity: PreferencePolarity,
    confirmedAt: Timestamp,
  }),
  // One of the owner's stated beliefs; its id is the belief's fact.
  z.strictObject({ ...item, kind: z.literal("belief"), belief: CompiledBelief }),
  // The person a person_brief is about; its id is the entity's.
  z.strictObject({ ...item, kind: z.literal("entity"), entity: PackEntity }),
  // The agent guide, code's own text: its id is its version, and it has no provenance and is never
  // untrusted.
  z.strictObject({
    id: z.string().regex(/^agent_guide@[1-9][0-9]*$/),
    section: z.literal("guide"),
    required: z.literal(true),
    asOf: Timestamp,
    kind: z.literal("guide"),
    text: z.string().min(1).max(5000),
  }),
  // get_self's `work`, computed at read; its id is "work".
  z.strictObject({ ...item, kind: z.literal("work"), work: WorkNow }),
  // One open item; its id is its source's.
  z.strictObject({ ...item, kind: z.literal("open_item"), openItem: OpenItem }),
  // One second-degree line; its id is its place, `second_degree:<n>`.
  z.strictObject({ ...item, kind: z.literal("second_degree"), line: SecondDegreeLine }),
  // One of the caller's moves cleared and never reported, read from the
  // ledger as `work` is; its id is the move's. Only an internal stage is ever cleared.
  z.strictObject({
    ...item,
    kind: z.literal("unreported_move"),
    id: MoveId.or(Handle),
    opportunity: OpportunityId.or(Handle),
    stage: z.enum(["investigate", "prepare"]),
    say: z.literal("report or release"),
  }),
  // A piece of work the caller holds, read from the ledger as `work` is; its id is the work's. Its
  // view carries its latest progress. `checkBack`, the caller's own waiting check-back on it (a
  // parked piece of work has one): when it is due, and the note set with it.
  z.strictObject({
    ...item,
    kind: z.literal("held_work"),
    id: OpportunityId.or(Handle),
    opportunity: OpportunityView,
    checkBack: z.strictObject({ dueAt: Timestamp, note: UntrustedString.nullable() }).nullable(),
    // How the caller has it (A8): held, held to a date, lapsed or returned.
    state: WorkHold,
  }),
  // The caller's own record over 28 days, counts and codes only, with code's words on what it is
  // for; its id is "record". Only a record with something in it is served.
  z.strictObject({
    ...item,
    kind: z.literal("own_record"),
    id: z.literal("record"),
    record: AgentRecord,
    say: z.literal(AGENT_RECORD_SAY),
  }),
  // The caller's standing over the last seven days, counts and codes only, with code's words on what
  // it is for; its id is "standing". Served whatever it holds.
  z.strictObject({
    ...item,
    kind: z.literal("standing"),
    id: z.literal("standing"),
    standing: AgentStanding,
    say: z.literal(AGENT_STANDING_SAY),
  }),
  // One known issue and one active learning of the caller's scope.
  z.strictObject({ ...item, ...KNOWN_ISSUE_ITEM }),
  z.strictObject({ ...item, ...LEARNING_ITEM }),
  // The project a project_brief is about, as get_project answers it; its id is the project's.
  z.strictObject({
    ...item,
    kind: z.literal("project"),
    id: EntityId.or(Handle),
    project: PersonalWorkResults.get_project,
  }),
]);
export type PackItem = z.infer<typeof PackItem>;

// `template` is the purpose, "@" and the version, such as agent_bootstrap@1.
export const ContextPack = z.strictObject({
  purpose: PersonalContextPackPurpose,
  template: z.string().regex(/^[a-z][a-z_]*@[1-9][0-9]*$/),
  asOf: Timestamp,
  items: z.array(PackItem),
  truncated: z.boolean(),
  hash: Hex64,
  // The sections the client's views leave out, and `goals` when list_goals' gate does: as get_self's
  // `withheld`, a function of the registration alone.
  withheld: z
    .array(z.union([PackSection, z.literal("goals")]))
    .min(1)
    .optional(),
});
export type ContextPack = z.infer<typeof ContextPack>;
