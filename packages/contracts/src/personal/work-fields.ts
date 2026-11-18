import { z } from "zod";

// What a gap flag finds missing, which the gap rules (work-gaps.ts) and the work views (work.ts)
// share. Not on the package root.
export const GapMissing = z.enum([
  "identity",
  "path",
  "profile",
  "role",
  "brief",
  "follow_up",
  "reply",
  "tie",
  "ask",
  "fix",
  "triage",
  "answer",
]);
export type GapMissing = z.infer<typeof GapMissing>;
