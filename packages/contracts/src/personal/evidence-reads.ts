import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { IntroOffer } from "./fact-vocabulary.ts";
import { AgentRecordId, CaptureId, DocumentId, EventId, Handle, MessageId } from "./ids.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { FactSource, MessageSummary, Who } from "./tools-views.ts";

// The results of the evidence and path reads. Every value a source wrote is under untrusted.

const count = z.number().int().nonnegative();
// Credential-shaped values masked in the text a result carries.
const masked = z.number().int().positive();

// The source a fact was taken from: one this tool opens, or, for a fact with no passage here, where
// it came from: a document for get_document, or only the kind of a source no agent tool opens.
export const EvidenceSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), id: MessageId.or(Handle) }),
  z.strictObject({ kind: z.literal("record"), id: AgentRecordId.or(Handle) }),
  z.strictObject({ kind: z.literal("document"), id: DocumentId.or(Handle) }),
  // A recorded meeting: read_meeting opens it whole.
  z.strictObject({ kind: z.literal("meeting"), id: CaptureId.or(Handle) }),
  z.strictObject({ kind: z.literal("elsewhere"), from: FactSource }),
]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

// Why a fact the caller can see has no passage, and what to do, by where it came from. Fixed text.
export const NO_PASSAGE: Readonly<Record<EvidenceSource["kind"], string>> = Object.freeze({
  message:
    "This fact rests on an attachment or a subject line, not a passage of the text: read_message opens the message.",
  document: "No passage is cut from a document: get_document opens it.",
  record: "This fact's record has no passage to serve: read_record opens the record.",
  meeting:
    "This fact cites no turn of its meeting that is still stored. read_meeting, if you hold it, opens the meeting.",
  elsewhere:
    "This source's text, a chat's among them, is not served to agents: the fact's own words are all there is. Nothing is wrong with the id.",
});

// The segment one fact's span falls in. `chars` is the whole passage's length; `cut` says the
// passage served is shorter. `passage` null: the fact is one the caller can see, with no text here, and `noPassage` says why.
export const EvidenceSpan = z.strictObject({
  fact: FactId.or(Handle),
  source: EvidenceSource,
  passage: UntrustedString.nullable(),
  chars: count,
  cut: z.boolean(),
  masked: masked.optional(),
  noPassage: z.string().max(200).optional(),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpan>;

// One thread's visible messages, oldest first. A message's `text` is null when it has none;
// `cut` says it goes on past what was served, which read_message reads on from. `next` is the
// position to ask from when messages remain.
export const ThreadView = z.strictObject({
  thread: UntrustedString.nullable(),
  messages: z
    .array(
      z.strictObject({ summary: MessageSummary, text: UntrustedString.nullable(), offset: count, cut: z.boolean() }),
    )
    .max(20),
  next: count.nullable(),
  masked: masked.optional(),
});
export type ThreadView = z.infer<typeof ThreadView>;

// The observed kinds are code's reading of mail, meetings and addresses: nobody said these two know
// each other.
export const OBSERVED_TIES = Object.freeze(["shared_thread", "same_domain", "met_together"] as const);
export const ObservedTie = z.enum(OBSERVED_TIES);
export type ObservedTie = z.infer<typeof ObservedTie>;
export const PathTie = z.enum([
  "own_tie",
  "relationship",
  "affiliation",
  "acquaintance",
  "intro_offer",
  "connection",
  "reported",
  "researched",
  ...OBSERVED_TIES,
]);
export type PathTie = z.infer<typeof PathTie>;
export const isObservedTie = (via: PathTie): via is ObservedTie => (OBSERVED_TIES as readonly PathTie[]).includes(via);

export const ObservedBasis = z.strictObject({
  weight: z.number().min(0).max(1),
  count: z.number().int().min(0),
  lastAt: Timestamp.nullable(),
  ref: z.union([MessageId, EventId, Handle]).nullable(),
});
export type ObservedBasis = z.infer<typeof ObservedBasis>;

// One hop, citing the facts it rests on. `offer` is an intro_offer hop's, and only its; `observed`
// an observed kind's, and only its, marking it as read from evidence, not stated by anyone.
export const PathHop = z
  .strictObject({
    from: Who,
    to: Who,
    via: PathTie,
    offer: IntroOffer.optional(),
    observed: ObservedBasis.optional(),
    facts: z.array(FactId.or(Handle)),
  })
  .refine((hop) => (hop.offer !== undefined) === (hop.via === "intro_offer"), {
    message: "an offer exactly on an intro_offer hop",
    path: ["offer"],
  })
  .refine((hop) => (hop.observed !== undefined) === isObservedTie(hop.via), {
    message: "observed exactly on an observed hop",
    path: ["observed"],
  });
export type PathHop = z.infer<typeof PathHop>;

// Each hop cites the facts of the beliefs it rests on. `cut` says a bound of the walk stopped it.
// At most 4 hops.
export const PathList = z.strictObject({
  paths: z
    .array(
      z.strictObject({
        score: z.number(),
        hops: z.array(PathHop).min(1).max(4),
      }),
    )
    .max(20),
  cut: z.boolean(),
});
export type PathList = z.infer<typeof PathList>;
