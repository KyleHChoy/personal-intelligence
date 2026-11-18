// Times and lengths of time in words, in the owner's own time zone, one style everywhere.

// Minutes as hours and minutes: 200 reads "3h 20m".
export const durationOf = (minutes: number): string => {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  return hours === 0 ? `${whole}m` : `${hours}h ${String(whole % 60).padStart(2, "0")}m`;
};

// Every time the page shows is in the owner's own time zone, in words, one style everywhere: "today
// 10:59 AM", "yesterday 6:12 PM", "Tue 8:40 PM", "tomorrow 9:00 AM", else "22 Oct", with its year
// ("22 Oct 2025") when it is more than a year ago. Lower case, as the design writes a time inside a
// sentence; `capital()` where one starts a line or a value. Never an ISO string, never UTC.
export const DAY_MS = 86_400_000;
const midnight = (when: Date): number => new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
// Whole local days from `now`'s day to `when`'s, rounded so a change of clocks moves nothing.
export const daysFrom = (when: Date, now: Date = new Date()): number =>
  Math.round((midnight(when) - midnight(now)) / DAY_MS);
export const clockOf = (when: Date): string =>
  when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// A date: "22 Oct", with its year when more than a year from now.
export const dateWords = (when: Date, now: Date = new Date()): string =>
  `${when.getDate()} ${when.toLocaleDateString(undefined, { month: "short" })}${Math.abs(now.getTime() - when.getTime()) > 365 * DAY_MS ? ` ${when.getFullYear()}` : ""}`;
const weekday = (when: Date): string => when.toLocaleDateString(undefined, { weekday: "short" });
const dateOf = (at: string | Date): Date => (typeof at === "string" ? new Date(at) : at);
export function whenWords(at: string | Date, now: Date = new Date()): string {
  const when = dateOf(at);
  if (Number.isNaN(when.getTime())) return "";
  const days = daysFrom(when, now);
  if (days === 0) return `today ${clockOf(when)}`;
  if (days === -1) return `yesterday ${clockOf(when)}`;
  if (days === 1) return `tomorrow ${clockOf(when)}`;
  if (days > -7 && days < 7) return `${weekday(when)} ${clockOf(when)}`;
  return dateWords(when, now);
}
// A day without its time: "today", "yesterday", "Tue", else "22 Oct".
export function dayWords(at: string | Date, now: Date = new Date()): string {
  const when = dateOf(at);
  if (Number.isNaN(when.getTime())) return "";
  const days = daysFrom(when, now);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (days > -7 && days < 7) return weekday(when);
  return dateWords(when, now);
}
// A length of time in days, said as the design does: "1 day", "4 days", "2 weeks", "3 months".
export function spanWords(days: number): string {
  const whole = Math.max(0, Math.round(days));
  if (whole < 14) return whole === 1 ? "1 day" : `${whole} days`;
  if (whole < 60) return `${Math.round(whole / 7)} weeks`;
  if (whole < 730) return `${Math.round(whole / 30)} months`;
  return `${Math.round(whole / 365)} years`;
}

// When work started, said once: "Since 8:54 AM" today, else "Since yesterday 6:12 PM".
export const sinceWords = (at: string | Date, now: Date = new Date()): string =>
  `Since ${dayWords(at, now) === "today" ? clockOf(dateOf(at)) : whenWords(at, now)}`;
// A length of time as the Today room says it: "40 min", "5 h", "5 h 05 min"; never "5 h 00 min".
export const hoursWords = (minutes: number): string => {
  const whole = Math.round(minutes);
  const [hours, rest] = [Math.floor(whole / 60), whole % 60];
  return hours === 0 ? `${whole} min` : rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} min`;
};

// An hour of the day on the owner's clock: "4 AM", "Noon", "Midnight".
export const hourWords = (hour: number): string => {
  const h = ((hour % 24) + 24) % 24;
  return h === 12 ? "Noon" : h === 0 ? "Midnight" : h > 12 ? `${h - 12} PM` : `${h} AM`;
};
// A day on the owner's device as a date field and the reads take it, `YYYY-MM-DD`.
export const isoDay = (when: Date): string =>
  `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
