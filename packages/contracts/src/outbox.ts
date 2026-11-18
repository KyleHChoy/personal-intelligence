import { z } from "zod";
import { Claim } from "./claim.ts";
import { ReferenceKind, SourceKind } from "./evidence.ts";
import { EvidenceId, LocalEntityId, MemberId, Sha256, Store, Timestamp } from "./ids.ts";
import { ContentKeys } from "./keys.ts";
import { Label, SignedLabel } from "./label.ts";

// A reference document, routed whole instead of being broken into claims.
const DocumentRecord = z.object({
  evidenceId: EvidenceId,
  kind: ReferenceKind,
  title: z.string().min(1),
  status: z.enum(["approved", "draft"]),
  effectiveFrom: Timestamp.optional(),
  replaces: EvidenceId.optional(),
  sourceLink: z.string().min(1),
  sourceRevision: z.number().int().nonnegative(),
  owner: LocalEntityId.optional(),
  keys: ContentKeys,
  label: Label,
});
type DocumentRecord = z.infer<typeof DocumentRecord>;

export const DocumentContent = z.object({
  sections: z.array(
    z.object({
      ordinal: z.number().int().nonnegative(),
      heading: z.string(),
      body: z.string(),
      guidance: z.string().optional(),
    }),
  ),
  placeholders: z.array(
    z.object({ ordinal: z.number().int().nonnegative(), name: z.string().min(1), kind: z.string().min(1) }),
  ),
  file: z.object({ blobRef: z.string().min(1), mediaType: z.string().min(1) }).optional(),
});
export type DocumentContent = z.infer<typeof DocumentContent>;

// Who was on an item, from its headers. A calendar event reaches a store as one of these,
// with channel "calendar" and direction "meeting". No text.
export const InteractionRecord = z.object({
  evidenceId: EvidenceId,
  occurredAt: Timestamp,
  channel: SourceKind,
  direction: z.enum(["inbound", "outbound", "meeting"]),
  // The member who sent the item, when a member did.
  sender: MemberId.optional(),
  // The members it was addressed to, in the order the source lists them.
  teamRecipients: z.array(MemberId),
  participants: z.array(LocalEntityId),
  // Present only on a message a member sent.
  sent: z.object({ recipients: z.array(LocalEntityId), bodyHash: Sha256 }).optional(),
});
export type InteractionRecord = z.infer<typeof InteractionRecord>;

const documentBody = z.object({ record: DocumentRecord, content: DocumentContent });

const routed = {
  destination: Store,
  evidenceId: EvidenceId,
  keys: ContentKeys,
  readEvidenceIds: z.array(EvidenceId).min(1),
  evidenceLabels: z.array(SignedLabel),
  label: Label,
};

// A message before it is sealed and numbered. The router registers the destination store
// against every key in keys.
export const Routed = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claim"), ...routed, body: Claim }),
  z.object({ kind: z.literal("document"), ...routed, body: documentBody }),
  z.object({ kind: z.literal("interaction"), ...routed, body: InteractionRecord }),
]);
export type Routed = z.infer<typeof Routed>;
