import { z } from "zod";
import { RestatementAnswer } from "./about-you.ts";
import { ClaimRecord, PersonalUnmappedReason, PipelineCode, RetryAsk, TriageLane } from "./extraction.ts";
import { count } from "./extraction-fields.ts";
import { PersonalEvidenceId, RulingId } from "./ids.ts";
import { FiledMention } from "./mentions.ts";
import { Hex64 } from "./primitives.ts";

// `reached` is null exactly for `new`; `matchedFactKeyFp`, the keyed fingerprint of the fact key
// restated, is set for `echo` and `stale` and null otherwise.
export const RestatementCheck = z
  .strictObject({
    claimId: z.string().min(1),
    answer: RestatementAnswer,
    reached: z.enum(["read", "held"]).nullable(),
    matchedFactKeyFp: Hex64.nullable(),
  })
  .refine((one) => (one.reached === null) === (one.answer === "new"), { message: "reached is null exactly for new" })
  .refine((one) => (one.matchedFactKeyFp !== null) === (one.answer === "echo" || one.answer === "stale"), {
    message: "a fact key exactly for echo and stale",
  });
export type RestatementCheck = z.infer<typeof RestatementCheck>;

// A field's name or a check's code on a refused candidate, by shape, so no value can be stored as one.
export const RefusalWord = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
export type RefusalWord = z.infer<typeof RefusalWord>;

// One re-ask an item's commit followed: the wording codes it named, the wording it was asked under
// (the re-ask prompt's id, version and the start of its text hash) and whether its answer left the
// item a claim. Codes and ids only.
export const ReaskRecord = z.strictObject({
  codes: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .min(1)
    .max(8),
  wording: z.string().regex(/^[A-Za-z0-9_.-]{1,100}@[A-Za-z0-9_.-]{1,40}#[0-9a-f]{12}$/),
  rescued: z.boolean(),
});
export type ReaskRecord = z.infer<typeof ReaskRecord>;

// One item's final answer, written in one transaction.
export const ExtractionCommit = z
  .strictObject({
    evidenceId: PersonalEvidenceId,
    generation: count,
    lane: TriageLane,
    status: z.enum(["done", "skipped", "withheld", "failed"]),
    code: PipelineCode.optional(),
    claims: z.array(ClaimRecord),
    unmapped: z.array(
      z.strictObject({
        id: z.string().min(1),
        proposedType: z.string().min(1),
        reason: PersonalUnmappedReason,
        // Which field of the type and what failed of it, in code's words: never a value.
        field: RefusalWord.optional(),
        issue: RefusalWord.optional(),
      }),
    ),
    unresolved: count,
    // For a document: the model calls it was sent in, at most eight, and the passages past the last
    // of them, which were not sent. A meeting's windows, at most 24 (the extract lane's
    // MEETING_MAX_WINDOWS), and the turns past the last of them.
    groups: count.max(24).optional(),
    leftOut: count.optional(),
    // For an agent record's `done` commit: one answer for each claim it checked.
    restatements: z.array(RestatementCheck).optional(),
    // They replace the item's filed mentions as its claims replace its claims; none given files
    // none.
    mentions: z.array(FiledMention).max(200).optional(),
    // For an agent record, the owner's release (by its ruling) the
    // run read when it opened the record; none when it read none.
    release: RulingId.optional(),
    // A moment committed `skipped` keeps the claims a
    // model made from it before, unless the owner retried it; only its code-made claims (`capture.`
    // and `activity.` types) become the batch's. The store holds it to a moment's skipped commit.
    keep: z.literal(true).optional(),
    // For a quoted proposal, its quote is a run of the owner's own words in an
    // item it cites that the owner sent, as the pipeline read the cited items. Only then may their standing
    // release keep it in place of a card (pipeline-write.ts); never from a body or a model.
    ownerQuoted: z.literal(true).optional(),
    // How many of its claims kept a value code repaired to the source's own words, and that the
    // item's claims came after its one re-ask.
    repaired: count.optional(),
    reasked: z.literal(true).optional(),
    // The re-ask this commit followed, whatever it gave: what the stop rule and the report count.
    reask: ReaskRecord.optional(),
    // What a retry chose it for, when this commit asked that version in that lane: a later replay stays on it.
    ask: RetryAsk.optional(),
  })
  // Up to 24 for a meeting's windows alone; every other lane keeps eight.
  .refine((one) => one.groups === undefined || one.lane === "meeting" || one.groups <= 8, {
    message: "groups over eight outside the meeting lane",
  });
export type ExtractionCommit = z.infer<typeof ExtractionCommit>;

// One answer the vendor gave, or one attempt it may have billed. `modelId` is the id the client
// called, in its route's form (OpenRouter's `vendor/model`, Anthropic's `claude-...`), never the
// vendor's model string. Every call carries the retention setting, so there is no field for it.
export const ModelUsageEvent = z.strictObject({
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
  inputTokens: count,
  outputTokens: count,
  costMicroUsd: count,
  outcome: z.enum(["ok", "rejected", "timed_out", "cost_missing", "no_answer", "check"]),
  evidenceId: PersonalEvidenceId.optional(),
});
export type ModelUsageEvent = z.infer<typeof ModelUsageEvent>;
