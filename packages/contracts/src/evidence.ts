import { z } from "zod";
import { EvidenceId, KeyRef, MemberId, Sha256, SourceAccountId, Timestamp, Vault } from "./ids.ts";
import { SignedLabel } from "./label.ts";

export const SourceKind = z.enum([
  "email",
  "calendar",
  "chat",
  "crm",
  "transcript",
  "document",
  "filing",
  "public_data",
  "web_research",
  "research_note",
  "workbench_correction",
]);
export type SourceKind = z.infer<typeof SourceKind>;

// Set by compliance for each source account, never by a model.
const ComplianceTags = z.object({
  lawfulBasis: z.string().min(1),
  purpose: z.string().min(1),
  jurisdiction: z.string().min(1),
  obligations: z.array(z.enum(["nda", "board", "mnpi", "privileged"])),
});
type ComplianceTags = z.infer<typeof ComplianceTags>;

// Marking for documents that are authoritative as documents (the document lane).
export const ReferenceKind = z.enum(["policy", "procedure", "template", "register"]);
export type ReferenceKind = z.infer<typeof ReferenceKind>;

export const MentionKeyKind = z.enum(["address", "source_id", "name"]);
export type MentionKeyKind = z.infer<typeof MentionKeyKind>;

// One way an item names a person or organization. A name alone never creates a person.
export const Mention = z.strictObject({
  key: z.strictObject({ kind: MentionKeyKind, value: z.string().min(1) }),
  observedAt: Timestamp,
});
export type Mention = z.infer<typeof Mention>;

// A link a member is shown, so it must read the way it resolves. At most this long. "https",
// exactly two slashes, then a host with no user part, not even an empty one. No white space,
// backslash, control character or format character anywhere: a zero-width space or a
// right-to-left override would show one address and open another.
const httpsLink = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s\\\p{C}/?#@]+(?:[/?#][^\s\\\p{C}]*)?$/u)
  .refine((link) => URL.canParse(link) && new URL(link).hostname !== "", { message: "not a plain https link" });

// No control character and no format character: a line break, a null, a zero-width space or a
// right-to-left override has no place in an identifier.
const NO_HIDDEN = /^\P{C}+$/u;

// What the source system says about a reference document: its standing there, never what the
// document says of itself. The connector reports it, and it is carried unchanged onto the
// evidence item. An item with none is a draft that is not enforced.
export const ReferenceFacts = z
  .strictObject({
    status: z.enum(["approved", "draft"]),
    effectiveFrom: Timestamp.optional(),
    // An enforced policy also goes through the interpreter.
    enforced: z.boolean(),
    // The source item id of the version this one supersedes.
    // A message id can be long, so the bound is wide.
    replaces: z.string().max(1024).regex(NO_HIDDEN).optional(),
    sourceLink: httpsLink,
    // The document's owner as the source system states it: the identifier of a mention. It is
    // the subject of the document-revised claim, and with none no such claim is made.
    // An address can reach 254 characters, so the bound is 320.
    owner: Mention.shape.key
      .refine((key) => key.value.length <= 320 && NO_HIDDEN.test(key.value), {
        message: "not an identifier",
        path: ["value"],
      })
      .optional(),
  })
  .refine((facts) => !facts.enforced || facts.status === "approved", {
    message: "a draft is not enforced",
    path: ["enforced"],
  });
export type ReferenceFacts = z.infer<typeof ReferenceFacts>;

const PayloadState = z.enum(["present", "expired", "erased"]);
type PayloadState = z.infer<typeof PayloadState>;

// Whether a change may wake the scheduler. Only "live" does.
export const ChangeKind = z.enum(["live", "backfill", "reprocess"]);
export type ChangeKind = z.infer<typeof ChangeKind>;

// What a source said, kept unchanged and treated as untrusted data.
export const EvidenceItem = z.object({
  id: EvidenceId,
  vault: Vault,
  sourceKind: SourceKind,
  sourceAccount: SourceAccountId,
  // Revisions are appended; an edit at the source creates a new revision.
  revision: z.number().int().nonnegative(),
  supersedes: EvidenceId.optional(),
  // Taken before encryption.
  contentHash: Sha256,
  // The format of the payload bytes, as the connector reported it.
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  // When the thing happened or was true at the source.
  observedAt: Timestamp,
  // When the system stored it.
  ingestedAt: Timestamp,
  label: SignedLabel,
  // Reference to this item's data key in the keyring.
  keyRef: KeyRef,
  compliance: ComplianceTags,
  referenceKind: ReferenceKind.optional(),
  // The raw item's reference facts, unchanged. Optional: an item with none is a draft that
  // is not enforced.
  reference: ReferenceFacts.optional(),
  // True for messages the system itself produced, so they cannot confirm their own premise.
  systemOriginated: z.boolean(),
  payloadState: PayloadState,
  // The change kind of the raw item it was stored from, which the pipeline stamps on its
  // claims. Optional: an item with none is read as backfill, which never wakes the scheduler.
  changeKind: ChangeKind.optional(),
  // The members among a message's participants, by id, recorded by ingest when it writes the
  // item. The pipeline's participants_only narrowing and an interaction record's member fields
  // read it, so the pipeline asks the directory nothing. Never the all-members group.
  participantMembers: z.array(MemberId).max(1000).optional(),
  // The member who sent a message. Recorded only where the source marks the sender and the
  // sender's address is a member's. The interaction record's sent side reads it.
  senderMember: MemberId.optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

// An exact place inside an evidence item.
export const Passage = z.strictObject({
  evidenceId: EvidenceId,
  // Source-specific: a character range, a transcript time range, a cell reference.
  span: z.string().min(1),
});
export type Passage = z.infer<typeof Passage>;
