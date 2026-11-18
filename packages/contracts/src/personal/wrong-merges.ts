import { z } from "zod";
import { EntityId, MessageId, RequestId } from "./ids.ts";

// report_wrong_merge: an agent's statement that the addresses served under one person belong to two
// or more people. A proposal, never a split: two agents naming the same split make it, below the
// owner's word.

const wrongMergeReportId = z.string().regex(/^wmr_[0-9A-HJKMNP-TV-Z]{26}$/);
const Code = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
// An address as get_entity serves it.
const Address = z.string().min(3).max(320);

const WRONG_MERGE_PARTS = Object.freeze({ min: 2, max: 4, addresses: 50, cites: 20 });

export const ReportWrongMergeArgs = z.strictObject({
  entity: EntityId,
  parts: z
    .array(z.array(Address).min(1).max(WRONG_MERGE_PARTS.addresses))
    .min(WRONG_MERGE_PARTS.min)
    .max(WRONG_MERGE_PARTS.max)
    .describe(
      "Each list is one person's addresses, as get_entity serves them. Every address of the person goes in one list.",
    ),
  because: Code.describe("Why, as a code: different_employers, different_cities, or a word of your own in that form."),
  cites: z
    .array(MessageId)
    .max(WRONG_MERGE_PARTS.cites)
    .describe("The messages you read that show they are different people."),
  requestId: RequestId,
});
export type ReportWrongMergeArgs = z.infer<typeof ReportWrongMergeArgs>;

// Why a report was not taken, each read from what the caller can see alone.
export const WrongMergeRefusal = z.enum([
  "agents_off",
  "not_merged",
  "same_record",
  "incomplete",
  "owner_ruled",
  "no_evidence",
  "cite_label",
  "already_reported",
]);
export type WrongMergeRefusal = z.infer<typeof WrongMergeRefusal>;

// Where a report stands: `filed` waits for a second agent; `agreed`, another agent named the same
// split and the next sweep makes it; `split`, made; `refused`, the split could not be made; `owner`,
// it waits for the owner.
export const WrongMergeState = z.enum(["filed", "agreed", "split", "refused", "owner"]);
export type WrongMergeState = z.infer<typeof WrongMergeState>;

export const ReportWrongMergeResult = z.union([
  z.strictObject({ report: wrongMergeReportId, state: WrongMergeState }),
  z.strictObject({ refused: WrongMergeRefusal }),
]);
export type ReportWrongMergeResult = z.infer<typeof ReportWrongMergeResult>;

export const MERGE_AUDIT_ASK =
  "Code joined two records as one person: the person this task is about. Check it. Read the person with get_entity and the mail of each address with find_messages and read_message. If they are one person, record a finding saying what shows it, which your done report cites. If the addresses belong to different people, call report_wrong_merge with each person's addresses and the messages that show it, then record a finding and report done. If you reported this merge yourself, release the task: a second agent has to check it. If you cannot tell, report failed with the reason. Contact no one.";
