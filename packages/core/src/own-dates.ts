import { dayAfter } from "@intelligence/contracts/personal";
import { DAY_MS, MONTH_WORD, MONTHS, WEEKDAYS } from "./days.ts";

// What a line's own words say of time, read by code from pinned English forms, so a line that names a
// date reads as past once it has gone, with no model and nothing stored. It can miss a date worded
// otherwise, and the line then ages as any other does.

const ORDINAL = "(?:st|nd|rd|th)?";
const RANGE = String.raw`(?:\s*(?:-|–|—|to)\s*(\d{1,2})${ORDINAL})?`;
const YEAR = String.raw`(?:,?\s+(\d{4}))?`;
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}/-])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}/])`;
const MONTH_FIRST = new RegExp(
  String.raw`${NOT_WORD_BEFORE}(${MONTH_WORD})\.?\s+(\d{1,2})${ORDINAL}${RANGE}${YEAR}${NOT_WORD_AFTER}`,
  "giu",
);
const DAY_FIRST = new RegExp(
  String.raw`${NOT_WORD_BEFORE}(\d{1,2})${ORDINAL}${RANGE}\s+(?:of\s+)?(${MONTH_WORD})\.?${YEAR}${NOT_WORD_AFTER}`,
  "giu",
);
const ISO_DAY = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const SLASHED = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g;

// A date with no year this far behind the day it was said is next year's; nearer, it had passed.
export const YEAR_ROLL_DAYS = 180;

const daysFrom = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS;

function dayOf(month: number, date: number, year: number | undefined, said: string): string | null {
  const held = new Date(Date.UTC(year ?? Number(said.slice(0, 4)), month - 1, date));
  if (held.getUTCMonth() !== month - 1 || held.getUTCDate() !== date) return null;
  const made = held.toISOString().slice(0, 10);
  if (year !== undefined || daysFrom(made, said) <= YEAR_ROLL_DAYS) return made;
  held.setUTCFullYear(held.getUTCFullYear() + 1);
  return held.toISOString().slice(0, 10);
}

const monthOf = (word: string): number => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
// "may" is an ordinary word unless it is written as a month's name.
const isMonth = (word: string): boolean => word.toLowerCase() !== "may" || word[0] === "M";

// The days `text` names, a range by its last day, read against the day it was said.
export function daysNamed(text: string, said: string): string[] {
  const days: (string | null)[] = [];
  for (const [, word, first, last, year] of text.matchAll(MONTH_FIRST))
    if (word !== undefined && isMonth(word))
      days.push(dayOf(monthOf(word), Number(last ?? first), year === undefined ? undefined : Number(year), said));
  for (const [, first, last, word, year] of text.matchAll(DAY_FIRST))
    if (word !== undefined && isMonth(word))
      days.push(dayOf(monthOf(word), Number(last ?? first), year === undefined ? undefined : Number(year), said));
  for (const [, year, month, date] of text.matchAll(ISO_DAY))
    days.push(dayOf(Number(month), Number(date), Number(year), said));
  // Three digits at least, so "3/4" as a fraction names no day.
  for (const [whole, month, date, year] of text.matchAll(SLASHED))
    if (whole.replace(/\D/g, "").length >= 3) {
      const full = year === undefined ? undefined : year.length === 2 ? 2000 + Number(year) : Number(year);
      days.push(dayOf(Number(month), Number(date), full, said));
    }
  return days.flatMap((day) => (day === null ? [] : [day]));
}

// The last day `text` names, or null.
export function lastDayNamed(text: string, said: string): string | null {
  return daysNamed(text, said).sort().at(-1) ?? null;
}

// Whether a day is over everywhere: the widest a zone is behind UTC is under a day, so this waits for
// the next UTC day to end, and a date never reads as past while it is still that day for the owner.
export const dayIsOver = (day: string, now: Date): boolean =>
  now.getTime() >= Date.parse(`${dayAfter(day, 2)}T00:00:00.000Z`);

// A count to something ("3 weeks before", "4 days left") was true the day it was said: this many days on
// it no longer reads as it did.
const COUNTDOWN_DAYS = 3;
const COUNTDOWN =
  /\b(?:\d+|a|an|one|two|three|four|five|six|couple(?:\s+of)?|few)\s+(?:days?|weeks?|months?)\s+(?:before|until|till|left|away|out|to go|from now)\b/i;
// Words that say when within a span counted from the day they were said, the span's days.
const SPANS: readonly (readonly [RegExp, number])[] = [
  [/\bthis week(?:end)?\b/i, 7],
  [/\bnext (?:few days|week(?:end)?)\b/i, 14],
  [/\bthis month\b/i, 31],
  [/\bnext month\b/i, 62],
];

// The instant words relative to when they were said stop reading true, or null for none.
export function relativeEnd(text: string, at: string): number | null {
  const said = Date.parse(at);
  if (COUNTDOWN.test(text)) return said + COUNTDOWN_DAYS * DAY_MS;
  const days = SPANS.find(([words]) => words.test(text))?.[1];
  return days === undefined ? null : said + days * DAY_MS;
}

// A word a calendar title says its day by, which reads wrongly on any other day.
const RELATIVE_WORD = /(?<![\p{L}\p{N}-])(today|tonight|tomorrow|tmrw)(?![\p{L}\p{N}-])/giu;
const capital = (word = ""): string => word.charAt(0).toUpperCase() + word.slice(1);
const written = (day: string): string => {
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${capital(WEEKDAYS[date.getUTCDay()])} ${capital(MONTHS[date.getUTCMonth()])} ${date.getUTCDate()}`;
};

// A title as served: each relative word replaced by the date it stands for, read against the day the
// event falls on, so a stored reminder never says "tomorrow" of a day that has come. The event's id
// serves the title as it was written.
export function datedTitle(title: string, day: string): string {
  return title.replace(RELATIVE_WORD, (word) => written(/^(?:tomorrow|tmrw)$/i.test(word) ? dayAfter(day) : day));
}

// A line that only says a time suits, a day and a clock and "would be perfect". What it fixes is a
// meeting, which the calendar and the thread hold; nothing is left to do. Whatever else it says keeps it.
const TIME_SUITS =
  /\b(?:works(?:\s+(?:great|well|fine|perfectly|for\s+(?:me|us)))?|work\s+for\s+(?:me|us)|(?:would|will)\s+be\s+(?:great|perfect|ideal|good|fine)|sounds?\s+(?:good|great|perfect)|is\s+(?:great|perfect|good|fine))\b/i;
const SAYS_WHEN = new RegExp(
  String.raw`\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b|\b(?:${MONTH_WORD})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\b\d{1,2}:\d{2}\b|\b(?:noon|morning|afternoon|evening|tomorrow|today)\b|\b[ecmp][sd]?t\b`,
  "gi",
);
const LINKING = new Set("the at on or and then that this next for any time yes sure ok okay great thanks".split(" "));
export function onlySaysTimeSuits(text: string): boolean {
  if (!TIME_SUITS.test(text) || text.match(SAYS_WHEN) === null) return false;
  const left = text
    .replace(TIME_SUITS, " ")
    .replace(SAYS_WHEN, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !LINKING.has(word));
  return left.length === 0;
}
