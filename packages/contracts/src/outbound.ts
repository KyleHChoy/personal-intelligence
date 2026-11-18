import { z } from "zod";
import { CardId, DraftId, GateCheckId, MemberId, PartyId, Sha256, Timestamp } from "./ids.ts";
import { Channel } from "./tokens.ts";

// The outbound app and its gate: drafts, the gate's checks and decision, notices to members and
// their delivery, consent, sent messages and the action client's own errors.

// What the outbound gate decided. No reason field: every refusal has the same fields.
const GateDecision = z.strictObject({
  id: GateCheckId,
  cleared: z.boolean(),
  payloadHash: Sha256,
  channel: Channel,
  member: MemberId,
  draftId: DraftId.optional(),
  checkedAt: Timestamp,
});
type GateDecision = z.infer<typeof GateDecision>;

const DraftKind = z.enum(["consent_ask", "introduction", "invitation"]);
type DraftKind = z.infer<typeof DraftKind>;

// A draft with its text, as only the provider's list_drafts serves it. The text is the card's
// proposed text, read with the card, or the fixed wording of the consent template.
export const DraftView = z.object({
  draftId: DraftId,
  cardId: CardId,
  kind: DraftKind,
  recipients: z.array(PartyId),
  text: z.string(),
  clearedHash: Sha256,
  decision: GateDecision,
});
export type DraftView = z.infer<typeof DraftView>;

const ConsentState = z.enum(["not_asked", "asked", "consented", "declined", "not_now"]);
type ConsentState = z.infer<typeof ConsentState>;

// "Not now" comes with the date before which the party is not asked again, and no other state
// does. Strict: a client sends one inside a consent update, and a key it does not name is refused.
export const ConsentStatus = z
  .strictObject({ state: ConsentState, notBefore: Timestamp.optional() })
  .refine((status) => (status.state === "not_now") === (status.notBefore !== undefined), {
    message: "a date goes with not now, and with no other state",
    path: ["notBefore"],
  });
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const GateCheckKind = z.enum([
  "authority",
  "vetoes",
  "conflict_lists",
  "contact_policy",
  "disclosure",
  "freshness",
  "consent",
  "channel_cap",
  "payload_hash",
]);
export type GateCheckKind = z.infer<typeof GateCheckKind>;
