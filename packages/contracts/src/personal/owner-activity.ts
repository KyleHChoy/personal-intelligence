import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ACTIVITY_TYPES } from "./about-you.ts";
import { OwnerCursor } from "./owner-reads-paging.ts";
import { FactKeyFp } from "./primitives.ts";
import { FactId, UntrustedString } from "./tools-args.ts";

// `until` is the span's end; `title` the sentence code writes from the claim's theme.
export const OwnerActivityEntry = z.strictObject({
  fact: FactId,
  type: z.enum([ACTIVITY_TYPES.workedOn, ACTIVITY_TYPES.researched, ACTIVITY_TYPES.messaged, ACTIVITY_TYPES.met]),
  at: Timestamp,
  until: Timestamp.nullable(),
  factKey: FactKeyFp,
  title: UntrustedString,
});
export type OwnerActivityEntry = z.infer<typeof OwnerActivityEntry>;
export const OwnerActivity = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  entries: z.array(OwnerActivityEntry),
  next: OwnerCursor.nullable(),
});
export type OwnerActivity = z.infer<typeof OwnerActivity>;
