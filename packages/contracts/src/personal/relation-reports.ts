import { z } from "zod";
import { DocumentId, MessageId, RequestId } from "./ids.ts";

// report_wrong_relation: an agent's statement that a model's relation between two claims, in effect
// at a read, is wrong. A report, never a lift: it counts toward its kind's overturn rate only when a
// second agent agrees or the second model's later check of it does not hold.

// A relation's id, as `about` serves it on a belief's applied relations.
export const RelationId = z.string().regex(/^[1-9][0-9]{0,17}$/);
export type RelationId = z.infer<typeof RelationId>;

const relationReportId = z.string().regex(/^rrp_[0-9A-HJKMNP-TV-Z]{26}$/);

// Why the relation is wrong, from a closed list: the two claims state different facts, the newer does
// not replace the older, they do not conflict, a claim misreads its source, or they are about
// different subjects.
export const RELATION_REPORT_BECAUSE = Object.freeze([
  "not_same_fact",
  "not_superseded",
  "not_contradicting",
  "source_misread",
  "different_subjects",
] as const);
export const RelationReportBecause = z.enum(RELATION_REPORT_BECAUSE);
export type RelationReportBecause = z.infer<typeof RelationReportBecause>;

const RELATION_REPORT_CITES = 20;

export const ReportWrongRelationArgs = z.strictObject({
  relation: RelationId.describe("The relation's id, from a belief's relations in about."),
  because: RelationReportBecause.describe(
    "Why: not_same_fact, not_superseded, not_contradicting, source_misread or different_subjects.",
  ),
  cites: z
    .array(z.union([MessageId, DocumentId]))
    .max(RELATION_REPORT_CITES)
    .describe("The messages and documents you read that show it is wrong."),
  requestId: RequestId,
});
export type ReportWrongRelationArgs = z.infer<typeof ReportWrongRelationArgs>;

// Why a report was not taken, each read from what the caller can see alone. A relation not in effect,
// or one the caller cannot see, is `not_found`, as one that does not exist is.
export const WrongRelationRefusal = z.enum(["agents_off", "owner_ruled", "no_evidence", "already_reported"]);
export type WrongRelationRefusal = z.infer<typeof WrongRelationRefusal>;

// Where a report stands: `filed` waits for a second agent or the second model's check; `agreed`,
// another agent's report under the same label names the same relation.
export const WrongRelationState = z.enum(["filed", "agreed"]);
export type WrongRelationState = z.infer<typeof WrongRelationState>;

export const ReportWrongRelationResult = z.union([
  z.strictObject({ report: relationReportId, state: WrongRelationState }),
  z.strictObject({ refused: WrongRelationRefusal }),
]);
export type ReportWrongRelationResult = z.infer<typeof ReportWrongRelationResult>;
