import type { Closeness, WarmthRules } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  type RankInput,
  type RuledTier,
  rankAudience,
  type WarmthFields,
  type WarmthInput,
  type WarmthMeeting,
  type WarmthMessage,
  warmthOf,
  warmthRules,
} from "./warmth.ts";

// Every expected value below is derived here from the warmth tier's formulas, never read from the
// implementation. Synthetic ids and made-up timestamps only.

const RULES = warmthRules();
const DAY = 86_400_000;
const TODAY = "2026-10-22T12:00:00.000Z";
const TODAY_DAY = Math.floor(Date.parse(TODAY) / DAY);
const UTC = "UTC";

// A day `age` days before TODAY, at `hour` UTC.
const ago = (age: number, hour = 12) => new Date((TODAY_DAY - age) * DAY + hour * 3_600_000).toISOString();

const out = (
  at: string,
  thread: string,
  recipients = 1,
  channel: WarmthMessage["channel"] = "email",
): WarmthMessage => ({ at, direction: "out", recipients, thread, channel });
const inn = (
  at: string,
  thread: string,
  recipients = 1,
  channel: WarmthMessage["channel"] = "email",
): WarmthMessage => ({ at, direction: "in", recipients, thread, channel });
const meet = (at: string, attendees: number): WarmthMeeting => ({ at, attendees });
const input = (messages: WarmthMessage[] = [], meetings: WarmthMeeting[] = []): WarmthInput => ({ messages, meetings });
const of = (i: WarmthInput, today = TODAY, timeZone = UTC) => warmthOf(i, RULES, today, timeZone);

// The fast clock's day weight, and the slow clock's.
const w = (age: number) => 0.5 ** (age / RULES.activeHalfLifeDays);
const slow = (age: number) => 0.5 ** (age / RULES.depthHalfLifeDays);
const day = (iso: string | null) => (iso === null ? null : iso.slice(0, 10));

// A direct recomputation of `active` at the end of `asOf` (a UTC day number): every day's
// value summed with its weight, no forward pass. The reference the implementation must agree with.
function refActive(i: WarmthInput, asOf: number): number {
  const add = (m: Map<number, number>, d: number, v: number) => m.set(d, (m.get(d) ?? 0) + v);
  const outs = new Map<number, number>();
  const ins = new Map<number, number>();
  const meets = new Map<number, number>();
  const started = new Map<number, number>();
  const dayOf = (iso: string) => Math.floor(Date.parse(iso) / DAY);
  for (const m of i.messages) {
    const d = dayOf(m.at);
    if (d <= asOf) add(m.direction === "out" ? outs : ins, d, 1 / m.recipients);
  }
  for (const m of i.meetings) {
    const d = dayOf(m.at);
    const weight =
      m.attendees === 2
        ? RULES.oneToOneMeetingWeight
        : m.attendees <= RULES.meetingMaxAttendees
          ? RULES.meetingWeight
          : 0;
    if (d <= asOf) add(meets, d, weight);
  }
  // A chat's who-starts threads are its conversations, cut at a gap of
  // chatConversationGapMinutes or more.
  const threads = new Map<string, WarmthMessage[]>();
  const talkOf = new Map<WarmthMessage, string>();
  const chats = new Map<string, WarmthMessage[]>();
  for (const m of i.messages) if (m.channel === "chat") chats.set(m.thread, [...(chats.get(m.thread) ?? []), m]);
  for (const [thread, lines] of chats) {
    let n = 0;
    [...lines]
      .sort((a, b) => a.at.localeCompare(b.at))
      .forEach((m, k, sorted) => {
        if (k > 0 && Date.parse(m.at) - Date.parse(sorted[k - 1]!.at) >= RULES.chatConversationGapMinutes * 60_000)
          n += 1;
        talkOf.set(m, `${thread}#${n}`);
      });
  }
  for (const m of i.messages) {
    const talk = talkOf.get(m) ?? m.thread;
    threads.set(talk, [...(threads.get(talk) ?? []), m]);
  }
  for (const msgs of threads.values()) {
    const sorted = [...msgs].sort((a, b) => a.at.localeCompare(b.at));
    const answer = sorted.find((m) => m.direction === "in");
    if (sorted[0]!.direction === "out" && answer !== undefined && dayOf(answer.at) <= asOf)
      add(started, dayOf(answer.at), 1);
  }
  const sum = (m: Map<number, number>, cap: number) =>
    [...m].reduce((s, [d, v]) => s + Math.min(cap, v) * w(asOf - d), 0);
  return (
    Math.sqrt(sum(outs, 1) * sum(ins, 1)) +
    sum(meets, Infinity) +
    RULES.answeredThreadWeight * sum(started, RULES.answeredStartsPerDayMax)
  );
}

// The depth recomputed directly: the best month-end `active` (and `asOf` itself), faded by the slow
// clock.
function refDepth(i: WarmthInput, asOf: number): number {
  const first = Math.min(...[...i.messages, ...i.meetings].map((r) => Math.floor(Date.parse(r.at) / DAY)));
  const checkpoints = [asOf];
  const cursor = new Date(first * DAY);
  for (;;) {
    const monthEnd = Math.floor(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0) / DAY);
    if (monthEnd >= asOf) break;
    checkpoints.push(monthEnd);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return Math.max(...checkpoints.map((c) => refActive(i, c) * slow(asOf - c)));
}

// Within the two decimals the fields carry.
const near = (actual: number, expected: number, tolerance = 0.011) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);

describe("warmthOf: what counts", () => {
  it("ten unanswered cold emails give active 0, warmth 0 and twoWay false", () => {
    const f = of(input(Array.from({ length: 10 }, (_, k) => out(ago(k * 3), `cold-${k}`))));
    expect(f.active).toBe(0);
    expect(f.depth).toBe(0);
    expect(f.warmth).toBe(0);
    expect(f.twoWay).toBe(false);
    expect(f.firstTwoWayAt).toBeNull();
    expect(f.lastTwoWayAt).toBeNull();
    expect(f.theyStart).toBeNull();
    expect(f.channels).toEqual([]);
    // Ten runs, none answered: a rate of 0, not a thin sample.
    expect(f.replyRate).toBe(0);
    expect(f.replyHours).toBeNull();
  });

  it("the person's mail alone, never answered, is one-way too", () => {
    const f = of(input(Array.from({ length: 10 }, (_, k) => inn(ago(k), `news-${k}`))));
    expect(f.active).toBe(0);
    expect(f.twoWay).toBe(false);
  });

  it("a 40-person meeting adds 0, a 1:1 adds 1.5, a meeting of three to ten adds 1 (at age 0)", () => {
    const base = [out(ago(0, 9), "t1"), inn(ago(0, 10), "t2")];
    expect(of(input(base)).active).toBe(1);
    expect(of(input(base, [meet(ago(0), 40)])).active).toBe(1);
    expect(of(input(base, [meet(ago(0), RULES.meetingMaxAttendees + 1)])).active).toBe(1);
    expect(of(input(base, [meet(ago(0), 2)])).active).toBe(2.5);
    expect(of(input(base, [meet(ago(0), 3)])).active).toBe(2);
    expect(of(input(base, [meet(ago(0), RULES.meetingMaxAttendees)])).active).toBe(2);
  });

  it("a meeting above the attendee cap is no two-way contact; a 1:1 alone is", () => {
    const big = of(input([], [meet(ago(0), 40)]));
    expect(big.active).toBe(0);
    expect(big.twoWay).toBe(false);
    const oneToOne = of(input([], [meet(ago(0), 2)]));
    expect(oneToOne.active).toBe(1.5);
    expect(oneToOne.twoWay).toBe(true);
    expect(oneToOne.channels).toEqual(["calendar"]);
  });

  it("fifty messages each way on one day count as one day each way", () => {
    const busy = [
      ...Array.from({ length: 50 }, (_, k) => out(ago(0, 1 + (k % 20)), `busy-${k}`)),
      ...Array.from({ length: 50 }, (_, k) => inn(ago(0, 1 + (k % 20)), `busy-in-${k}`)),
    ];
    const once = [out(ago(0, 9), "a"), inn(ago(0, 10), "b")];
    expect(of(input(busy)).active).toBe(1);
    expect(of(input(busy)).active).toBe(of(input(once)).active);
  });

  it("a message to five people counts a fifth for each, each way", () => {
    expect(of(input([out(ago(0, 9), "a", 5), inn(ago(0, 10), "b", 5)])).active).toBe(0.2);
    // Five fifths on one day make a whole day, and no more than one.
    const fifths = Array.from({ length: 7 }, (_, k) => out(ago(0, 1 + k), `f-${k}`, 5));
    expect(of(input([...fifths, inn(ago(0, 10), "b")])).active).toBe(1);
  });

  it("the geometric mean of the two ways, each decayed by its age", () => {
    const f = of(input([out(ago(10), "a"), inn(ago(20), "b")]));
    near(f.active, Math.sqrt(w(10) * w(20)));
  });

  it("a thread the owner started and the person answered adds answeredThreadWeight; one the person started adds nothing", () => {
    const heStarted = of(input([out(ago(0, 9), "t"), inn(ago(0, 10), "t")]));
    const theyStarted = of(input([inn(ago(0, 9), "t"), out(ago(0, 10), "t")]));
    expect(heStarted.active).toBe(1 + RULES.answeredThreadWeight);
    expect(theyStarted.active).toBe(1);
  });

  it("an answered thread is credited on the answer's day, so `past` excludes an answer given since", () => {
    // Started 30 days ago, answered 10 days ago; `past` is as of 21 days ago.
    const f = of(input([out(ago(30), "t"), inn(ago(10), "t")]));
    near(f.active, Math.sqrt(w(30) * w(10)) + RULES.answeredThreadWeight * w(10));
    expect(f.past.active).toBe(0);
    expect(f.past.twoWay).toBe(false);
    expect(f.past.lastTwoWayAt).toBeNull();
    expect(f.twoWay).toBe(true);
  });

  it("days fall in the owner's time zone", () => {
    // 23:30 and 00:30 UTC are two days in UTC and one evening in New York (UTC-4 in October).
    const rows = input([
      out("2026-10-21T23:30:00.000Z", "a"),
      out("2026-10-22T00:30:00.000Z", "b"),
      inn("2026-10-22T12:00:00.000Z", "c"),
    ]);
    near(of(rows, TODAY, UTC).active, Math.sqrt((w(1) + 1) * 1));
    near(of(rows, TODAY, "America/New_York").active, Math.sqrt(w(1) * 1));
  });
});

describe("warmthOf: the slow clock and the sort key", () => {
  // Four 1:1 meetings ending on a month end exactly 730 days before `today`.
  const today = "2026-10-31T12:00:00.000Z";
  const peak = [28, 29, 30, 31].map((d) => meet(`2024-10-${d}T15:00:00.000Z`, 2));
  const peakActive = RULES.oneToOneMeetingWeight * (1 + w(1) + w(2) + w(3));

  it("a person at active about 6 two years ago and silent since keeps depth about 3 and warmth about 1.5", () => {
    expect(peakActive).toBeGreaterThan(5.8);
    const f = warmthOf(input([], peak), RULES, today, UTC);
    near(f.depth, peakActive * 0.5);
    near(f.depth, 3, 0.1);
    near(f.warmth, RULES.depthFactor * peakActive * 0.5);
    near(f.warmth, 1.5, 0.05);
    expect(f.active).toBeLessThan(0.01);
    expect(f.twoWay).toBe(true);
    // No two-way contact in the last 365 days: no channel.
    expect(f.channels).toEqual([]);
  });

  it("warmth is the greater of active and depthFactor × depth", () => {
    const recent = of(input([out(ago(0, 9), "a"), inn(ago(0, 10), "b")]));
    expect(recent.depth).toBe(1);
    expect(recent.warmth).toBe(1);
  });
});

describe("warmthOf: the forward pass equals direct recomputation", () => {
  // A deterministic synthetic history of about 420 days.
  let seed = 7;
  const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const messages: WarmthMessage[] = [];
  for (let t = 0; t < 90; t++) {
    let age = Math.floor(rand() * 420);
    let direction: WarmthMessage["direction"] = rand() < 0.5 ? "out" : "in";
    const length = 1 + Math.floor(rand() * 4);
    // A thread is a mail thread or a chat, never both.
    const channel = pick(["email", "email", "chat"] as const);
    for (let k = 0; k < length && age >= 0; k++) {
      messages.push({
        at: ago(age, 1 + Math.floor(rand() * 22)),
        direction,
        recipients: pick([1, 1, 1, 2, 5, 10]),
        thread: `thread-${t}`,
        channel,
      });
      if (rand() < 0.7) direction = direction === "out" ? "in" : "out";
      age -= 1 + Math.floor(rand() * 20);
    }
  }
  const meetings = Array.from({ length: 20 }, () =>
    meet(ago(Math.floor(rand() * 420), 15), pick([2, 2, 3, 6, 10, 12, 40])),
  );
  const history = input(messages, meetings);

  it("active today equals the sum over every earlier day recomputed directly", () => {
    const f = of(history);
    expect(refActive(history, TODAY_DAY)).toBeGreaterThan(0.5);
    near(f.active, refActive(history, TODAY_DAY));
  });

  it("depth equals the best month-end active faded by the slow clock", () => {
    near(of(history).depth, refDepth(history, TODAY_DAY));
  });

  it("past equals the same fields recomputed from the rows dated on or before today − hysteresisDays", () => {
    const f = of(history);
    const then = TODAY_DAY - RULES.hysteresisDays;
    near(f.past.active, refActive(history, then));
    near(f.past.depth, refDepth(history, then));
    near(f.past.warmth, Math.max(refActive(history, then), RULES.depthFactor * refDepth(history, then)), 0.02);
    if (f.past.lastTwoWayAt !== null) expect(Date.parse(f.past.lastTwoWayAt)).toBeLessThan((then + 1) * DAY);
  });

  it("at a month end, active is that day's direct value and depth at least that", () => {
    const monthEnd = "2026-08-31T20:00:00.000Z";
    const f = of(history, monthEnd);
    const d = Math.floor(Date.parse(monthEnd) / DAY);
    near(f.active, refActive(history, d));
    near(f.depth, refDepth(history, d));
    expect(f.depth).toBeGreaterThanOrEqual(f.active);
  });

  it("active, depth and warmth carry two decimals", () => {
    const f = of(history);
    for (const v of [f.active, f.depth, f.warmth]) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
  });
});

describe("warmthOf: two-way days and channels", () => {
  it("first and last two-way days come from a day with mail each way, or a kept meeting", () => {
    const f = of(input([out(ago(100, 9), "a"), inn(ago(100, 15), "a"), out(ago(50), "lonely")], [meet(ago(3), 2)]));
    expect(day(f.firstTwoWayAt)).toBe(day(ago(100)));
    expect(day(f.lastTwoWayAt)).toBe(day(ago(3)));
  });

  it("channels are those with contact each way in 365 days", () => {
    const f = of(
      input(
        [
          out(ago(10), "e1"),
          inn(ago(12), "e2"),
          out(ago(5), "c1", 1, "chat"),
          out(ago(400), "c2", 1, "chat"),
          inn(ago(400), "c2", 1, "chat"),
        ],
        [meet(ago(20), 4)],
      ),
    );
    expect([...f.channels].sort()).toEqual(["calendar", "email"]);
  });
});

describe("warmthOf: responsiveness", () => {
  it("replyRate is null below replyMinRuns runs", () => {
    const f = of(
      input([
        out(ago(40), "a"),
        inn(ago(39), "a"),
        out(ago(30), "b"),
        inn(ago(29), "b"),
        out(ago(20), "c"),
        inn(ago(19), "c"),
      ]),
    );
    expect(f.replyRate).toBeNull();
  });

  it("consecutive messages from the owner in a thread are one run; 2 of 4 runs answered within 14 days give 0.5", () => {
    const f = of(
      input([
        // Thread a: a run of two, answered 24 hours after the run's last message.
        out(ago(60, 9), "a"),
        out(ago(59, 9), "a"),
        inn(ago(58, 9), "a"),
        // Thread b: answered 72 hours later.
        out(ago(50, 9), "b"),
        inn(ago(47, 9), "b"),
        // Threads c and d: never answered.
        out(ago(40, 9), "c"),
        out(ago(30, 9), "d"),
      ]),
    );
    expect(f.replyRate).toBe(0.5);
    expect(f.replyHours).toBe(48);
  });

  it("an answer on day 15 does not count; one on day 13 does", () => {
    const rows = (lateAnswer: number) =>
      input([
        out(ago(80), "a"),
        inn(ago(79), "a"),
        out(ago(70), "b"),
        inn(ago(69), "b"),
        out(ago(60), "c"),
        inn(ago(60 - lateAnswer), "c"),
        out(ago(30), "d"),
      ]);
    expect(of(rows(15)).replyRate).toBe(0.5);
    expect(of(rows(13)).replyRate).toBe(0.75);
  });

  it("runs older than responsivenessWindowDays are not counted", () => {
    const old = Array.from({ length: 5 }, (_, k) => [
      out(ago(400 + k * 2), `old-${k}`),
      inn(ago(399 + k * 2), `old-${k}`),
    ]).flat();
    expect(of(input(old)).replyRate).toBeNull();
  });

  it("theyStart counts only threads with a message each way", () => {
    const f = of(
      input([
        inn(ago(50, 9), "they"),
        out(ago(50, 10), "they"),
        out(ago(40, 9), "he-1"),
        inn(ago(40, 10), "he-1"),
        out(ago(30, 9), "he-2"),
        inn(ago(30, 10), "he-2"),
        inn(ago(20), "they-only"),
        out(ago(10), "he-only"),
      ]),
    );
    near(f.theyStart!, 1 / 3, 0.006);
  });

  it("responsiveness never changes active, depth or warmth", () => {
    const fast = of(input([out(ago(5, 8), "t"), inn(ago(5, 9), "t"), out(ago(3, 8), "u"), inn(ago(3, 9), "u")]));
    const slowReply = of(input([out(ago(5, 8), "t"), inn(ago(5, 20), "t"), out(ago(3, 8), "u"), inn(ago(3, 21), "u")]));
    expect(fast.replyHours).not.toBe(slowReply.replyHours);
    expect([slowReply.active, slowReply.depth, slowReply.warmth]).toEqual([fast.active, fast.depth, fast.warmth]);
  });
});

// Chats as direct messages, under version 3's rules.
const chatOut = (at: string, chat = "chat-1", recipients = 1) => out(at, chat, recipients, "chat");
const chatIn = (at: string, chat = "chat-1", recipients = 1) => inn(at, chat, recipients, "chat");
const at = (age: number, hour: number, minute = 0) =>
  new Date((TODAY_DAY - age) * DAY + hour * 3_600_000 + minute * 60_000).toISOString();

describe("warmthOf: answered starts capped a day", () => {
  it("five conversations the owner opened and the person answered on one day add answeredThreadWeight once, not five times", () => {
    expect(RULES.version).toBe(3);
    expect(RULES.answeredStartsPerDayMax).toBe(1);
    // Five conversations two hours apart, each the owner's line then the person's ten minutes later.
    const lines = [8, 10, 12, 14, 16].flatMap((hour) => [chatOut(at(0, hour)), chatIn(at(0, hour, 10))]);
    expect(of(input(lines)).active).toBe(1 + RULES.answeredThreadWeight);
  });

  it("a mail day with two answered threads the owner started adds answeredThreadWeight once", () => {
    const f = of(input([out(ago(0, 8), "a"), inn(ago(0, 9), "a"), out(ago(0, 10), "b"), inn(ago(0, 11), "b")]));
    expect(f.active).toBe(1 + RULES.answeredThreadWeight);
  });
});

describe("warmthOf: chats count as direct messages", () => {
  it("a hundred chat lines each way on one day count as one day each way, as one email does", () => {
    const chat = of(input(Array.from({ length: 100 }, (_, k) => [chatOut(at(3, 9, k)), chatIn(at(3, 9, k))]).flat()));
    const mail = of(input([out(ago(3, 9), "m"), inn(ago(3, 10), "m")]));
    near(chat.active, Math.sqrt(w(3) * w(3)) + RULES.answeredThreadWeight * w(3));
    expect(chat.active).toBe(mail.active);
  });

  it("a chat's line shared with others counts 1/n, and a chat with more than directMaxRecipients others counts for nobody", () => {
    near(
      of(input([chatOut(at(0, 9), "g", 3), chatIn(at(0, 9, 10), "g", 3)])).active,
      1 / 3 + RULES.answeredThreadWeight,
    );
    const big = of(
      input([
        chatOut(at(0, 9), "g", RULES.directMaxRecipients + 1),
        chatIn(at(0, 9, 10), "g", RULES.directMaxRecipients + 1),
      ]),
    );
    expect([big.active, big.twoWay]).toEqual([0, false]);
  });

  it("a conversation is cut at chatConversationGapMinutes: the person's opening line after two hours' silence counts toward theyStart, a line ten minutes after the owner's does not", () => {
    expect(RULES.chatConversationGapMinutes).toBe(30);
    const f = of(
      input([
        // Conversation 1: the owner opens, the person answers ten minutes later.
        chatOut(at(5, 9)),
        chatIn(at(5, 9, 10)),
        // Conversation 2, two hours later: the person opens, the owner answers.
        chatIn(at(5, 11, 10)),
        chatOut(at(5, 11, 20)),
      ]),
    );
    expect(f.theyStart).toBe(0.5);
    // One chat thread alone would give one sample, started by the owner.
    const one = of(input([chatOut(at(5, 9)), chatIn(at(5, 9, 10)), chatIn(at(5, 9, 25)), chatOut(at(5, 9, 40))]));
    expect(one.theyStart).toBe(0);
  });

  it("a gap of exactly chatConversationGapMinutes starts a new conversation; one minute less does not", () => {
    const opened = (gap: number) =>
      of(input([chatOut(at(5, 9)), chatIn(at(5, 9, 5)), chatIn(at(5, 9, 5 + gap)), chatOut(at(5, 9, 6 + gap))]))
        .theyStart;
    expect(opened(30)).toBe(0.5);
    expect(opened(29)).toBe(0);
  });

  it("a reply the next morning answers the owner's last line of the night: the chat is one thread for reply runs", () => {
    // Four runs, each the owner's line late at night and the person's answer at eight the next morning.
    const f = of(input([40, 30, 20, 10].flatMap((age) => [chatOut(at(age, 23)), chatIn(at(age - 1, 8))])));
    expect(f.replyRate).toBe(1);
    expect(f.replyHours).toBe(9);
  });

  it("an answered start in a chat is credited on the answer's day; an answer after the gap opens a conversation of its own", () => {
    // The owner opens just before midnight; the person answers twenty minutes later, past midnight: the answer's day.
    const f = of(input([chatOut(at(1, 23, 50)), chatIn(at(0, 0, 10))]));
    near(f.active, Math.sqrt(w(1) * w(0)) + RULES.answeredThreadWeight * w(0));
    // Answered eight hours later: two conversations, one the owner's unanswered and one the person's,
    // so no answered start.
    const late = of(input([chatOut(at(1, 22)), chatIn(at(0, 6))]));
    near(late.active, Math.sqrt(w(1) * w(0)));
  });

  it("channels holds chat for two-way chat within 365 days, and not for one-way or old chat", () => {
    expect(of(input([chatOut(ago(10)), chatIn(ago(9))])).channels).toEqual(["chat"]);
    expect(of(input([chatOut(ago(10)), chatOut(ago(9))])).channels).toEqual([]);
    expect(of(input([chatOut(ago(400)), chatIn(ago(399))])).channels).toEqual([]);
  });

  it("chat and mail with one person add up by day, the same as two mails would", () => {
    const mixed = of(input([out(ago(2, 9), "m"), chatIn(ago(2, 10))]));
    const mail = of(input([out(ago(2, 9), "m"), inn(ago(2, 10), "n")]));
    expect(mixed.active).toBe(mail.active);
    expect([...mixed.channels].sort()).toEqual([]);
  });
});

// Ranks, over fields built directly: rankAudience reads only the fields.
const ULID = "01JABCDEFGHJKMNPQRSTVWXY";
const id = (n: number) => `ent_${ULID}${n.toString(36).toUpperCase().padStart(2, "0")}`;
type Now = {
  warmth: number;
  depth?: number;
  active?: number;
  twoWay?: boolean;
  lastTwoWayAt?: string | null;
  contactDays?: number;
};
function fields(now: Now, past?: Now): WarmthFields {
  // A fixture meets the tier floors unless it sets its own days.
  const full = (x: Now) => ({
    warmth: x.warmth,
    depth: x.depth ?? x.warmth,
    active: x.active ?? x.warmth,
    twoWay: x.twoWay ?? true,
    lastTwoWayAt: x.lastTwoWayAt === undefined ? ago(1) : x.lastTwoWayAt,
    contactDays: x.contactDays ?? 30,
  });
  const n = full(now);
  const p = full(past ?? now);
  return {
    ...n,
    firstTwoWayAt: n.twoWay ? ago(500) : null,
    replyRate: null,
    replyHours: null,
    theyStart: null,
    channels: [],
    past: p,
  };
}
const person = (n: number, now: Now, past?: Now, closeness?: Closeness): RankInput => ({
  id: id(n),
  fields: fields(now, past),
  ...(closeness === undefined ? {} : { closeness }),
});
const oneWay = (n: number): RankInput => ({
  id: id(n),
  fields: fields({ warmth: 0, twoWay: false, lastTwoWayAt: null }),
});
const tiersOf = (ranked: Map<string, { tier: string }>) => {
  const counts: Record<string, number> = {};
  for (const r of ranked.values()) counts[r.tier] = (counts[r.tier] ?? 0) + 1;
  return counts;
};
// `count` two-way people, person k at warmth count − k: rank k + 1, ids 1 to count.
const ladder = (count: number, from = 1) =>
  Array.from({ length: count }, (_, k) => person(from + k, { warmth: count - k }));

describe("rankAudience: tiers by rank", () => {
  it("200 two-way people give 5, 10, 35, 100 and 50; one-way people take no rank", () => {
    const people = [...ladder(200), ...Array.from({ length: 20 }, (_, k) => oneWay(300 + k))];
    const ranked = rankAudience(people, RULES);
    expect(ranked.size).toBe(220);
    expect(tiersOf(ranked)).toEqual({ inner: 5, close: 10, regular: 35, known: 100, outer: 50, "one-way": 20 });
    for (let k = 1; k <= 5; k++) expect(ranked.get(id(k))!.tier).toBe("inner");
    expect(ranked.get(id(6))!.tier).toBe("close");
    expect(ranked.get(id(16))!.tier).toBe("regular");
    expect(ranked.get(id(51))!.tier).toBe("known");
    expect(ranked.get(id(151))!.tier).toBe("outer");
    for (const r of ranked.values()) {
      expect(r.tierSource).toBe("inferred");
      expect(r.dormant).toBe(false);
    }
    expect(ranked.get(id(300))!.tier).toBe("one-way");
  });

  it("ties break by depth, then the later lastTwoWayAt, then id, the same in any input order", () => {
    const rules: WarmthRules = { ...RULES, caps: [1, 2, 3, 4] };
    const people = [
      person(5, { warmth: 5, depth: 4, lastTwoWayAt: ago(30) }),
      person(4, { warmth: 5, depth: 4, lastTwoWayAt: ago(30) }),
      person(3, { warmth: 5, depth: 4, lastTwoWayAt: ago(20) }),
      person(2, { warmth: 5, depth: 4, lastTwoWayAt: ago(2) }),
      person(1, { warmth: 5, depth: 6, lastTwoWayAt: ago(40) }),
    ];
    const expected = { [id(1)]: "inner", [id(2)]: "close", [id(3)]: "regular", [id(4)]: "known", [id(5)]: "outer" };
    for (const order of [people, [...people].reverse(), [people[2]!, people[0]!, people[4]!, people[1]!, people[3]!]]) {
      const ranked = rankAudience(order, rules);
      expect(Object.fromEntries([...ranked].map(([k, v]) => [k, v.tier]))).toEqual(expected);
    }
  });
});

describe("rankAudience: the owner's labels", () => {
  it("two labelled inner take inner whatever their score and leave three inferred inner slots", () => {
    const people = [
      ...ladder(30),
      person(100, { warmth: 0.01 }, undefined, "inner"),
      person(101, { warmth: 0, twoWay: false, lastTwoWayAt: null }, undefined, "inner"),
    ];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "inner", tierSource: "owner", dormant: false });
    expect(ranked.get(id(101))).toEqual({ tier: "inner", tierSource: "owner", dormant: false });
    for (let k = 1; k <= 3; k++)
      expect(ranked.get(id(k))).toEqual({ tier: "inner", tierSource: "inferred", dormant: false });
    expect(ranked.get(id(4))!.tier).toBe("close");
    expect(tiersOf(ranked).inner).toBe(5);
  });

  it("a labelled inner who also ranks first takes one slot, not two", () => {
    const people = [person(100, { warmth: 1000 }, undefined, "inner"), ...ladder(30)];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "inner", tierSource: "owner", dormant: false });
    for (let k = 1; k <= 4; k++) expect(ranked.get(id(k))!.tier).toBe("inner");
    expect(ranked.get(id(5))!.tier).toBe("close");
    expect(tiersOf(ranked).inner).toBe(5);
  });

  it("a labelled dormant is outer and dormant, above every one-way, and takes no ranked slot", () => {
    const people = [
      person(100, { warmth: 1000 }, undefined, "dormant"),
      person(101, { warmth: 0, twoWay: false, lastTwoWayAt: null }, undefined, "dormant"),
      ...ladder(30),
      oneWay(200),
    ];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "outer", tierSource: "owner", dormant: true });
    expect(ranked.get(id(101))).toEqual({ tier: "outer", tierSource: "owner", dormant: true });
    expect(ranked.get(id(200))!.tier).toBe("one-way");
    for (let k = 1; k <= 5; k++) expect(ranked.get(id(k))!.tier).toBe("inner");
    expect(ranked.get(id(6))!.tier).toBe("close");
  });

  it("a labelled active leaves the score to decide", () => {
    const ranked = rankAudience([...ladder(30), person(100, { warmth: 0.5 }, undefined, "active")], RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "regular", tierSource: "inferred", dormant: false });
  });

  it("a label overrides hysteresis", () => {
    // Inner by both ranks, labelled dormant: served outer.
    const ranked = rankAudience([...ladder(30), person(100, { warmth: 1000 }, { warmth: 1000 }, "dormant")], RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "outer", tierSource: "owner", dormant: true });
  });
});

describe("rankAudience: the owner's tier rulings", () => {
  const ruled = (input: RankInput, tier: RuledTier): RankInput => ({ ...input, ruledTier: tier });

  it("a ruled person takes the ruled tier whatever the score, with no floor, and shrinks the cuts of that tier and every tier below", () => {
    // Two ruled inner (one with no two-way contact, one short of every floor) and three ruled
    // regular: inner's inferred places 5 − 2 = 3, close's cumulative 15 − 2 = 13 (10 close),
    // regular's 50 − 5 = 45 (32 regular), known's 150 − 5 = 145.
    const people = [
      ...ladder(200),
      ruled(person(300, { warmth: 0, twoWay: false, lastTwoWayAt: null }), "inner"),
      ruled(person(301, { warmth: 0.01, contactDays: 0 }), "inner"),
      ...[302, 303, 304].map((n) => ruled(person(n, { warmth: 1000 }), "regular")),
    ];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(300))).toEqual({ tier: "inner", tierSource: "owner", dormant: false });
    expect(ranked.get(id(301))).toEqual({ tier: "inner", tierSource: "owner", dormant: false });
    expect(ranked.get(id(302))).toMatchObject({ tier: "regular", tierSource: "owner" });
    expect(tiersOf(ranked)).toEqual({ inner: 5, close: 10, regular: 35, known: 100, outer: 55 });
    for (let k = 1; k <= 3; k++) expect(ranked.get(id(k))).toMatchObject({ tier: "inner", tierSource: "inferred" });
    expect(ranked.get(id(4))!.tier).toBe("close");
    expect(ranked.get(id(13))!.tier).toBe("close");
    expect(ranked.get(id(14))!.tier).toBe("regular");
    expect(ranked.get(id(45))!.tier).toBe("regular");
    expect(ranked.get(id(46))!.tier).toBe("known");
    expect(ranked.get(id(145))!.tier).toBe("known");
    expect(ranked.get(id(146))!.tier).toBe("outer");
  });

  it("a ruled outer takes no ranked place, and a ruled person ranking first frees the place", () => {
    const people = [ruled(person(100, { warmth: 1000 }), "outer"), ...ladder(30)];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "outer", tierSource: "owner", dormant: false });
    for (let k = 1; k <= 5; k++) expect(ranked.get(id(k))!.tier).toBe("inner");
    expect(ranked.get(id(6))!.tier).toBe("close");
  });

  it("a ruling beats a closeness label, and the label's inner slot is not taken", () => {
    const people = [ruled(person(100, { warmth: 1000 }, undefined, "inner"), "regular"), ...ladder(30)];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "regular", tierSource: "owner", dormant: false });
    // Five inferred inner: the ruled regular counts against regular's cut, not inner's.
    for (let k = 1; k <= 5; k++) expect(ranked.get(id(k))!.tier).toBe("inner");
    expect(ranked.get(id(15))!.tier).toBe("close");
    expect(ranked.get(id(16))!.tier).toBe("regular");
  });

  it("a confirmed dormant still sets the dormant state on a ruled person", () => {
    const ranked = rankAudience(
      [ruled(person(100, { warmth: 1000 }, undefined, "dormant"), "close"), ...ladder(30)],
      RULES,
    );
    expect(ranked.get(id(100))).toEqual({ tier: "close", tierSource: "owner", dormant: true });
  });

  it("no hysteresis holds a ruled person at a better past rank", () => {
    const ranked = rankAudience([...ladder(30), ruled(person(100, { warmth: 0.5 }, { warmth: 1000 }), "known")], RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "known", tierSource: "owner", dormant: false });
  });
});

describe("rankAudience: hysteresis", () => {
  // Thirty people whose warmth did not change; ranks 1 to 30 at warmth 30 down to 1.
  it("a person who fell from close to regular within hysteresisDays is served close", () => {
    // Now at rank 18 (regular); as of 21 days ago at rank 8 (close).
    const ranked = rankAudience([...ladder(30), person(100, { warmth: 13.5 }, { warmth: 23.5 })], RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "close", tierSource: "inferred", dormant: false });
  });

  it("one who fell before that is served regular", () => {
    const ranked = rankAudience([...ladder(30), person(100, { warmth: 13.5 }, { warmth: 13.5 })], RULES);
    expect(ranked.get(id(100))!.tier).toBe("regular");
  });

  it("a rise shows at once", () => {
    // Now rank 3 (inner); as of 21 days ago rank 31 (regular), or no two-way contact at all.
    expect(
      rankAudience([...ladder(30), person(100, { warmth: 28.5 }, { warmth: 0.5 })], RULES).get(id(100))!.tier,
    ).toBe("inner");
    expect(
      rankAudience(
        [...ladder(30), person(100, { warmth: 28.5 }, { warmth: 0, twoWay: false, lastTwoWayAt: null })],
        RULES,
      ).get(id(100))!.tier,
    ).toBe("inner");
  });
});

describe("rankAudience: dormant", () => {
  it("dormant holds for a person top 15 by depth and outside top 50 by active, and never lowers the tier", () => {
    // Sixty people with active = depth = warmth, 60 down to 1.
    const people = [
      ...ladder(60),
      // Top by depth, last by active: dormant; rank 12 by warmth, so still close.
      person(100, { warmth: 50, depth: 100, active: 0.1 }),
      // Rank 21 by depth, last by active: not dormant.
      person(101, { warmth: 21, depth: 42, active: 0.1 }),
      // Top by depth, rank 10 by active: not dormant.
      person(102, { warmth: 51.5, depth: 99, active: 51.5 }),
    ];
    const ranked = rankAudience(people, RULES);
    expect(ranked.get(id(100))).toEqual({ tier: "close", tierSource: "inferred", dormant: true });
    expect(ranked.get(id(101))!.dormant).toBe(false);
    expect(ranked.get(id(102))!.dormant).toBe(false);
  });
});
