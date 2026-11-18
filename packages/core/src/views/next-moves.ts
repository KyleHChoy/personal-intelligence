import {
  dayIn,
  type MeetingView,
  NEXT_MOVE_ROOM,
  NEXT_MOVE_WHOLE_ROOM,
  type NextMove,
  type NextMoveKind,
  type NextMoves,
  type OpenItem,
  type OpportunityId,
  type UntrustedString,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS, daysBetween } from "../days.ts";
import { type Finding, reportsOfMeeting, withItemReports } from "./agent-reports.ts";
import { ownWords } from "./first-read.ts";

// What next: what holds now, as signals with their sources, composed from what one read already
// returned under the caller's token. Pure, no model, no clock of its own. It suggests nothing: agents
// decide. The block's order is fixed by kind and ranks nothing:
//
//   1. what is late, the owner's before what others owe, the least late first, since what is long
//      late has most likely ended some other way;
//   2. what falls due inside its window, the owner's first, the soonest first;
//   3. replies the owner owes, those a task has not looked at first, what asks for an answer before what does not,
//      the newest first in each, since one long unanswered has most likely ended some other way;
//   4. a date in the mail of a person the owner has never written to, late or due: any stranger can say "your
//      payment is due Friday", and the words alone must not stand with real work;
//   5. the next firm meeting, then one ahead of it whose title says it is moving.
//
// Late items, due items and replies share their room by what is there: each kind's first places are its own, and
// what a kind leaves goes to the rest of what is late, what falls due, what asks, then what is due within the week,
// and last, within the replies' own room, to a reply that asks nothing or that a task looked at.
//
// It moves nothing: an item keeps its date and its source's say, and what an agent reported stays
// marked unconfirmed all the way to the reader.

// `asks`: its subject, or its body where `bodyRead`, asks for an answer. No body's words go any further.
// `task`: a task looked at exactly this message and reported done, for a client that can list it.
export type OwedReply = {
  message: string;
  who: Who | null;
  what: UntrustedString | null;
  at: string;
  asks: boolean;
  bodyRead: boolean;
  task?: OpportunityId;
};

// A marker at the head of a meeting's own title, which whoever keeps the calendar wrote. Source text, so code
// may read it; pinned and narrow, so a title merely about a reschedule is nothing. What it says of a time is
// said to the reader, and the time stays the calendar's.
const MOVING_WORDS = "re-?schedul(?:e|ing|ed)|moved|moving|postponed|cancell?ed";
const MOVING_TITLE = new RegExp(
  `^\\s*(?:[\\[(]\\s*(?:${MOVING_WORDS})\\s*[\\])]|(?:${MOVING_WORDS})\\s*(?::|\\s[-\u2013\u2014]|[-\u2013\u2014]\\s))`,
  "i",
);
export const titleSaysMoving = (title: string | null | undefined): boolean =>
  title !== null && title !== undefined && MOVING_TITLE.test(title);

// A body asks for an answer: a question mark that ends a sentence, or a request in pinned English, in the
// writer's own words above any quote. It can miss one worded otherwise, and a question put to someone else on the
// thread reads as one to the owner. A sign-off ("let me know if you need anything") is none.
const ASKS_BODY =
  /\?(?:\s|$|["')\]])|\blet me know\b(?! if (?:you(?:['\u2019]d like| need| have any| have questions| want| would like| run into)|there(?:['\u2019]s| is| are) any(?:thing)?)| (?:of|about) any)|\bplease (?:confirm|reply|respond|advise|send|share|review|sign|rsvp)\b|\b(?:can|could|would) you\b|\bare you (?:free|available|able)\b|\bwhat do you think\b|\byour thoughts\b|\bdoes (?:that|this|it) work\b/i;
export const asksForAnswer = (body: string): boolean => ASKS_BODY.test(ownWords(body));
const ASKS_SUBJECT =
  /\?\s*$|\bquick question\b|\b(?:can|could|would) you\b|\brsvp\b|\bplease confirm\b|\baction required\b/i;
export const subjectAsks = (subject: string): boolean => ASKS_SUBJECT.test(subject);
// Whether a reply asks: a body that was read decides, since a thread's subject stays what its first message asked.
export const replyAsks = (subject: string | undefined, body: string | undefined): boolean =>
  body !== undefined ? asksForAnswer(body) : subject !== undefined && subjectAsks(subject);

// The meetings a read holds, the earliest first: the first firm one that is no repeating slot, or else the first firm
// slot, and one ahead of it whose own title says it is moving, which holds no place against a firm one. With none firm,
// the first alone.
export function meetingsToShow<Meeting extends { title: UntrustedString | null }>(
  meetings: readonly Meeting[],
  recurring: (meeting: Meeting) => boolean = () => false,
): { meeting: Meeting | null; moving: Meeting | null; slot?: Meeting } {
  const firm = (one: Meeting): boolean => !titleSaysMoving(one.title?.untrusted);
  const place = meetings.findIndex((one) => firm(one) && !recurring(one));
  const chosen = place >= 0 ? place : meetings.findIndex(firm);
  if (chosen < 0) return { meeting: meetings[0] ?? null, moving: null };
  const moving = meetings.slice(0, chosen).find((one) => !firm(one)) ?? null;
  const slot = meetings.slice(0, chosen).find(firm);
  return { meeting: meetings[chosen] as Meeting, moving, ...(slot === undefined ? {} : { slot }) };
}

const HOUR_MS = 3_600_000;
// How far ahead a dated item may take room that nothing nearer needs.
const COMING_DAYS = 7;
const UNCONFIRMED = "An agent reported this; nobody has confirmed it.";

const dayOfDate = (at: string, zone: string | null): string => (at.length === 10 ? at : dayIn(new Date(at), zone));
const days = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;
const isOwners = (item: OpenItem): boolean => item.whoActs.kind === "owner";

function moveOfItem(kind: NextMoveKind, item: OpenItem, at: string | null, why: string): NextMove {
  const reported = item.source.record !== undefined;
  return {
    kind,
    what: item.what,
    why: reported ? `${why} ${UNCONFIRMED}` : why,
    at: at as NextMove["at"],
    source: { kind: item.source.kind, id: item.source.id },
    ...(isOwners(item) ? {} : { who: item.whoActs }),
    ...(reported ? { unconfirmed: true as const } : {}),
    ...(item.reported === undefined ? {} : { reported: item.reported }),
  };
}

function lateMove(item: OpenItem): NextMove {
  const late =
    item.lateDays === null || item.lateDays === 0 ? "Was due earlier today." : `Late by ${days(item.lateDays)}.`;
  return moveOfItem("overdue", item, item.due ?? item.remindAt ?? null, isOwners(item) ? late : `Owed to you. ${late}`);
}

function dueMove(item: OpenItem, today: string, zone: string | null): NextMove {
  const at = (item.due ?? item.remindAt) as string;
  const left = daysBetween(today, dayOfDate(at, zone));
  const when = left <= 0 ? "today" : left === 1 ? "tomorrow" : `in ${days(left)}`;
  const said = item.due === null ? `Reminder for ${when}.` : `Due ${when}.`;
  return moveOfItem("due_soon", item, at, isOwners(item) ? said : `Owed to you. ${said}`);
}

function replyMove(reply: OwedReply, today: string, zone: string | null): NextMove {
  const ago = daysBetween(dayOfDate(reply.at, zone), today);
  const when = ago <= 0 ? "today" : `${days(ago)} ago`;
  const said = reply.asks
    ? "It asks for an answer."
    : reply.bodyRead
      ? "Nothing in it asks for an answer."
      : "Code read only its subject, which asks nothing.";
  return {
    kind: "reply",
    what: reply.what,
    why:
      reply.task === undefined
        ? `They wrote ${when} on a thread you are in, and nothing from you since. ${said}`
        : `They wrote ${when}, and nothing from you since. A task looked and reported done, maybe with a draft: list_opportunities, scope closed.`,
    ...(reply.asks ? { asks: true as const } : {}),
    ...(reply.task === undefined ? {} : { task: reply.task }),
    at: reply.at as NextMove["at"],
    source: { kind: "message", id: reply.message as NextMove["source"]["id"] },
    ...(reply.who === null ? {} : { who: reply.who }),
  };
}

function meetingMove(
  meeting: MeetingView,
  now: Date,
  findings: readonly Finding[],
  zone: string | null,
  kind: "plain" | "recurring" | "one_off" = "plain",
): NextMove {
  const start = meeting.startsAt as string;
  const hours = Math.max(0, Math.round((Date.parse(start) - now.getTime()) / HOUR_MS));
  const reported = reportsOfMeeting(findings, {
    day: dayIn(new Date(start), zone),
    names: meeting.participants.flatMap((one) => (one.kind === "person" ? (one.name?.untrusted ?? []) : [])),
  });
  const when =
    hours === 0
      ? "within the hour"
      : hours < 48
        ? `in ${hours} ${hours === 1 ? "hour" : "hours"}`
        : `in ${days(Math.round(hours / 24))}`;
  const moving = titleSaysMoving(meeting.title?.untrusted);
  const lead = moving
    ? `On your calendar ${when}, but its title says it is being moved or called off: do not count on the time.`
    : kind === "recurring"
      ? `A recurring slot on your calendar, ${when}; code cannot say you mean to go.`
      : kind === "one_off"
        ? `Your next one-off meeting, ${when}; a recurring slot comes first.`
        : `Your next meeting, ${when}.`;
  return {
    kind: "meeting",
    what: meeting.title,
    why: `${lead}${reported.length === 0 ? "" : " An agent's note is beside it, unconfirmed."}`,
    at: start as NextMove["at"],
    source: { kind: "event", id: meeting.id },
    ...(moving ? { moving: true as const } : {}),
    ...(kind === "recurring" && !moving ? { recurring: true as const } : {}),
    ...(reported.length === 0 ? {} : { reported }),
  };
}

export function composeNext(input: {
  now: Date;
  zone: string | null;
  // Every open item the read returned, soonest first.
  items: readonly OpenItem[];
  // Whether the read of replies ran out before the replies did.
  more: boolean;
  replies: readonly OwedReply[];
  meeting: MeetingView | null;
  // A meeting ahead of `meeting` whose own title says it is moving.
  moving?: MeetingView | null;
  // `meeting` is a slot that repeats.
  recurring?: boolean;
  // A repeating slot ahead of `meeting`, a one-off: `more` until `moves` shows it.
  slot?: MeetingView | undefined;
  findings: readonly Finding[];
  hours: { due: number };
  // Room for every kind (get_self's `moves`), in place of a first read's few.
  whole?: boolean;
  // Room of the caller's own, past either.
  room?: Readonly<Record<NextMoveKind, number>>;
  // The items' ids a person the owner has never written to gave them.
  strangers?: ReadonlySet<string>;
}): NextMoves {
  const { now, zone, hours } = input;
  const today = dayIn(now, zone);
  const lastDueDay = dayIn(new Date(now.getTime() + hours.due * HOUR_MS), zone);
  const lastDueAt = now.getTime() + hours.due * HOUR_MS;
  const items = input.items.filter(
    (item) =>
      item.source.id !== input.meeting?.id && item.source.id !== input.moving?.id && item.source.id !== input.slot?.id,
  );
  const owners = (a: OpenItem, b: OpenItem): number => Number(isOwners(b)) - Number(isOwners(a));
  const fromStranger = (item: OpenItem): boolean => input.strangers?.has(item.source.id) === true;
  const overdue = items
    .filter((item) => item.overdue && !fromStranger(item))
    .sort((a, b) => owners(a, b) || (a.lateDays ?? 0) - (b.lateDays ?? 0));
  const inWindow = (item: OpenItem): boolean => {
    const at = item.due ?? item.remindAt ?? null;
    if (at === null || item.overdue) return false;
    // A reminder with no deadline whose date has passed is never overdue, and it does not fall due either.
    if (at.length === 10) return at >= today && at <= lastDueDay;
    return Date.parse(at) >= now.getTime() && Date.parse(at) <= lastDueAt;
  };
  const dueSoon = items.filter((item) => inWindow(item) && !fromStranger(item)).sort(owners);
  const strangers = items.filter((item) => fromStranger(item) && (item.overdue || inWindow(item)));
  const lastComingDay = dayIn(new Date(now.getTime() + COMING_DAYS * DAY_MS), zone);
  const coming = items.filter((item) => {
    const at = item.due ?? item.remindAt ?? null;
    if (at === null || item.overdue || inWindow(item) || fromStranger(item)) return false;
    const day = dayOfDate(at, zone);
    return day >= today && day <= lastComingDay && (at.length === 10 || Date.parse(at) >= now.getTime());
  });
  const replies = [...input.replies].sort(
    (a, b) =>
      Number(a.task !== undefined) - Number(b.task !== undefined) ||
      Number(b.asks) - Number(a.asks) ||
      (a.at < b.at ? 1 : a.at > b.at ? -1 : a.message < b.message ? -1 : 1),
  );
  const meetingMoves =
    input.meeting === null
      ? []
      : [
          meetingMove(
            input.meeting,
            now,
            input.findings,
            zone,
            input.recurring === true ? "recurring" : input.slot === undefined ? "plain" : "one_off",
          ),
        ];
  const room = input.room ?? (input.whole === true ? NEXT_MOVE_WHOLE_ROOM : NEXT_MOVE_ROOM);
  const asking = replies.filter((reply) => reply.asks && reply.task === undefined);
  const others = replies.filter((reply) => !asking.includes(reply));
  // Each kind's first places, then what they leave, in the order the head of this file gives.
  let late = Math.min(room.overdue, overdue.length);
  let due = Math.min(room.due_soon, dueSoon.length);
  let asks = Math.min(room.reply, asking.length);
  let left = room.overdue + room.due_soon + room.reply - late - due - asks;
  const fill = (have: number, all: number): number => {
    const added = Math.min(left, all - have);
    left -= added;
    return have + added;
  };
  late = fill(late, overdue.length);
  due = fill(due, dueSoon.length);
  asks = fill(asks, asking.length);
  const comingShown = fill(0, coming.length);
  const othersShown = fill(0, Math.min(others.length, Math.max(0, room.reply - asks)));
  const strangersShown = fill(0, strangers.length);
  const shownDue = withItemReports([...dueSoon.slice(0, due), ...coming.slice(0, comingShown)], input.findings, zone);
  const shownLate = withItemReports(overdue.slice(0, late), input.findings, zone);
  const moves = [
    ...shownLate.map(lateMove),
    ...shownDue.map((item) => dueMove(item, today, zone)),
    ...[...asking.slice(0, asks), ...others.slice(0, othersShown)].map((reply) => replyMove(reply, today, zone)),
    ...withItemReports(strangers.slice(0, strangersShown), input.findings, zone).map((item) =>
      item.overdue ? lateMove(item) : dueMove(item, today, zone),
    ),
    ...meetingMoves,
    ...(input.moving === null || input.moving === undefined
      ? []
      : [meetingMove(input.moving, now, input.findings, zone)]),
    ...(input.whole === true && input.slot !== undefined
      ? [meetingMove(input.slot, now, input.findings, zone, "recurring")]
      : []),
  ];
  return {
    moves,
    more:
      input.more ||
      (input.whole !== true && input.slot !== undefined) ||
      late < overdue.length ||
      due < dueSoon.length ||
      asks + othersShown < replies.length ||
      strangersShown < strangers.length,
  };
}
