import { z } from "zod";
import { DateOnly } from "../ids.ts";

// The owner's time by activity, a view over Lens's time blocks. The rule table is
// versioned data, `ontology/activity-categories.json`; code applies it when a block day is read,
// and nothing it gives is stored as knowledge.

export const ActivityCategory = z.enum([
  "coding",
  "writing",
  "communication",
  "meetings",
  "research",
  "design",
  "media",
  "admin",
  "other",
]);
export type ActivityCategory = z.infer<typeof ActivityCategory>;

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
// A host in lower case, two labels at least.
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A URL path prefix: `/` and one or more segments, no query or fragment.
const PREFIX = /^(?:\/[^/?#\s]+)+$/;

// One row: a bundle id, or a host (which also matches its subdomains) with an optional path
// prefix, and its category. Exactly one of bundle and host.
export const ActivityRule = z
  .strictObject({
    bundle: z.string().regex(BUNDLE).optional(),
    host: z.string().regex(HOST).optional(),
    prefix: z.string().max(200).regex(PREFIX).optional(),
    category: ActivityCategory,
  })
  .refine((rule) => (rule.bundle === undefined) !== (rule.host === undefined), { message: "a bundle or a host" })
  .refine((rule) => rule.prefix === undefined || rule.host !== undefined, {
    message: "a prefix only with a host",
    path: ["prefix"],
  });
export type ActivityRule = z.infer<typeof ActivityRule>;

export const ActivityTable = z
  .strictObject({ version: z.number().int().min(1), rules: z.array(ActivityRule).min(1).max(2000) })
  .refine(
    (table) =>
      new Set(table.rules.map((rule) => JSON.stringify([rule.bundle?.toLowerCase(), rule.host, rule.prefix]))).size ===
      table.rules.length,
    {
      message: "a row twice",
    },
  );
export type ActivityTable = z.infer<typeof ActivityTable>;

// One local day's minutes by category, as `pi lens time` prints it: every category present, at
// most one decimal, and the table version that gave them.
export const ActivityDay = z.strictObject({
  day: DateOnly,
  version: z.number().int().min(1),
  minutes: z.record(ActivityCategory, z.number().min(0)),
  total: z.number().min(0),
});
export type ActivityDay = z.infer<typeof ActivityDay>;
