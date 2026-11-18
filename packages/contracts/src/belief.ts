import { z } from "zod";
import { ChangeKind } from "./evidence.ts";
import { ClaimId, LocalEntityId, Sha256, Timestamp } from "./ids.ts";
import { Label } from "./label.ts";
import { BeliefKind, TypedValue } from "./ontology.ts";

export const BeliefStatus = z.enum(["active", "stale", "dormant", "expired", "closed"]);
export type BeliefStatus = z.infer<typeof BeliefStatus>;

// A rebuildable projection, never the authority. One row per fact per audience, keyed by
// factKey and supportHash. It holds no free text: wording is rendered from typed fields when shown.
export const Belief = z.object({
  kind: BeliefKind,
  // Derived deterministically from the claim content's typed fields.
  factKey: z.string().min(1),
  // SHA-256 over the sorted ids of the claims this audience can see.
  supportHash: Sha256,
  subject: LocalEntityId,
  // An ontology type id.
  type: z.string().min(1),
  values: z.record(z.string(), TypedValue),
  // The combined label of its support.
  label: Label,
  status: BeliefStatus,
  // Set only in a set that contains every conflicting claim. Only a person resolves it.
  disputed: z.boolean(),
  confidence: z.number().min(0).max(1),
  lastConfirmedAt: Timestamp,
  reviewAfter: Timestamp.optional(),
  // The fact key of the belief that replaced this one.
  supersededBy: z.string().min(1).optional(),
  changeKind: ChangeKind,
  support: z.array(ClaimId).min(1),
});
export type Belief = z.infer<typeof Belief>;
