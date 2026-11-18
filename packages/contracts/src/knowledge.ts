import { z } from "zod";
import { MemberId, Timestamp } from "./ids.ts";
import { Label } from "./label.ts";

const HumanDecisionKind = z.enum(["correction", "ruling", "veto", "project_binding", "dispute", "grouping"]);
type HumanDecisionKind = z.infer<typeof HumanDecisionKind>;

// What a person decided. It outranks anything inferred.
export const HumanDecision = z.object({
  id: z.string().min(1),
  kind: HumanDecisionKind,
  targetKind: z.enum(["claim", "belief", "review_item", "project"]),
  targetId: z.string().min(1),
  decidedBy: MemberId,
  decidedAt: Timestamp,
  label: Label,
});
export type HumanDecision = z.infer<typeof HumanDecision>;

export const ReviewKind = z.enum(["project_binding", "dispute", "grouping"]);
export type ReviewKind = z.infer<typeof ReviewKind>;
