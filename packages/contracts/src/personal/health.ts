import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { DeployedCommit } from "./deployed-commit.ts";
import { CardId, RequestId } from "./ids.ts";

// get_health: the system's health as the caller's label covers it. Every value is an id, a count,
// a code or a time; nothing a source or an agent wrote is here.

const Code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// A measure's name, as the store keeps it.
const Metric = z.string().regex(/^[a-z0-9_:.-]{1,120}$/);

export const GetHealthArgs = z.strictObject({});
export type GetHealthArgs = z.infer<typeof GetHealthArgs>;

// What a measure is made of: codes with their counts (a reason and how often, a command's kind and
// how often, the days since the last). Never a name or a text.
export const HEALTH_PARTS_MOST = 80;
export const HealthPartKey = z.string().regex(/^[a-z0-9_:.-]{1,80}$/);
export type HealthPartKey = z.infer<typeof HealthPartKey>;

// `failing`: the value is on the wrong side of its healthy line, above a line it must stay at or
// under, or below one it must reach. `healthy.test` says which.
const HealthMeasure = z.strictObject({
  metric: Metric,
  state: z.enum(["ok", "failing", "no_data"]),
  value: z.number().nullable(),
  sample: z.number().int().nonnegative(),
  readAt: Timestamp,
  // The line the code holds for this metric, or null for a reading with none (the nightly's count).
  healthy: z.strictObject({ test: z.enum(["at_least", "under", "at_most"]), value: z.number() }).nullable(),
  // Read more than 48 hours ago: the filing pass has not run since.
  stale: z.boolean(),
  // Its parts as the filing pass stored them with the reading, under the reading's label.
  parts: z.record(HealthPartKey, z.number()).optional(),
});

export const HealthView = z.strictObject({
  measures: z.array(HealthMeasure).max(300),
  // The standing check's latest result for each source.
  checks: z.array(z.strictObject({ source: Code, code: Code, at: Timestamp })).max(100),
  // Each job's last run, and whether its last three all failed.
  jobs: z.array(z.strictObject({ job: Code, code: Code, at: Timestamp, failing: z.boolean() })).max(100),
  // The box health cards standing open. `about` is a code or an id, cut to its kind for a caller
  // not cleared for what it names. A `backup_due` card's says why it is due: `backup` (the last dump
  // is too old), `erasure` (an erasure with no dump since) or `restore` (a restore test is due).
  cards: z
    .array(z.strictObject({ card: z.string(), kind: Code, about: z.string().max(200), since: Timestamp }))
    .max(100),
  // Open defects the caller can see, counted by role and severity.
  defects: z
    .array(
      z.strictObject({
        role: RoleName.nullable(),
        severity: z.enum(["low", "medium", "high", "critical"]),
        open: z.number().int().positive(),
      }),
    )
    .max(200),
  // The box itself, for a caller that is served a reading: the holds that stand, each switch the
  // agent API can read with its value, the commit deployed and the newest migration applied.
  // Absent for a caller served no reading.
  box: z
    .strictObject({
      holds: z.array(Code).max(20),
      switches: z.array(z.strictObject({ key: Code, value: Code })).max(40),
      commit: DeployedCommit,
      migration: z
        .string()
        .regex(/^[0-9]{4}$/)
        .nullable(),
    })
    .optional(),
});
export type HealthView = z.infer<typeof HealthView>;

// mark_health_seen: an agent's `seen` on one box health card it is cleared for, of a kind an agent
// may mark (AGENT_SEEN_KINDS). The card, from get_health's `cards` or a box_health notice, and when
// it was marked seen: on a repeat, when the caller first marked it.
export const MarkHealthSeenArgs = z.strictObject({ card: CardId, requestId: RequestId });
export type MarkHealthSeenArgs = z.infer<typeof MarkHealthSeenArgs>;
export const MarkHealthSeenResult = z.strictObject({ card: CardId, seenAt: Timestamp });
export type MarkHealthSeenResult = z.infer<typeof MarkHealthSeenResult>;
