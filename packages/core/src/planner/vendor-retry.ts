// An item that failed because the model vendor was away (a rate limit, a timeout, a 5xx: the
// pipeline's `model_unavailable`) is tried again by the scheduled run with no word from the owner;
// one that failed for its content waits for the owner's retry, since asking again gives the same
// answer. The tries are bounded, and each waits twice as long as the one before, so an outage of
// most of a day is ridden out and a vendor that never answers an item is not asked for ever.

import { leverDefault } from "./levers.ts";

export const VENDOR_FAILURE_CODES: readonly string[] = Object.freeze(["model_unavailable"]);
// The defaults of the levers `extract.vendor_retry_max` and `extract.vendor_retry_base_minutes`.
export const VENDOR_RETRY_MAX = leverDefault("extract.vendor_retry_max");
export const VENDOR_RETRY_BASE_MINUTES = leverDefault("extract.vendor_retry_base_minutes");

// What becomes of an item that has just failed with `code`, after `retries` automatic retries:
// its count from here, and the minutes until the next one, or null when none is owed (a content
// failure, which also clears the count, or its tries are spent). `limits`: the two levers' values,
// which every caller reads, so the owner's setting is never passed over for the default.
export function vendorRetry(
  code: string | undefined,
  retries: number,
  limits: { max: number; baseMinutes: number },
): { retries: number; afterMinutes: number | null } {
  if (code === undefined || !VENDOR_FAILURE_CODES.includes(code)) return { retries: 0, afterMinutes: null };
  if (retries >= limits.max) return { retries, afterMinutes: null };
  return { retries: retries + 1, afterMinutes: limits.baseMinutes * 2 ** retries };
}
