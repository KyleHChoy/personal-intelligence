import { canonicalTimeZone, dayAfter, dayIn, instantOf, startOfDay } from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import type { Query } from "./db.ts";
import type { Ctx } from "./read-ctx.ts";

// The owner's time zone: set with `pi owner timezone`, in policy.owner_settings, null while unset.
// It is read by no viewer's rows, so every caller reads the same answer, and a day boundary that
// turns on it turns on nothing a caller cannot see. The tick (pi_work) and the Pipeline
// (pi_pipeline) read it too.

// The farthest a local day reaches from UTC: a read of "today" looks this much either side.
export const ZONE_REACH_MS = 14 * 60 * 60 * 1000;

export const OWNER_TIME_ZONE = "select time_zone from policy.owner_settings";

const zoneOf = (rows: { time_zone: string | null }[]): string | null =>
  rows[0]?.time_zone == null ? null : canonicalTimeZone(rows[0].time_zone);

// The zone, or null while unset or when the stored name is not one this runtime knows, which a
// day boundary then reads as UTC.
export async function ownerTimeZone(ctx: Ctx): Promise<string | null> {
  return zoneOf(await ctx.run<{ time_zone: string | null }>(OWNER_TIME_ZONE, []));
}

// The same, for a role's own transaction: the tick's and the Pipeline's.
export async function ownerZoneOf(query: Query): Promise<string | null> {
  return zoneOf(await query<{ time_zone: string | null }>(OWNER_TIME_ZONE));
}

// The owner's day at `now`, in their zone (UTC's while unset), worked out here as `pi health
// dream-due` works out the day it names, so the two never disagree and no zone name reaches the
// database's own list: the day the night's pass counts its budget by, and the spend view reads its
// lane by.
export async function ownerDayOf(query: Query, now: Date = systemNow()): Promise<string> {
  return dayIn(now, await ownerZoneOf(query));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A tool's time bounds as instants: a date alone is the owner's local day, its first instant as
// a `from` and its last as a `to` (instantOf). The zone is read only when a bound is a date.
export async function zonedBounds<A extends { from?: string | undefined; to?: string | undefined }>(
  ctx: Ctx,
  args: A,
): Promise<A> {
  if (!DATE.test(args.from ?? "") && !DATE.test(args.to ?? "")) return args;
  const zone = await ownerTimeZone(ctx);
  const from = instantOf(args.from, "from", zone);
  const to = instantOf(args.to, "to", zone);
  return { ...args, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

// An all-day event's span in the owner's zone: from the first instant of its first day to the
// first of the day after its last. The calendar stores its days as UTC midnights, the end the
// day after the last, so a null zone gives the stored instants back.
export function allDaySpan(starts: Date, ends: Date | null, zone: string | null): { start: number; end: number } {
  const first = starts.toISOString().slice(0, 10);
  const after = ends === null || ends.getTime() <= starts.getTime() ? dayAfter(first) : ends.toISOString().slice(0, 10);
  return { start: startOfDay(first, zone), end: startOfDay(after, zone) };
}
