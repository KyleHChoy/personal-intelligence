import { z } from "zod";
import { GateCheckKind } from "../outbound.ts";
import { DraftId, Handle, MessageId, OpportunityId, RequestId, SourceAccountId } from "./ids.ts";
import { ClientRef, sendAddress } from "./primitives.ts";

// The send proxy: a draft, the gate that clears it and the one send. Plain text only: no
// attachment, no HTML part, no hidden recipient and no display name has a field.

const codePoints = (text: string): number => [...text].length;
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
const BODY_REFUSED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
const SUBJECT_REFUSED = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
const text = (min: number, max: number, refused: RegExp) =>
  z
    .string()
    .refine((value) => codePoints(value) >= min && codePoints(value) <= max, {
      message: `${min} to ${max} code points`,
    })
    .refine((value) => !refused.test(value) && !UNPAIRED.test(value), {
      message: "a character a message may not carry",
    });
// Printable ASCII with no white space.
const token = z.string().regex(/^[\x21-\x7E]{1,250}$/);
const address = z
  .string()
  .refine((value) => sendAddress(value) === value, { message: "not a send address in lower case" });
const looseAddress = z.string().refine((value) => sendAddress(value) !== null, { message: "not a send address" });
const distinct = (to: string[], cc: string[]): boolean =>
  new Set([...to, ...cc].map((one) => one.toLowerCase())).size === to.length + cc.length;

export const SendPayload = z
  .strictObject({
    v: z.literal(1),
    account: SourceAccountId,
    to: z.array(address).min(1).max(10),
    cc: z.array(address).max(10),
    subject: text(1, 200, SUBJECT_REFUSED),
    body: text(1, 20_000, BODY_REFUSED),
    thread: z.strictObject({ id: token, inReplyTo: token, references: z.array(token).max(20) }).nullable(),
  })
  .refine((payload) => distinct(payload.to, payload.cc), { message: "an address twice" })
  .refine((payload) => payload.to.length + payload.cc.length <= 10, { message: "more than 10 recipients" });
export type SendPayload = z.infer<typeof SendPayload>;

// No key for a label, a compartment, an author, a thread, a header or a sender. `account` is a
// source account's label. Each id may be a one-time handle.
export const DraftMessageArgs = z
  .strictObject({
    opportunity: OpportunityId.or(Handle).optional(),
    account: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .optional(),
    replyTo: MessageId.or(Handle).optional(),
    to: z.array(looseAddress).max(10).optional(),
    cc: z.array(looseAddress).max(10).optional(),
    subject: text(1, 200, SUBJECT_REFUSED).optional(),
    body: text(1, 20_000, BODY_REFUSED),
    basis: z.array(ClientRef).max(20).optional(),
    requestId: RequestId,
  })
  .refine((args) => args.replyTo !== undefined || ((args.to ?? []).length > 0 && args.subject !== undefined), {
    message: "a new message needs to and subject",
  })
  .refine((args) => args.replyTo === undefined || args.subject === undefined, {
    message: "a reply's subject is derived",
    path: ["subject"],
  })
  .refine((args) => distinct(args.to ?? [], args.cc ?? []), { message: "an address twice" })
  .refine((args) => (args.to ?? []).length + (args.cc ?? []).length <= 10, { message: "more than 10 recipients" });
export type DraftMessageArgs = z.infer<typeof DraftMessageArgs>;

// Nothing else, whatever the gate decided.
export const DraftMessageResult = z.strictObject({ draft: DraftId.or(Handle) });
export type DraftMessageResult = z.infer<typeof DraftMessageResult>;

export const GatePhase = z.enum(["draft", "send"]);
export type GatePhase = z.infer<typeof GatePhase>;

export const DraftStatus = z.enum(["made", "held", "sent", "rejected", "expired"]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const SendStatus = z.enum(["sending", "sent", "failed", "unknown"]);
export type SendStatus = z.infer<typeof SendStatus>;

const count = z.number().int().nonnegative();

// Integers, booleans and one closed word: never an id, a fingerprint or text. The keys are in
// the order the gate's table gives them, so two equal fact sets are equal bytes.
export const GateFacts = z.strictObject({
  draft: z.strictObject({
    found: z.boolean(),
    tainted: z.boolean(),
    status: z.enum(["new", ...DraftStatus.options]),
    ageSeconds: count,
    withinCap: z.boolean(),
    consentFree: z.boolean(),
    authorCurrent: z.boolean(),
    disclosureOnly: z.boolean(),
  }),
  account: z.strictObject({
    connected: z.boolean(),
    own: z.boolean(),
    copyMissing: z.boolean(),
    syncAgeSeconds: count.nullable(),
  }),
  recipients: z.strictObject({ count, vetoed: count, suppressed: count, firstContact: count }),
  about: z.strictObject({ vetoed: z.boolean() }),
  basis: z.strictObject({ missing: count, tainted: count, flagged: count, unscreened: count }),
  beliefs: z.strictObject({ changed: count }),
  thread: z.strictObject({ isNew: z.boolean(), found: z.boolean(), newer: count }),
  sent: z.strictObject({ already: z.boolean() }),
  // `open`: the opportunity's latest status is go, claimed or handed_to_owner.
  work: z.strictObject({ named: z.boolean(), go: z.boolean(), open: z.boolean(), tainted: z.boolean() }),
  killSwitch: z.boolean(),
});
export type GateFacts = z.infer<typeof GateFacts>;

// `released` is 0 at phase draft.
export const GateInput = z
  .strictObject({
    phase: GatePhase,
    facts: GateFacts,
    revealed: count,
    released: count,
    computedFp: z.string(),
    storedFp: z.string(),
  })
  .refine((input) => input.phase === "send" || input.released === 0, {
    message: "nothing is released at phase draft",
    path: ["released"],
  });
export type GateInput = z.infer<typeof GateInput>;

// Each cause and the one check it belongs to. cannot_answer belongs to none: it is any check
// that threw or whose facts were missing.
export const GATE_CAUSE_CHECK = Object.freeze({
  draft_missing: "authority",
  author_not_current: "authority",
  not_made: "authority",
  // A held draft whose hold is not lapsed by a release.
  held_at_draft: "authority",
  switch_on: "authority",
  no_go: "authority",
  work_tainted: "authority",
  work_closed: "authority",
  recipient_vetoed: "vetoes",
  about_vetoed: "vetoes",
  recipient_suppressed: "conflict_lists",
  recipient_count: "contact_policy",
  use_only_revealed: "disclosure",
  draft_tainted: "freshness",
  too_old: "freshness",
  ref_missing: "freshness",
  ref_tainted: "freshness",
  belief_moved: "freshness",
  thread_missing: "freshness",
  later_message: "freshness",
  already_sent: "freshness",
  sync_stale: "freshness",
  consent_needed: "consent",
  label_over_cap: "channel_cap",
  account_not_own: "channel_cap",
  not_connected: "channel_cap",
  copy_missing: "channel_cap",
  payload_changed: "payload_hash",
} as const satisfies Record<string, GateCheckKind>);

export const GateCause = z.enum([
  ...(Object.keys(GATE_CAUSE_CHECK) as (keyof typeof GATE_CAUSE_CHECK)[]),
  "cannot_answer",
]);
export type GateCause = z.infer<typeof GateCause>;

// One cause for each clause that failed, in the order of the checks.
export const GateOutcome = z.strictObject({
  cleared: z.boolean(),
  checks: z.record(GateCheckKind, z.boolean()),
  causes: z.array(GateCause),
});
export type GateOutcome = z.infer<typeof GateOutcome>;

// `isPublic` when the claim's compartments are exactly public; `thirdParty` from its sealed
// disclosure.
export const UseOnlyCandidate = z.strictObject({
  id: z.string().min(1),
  thirdParty: z.boolean(),
  isPublic: z.boolean(),
  offThread: z.boolean(),
  citedItem: z.boolean(),
  textValues: z.array(z.string()),
});
export type UseOnlyCandidate = z.infer<typeof UseOnlyCandidate>;

// A claim the draft reveals and how it is tied. No text.
export const RevealedClaim = z.strictObject({
  id: z.string().min(1),
  tie: z.enum(["cited_item", "text_value"]),
  valueIndex: z.number().int().nonnegative().nullable(),
});
export type RevealedClaim = z.infer<typeof RevealedClaim>;

export const ContactCandidate = z.strictObject({
  id: z.string().min(1),
  names: z.array(z.string()),
  phones: z.array(z.string()),
  organizations: z.array(z.strictObject({ name: z.string().nullable(), title: z.string().nullable() })),
  birthday: z.strictObject({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullable(),
  // Its links' normalized URLs, its own and its import's. Absent is none.
  links: z.array(z.string()).optional(),
});
export type ContactCandidate = z.infer<typeof ContactCandidate>;

// A contact field a draft reveals, or one the owner released: its contact, its field, and its
// index among the contact's phones, organizations or links (null for a birthday). No value.
export const RevealedContact = z.strictObject({
  id: z.string().min(1),
  field: z.enum(["phone", "organization", "title", "birthday", "link"]),
  index: z.number().int().nonnegative().nullable(),
});
export type RevealedContact = z.infer<typeof RevealedContact>;

// What the one request to the send endpoint became.
export const SendResult = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("sent"), id: z.string().min(1), threadId: z.string().min(1).nullable() }),
  z.strictObject({ outcome: z.literal("failed"), status: z.number().int() }),
  z.strictObject({ outcome: z.literal("unknown") }),
]);
export type SendResult = z.infer<typeof SendResult>;
