import { z } from "zod";
import { LocalEntityId, ReviewId } from "./ids.ts";

// What the identity service says a mention is, for one store.
export const Resolution = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.enum(["linked", "created"]), entity: LocalEntityId, epoch: z.number().int().nonnegative() }),
  // A person must rule before a claim about this subject is routed.
  z.object({ outcome: z.literal("candidate"), reviewId: ReviewId }),
  z.object({ outcome: z.literal("not_a_person") }),
  z.object({ outcome: z.literal("suppressed") }),
]);
export type Resolution = z.infer<typeof Resolution>;
