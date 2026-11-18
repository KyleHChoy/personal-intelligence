import {
  type Closeness,
  TIERS,
  type Tier,
  type TierSource,
  type WarmthChannel,
  WarmthRules,
} from "@intelligence/contracts/personal";
import { DAY_MS, HOUR_MS } from "../days.ts";
import { repoFile } from "../repo-root.ts";

// The warmth tier: pure functions over one audience's rows. The store reads the rows and stores
// the result; nothing here reads a database, calls a model or keeps state, and `today` is the
// only clock.

// One direct message between the owner and the person: already filtered by the store to at most
// `directMaxRecipients` person recipients, never held, bulk or automated. `recipients` is the
// message's person recipients, the owner counted on a message to the owner.
export type WarmthMessage = {
  at: string;
  direction: "out" | "in";
  recipients: number;
  thread: string;
  channel: "email" | "chat";
};

// One meeting the owner kept with the person a participant; `attendees` counts the owner.
export type WarmthMeeting = { at: string; attendees: number };

export type WarmthInput = { messages: readonly WarmthMessage[]; meetings: readonly WarmthMeeting[] };

// The per-person fields, as of `today`, and the three the hysteresis rank needs as of
// `today − hysteresisDays`.
export type WarmthFields = {
  active: number;
  depth: number;
  warmth: number;
  twoWay: boolean;
  firstTwoWayAt: string | null;
  lastTwoWayAt: string | null;
  replyRate: number | null;
  replyHours: number | null;
  theyStart: number | null;
  channels: WarmthChannel[];
  // The days in the responsiveness window on which the person wrote to
  // or met the owner (a counted meeting), for the tier floors.
  contactDays: number;
  past: {
    active: number;
    depth: number;
    warmth: number;
    twoWay: boolean;
    lastTwoWayAt: string | null;
    contactDays: number;
  };
};

// A tier the owner may rule: any ranked tier.
export type RuledTier = Exclude<Tier, "one-way">;

// One person of an audience for the ranks: the group's representative id, its fields, the owner's
// confirmed closeness when the audience reads it, and the owner's tier ruling when the audience sees one.
export type RankInput = {
  id: string;
  fields: WarmthFields;
  closeness?: Closeness | undefined;
  ruledTier?: RuledTier | undefined;
};

export type RankedTier = { tier: Tier; tierSource: TierSource; dormant: boolean };

const round2 = (value: number): number => Math.round(value * 100) / 100;

// A calendar day as a whole number of days since the epoch, and back.
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
const isMonthEnd = (day: number): boolean => new Date((day + 1) * DAY_MS).getUTCDate() === 1;

type Row = { day: number; ms: number };
// `talk`, the thread who-starts reads: a mail's thread, or one
// conversation of a chat, cut at `chatConversationGapMinutes`.
type Msg = WarmthMessage & Row & { talk: string };
type Meet = WarmthMeeting & Row & { weight: number };

// The first and last two-way contact, as the instants of the rows that set them. The rule names the
// first and last day with a direct message each way, or such a meeting. Read as one day holding
// both directions, an exchange across two days (one side writes on Monday, the other answers on
// Tuesday) would never count, so the first is the earliest instant by which a message each way had
// occurred (the later of the first out and the first in), and the last, once mail has gone both
// ways, is the latest message either way; a counted meeting is two-way contact on its own. So the
// last is never before the first, which the earlier of the last out and the last in would allow.
// Instants, not days, since `WarmthLine` serves a `Timestamp`; the day in the owner's zone follows
// from it.
function twoWaySpan(
  messages: readonly Msg[],
  meetings: readonly Meet[],
): { twoWay: boolean; first: Row | null; last: Row | null } {
  let firstOut: Row | null = null,
    firstIn: Row | null = null,
    lastOut: Row | null = null,
    lastIn: Row | null = null;
  for (const one of messages) {
    if (one.direction === "out") {
      if (firstOut === null || one.ms < firstOut.ms) firstOut = one;
      if (lastOut === null || one.ms >= lastOut.ms) lastOut = one;
    } else {
      if (firstIn === null || one.ms < firstIn.ms) firstIn = one;
      if (lastIn === null || one.ms >= lastIn.ms) lastIn = one;
    }
  }
  const counted = meetings.filter((one) => one.weight > 0);
  const candidatesFirst: Row[] = counted.slice();
  const candidatesLast: Row[] = counted.slice();
  if (firstOut !== null && firstIn !== null) candidatesFirst.push(firstOut.ms >= firstIn.ms ? firstOut : firstIn);
  if (lastOut !== null && lastIn !== null) candidatesLast.push(lastOut.ms >= lastIn.ms ? lastOut : lastIn);
  if (candidatesFirst.length === 0) return { twoWay: false, first: null, last: null };
  const first = candidatesFirst.reduce((a, b) => (b.ms < a.ms ? b : a));
  const last = candidatesLast.reduce((a, b) => (b.ms > a.ms ? b : a));
  return { twoWay: true, first, last };
}

// Runs of the owner's messages in a thread, answered by the person's next message in that
// thread within `replyWindowDays`; who started each thread with a message each way. Over the
// messages given, already cut to the window. A run still waiting at `today` counts as unanswered.
// A chat is one thread for reply runs, and its conversations are the threads of who starts.
function responsiveness(
  messages: readonly Msg[],
  rules: WarmthRules,
): Pick<WarmthFields, "replyRate" | "replyHours" | "theyStart"> {
  let runs = 0;
  const answers: number[] = [];
  let mutual = 0,
    theirs = 0;
  for (const talk of groupBy(messages, (one) => one.talk).values()) {
    if (talk.some((one) => one.direction === "out") && talk.some((one) => one.direction === "in")) {
      mutual += 1;
      if (talk[0]!.direction === "in") theirs += 1;
    }
  }
  for (const thread of groupBy(messages, (one) => one.thread).values()) {
    for (let i = 0; i < thread.length; i += 1) {
      if (thread[i]!.direction !== "out" || thread[i + 1]?.direction === "out") continue;
      runs += 1;
      const answer = thread[i + 1];
      const hours = answer === undefined ? Infinity : (answer.ms - thread[i]!.ms) / HOUR_MS;
      if (hours <= rules.replyWindowDays * 24) answers.push(hours);
    }
  }
  return {
    replyRate: runs < rules.replyMinRuns ? null : round2(answers.length / runs),
    replyHours: answers.length === 0 ? null : round2(median(answers)),
    theyStart: mutual === 0 ? null : round2(theirs / mutual),
  };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Each thread's (or conversation's) messages in time order (the input order breaks a tie).
function groupBy(messages: readonly Msg[], key: (one: Msg) => string): Map<string, Msg[]> {
  const threads = new Map<string, Msg[]>();
  for (const one of messages) {
    const thread = threads.get(key(one));
    if (thread === undefined) threads.set(key(one), [one]);
    else thread.push(one);
  }
  for (const thread of threads.values()) thread.sort((a, b) => a.ms - b.ms);
  return threads;
}

// Each chat message's conversation, a run of the chat's lines with no gap of `gapMinutes` or more,
// numbered within its chat; a mail's is its thread. Sets `talk` in place.
function cutConversations(messages: Msg[], gapMinutes: number): void {
  for (const one of messages) one.talk = `${one.channel}\n${one.thread}`;
  for (const [thread, lines] of groupBy(
    messages.filter((one) => one.channel === "chat"),
    (one) => one.thread,
  )) {
    let n = 0;
    lines.forEach((one, i) => {
      if (i > 0 && one.ms - lines[i - 1]!.ms >= gapMinutes * 60_000) n += 1;
      one.talk = `chat\n${thread}\n${n}`;
    });
  }
}

// One person's fields from their rows, days in `timeZone` (the owner's), as of `today` (an ISO
// timestamp). Rows dated after today's day are left out.
export function warmthOf(input: WarmthInput, rules: WarmthRules, today: string, timeZone: string): WarmthFields {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOf = (at: number): number => dayNumber(format.format(new Date(at)));
  const now = dayOf(Date.parse(today));
  const pastDay = now - rules.hysteresisDays;

  const messages: Msg[] = [];
  for (const one of input.messages) {
    const ms = Date.parse(one.at);
    const day = dayOf(ms);
    if (day <= now && one.recipients <= rules.directMaxRecipients) messages.push({ ...one, ms, day, talk: one.thread });
  }
  cutConversations(messages, rules.chatConversationGapMinutes);
  const meetings: Meet[] = [];
  for (const one of input.meetings) {
    const ms = Date.parse(one.at);
    const day = dayOf(ms);
    const weight =
      one.attendees <= 2
        ? rules.oneToOneMeetingWeight
        : one.attendees <= rules.meetingMaxAttendees
          ? rules.meetingWeight
          : 0;
    if (day <= now) meetings.push({ ...one, ms, day, weight });
  }

  // Each day's values. A thread the owner started is credited on the day of the person's first
  // answer in it; for a chat, a conversation.
  const out = new Map<number, number>(),
    into = new Map<number, number>(),
    meet = new Map<number, number>(),
    started = new Map<number, number>();
  const add = (map: Map<number, number>, day: number, value: number): void =>
    void map.set(day, (map.get(day) ?? 0) + value);
  for (const one of messages) add(one.direction === "out" ? out : into, one.day, 1 / Math.max(1, one.recipients));
  for (const one of meetings) if (one.weight > 0) add(meet, one.day, one.weight);
  for (const thread of groupBy(messages, (one) => one.talk).values()) {
    const answer = thread[0]!.direction === "out" ? thread.find((one) => one.direction === "in") : undefined;
    if (answer !== undefined) add(started, answer.day, 1);
  }

  // One forward pass. Each sum decays a day at the fast half-life, then adds the
  // day's value; `held` is the best month-end `active` faded at the slow half-life to the current day.
  const fast = 2 ** (-1 / rules.activeHalfLifeDays);
  const slow = 2 ** (-1 / rules.depthHalfLifeDays);
  const start = [...messages, ...meetings].reduce((least, one) => Math.min(least, one.day), now);
  let sOut = 0,
    sIn = 0,
    sMeet = 0,
    sStarted = 0,
    held = 0;
  let nowScores = { active: 0, depth: 0 },
    pastScores = { active: 0, depth: 0 };
  for (let day = start; day <= now; day += 1) {
    sOut = sOut * fast + Math.min(1, out.get(day) ?? 0);
    sIn = sIn * fast + Math.min(1, into.get(day) ?? 0);
    sMeet = sMeet * fast + (meet.get(day) ?? 0);
    // Answered starts capped a day, every channel, as each direction is.
    sStarted = sStarted * fast + Math.min(rules.answeredStartsPerDayMax, started.get(day) ?? 0);
    held *= slow;
    const active = Math.sqrt(sOut * sIn) + sMeet + rules.answeredThreadWeight * sStarted;
    const scores = { active, depth: Math.max(held, active) };
    if (day === pastDay) pastScores = scores;
    if (day === now) nowScores = scores;
    if (isMonthEnd(day)) held = Math.max(held, active);
  }
  const warmthFrom = (scores: { active: number; depth: number }): number =>
    Math.max(scores.active, rules.depthFactor * scores.depth);

  const span = twoWaySpan(messages, meetings);
  const pastSpan = twoWaySpan(
    messages.filter((one) => one.day <= pastDay),
    meetings.filter((one) => one.day <= pastDay),
  );
  const instant = (row: Row | null): string | null => (row === null ? null : new Date(row.ms).toISOString());

  // Responsiveness and two-way contact over the last `responsivenessWindowDays` days (365 for
  // channels).
  const recent = messages.filter((one) => now - one.day < rules.responsivenessWindowDays);
  const both = (channel: WarmthMessage["channel"]): boolean =>
    recent.some((one) => one.channel === channel && one.direction === "out") &&
    recent.some((one) => one.channel === channel && one.direction === "in");
  const channels: WarmthChannel[] = [];
  if (both("email")) channels.push("email");
  if (meetings.some((one) => one.weight > 0 && now - one.day < rules.responsivenessWindowDays))
    channels.push("calendar");
  if (both("chat")) channels.push("chat");

  // The person's own days of contact, as of a day, within the window.
  const contactDaysAsOf = (asOf: number): number =>
    new Set(
      [
        ...messages.filter((one) => one.direction === "in").map((one) => one.day),
        ...meetings.filter((one) => one.weight > 0).map((one) => one.day),
      ].filter((day) => day <= asOf && asOf - day < rules.responsivenessWindowDays),
    ).size;

  return {
    active: round2(nowScores.active),
    depth: round2(nowScores.depth),
    warmth: round2(warmthFrom(nowScores)),
    twoWay: span.twoWay,
    firstTwoWayAt: instant(span.first),
    lastTwoWayAt: instant(span.last),
    ...responsiveness(recent, rules),
    channels,
    contactDays: contactDaysAsOf(now),
    past: {
      active: round2(pastScores.active),
      depth: round2(pastScores.depth),
      warmth: round2(warmthFrom(pastScores)),
      twoWay: pastSpan.twoWay,
      lastTwoWayAt: instant(pastSpan.last),
      contactDays: contactDaysAsOf(pastDay),
    },
  };
}

// One person's contact on one day of the owner's zone, under one label: only statistics that add up
// across labels and across a group's members, so the read sums the days a viewer is cleared for.
// `day` is the day's number since the epoch. Thread-level figures (answered starts, reply runs, who
// starts) are counted within the label and dated by the day they turn on: the answer for an
// answered start, the owner's message for a reply run, the talk's first message for who starts.
export type WarmthDay = {
  day: number;
  outW: number;
  inW: number;
  meetW: number;
  emailOut: number;
  emailIn: number;
  chatOut: number;
  chatIn: number;
  meetN: number;
  started: number;
  runs: number;
  answered: number;
  answerHours: number;
  mutual: number;
  theirs: number;
  firstOutAt: number | null;
  lastOutAt: number | null;
  firstInAt: number | null;
  lastInAt: number | null;
  firstMeetAt: number | null;
  lastMeetAt: number | null;
};

const emptyDay = (day: number): WarmthDay => ({
  day,
  outW: 0,
  inW: 0,
  meetW: 0,
  emailOut: 0,
  emailIn: 0,
  chatOut: 0,
  chatIn: 0,
  meetN: 0,
  started: 0,
  runs: 0,
  answered: 0,
  answerHours: 0,
  mutual: 0,
  theirs: 0,
  firstOutAt: null,
  lastOutAt: null,
  firstInAt: null,
  lastInAt: null,
  firstMeetAt: null,
  lastMeetAt: null,
});
const least = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const most = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

// Days of one or more lists added together, by day, in day order.
export function mergeDays(lists: readonly (readonly WarmthDay[])[]): WarmthDay[] {
  const out = new Map<number, WarmthDay>();
  for (const list of lists)
    for (const one of list) {
      const held = out.get(one.day);
      if (held === undefined) {
        out.set(one.day, { ...one });
        continue;
      }
      held.outW += one.outW;
      held.inW += one.inW;
      held.meetW += one.meetW;
      held.emailOut += one.emailOut;
      held.emailIn += one.emailIn;
      held.chatOut += one.chatOut;
      held.chatIn += one.chatIn;
      held.meetN += one.meetN;
      held.started += one.started;
      held.runs += one.runs;
      held.answered += one.answered;
      held.answerHours += one.answerHours;
      held.mutual += one.mutual;
      held.theirs += one.theirs;
      held.firstOutAt = least(held.firstOutAt, one.firstOutAt);
      held.lastOutAt = most(held.lastOutAt, one.lastOutAt);
      held.firstInAt = least(held.firstInAt, one.firstInAt);
      held.lastInAt = most(held.lastInAt, one.lastInAt);
      held.firstMeetAt = least(held.firstMeetAt, one.firstMeetAt);
      held.lastMeetAt = most(held.lastMeetAt, one.lastMeetAt);
    }
  return [...out.values()].sort((a, b) => a.day - b.day);
}

// One person's rows under one label as days, in `timeZone` (the owner's). Every row, whatever its
// date: the read cuts at its own day.
export function warmthDays(input: WarmthInput, rules: WarmthRules, timeZone: string): WarmthDay[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOf = (at: number): number => dayNumber(format.format(new Date(at)));
  const days = new Map<number, WarmthDay>();
  const of = (day: number): WarmthDay => {
    const held = days.get(day);
    if (held !== undefined) return held;
    const made = emptyDay(day);
    days.set(day, made);
    return made;
  };
  const messages: Msg[] = [];
  for (const one of input.messages) {
    const ms = Date.parse(one.at);
    if (one.recipients <= rules.directMaxRecipients) messages.push({ ...one, ms, day: dayOf(ms), talk: one.thread });
  }
  cutConversations(messages, rules.chatConversationGapMinutes);
  for (const one of messages) {
    const day = of(one.day);
    const share = 1 / Math.max(1, one.recipients);
    if (one.direction === "out") {
      day.outW += share;
      if (one.channel === "chat") day.chatOut += 1;
      else day.emailOut += 1;
      day.firstOutAt = least(day.firstOutAt, one.ms);
      day.lastOutAt = most(day.lastOutAt, one.ms);
    } else {
      day.inW += share;
      if (one.channel === "chat") day.chatIn += 1;
      else day.emailIn += 1;
      day.firstInAt = least(day.firstInAt, one.ms);
      day.lastInAt = most(day.lastInAt, one.ms);
    }
  }
  for (const one of input.meetings) {
    const weight =
      one.attendees <= 2
        ? rules.oneToOneMeetingWeight
        : one.attendees <= rules.meetingMaxAttendees
          ? rules.meetingWeight
          : 0;
    if (weight <= 0) continue;
    const ms = Date.parse(one.at);
    const day = of(dayOf(ms));
    day.meetW += weight;
    day.meetN += 1;
    day.firstMeetAt = least(day.firstMeetAt, ms);
    day.lastMeetAt = most(day.lastMeetAt, ms);
  }
  for (const talk of groupBy(messages, (one) => one.talk).values()) {
    const first = talk[0]!;
    const answer = first.direction === "out" ? talk.find((one) => one.direction === "in") : undefined;
    if (answer !== undefined) of(answer.day).started += 1;
    if (talk.some((one) => one.direction === "out") && talk.some((one) => one.direction === "in")) {
      of(first.day).mutual += 1;
      if (first.direction === "in") of(first.day).theirs += 1;
    }
  }
  for (const thread of groupBy(messages, (one) => one.thread).values()) {
    for (let i = 0; i < thread.length; i += 1) {
      if (thread[i]!.direction !== "out" || thread[i + 1]?.direction === "out") continue;
      const day = of(thread[i]!.day);
      day.runs += 1;
      const answer = thread[i + 1];
      const hours = answer === undefined ? Infinity : (answer.ms - thread[i]!.ms) / HOUR_MS;
      if (hours <= rules.replyWindowDays * 24) {
        day.answered += 1;
        day.answerHours += hours;
      }
    }
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

// warmthOf from days (mergeDays of every label the viewer is cleared for, and of a group's
// members), as of `today` in `timeZone`. The same fields, but for what does not add up: the reply
// time is the mean of the answered runs, not their median, and the thread-level figures are counted
// within each label, whole, by the day they turn on rather than cut at the window's edge.
export function warmthOfDays(
  given: readonly WarmthDay[],
  rules: WarmthRules,
  today: string,
  timeZone: string,
): WarmthFields {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const now = dayNumber(format.format(new Date(Date.parse(today))));
  const pastDay = now - rules.hysteresisDays;
  const days = given.filter((one) => one.day <= now);
  const byDay = new Map(days.map((one) => [one.day, one]));

  const fast = 2 ** (-1 / rules.activeHalfLifeDays);
  const slow = 2 ** (-1 / rules.depthHalfLifeDays);
  const start = days.reduce((low, one) => Math.min(low, one.day), now);
  let sOut = 0,
    sIn = 0,
    sMeet = 0,
    sStarted = 0,
    held = 0;
  let nowScores = { active: 0, depth: 0 },
    pastScores = { active: 0, depth: 0 };
  for (let day = start; day <= now; day += 1) {
    const one = byDay.get(day);
    sOut = sOut * fast + Math.min(1, one?.outW ?? 0);
    sIn = sIn * fast + Math.min(1, one?.inW ?? 0);
    sMeet = sMeet * fast + (one?.meetW ?? 0);
    sStarted = sStarted * fast + Math.min(rules.answeredStartsPerDayMax, one?.started ?? 0);
    held *= slow;
    const active = Math.sqrt(sOut * sIn) + sMeet + rules.answeredThreadWeight * sStarted;
    const scores = { active, depth: Math.max(held, active) };
    if (day === pastDay) pastScores = scores;
    if (day === now) nowScores = scores;
    if (isMonthEnd(day)) held = Math.max(held, active);
  }
  const warmthFrom = (scores: { active: number; depth: number }): number =>
    Math.max(scores.active, rules.depthFactor * scores.depth);

  const span = (upTo: number): { twoWay: boolean; first: number | null; last: number | null } => {
    let firstOut: number | null = null,
      firstIn: number | null = null,
      lastOut: number | null = null,
      lastIn: number | null = null,
      firstMeet: number | null = null,
      lastMeet: number | null = null;
    for (const one of days) {
      if (one.day > upTo) continue;
      firstOut = least(firstOut, one.firstOutAt);
      lastOut = most(lastOut, one.lastOutAt);
      firstIn = least(firstIn, one.firstInAt);
      lastIn = most(lastIn, one.lastInAt);
      firstMeet = least(firstMeet, one.firstMeetAt);
      lastMeet = most(lastMeet, one.lastMeetAt);
    }
    const first = least(firstMeet, firstOut !== null && firstIn !== null ? Math.max(firstOut, firstIn) : null);
    const last = most(lastMeet, lastOut !== null && lastIn !== null ? Math.max(lastOut, lastIn) : null);
    return first === null ? { twoWay: false, first: null, last: null } : { twoWay: true, first, last };
  };
  const nowSpan = span(now);
  const pastSpan = span(pastDay);
  const instant = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

  const recent = days.filter((one) => now - one.day < rules.responsivenessWindowDays);
  const sum = (pick: (one: WarmthDay) => number): number => recent.reduce((total, one) => total + pick(one), 0);
  const channels: WarmthChannel[] = [];
  if (sum((one) => one.emailOut) > 0 && sum((one) => one.emailIn) > 0) channels.push("email");
  if (sum((one) => one.meetN) > 0) channels.push("calendar");
  if (sum((one) => one.chatOut) > 0 && sum((one) => one.chatIn) > 0) channels.push("chat");
  const runs = sum((one) => one.runs);
  const answered = sum((one) => one.answered);
  const mutual = sum((one) => one.mutual);

  const contactDaysAsOf = (asOf: number): number =>
    days.filter(
      (one) =>
        one.day <= asOf &&
        asOf - one.day < rules.responsivenessWindowDays &&
        (one.emailIn + one.chatIn > 0 || one.meetN > 0),
    ).length;

  return {
    active: round2(nowScores.active),
    depth: round2(nowScores.depth),
    warmth: round2(warmthFrom(nowScores)),
    twoWay: nowSpan.twoWay,
    firstTwoWayAt: instant(nowSpan.first),
    lastTwoWayAt: instant(nowSpan.last),
    replyRate: runs < rules.replyMinRuns ? null : round2(answered / runs),
    replyHours: answered === 0 ? null : round2(sum((one) => one.answerHours) / answered),
    theyStart: mutual === 0 ? null : round2(sum((one) => one.theirs) / mutual),
    channels,
    contactDays: contactDaysAsOf(now),
    past: {
      active: round2(pastScores.active),
      depth: round2(pastScores.depth),
      warmth: round2(warmthFrom(pastScores)),
      twoWay: pastSpan.twoWay,
      lastTwoWayAt: instant(pastSpan.last),
      contactDays: contactDaysAsOf(pastDay),
    },
  };
}

type Scored = {
  id: string;
  warmth: number;
  depth: number;
  twoWay: boolean;
  lastTwoWayAt: string | null;
  contactDays: number;
};

// The ranked tier of each unlabelled, unruled two-way person, by warmth, then depth, then the later
// last two-way contact, then id, into the cumulative cuts given (`caps` less the places the owner's
// word took). The labelled were taken out before this, and only the inner cut shrinks by the
// labelled `inner`. Tiers fill in rank order, each person taking the best tier whose floor they
// meet (`tierFloors`, in days of contact) and whose cumulative cut is not yet full, so a
// one-exchange tie on a thin network never reaches `inner` or `close`, and the next person who
// qualifies moves up into the place it leaves.
function rankTiers(
  people: readonly Scored[],
  cutsOf: readonly [number, number, number, number],
  rules: WarmthRules,
): Map<string, Tier> {
  const ranked = people
    .filter((one) => one.twoWay)
    .sort(
      (a, b) =>
        b.warmth - a.warmth ||
        b.depth - a.depth ||
        (b.lastTwoWayAt ?? "").localeCompare(a.lastTwoWayAt ?? "") ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const cuts: [Tier, number, number][] = [
    ["inner", cutsOf[0], rules.tierFloors.inner],
    ["close", cutsOf[1], rules.tierFloors.close],
    ["regular", cutsOf[2], 0],
    ["known", cutsOf[3], 0],
  ];
  const filled = cuts.map(() => 0);
  const tiers = new Map<string, Tier>();
  for (const one of ranked) {
    // A tier's cut counts everyone placed in it or above, as the cumulative caps do.
    const at = cuts.findIndex(
      ([, cut, floor], i) => one.contactDays >= floor && filled.slice(0, i + 1).reduce((sum, n) => sum + n, 0) < cut,
    );
    if (at < 0) tiers.set(one.id, "outer");
    else {
      filled[at]! += 1;
      tiers.set(one.id, cuts[at]![0]);
    }
  }
  return tiers;
}

// The ids of the first `n` two-way people by one score, higher first, id breaking ties.
function topBy(people: readonly RankInput[], score: (fields: WarmthFields) => number, n: number): Set<string> {
  const ranked = people
    .filter((one) => one.fields.twoWay)
    .sort((a, b) => score(b.fields) - score(a.fields) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(ranked.slice(0, n).map((one) => one.id));
}

// Every person's served tier and dormant state within one audience. A ruled person takes the ruled
// tier, beating a closeness label, with no floor or hysteresis; ruled people are taken out of the
// ranking first and count against the cumulative cut of their tier and of every tier below it, so
// the inferred places shrink by the owner's. A confirmed `dormant` still sets the dormant state.
export function rankAudience(people: readonly RankInput[], rules: WarmthRules): Map<string, RankedTier> {
  const unruled = people.filter((one) => one.ruledTier === undefined);
  const unlabelled = unruled.filter((one) => one.closeness !== "inner" && one.closeness !== "dormant");
  const labelledInner = unruled.filter((one) => one.closeness === "inner").length;
  // The ruled in each ranked tier and above: inner's count against inner's cut, inner's and
  // close's against close's, and so on; a ruled `outer` takes no place.
  const ruledAtOrAbove = (["inner", "close", "regular", "known"] as const).map(
    (_, i) => people.filter((one) => one.ruledTier !== undefined && TIERS.indexOf(one.ruledTier) <= i).length,
  );
  const cuts = [
    Math.max(0, rules.caps[0] - labelledInner - ruledAtOrAbove[0]!),
    Math.max(0, rules.caps[1] - ruledAtOrAbove[1]!),
    Math.max(0, rules.caps[2] - ruledAtOrAbove[2]!),
    Math.max(0, rules.caps[3] - ruledAtOrAbove[3]!),
  ] as const;
  const nowTiers = rankTiers(
    unlabelled.map((one) => ({ id: one.id, ...one.fields })),
    cuts,
    rules,
  );
  const pastTiers = rankTiers(
    unlabelled.map((one) => ({ id: one.id, ...one.fields.past })),
    cuts,
    rules,
  );
  const deep = topBy(people, (fields) => fields.depth, rules.dormantDepthRank);
  const busy = topBy(people, (fields) => fields.active, rules.dormantActiveRank);

  const result = new Map<string, RankedTier>();
  for (const one of people) {
    const inferredDormant = deep.has(one.id) && !busy.has(one.id);
    if (one.ruledTier !== undefined)
      result.set(one.id, {
        tier: one.ruledTier,
        tierSource: "owner",
        dormant: one.closeness === "dormant" || inferredDormant,
      });
    else if (one.closeness === "inner")
      result.set(one.id, { tier: "inner", tierSource: "owner", dormant: inferredDormant });
    else if (one.closeness === "dormant") result.set(one.id, { tier: "outer", tierSource: "owner", dormant: true });
    else {
      const now = nowTiers.get(one.id) ?? "one-way";
      const past = pastTiers.get(one.id) ?? "one-way";
      const tier = TIERS.indexOf(past) < TIERS.indexOf(now) ? past : now;
      result.set(one.id, { tier, tierSource: "inferred", dormant: inferredDormant });
    }
  }
  return result;
}

// The rule table, `ontology/warmth.json`, parsed once.
export const warmthRules: () => WarmthRules = repoFile("ontology/warmth.json", (text) =>
  WarmthRules.parse(JSON.parse(text)),
);
