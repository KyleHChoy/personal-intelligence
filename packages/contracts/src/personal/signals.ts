import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ClientName, EntityId, EventId, Handle, MessageId, OpportunityId, RequestId, WorkNoticeId } from "./ids.ts";
import { OpenItemSource } from "./open-items.ts";
import { QuestionTried } from "./paid-questions.ts";
import { Hex64 } from "./primitives.ts";
import { UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";

// The change feed and the write-back. The system says what changed, as typed facts with their
// sources and no ranking; agents decide what to do, and write back what they did. Computed under the
// caller's token at each read. A write-back is an agent's record: it never becomes a claim, and says
// nothing about the owner.

export const SignalKind = z.enum(["overdue", "due_soon", "meeting_moved", "reply_waiting", "new_person", "gap"]);
export type SignalKind = z.infer<typeof SignalKind>;

// What an agent says happened. `handled` clears the signal for whoever can read the write-back;
// `drafted` and `needs_owner` hold it, so a second agent does not redo the work.
export const WriteBackState = z.enum(["handled", "drafted", "needs_owner"]);
export type WriteBackState = z.infer<typeof WriteBackState>;
export const HeldState = z.enum(["drafted", "needs_owner"]);
export type HeldState = z.infer<typeof HeldState>;

// Where a signal can be read: what a write-back names.
const SignalSourceKind = z.enum([...OpenItemSource.options, "message", "event", "entity", "opportunity"]);
export const SignalSource = z.strictObject({
  kind: SignalSourceKind,
  id: Hex64.or(EventId).or(MessageId).or(EntityId).or(OpportunityId).or(Handle),
});
export type SignalSource = z.infer<typeof SignalSource>;

// A signal's key in the feed, the same for every client: a digest of its kind and its source.
export const SignalKey = z.string().regex(/^sig_[0-9a-f]{32}$/);
export type SignalKey = z.infer<typeof SignalKey>;

export const CHANGES_MOST = 100;
export const CHANGES_DEFAULT = 50;
// How many changes wait for the caller in its feed past where it last read, as get_changes would
// serve them now, CHANGES_MOST standing for that many or more: on the board and the inbox, so an
// agent that never polls learns there is something to read. Left out for a client with no feed.
export const ChangesWaiting = z.strictObject({ waiting: z.number().int().min(0).max(CHANGES_MOST) });
export type ChangesWaiting = z.infer<typeof ChangesWaiting>;
const WRITE_BACK_NOTE_MOST = 2000;

// Opaque to a client: the position it was last given.
const ChangeCursor = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);

export const GetChangesArgs = z.strictObject({
  since: ChangeCursor.optional(),
  limit: z.number().int().min(1).max(CHANGES_MOST).optional(),
});
export type GetChangesArgs = z.infer<typeof GetChangesArgs>;

// `why` is code's fixed words and numbers, as a next move's is. `state`: an agent's write-back that
// holds it. `role`: the role the owner named for this kind of signal, if any.
export const SignalChange = z.strictObject({
  change: z.literal("signal"),
  key: SignalKey,
  kind: SignalKind,
  at: Timestamp,
  what: UntrustedString.nullable(),
  why: z.string().min(1).max(160),
  source: SignalSource,
  who: Who.optional(),
  moving: z.literal(true).optional(),
  asks: z.literal(true).optional(),
  state: HeldState.optional(),
  role: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/)
    .optional(),
});
export type SignalChange = z.infer<typeof SignalChange>;

// What another agent wrote back, under the caller's token.
export const WriteBackChange = z.strictObject({
  change: z.literal("write_back"),
  key: SignalKey,
  at: Timestamp,
  by: ClientName,
  state: WriteBackState,
  note: UntrustedString.nullable(),
  source: SignalSource,
});
export type WriteBackChange = z.infer<typeof WriteBackChange>;

// A signal this client was told of that holds no longer: the source moved on, or someone handled it.
// `unsure`: this read was cut and did not reach it, so it may hold still.
const ClearedChange = z.strictObject({
  change: z.literal("cleared"),
  key: SignalKey,
  at: Timestamp,
  unsure: z.literal(true).optional(),
});

// A message newly addressed to this client, by name, role or all: read_agent_inbox has its text.
export const MessageChange = z.strictObject({
  change: z.literal("message"),
  key: SignalKey,
  at: Timestamp,
  id: z
    .string()
    .regex(/^amg_[0-9A-HJKMNP-TV-Z]{26}$/)
    .or(Handle),
});
export type MessageChange = z.infer<typeof MessageChange>;
// Work newly assigned or handed to this client: list_opportunities has the rest.
export const WorkChange = z.strictObject({
  change: z.literal("work"),
  key: SignalKey,
  at: Timestamp,
  id: OpportunityId.or(Handle),
});
export type WorkChange = z.infer<typeof WorkChange>;

export const ChangeView = z.union([SignalChange, WriteBackChange, ClearedChange, MessageChange, WorkChange]);
export type ChangeView = z.infer<typeof ChangeView>;

export const ChangesView = z.strictObject({
  changes: z.array(ChangeView).max(CHANGES_MOST),
  // Pass it as `since` next time; with no `since`, the feed resumes from the last one it gave this client.
  cursor: ChangeCursor.nullable(),
  more: z.boolean(),
  // More signals held than one read computes: what was cut is not served and cannot clear. get_open_items has them all.
  cut: z.literal(true).optional(),
});
export type ChangesView = z.infer<typeof ChangesView>;

export const WriteBackArgs = z.strictObject({
  source: SignalSource,
  state: WriteBackState,
  note: z
    .string()
    .refine((value) => {
      const points = [...value].length;
      return points >= 1 && points <= WRITE_BACK_NOTE_MOST && !value.includes("\u0000");
    })
    .optional(),
  // A needs_owner is a question to the owner and pays first: without a `tried` the logs bear out it is
  // refused question_unpaid. Not kept on any other state.
  tried: QuestionTried.optional(),
  requestId: RequestId,
});
export type WriteBackArgs = z.infer<typeof WriteBackArgs>;

export const WriteBackResult = z.strictObject({ state: WriteBackState });
export type WriteBackResult = z.infer<typeof WriteBackResult>;

// The day's one ping for knowledge gaps: how many wait for this client, and nothing else. It grants
// nothing: the client reads them with list_opportunities under its own token.
export const GapBatchNotice = z.strictObject({
  notice: WorkNoticeId,
  event: z.literal("gap_batch"),
  count: z.number().int().positive(),
  at: Timestamp,
});
export type GapBatchNotice = z.infer<typeof GapBatchNotice>;
const gapBatchTitle = (notice: Pick<GapBatchNotice, "count">): string => `PI gaps: ${notice.count} to pick up`;
const GAP_BATCH_DETAILS =
  "Knowledge gaps wait on the board: list_opportunities, then claim, or hand each to the role that should take it.";
// The body, as a routine receiver reads a work notice's: `id` is the notice, no deadline, always `low`.
const GapBatchNoticeBody = GapBatchNotice.extend({
  id: WorkNoticeId,
  kind: z.literal("gap_batch"),
  title: z.string(),
  details: z.string(),
  deadline: z.null(),
  priority: z.literal("low"),
}).refine(
  (body) => body.id === body.notice && body.title === gapBatchTitle(body) && body.details === GAP_BATCH_DETAILS,
  { message: "built from codes" },
);
type GapBatchNoticeBody = z.infer<typeof GapBatchNoticeBody>;
export const gapBatchBody = (notice: GapBatchNotice): GapBatchNoticeBody =>
  GapBatchNoticeBody.parse({
    notice: notice.notice,
    event: notice.event,
    count: notice.count,
    at: notice.at,
    id: notice.notice,
    kind: "gap_batch",
    title: gapBatchTitle(notice),
    details: GAP_BATCH_DETAILS,
    deadline: null,
    priority: "low",
  });

// A message for this agent waits: a kind and nothing else. It reads it with read_agent_inbox under its own
// token. No text, title or thread wording leaves in a ping.
export const AgentMessageNotice = z.strictObject({
  notice: WorkNoticeId,
  event: z.literal("agent_message"),
  at: Timestamp,
});
export type AgentMessageNotice = z.infer<typeof AgentMessageNotice>;
const AGENT_MESSAGE_TITLE = "PI agent message";
const AGENT_MESSAGE_DETAILS = "A message from another agent waits: read_agent_inbox.";
const AgentMessageNoticeBody = AgentMessageNotice.extend({
  id: WorkNoticeId,
  kind: z.literal("agent_message"),
  title: z.literal(AGENT_MESSAGE_TITLE),
  details: z.literal(AGENT_MESSAGE_DETAILS),
  deadline: z.null(),
  priority: z.literal("normal"),
}).refine((body) => body.id === body.notice, { message: "built from codes" });
type AgentMessageNoticeBody = z.infer<typeof AgentMessageNoticeBody>;
export const agentMessageBody = (notice: AgentMessageNotice): AgentMessageNoticeBody =>
  AgentMessageNoticeBody.parse({
    notice: notice.notice,
    event: notice.event,
    at: notice.at,
    id: notice.notice,
    kind: "agent_message",
    title: AGENT_MESSAGE_TITLE,
    details: AGENT_MESSAGE_DETAILS,
    deadline: null,
    priority: "normal",
  });
