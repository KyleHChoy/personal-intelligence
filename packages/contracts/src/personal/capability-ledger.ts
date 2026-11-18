import { z } from "zod";
import { Timestamp } from "../ids.ts";

// `pia ledger`: each scheduled job the store can record a run of, whether it ran and how its last run
// ended. Ids, counts, times and codes only, so it can be handed to a reviewer who never sees the box.
// A job that never ran has no last run, and shows with a count of zero.
export const CAPABILITY_LEDGER_DAYS = 14;

const CapabilityRow = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  lastRunAt: Timestamp.nullable(),
  runs: z.number().int().nonnegative(),
  lastStatus: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable(),
});

export const CapabilityLedger = z.strictObject({
  at: Timestamp,
  days: z.literal(CAPABILITY_LEDGER_DAYS),
  capabilities: z.array(CapabilityRow),
});
export type CapabilityLedger = z.infer<typeof CapabilityLedger>;
