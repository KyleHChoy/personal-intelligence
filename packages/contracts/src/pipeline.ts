import { z } from "zod";
import { BasisType, Claim, StatementKind } from "./claim.ts";
import { Mention, SourceKind } from "./evidence.ts";
import { Compartment, EvidenceId, ReviewId, Timestamp, TrustGroupId, Vault } from "./ids.ts";
import { Label } from "./label.ts";

export const ParsedSegment = z.object({
  span: z.string().min(1),
  // Quoted and forwarded text is credited to its original author.
  author: Mention.optional(),
  quoted: z.boolean(),
  text: z.string(),
});
export type ParsedSegment = z.infer<typeof ParsedSegment>;

export const ParsedItem = z.object({
  evidenceId: EvidenceId,
  revision: z.number().int().nonnegative(),
  sourceKind: SourceKind,
  // Bulk, no-reply, room and shared-inbox senders. Never people.
  automated: z.boolean(),
  segments: z.array(ParsedSegment),
  headers: z.record(z.string(), z.array(z.string())),
  // The earlier replies this message answers, nearest first, cut at the configured depth.
  // The extraction reads those and no other part of the thread.
  replyChainEvidenceIds: z.array(EvidenceId),
});
export type ParsedItem = z.infer<typeof ParsedItem>;

// Keys that would let model output carry a label, a reader or a destination. A key is reserved
// in any letter case, singular or plural, at any depth.
const reserved = new Set(["label", "reader", "compartment", "destination", "store", "grant", "clearance"]);

const isReserved = (key: string): boolean => {
  const word = key.toLowerCase();
  return reserved.has(word) || (word.endsWith("s") && reserved.has(word.slice(0, -1)));
};

const carriesReservedKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(carriesReservedKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, inner]) => isReserved(key) || carriesReservedKey(inner));
};

// A claim as the header reader or the interpreter proposes it. Code checks it, resolves its
// mentions and routes it: nothing here names a label or a store.
export const ClaimCandidate = z.strictObject({
  type: z.string().min(1),
  subject: Mention,
  fields: z
    .record(z.string(), z.unknown())
    .refine((fields) => !carriesReservedKey(fields), { message: "a reserved key" }),
  statementKind: StatementKind,
  basis: BasisType,
  assertedBy: Mention.optional(),
  validFrom: Timestamp.optional(),
  validTo: Timestamp.optional(),
  span: z.string().min(1),
  context: z
    .strictObject({ kind: z.enum(["project", "organization", "global"]), mention: Mention.optional() })
    .optional(),
});
export type ClaimCandidate = z.infer<typeof ClaimCandidate>;

// All a model may ask for. Code maps participants_only to shrinking the readers to the people
// on the item itself, special_category to adding the configured compartment, and quarantine to
// flagging the item. No value releases or widens.
export const NarrowingValue = z.enum(["none", "participants_only", "special_category", "quarantine"]);
export type NarrowingValue = z.infer<typeof NarrowingValue>;

// Exactly these two keys. Any other rejects the whole output.
export const InterpreterOutput = z.strictObject({
  claims: z.array(ClaimCandidate),
  narrowing: NarrowingValue,
});
export type InterpreterOutput = z.infer<typeof InterpreterOutput>;

// Why a proposed claim was stored and not routed. A code, never text.
export const UnmappedReason = z.enum([
  "unknown_type",
  "bad_fields",
  "bad_span",
  "bad_times",
  "ungrounded_mention",
  "author_unknown",
]);
export type UnmappedReason = z.infer<typeof UnmappedReason>;

// A claim that fits no ontology type, or failed a later check. Stored, not routed. One row of
// vault.unmapped_claims: ids and codes, and no wording.
export const UnmappedClaim = z.object({
  id: z.string().min(1),
  evidenceId: EvidenceId,
  // A known ontology type id, "other", or "invalid" for a proposed type that is not a plain id.
  // Never the model's own text. The pattern is the check on vault.unmapped_claims.proposed_type.
  proposedType: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  // The pattern is the check on vault.unmapped_claims.pipeline_version.
  pipelineVersion: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  label: Label,
  reason: UnmappedReason,
  // Set by the writer from the generation its app runs as, never read from evidence or model
  // output. The first generation is 0.
  extractorGeneration: z.number().int().nonnegative(),
  // A shadow row is one a reprocessing run wrote. Counts for an operator leave it out.
  shadow: z.boolean(),
});
export type UnmappedClaim = z.infer<typeof UnmappedClaim>;

// The checker's unmapped claims carry no extractor generation and no shadow mark. The writer is
// the one source of both: the generation its app runs as, and the mark from the commit's mode,
// as on an outbox message.
export const CheckResult = z.object({
  claims: z.array(Claim),
  unmapped: z.array(UnmappedClaim.omit({ shadow: true, extractorGeneration: true })),
  reviews: z.array(ReviewId),
});
export type CheckResult = z.infer<typeof CheckResult>;

const limit = z.number().int().positive();

export const PipelineConfig = z.strictObject({
  vault: Vault,
  // How many earlier replies an extraction reads.
  replyChainDepth: z.number().int().nonnegative(),
  specialCategoryCompartment: Compartment,
  gateway: TrustGroupId,
  // What the parser accepts and what is sent to the model. An item over any of these fails as
  // parse_failed, with no content. The bytes are untrusted, so each bounds work done on them.
  limits: z.strictObject({
    // The item's bytes as the connector handed them over, and the line ends in them.
    payloadBytes: limit,
    payloadLines: limit,
    // The plain text body, and the text taken from one attachment.
    bodyChars: limit,
    // An HTML body or document before it is turned into text, how deep its elements nest and
    // how many tags it holds.
    htmlChars: limit,
    htmlDepth: limit,
    htmlTags: limit,
    // One line of the plain text body, and the subject.
    lineChars: limit,
    attachments: limit,
    // One attachment that is read. Others are never opened.
    attachmentBytes: limit,
    // The pieces one item is cut into: subject, body segments and attachment texts.
    segments: limit,
    // The rendered interpreter prompt: the instructions, the message and the replies it answers.
    promptChars: limit,
  }),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;
