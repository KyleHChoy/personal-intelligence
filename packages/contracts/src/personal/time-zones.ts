// Calendar math in the owner's time zone. Pure, and imports nothing.

// The owner's time zone: an IANA name this runtime knows, in its canonical form,
// such as America/Chicago, or null for any other string.
export function canonicalTimeZone(zone: string): string | null {
  if (zone.length === 0 || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;
const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

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

// The first instant of a calendar day in a zone, in milliseconds; UTC's for a null zone. The
// offset is taken again at the first guess, so a day that starts on the other side of a clock
// change starts when the zone's clock reads midnight.
export function startOfDay(date: string, zone: string | null): number {
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (zone === null) return midnight;
  const guess = midnight - offsetAt(zone, midnight);
  return midnight - offsetAt(zone, guess);
}

// The calendar day an instant falls on in a zone, UTC's for a null zone.
export const dayIn = (at: Date, zone: string | null): string =>
  zone === null
    ? at.toISOString().slice(0, 10)
    : new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        at,
      );

// The hour an instant falls in on a zone's clock, 0 to 23, UTC's for a null zone, for the
// planner's daily sweep.
export const hourIn = (at: Date, zone: string | null): number =>
  zone === null
    ? at.getUTCHours()
    : Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit" }).format(at));

// A calendar day `days` after the one given.
export const dayAfter = (date: string, days = 1): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

// A time bound as the instant it stands for: a date alone is its day's first instant as a `from`
// and its last as a `to`, in the zone given, UTC when it is null or left out.
export const instantOf = (
  value: string | undefined,
  end: "from" | "to",
  zone: string | null = null,
): string | undefined => {
  if (value === undefined || !isDate(value)) return value;
  const at = end === "from" ? startOfDay(value, zone) : startOfDay(dayAfter(value), zone) - 1;
  return new Date(at).toISOString();
};
