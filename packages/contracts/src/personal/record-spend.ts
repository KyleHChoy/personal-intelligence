import { z } from "zod";

// One model call's cost, recorded before its output is used; a cost of 0 only asks whether it may go
// on. requestId is the work tools' RequestId, restated so this file imports nothing of theirs.
export const RecordSpendArgs = z.strictObject({
  modelId: z.string().min(1).max(128),
  costMicroUsd: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export type RecordSpendArgs = z.infer<typeof RecordSpendArgs>;
export const RecordSpendResult = z.strictObject({ go: z.boolean() });
export type RecordSpendResult = z.infer<typeof RecordSpendResult>;
