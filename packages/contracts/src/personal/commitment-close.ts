import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { AgentRecordId, CaptureId, DocumentId, Handle, MessageId, PersonalEvidenceId, RequestId } from "./ids.ts";
import { Hex64, parseJsonBody } from "./primitives.ts";

// An agent closes a commitment it can see, at once, as its own word, citing items it read whole.
// Nothing here lets a client name a label, a compartment, an origin, a tier, a time or a writer:
// the provider sets each, and the strict arguments refuse a call that carries one.

// How a commitment ended: kept, called off, or the counterparty let the owner off (`released`).
export const CommitmentEnding = z.enum(["done", "cancelled", "released"]);
export type CommitmentEnding = z.infer<typeof CommitmentEnding>;

// The evidence an agent may cite: an item it read whole by id (read_message, get_document,
// read_item). Never a thread, which the read log does not record, and never an agent record,
// which no `bound` entry ever names.
const CLOSE_EVIDENCE_MAX = 10;
const CLOSE_NOTE_MAX = 280;
const codePoints = (text: string): number => [...text].length;

// `commitment` is the `fact` that get_commitments (or find_facts, or a pack) served.
export const CloseCommitmentArgs = z.strictObject({
  commitment: Hex64.or(Handle),
  ending: CommitmentEnding,
  evidence: z
    .array(z.union([MessageId, DocumentId, CaptureId, Handle]))
    .min(1)
    .max(CLOSE_EVIDENCE_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: "an item named twice" }),
  note: z
    .string()
    .refine((note) => codePoints(note) >= 1 && codePoints(note) <= CLOSE_NOTE_MAX, {
      message: `1 to ${CLOSE_NOTE_MAX} code points`,
    })
    .refine((note) => !note.includes("\u0000"), { message: "a NUL" })
    .optional(),
  requestId: RequestId,
});
export type CloseCommitmentArgs = z.infer<typeof CloseCommitmentArgs>;

// The close's id is its agent record's. It takes effect at the next build, within seconds.
export const CloseCommitmentAck = z.strictObject({
  close: AgentRecordId.or(Handle),
  effective: z.literal("next_build"),
});
export type CloseCommitmentAck = z.infer<typeof CloseCommitmentAck>;

// An agent reopens a close of its own, by the close's id.
export const ReopenCommitmentArgs = z.strictObject({ close: AgentRecordId.or(Handle) });
export type ReopenCommitmentArgs = z.infer<typeof ReopenCommitmentArgs>;
export const ReopenCommitmentAck = z.strictObject({
  close: AgentRecordId.or(Handle),
  effective: z.literal("next_build"),
});
export type ReopenCommitmentAck = z.infer<typeof ReopenCommitmentAck>;

// A close record's stored body, written by the provider, never by the client: the commitment's
// fact key fingerprint, the ending, the cited items by their ids and their evidence ids, the time
// of the newest related item (which the close claim is dated by), and the note. The one
// parser of a body, for intake and the pipeline; null for anything else.
export const CloseBody = z.strictObject({
  commitment: Hex64,
  ending: CommitmentEnding,
  evidence: z
    .array(z.union([MessageId, DocumentId, CaptureId]))
    .min(1)
    .max(CLOSE_EVIDENCE_MAX),
  evidenceIds: z.array(PersonalEvidenceId).min(1).max(CLOSE_EVIDENCE_MAX),
  relatedAt: Timestamp,
  note: z.string().optional(),
});
export type CloseBody = z.infer<typeof CloseBody>;
export const parseCloseBody = (body: string): CloseBody | null => parseJsonBody(CloseBody, body);
