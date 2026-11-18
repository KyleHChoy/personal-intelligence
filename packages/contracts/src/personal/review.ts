import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { PersonalEvidenceId, TriageLane } from "./extraction.ts";
import { MessageId } from "./ids.ts";
import { FactType } from "./tools-args.ts";

// The extraction review's two documents. `pi extract review-export` prints the sample `pi extract
// review` would show, as one document, to a terminal only, since it holds decrypted mail from every
// compartment; `pi extract review-import` reads the owner's verdicts back. The export carries
// exactly what the terminal review shows, and the ids the verdicts need.

// The sample's id: the sample's ids and generation, under the deployment's MAC. Opaque here.
const SampleId = z.string().min(1).max(1_000_000);
// A claim's id as the store gives it.
const ClaimRef = z.string().min(1).max(256);

export const ReviewExport = z.strictObject({
  sample_id: SampleId,
  generation: z.number().int().nonnegative(),
  // The `--type` the sample was drawn for, or null.
  type: FactType.nullable(),
  items: z.array(
    z.strictObject({
      item_id: PersonalEvidenceId,
      message_id: MessageId,
      lane: TriageLane,
      date: Timestamp,
      subject: z.string().nullable(),
      sender: z.string().nullable(),
      text: z.string().nullable(),
      claims: z.array(
        z.strictObject({
          claim_id: ClaimRef,
          type: z.string(),
          fields: z.record(z.string(), z.unknown()),
          passage: z.string(),
        }),
      ),
    }),
  ),
});
export type ReviewExport = z.infer<typeof ReviewExport>;

// A claim's verdict, as the terminal review takes it. `missed` and `nothing` are the item's.
const ClaimVerdict = z.enum(["right", "wrong", "wrong_date"]);

export const ReviewImport = z.strictObject({
  sample_id: SampleId,
  verdicts: z
    .array(
      z.strictObject({
        item_id: PersonalEvidenceId,
        claims: z.array(z.strictObject({ claim_id: ClaimRef, verdict: ClaimVerdict })),
        // The terminal's item answer: `missed`, or nothing missed.
        missed: z.boolean(),
        // Optional: an item with no claim and nothing missed is stored as `nothing` without it.
        nothing: z.literal(true).optional(),
      }),
    )
    .max(500),
});
export type ReviewImport = z.infer<typeof ReviewImport>;
