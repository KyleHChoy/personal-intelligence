import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { GetHealthArgs, HealthView, MarkHealthSeenArgs, MarkHealthSeenResult } from "./health.ts";
import { ClientName, Handle, RequestId, ULID_PATTERN } from "./ids.ts";
import { FileLearningArgs, FileLearningResult } from "./learnings.ts";
import { ListLeversArgs, ListLeversResult, SetLeverArgs, SetLeverResult } from "./levers.ts";
import { ChangesWaiting } from "./signals.ts";
import type { PersonalWorkTool } from "./tools.ts";
import { UntrustedString } from "./tools-args.ts";

// Agents write to each other through the system, and any agent files what it finds
// wrong with the system itself where a self-improvement routine triages it. Nothing here names a
// label, a compartment, a sender or a session: the database sets each from the caller's
// registration, as it does for every work row. Every text is an agent's, sealed under the
// writer's clearance, and served back inside { untrusted }.

const codePoints = (text: string): number => [...text].length;
const text = (most: number) =>
  z
    .string()
    .refine((value) => codePoints(value.trim()) >= 1 && codePoints(value) <= most, {
      message: `1 to ${most} code points`,
    })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });

const AgentMessageId = z
  .string()
  .regex(new RegExp(`^amg_${ULID_PATTERN}$`))
  .brand<"AgentMessageId">();
export const ImprovementId = z
  .string()
  .regex(new RegExp(`^imp_${ULID_PATTERN}$`))
  .brand<"ImprovementId">();
export type ImprovementId = z.infer<typeof ImprovementId>;
// An id or a one-time handle, as every work tool takes and serves one.
const messageId = AgentMessageId.or(Handle);
const improvementId = ImprovementId.or(Handle);

const AGENT_SUBJECT_MOST = 200;
const AGENT_BODY_MOST = 8000;
const IMPROVEMENT_TITLE_MOST = 200;
const IMPROVEMENT_DETAIL_MOST = 8000;
const IMPROVEMENT_EVIDENCE_MOST = 4000;
const IMPROVEMENT_NOTE_MOST = 2000;
const AGENT_INBOX_MOST = 50;
const IMPROVEMENTS_LISTED = 50;

// Who a message is for: one agent by its registered name, every agent holding a role, or every
// agent. A reply goes to the thread's other side and names no recipient.
export const AgentRecipient = z.union([
  z.strictObject({ client: ClientName }),
  z.strictObject({ role: RoleName }),
  z.strictObject({ all: z.literal(true) }),
]);
export type AgentRecipient = z.infer<typeof AgentRecipient>;

// What a message is: a note to read, a question that wants an answer, an issue someone should act
// on, or an answer to a question.
const AgentMessageKind = z.enum(["note", "question", "issue", "answer"]);

export const PostAgentMessageArgs = z
  .strictObject({
    to: AgentRecipient.optional(),
    replyTo: messageId.optional(),
    kind: AgentMessageKind,
    subject: text(AGENT_SUBJECT_MOST).optional(),
    body: text(AGENT_BODY_MOST),
    requestId: RequestId,
  })
  .refine((args) => (args.to === undefined) !== (args.replyTo === undefined), {
    message: "exactly one of to and replyTo",
    path: ["to"],
  })
  .refine((args) => args.replyTo !== undefined || args.subject !== undefined, {
    message: "a new thread has a subject",
    path: ["subject"],
  })
  .refine((args) => args.replyTo === undefined || args.subject === undefined, {
    message: "a reply takes the thread's subject",
    path: ["subject"],
  });
export type PostAgentMessageArgs = z.infer<typeof PostAgentMessageArgs>;
export const PostAgentMessageResult = z.strictObject({ message: messageId, thread: messageId });
export type PostAgentMessageResult = z.infer<typeof PostAgentMessageResult>;

// unread (the default): messages to the caller it has not marked read; all: every message to it or
// from it, newest first; thread: one thread whole, oldest first. markRead (default true) marks
// what was served to the caller as read.
export const ReadAgentInboxArgs = z
  .strictObject({
    scope: z.enum(["unread", "all", "thread"]).optional(),
    thread: messageId.optional(),
    markRead: z.boolean().optional(),
    limit: z.number().int().min(1).max(AGENT_INBOX_MOST).optional(),
  })
  .refine((args) => (args.scope === "thread") === (args.thread !== undefined), {
    message: "thread with scope thread, and only then",
    path: ["thread"],
  });
export type ReadAgentInboxArgs = z.infer<typeof ReadAgentInboxArgs>;

export const AgentMessageView = z.strictObject({
  id: messageId,
  thread: messageId,
  replyTo: messageId.nullable(),
  from: ClientName,
  to: AgentRecipient,
  kind: AgentMessageKind,
  // A thread's subject, on every message of it; null when it does not open with this call's keys.
  subject: UntrustedString.nullable(),
  body: UntrustedString.nullable(),
  sentAt: Timestamp,
  mine: z.boolean(),
  read: z.boolean(),
});
export type AgentMessageView = z.infer<typeof AgentMessageView>;
// `changes`: how many changes wait in the caller's feed (get_changes), as on the board.
export const ReadAgentInboxResult = z.strictObject({
  messages: z.array(AgentMessageView).max(AGENT_INBOX_MOST),
  more: z.boolean(),
  changes: ChangesWaiting.optional(),
});
export type ReadAgentInboxResult = z.infer<typeof ReadAgentInboxResult>;

// The improvement store: what is wrong with, or could be better in, the system itself.
export const ImprovementKind = z.enum(["bug", "improvement"]);
export type ImprovementKind = z.infer<typeof ImprovementKind>;
export const ImprovementArea = z.enum([
  "mcp",
  "extraction",
  "knowledge",
  "work",
  "planner",
  "sources",
  "deploy",
  "docs",
  "other",
]);
export type ImprovementArea = z.infer<typeof ImprovementArea>;
export const ImprovementSeverity = z.enum(["low", "medium", "high", "critical"]);
export type ImprovementSeverity = z.infer<typeof ImprovementSeverity>;
export const ImprovementStatus = z.enum(["open", "triaged", "in_progress", "done", "wont_do", "duplicate"]);
export type ImprovementStatus = z.infer<typeof ImprovementStatus>;
// An improvement in one of these is open. Every rule that says "an open improvement" means this list.
export const OPEN_IMPROVEMENT_STATUSES = [
  "open",
  "triaged",
  "in_progress",
] as const satisfies readonly ImprovementStatus[];

// What an agent takes a defect with. `pr:<number>` and `commit:<hash>` are the agent's own claim:
// nothing checks either. `lever:<key>` names a lever the caller moved, checked against the lever's
// history. `ops:<code>` names an operation the system records; no code is open. `none:<code>`
// claims no fix and goes with `triaged`: the defect was looked at.
export const FIX_NONE_CODES = ["not_reproducible", "owners_to_change", "duplicate"] as const;
export type FixNoneCode = (typeof FIX_NONE_CODES)[number];
// The grammar, which ledger.update_improvement holds too, character for character.
export const FIX_REF_PATTERN = new RegExp(
  `^(pr:[1-9][0-9]{0,6}|commit:[0-9a-f]{7,40}|lever:[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31}){1,2}|ops:[a-z][a-z0-9_]{0,31}|none:(${FIX_NONE_CODES.join("|")}))$`,
);
export const FixRef = z.string().regex(FIX_REF_PATTERN);
export type FixRef = z.infer<typeof FixRef>;
const ImprovementCause = z.string().regex(/^[a-z0-9_:.-]{1,200}$/);
const ImprovementCauseState = z.string().regex(/^[a-z0-9_:.= -]{0,200}$/);

export const SubmitImprovementArgs = z.strictObject({
  kind: ImprovementKind,
  area: ImprovementArea,
  severity: ImprovementSeverity,
  title: text(IMPROVEMENT_TITLE_MOST),
  detail: text(IMPROVEMENT_DETAIL_MOST),
  evidence: text(IMPROVEMENT_EVIDENCE_MOST).optional(),
  requestId: RequestId,
});
export type SubmitImprovementArgs = z.infer<typeof SubmitImprovementArgs>;
// merged: an improvement the caller can see with the same title is still open, so this one was
// added to it as one more report, and its id is answered.
export const SubmitImprovementResult = z.strictObject({
  improvement: improvementId,
  merged: z.literal(true).optional(),
});
export type SubmitImprovementResult = z.infer<typeof SubmitImprovementResult>;

export const ListImprovementsArgs = z.strictObject({
  status: z.array(ImprovementStatus).min(1).max(6).optional(),
  area: ImprovementArea.optional(),
  improvement: improvementId.optional(),
  // Only the defects whose role the caller holds.
  mine: z.boolean().optional(),
  limit: z.number().int().min(1).max(IMPROVEMENTS_LISTED).optional(),
  // The `next` a page answered: the page after it, under the same filters.
  after: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
});
export type ListImprovementsArgs = z.infer<typeof ListImprovementsArgs>;

export const ImprovementEventView = z.strictObject({
  at: Timestamp,
  by: ClientName,
  event: z.enum(["reported", "status"]),
  status: ImprovementStatus.nullable(),
  // A later report's detail and evidence, or a status change's note.
  note: UntrustedString.nullable(),
  evidence: UntrustedString.nullable(),
});
export type ImprovementEventView = z.infer<typeof ImprovementEventView>;

export const ImprovementView = z.strictObject({
  id: improvementId,
  kind: ImprovementKind,
  area: ImprovementArea,
  severity: ImprovementSeverity,
  status: ImprovementStatus,
  title: UntrustedString.nullable(),
  detail: UntrustedString.nullable(),
  evidence: UntrustedString.nullable(),
  by: ClientName,
  reportedAt: Timestamp,
  updatedAt: Timestamp,
  reports: z.number().int().positive(),
  duplicateOf: improvementId.nullable(),
  // The role whose agents work it, or null for any agent's.
  assigneeRole: RoleName.nullable(),
  // A defect the system filed: the measure it was filed for and that measure's state, as codes.
  // It closes when the measure recovers, never by an agent's status.
  cause: ImprovementCause.nullable(),
  causeState: ImprovementCauseState.nullable(),
  // Who last set it in progress and when, while it stands so; a statement, not a lock.
  heldBy: ClientName.nullable(),
  heldAt: Timestamp.nullable(),
  // The latest fix an agent named for it.
  fixRef: FixRef.nullable(),
  // With `improvement` alone: every event the caller can see, oldest first.
  events: z.array(ImprovementEventView).max(200).optional(),
});
export type ImprovementView = z.infer<typeof ImprovementView>;
// `next`: with `more`, what `after` takes for the next page.
export const ListImprovementsResult = z.strictObject({
  improvements: z.array(ImprovementView).max(IMPROVEMENTS_LISTED),
  more: z.boolean(),
  next: z.string().optional(),
});
export type ListImprovementsResult = z.infer<typeof ListImprovementsResult>;

export const UpdateImprovementArgs = z
  .strictObject({
    improvement: improvementId,
    status: ImprovementStatus,
    note: text(IMPROVEMENT_NOTE_MOST).optional(),
    duplicateOf: improvementId.optional(),
    // Required with in_progress on a defect the system filed, and then not a `none:`.
    fixRef: FixRef.optional(),
    requestId: RequestId,
  })
  .refine((args) => (args.status === "duplicate") === (args.duplicateOf !== undefined), {
    message: "duplicateOf with status duplicate, and only then",
    path: ["duplicateOf"],
  })
  .refine((args) => args.duplicateOf === undefined || args.duplicateOf !== args.improvement, {
    message: "not a duplicate of itself",
    path: ["duplicateOf"],
  });
export type UpdateImprovementArgs = z.infer<typeof UpdateImprovementArgs>;
// `noteDropped`: the status was set and the note was not kept, since it could not be sealed under the defect's label.
export const UpdateImprovementResult = z.strictObject({
  improvement: improvementId,
  status: ImprovementStatus,
  noteDropped: z.literal(true).optional(),
});
export type UpdateImprovementResult = z.infer<typeof UpdateImprovementResult>;

export const AGENT_MAIL_ARGS = Object.freeze({
  post_agent_message: PostAgentMessageArgs,
  read_agent_inbox: ReadAgentInboxArgs,
  submit_improvement: SubmitImprovementArgs,
  list_improvements: ListImprovementsArgs,
  update_improvement: UpdateImprovementArgs,
  get_health: GetHealthArgs,
  mark_health_seen: MarkHealthSeenArgs,
  file_learning: FileLearningArgs,
  list_levers: ListLeversArgs,
  set_lever: SetLeverArgs,
} satisfies Partial<Record<PersonalWorkTool, z.ZodType>>);
// The work tools that are agents' mail: the rows above.
type AgentMailTool = keyof typeof AGENT_MAIL_ARGS;

export const AGENT_MAIL_RESULTS = Object.freeze({
  post_agent_message: PostAgentMessageResult,
  read_agent_inbox: ReadAgentInboxResult,
  submit_improvement: SubmitImprovementResult,
  list_improvements: ListImprovementsResult,
  update_improvement: UpdateImprovementResult,
  get_health: HealthView,
  mark_health_seen: MarkHealthSeenResult,
  file_learning: FileLearningResult,
  list_levers: ListLeversResult,
  set_lever: SetLeverResult,
} satisfies Record<AgentMailTool, z.ZodType>);

// A known issue: a defect of the tools or the sources that the defect role has taken
// (`in_progress`) or looked at and left standing (`triaged`), with code's words on what it is for.
// Its title is the filer's words, untrusted.
const KNOWN_ISSUE_AREAS = ["mcp", "sources"] as const satisfies readonly ImprovementArea[];
export const KnownIssueArea = z.enum(KNOWN_ISSUE_AREAS);
export type KnownIssueArea = z.infer<typeof KnownIssueArea>;
export const KnownIssueStatus = ImprovementStatus.extract(["triaged", "in_progress"]);
export type KnownIssueStatus = z.infer<typeof KnownIssueStatus>;
export const KNOWN_ISSUE_SAY =
  "A known problem with these tools or sources that the defect role is working on. Expect it, work around it, and read it with list_improvements before filing it again.";

// A `known_issue` pack item's own fields, beside those every pack item has (packs.ts): its id is the
// defect's.
export const KNOWN_ISSUE_ITEM = {
  kind: z.literal("known_issue"),
  id: ImprovementId.or(Handle),
  area: KnownIssueArea,
  status: KnownIssueStatus,
  severity: ImprovementSeverity,
  title: UntrustedString.nullable(),
  say: z.literal(KNOWN_ISSUE_SAY),
};
