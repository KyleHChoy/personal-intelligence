import { BeliefLine } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { datedTitle, dayIsOver, daysNamed, lastDayNamed, onlySaysTimeSuits, relativeEnd } from "../own-dates.ts";
import {
  type Finding,
  namesPattern,
  reportedApplications,
  reportsNaming,
  reportsOfDay,
  reportsOfPersonsMeeting,
  reportsOfProject,
  reportsOfSign,
  withItemReports,
} from "./agent-reports.ts";
import { applicationSignsOf } from "./first-read.ts";
import { isFragment, isStale, pastOnOf } from "./line-checks.ts";
import { composeOpenItems, type OpenInputs } from "./open-items.ts";

// What agents' findings say beside the fields, and what a line's own words say of time. Synthetic values only.

const NOW = new Date("2026-11-12T12:00:00Z");
const fp = (char: string): string => char.repeat(64);
const rec = (char: string): string => `rec_${char.repeat(26)}`;
const finding = (char: string, text: string, at = "2026-11-10T09:00:00.000Z"): Finding => ({
  id: rec(char),
  client: "helper",
  at,
  text,
});
const line = (words: string, over: Record<string, unknown> = {}): BeliefLine =>
  BeliefLine.parse({
    fact: fp("1"),
    kind: "situation",
    domain: null,
    line: { untrusted: words },
    tier: "owner",
    status: "active",
    since: "2026-11-01T00:00:00Z",
    at: "2026-11-01T00:00:00Z",
    cites: 1,
    ...over,
  });

describe("a line's own date", () => {
  it("names days in the forms people write them, a range by its last, rolling a past date to next year", () => {
    expect(daysNamed("Board offsite Nov 18-20 in Lisbon", "2026-11-01")).toEqual(["2026-11-20"]);
    expect(daysNamed("back on 3 December", "2026-11-01")).toEqual(["2026-12-03"]);
    expect(daysNamed("due 2026-11-15", "2026-11-01")).toEqual(["2026-11-15"]);
    expect(daysNamed("call on 11/14", "2026-11-01")).toEqual(["2026-11-14"]);
    expect(daysNamed("trip Jan 4", "2026-11-01")).toEqual(["2027-01-04"]);
    expect(lastDayNamed("from Nov 2 to Nov 9", "2026-11-01")).toBe("2026-11-09");
  });

  it("does not read a fraction, an ordinary word or a version as a date", () => {
    expect(daysNamed("about 3/4 done", "2026-11-01")).toEqual([]);
    expect(daysNamed("we may 3 times try", "2026-11-01")).toEqual([]);
    expect(daysNamed("open 24/7", "2026-11-01")).toEqual([]);
  });

  it("is over only once it has ended in every zone", () => {
    expect(dayIsOver("2026-11-10", new Date("2026-11-11T23:00:00Z"))).toBe(false);
    expect(dayIsOver("2026-11-10", new Date("2026-11-12T00:00:00Z"))).toBe(true);
  });

  it("marks a line whose named date has gone as past, whichever passing kind it is", () => {
    const passed = line("Situation: registered for the Harbor Summit Nov 3-5");
    expect(isStale(passed, NOW)).toBe(true);
    expect(pastOnOf(passed, NOW)).toBe("2026-11-05");
    const goal = line("Goal: file the grant report by Nov 6", { kind: "goal" });
    expect(isStale(goal, NOW)).toBe(true);
  });

  it("leaves a date still ahead, a date from before it was said, and a trait alone", () => {
    expect(isStale(line("Situation: registered for the Harbor Summit Nov 30"), NOW)).toBe(false);
    // What began on a date holds past it.
    expect(isStale(line("Situation: moved to Denver on Oct 3"), NOW)).toBe(false);
    expect(pastOnOf(line("Situation: moved to Denver on Oct 3"), NOW)).toBeUndefined();
    expect(isStale(line("Prefers: the Nov 3 format", { kind: "preference" }), NOW)).toBe(false);
  });

  it("a passed by or until is the day it says, of any such kind", () => {
    const goal = line("Goal: file the form, by 2026-11-05", { kind: "goal", by: "2026-11-05" });
    expect(pastOnOf(goal, NOW)).toBe("2026-11-05");
    expect(isStale(goal, NOW)).toBe(true);
  });

  it("judges what was ahead from when the line was first said, so a later cite does not hide it", () => {
    const again = line("Situation: interview on Nov 5", { since: "2026-11-01T00:00:00Z", at: "2026-11-08T00:00:00Z" });
    expect(pastOnOf(again, NOW)).toBe("2026-11-05");
  });

  it("never reads a date in the template's tail: until and by already say that", () => {
    const line_ = line("Situation: on leave, until 2026-11-05", { until: "2026-11-30" });
    expect(isStale(line_, NOW)).toBe(false);
  });

  it("a count to something goes stale within days, and words for a span at its end", () => {
    const said = "2026-11-08T00:00:00.000Z";
    expect(relativeEnd("3 weeks before launch", said)).toBe(Date.parse("2026-11-11T00:00:00.000Z"));
    expect(isStale(line("Situation: 3 weeks before launch", { at: said, since: said }), NOW)).toBe(true);
    expect(isStale(line("Situation: 3 weeks before launch", { at: "2026-11-11T00:00:00Z" }), NOW)).toBe(false);
    expect(isStale(line("Situation: sprinting this week", { at: "2026-11-01T00:00:00Z" }), NOW)).toBe(true);
    expect(relativeEnd("working on the plan", said)).toBeNull();
  });
});

describe("a fragment", () => {
  it("a three-word capability said once is thin; one the owner confirmed or said twice is not", () => {
    expect(isFragment(line("Capability: bake sourdough loaves", { kind: "capability" }))).toBe(true);
    expect(isFragment(line("Capability: bake sourdough loaves", { kind: "capability", cites: 2 }))).toBe(false);
    expect(isFragment(line("Capability: bake sourdough loaves", { kind: "capability", tier: "owner_confirmed" }))).toBe(
      false,
    );
    expect(isFragment(line("Situation: renovating the kitchen now"))).toBe(false);
  });
});

describe("a calendar title's relative word", () => {
  it("reads as the date it stands for, against the day the event falls on", () => {
    expect(datedTitle("Reminder: lab report due TOMORROW", "2026-11-05")).toBe("Reminder: lab report due Fri Nov 6");
    expect(datedTitle("Tomorrow: rent due", "2026-11-07")).toBe("Sun Nov 8: rent due");
    expect(datedTitle("Essay due today 5pm", "2026-11-09")).toBe("Essay due Mon Nov 9 5pm");
    expect(datedTitle("Quarterly review", "2026-11-09")).toBe("Quarterly review");
  });
});

describe("a line that only says a time suits", () => {
  it("is told from one that asks for something", () => {
    expect(onlySaysTimeSuits("Tuesday the 9th at 2 pm PT would be perfect.")).toBe(true);
    expect(onlySaysTimeSuits("Monday 11/09 at 3pm works for me")).toBe(true);
    expect(onlySaysTimeSuits("Sounds good, Tuesday at noon")).toBe(true);
    expect(onlySaysTimeSuits("Tuesday works for the slide review, send the deck first")).toBe(false);
    expect(onlySaysTimeSuits("The draft works")).toBe(false);
    expect(onlySaysTimeSuits("Work on Friday morning")).toBe(false);
  });

  it("is no open item, and a plan that says a deadline stays one", () => {
    const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as never;
    const plan = (key: string, what: string) => ({
      key: key.repeat(64),
      what,
      match: key,
      when: "2026-11-20",
      at: NOW.getTime() - 1000,
      ownMail: true,
      refs: {},
    });
    const inputs: OpenInputs = {
      owner,
      commitments: [],
      nextSteps: [],
      plans: [plan("a", "Tuesday the 9th at 2 pm PT would be perfect."), plan("b", "Send the signed lease")],
      events: [],
      closes: [],
    };
    const { items } = composeOpenItems(inputs, NOW, null);
    expect(items.map((one) => one.what?.untrusted)).toEqual(["Send the signed lease"]);
  });

  it("a calendar item's words read by date, and it keeps its dates", () => {
    const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as never;
    const { items } = composeOpenItems(
      {
        owner,
        commitments: [],
        nextSteps: [],
        plans: [],
        closes: [],
        events: [
          {
            id: `evt_${"1".repeat(26)}`,
            title: "Reminder: lab report due TOMORROW",
            day: "2026-11-13",
            due: "2026-11-13T15:00:00.000Z",
            allDay: false,
            days: 1,
            minutes: 15,
            others: 0,
            declined: false,
          },
        ],
      },
      NOW,
      null,
    );
    expect(items[0]?.what?.untrusted).toBe("Reminder: lab report due Sat Nov 14");
    expect(items[0]?.due).toBe("2026-11-14");
  });
});

describe("what an agent reported, beside an open item", () => {
  const moved = finding("1", "The Nov 18 call with Ada moved. New times await a pick.");

  it("sets the sentence naming the item's day beside it, marked and naming its record", () => {
    expect(reportsOfDay([moved], "2026-11-18")).toEqual([
      {
        said: { untrusted: "The Nov 18 call with Ada moved." },
        record: rec("1"),
        client: "helper",
        at: moved.at,
        unconfirmed: true,
      },
    ]);
  });

  it("needs the day and a word that it changed", () => {
    expect(reportsOfDay([moved], "2026-11-19")).toEqual([]);
    expect(reportsOfDay([finding("2", "The Nov 18 call with Ada is about hiring.")], "2026-11-18")).toEqual([]);
  });

  it("changes no date, no state and no order of the items", () => {
    const item = { due: "2026-11-18", overdue: false, what: { untrusted: "that time suits" } } as never;
    const [one] = withItemReports([item], [moved], null) as { due: string; overdue: boolean; reported: unknown[] }[];
    expect(one).toMatchObject({ due: "2026-11-18", overdue: false });
    expect(one?.reported).toHaveLength(1);
    expect(withItemReports([item], [], null)).toEqual([item]);
  });
});

describe("what an agent reported, beside a person", () => {
  it("newest first, one sentence a finding, at most three, and only those naming them", () => {
    const names = (sentence: string) => /\bAda\b/.test(sentence);
    const reports = reportsNaming(
      [
        finding("1", "Ada asked for the deck.", "2026-11-01T00:00:00.000Z"),
        finding("2", "Nothing here names anyone."),
        finding("3", "Ada moved the call. Ada is away.", "2026-11-05T00:00:00.000Z"),
        finding("4", "Ada wrote back.", "2026-11-06T00:00:00.000Z"),
        finding("5", "Ada signed.", "2026-11-07T00:00:00.000Z"),
      ],
      names,
    );
    expect(reports.map((one) => one.said.untrusted)).toEqual(["Ada signed.", "Ada wrote back.", "Ada moved the call."]);
  });

  it("cuts a long sentence and keeps the mark", () => {
    const [one] = reportsNaming([finding("1", `Ada ${"word ".repeat(100)}`)], () => true);
    expect([...(one?.said.untrusted ?? "")].length).toBeLessThanOrEqual(240);
    expect(one?.unconfirmed).toBe(true);
  });

  it("matches whole words of a name", () => {
    expect(namesPattern(["Ada"]).test("Adam wrote")).toBe(false);
    expect(namesPattern(["Ada"]).test("ask ada, then")).toBe(true);
  });
});

describe("what an agent reported, among the applications", () => {
  const none = { messages: [], lines: [], openItems: [] };
  const mail = (subject: string, at: string) => ({
    id: `msg_${"1".repeat(26)}`,
    subject,
    from: "team@northwind.example",
    at,
    bulk: false,
    outbound: false,
  });

  it("marks a deadline whose date has passed, in its words or in `due`, and leaves one ahead live", () => {
    const signs = applicationSignsOf({
      ...none,
      now: NOW,
      messages: [mail("Linden fellowship applications deadline is Nov 3", "2026-10-20T00:00:00.000Z")],
    });
    expect(signs[0]).toMatchObject({ state: "deadline", passed: true });
    const ahead = applicationSignsOf({
      ...none,
      now: NOW,
      messages: [mail("Linden fellowship applications deadline is Nov 30", "2026-10-20T00:00:00.000Z")],
    });
    expect(ahead[0]?.passed).toBeUndefined();
    const item = applicationSignsOf({
      ...none,
      now: NOW,
      openItems: [
        { what: { untrusted: "Apply to the residency" }, due: "2026-11-02", source: { kind: "plan", id: fp("2") } },
      ],
    });
    expect(item[0]).toMatchObject({ state: "deadline", passed: true });
  });

  it("sets a report beside the sign it names, its state unmoved", () => {
    const signs = applicationSignsOf({
      ...none,
      now: NOW,
      messages: [mail("Linden fellowship applications deadline is Nov 30", "2026-10-20T00:00:00.000Z")],
      findings: [finding("1", "The owner decided not to apply to Linden this round.")],
    });
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ state: "deadline" });
    expect(signs[0]?.reported?.[0]).toMatchObject({ record: rec("1"), unconfirmed: true });
  });

  it("lists what only a finding says, as reported, and never what merely advertises", () => {
    const signs = applicationSignsOf({
      ...none,
      now: NOW,
      findings: [
        finding("1", "The owner is applying for the operations lead role at Northwind."),
        finding("2", "Anyone could apply if they wanted."),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["reported"]);
    expect(signs[0]).toMatchObject({
      what: { untrusted: "The owner is applying for the operations lead role at Northwind." },
      at: "2026-11-10T09:00:00.000Z",
    });
    expect(signs[0]?.reported?.[0]?.unconfirmed).toBe(true);
  });

  it("a report never pushes a source's sign off the list", () => {
    const messages = Array.from({ length: 15 }, (_, index) =>
      mail(`Birch ${index} application deadline is Nov 30`, `2026-10-${String(10 + index)}T00:00:00.000Z`),
    );
    const signs = applicationSignsOf({
      ...none,
      now: NOW,
      messages: messages.map((one, index) => ({ ...one, id: `msg_${String(index)}` })),
      findings: [finding("1", "The owner is applying for the operations lead role at Northwind.")],
    });
    expect(signs).toHaveLength(15);
    expect(signs.some((one) => one.state === "reported")).toBe(false);
  });

  it("a word many applications share names none of them", () => {
    const signs = applicationSignsOf({
      ...none,
      now: NOW,
      messages: [mail("Acme summer internship application deadline is Nov 30", "2026-10-20T00:00:00.000Z")],
      findings: [finding("1", "The owner decided not to apply to the Beta summer program.")],
    });
    expect(signs.find((one) => one.state === "deadline")?.reported).toBeUndefined();
    expect(signs.some((one) => one.state === "reported")).toBe(true);
  });

  it("with no findings, and with no clock, a sign is as it was", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [mail("Linden fellowship applications deadline is Nov 3", "2026-10-20T00:00:00.000Z")],
    });
    expect(signs[0]).not.toHaveProperty("passed");
    expect(signs[0]).not.toHaveProperty("reported");
  });

  it("two pure helpers agree on what a sign takes", () => {
    const one = finding("1", "The owner applied to Northwind last week.");
    expect(reportsOfSign([one], ["northwind"])).toHaveLength(1);
    expect(reportsOfSign([one], [])).toEqual([]);
    expect(reportedApplications([one], (sentence) => /northwind/i.test(sentence), 5)).toEqual([]);
  });
});

describe("what the combined review found", () => {
  const finding = (text: string): Finding => ({ id: "rec_1", client: "scout", at: "2026-11-04T00:00:00.000Z", text });

  it("no ordinary 'applied to' and no one else's application makes a sign", () => {
    for (const text of ["The label was applied to the thread.", "Rhea applied to the fellowship."])
      expect(reportedApplications([finding(text)], () => false, 3)).toEqual([]);
    for (const text of ["Applied to Birch.", "The owner is applying for the Birch role.", "He has applied to Birch."])
      expect(reportedApplications([finding(text)], () => false, 3)).toHaveLength(1);
  });

  it("a sign with no name of its own to a finding is still ended by its end", () => {
    const from = "team@alder.example";
    const message = (id: string, subject: string, at: string) => ({
      id,
      subject,
      from,
      at,
      bulk: false,
      outbound: false,
    });
    const signs = applicationSignsOf({
      messages: [
        message("1", "Your application for the Summer Internship", "2026-11-01T00:00:00.000Z"),
        message("2", "Your application for the Summer Internship was not successful", "2026-11-03T00:00:00.000Z"),
      ],
      lines: [],
      openItems: [],
    });
    expect(signs.map((one) => one.state)).toEqual(["closed"]);
  });

  it("a thing done or sent on an item's day says nothing of the item", () => {
    expect(reportsOfDay([finding("The grant report was submitted Nov 14.")], "2026-11-14")).toEqual([]);
    expect(reportsOfDay([finding("The call moved to Nov. 14 at noon.")], "2026-11-14")).toHaveLength(1);
  });

  it("a reported sign stays below the sourced ones, however fresh", () => {
    const signs = applicationSignsOf({
      messages: [
        {
          id: "1",
          subject: "Your application to Birch",
          from: "team@birch.example",
          at: "2026-10-01T00:00:00.000Z",
          bulk: false,
          outbound: false,
        },
      ],
      lines: [],
      openItems: [],
      findings: [finding("Applied to Alder.")],
    });
    expect(signs.map((one) => one.state)).toEqual(["in_progress", "reported"]);
  });
});

describe("what an agent reported, beside a next meeting", () => {
  const names = (sentence: string) => /\bAda\b/.test(sentence);
  it("takes a sentence naming them and the day that says it changed, and only that", () => {
    const moved = finding("1", "The Thu Nov 5 call with Ada was rescheduled on Nov 4.", "2026-11-04T00:00:00.000Z");
    const prep = finding("2", "Call prep for Ada on Nov 5.", "2026-11-04T00:00:00.000Z");
    const other = finding("3", "The Nov 5 call with Mina was moved.", "2026-11-04T00:00:00.000Z");
    const elsewhen = finding("4", "Ada moved the Nov 9 call.", "2026-11-04T00:00:00.000Z");
    const reports = reportsOfPersonsMeeting([moved, prep, other, elsewhen], "2026-11-05", names);
    expect(reports.map((one) => one.record)).toEqual([moved.id]);
    expect(reports[0]?.unconfirmed).toBe(true);
  });
});

describe("what the owner said no to, among the applications", () => {
  const no = {
    id: `opp_${"1".repeat(26)}`,
    what: "Submit the Linden application by Nov 8",
    at: "2026-10-30T00:00:00.000Z",
  };
  const none = { messages: [], lines: [], openItems: [] };

  it("lists a step that says application, as the owner's no and nothing more", () => {
    expect(applicationSignsOf({ ...none, ownerNoes: [no] })).toEqual([
      { state: "owner_no", what: { untrusted: no.what }, at: no.at, opportunity: no.id },
    ]);
    expect(applicationSignsOf({ ...none, ownerNoes: [{ ...no, what: "Book the Linden tour" }] })).toEqual([]);
  });

  it("takes what room is left, so no source's sign goes for it", () => {
    const messages = Array.from({ length: 15 }, (_, n) => ({
      id: `msg_${n}`,
      subject: `Your offer from Maple ${n}`,
      from: `hr${n}@maple${n}.example`,
      at: "2026-10-01T00:00:00.000Z",
      bulk: false,
      outbound: false,
    }));
    const signs = applicationSignsOf({ ...none, messages, ownerNoes: [no] });
    expect(signs).toHaveLength(15);
    expect(signs.some((one) => one.state === "owner_no")).toBe(false);
  });

  it("sets a later finding beside it, and moves neither", () => {
    const later = finding("9", "The owner is applying to Linden after all.", "2026-11-02T00:00:00.000Z");
    const [sign] = applicationSignsOf({ ...none, ownerNoes: [no], findings: [later] });
    expect(sign?.state).toBe("owner_no");
    expect(sign?.reported?.[0]?.record).toBe(later.id);
  });

  describe("applications: what the owner's no says, and one application once", () => {
    const NOW = new Date("2026-11-05T12:00:00Z");
    const signsOf = (over: Partial<Parameters<typeof applicationSignsOf>[0]>) =>
      applicationSignsOf({ messages: [], lines: [], openItems: [], now: NOW, ...over });
    const noAt = "2026-10-30T18:00:00.000Z";

    it("a step closed as already handled is no refusal; any other reason stays a no and says so", () => {
      const handled = signsOf({
        ownerNoes: [
          { id: "opp_a", what: "Submit the Northwind application by Nov 8", at: noAt, reason: "already_handled" },
        ],
      });
      expect(handled[0]).toMatchObject({ state: "step_handled", reason: "already_handled" });
      const no = signsOf({
        ownerNoes: [
          { id: "opp_a", what: "Submit the Northwind application by Nov 8", at: noAt, reason: "not_worth_it" },
        ],
      });
      expect(no[0]).toMatchObject({ state: "owner_no", reason: "not_worth_it" });
      const bare = signsOf({ ownerNoes: [{ id: "opp_a", what: "Submit the Northwind application", at: noAt }] });
      expect(bare[0]?.state).toBe("owner_no");
      expect(bare[0]).not.toHaveProperty("reason");
    });

    const said = (id: string, at: string, text: string) => ({ id, client: "moth", at, text });

    it("a sentence with no name of its own, in a finding that names a sign, is no row of its own", () => {
      const signs = signsOf({
        ownerNoes: [{ id: "opp_a", what: "Submit the Northwind application", at: noAt }],
        findings: [said("rec_a", "2026-11-02T00:00:00.000Z", "Northwind is hiring.\nDeadline to apply: Nov 20, 2026.")],
      });
      expect(signs.map((one) => one.state)).toEqual(["owner_no"]);
    });

    it("sentences that give a day a sign gives, or that another gave, are one row", () => {
      const beside = signsOf({
        ownerNoes: [{ id: "opp_a", what: "Submit the Northwind application by Nov 8", at: noAt }],
        findings: [
          said("rec_a", "2026-11-02T00:00:00.000Z", "Job posting deadline Nov 8, 2026; application form is open."),
        ],
      });
      expect(beside.map((one) => one.state)).toEqual(["owner_no"]);
      const twice = signsOf({
        findings: [
          said("rec_a", "2026-11-02T00:00:00.000Z", "Job posting deadline Nov 20, 2026; application form is open."),
          said("rec_b", "2026-10-30T00:00:00.000Z", "Deadline: apply by Friday 2026-11-20 on the form."),
        ],
      });
      expect(twice.map((one) => one.reported?.[0]?.record)).toEqual(["rec_a"]);
    });

    it("a sentence that names something else stands, whatever else the finding or a sign says", () => {
      const named = signsOf({
        ownerNoes: [{ id: "opp_a", what: "Submit the Northwind application by Nov 8", at: noAt }],
        findings: [
          said(
            "rec_a",
            "2026-11-02T00:00:00.000Z",
            "Reviewed Northwind.\nOwner is also applying to Bravo, deadline Nov 8, 2026.",
          ),
        ],
      });
      expect(named.map((one) => one.state)).toEqual(["owner_no", "reported"]);
    });

    it("duplicates use up no room: six findings of one day leave room for the next", () => {
      const same = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
        said(
          `rec_${id}`,
          `2026-11-0${9 - index}T00:00:00.000Z`,
          "Job posting deadline Nov 20, 2026; application is open.",
        ),
      );
      const other = said("rec_g", "2026-10-30T00:00:00.000Z", "Deadline: apply by 2026-11-25 on the form.");
      const signs = signsOf({ findings: [...same, other] });
      expect(signs.map((one) => one.reported?.[0]?.record)).toEqual(["rec_a", "rec_g"]);
    });

    it("a sentence that gives another day still stands, and a day gone says passed", () => {
      const signs = signsOf({
        findings: [
          said("rec_a", "2026-11-02T00:00:00.000Z", "Job posting deadline Nov 20, 2026; application form is open."),
          said("rec_b", "2026-10-20T00:00:00.000Z", "Deadline: apply by 2026-10-25 on the form."),
        ],
      });
      expect(signs.map((one) => one.reported?.[0]?.record)).toEqual(["rec_a", "rec_b"]);
      expect(signs[0]).not.toHaveProperty("passed");
      expect(signs[1]?.passed).toBe(true);
    });
  });
});

describe("what agents said of a project", () => {
  const finding = (text: string, project?: string) => ({
    id: "rec_1",
    client: "scout",
    at: "2026-11-04T10:00:00.000Z",
    text,
    ...(project === undefined ? {} : { project }),
  });
  const names = (sentence: string): boolean => /\bHarbor\b/.test(sentence);
  const said = (text: string, project?: string) =>
    reportsOfProject([finding(text, project)], "ent_p", "Harbor", names).map((one) => one.said.untrusted);

  it("a sentence about the project, with a word for its state, stands", () => {
    expect(said("Harbor is blocked on the vendor.")).toEqual(["Harbor is blocked on the vendor."]);
    expect(said("The Harbor pilot shipped on Tuesday.")).toEqual(["The Harbor pilot shipped on Tuesday."]);
  });

  it("a name of many words begins in the first words too", () => {
    const whole = (sentence: string): boolean => sentence.includes("Harbor Deal Room Portal Build");
    const named = reportsOfProject(
      [finding("The new Harbor Deal Room Portal Build is live.")],
      "ent_p",
      "Harbor Deal Room Portal Build",
      whole,
    );
    expect(named).toHaveLength(1);
  });

  it("a passing mention is none, though it ends in the project's name", () => {
    expect(said("Avoid: networking asks, faith topics, fundraising for Harbor.")).toEqual([]);
    expect(said("AGAINST: a student vs a two-year commitment vs Harbor, and blocked on nothing.")).toEqual([]);
  });

  it("a date on something else is none", () => {
    expect(said("The weekly build log for Harbor is due Sunday 2026-11-01 in the portal.")).toEqual([]);
    expect(said("Harbor log is due Sunday 2026-11-01.")).toEqual([]);
  });

  it("one filed under the project needs no name, but still says a state, and any of its sentences will do", () => {
    expect(said("The vendor signed on Tuesday.", "ent_p")).toEqual(["The vendor signed on Tuesday."]);
    expect(said("A note on lunch. The vendor signed on Tuesday.", "ent_p")).toEqual(["The vendor signed on Tuesday."]);
    expect(said("A note on lunch.", "ent_p")).toEqual([]);
  });
});
