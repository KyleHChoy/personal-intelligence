// What the read tools answer: people, meetings, work, messages, facts, documents and timelines.
import { z } from "zod";
import { BeliefStatus } from "../belief.ts";
import { StatementKind } from "../claim.ts";
import { DateOnly, Timestamp } from "../ids.ts";
import { ActivityCategory } from "./activity.ts";
import { LinkKind } from "./contact-import.ts";
import { CurrencyCode } from "./currencies.ts";
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
import { AgentRecordId, AnchorId, CaptureId, ClientName, Handle, MessageId, PageId } from "./ids.ts";
import { ClaimTier, LifeDomain } from "./knowledge-model.ts";
import { Closeness, ConnectionKind, TieRelation } from "./people-ties.ts";
import { SubjectKind } from "./subjects.ts";
import { DocumentKind, DocumentUnreadable, FactId, MessageCategory, UntrustedString } from "./tools-args.ts";
import { document, entity, event, message } from "./tools-fields.ts";
import { MATCH_RULE } from "./work-time.ts";

const who = {
  id: entity,
  kind: SubjectKind,
  name: UntrustedString.nullable(),
  address: UntrustedString.nullable(),
  nameOnly: z.literal(true).optional(),
};

export const Who = z.strictObject(who);
export type Who = z.infer<typeof Who>;

// `response` is the owner's own. An all-day event is served as its days, `date`
// its first and `lastDate` its last, with no instant, since a UTC midnight read in a local zone is
// the evening before; the Lens mirror keeps its instants.
export const MeetingView = z.strictObject({
  id: event,
  title: UntrustedString.nullable(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  allDay: z.boolean(),
  date: DateOnly.optional(),
  lastDate: DateOnly.optional(),
  cancelled: z.boolean(),
  participants: z.array(Who),
  response: z.enum(["needsAction", "accepted", "tentative", "declined"]).optional(),
});
export type MeetingView = z.infer<typeof MeetingView>;

const count = z.number().int().nonnegative();
const masked = z.number().int().positive();

// Work time, the shapes a timeline entry holds: computed at read from the capture rows the caller
// can see, never stored. Minutes are observed foreground time, not effort.
export const WorkMinutes = z.number().min(0);
export type WorkMinutes = z.infer<typeof WorkMinutes>;
const workMinutes = WorkMinutes;

export const WhereKind = z.enum(["repository", "folder", "document", "host", "app"]);
export type WhereKind = z.infer<typeof WhereKind>;
export const WorkWhere = z.strictObject({
  kind: WhereKind,
  value: UntrustedString,
  strength: z.enum(["strong", "weak"]),
});
export type WorkWhere = z.infer<typeof WorkWhere>;

export const WorkTarget = z.union([z.strictObject({ project: Who }), z.strictObject({ where: WorkWhere })]);
export type WorkTarget = z.infer<typeof WorkTarget>;

export const WorkBasisCode = z.enum([
  "ruling",
  "meeting",
  "anchor",
  "moment",
  "title",
  "agent_ruling",
  "agent_anchor",
  "proposed",
  "none",
]);
export type WorkBasisCode = z.infer<typeof WorkBasisCode>;

// `minutes` are the credited minutes inside it, never its span; `agent_ruling` and `agent_anchor`
// an agent's, never the owner's.
export const WorkSession = z.strictObject({
  target: WorkTarget,
  start: Timestamp,
  end: Timestamp,
  minutes: workMinutes,
  top: WorkWhere.nullable(),
  basis: WorkBasisCode,
});
export type WorkSession = z.infer<typeof WorkSession>;

// It closes nothing.
export const WorkedOn = z.strictObject({
  rule: z.literal(MATCH_RULE),
  advisory: z.literal(true),
  minutes: workMinutes,
  sessions: count,
  from: Timestamp,
  to: Timestamp,
  shared: count,
  partial: z.boolean(),
});
export type WorkedOn = z.infer<typeof WorkedOn>;

// `completionRecordedAt` is when the owner ticked it; `doneAt` is only what they stated, never the
// recorded time in its place.
export const TaskView = z.strictObject({
  capture: CaptureId.or(Handle),
  title: UntrustedString,
  project: Who.nullable(),
  createdAt: Timestamp,
  completionRecordedAt: Timestamp.nullable(),
  doneAt: Timestamp.nullable(),
  reopened: count,
  workedOn: WorkedOn.nullable(),
});
export type TaskView = z.infer<typeof TaskView>;

// Counted in each window, both directions.
export const ContactCount = z.strictObject({
  ...who,
  emails30d: count,
  emails90d: count,
  meetings90d: count,
  // Two-way contact in the ninety days with chat among their channels put them here: its last time, on
  // any channel. The counts above are mail and meetings.
  lastTwoWayAt: Timestamp.optional(),
});
export type ContactCount = z.infer<typeof ContactCount>;

// A saved contact's sealed fields, each value wrapped. Month and day of a birthday, never a year.
// EntityView, which holds them, is in packs.ts. `disclosure` marks every field use-only: a client
// may use it, and the outbound gate holds a draft that carries one to anyone the contact does not
// exempt.
export const ContactDetails = z.strictObject({
  disclosure: z.literal("use_only"),
  names: z.array(UntrustedString),
  phones: z.array(z.strictObject({ value: UntrustedString, type: UntrustedString.nullable() })),
  organizations: z.array(z.strictObject({ name: UntrustedString.nullable(), title: UntrustedString.nullable() })),
  birthday: z.strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullable(),
});
export type ContactDetails = z.infer<typeof ContactDetails>;

// A link on a person, from a `link` claim of one of the owner's own contacts, its
// URL and label wrapped as every value from a source is, use-only as a contact's details are (the
// gate holds a draft that carries it to anyone the contact does not exempt). Never fetched.
export const PersonLinkView = z.strictObject({
  disclosure: z.literal("use_only"),
  url: UntrustedString,
  kind: LinkKind,
  label: UntrustedString.nullable(),
});
export type PersonLinkView = z.infer<typeof PersonLinkView>;

// The owner's own words about a person, an import's tag (`key` its column) or note (`key` its
// column, null for an older stored one), from one of the owner's own contacts. `by` marks
// them the owner's: never a fact about the person, in no claim and no belief. `cut`: the value was cut short
// to keep the view bounded.
export const OwnerWordsView = z.strictObject({
  by: z.literal("owner"),
  kind: z.enum(["tag", "note"]),
  key: UntrustedString.nullable(),
  value: UntrustedString,
  cut: z.literal(true).optional(),
});
export type OwnerWordsView = z.infer<typeof OwnerWordsView>;
export const SignatureView = z.strictObject({
  message: MessageId,
  at: Timestamp,
  name: UntrustedString.nullable(),
  title: UntrustedString.nullable(),
  organization: UntrustedString.nullable(),
  phones: z.array(UntrustedString).max(3),
  addresses: z.array(UntrustedString).max(3),
  links: z.array(UntrustedString).max(3),
});
export type SignatureView = z.infer<typeof SignatureView>;

// The first From address and the name written with it.
export const MessageSender = z.strictObject({ address: UntrustedString, name: UntrustedString.nullable() });
export type MessageSender = z.infer<typeof MessageSender>;

const summary = {
  id: message,
  at: Timestamp,
  direction: z.enum(["inbound", "outbound"]),
  bulk: z.boolean(),
  category: MessageCategory,
  subject: UntrustedString.nullable(),
  sender: MessageSender.nullable(),
  // The length of the text in code points.
  chars: count,
  // How many attachments the message has.
  attachments: count,
  masked: masked.optional(),
};

export const MessageSummary = z.strictObject(summary);
export type MessageSummary = z.infer<typeof MessageSummary>;

// At most `limit` messages, newest first, and whether more matched.
export const MessageList = z.strictObject({ messages: z.array(MessageSummary), more: z.boolean() });
export type MessageList = z.infer<typeof MessageList>;

// Never the attachment's bytes.
export const AttachmentView = z.strictObject({ name: UntrustedString, type: UntrustedString, size: count });
export type AttachmentView = z.infer<typeof AttachmentView>;

// The Gmail address of one conversation, built by code from Gmail's own thread id. It is not
// wrapped as untrusted: one host and one form pass, and it carries no text a sender chose.
export const MessageLink = z.string().regex(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/[0-9a-f]{1,32}$/);
export type MessageLink = z.infer<typeof MessageLink>;

export const MessageView = z.strictObject({
  ...summary,
  thread: UntrustedString,
  // The slice asked for, null when the message has no text.
  text: UntrustedString.nullable(),
  offset: count,
  // The text goes on past the slice.
  more: z.boolean(),
  // The stored body could not be read as text.
  unreadable: z.boolean(),
  attachmentList: z.array(AttachmentView).max(50),
  link: MessageLink.nullable(),
});
export type MessageView = z.infer<typeof MessageView>;

// What a fact or an item rests on. `source`: a source that is not an agent; `agent_reported`:
// agent records alone. `owner`: a preference the owner confirmed, in a pack. `corroborated` is not produced yet.
export const Provenance = z.enum(["source", "agent_reported", "corroborated", "owner"]);
export type Provenance = z.infer<typeof Provenance>;

// Where a fact came from, by the kind of source its evidence is, set by code at read: `messages` a
// chat moment a source rule admitted (iMessage), `screen` any other moment or block Lens saw on
// screen, agent apps' included, `agent` an agent record or write, `owner` the owner's own command
// or answer, `other` a source no other kind names.
export const FACT_SOURCES = Object.freeze([
  "mail",
  "messages",
  "screen",
  "meeting",
  "calendar",
  "contacts",
  "document",
  "web",
  "agent",
  "owner",
  "other",
] as const);
export const FactSource = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof FactSource>;

// One fact, by its type. Every text value came from evidence, and so did a person's name and
// address: each is untrusted. A new type is a new member: a fact of a type the contract does
// not know fails the parse.
const fact = {
  id: FactId.or(Handle),
  subject: Who,
  statedBy: Who.nullable(),
  // `system_observed`, an activity fact's, which only code sets.
  basis: z.enum(["explicit_self", "third_party", "system_observed"]),
  statementKind: StatementKind,
  at: Timestamp,
  message: message.nullable(),
  // A fact from a document names it, and the passage its claim cites, in UTF-16 code units
  // of get_document's text.
  document: document.nullable(),
  passage: z.strictObject({ start: count, end: count }).nullable(),
  // A fact from a stored web page names it, its URL as fetched and when it was fetched.
  page: z.strictObject({ id: PageId.or(Handle), url: UntrustedString, fetchedAt: Timestamp }).nullable(),
  // A fact has at most one of a message, a document, a page and a capture item.
  capture: CaptureId.or(Handle).nullable(),
  segment: z
    .strictObject({ from: count, to: count })
    .refine((span) => span.to >= span.from, { message: "a span ends after it starts" })
    .nullable(),
  // A fact from an agent record names it, the record the caller's token returns,
  // which a basis cites as {kind: "agent_record"}. No other fact has the key.
  record: AgentRecordId.or(Handle).optional(),
  thirdParty: z.boolean(),
  agentReported: z.boolean(),
  // Derived: agent_reported exactly when agentReported is true.
  provenance: Provenance,
  // Optional: an older stored copy has neither. No argument of any tool names either.
  tier: ClaimTier.optional(),
  channel: ClientName.optional(),
  // Set by code from the moment's rule and the claim's speaker.
  sourceMark: z.literal("agent_chat").optional(),
  status: BeliefStatus.optional(),
  // Where the fact came from. Optional: an older stored copy, and an output that omits it, have none.
  source: FactSource.optional(),
};
const when = z.union([DateOnly, Timestamp]);

const what = UntrustedString;
// A type with an `until` field serves it also as the fact's `validTo`: `until` is a field, `validTo` the
// one top-level key it adds.
const until = when.optional();
const domain = LifeDomain.optional();
const ends = { validTo: Timestamp.optional() };
const statement = <T extends string, F extends z.ZodRawShape>(type: T, fields: F) =>
  z.strictObject({ ...fact, type: z.literal(type), fields: z.strictObject(fields) });
const namesOrganization = (fields: { organization?: unknown; organization_name?: unknown }): boolean =>
  fields.organization !== undefined || fields.organization_name !== undefined;

// The source facts code makes from a capture item: a project link, `capture.anchor` or
// `capture.project`, and a meeting's participant, `capture.person`. Each names its item and no
// span, and is never an agent's. Declared here because lens_mirror@1 serves them (MirrorEntry).
const captureFact = <T extends string, F extends z.ZodRawShape>(type: T, fields: F) =>
  z.strictObject({
    ...fact,
    type: z.literal(type),
    fields: z.strictObject(fields),
    message: z.null(),
    document: z.null(),
    passage: z.null(),
    page: z.null(),
    capture: CaptureId.or(Handle),
    segment: z.null(),
    agentReported: z.literal(false),
    provenance: z.literal("source"),
  });
// Never an agent's.
const activityFact = <T extends string, F extends z.ZodType>(type: T, fields: F) =>
  z.strictObject({
    ...fact,
    ...ends,
    type: z.literal(type),
    fields,
    message: z.null(),
    document: z.null(),
    passage: z.null(),
    page: z.null(),
    capture: CaptureId.or(Handle),
    segment: z.null(),
    agentReported: z.literal(false),
    provenance: z.literal("source"),
  });
const exactlyOne =
  (names: readonly string[]) =>
  (fields: Record<string, unknown>): boolean =>
    names.filter((name) => fields[name] !== undefined).length === 1;
const factMembers = z.discriminatedUnion("type", [
  z.strictObject({
    ...fact,
    type: z.literal("transaction.receipt"),
    fields: z.strictObject({
      merchant: UntrustedString,
      amount: z.number(),
      currency: CurrencyCode,
      date: DateOnly,
      order_ref: UntrustedString.optional(),
    }),
  }),
  z.strictObject({
    ...fact,
    type: z.literal("commitment"),
    fields: z.strictObject({ counterparty: Who, what: UntrustedString, due: when.optional() }),
  }),
  z.strictObject({
    ...fact,
    type: z.literal("plan"),
    fields: z.strictObject({ counterparty: Who.optional(), what: UntrustedString, when }),
  }),
  statement("role", {
    title: UntrustedString,
    organization: Who.optional(),
    organization_name: UntrustedString.optional(),
  }),
  z.strictObject({
    ...fact,
    type: z.literal("affiliation"),
    fields: z
      .strictObject({
        relation: AffiliationRelation,
        organization: Who.optional(),
        organization_name: UntrustedString.optional(),
      })
      .refine(namesOrganization, { message: "an affiliation names its organization" }),
  }),
  statement("relationship", { counterparty: Who, relation: RelationshipRelation }),
  statement("intro_offer", { person: Who, offer: IntroOffer }),
  statement("need", { what, by: when.optional(), domain }),
  statement("capability", { what, domain }),
  statement("goal", { what, by: when.optional(), domain }),
  statement("preference", { what, polarity: PreferencePolarity, domain }),
  z.strictObject({ ...fact, ...ends, type: z.literal("constraint"), fields: z.strictObject({ what, until, domain }) }),
  z.strictObject({
    ...fact,
    ...ends,
    type: z.literal("situation"),
    fields: z.strictObject({ what, until, domain, momentary: z.boolean().optional() }),
  }),
  // A view's `what` is the view, a status's the process and a visit's the place (KEY_FIELDS'
  // phrase), each with its value fields.
  statement("view", { what, topic: UntrustedString.optional(), domain }),
  statement("status", {
    what,
    organization_name: UntrustedString,
    state: UntrustedString,
    since: when.optional(),
    domain,
  }),
  statement("visited", { what, when: when.optional(), domain }),
  statement("consent", { about: ConsentSubject, to: Who.optional(), what }),
  z.strictObject({
    ...fact,
    ...ends,
    type: z.literal("contact_rule"),
    fields: z.strictObject({ rule: ContactRuleKind, channel: ContactChannel, what, until }),
  }),
  statement("project.status", { status: ProjectStatus, what: what.optional() }),
  statement("project.decision", { what }),
  statement("project.fact", { what }),
  statement("project.next_step", { what, who: Who, due: when.optional() }),
  captureFact("capture.person", { role: z.enum(["speaker", "organizer", "attendee"]) }),
  // No read serves a capture.project fact but as a cite of its confirmed capture_project belief.
  captureFact("capture.anchor", { anchor: AnchorId }),
  captureFact("capture.project", {}),
  // A link on a person, from a contact (a claim of the owner's own contacts only).
  statement("link", { url: UntrustedString, kind: LinkKind, label: UntrustedString.optional() }),
  // A person the owner knows, proposed by an agent (about the owner, naming no
  // entity), a person's tie to the owner, and a typed link to another person or an organization.
  statement("known_person", {
    name: UntrustedString,
    known_how: UntrustedString,
    email: UntrustedString.optional(),
    phone: UntrustedString.optional(),
    linkedin: UntrustedString.optional(),
  }),
  statement("owner_tie", { relation: TieRelation, closeness: Closeness }),
  statement("connection", { kind: ConnectionKind, other: Who, inferred: z.boolean() }),
  activityFact(
    "activity.worked_on",
    z
      .strictObject({
        project: Who.optional(),
        repository: UntrustedString.optional(),
        document: UntrustedString.optional(),
      })
      .refine(exactlyOne(["project", "repository", "document"]), { message: "a project, a repository or a document" }),
  ),
  activityFact(
    "activity.researched",
    z
      .strictObject({
        project: Who.optional(),
        category: ActivityCategory.optional(),
        topic: UntrustedString.optional(),
        host: UntrustedString,
        hosts: UntrustedString.optional(),
        queries: UntrustedString.optional(),
      })
      .refine(exactlyOne(["project", "category", "topic"]), { message: "a project, a category or a topic" }),
  ),
  activityFact("activity.messaged", z.strictObject({ counterparty: Who })),
  activityFact("activity.met", z.strictObject({ counterparty: Who })),
]);
export const FactView = factMembers
  .refine((one) => (one.provenance === "agent_reported") === one.agentReported, {
    message: "provenance is agent_reported exactly when agentReported is true",
    path: ["provenance"],
  })
  .refine(
    (one) =>
      [one.message, one.document, one.page, one.capture, one.record ?? null].filter((source) => source !== null)
        .length <= 1,
    { message: "a fact has a message, a document, a page, a capture item or an agent record, never two" },
  )
  .refine((one) => one.segment === null || one.capture !== null, {
    message: "a segment only with a capture item",
    path: ["segment"],
  });
export type FactView = z.infer<typeof FactView>;

export const CaptureFactView = z.discriminatedUnion("type", [
  captureFact("capture.anchor", { anchor: AnchorId }),
  captureFact("capture.project", {}),
  captureFact("capture.person", { role: z.enum(["speaker", "organizer", "attendee"]) }),
]);
export type CaptureFactView = z.infer<typeof CaptureFactView>;

export const FactList = z.strictObject({ facts: z.array(FactView), more: z.boolean() });
export type FactList = z.infer<typeof FactList>;

// A document's Google address, built by code from the file's id and kind. Not wrapped, as
// MessageLink is not.
export const DocumentLink = z
  .string()
  .regex(
    /^https:\/\/(docs\.google\.com\/(document|spreadsheets|presentation)\/d\/[A-Za-z0-9_-]{10,100}\/edit|drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,100}\/view)$/,
  );
export type DocumentLink = z.infer<typeof DocumentLink>;

// Offsets, lengths, `start` and `end` are UTF-16 code units, the unit of a span.
export const DocumentSummary = z.strictObject({
  id: document,
  title: UntrustedString,
  kind: DocumentKind,
  modifiedAt: Timestamp,
  mine: z.boolean(),
  owner: z.strictObject({ name: UntrustedString.nullable(), address: UntrustedString.nullable() }).nullable(),
  reference: z.boolean(),
  chars: count,
  sections: count,
  unreadable: DocumentUnreadable.nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

// `scanned` is false when a title search stopped at its bound.
export const DocumentList = z.strictObject({
  documents: z.array(DocumentSummary),
  more: z.boolean(),
  scanned: z.boolean(),
});
export type DocumentList = z.infer<typeof DocumentList>;

// A heading is at most 200 code units.
export const SectionView = z.strictObject({
  ordinal: count,
  heading: z.strictObject({ untrusted: z.string().max(200) }),
  start: count,
  end: count,
});
export type SectionView = z.infer<typeof SectionView>;

export const DocumentView = z.strictObject({
  ...DocumentSummary.shape,
  outline: z.array(SectionView),
  text: UntrustedString.nullable(),
  offset: count,
  more: z.boolean(),
  link: DocumentLink.nullable(),
  masked: masked.optional(),
});
export type DocumentView = z.infer<typeof DocumentView>;

// A names search's people and organizations. In a match mode `results` is empty and
// `matches` holds the claims whose text holds a word of the query, each with how many distinct
// words of it it holds, and `more` says more matched or the scan stopped short; the two come
// together.
export const SearchResult = z
  .strictObject({
    results: z.array(z.strictObject({ ...who, lastInteractionAt: Timestamp.nullable() })),
    matches: z.array(z.strictObject({ fact: FactView, score: z.number().int().min(1) })).optional(),
    more: z.boolean().optional(),
    // A fixed sentence on a name nothing visible holds, the same whether it is absent or hidden.
    note: z.string().optional(),
  })
  .refine((result) => (result.matches === undefined) === (result.more === undefined), {
    message: "matches and more come together",
  });
export type SearchResult = z.infer<typeof SearchResult>;

export const TimelineEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("email"),
    id: message,
    at: Timestamp,
    direction: z.enum(["inbound", "outbound"]),
    subject: UntrustedString.nullable(),
    thread: UntrustedString,
  }),
  z.strictObject({ kind: z.literal("meeting"), at: Timestamp, meeting: MeetingView }),
  // A fact about or naming the entity, at its time.
  z.strictObject({ kind: z.literal("fact"), at: Timestamp, fact: FactView }),
  z.strictObject({ kind: z.literal("work_session"), at: Timestamp, session: WorkSession }),
  z.strictObject({
    kind: z.literal("task"),
    at: Timestamp,
    change: z.enum(["created", "completed", "reopened"]),
    task: TaskView,
  }),
  // A meeting Lens recorded and linked to no calendar event, at its start: its capture item, its
  // time and the people its participant claims name, as the caller sees them. No title: a capture
  // item's sealed fields are served nowhere.
  z.strictObject({
    kind: z.literal("captured_meeting"),
    at: Timestamp,
    capture: CaptureId.or(Handle),
    startsAt: Timestamp,
    endsAt: Timestamp,
    participants: z.array(Who),
  }),
  // Consecutive capture.anchor facts of one project and one item kind, as one
  // entry: `at` the run's last time, `first` its first, `count` how many.
  z.strictObject({
    kind: z.literal("anchor_run"),
    at: Timestamp,
    first: Timestamp,
    count: z.number().int().min(2),
    item: z.enum(["meeting", "moment"]),
  }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelineView = z.strictObject({ entries: z.array(TimelineEntry) });
export type TimelineView = z.infer<typeof TimelineView>;

// A reference document's window, sliced as get_document's, and the `{{name:kind}}` placeholders of its
// whole text, in order, at most 100.
const TemplatePlaceholder = z.strictObject({ ordinal: count, name: UntrustedString, kind: UntrustedString });

export const TemplateView = z.strictObject({
  document: DocumentSummary,
  text: UntrustedString.nullable(),
  offset: count,
  more: z.boolean(),
  placeholders: z.array(TemplatePlaceholder).max(100),
  masked: masked.optional(),
});
export type TemplateView = z.infer<typeof TemplateView>;
