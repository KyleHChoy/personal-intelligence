import type { Who } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  composeOpenItems,
  type EventInput,
  isCalendarCopy,
  isReminderEvent,
  OPEN_ITEM_LAPSE_DAYS,
  type OpenInputs,
  PAST_DUE_WINDOW_DAYS,
  type PlanInput,
  saysDeadline,
  titledDeadline,
} from "./open-items.ts";

const NOW = new Date("2026-11-03T18:00:00.000Z");
const ZONE = "America/Chicago";
const DAY = 86_400_000;
const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as unknown as Who;
const hex = (n: number): string => String(n).padStart(64, "0");
const event = (over: Partial<EventInput> = {}): EventInput => ({
  id: `evt_${"1".repeat(26)}`,
  title: "Problem set 4 due",
  day: "2026-11-05",
  due: "2026-11-05",
  allDay: true,
  days: 1,
  minutes: 1440,
  others: 0,
  declined: false,
  ...over,
});
const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  key: hex(1),
  what: "Book the flight to Lisbon",
  match: `plan-${hex(1)}`,
  when: "2026-11-06",
  at: NOW.getTime() - DAY,
  ownMail: false,
  refs: { message: "msg_x" as never },
  ...over,
});
const inputs = (over: Partial<OpenInputs> = {}): OpenInputs => ({
  owner,
  commitments: [],
  nextSteps: [],
  plans: [],
  events: [],
  closes: [],
  ...over,
});
const compose = (over: Partial<OpenInputs> = {}) => composeOpenItems(inputs(over), NOW, ZONE);

describe("what code reads as a reminder or a deadline", () => {
  it.each([
    ["an all-day task of one day", {}, true],
    ["a holiday", { title: "Veterans Day" }, false],
    ["the clocks changing", { title: "Daylight Saving Time ends" }, false],
    ["a school break", { title: "Spring break" }, false],
    ["a note of where he is", { title: "In Elmhaven" }, false],
    ["a pay day", { title: "Pay day" }, false],
    ["an all-day line that asks nothing", { title: "Call the bank" }, false],
    ["a birthday", { title: "Sam's birthday" }, false],
    ["a trip of several days", { title: "Lisbon trip", days: 4 }, false],
    ["an all-day event with people", { title: "Team offsite", others: 3 }, false],
    ["an all-day deadline with people", { title: "Grant application deadline", others: 3 }, true],
    ["a declined one", { declined: true }, false],
    ["a short timed deadline", { allDay: false, minutes: 15, title: "Submit the form" }, true],
    ["a zero-length timed reminder", { allDay: false, minutes: 0, title: "Take the car in" }, true],
    ["a long class", { allDay: false, minutes: 90, title: "Econ exam review" }, false],
    ["a plain workout", { allDay: false, minutes: 30, title: "Workout" }, false],
    ["a short meeting with someone", { allDay: false, minutes: 15, title: "Pay check-in", others: 1 }, false],
  ] as const)("%s", (_name, over, expected) => {
    expect(isReminderEvent(event(over as Partial<EventInput>))).toBe(expected);
  });
});

// The lines a daily brief mail restates, and tasks a person would keep.
const WORKOUT = event({ title: "Workout", day: "2026-11-03", allDay: false, minutes: 60 });
const STANDUP = event({ title: "Team standup", day: "2026-11-03", allDay: false, minutes: 15 });
const SEMINAR = event({ title: "Seminar: price theory", day: "2026-11-04", allDay: false, minutes: 90 });
const CALENDAR = [WORKOUT, STANDUP, SEMINAR];
const COPIES: Partial<PlanInput>[] = [
  { what: "7:30 AM - Workout", when: "2026-11-03", ownMail: true },
  { what: "7:30 AM - Workout", when: "2026-11-03" },
  { what: "7:30am Workout", when: "2026-11-03" },
  { what: "Workout", when: "2026-11-03" },
  { what: "9:00 - 9:15 AM – Team standup", when: "2026-11-03" },
  { what: "team standup", when: "2026-11-03" },
  { what: "2:00 PM: Seminar: price theory", when: "2026-11-04", ownMail: true },
  { what: "price theory", when: "2026-11-04" },
  // On no calendar here, from the owner's own address, and shaped as a schedule line.
  { what: "12:30 PM - Lunch with Sam", when: "2026-11-03", ownMail: true },
  { what: "18:00 Gym", when: "2026-11-05", ownMail: true },
];
const KEPT: Partial<PlanInput>[] = [
  { what: "Book the flight to Lisbon", when: "2026-11-06" },
  { what: "Essay for econ due", when: "2026-11-05" },
  // The owner's own note to themselves, no schedule line.
  { what: "Pay rent by Friday", when: "2026-11-06", ownMail: true },
  // A clock in the line, and it says a deadline.
  { what: "11:59 PM - Problem set 4 due", when: "2026-11-06", ownMail: true },
  // The word workout on another day.
  { what: "Workout", when: "2026-11-09" },
  { what: "Call the dentist about Thursday", when: "2026-11-05" },
  { what: "Send Ana the workout plan", when: "2026-11-03" },
  { what: "Renew the passport", when: "2026-11-20" },
  // The event's words inside a real task's: the task stays.
  { what: "Prepare slides for team standup", when: "2026-11-03" },
  { what: "Seminar price theory with Ana", when: "2026-11-04" },
];

describe("a plan that restates the calendar", () => {
  it.each(COPIES.map((one) => [one.what, one] as const))("is a copy: %s", (_what, one) => {
    expect(isCalendarCopy(plan(one), CALENDAR, ZONE)).toBe(true);
  });
  it.each(KEPT.map((one) => [one.what, one] as const))("is kept: %s", (_what, one) => {
    expect(isCalendarCopy(plan(one), CALENDAR, ZONE)).toBe(false);
  });
  it("keeps a deadline when the calendar's line of it is no item, and leaves it to the event when it is", () => {
    const line = { what: "Essay due", when: "2026-11-05" };
    expect(
      isCalendarCopy(plan(line), [event({ title: "Essay due", allDay: false, minutes: 120, others: 2 })], ZONE),
    ).toBe(false);
    expect(isCalendarCopy(plan(line), [event({ title: "Essay due" })], ZONE)).toBe(true);
  });
  it("a known miss: a schedule line from a service's address, on no calendar, stays", () => {
    expect(isCalendarCopy(plan({ what: "7:30 AM - Pilates", when: "2026-11-03" }), CALENDAR, ZONE)).toBe(false);
  });
});

describe("composeOpenItems", () => {
  const step = (over = {}) => ({
    key: hex(7),
    what: "Order the firebricks",
    due: null,
    at: NOW.getTime() - 3_600_000,
    match: "step-firebricks",
    evidence: "evd_a",
    agent: "agent-a",
    project: { id: `ent_${"2".repeat(26)}`, kind: "project", name: { untrusted: "Kiln" }, address: null } as Who,
    refs: { record: "rec_a" as never },
    ...over,
  });
  const commitment = (over = {}) => ({
    key: hex(9),
    what: "Send the slides to Ana",
    due: "2026-11-04",
    whoActs: owner,
    project: null,
    refs: { message: "msg_y" as never },
    ...over,
  });

  it("joins the four sources once each, soonest first and undated last", () => {
    const { items } = compose({
      commitments: [commitment()],
      nextSteps: [step()],
      plans: [plan(), plan()],
      events: [event(), event()],
    });
    expect(items.map((one) => [one.source.kind, one.due, one.overdue])).toEqual([
      ["commitment", "2026-11-04", false],
      ["calendar", "2026-11-05", false],
      ["plan", "2026-11-06", false],
      ["next_step", null, false],
    ]);
  });

  it("says what is overdue, by the owner's day", () => {
    const { items } = compose({
      commitments: [commitment({ due: "2026-11-01" }), commitment({ key: hex(10), due: "2026-11-03" })],
      plans: [plan({ when: "2026-11-02" })],
    });
    expect(items.map((one) => [one.source.kind, one.overdue, one.lateDays])).toEqual([
      ["commitment", true, 2],
      ["plan", true, 1],
      ["commitment", false, null],
    ]);
  });

  it("an instant passed earlier today is overdue by no whole day", () => {
    const { items } = compose({ commitments: [commitment({ due: "2026-11-03T15:00:00.000Z" })] });
    expect(items.map((one) => [one.overdue, one.lateDays])).toEqual([[true, 0]]);
  });

  it("lapses a step, plan or reminder past the named limits, and says which", () => {
    const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);
    const { items, lapsed } = compose({
      nextSteps: [
        step({ due: ago(OPEN_ITEM_LAPSE_DAYS) }),
        step({ key: hex(10), match: "step-other", what: "Buy wood", due: ago(OPEN_ITEM_LAPSE_DAYS + 1) }),
      ],
      plans: [
        plan({ when: ago(PAST_DUE_WINDOW_DAYS) }),
        plan({ key: hex(2), what: "Book the train", when: ago(PAST_DUE_WINDOW_DAYS + 1) }),
      ],
      events: [event({ day: ago(PAST_DUE_WINDOW_DAYS + 1), due: ago(PAST_DUE_WINDOW_DAYS + 1) })],
    });
    expect(items.map((one) => one.source.id)).toEqual([hex(7), hex(1)]);
    expect(lapsed.map((one) => one.key).sort()).toEqual([hex(2), hex(10), event().id].sort());
  });

  it("takes no date lapse on a commitment: its read already applied the rule, with its reopen", () => {
    const old = new Date(NOW.getTime() - 60 * DAY).toISOString().slice(0, 10);
    const { items, lapsed } = compose({ commitments: [commitment({ due: old })] });
    expect(items.map((one) => [one.source.id, one.overdue])).toEqual([[hex(9), true]]);
    expect(lapsed).toEqual([]);
  });

  it("drops a plan with no date it can read, and one the calendar restates", () => {
    const { items } = compose({
      plans: [plan({ when: "next week" }), plan({ key: hex(2), what: "7:30 AM - Workout", when: "2026-11-03" })],
      events: [WORKOUT],
    });
    expect(items).toEqual([]);
  });

  it("a later report on the project replaces its earlier next steps", () => {
    const later = step({ key: hex(8), what: "Fire the kiln", evidence: "evd_b", at: NOW.getTime() - 60_000 });
    const same = step({ key: hex(11), what: "Buy wood", evidence: "evd_b", at: NOW.getTime() - 60_000 });
    const { items, replaced } = compose({ nextSteps: [step(), later, same] });
    expect(items.map((one) => one.source.id).sort()).toEqual([hex(8), hex(11)]);
    expect(replaced).toEqual([hex(7)]);
  });

  it("a report with no step for the owner erases nothing, since none reaches here", () => {
    const { items, replaced } = compose({ nextSteps: [step()] });
    expect(items.map((one) => one.source.id)).toEqual([hex(7)]);
    expect(replaced).toEqual([]);
  });

  it("another agent's later report on the project replaces nothing of this agent's", () => {
    const theirs = step({ key: hex(8), what: "Fire the kiln", evidence: "evd_b", agent: "agent-b", at: NOW.getTime() });
    const { items, replaced } = compose({ nextSteps: [theirs, step()] });
    expect(items.map((one) => one.source.id).sort()).toEqual([hex(7), hex(8)]);
    expect(replaced).toEqual([]);
  });

  it("no date a contract would refuse is an item's due", () => {
    for (const when of ["2026-11-05T17:00", "Nov 5, 2026", "2026-02-31", "March 5"]) {
      expect(compose({ plans: [plan({ when })] }).items, when).toEqual([]);
      expect(compose({ nextSteps: [step({ due: when })] }).items[0]?.due, when).toBeNull();
    }
  });

  it("a fact's newest statement decides: one restating the calendar hides an older statement of it", () => {
    const { items } = compose({
      plans: [plan({ what: "Workout", when: "2026-11-03" }), plan({ what: "Workout", when: "2026-11-09" })],
      events: [WORKOUT],
    });
    expect(items).toEqual([]);
  });

  it("an undated next step lapses by its age", () => {
    const { items, lapsed } = compose({ nextSteps: [step({ at: NOW.getTime() - 31 * DAY })] });
    expect(items).toEqual([]);
    expect(lapsed.map((one) => one.key)).toEqual([hex(7)]);
  });

  const close = (over = {}) => ({
    key: hex(1),
    match: `plan-${hex(1)}`,
    ending: "done" as const,
    at: NOW.toISOString(),
    due: "2026-11-06",
    ...over,
  });

  it("leaves out what the owner closed", () => {
    expect(compose({ plans: [plan()], closes: [close()] }).items).toEqual([]);
  });

  it("a Done ends at a new date, or at a later statement of the same item the read serves", () => {
    expect(compose({ plans: [plan({ when: "2026-11-09" })], closes: [close()] }).items).toHaveLength(1);
    const later = plan({ at: NOW.getTime() + 1 });
    expect(compose({ plans: [later], closes: [close()] }).items).toHaveLength(1);
    const earlier = plan({ at: NOW.getTime() - 1 });
    expect(compose({ plans: [earlier], closes: [close()] }).items).toEqual([]);
  });

  it("a Drop outlasts a later statement and a new record, by its words; only a new date ends it", () => {
    const dropped = close({ ending: "dropped", key: hex(7), match: "step-firebricks", due: null });
    const again = step({ key: hex(70), evidence: "evd_b", at: NOW.getTime() + 1 });
    expect(compose({ nextSteps: [again], closes: [dropped] }).items).toEqual([]);
    const dated = step({ key: hex(70), evidence: "evd_b", at: NOW.getTime() + 1, due: "2026-11-20" });
    expect(compose({ nextSteps: [dated], closes: [dropped] }).items).toHaveLength(1);
  });

  it("a Done on one step leaves a step of other words alone, and matches no other item by its words", () => {
    const done = close({ key: hex(7), match: "step-firebricks", due: null });
    const other = step({ key: hex(8), match: "step-wood", what: "Buy wood" });
    const same = step({ key: hex(70), evidence: "evd_a" });
    const { items } = compose({ nextSteps: [step(), other, same], closes: [done] });
    expect(items.map((one) => one.source.id).sort()).toEqual([hex(8), hex(70)]);
  });

  it("a recurring reminder lists its next instance, whichever day each is stored for", () => {
    const week = (id: number, day: string) =>
      event({ id: `evt_${String(id).padStart(26, "0")}`, title: "Timesheet due", day, due: day });
    const { items } = compose({
      events: [week(1, "2026-11-02"), week(2, "2026-11-09"), week(3, "2026-11-16"), week(4, "2026-11-23")],
    });
    expect(items.map((one) => one.due)).toEqual(["2026-11-09"]);
    const past = compose({ events: [week(1, "2026-11-02")] });
    expect(past.items.map((one) => one.overdue)).toEqual([true]);
  });

  it("orders ties by key, so the order rests on nothing else", () => {
    const { items } = compose({ plans: [plan({ key: hex(3), what: "Book the train" }), plan({ key: hex(2) })] });
    expect(items.map((one) => one.source.id)).toEqual([hex(2), hex(3)]);
  });

  describe("a thread or the calendar moved on", () => {
    const later = NOW.getTime() - 3_600_000;

    it("a reply alone closes nothing: the plan stays, marked as replied to", () => {
      const dinner = plan({ what: "Dinner with Sam", repliedAt: later });
      const { items } = compose({ plans: [dinner] });
      expect(items.map((one) => one.what?.untrusted)).toEqual(["Dinner with Sam"]);
      expect(items[0]?.repliedAt).toBe(new Date(later).toISOString());
    });

    it("a reply from before the plan was said is no reply to it", () => {
      const { items } = compose({ plans: [plan({ what: "Dinner with Sam", repliedAt: NOW.getTime() - 2 * DAY })] });
      expect(items[0]?.repliedAt).toBeUndefined();
    });

    const said = (over: Partial<PlanInput>) =>
      plan({ thread: "thread-a", what: "Thursday at 4pm with Ada works great.", ...over });
    const reply = (over: Partial<PlanInput>) =>
      plan({
        key: hex(60),
        thread: "thread-a",
        ownMail: true,
        at: later,
        what: "Let's move it to Friday",
        when: "2026-11-07",
        ...over,
      });

    it("the owner's later plan on the thread that moves it to another date replaces it", () => {
      expect(compose({ plans: [said({}), reply({})] }).items.map((one) => one.what?.untrusted)).toEqual([
        "Let's move it to Friday",
      ]);
    });

    it("the owner's later plan of the same words at another date replaces it", () => {
      const again = reply({ what: "Thursday at 4pm with Ada works great." });
      expect(compose({ plans: [said({}), again] }).items.map((one) => one.due)).toEqual(["2026-11-07"]);
    });

    it.each([
      ["another plan on the thread that does not say it moved", { what: "Also dinner on Saturday" }],
      ["the same date", { when: "2026-11-06" }],
      ["someone else's message", { ownMail: false }],
      ["another thread", { thread: "thread-b" }],
      ["an earlier statement", { at: NOW.getTime() - 3 * DAY }],
    ])("%s replaces nothing", (_name, over) => {
      expect(compose({ plans: [said({}), reply(over)] }).items).toHaveLength(2);
    });

    it("a line that says a deadline is not replaced by a move", () => {
      expect(compose({ plans: [said({ what: "Submit the form" }), reply({})] }).items).toHaveLength(2);
    });

    it("a series of those words says nothing of this date", () => {
      const week = (n: number, day: string) =>
        event({ id: `evt_${String(n).padStart(26, "0")}`, title: "Team sync", day, due: day });
      const said = plan({ what: "Team sync" });
      const { items } = compose({ plans: [said], events: [week(1, "2026-11-09"), week(2, "2026-11-16")] });
      expect(items).toHaveLength(1);
    });

    it("the calendar's event of those words on another day has moved it; a deadline stays", () => {
      const moved = event({ title: "Lunch with Pat", day: "2026-11-09", due: "2026-11-09" });
      expect(compose({ plans: [plan({ what: "Lunch with Pat" })], events: [moved] }).items).toEqual([]);
      const form = event({ title: "Form due", day: "2026-11-09", due: "2026-11-09" });
      expect(compose({ plans: [plan({ what: "Form due" })], events: [form] }).items).toHaveLength(2);
    });
  });

  describe("one obligation, once", () => {
    const finals = (n: number, when: string) =>
      plan({ key: hex(40 + n), what: "Exams are scheduled for November 10th, 12th and 13th.", when, match: "finals" });

    it("one line with several dates to come is one item, at its next date", () => {
      const { items } = compose({ plans: [finals(0, "2026-11-10"), finals(1, "2026-11-12"), finals(2, "2026-11-13")] });
      expect(items.map((one) => one.due)).toEqual(["2026-11-10"]);
    });

    it("a missed date stays overdue beside the next", () => {
      const { items } = compose({ plans: [finals(0, "2026-11-02"), finals(1, "2026-11-12"), finals(2, "2026-11-13")] });
      expect(items.map((one) => [one.due, one.overdue])).toEqual([
        ["2026-11-02", true],
        ["2026-11-12", false],
      ]);
    });

    it("a Done holds for its own date: the next one comes up", () => {
      const done = { key: hex(40), match: "finals", ending: "done" as const, at: NOW.toISOString(), due: "2026-11-10" };
      const plans = [finals(0, "2026-11-10"), finals(1, "2026-11-12"), finals(2, "2026-11-19")];
      expect(compose({ plans, closes: [done] }).items.map((one) => one.due)).toEqual(["2026-11-12"]);
    });

    it("a Drop holds for its own date too", () => {
      const drop = {
        key: hex(40),
        match: "finals",
        ending: "dropped" as const,
        at: NOW.toISOString(),
        due: "2026-11-10",
      };
      const plans = [finals(0, "2026-11-10"), finals(1, "2026-11-12")];
      expect(compose({ plans, closes: [drop] }).items.map((one) => one.due)).toEqual(["2026-11-12"]);
    });

    it.each([
      ["a note in parentheses", "Problem set 3 (Math)", "Problem set 3 (Econ)"],
      ["words after due", "Final paper due Friday for Math", "Final paper due Friday for Econ"],
      ["a reminder of each", "Reminder: paper due tomorrow for Math", "Reminder: paper due tomorrow for Econ"],
    ])("%s keeps two obligations apart, and Done on one leaves the other", (_name, one, other) => {
      const first = plan({ key: hex(61), what: one, when: "2026-11-06", refs: { message: "msg_a" as never } });
      const second = plan({ key: hex(62), what: other, when: "2026-11-06", refs: { message: "msg_b" as never } });
      expect(compose({ plans: [first, second] }).items).toHaveLength(2);
      const done = { key: hex(61), match: null, ending: "done" as const, at: NOW.toISOString(), due: "2026-11-06" };
      expect(compose({ plans: [first, second], closes: [done] }).items.map((item) => item.what?.untrusted)).toEqual([
        other,
      ]);
    });

    it("two reminders of one deadline and a plan of it are one item", () => {
      const week = event({
        id: `evt_${"2".repeat(26)}`,
        title: "Week-before reminder: Term paper due Nov 17 8:00am",
        allDay: false,
        minutes: 15,
        day: "2026-11-10",
        due: "2026-11-10T15:00:00.000Z",
      });
      const dayBefore = event({
        id: `evt_${"3".repeat(26)}`,
        title: "Day-before reminder: Term paper due tomorrow 8:00am",
        allDay: false,
        minutes: 15,
        day: "2026-11-16",
        due: "2026-11-17T00:00:00.000Z",
      });
      const said = plan({ what: "Term paper due Nov 17", when: "2026-11-17" });
      const { items } = compose({ events: [week, dayBefore], plans: [said] });
      expect(items.map((one) => one.due)).toEqual(["2026-11-17"]);
    });

    it("an obligation at two deadlines is two items, the late one and the next", () => {
      const late = event({
        id: `evt_${"4".repeat(26)}`,
        title: "DUE: Lab report (portal)",
        day: "2026-11-01",
        due: "2026-11-01",
      });
      const next = event({
        id: `evt_${"5".repeat(26)}`,
        title: "Tomorrow: Lab report due (Sunday)",
        allDay: false,
        minutes: 15,
        day: "2026-11-07",
        due: "2026-11-08T00:00:00.000Z",
      });
      const { items } = compose({ events: [late, next] });
      expect(items.map((one) => [one.due, one.overdue])).toEqual([
        ["2026-11-01", true],
        ["2026-11-08", false],
      ]);
    });

    it("closing one source of it does not bring back another, and no close of another source ends a commitment", () => {
      const reminder = event({ title: "Reminder: annual form due tomorrow", day: "2026-11-04", due: "2026-11-04" });
      const said = plan({ what: "Annual form due Nov 5", when: "2026-11-05" });
      const done = { key: reminder.id, match: null, ending: "done" as const, at: NOW.toISOString(), due: "2026-11-05" };
      expect(compose({ events: [reminder], plans: [said] }).items).toHaveLength(1);
      expect(compose({ events: [reminder], plans: [said], closes: [done] }).items).toEqual([]);
      const promised = {
        key: hex(9),
        what: "Annual form due",
        due: "2026-11-05",
        whoActs: owner,
        project: null,
        refs: {},
      };
      const { items } = compose({ commitments: [promised], events: [reminder], closes: [done] });
      expect(items.map((one) => one.source.kind)).toEqual(["commitment"]);
    });

    it("two messages' statements of one line at two dates are two items, the late one and the next", () => {
      const late = plan({ key: hex(50), what: "Submit the log", when: "2026-11-02" });
      const next = plan({
        key: hex(51),
        what: "Submit the log",
        when: "2026-11-08",
        refs: { message: "msg_y" as never },
      });
      expect(compose({ plans: [late, next] }).items.map((one) => one.due)).toEqual(["2026-11-02", "2026-11-08"]);
    });

    it("the same words at one date are one obligation only for one who acts, on one project", () => {
      const other = { id: `ent_${"7".repeat(26)}`, kind: "person", name: null, address: null } as unknown as Who;
      const owed = {
        key: hex(52),
        what: "Send the deck",
        due: "2026-11-05",
        whoActs: other,
        project: null,
        refs: {},
      };
      const mine = plan({ what: "Send the deck", when: "2026-11-05" });
      expect(compose({ commitments: [owed], plans: [mine] }).items).toHaveLength(2);
    });
  });

  describe("a reminder's date is not a deadline", () => {
    const remind = (title: string, day: string, due: string) => event({ title, day, due, allDay: false, minutes: 15 });

    it.each([
      ["tomorrow", "Reminder: team update due TOMORROW (Tue/Fri)", "2026-11-05", "2026-11-06"],
      ["today", "Design review due TODAY 11:59pm (the brief says Nov 11)", "2026-11-08", "2026-11-08"],
      ["a head", "Tomorrow: lab report due (Sunday)", "2026-11-07", "2026-11-08"],
      ["a date", "Week-before reminder: term paper due Nov 17 8:00am", "2026-11-10", "2026-11-17"],
      ["a date in figures", "Reminder: rent due 12/1", "2026-11-25", "2026-12-01"],
      ["a weekday", "Reminder: essay due Monday", "2026-11-05", "2026-11-09"],
      ["a date next year", "Reminder: taxes due Jan 15", "2026-12-20", "2027-01-15"],
    ])("reads %s from the title", (_name, title, day, deadline) => {
      expect(titledDeadline(title, day)).toBe(deadline);
    });

    it("a title that names no date gives none", () => {
      expect(titledDeadline("Reminder: renew the passport", "2026-11-05")).toBeNull();
      expect(titledDeadline("Essay due midnight", "2026-11-05")).toBeNull();
      expect(titledDeadline("Rent due monthly", "2026-11-05")).toBeNull();
      expect(titledDeadline("Deposit due wedding day", "2026-11-05")).toBeNull();
    });

    it("a date just past stays past, and a stated year holds", () => {
      expect(titledDeadline("Form was due Oct 30", "2026-11-01")).toBe("2026-10-30");
      expect(titledDeadline("Form due 11/5/2027", "2026-11-01")).toBe("2027-11-05");
    });

    it("serves the title's date as due, and the event's as remindAt", () => {
      const at = "2026-11-06T00:00:00.000Z";
      const { items } = compose({ events: [remind("Reminder: team update due tomorrow", "2026-11-05", at)] });
      expect(items[0]).toMatchObject({ due: "2026-11-06", remindAt: at, overdue: false });
    });

    it("a reminder naming no date has no due and orders by its reminder", () => {
      const at = "2026-11-05T15:00:00.000Z";
      const { items } = compose({
        events: [remind("Reminder: renew the passport", "2026-11-05", at)],
        plans: [plan({ when: "2026-11-06" }), plan({ key: hex(2), what: "Book the train", when: "2026-11-04" })],
      });
      expect(items.map((one) => one.what?.untrusted)).toEqual([
        "Book the train",
        "Reminder: renew the passport",
        "Book the flight to Lisbon",
      ]);
      expect(items[1]).toMatchObject({ due: null, remindAt: at, overdue: false, lateDays: null });
    });

    it("a reminder fired long ago naming no date lapses by its own date", () => {
      const at = "2026-10-20T15:00:00.000Z";
      const { items, lapsed } = compose({ events: [remind("Reminder: renew the passport", "2026-10-20", at)] });
      expect(items).toEqual([]);
      expect(lapsed).toHaveLength(1);
    });

    it("a deadline at its own time, an all-day one and a title with no reminder keep their date, and no remindAt", () => {
      const { items } = compose({ events: [event({ title: "Problem set 4 due" })] });
      expect(items[0]).toMatchObject({ due: "2026-11-05" });
      expect(items[0]?.remindAt).toBeUndefined();
    });

    it("a close of a reminder naming no date holds until its event moves", () => {
      const at = "2026-11-05T15:00:00.000Z";
      const done = {
        key: `evt_${"1".repeat(26)}`,
        match: null,
        ending: "done" as const,
        at: NOW.toISOString(),
        due: at,
      };
      const held = remind("Reminder: renew the passport", "2026-11-05", at);
      expect(compose({ events: [held], closes: [done] }).items).toEqual([]);
      const moved = remind("Reminder: renew the passport", "2026-12-01", "2026-12-01T15:00:00.000Z");
      expect(compose({ events: [moved], closes: [done] }).items).toHaveLength(1);
    });

    it("a close from before keeps holding on the event's own date", () => {
      const at = "2026-11-06T00:00:00.000Z";
      const done = {
        key: `evt_${"1".repeat(26)}`,
        match: null,
        ending: "done" as const,
        at: NOW.toISOString(),
        due: at,
      };
      const { items } = compose({
        events: [remind("Reminder: team update due tomorrow", "2026-11-05", at)],
        closes: [done],
      });
      expect(items).toEqual([]);
    });
  });

  it("says which lines name a deadline", () => {
    expect(saysDeadline("Grant application")).toBe(true);
    expect(saysDeadline("Team budget about $30")).toBe(false);
  });

  it("a mailing's plan that says no deadline is no item; one that says a deadline stays", () => {
    const items = compose({
      plans: [
        plan({ what: "Summit pass confirmed, doors open at nine", bulk: true }),
        plan({ key: hex(2), what: "Registration fee due for the summit", bulk: true }),
        plan({ key: hex(3), what: "Dinner with Rhea and Sam", bulk: false }),
      ],
    }).items;
    expect(items.map((one) => one.what?.untrusted).sort()).toEqual([
      "Dinner with Rhea and Sam",
      "Registration fee due for the summit",
    ]);
  });

  it("two calendar lines of one deadline are one item, the deadline before its reminder", () => {
    const lines = compose({
      events: [
        event({
          id: `evt_${"2".repeat(26)}`,
          title: "Week-before reminder: Birch Study Final Report due Nov 17 8:00am",
          day: "2026-11-10",
          due: "2026-11-10T15:00:00.000Z",
          allDay: false,
          minutes: 15,
        }),
        event({
          id: `evt_${"3".repeat(26)}`,
          title: "DUE 8:00am: Birch Study Final Report (portal upload)",
          day: "2026-11-17",
          due: "2026-11-17T14:00:00.000Z",
          allDay: false,
          minutes: 15,
        }),
      ],
    }).items;
    expect(lines.map((one) => one.source.id)).toEqual([`evt_${"3".repeat(26)}`]);
  });

  it("closing the deadline does not bring its reminder back", () => {
    const due = event({
      id: `evt_${"3".repeat(26)}`,
      title: "DUE 8:00am: Birch Study Final Report (portal upload)",
      day: "2026-11-17",
      due: "2026-11-17T14:00:00.000Z",
      allDay: false,
      minutes: 15,
    });
    const reminder = event({
      id: `evt_${"2".repeat(26)}`,
      title: "Week-before reminder: Birch Study Final Report due Nov 17 8:00am",
      day: "2026-11-10",
      due: "2026-11-10T15:00:00.000Z",
      allDay: false,
      minutes: 15,
    });
    const closes = [{ key: due.id, match: null, ending: "done" as const, at: NOW.toISOString(), due: due.due }];
    expect(compose({ events: [reminder, due], closes }).items).toEqual([]);
  });

  it("a deadline that opens with a condition's words stays an item; a bare condition does not", () => {
    const at = (id: string, title: string) =>
      event({ id: `evt_${id.repeat(26)}`, title, day: "2026-11-08", due: "2026-11-08", allDay: true });
    expect(
      compose({
        events: [
          at("2", "If required documents are missing, the form is due"),
          at("3", "If requested: the second copy is due"),
        ],
      }).items.map((one) => one.source.id),
    ).toEqual([`evt_${"2".repeat(26)}`]);
  });

  it("closing a line that is no reminder leaves another line of that day that says more", () => {
    const at = (id: string, title: string) =>
      event({ id: `evt_${id.repeat(26)}`, title, day: "2026-11-08", due: "2026-11-08", allDay: true });
    const closed = at("2", "Essay draft due");
    const closes = [{ key: closed.id, match: null, ending: "done" as const, at: NOW.toISOString(), due: closed.due }];
    expect(
      compose({ events: [closed, at("3", "Essay draft due to Rhea for review")], closes }).items.map(
        (one) => one.source.id,
      ),
    ).toEqual([`evt_${"3".repeat(26)}`]);
  });

  it("two lines of different work stay two, even opening alike; a reminder opening with five words alike is one", () => {
    const at = (id: string, title: string) =>
      event({ id: `evt_${id.repeat(26)}`, title, day: "2026-11-08", due: "2026-11-08", allDay: true });
    expect(
      compose({
        events: [
          at("2", "Reminder: Memo due tomorrow per the class portal, spec says otherwise"),
          at("3", "Reminder: Memo due tomorrow per the class portal, unconfirmed"),
        ],
      }).items,
    ).toHaveLength(1);
    expect(
      compose({ events: [at("2", "Problem set 3 due"), at("3", "Problem set 4 due"), at("4", "Essay due")] }).items,
    ).toHaveLength(3);
    expect(
      compose({
        events: [
          at("2", "Grant application for Cedar Fund round one due"),
          at("3", "Grant application for Cedar Fund round two due"),
        ],
      }).items,
    ).toHaveLength(2);
  });
});

describe("a line on a condition", () => {
  it("is no item from the calendar or a plan, and a condition later in a line stays one", () => {
    const composed = composeOpenItems(
      inputs({
        events: [event({ id: `evt_${"3".repeat(26)}`, title: "IF REQUESTED: Canary revisions due midnight" })],
        plans: [plan({ what: "If needed, submit the Canary form" })],
      }),
      NOW,
      ZONE,
    );
    expect(composed.items).toEqual([]);
    const kept = composeOpenItems(
      inputs({ events: [event({ title: "Canary form due, if requested late" })] }),
      NOW,
      ZONE,
    );
    expect(kept.items).toHaveLength(1);
  });
});

describe("a title's own time", () => {
  const titled = event({
    title: "DUE 8:00am: Canary final proposal",
    day: "2026-11-17",
    due: "2026-11-17T13:30:00.000Z",
    allDay: false,
    minutes: 15,
  });

  it("is when it is due, and the event's earlier start is when it fires", () => {
    const [item] = composeOpenItems(inputs({ events: [titled] }), NOW, ZONE).items;
    expect(item?.due).toBe("2026-11-17T14:00:00.000Z");
    expect(item?.remindAt).toBe("2026-11-17T13:30:00.000Z");
  });

  it("changes nothing when it agrees with the event, or for an afternoon's half of the day", () => {
    const same = { ...titled, due: "2026-11-17T14:00:00.000Z" };
    const [agreed] = composeOpenItems(inputs({ events: [same] }), NOW, ZONE).items;
    expect(agreed?.due).toBe("2026-11-17T14:00:00.000Z");
    expect(agreed?.remindAt).toBeUndefined();
    const late = { ...titled, title: "Canary form due 5pm" };
    expect(composeOpenItems(inputs({ events: [late] }), NOW, ZONE).items[0]?.due).toBe("2026-11-17T23:00:00.000Z");
  });

  it("reads no such time from a title that names another day or says it is a reminder", () => {
    const due = (title: string) =>
      composeOpenItems(inputs({ events: [{ ...titled, title }] }), NOW, ZONE).items[0]?.due;
    expect(due("Tomorrow: Canary essay due 11:59pm")).toBe("2026-11-18");
    expect(due("Reminder: Canary paper due 5pm")).toBeNull();
    expect(due("Canary form due 8am Friday")).toBe(titled.due);
  });

  it("reads none earlier than the event: that is another day's midnight", () => {
    const [item] = composeOpenItems(
      inputs({ events: [{ ...titled, title: "DUE 12:00am: Canary upload" }] }),
      NOW,
      ZONE,
    ).items;
    expect(item?.due).toBe(titled.due);
    expect(item?.remindAt).toBeUndefined();
  });

  it("keeps a close made on the event's old time", () => {
    const closes = [{ key: titled.id, match: null, ending: "done" as const, at: NOW.toISOString(), due: titled.due }];
    expect(composeOpenItems(inputs({ events: [titled], closes }), NOW, ZONE).items).toEqual([]);
  });
});
