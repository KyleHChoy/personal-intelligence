import type { Who } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  composeOpenItems,
  type OpenInputs,
  type PlanInput,
  saysDeadline,
  saysDeadlineToOwner,
  saysDone,
  saysNoticeDue,
} from "./open-items.ts";

// What a mailing's line does on the list: an institution's deadline in, an advertisement out. Every
// line here is invented.
const NOW = new Date("2026-11-03T18:00:00.000Z");
const ZONE = "America/Chicago";
const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as unknown as Who;
const hex = (n: number): string => String(n).padStart(64, "0");
const SENDER = "fingerprint-of-a-sender";
const notice = (n: number, over: Partial<PlanInput>): PlanInput => ({
  key: hex(n),
  match: `plan-${hex(n)}`,
  what: "Your Week 3 studio report is due today.",
  when: "2026-11-08",
  at: n,
  ownMail: false,
  bulk: true,
  sender: SENDER,
  authed: true,
  refs: { message: "msg_x" as never },
  ...over,
});
const compose = (over: Partial<OpenInputs>) =>
  composeOpenItems({ owner, commitments: [], nextSteps: [], plans: [], events: [], closes: [], ...over }, NOW, ZONE);
const lines = (plans: PlanInput[]) => compose({ plans }).items.map((one) => one.what?.untrusted);

describe("a mailing's line on the list", () => {
  it("that says something is overdue is an item, late, at the date it names, with its source", () => {
    const [item] = compose({
      plans: [notice(1, { what: "Your studio report is overdue.", when: "2026-11-01" })],
    }).items;
    expect(item).toMatchObject({
      due: "2026-11-01",
      overdue: true,
      lateDays: 2,
      source: { kind: "plan", message: "msg_x" },
    });
  });

  it("that says past due is an item, and what is due to the weather is not", () => {
    expect(lines([notice(1, { what: "Your water bill is past due.", when: "2026-11-02" })])).toHaveLength(1);
    expect(lines([notice(1, { what: "Due to rain, tonight's concert moves indoors.", when: "2026-11-06" })])).toEqual(
      [],
    );
  });

  it("stays open two weeks past its date, where a reminder of an event stays three days", () => {
    const owed = (when: string) => lines([notice(1, { what: "Studio report deadline has passed.", when })]);
    expect(owed("2026-10-30")).toHaveLength(1);
    expect(owed("2026-10-20")).toHaveLength(1);
    expect(owed("2026-10-19")).toEqual([]);
    const reminder = (when: string) => lines([notice(1, { what: "Reminder: the alumni dinner", when })]);
    expect(reminder("2026-10-31")).toHaveLength(1);
    expect(reminder("2026-10-30")).toEqual([]);
  });

  it.each([
    "Applications close Sunday for the Spring Fellowship.",
    "Apply by November 8 to join the founders cohort.",
    "Apply now: the Chief of Staff role is open until the deadline.",
    "Last chance: register today, the early-bird rate is due to end.",
    "Sale ends Sunday, payment plans available.",
    "Offer expires November 8.",
    "Acme is hiring: application deadline November 8.",
  ])("that advertises stays out: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([]);
  });

  it("that a person wrote is not read as an advertisement", () => {
    const what = "Apply by November 8, as we discussed.";
    expect(lines([notice(1, { what, bulk: false })])).toEqual([what]);
  });

  it("that says only an event's date stays out", () => {
    expect(lines([notice(1, { what: "The summit starts tomorrow at the Hilton" })])).toEqual([]);
  });

  const OPENED = notice(1, { what: "Studio report deadline: Sunday, November 8" });
  const DUE = notice(2, { what: "Your Week 3 studio report is due today." });
  const LATE = notice(3, { what: "We have not received your Week 3 studio report, and its deadline has passed." });
  const RECEIVED = notice(4, { what: "We have received your Week 3 studio report." });

  it("said three ways by one sender for one date is one item, the newest", () => {
    expect(lines([LATE, DUE, OPENED])).toEqual([LATE.what]);
  });

  it("from two senders, at two dates, or of two things, stays two", () => {
    expect(lines([DUE, { ...LATE, sender: "another-sender" }])).toHaveLength(2);
    expect(lines([DUE, { ...LATE, when: "2026-11-09" }])).toHaveLength(2);
    expect(lines([DUE, notice(5, { what: "Your Week 3 essay on Lisbon is due today." })])).toHaveLength(2);
  });

  it("is ended by that sender's later receipt, and a receipt is no item", () => {
    expect(lines([OPENED, DUE, RECEIVED])).toEqual([]);
    expect(lines([RECEIVED])).toEqual([]);
    expect(lines([notice(1, { what: "Your application was received." })])).toEqual([]);
  });

  it("is not ended by a receipt before it, another sender's, another date's or another thing's", () => {
    expect(lines([{ ...RECEIVED, at: 0 }, LATE])).toEqual([LATE.what]);
    expect(lines([DUE, { ...RECEIVED, sender: "another-sender" }])).toEqual([DUE.what]);
    expect(lines([DUE, { ...RECEIVED, when: "2026-11-09" }])).toEqual([DUE.what]);
    expect(lines([DUE, { ...RECEIVED, what: "We have received your essay on Lisbon." }])).toEqual([DUE.what]);
  });

  it("is not ended by a line that says it was not received, or by a reply on its thread", () => {
    expect(lines([DUE, LATE])).toEqual([LATE.what]);
    const [item] = compose({ plans: [{ ...DUE, thread: "thread", repliedAt: DUE.at + 1 }] }).items;
    expect(item).toMatchObject({ repliedAt: expect.any(String), what: { untrusted: DUE.what } });
  });

  it("the owner's Done on the newest holds, and the older statements do not come back", () => {
    const closes = [
      { key: LATE.key, match: LATE.match, ending: "done" as const, at: NOW.toISOString(), due: "2026-11-08" },
    ];
    expect(compose({ plans: [LATE, DUE], closes }).items).toEqual([]);
  });

  it("with no sender keeps every statement: nothing says they share one", () => {
    const unsent = ({ sender: _sender, ...rest }: PlanInput): PlanInput => rest;
    expect(lines([unsent(DUE), unsent(LATE)])).toHaveLength(2);
  });
});

describe("what the review of this read found", () => {
  it("a line that says it must be received is owed, not done", () => {
    expect(lines([notice(1, { what: "Payment must be received by November 8." })])).toHaveLength(1);
    expect(
      lines([
        notice(1, { what: "Your payment is due November 8." }),
        notice(2, { what: "Payment must be received by November 8." }),
      ]),
    ).toHaveLength(1);
  });

  it("a plain receipt is done", () => {
    const due = notice(1, { what: "Your Week 3 report is due." });
    expect(lines([due, notice(2, { what: "Your Week 3 report has been received." })])).toEqual([]);
    expect(lines([due, notice(2, { what: "Week 3 report received." })])).toEqual([]);
  });

  it("a short line that could be either of two things ends neither", () => {
    const [lab, expense] = [
      notice(1, { what: "Your lab report is due." }),
      notice(2, { what: "Your expense report is due." }),
    ];
    expect(lines([lab, expense, notice(3, { what: "Report received." })])).toHaveLength(2);
  });

  it("an institution's chase in an advertisement's words stays, and an advertisement in them does not", () => {
    const chase = "Last chance to submit your Week 3 report, it is due today.";
    expect(lines([notice(1, { what: chase })])).toEqual([chase]);
    expect(lines([notice(1, { what: "Last chance: the deadline for the Spring Fair is Sunday." })])).toEqual([]);
  });

  it("the owner's Drop holds for a chase in other words, and a Done does not", () => {
    const [due, chase] = [
      notice(1, { what: "Your studio report is due." }),
      notice(2, { what: "We have not received your studio report." }),
    ];
    const close = (ending: "dropped" | "done") => [
      { key: due.key, match: due.match, ending, at: NOW.toISOString(), due: "2026-11-08" },
    ];
    expect(compose({ plans: [due, chase], closes: close("dropped") }).items).toEqual([]);
    expect(compose({ plans: [due, chase], closes: close("done") }).items).toHaveLength(1);
  });

  it("a chase in other words keeps the window of the line it stands for", () => {
    const when = "2026-10-28";
    const late = notice(1, { what: "Your studio report is overdue.", when });
    expect(lines([late, notice(2, { what: "Please submit your studio report.", when })])).toHaveLength(1);
  });

  it("a due word in a calendar title is still a deadline", () => {
    expect(saysDeadline("Report due to Dana")).toBe(true);
  });
});

describe("what a notice's words ask to be read again", () => {
  it.each([
    "Your log is overdue",
    "Bill past due",
    "Log deadline: Sunday",
    "Rent is due on the 3rd",
    "We have received your form",
    "Your filing was submitted",
    "We haven't received your form",
  ])("%s", (text) => {
    expect(saysNoticeDue(text)).toBe(true);
  });
  it.each([
    "Your package shipped",
    "Due to rain the concert moved",
    "Your statement is ready",
    "You received this email because you subscribed.",
    "We received your order.",
  ])("not: %s", (text) => {
    expect(saysNoticeDue(text)).toBe(false);
  });
});

describe("a line says a thing was done only by saying so plainly", () => {
  it.each([
    "We have received your Week 3 studio report.",
    "We received your form.",
    "Your application was received.",
    "Your tuition has been paid.",
    "Week 3 report received.",
    "Report received.",
    "You've submitted your form.",
    "Your return was filed!",
  ])("done: %s", (text) => {
    expect(saysDone(text)).toBe(true);
  });

  const STANDS = [
    "Please make sure payment is received by Friday.",
    "Please ensure the form is submitted by Friday.",
    "Your deposit was received, balance due May 1.",
    "You've submitted part one, part two due Friday.",
    "We have received your application. Please submit your transcript by May 1.",
    "A complaint was filed. You must respond by Nov 20.",
    "Your rent is paid on the first of the month.",
    "No payment was received.",
    "Nothing was received.",
    "You have completed 2 of 5 modules.",
    "Make sure your tuition is paid.",
    "No tuition was received.",
    "Tax return to be filed",
    "Forms need to be submitted",
    "Rent should be paid",
    "Your FAFSA has yet to be filed",
    "Final grades will be submitted",
    "Get your paperwork filed",
    "Have your transcript submitted",
    "Your Week 3 report has not been received",
    "Your Week 3 report hasn't been received",
    "Your tuition has not been paid",
    "Your form has not been submitted",
    "Your form has never been filed",
    "Your enrolment is not complete until payment is received",
    "Your return is due March 1 unless you received an extension",
    "You filed an extension; your return is due March 1",
    "You filed an extension, and your return is due March 1",
    "Your tuition is due March 1 and has not been paid",
    "If you have paid, ignore this",
    "Has your form been received?",
    "You will hear from us when your form is received",
    "We have no record your form was received",
    "Your Week 3 report is overdue and was not received",
    "Payment must be received by November 8.",
    "Your tuition has been paid in part.",
    "Your tuition was paid but a balance remains.",
    "We have not received your Week 3 studio report, and its deadline has passed.",
  ];
  it.each(STANDS)("not done: %s", (text) => {
    expect(saysDone(text)).toBe(false);
  });

  it.each([
    "Please make sure payment is received by Friday.",
    "Please ensure the form is submitted by Friday.",
    "Your deposit was received, balance due May 1.",
    "You've submitted part one, part two due Friday.",
    "We have received your application. Please submit your transcript by May 1.",
    "A complaint was filed. You must respond by Nov 20.",
    "Your rent is paid on the first of the month.",
    "No payment was received.",
    "Make sure your tuition is paid.",
    "No tuition was received.",
    "Your Week 3 report has not been received",
    "Your tuition has not been paid",
    "Your form has not been submitted",
    "Your enrolment is not complete until payment is received",
    "Your return is due March 1 unless you received an extension",
    "You filed an extension; your return is due March 1",
    "Your tuition is due March 1 and has not been paid",
  ])("stays on the list: %s", (what) => {
    expect(lines([notice(2, { what })])).toEqual([what]);
  });

  it("a chase that says it has not been received stands for the line it repeats", () => {
    const chase = "Your studio report has not been received.";
    expect(lines([notice(1, { what: "Your studio report is due." }), notice(2, { what: chase })])).toEqual([chase]);
  });

  it("applies to a mailing alone: a person's line that says it stays, and lapses by itself", () => {
    const what = "Your housing payment was received.";
    expect(lines([notice(1, { what, bulk: false })])).toEqual([what]);
  });
});

describe("what ends a line, and what cannot", () => {
  const due = notice(1, { what: "Your tax report is due." });
  const receipt = notice(2, { what: "Your tax report was received." });

  it("a receipt ends a line only when its mail passed authentication", () => {
    expect(lines([due, receipt])).toEqual([]);
    expect(lines([due, { ...receipt, authed: false }])).toEqual([due.what]);
    const { authed: _authed, ...unknown } = receipt;
    expect(lines([due, unknown])).toEqual([due.what]);
  });

  it("a later notice replaces an earlier one only when it holds all the earlier one's words", () => {
    const both = notice(1, { what: "Transcript and immunization form due" });
    const part = notice(2, { what: "Transcript due" });
    expect(lines([both, part])).toEqual(expect.arrayContaining([both.what, part.what]));
    const whole = notice(3, { what: "Transcript and immunization form overdue" });
    expect(lines([part, whole])).toEqual([whole.what]);
  });

  it("only when its words, less the done words, are the line's, less the due words", () => {
    const whole = notice(1, { what: "Your tuition and housing payment is due." });
    expect(lines([whole, notice(2, { what: "Your housing payment was received." })])).toEqual([whole.what]);
    expect(lines([whole, notice(2, { what: "Your tuition and housing payment was received." })])).toEqual([]);
    const tuition = notice(1, { what: "Your tuition is due." });
    expect(lines([tuition, notice(2, { what: "Your tuition has been paid." })])).toEqual([]);
    expect(lines([tuition, notice(2, { what: "Your tuition has been paid in part." })])).toContain(tuition.what);
    expect(lines([tuition, notice(2, { what: "Your tuition was paid but a balance remains." })])).toContain(
      tuition.what,
    );
    // The accepted cost: this stays until it lapses.
    const payment = notice(1, { what: "Your tuition payment is due." });
    expect(lines([payment, notice(2, { what: "Payment received." })])).toEqual([payment.what]);
  });
});

describe("whose date it is", () => {
  it.each([
    "Course registration closes March 5, your deadline",
    "The application deadline for your program is November 8.",
    "Application deadline is November 8.",
    "Application deadline: March 5 for the spring cohort",
    "Registration deadline is March 5",
    "Your admission offer expires",
    "Your job offer expires",
    "Registration closes for spring classes",
    "Last chance to submit your housing deposit",
    "Immunization form, due to Health Services",
    "Due to the Registrar: your FERPA form",
  ])("a real deadline costs more to lose than an advertisement to keep: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([what]);
  });

  it.each([
    "Applications close March 5",
    "Sale ends Friday: your deadline to save.",
    "Hurry, 20% off, your deadline is Friday.",
    "Offer expires soon",
    "Deals end Sunday",
    "Due to high demand, register now",
    "Register now due to limited seats",
  ])("a sale or an opening is nothing: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([]);
  });

  it("due to limited seats is no due word", () => {
    expect(saysNoticeDue("Few places, due to limited seats")).toBe(false);
    expect(lines([notice(1, { what: "Your report is due to the registrar." })])).toHaveLength(1);
  });

  it.each([
    "Your appointment is fixed for May 3",
    "Your interview is scheduled for May 3",
    "Your reservation is confirmed for May 3",
    "Your next appointment is set for May 3",
    "Your pickup is booked for May 3",
  ])("a date fixed for the owner to attend stays: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([what]);
  });

  it.each([
    "Complete your I-9",
    "Sign your lease",
    "Upload your transcript",
    "Accept your financial aid award",
    "Verify your enrollment",
    "Respond to your jury summons",
    "Tuition unpaid",
    "Balance owed on your account",
    "Outstanding balance on your account",
    "Tuition payable",
    "Action required: verify your identity",
    "Last day to drop a class",
    "Hold on your account: clear it",
    "Your court date is set",
    "Your interview is on Monday",
    // A stray one, which the 3-day window takes off.
    "Complete your profile",
    "Complete your booking by Friday.",
  ])("a mailing's line that asks something of the owner stays: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([what]);
    expect(lines([notice(1, { what, when: "2026-10-30" })])).toEqual([]);
  });

  it.each([
    "Complete the survey",
    "Accept these terms for a free gift",
    "Return to our homepage",
    "Early-bird registration",
  ])("what asks nothing of the owner is still news: %s", (what) => {
    expect(lines([notice(1, { what })])).toEqual([]);
  });

  it.each([
    "Plan your visit by Friday.",
    "Reserve now for your visit.",
    "Finish your reservation before it expires.",
    "Your next appointment is available, call us.",
    "Your interview tips webinar is scheduled for Friday.",
    "Book your appointment by May 3",
    "Summit pass confirmed, doors open at nine",
  ])("a mailing's other date is news: %s", (what) => {
    const shown = lines([notice(1, { what })]);
    // "expires" says a deadline, and a word rule may keep a line: what matters is that attendance did not.
    expect(shown).toEqual(/expires/.test(what) ? [what] : []);
  });
});

describe("an amount of nothing is not due", () => {
  it.each(["Amount due: $0.00. Thanks for your order", "Balance due: 0.00", "$0.00 due", "Nothing further is due"])(
    "%s",
    (text) => {
      expect(saysNoticeDue(text)).toBe(false);
    },
  );
  it.each(["Amount due: $0.50", "Amount due: $10.00", "Amount due: $0.00 last month, $12 is due now"])("%s", (text) => {
    expect(saysNoticeDue(text)).toBe(true);
  });
});

describe("a person's line that puts a deadline on the owner", () => {
  it("says so, addressed to the reader or to no one else", () => {
    for (const line of [
      "Your essay on tidal power is due Friday.",
      "Final drafts are due December 5.",
      "I need your signed form by the deadline on Friday.",
      "Please submit your lab notes by Monday.",
      "Friday's deadline for the final draft stands.",
    ])
      expect(saysDeadlineToOwner(line), line).toBe(true);
  });

  it("not their own deadline, someone else's, a wish, a cause or a plain remark", () => {
    for (const line of [
      "My paper on tidal power is due Friday.",
      "My paper is due Friday, thank you.",
      "We have a deadline on Friday for our grant, let me know if you can help.",
      "Her report is due Friday.",
      "Sam's essay is due Friday.",
      "The report for him is due Friday.",
      "See you at the exam on Friday.",
      "Registration opens Friday.",
      "Your application has been received.",
      "Applications close Friday, apply now.",
      "Hope your exam goes well on Friday.",
      "Good luck with the essay!",
      "Lunch was late due to the weather.",
      "See you at the cafe on Friday.",
    ])
      expect(saysDeadlineToOwner(line), line).toBe(false);
  });
});
