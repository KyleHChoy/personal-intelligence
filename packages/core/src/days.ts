import { dayAfter, dayIn, startOfDay } from "@intelligence/contracts/personal";

// Days and times: units in milliseconds, the day of an instant (in UTC, or in the owner's zone), a
// zone's wall clock, and the month and weekday words dates are written with. Pure.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// A date with no time: YYYY-MM-DD.
export const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// The whole days from one YYYY-MM-DD date to another, negative when `to` is earlier.
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// The UTC day (YYYY-MM-DD) of an instant.
export const utcDayOf = (at: string | number | Date): string => new Date(at).toISOString().slice(0, 10);

// The owner's day of a date or an instant; null for what is neither.
export const dayOf = (when: unknown, zone: string | null): string | null => {
  if (typeof when !== "string") return null;
  if (DAY_ONLY.test(when)) return when;
  const at = Date.parse(when);
  return Number.isFinite(at) ? dayIn(new Date(at), zone) : null;
};

// How far a zone's wall clock is ahead of UTC at an instant, in milliseconds.
function offsetAt(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: string): number => Number(parts.find((one) => one.type === type)?.value);
  return (
    Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) -
    (at - (((at % 1000) + 1000) % 1000))
  );
}

// The instant a zone's clock reads `hour`:00 on `date`, the offset taken again at the first guess
// so an hour on the other side of a clock change is the one the clock shows.
export function wallInstant(date: string, hour: number, zone: string | null): number {
  const wall = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  if (zone === null) return wall;
  return wall - offsetAt(zone, wall - offsetAt(zone, wall));
}

// A local day in the owner's zone as a window, and its two halves, split at the zone's noon.
export const dayWindow = (day: string, zone: string | null): { from: number; to: number } => ({
  from: startOfDay(day, zone),
  to: startOfDay(dayAfter(day), zone),
});
export const halfDayWindows = (day: string, zone: string | null): { from: number; to: number }[] => {
  const { from, to } = dayWindow(day, zone);
  const noon = wallInstant(day, 12, zone);
  return [
    { from, to: noon },
    { from: noon, to },
  ];
};

// The months' names, January first, and their three-letter forms.
export const MONTH_NAMES: readonly string[] = Object.freeze([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);
export const MONTHS: readonly string[] = Object.freeze(MONTH_NAMES.map((name) => name.slice(0, 3)));
// A month's name as a regular expression's alternation: the name, its three letters, or "sept".
export const MONTH_WORD =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// The weekdays' three letters, Sunday first, as Date's getUTCDay counts them.
export const WEEKDAYS: readonly string[] = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
