import { DateOnly, Timestamp } from "@intelligence/contracts";
import {
  dayAfter,
  dayIn,
  type OpenItem,
  type OpenItemEnding,
  type RecallFilter,
  startOfDay,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS, DAY_ONLY, dayOf, daysBetween, MONTH_WORD, MONTHS, WEEKDAYS } from "../days.ts";
import { datedTitle, onlySaysTimeSuits, YEAR_ROLL_DAYS } from "../own-dates.ts";
import { COURTESY_DAYS } from "./commitment-lapse.ts";

// No model, no statement and no stored answer: a caller reads the sources under its own token, and
// this keeps, dates and orders only those rows, so nothing it cannot see moves anything it sees
// (invariant 6). A source's text is data; it is compared, never followed.

// A next step past due by more than this many days is no longer open; it stays readable through its
// source. A commitment's read has already applied its own lapse, counted from its date, its last
// confirming and the owner's reopen (commitment-lapse.ts), so one that reaches here is open.
export const OPEN_ITEM_LAPSE_DAYS = 14;
// A plan or a calendar reminder is about its date: it lapses sooner.
export const PAST_DUE_WINDOW_DAYS = 3;
// A next step with no date lapses by its age, as an undated commitment's courtesy does.
const UNDATED_STEP_DAYS = COURTESY_DAYS;
// A timed event this short, with nobody else on it and a title that says a deadline, is a reminder.
export const REMINDER_MAX_MINUTES = 30;

// A title or a line that says something is due or must be done by a date.
const DEADLINE =
  /\b(due|overdue|(?:not|\w+n['’]t)\s+(?:yet\s+)?(?:been\s+)?(?:received|submitted|filed|paid|renewed|completed)|deadlines?|submit|submission|turn in|hand in|assignments?|homework|problem sets?|psets?|exams?|midterms?|quiz(?:zes)?|essays?|renew(?:al)?|expires?|rsvp|pay|payments?|reminders?|remind|apply|application|register|registration)\b/i;
// Dates that use a deadline's words and ask nothing of anyone.
const MARKS_A_DATE = /\b(birthday|anniversary|holiday|pay day)\b/i;
// A mailing's line that says something is owed by a date, as a reminder of an event does not. `owedWords` leaves
// out what says nothing is owed: "due to" before a cause, and an amount of nothing due.
const OWED =
  /\b(?:due|overdue|(?:not|\w+n['’]t)\s+(?:yet\s+)?(?:been\s+)?(?:received|submitted|filed|paid|renewed|completed)|deadlines?)\b/i;
const CAUSAL_DUE =
  /\bdue\s+to\s+(?:limited|high|popular|overwhelming|strong|heavy|demand|capacity|rain|weather|maintenance|unforeseen|technical|scheduling|staffing|illness|circumstances|recent|ongoing|the\s+(?:holidays?|weather|storm|strike))\b/gi;
const NOTHING_DUE =
  /\b(?:(?:amount|balance|total|payment)\s+due\s*:?\s*(?:is\s+)?[$£€]?\s*0(?:\.0+)?(?![\d.,]*\d)|nothing\s+(?:(?:further|more|else)\s+)?(?:is\s+)?(?:due|owed)\b|no\s+(?:payment|balance|amount)\s+(?:is\s+)?due\b)|[$£€]\s*0(?:\.0+)?\s+(?:is\s+)?due\b/gi;
const owedWords = (text: string): string => text.replace(CAUSAL_DUE, " ").replace(NOTHING_DUE, " ");
const DONE_AS = (words: string): string =>
  String.raw`\b(?:has|have|had|was|were|is|been|we|we['’]ve|you['’]ve|you)\s+(?:(?:been|now|successfully)\s+)*(?:${words})\b|(?<!\bnot\s)(?<!\bnever\s)(?<!n['’]t\s)(?<!\bbe\s)(?<!\bto\s)\b(?:${words})\s*(?:$|[.!—–-])`;
// A plain past-tense statement of a thing received, paid, submitted or filed, whose sentence ends there.
const DONE_WORDS = "received|paid|submitted|filed";
const PLAIN_DONE = new RegExp(
  String.raw`^\s*(?:(?:we|i)(?:['’]ve|\s+have)?\s+(?:successfully\s+)?(?:${DONE_WORDS})\s+[^,;:]+?|you(?:['’]ve|\s+have)?\s+(?:successfully\s+)?(?:paid|submitted|filed)\s+[^,;:]+?|[^,;:]+?\s+(?:(?:has|have|had)\s+been\s+|was\s+|were\s+)?(?:successfully\s+)?(?:${DONE_WORDS}))\s*[.!]?\s*$`,
  "iu",
);
// A line that speaks of such a thing and does not say plainly it was done may be owed: it stays, and lapses by itself.
const SPEAKS_OF_DONE = new RegExp(String.raw`\b(?:${DONE_WORDS})\b`, "i");
// A word that leaves something owed, a condition or a part in a sentence: any of them and it says no thing was done.
const LEAVES_OWED =
  /\b(?:by|due|overdue|owed|must|please|make\s+sure|ensure|confirm|balance|remains?|still|but|part|of\s+\d+|on\s+the\s+first|no|nothing|not|never|until|unless|if|once|when|whether|before|after|cannot|to|be|needs?|should|will|would|shall|may|can|yet|get|required)\b|^\s*have\b|n['’]t\b/i;
// The done words a notice is read again for: a purchase says paid or completed and gives a receipt anyway,
// and a footer says who received the mail.
const ASKED_AGAIN = new RegExp(`(?:${DONE_AS("received|submitted|filed")})(?!\\s+(?:this|your\\s+order))`, "im");
// What an advertisement says of a date anyone may act on: no deadline of the owner's, whatever deadline
// word is beside it. It reads a mailing's line alone; a person's own mail is not a mailing. A line with "your" or
// a required word is none unless it is a sale's. It costs less to keep an advertisement than to lose a
// real deadline, so these words are few.
const ADVERTISED =
  /\b(?:applications?\s+(?:(?:are|is|now)\s+)*(?:open|close[sd]?|closing)|registration\s+(?:(?:are|is|now)\s+)*open|apply\s+(?:now|today|by|before)|register\s+(?:now|today)|(?:is|are|we['’]?re|now)\s+hiring)\b/i;
// What only a sale says: no word of the owner's makes it a deadline. An offer's end is the owner's when it is their offer.
const SELLS = /\b(?:(?:sales?|deals?|discounts?)\s+(?:ends?|expires?)|\d+%\s+off)\b/i;
const OFFER_ENDS = /\boffers?\s+(?:ends?|expires?)\b/i;
const OWN_OFFER = /\byour\b[^.!?\n]*\boffers?\b/i;
const ADVERTISED_SOFTLY =
  /\b(?:sign\s+up|last\s+chance|early[-\s]bird|don['’]?t\s+miss|limited[-\s]time|free\s+trial)\b/i;
const OWNERS_OR_REQUIRED = /\b(?:your|required|mandatory|must)\b/i;
const advertises = (text: string): boolean =>
  SELLS.test(text) ||
  (OFFER_ENDS.test(text) && !OWN_OFFER.test(text)) ||
  ((ADVERTISED.test(text) || ADVERTISED_SOFTLY.test(text)) && !OWNERS_OR_REQUIRED.test(text));
// A date a notice fixes for the owner to be somewhere, which needs no deadline word: only this positive form.
const FIXES_ATTENDANCE =
  /\byour\s+(?:next\s+)?(?:appointment|pick-?up|booking|reservation|interview|hearing|court\s+date)\s+(?:is|was|has\s+been)\s+(?:now\s+)?(?:scheduled|fixed|confirmed|booked|set)\b/i;
// A mailing's line that asks something of the owner, with no deadline word. A word list judged by a sweep of invented
// wordings: a stray one ("Complete your profile") has the 3-day window, and leaves by itself.
const ACTION_WORD = String.raw`complete|sign|upload|accept|verify|return|respond\s+to|submit`;
const ASKS_ACTION = new RegExp(
  String.raw`\b(?:${ACTION_WORD})\b[^.!?\n]*\b(?:your|required)\b|\brequired\b[^.!?\n]*\b(?:${ACTION_WORD})\b|\baction\s+required\b|\b(?:unpaid|owed|outstanding|payable|last\s+day\s+to|hold\s+on\s+your\s+account|court\s+date|your\s+interview\s+is\s+on|you\s+owe)\b`,
  "i",
);
// The words two statements of one notice's obligation need not share, beside those that say when.
const NOTICE_FILLER = new Set(
  "a an and are been by for has have haven had hasn in is it its of on our passed please t the this to was we were you your not deadline deadlines overdue past received submitted filed paid renewed completed reminder".split(
    " ",
  ),
);
// A clock time at a line's head, or a range of them, with what separates it from the words.
const CLOCK_TIME = String.raw`(?:\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)`;
const CLOCK_HEAD = new RegExp(String.raw`^\s*${CLOCK_TIME}(?:\s*[-–—]\s*${CLOCK_TIME})?\s*[-–—:|]?\s*`, "i");
// A title that says it is a reminder, or says its deadline by the day it fires on.
const SAYS_REMINDER = /\b(reminders?|remind)\b/i;
const RELATIVE_HEAD = /^\s*(today|tonight|tomorrow|tmrw)\s*:/i;
const RELATIVE_DUE = /\bdue\s+(?:by\s+|on\s+)?(?:today|tonight|tomorrow|tmrw)\b/i;
const WEEKDAY_WORD =
  "sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?";
const DUE_ON = new RegExp(
  String.raw`\bdue\s+(?:by\s+|on\s+)?(?:(today|tonight)|(tomorrow|tmrw)|(\d{4}-\d{2}-\d{2})|(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?|(${MONTH_WORD})\.?\s+(\d{1,2})|(${WEEKDAY_WORD}))\b`,
  "i",
);
// What a reminder's line says before the thing it reminds of.
// Words and dates that say when, which two statements of one obligation may put differently.
const WHEN_WORDS = new RegExp(
  String.raw`\b(?:due|today|tonight|tomorrow|tmrw|sunday|monday|tuesday|wednesday|thursday|friday|saturday|(?:${MONTH_WORD})\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}/\d{1,2}(?:/\d{2,4})?|\d{4}-\d{2}-\d{2}|${CLOCK_TIME})(?![\p{L}\p{N}])`,
  "giu",
);
// A line that opens by saying it holds only on a condition: nothing is owed until that happens, and what
// makes it happen arrives as a line of its own.
const CONDITIONAL_HEAD = /^\s*if\s+(?:requested|needed|necessary|required|asked|applicable)\s*(?:[,:;.)—–-]|$)/iu;
// A title's own time for a deadline, which an alert set ahead of it is not.
const DUE_AT_CLOCK = /\bdue\s+(?:by\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![\p{L}\p{N}])/iu;
// A word or a date that names a day, so a clock in the same title may belong to that day and not the event's.
const NAMES_A_DAY = new RegExp(
  String.raw`\b(?:today|tonight|tomorrow|tmrw|${WEEKDAY_WORD}|(?:${MONTH_WORD})\.?\s+\d{1,2}|\d{1,2}/\d{1,2}|\d{4}-\d{2}-\d{2})\b`,
  "i",
);
// A later plan of the owner's saying the earlier one moved.
const SAYS_MOVED =
  /\b(instead|move[ds]?|moving|reschedul\w*|postpone[ds]?|push(?:ed|ing)?|bump(?:ed|ing)?|shift(?:ed|ing)?|change[ds]?)\b/i;
const REMINDER_HEAD =
  /^\s*(?:(?:week|day|month|hour)[\s-]before\s+)?(?:reminders?|today|tonight|tomorrow|tmrw)\b\s*[:\-–—]?\s*/i;

type Refs = Pick<OpenItem["source"], "message" | "document" | "capture" | "record" | "agent">;

export type EventInput = {
  id: string;
  title: string;
  // The owner's day it falls on, and what it is due as: an all-day event's day, a timed one's instant.
  day: string;
  due: string;
  allDay: boolean;
  days: number;
  minutes: number;
  // The other people on it the caller can see; the owner is never one.
  others: number;
  declined: boolean;
};
export type PlanInput = {
  // The item's id, and what its words match across statements (`itemKeys`).
  key: string;
  match: string;
  what: string;
  when: unknown;
  // When it was said.
  at: number;
  // Its message came from one of the owner's own addresses.
  ownMail: boolean;
  // Its message is a mailing, or a program's notice: a date in one is news of an event, not something owed,
  // unless it says a deadline.
  bulk?: boolean;
  // Who sent it, as a fingerprint: one sender's notices of one obligation are one item, and its receipt
  // ends them.
  sender?: string;
  // Its mail passed authentication: only such a line can say a thing was done and end what its sender said was owed.
  authed?: boolean;
  // The mail thread it was said on, and the owner's latest message there, which closes nothing.
  thread?: string;
  repliedAt?: number;
  refs: Refs;
};
type NextStepInput = {
  key: string;
  match: string;
  what: string;
  due: unknown;
  at: number;
  // The record's evidence: one report's steps stand or fall together.
  evidence: string;
  // Who reported it: an agent's later report replaces its own steps, and no other agent's.
  agent: string;
  project: Who;
  refs: Refs;
};
// The owner's Done or Drop in force. `key` is the item it was pressed on, `due` its date then.
type CloseInput = {
  key: string;
  match: string | null;
  ending: OpenItemEnding;
  at: string;
  due: string | null;
};
type CommitmentInput = {
  key: string;
  what: string | null;
  due: string | null;
  whoActs: Who;
  project: Who | null;
  refs: Refs;
};
export type OpenInputs = {
  owner: Who;
  commitments: readonly CommitmentInput[];
  nextSteps: readonly NextStepInput[];
  plans: readonly PlanInput[];
  events: readonly EventInput[];
  closes: readonly CloseInput[];
};

// A line's words as one text, which two statements of it share however it is cased or punctuated.
export const normalizedLine = (text: string): string => wordsOf(text).join(" ");

// A line that says something is due or must be done by a date.
export const saysDeadline = (text: string): boolean => DEADLINE.test(text) && !MARKS_A_DATE.test(text);

// A person's own line that puts a deadline on whoever reads it. Addressed to the reader, any deadline word will do:
// "Your exam is Friday". Otherwise it takes a word that says something is owed, and must name no one else: "Final
// drafts are due Friday", not "My paper is due Friday", "Sam's essay is due Friday" or "See you at the exam on Friday".
// A wish, what was already done and an advertisement are none. A line with no date is no item at any rate.
const SOMEONE_ELSES =
  /\b(?:i|i['’](?:m|ll|ve|d)|my|mine|we|we['’](?:re|ll|ve|d)|us|our|ours|he|him|she|they|them|his|her|hers|their|theirs)\b|\b(?!(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|week|year)['’])\p{L}+['’]s\b/iu;
const ADDRESSED = /\b(?:your|yours|you\s+(?:must|need|have|should|owe))\b/i;
const A_WISH = /\b(?:hope|good luck|best of luck|congrats|congratulations|enjoy|have fun)\b/i;
export const saysDeadlineToOwner = (text: string): boolean => {
  const words = owedWords(text);
  if (A_WISH.test(text) || saysDone(text) || advertises(text) || !saysDeadline(words)) return false;
  return ADDRESSED.test(text) || (OWED.test(words) && !SOMEONE_ELSES.test(text));
};

// A mailing's line that says something is owed by a date, or that it was done: the words a notice is read
// again for.
export const saysNoticeDue = (text: string): boolean => OWED.test(owedWords(text)) || ASKED_AGAIN.test(text);

// A mailing's line says the thing owed was done: not done unless proved. Some sentence must be a plain past-tense
// statement that ends there, and no sentence may leave anything owed. A line this misses stays and lapses by itself; a
// line it wrongly took would be a lost obligation.
export function saysDone(text: string): boolean {
  const sentences = text.split(/(?<=[.!?;\n])\s*/u).filter((one) => one.trim() !== "");
  return (
    sentences.some((one) => PLAIN_DONE.test(one)) &&
    !sentences.some((one) => LEAVES_OWED.test(owedWords(one)) || one.trimEnd().endsWith("?"))
  );
}

// Whether a line's head makes it conditional.
const saysConditional = (text: string): boolean => CONDITIONAL_HEAD.test(text.replace(CLOCK_HEAD, ""));

// The words of a line, with any clock at its head left off, lower-cased.
const wordsOf = (text: string): string[] =>
  text
    .replace(CLOCK_HEAD, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

// Whether a plan's words stand whole inside an event's title, so the plan says nothing the calendar
// does not. The other way round is a task about the event ("Prepare slides for team meeting"). One
// word says too little ("Call" is inside many a title), so that must be the whole title.
function restatesTitle(plan: readonly string[], title: readonly string[]): boolean {
  if (plan.length === 0 || plan.length > title.length) return false;
  if (plan.length === title.length) return plan.every((word, index) => word === title[index]);
  if (plan.length < 2) return false;
  for (let start = 0; start + plan.length <= title.length; start += 1)
    if (plan.every((word, index) => word === title[start + index])) return true;
  return false;
}

// A calendar event that is a reminder or a deadline. Its title must say so: a holiday calendar's
// lines, a school break and a note of where the owner is are all-day lines with nobody on them, and
// nothing stored says which calendar an event came from. A timed one is also short and solo, or lasts
// no time at all, which only a reminder does.
export function isReminderEvent(event: EventInput): boolean {
  if (event.declined || saysConditional(event.title)) return false;
  const deadline = DEADLINE.test(event.title) && !MARKS_A_DATE.test(event.title);
  if (event.allDay) return event.days === 1 && deadline;
  if (event.others > 0) return false;
  return event.minutes === 0 || (event.minutes <= REMINDER_MAX_MINUTES && deadline);
}

// The day a title says something is due, read against the day it fires on: today, tomorrow, a date or
// a weekday after "due", or a head of today or tomorrow. Null when it says none.
export function titledDeadline(title: string, day: string): string | null {
  const inYear = (month: number, date: number, named?: number): string | null => {
    const year = named ?? Number(day.slice(0, 4));
    const held = new Date(Date.UTC(year, month - 1, date));
    if (held.getUTCMonth() !== month - 1 || held.getUTCDate() !== date) return null;
    const made = (y: number): string => `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
    return named === undefined && daysBetween(made(year), day) > YEAR_ROLL_DAYS ? made(year + 1) : made(year);
  };
  const found = DUE_ON.exec(title);
  if (found !== null) {
    const [, today, tomorrow, iso, month, date, year, named, namedDate, weekday] = found;
    if (today !== undefined) return day;
    if (tomorrow !== undefined) return dayAfter(day);
    if (iso !== undefined) return iso;
    if (month !== undefined) {
      const full = year === undefined ? undefined : year.length === 2 ? 2000 + Number(year) : Number(year);
      return inYear(Number(month), Number(date), full);
    }
    if (named !== undefined) return inYear(MONTHS.indexOf(named.slice(0, 3).toLowerCase()) + 1, Number(namedDate));
    if (weekday !== undefined) {
      const from = new Date(`${day}T00:00:00.000Z`).getUTCDay();
      return dayAfter(day, (WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase()) - from + 7) % 7);
    }
  }
  const head = RELATIVE_HEAD.exec(title)?.[1]?.toLowerCase();
  if (head === undefined) return null;
  return head === "today" || head === "tonight" ? day : dayAfter(day);
}

// The instant a timed title says it is due on its event's day ("DUE 8:00am"), in the owner's zone, when that
// reads as an alert set ahead of the deadline: a title that names no other day and no reminder, with its time
// after the event starts. Counted from the day's first moment, so on the day a clock changes it is an hour out.
function titledClock(event: EventInput, zone: string | null): string | null {
  if (event.allDay || NAMES_A_DAY.test(event.title) || SAYS_REMINDER.test(event.title)) return null;
  const found = DUE_AT_CLOCK.exec(event.title);
  if (found === null) return null;
  const [, hour, minute, half] = found;
  const hours = Number(hour);
  const minutes = Number(minute ?? 0);
  if (hours < 1 || hours > 12 || minutes > 59) return null;
  const clock = (hours % 12) + ((half as string).toLowerCase() === "p" ? 12 : 0);
  const at = startOfDay(event.day, zone) + (clock * 60 + minutes) * 60_000;
  return at > Date.parse(event.due) ? new Date(at).toISOString() : null;
}

// A calendar item's dates. A reminder fires on its event's date and the thing is due on the date its
// title names, or on none it can read; only a title that is no reminder is due when the event is. A title
// that gives its own time wins over the event's start, which is then when it fires.
function calendarDates(event: EventInput, zone: string | null): { due: string | null; remindAt?: string } {
  const clock = titledClock(event, zone);
  if (clock !== null) return { due: clock, remindAt: event.due };
  const titled = titledDeadline(event.title, event.day);
  const reminder = SAYS_REMINDER.test(event.title) || RELATIVE_HEAD.test(event.title) || RELATIVE_DUE.test(event.title);
  if (titled === null) return reminder ? { due: null, remindAt: event.due } : { due: event.due };
  if (titled === event.day && !reminder) return { due: event.due };
  return { due: titled, remindAt: event.due };
}

// What a line obliges: all its words but a reminder's and those that say when, so a reminder of a
// deadline and the deadline share it, and anything else that differs keeps them two. A duplicate is a
// nuisance and a lost obligation a failure. Null when too little is left to say two lines are one.
function obligationOf(text: string): string | null {
  const words = wordsOf(text.replace(REMINDER_HEAD, "").replace(WHEN_WORDS, " "));
  return words.length < 2 ? null : words.join(" ");
}

// Two notices of one sender at one date are one obligation when all that one says of it stands in the
// other. Any other word apart keeps them two: a lost obligation is a failure.
const noticeWords = (text: string): string[] =>
  wordsOf(text.replace(WHEN_WORDS, " ")).filter((word) => !NOTICE_FILLER.has(word));
// A receipt ends a line only when, its done words and the line's due words apart, they say the same thing. "Payment
// received." leaves "Your tuition payment is due." standing until it lapses, which is the cheaper mistake.
const coversLine = (receipt: PlanInput, line: PlanInput): boolean => {
  const said = new Set(noticeWords(receipt.what));
  const owed = new Set(noticeWords(line.what));
  return said.size === owed.size && [...owed].every((word) => said.has(word));
};
// A later notice replaces an earlier one only when it holds all of what that one says: "Transcript due" leaves
// "Transcript and immunization form due" standing.
const holdsLine = (later: PlanInput, line: PlanInput): boolean => {
  const said = new Set(noticeWords(later.what));
  return noticeWords(line.what).every((word) => said.has(word));
};
function sameNotice(a: PlanInput, b: PlanInput, zone: string | null): boolean {
  if (a.sender === undefined || a.sender !== b.sender || dayOf(a.when, zone) !== dayOf(b.when, zone)) return false;
  const [one, other] = [noticeWords(a.what), noticeWords(b.what)];
  const [short, long] = one.length <= other.length ? [one, new Set(other)] : [other, new Set(one)];
  return short.length > 0 && short.every((word) => long.has(word));
}

// Whether a reminder on the calendar says the same deadline as another line that day: the shorter stands
// whole inside the longer, at least three words of it, or both open with five words alike. Two lines
// neither of which is a reminder stay two: related work words itself alike, and a lost one is a failure.
const CALENDAR_RUN_WORDS = 3;
const CALENDAR_HEAD_WORDS = 5;
function sameCalendarLine(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a.split(" "), b.split(" ")] : [b.split(" "), a.split(" ")];
  if (short.length >= CALENDAR_RUN_WORDS && restatesTitle(short, long)) return true;
  return (
    long.slice(0, CALENDAR_HEAD_WORDS).every((word, at) => word === short[at]) && short.length >= CALENDAR_HEAD_WORDS
  );
}

// A recurring event is stored once per instance, with nothing joining them but their words: its next
// instance stands for the rest, or, with none to come, its latest. A reminder's instance counts by the
// day it reminds of.
function nextInstances(events: readonly EventInput[], today: string): EventInput[] {
  const series = new Map<string, EventInput>();
  const deadlineOf = (event: EventInput): string => titledDeadline(event.title, event.day) ?? event.day;
  for (const event of [...events].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    const title = normalizedLine(event.title);
    const kept = series.get(title);
    if (kept === undefined || deadlineOf(kept) < today) series.set(title, event);
  }
  return [...series.values()];
}

// A plan that restates the owner's calendar, not a thing to do: its line and date match an event of
// theirs, or it is a schedule line (a clock at its head) from their own address, as a daily brief's
// lines are. A line that says a deadline stays unless the calendar's event is itself an item.
export function isCalendarCopy(plan: PlanInput, events: readonly EventInput[], zone: string | null): boolean {
  const day = dayOf(plan.when, zone);
  if (day === null) return false;
  const words = wordsOf(plan.what);
  const deadline = DEADLINE.test(plan.what);
  const matches = events.filter((event) => event.day === day && restatesTitle(words, wordsOf(event.title)));
  if (matches.some((event) => !deadline || isReminderEvent(event))) return true;
  return plan.ownMail && !deadline && CLOCK_HEAD.test(plan.what);
}

// A plan that names no deadline, whose date the owner or the calendar has since replaced: the owner's later plan
// on its thread at another date, in the same words or saying it moved, or one event titled exactly its
// words on another day to come. Several such events are a series, which says nothing of this date. A
// reply alone closes nothing: "sounds good" confirms a plan, and code cannot read more from one.
function movedOn(
  plan: PlanInput,
  plans: readonly PlanInput[],
  events: readonly EventInput[],
  today: string,
  zone: string | null,
): boolean {
  if (saysDeadline(plan.what)) return false;
  const day = dayOf(plan.when, zone);
  const line = normalizedLine(plan.what);
  const replaced = plans.some(
    (later) =>
      plan.thread !== undefined &&
      later.thread === plan.thread &&
      later.ownMail &&
      later.at > plan.at &&
      dayOf(later.when, zone) !== null &&
      dayOf(later.when, zone) !== day &&
      (normalizedLine(later.what) === line || SAYS_MOVED.test(later.what)),
  );
  if (replaced) return true;
  const words = wordsOf(plan.what);
  const titled = events.filter(
    (event) => !event.declined && wordsOf(event.title).join(" ") === words.join(" ") && words.length > 0,
  );
  const [only] = titled;
  return titled.length === 1 && only !== undefined && only.day >= today && only.day !== day;
}

// A date or an instant to order by: a day is its first moment in the owner's zone. Undated last.
const orderOf = (due: string | null, zone: string | null): number => {
  if (due === null) return Number.MAX_SAFE_INTEGER;
  return DAY_ONLY.test(due) ? startOfDay(due, zone) : Date.parse(due);
};

// A due value as a date or an instant, or null for anything else, which no item is due by.
const dueOf = (when: unknown): string | null =>
  DateOnly.safeParse(when).success || Timestamp.safeParse(when).success ? (when as string) : null;

type Lapsed = { key: string; at: number };
type Composed = {
  items: OpenItem[];
  // What dropped out by date, and when, for the outcome report; each still reads through its source.
  // No commitment: those are in its own read's closed list, with `lapsed`.
  lapsed: Lapsed[];
  // Next steps a later report on their project replaced.
  replaced: string[];
  // Dated lines a closed filter kept from being items, by the filter: what a recall audit reads. A line
  // the owner dropped, the calendar holds or a later plan moved is not here: nothing closed decided those.
  dropped: { key: string; filter: RecallFilter }[];
};

export function composeOpenItems(inputs: OpenInputs, now: Date, zone: string | null): Composed {
  const today = dayIn(now, zone);
  const seen = new Set<string>();
  const items: OpenItem[] = [];
  const lapsed: Lapsed[] = [];
  const dropped: Composed["dropped"] = [];

  const closed = (id: string, match: string | null, due: string | null, at: number | null, stored?: string | null) =>
    closedBy(inputs.closes, id, match, due, at, stored);
  // What the owner closed through one of its sources: no other brings it back (invariant 11).
  const closedObligations = new Set<string>();
  const calendarLines: { day: string; words: string; reminder: boolean }[] = [];
  const closeObligation = (what: string | null, due: string | null, whoActs: Who, project: Who | null): void => {
    const obligation = obligationAt(zone, what, due, whoActs, project);
    if (obligation !== null) closedObligations.add(obligation);
  };

  // `limit`: how many days past due, or past its reminder when nothing is due, it stays open.
  const add = (
    source: OpenItem["source"],
    what: string | null,
    due: string | null,
    whoActs: Who,
    project: Who | null,
    limit: number,
    close: { match: string | null; at: number | null } = { match: null, at: null },
    marks: { remindAt?: string; repliedAt?: string } = {},
  ): void => {
    const { remindAt } = marks;
    if (seen.has(source.id)) return;
    seen.add(source.id);
    if (source.kind !== "commitment" && closed(source.id, close.match, due, close.at, remindAt ?? null)) {
      closeObligation(what, due, whoActs, project);
      const calendarDay = due === null ? null : dayOf(due, zone);
      const calendarWords = what === null ? null : obligationOf(what);
      if (source.kind === "calendar" && calendarDay !== null && calendarWords !== null)
        calendarLines.push({ day: calendarDay, words: calendarWords, reminder: remindAt !== undefined });
      return;
    }
    const dated = due ?? remindAt ?? null;
    const day = dated === null ? null : dayOf(dated, zone);
    const late = day === null ? 0 : daysBetween(day, today);
    if (late > limit) {
      lapsed.push({ key: source.id, at: Date.parse(`${day}T00:00:00.000Z`) + (limit + 1) * DAY_MS });
      return;
    }
    const overdue =
      due !== null && (late > 0 || (!DAY_ONLY.test(due) && late === 0 && Date.parse(due) < now.getTime()));
    items.push({
      what: what === null ? null : { untrusted: what },
      due,
      ...marks,
      source,
      whoActs,
      project,
      overdue,
      lateDays: overdue ? late : null,
    });
  };

  for (const one of inputs.commitments)
    add(
      { kind: "commitment", id: one.key, ...one.refs },
      one.what,
      dueOf(one.due),
      one.whoActs,
      one.project,
      Number.POSITIVE_INFINITY,
    );

  const { live, replaced } = liveSteps(inputs.nextSteps);
  for (const step of inputs.nextSteps) {
    if (!live.has(step.key)) continue;
    const due = dueOf(step.due);
    if (due === null && now.getTime() - step.at > UNDATED_STEP_DAYS * DAY_MS) {
      if (!seen.has(step.key) && !closed(step.key, step.match, null, step.at)) {
        seen.add(step.key);
        lapsed.push({ key: step.key, at: step.at + UNDATED_STEP_DAYS * DAY_MS });
      }
      continue;
    }
    add(
      { kind: "next_step", id: step.key, ...step.refs },
      step.what,
      due,
      inputs.owner,
      step.project,
      OPEN_ITEM_LAPSE_DAYS,
      { match: step.match, at: step.at },
    );
  }

  for (const event of nextInstances(inputs.events.filter(isReminderEvent), today)) {
    const { due, remindAt } = calendarDates(event, zone);
    add(
      { kind: "calendar", id: event.id },
      event.title,
      due,
      inputs.owner,
      null,
      PAST_DUE_WINDOW_DAYS,
      undefined,
      remindAt === undefined ? {} : { remindAt },
    );
  }

  // Rows come newest first: a fact's newest statement decides, so an older one never stands in for it.
  // One line that gives several dates: of one source's statements of it, the next date to come stands
  // for those after it, and any date already past stays, as overdue or lapsed. A close holds for its own
  // date alone: the next one then comes up. Another source's statement stands apart.
  const lines = new Map<string, { plan: PlanInput; due: string }[]>();
  const lineOf = (plan: PlanInput): string =>
    `${normalizedLine(plan.what)}\n${plan.refs.message ?? plan.refs.document ?? plan.refs.capture ?? plan.refs.record ?? plan.key}`;
  const mailed = inputs.plans.filter((plan) => plan.bulk === true);
  const stated = new Set<string>();
  for (const plan of inputs.plans) {
    if (stated.has(plan.key)) continue;
    stated.add(plan.key);
    const due = dueOf(plan.when);
    if (due === null) continue;
    const filter =
      (plan.bulk === true ? mailingDrop(mailed, plan, zone) : null) ??
      (onlySaysTimeSuits(plan.what) ? "says_time_suits" : saysConditional(plan.what) ? "says_conditional" : null);
    if (filter !== null) {
      dropped.push({ key: plan.key, filter });
      continue;
    }
    if (
      (plan.bulk === true && droppedEarlier(mailed, inputs.closes, plan, zone)) ||
      isCalendarCopy(plan, inputs.events, zone) ||
      movedOn(plan, inputs.plans, inputs.events, today, zone)
    )
      continue;
    if (closed(plan.key, plan.match, due, plan.at)) {
      closeObligation(plan.what, due, inputs.owner, null);
      continue;
    }
    lines.set(lineOf(plan), [...(lines.get(lineOf(plan)) ?? []), { plan, due }]);
  }
  for (const statements of lines.values()) {
    const open = [...statements].sort((a, b) => orderOf(a.due, zone) - orderOf(b.due, zone));
    const next = open.find((one) => (dayOf(one.due, zone) as string) >= today);
    for (const { plan, due } of open.filter((one) => one === next || (dayOf(one.due, zone) as string) < today)) {
      const replied = plan.repliedAt !== undefined && plan.repliedAt > plan.at;
      add(
        { kind: "plan", id: plan.key, ...plan.refs },
        plan.what,
        due,
        inputs.owner,
        null,
        // What a mailing says is owed stays until it is done or a next step would lapse: an institution
        // goes on waiting past the date, where an appointment is over.
        owedInMail(mailed, plan, zone) ? OPEN_ITEM_LAPSE_DAYS : PAST_DUE_WINDOW_DAYS,
        { match: plan.match, at: plan.at },
        replied ? { repliedAt: new Date(plan.repliedAt as number).toISOString() } : {},
      );
    }
  }

  return {
    items: onceEach(items, closedObligations, calendarLines, inputs.events, zone),
    lapsed,
    replaced: [...replaced].filter((key) => !live.has(key)).sort(),
    dropped,
  };
}

// Whether the owner's close still stands. Only a new date ends a Drop, which holds for the words
// across statements and records (invariant 11). A Done holds for this item, and a later statement
// of it, which reached here so the read serves it, ends that too.
// `stored`, a reminder's own date, which a close from before it had a due holds.
const closedBy = (
  closes: readonly CloseInput[],
  id: string,
  match: string | null,
  due: string | null,
  at: number | null,
  stored: string | null = null,
): boolean =>
  closes.some((one) => {
    const dropped = one.ending === "dropped" && match !== null && one.match === match;
    if (one.key !== id && !dropped) return false;
    if (due !== null && due !== one.due && (stored === null || stored !== one.due)) return false;
    if (due === null && stored !== null && one.due !== null && one.due !== stored) return false;
    return dropped || one.ending === "dropped" || at === null || at <= Date.parse(one.at);
  });

// An obligation at its day, for what one item of it stands for: whoever acts on it, on its project.
const obligationAt = (
  zone: string | null,
  what: string | null,
  due: string | null,
  whoActs: Who,
  project: Who | null,
): string | null => {
  const day = due === null ? null : dayOf(due, zone);
  const words = what === null ? null : obligationOf(what);
  return day === null || words === null ? null : `${whoActs.id}\n${project?.id ?? ""}\n${day}\n${words}`;
};

// An agent's later report on a project replaces that agent's earlier steps for the owner: only its
// newest report's stand, all of them. A report with no step for the owner never reaches here, so it
// erases nothing, and another agent's replaces nothing of this one's.
function liveSteps(steps: readonly NextStepInput[]): { live: Set<string>; replaced: Set<string> } {
  const groupOf = (step: NextStepInput): string => `${step.project.id}\n${step.agent}`;
  const newest = new Map<string, NextStepInput>();
  for (const step of steps) {
    const best = newest.get(groupOf(step));
    if (best === undefined || step.at > best.at || (step.at === best.at && step.evidence < best.evidence))
      newest.set(groupOf(step), step);
  }
  const replaced = new Set<string>();
  const live = new Set<string>();
  for (const step of steps) {
    if (newest.get(groupOf(step))?.evidence === step.evidence) live.add(step.key);
    else replaced.add(step.key);
  }
  return { live, replaced };
}

// A mailing's line is no item when it says no deadline and fixes no date to attend, says it was done,
// advertises, or its sender has since said the same obligation again or that it was done. All of it
// is read from the lines the caller can see (`mailed`, the bulk ones); nothing is stored, and a reply
// on the thread plays no part.
const standsFor = (mailed: readonly PlanInput[], plan: PlanInput, later: PlanInput, zone: string | null): boolean =>
  sameNotice(plan, later, zone) &&
  later.key !== plan.key &&
  (later.at > plan.at || (later.at === plan.at && later.key < plan.key)) &&
  (saysDone(later.what)
    ? later.authed === true && coversLine(later, plan)
    : saysDeadline(owedWords(later.what)) && !advertises(later.what) && holdsLine(later, plan)) &&
  // A later line that could be either of two things the sender said is due ends neither.
  !mailed.some(
    (other) =>
      other.key !== plan.key &&
      other.key !== later.key &&
      !saysDone(other.what) &&
      sameNotice(other, later, zone) &&
      !sameNotice(other, plan, zone),
  );
function mailingDrop(mailed: readonly PlanInput[], plan: PlanInput, zone: string | null): RecallFilter | null {
  if (
    !saysDeadline(owedWords(plan.what)) &&
    !FIXES_ATTENDANCE.test(plan.what) &&
    !SPEAKS_OF_DONE.test(plan.what) &&
    !ASKS_ACTION.test(plan.what)
  )
    return "mail_no_deadline_word";
  if (saysDone(plan.what)) return "mail_says_done";
  if (advertises(plan.what)) return "mail_advertises";
  return mailed.some((later) => standsFor(mailed, plan, later, zone)) ? "mail_restated" : null;
}
// The owner's Drop of what a sender said holds for that sender's later lines of it (invariant 11). A Done
// does not: a later chase says it is still owed.
const droppedEarlier = (
  mailed: readonly PlanInput[],
  closes: readonly CloseInput[],
  plan: PlanInput,
  zone: string | null,
): boolean =>
  mailed.some(
    (older) =>
      older.at <= plan.at &&
      sameNotice(plan, older, zone) &&
      closes.some(
        (one) =>
          one.ending === "dropped" &&
          (one.key === older.key || one.match === older.match) &&
          one.due === dueOf(older.when),
      ),
  );
// The longest window of the lines it stands for, so a later line in other words shortens nothing.
const owedInMail = (mailed: readonly PlanInput[], plan: PlanInput, zone: string | null): boolean =>
  plan.bulk === true &&
  (OWED.test(owedWords(plan.what)) ||
    mailed.some((other) => sameNotice(plan, other, zone) && OWED.test(owedWords(other.what))));

// The items once each, ordered and dated. One obligation at one deadline, however many sources or
// reminders say it: the first source, a commitment before a step, a step before the calendar, the
// calendar before a plan; none the owner closed through another source.
function onceEach(
  items: readonly OpenItem[],
  closedObligations: ReadonlySet<string>,
  calendarLines: { day: string; words: string; reminder: boolean }[],
  events: readonly EventInput[],
  zone: string | null,
): OpenItem[] {
  const once = new Set<string>();
  const unique = items.filter((item) => {
    const obligation = obligationAt(zone, item.what?.untrusted ?? null, item.due, item.whoActs, item.project);
    if (obligation === null) return true;
    // A commitment closes as it does, never through another source's close.
    if (item.source.kind !== "commitment" && closedObligations.has(obligation)) return false;
    if (once.has(obligation)) return false;
    once.add(obligation);
    return true;
  });
  // Calendar lines of one deadline, worded apart: the line due that day stands, before one reminding of it.
  const merged = [...unique]
    .sort((a, b) => Number(a.remindAt !== undefined) - Number(b.remindAt !== undefined))
    .filter((item) => {
      const day = item.due === null ? null : dayOf(item.due, zone);
      const words = item.what === null ? null : obligationOf(item.what.untrusted);
      if (item.source.kind !== "calendar" || day === null || words === null) return true;
      const reminder = item.remindAt !== undefined;
      if (
        calendarLines.some((one) => one.day === day && (reminder || one.reminder) && sameCalendarLine(one.words, words))
      )
        return false;
      calendarLines.push({ day, words, reminder });
      return true;
    });
  merged.sort(
    (a, b) =>
      orderOf(a.due ?? a.remindAt ?? null, zone) - orderOf(b.due ?? b.remindAt ?? null, zone) ||
      (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0),
  );
  // Last, so two lines of one deadline were matched by the words they were written in. A reminder's words
  // are read against the day it fires on, not the day it is due.
  const eventDays = new Map(events.map((event) => [event.id, event.day]));
  return merged.map((item): OpenItem => {
    const day = item.source.kind === "calendar" ? eventDays.get(item.source.id) : undefined;
    return day === undefined || item.what === null
      ? item
      : { ...item, what: { untrusted: datedTitle(item.what.untrusted, day) } };
  });
}
