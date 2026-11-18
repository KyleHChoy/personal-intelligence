import { z } from "zod";

// Names the stage that failed. Never an error message.
export const FailureCode = z.enum([
  "transient",
  "control_unavailable",
  "gateway_unavailable",
  "key_refused",
  "label_invalid",
  "parse_failed",
  "interpret_failed",
  "check_failed",
  "route_failed",
  "commit_failed",
  "payload_missing",
  "internal",
]);
export type FailureCode = z.infer<typeof FailureCode>;
