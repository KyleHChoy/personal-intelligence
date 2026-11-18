import { dayAfter, dayIn } from "@intelligence/contracts/personal";
import { wallInstant } from "../days.ts";

// The moment lane's batched mode runs at 00:00 and 12:00 on the owner's clock, in the zone `pi
// owner timezone` set (UTC while none is set). A run takes the moments first pushed at or before
// the latest of those instants at or before its own time. Pure.

// The latest 00:00 or 12:00 on the zone's clock at or before `now`: today's noon, today's
// midnight, or yesterday's noon, which is always before now.
export function momentBatchCutoff(now: Date, zone: string | null): Date {
  const today = dayIn(now, zone);
  const candidates = [
    wallInstant(today, 12, zone),
    wallInstant(today, 0, zone),
    wallInstant(dayAfter(today, -1), 12, zone),
  ];
  return new Date(candidates.find((at) => at <= now.getTime()) as number);
}

// A source moment's thread is asked over several local days together, so its
// earlier days give a later one context. MOMENT_THREAD_DAYS is how many: the window of a thread's
// newest due day holds that day and the six before it; its older due days start the next window,
// from the newest of them. `days` are one thread's due local days (YYYY-MM-DD, any order, repeats
// allowed); the result names each day's window by its newest day. Pure.
export const MOMENT_THREAD_DAYS = 7;
export function threadWindows(days: readonly string[], span = MOMENT_THREAD_DAYS): Map<string, string> {
  const windows = new Map<string, string>();
  let anchor: string | undefined;
  for (const day of [...new Set(days)].sort().reverse()) {
    if (anchor === undefined || day <= dayAfter(anchor, -span)) anchor = day;
    windows.set(day, anchor);
  }
  return windows;
}
