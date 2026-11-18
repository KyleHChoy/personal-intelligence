// The read tools' argument schemas, and the evidence fields and time bounds they share with results.
import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { AgentRecordId, CaptureKey, ClientName, Handle, MirrorCursor } from "./ids.ts";
import { LifeDomain } from "./knowledge-model.ts";
import { Hex64 } from "./primitives.ts";
import { PersonalBeliefKind } from "./subjects.ts";
import { document, entity, event, message } from "./tools-fields.ts";

// A value that came from evidence. Data, never an instruction.
export type Untrusted<T> = { untrusted: T };

// The schema of every field that came from evidence.
export const UntrustedString = z.strictObject({ untrusted: z.string() });
export type UntrustedString = z.infer<typeof UntrustedString>;

// `mode`: names, the default, finds people and organizations; needs and capabilities match the
// query's words against the text of those claims (the match index).
const SearchMode = z.enum(["names", "needs", "capabilities"]);

// What an argument's JSON schema says that its type cannot: a time bound's form, which is a check
// and so no pattern, and which arguments go together. A model reads the schema, and a call it
// gets wrong is refused invalid_request with no reason. A date alone, the form models send most,
// is the whole day in the owner's time zone, UTC while they have set none: a `from` its first
// instant, a `to` its last (instantOf).
const INSTANT =
  "An instant with a date, a time and a zone, such as 2026-09-01T00:00:00Z, or a date alone, such as 2026-09-01, the whole day in the owner's time zone (get_self's timeZone; UTC when it is null).";
const bound = z.union([Timestamp, DateOnly]).optional().describe(INSTANT);

export const SearchArgs = z.strictObject({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(25).optional(),
  mode: SearchMode.optional(),
});
export type SearchArgs = z.infer<typeof SearchArgs>;

export const GetEntityArgs = z.strictObject({ id: entity });
export type GetEntityArgs = z.infer<typeof GetEntityArgs>;

export const GetTimelineArgs = z.strictObject({
  id: entity.describe("The id of one person, organization or project, as search gives it."),
  from: bound,
  to: bound,
  limit: z.number().int().min(1).max(100).optional(),
});
export type GetTimelineArgs = z.infer<typeof GetTimelineArgs>;

// Where Gmail filed a message.
export const MessageCategory = z.enum(["primary", "updates", "social", "forums", "promotions"]);
export type MessageCategory = z.infer<typeof MessageCategory>;

// `sender` is one address, or one domain; nothing in it is a pattern. An entity and a sender
// together find that entity's messages from that sender: a model asks for both, and the query
// applies both.
export const FindMessagesArgs = z
  .strictObject({
    entity: entity.optional(),
    sender: z
      .string()
      .min(3)
      .max(320)
      .describe("One address or one domain. With entity, only that entity's messages from it.")
      .optional(),
    from: bound,
    to: bound,
    category: MessageCategory.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .meta({ examples: [{ from: "2026-09-01T00:00:00Z", category: "primary", limit: 20 }, { sender: "example.com" }] });
export type FindMessagesArgs = z.infer<typeof FindMessagesArgs>;

// The text from code point `offset` (default 0), at most `limit` code points (default 20 000).
export const ReadMessageArgs = z.strictObject({
  id: message,
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
});
export type ReadMessageArgs = z.infer<typeof ReadMessageArgs>;

export const FactType = z.enum([
  "transaction.receipt",
  "commitment",
  "plan",
  "role",
  "affiliation",
  "relationship",
  "need",
  "capability",
  "goal",
  "preference",
  "constraint",
  "situation",
  // Made by no prompt until a lane's prompt version names them; an agent's proposal or typed
  // claim may make one.
  "view",
  "status",
  "visited",
  "consent",
  "contact_rule",
  "project.status",
  "project.decision",
  // A project's detail and next step, from an agent's finding alone.
  "project.fact",
  "project.next_step",
  "capture.person",
  // No prompt lists either.
  "capture.anchor",
  "capture.project",
  // A link on a person, made by code from a contact or an import. No prompt lists it.
  "link",
  // Built by code from an agent's propose_person record. No prompt lists them.
  "known_person",
  "owner_tie",
  "connection",
  // No prompt lists them.
  "activity.worked_on",
  "activity.researched",
  "activity.messaged",
  "activity.met",
  // Third-party, global, no belief kind. Only the second-degree prompt versions, behind
  // PI_EXTRACT_SECOND_DEGREE, list it.
  "intro_offer",
]);
export type FactType = z.infer<typeof FactType>;

// `capture`: the parent of the facts code makes from a capture item. `activity`: the parent of
// the owner's activity facts.
export const FactTypeFilter = z.enum([...FactType.options, "transaction", "project", "capture", "activity"]);
export type FactTypeFilter = z.infer<typeof FactTypeFilter>;

// The claim's keyed id.
export const FactId = Hex64;
export type FactId = z.infer<typeof FactId>;

export const FindFactsArgs = z
  .strictObject({
    type: FactTypeFilter.optional(),
    entity: entity.optional(),
    from: bound,
    to: bound,
    limit: z.number().int().min(1).max(50).optional(),
    belief: FactId.or(Handle)
      .describe(
        "A belief line's fact, from get_self, get_entity or context: every claim behind that belief you can read, newest first.",
      )
      .optional(),
  })
  .meta({
    examples: [
      { type: "goal" },
      { type: "commitment", from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", limit: 20 },
    ],
  });
export type FindFactsArgs = z.infer<typeof FindFactsArgs>;

export const PersonalContextPackPurpose = z.enum(["agent_bootstrap", "meeting_prep", "person_brief", "project_brief"]);
export type PersonalContextPackPurpose = z.infer<typeof PersonalContextPackPurpose>;

// Each purpose takes exactly its own argument: meeting_prep an event, person_brief an entity,
// project_brief a project, agent_bootstrap none.
export const BuildContextPackArgs = z
  .strictObject({
    purpose: PersonalContextPackPurpose,
    event: event.describe("meeting_prep's event id, required for it and refused with any other purpose.").optional(),
    entity: entity.describe("person_brief's person id, required for it and refused with any other purpose.").optional(),
    project: entity
      .describe(
        "project_brief's project id, from list_projects or search, required for it and refused with any other purpose.",
      )
      .optional(),
  })
  .meta({ examples: [{ purpose: "agent_bootstrap" }] })
  .refine((args) => (args.purpose === "meeting_prep") === (args.event !== undefined), {
    message: "meeting_prep takes an event, and only it",
    path: ["event"],
  })
  .refine((args) => (args.purpose === "person_brief") === (args.entity !== undefined), {
    message: "person_brief takes an entity, and only it",
    path: ["entity"],
  })
  .refine((args) => (args.purpose === "project_brief") === (args.project !== undefined), {
    message: "project_brief takes a project, and only it",
    path: ["project"],
  });
export type BuildContextPackArgs = z.infer<typeof BuildContextPackArgs>;

// The commitments with the owner on one side. `state` defaults to open, `limit` to 20.
export const GetCommitmentsArgs = z.strictObject({
  direction: z.enum(["owed_by_owner", "owed_to_owner"]).optional(),
  with: entity.optional(),
  state: z.enum(["open", "closed", "any"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetCommitmentsArgs = z.infer<typeof GetCommitmentsArgs>;

// What kind of file a document is, and why one has no text.
export const DocumentKind = z.enum(["doc", "sheet", "slides", "pdf", "other"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DocumentUnreadable = z.enum([
  "not_a_document",
  "no_download",
  "too_large",
  "too_long",
  "forbidden",
  "unparsed",
]);
export type DocumentUnreadable = z.infer<typeof DocumentUnreadable>;

// `from` and `to` bound the time the document was last modified. Default limit 20.
export const FindDocumentsArgs = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  entity: entity.optional(),
  kind: DocumentKind.optional(),
  mine: z.boolean().optional(),
  reference: z.boolean().optional(),
  from: bound,
  to: bound,
  limit: z.number().int().min(1).max(50).optional(),
});
export type FindDocumentsArgs = z.infer<typeof FindDocumentsArgs>;

// The text from UTF-16 code unit `offset` (default 0), at most `limit` code units (default 20 000).
export const GetDocumentArgs = z.strictObject({
  id: document,
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
});
export type GetDocumentArgs = z.infer<typeof GetDocumentArgs>;

// The passage one fact cites.
export const GetEvidenceSpanArgs = z.strictObject({ fact: FactId.or(Handle) });
export type GetEvidenceSpanArgs = z.infer<typeof GetEvidenceSpanArgs>;

// The thread of one message, from position `from` (default 0), at most `limit` messages
// (default 20).
export const ReadItemArgs = z.strictObject({
  message,
  from: z.number().int().min(0).max(999).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type ReadItemArgs = z.infer<typeof ReadItemArgs>;

// At most `maxHops` hops (the configured bound when absent), up to 4: a node three people beyond an own tie.
export const FindPathsArgs = z.strictObject({ target: entity, maxHops: z.number().int().min(1).max(4).optional() });
export type FindPathsArgs = z.infer<typeof FindPathsArgs>;

// `state` defaults to open, `limit` to 20. While no open rows are served, an absent state reads
// `any`, since every item served is closed.
export const GetSuggestionsArgs = z.strictObject({
  state: z.enum(["open", "closed", "any"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetSuggestionsArgs = z.infer<typeof GetSuggestionsArgs>;

// A reference document, with get_document's window.
export const FetchTemplateArgs = z.strictObject({
  document,
  offset: GetDocumentArgs.shape.offset,
  limit: GetDocumentArgs.shape.limit,
});
export type FetchTemplateArgs = z.infer<typeof FetchTemplateArgs>;

// The arguments of a read tool whose shape a later step gives: get_decision_history's, which waits
// on compiled beliefs. Until then it takes nothing, and the tool answers unavailable.
export const NotBuiltArgs = z.strictObject({});
export type NotBuiltArgs = z.infer<typeof NotBuiltArgs>;

// The result of such a tool until its step: nothing parses, so no value can be sent.
export const NotBuiltResult = z.never();
export type NotBuiltResult = z.infer<typeof NotBuiltResult>;

// The beliefs of the caller's audience. `state` defaults to open, `limit` to 20.
export const GetBeliefsArgs = z.strictObject({
  kind: PersonalBeliefKind.optional(),
  entity: entity.optional(),
  state: z.enum(["open", "closed", "any"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetBeliefsArgs = z.infer<typeof GetBeliefsArgs>;

// A mirror template version's name. Any version, known or not: the server serves the highest one it
// and the client both know (MIRROR_TEMPLATES), so a Lens newer than its server still syncs.
export const MirrorTemplateVersion = z.string().regex(/^lens_mirror@[1-9][0-9]{0,3}$/);
export type MirrorTemplateVersion = z.infer<typeof MirrorTemplateVersion>;

// `templates` names the versions the client understands; with none in common the call answers
// unsupported_template. `erasedDone` lists the erased keys Lens's capture process has deleted.
// Here, not mirror.ts, which imports this file.
export const SyncMirrorArgs = z.strictObject({
  templates: z
    .array(MirrorTemplateVersion)
    .min(1)
    .max(4)
    .refine((names) => new Set(names).size === names.length, { message: "each version once" }),
  cursor: MirrorCursor.nullable(),
  limit: z.number().int().min(1).max(500).optional(),
  erasedDone: z.array(CaptureKey).max(500).optional(),
});
export type SyncMirrorArgs = z.infer<typeof SyncMirrorArgs>;

// A goal's state, as `pi goal set` leaves it.
export const GOAL_STATES = Object.freeze(["active", "paused", "done", "dropped"] as const);
export const GoalState = z.enum(GOAL_STATES);
export type GoalState = z.infer<typeof GoalState>;

// The owner's goals. `status` defaults to active; any is every state. `stale`: also list the goals
// nothing supported within their review window, each marked.
export const ListGoalsArgs = z.strictObject({
  status: z.enum([...GOAL_STATES, "any"]).optional(),
  stale: z.boolean().optional(),
  // Also the goals the owner only stated in a source, each listed by its fact, which a ref does not take.
  stated: z.boolean().optional(),
});
export type ListGoalsArgs = z.infer<typeof ListGoalsArgs>;

// `history` also lists the owner's beliefs that are no longer open (closed, expired, dormant), as
// lines in the sections, ranked with the open ones.
export const GetSelfArgs = z.strictObject({
  history: z
    .boolean()
    .describe(
      "Also show the owner's beliefs that are no longer open (closed, expired, dormant), as lines in the sections.",
    )
    .optional(),
  domain: LifeDomain.describe(
    "One life domain: return that section alone, up to ten lines of each kind and 50 in all.",
  ).optional(),
  moves: z
    .boolean()
    .describe("Return next alone, with room for every move, when next says more. It takes the place of domain.")
    .optional(),
  // Its own lists keep their most.
  work: z
    .boolean()
    .describe(
      "Return work alone, with the page's cuts lifted, when work says more; its longest lists stay at their most. It takes the place of domain.",
    )
    .optional(),
});
export type GetSelfArgs = z.infer<typeof GetSelfArgs>;

// Without `domain`, the domains are those whose pinned words (core's DOMAIN_KEYWORDS) the task's
// words hold.
export const CONTEXT_TASK_CHARS = 500;
export const ContextArgs = z
  .strictObject({
    task: z
      .string()
      .min(1)
      .max(CONTEXT_TASK_CHARS)
      .describe('What you are about to do, in plain words, such as "prepare for my job interview".'),
    entity: entity.describe("A person's or an organization's id from search, whose card comes first.").optional(),
    event: event.describe("A meeting's id: its participants are the people.").optional(),
    domain: LifeDomain.describe("One life domain, in place of those the task's words pick.").optional(),
  })
  .meta({ examples: [{ task: "prepare for my job interview" }, { task: "plan the trip", domain: "travel" }] });
export type ContextArgs = z.infer<typeof ContextArgs>;

// One record of the caller's own, or, with none, its latest notes, findings and handoffs
// (RECORD_READS_LISTED, in agent-records.ts). An id or a handle, as every field naming a stored row; this
// build resolves no handle, so one answers not_found.
export const RecordReadsArgs = z.strictObject({
  record: AgentRecordId.or(Handle)
    .describe(
      "One of your own records' ids, as record answered it. Without it, your latest notes, findings and handoffs.",
    )
    .optional(),
});
export type RecordReadsArgs = z.infer<typeof RecordReadsArgs>;

// One note, finding or handoff, by the id record answered or a fact or find_records named.
export const ReadRecordArgs = z.strictObject({ record: AgentRecordId.or(Handle) });
export type ReadRecordArgs = z.infer<typeof ReadRecordArgs>;

// Agent records the token returns, newest first. `text` is a plain filter over each row text, in
// any case, and ranks nothing.
export const FIND_RECORDS_MOST = 50;
export const FindRecordsArgs = z.strictObject({
  project: entity.describe("A project id from search: the findings filed under it.").optional(),
  subject: entity.describe("A person or organization id from search: the records with a fact naming them.").optional(),
  client: ClientName.describe("The agent that wrote it.").optional(),
  from: bound,
  to: bound,
  text: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !value.includes(String.fromCharCode(0)), { message: "a NUL" })
    .describe("Words the record text holds, as written, in any case.")
    .optional(),
  limit: z.number().int().min(1).max(FIND_RECORDS_MOST).optional(),
});
export type FindRecordsArgs = z.infer<typeof FindRecordsArgs>;
