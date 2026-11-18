import type {
  DocumentTriageRow,
  EmailDueItem,
  MessageTriageRow,
  MomentEntity,
  MomentItem,
  PipelineCode,
  TriageLane,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";

// extract_triage's default line, at or above which a message is a person's. The contracts pin it.
export const DEFAULT_LANE_LINE = 0.5;

// Triage: the item's message row, the owner's lane and the decide model's `human_written` answer, and nothing
// else. Lines 1 to 4 and 6 to 8 are rung 0's; line 5, the decide model's, applies only when an answer is
// given, at the run's lane line. Line 4, a known correspondent's mail that is not bulk is correspondence
// whatever the decide model's answer, since that is where relationships and life facts are read.
export function triage(
  row: MessageTriageRow,
  override?: TriageLane,
  humanWritten?: number,
  line: number = DEFAULT_LANE_LINE,
): { lane: TriageLane; code?: PipelineCode } {
  const { by: _by, ...triaged } = triageBy(row, override, humanWritten, line);
  return triaged;
}

// Which of triage's lines decided, for `pia extract item`: the owner's lane, no text, outbound, a
// known correspondent, the decide model's answer (either side of the line), no decide model answer for mail that is not
// bulk, or the category's route for bulk mail the decide model did not answer.
type TriageBy = "override" | "no_text" | "outbound" | "known_correspondent" | "jev" | "no_jev" | "routed";

export function triageBy(
  row: MessageTriageRow,
  override?: TriageLane,
  humanWritten?: number,
  line: number = DEFAULT_LANE_LINE,
): { lane: TriageLane; code?: PipelineCode; by: TriageBy } {
  if (override !== undefined) return { lane: override, by: "override" };
  if (row.unreadable || row.chars === 0) return { lane: "skip", code: "no_text", by: "no_text" };
  if (row.direction === "outbound") return { lane: "correspondence", by: "outbound" };
  if (row.knownCorrespondent === true && !row.bulk) return { lane: "correspondence", by: "known_correspondent" };
  if (humanWritten !== undefined && humanWritten >= line) return { lane: "correspondence", by: "jev" };
  if (humanWritten === undefined && !row.bulk) return { lane: "correspondence", by: "no_jev" };
  const by = humanWritten === undefined ? "routed" : "jev";
  if (row.category === "updates" || row.category === "primary") return { lane: "transaction", by };
  return { lane: "skip", code: "bulk", by };
}

// The due item as the check reads it, carrying triage's decision: `routed` when triage's own rule,
// with no owner's lane, gave it the transaction lane.
export const routedDue = (due: EmailDueItem, lane: TriageLane): EmailDueItem =>
  lane === "transaction" && due.lane === undefined ? { ...due, routed: "transaction" } : due;

// PI_EXTRACT_DOCUMENT_DAYS when unset.
export const DOCUMENT_DAYS = 90;

// A document's triage: its row, the owner's lane and the run's clock, and nothing a document says.
// A reference document is skipped before the owner's lane is read: it is never sent to a model, and
// the owner takes it out of the reference library by its root's mode.
export function triageDocument(
  row: DocumentTriageRow,
  override: TriageLane | undefined,
  now: Date,
  days: number = DOCUMENT_DAYS,
): { lane: TriageLane; code?: PipelineCode } {
  if (row.reference) return { lane: "skip", code: "reference" };
  if (override !== undefined) return { lane: override };
  if (row.unreadable || row.chars === 0 || row.kind !== "doc") return { lane: "skip", code: "no_text" };
  if (!row.mine && !row.editedByMe) return { lane: "skip", code: "not_owners" };
  if (Date.parse(row.modifiedAt) < now.getTime() - days * DAY_MS) return { lane: "skip", code: "old" };
  return { lane: "document" };
}

export const MEETING_MIN_CHARS = 500;

// A meeting's triage at rung 0: the owner's lane, then `too_short` for `meetingText` under
// MEETING_MIN_CHARS code points, then `meeting`. It reads the text's length and nothing a
// transcript says.
export function triageMeeting(
  text: string,
  override: TriageLane | undefined,
): { lane: TriageLane; code?: PipelineCode } {
  if (override !== undefined) return { lane: override };
  if ([...text].length < MEETING_MIN_CHARS) return { lane: "skip", code: "too_short" };
  return { lane: "meeting" };
}

export const MOMENT_MIN_CHARS = 200;
// A moment read from its source's database (`read: "db"`, a session of iMessage) holds only what
// was typed, no screen around it, so it is too short only under this: the shortest line of the
// moment set that states a fact alone ("need a bigger studio") is 20 code points, and its replies
// that state none alone ("yes!! see you then", "two, def") are shorter. A thread's due days are
// asked together, so a short session costs its words, not a call.
export const MOMENT_DB_MIN_CHARS = 20;

// A page moment is `reading`, never sent to a model. An agent app's moment is `agent_app`: one its
// rule marks, or a chat with any turn Lens marks an agent's, whatever its rule says. A `doc` moment
// whose URL names a Google Doc stored under a Drive root (the store's `storedDocument`, by the
// file's fingerprint) is `connected_source`, since that source is read whole. Any other moment that
// is no chat is `not_chat`, and a chat that carries no turns (`turns`: read `ax` with turns) is
// `no_turns`. These come before the owner's lane, which none of them follows. Then the owner's
// lane; text under MOMENT_MIN_CHARS code points (MOMENT_DB_MIN_CHARS for a moment read `db`) is
// `too_short`; anything else is `moment`. It reads the moment's kind, whether it has turns, its
// rule's agent-app mark, the store's answer and the text's length, and nothing the text says. The
// lane commits `reading` and `agent_app` whatever its switch.
export function triageMoment(
  moment: {
    entity: MomentEntity;
    agentApp: boolean;
    storedDocument: boolean;
    text: string;
    turns: boolean;
    agentTurn?: boolean;
    read?: MomentItem["read"];
  },
  override: TriageLane | undefined,
): { lane: TriageLane; code?: PipelineCode } {
  if (moment.entity === "page") return { lane: "skip", code: "reading" };
  if (moment.agentApp || moment.agentTurn === true) return { lane: "skip", code: "agent_app" };
  if (moment.entity === "doc" && moment.storedDocument) return { lane: "skip", code: "connected_source" };
  if (moment.entity !== "chat") return { lane: "skip", code: "not_chat" };
  if (!moment.turns) return { lane: "skip", code: "no_turns" };
  if (override !== undefined) return { lane: override };
  if ([...moment.text].length < (moment.read === "db" ? MOMENT_DB_MIN_CHARS : MOMENT_MIN_CHARS))
    return { lane: "skip", code: "too_short" };
  return { lane: "moment" };
}
