import { BeliefLine } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { applicationSignsOf, isTopGoal, rankGoals, saysEnded } from "./first-read.ts";
import { isAdminNotice, isStale, useBandOf } from "./line-checks.ts";
import { buildSections, rankLines } from "./lines.ts";

// A first read of the owner: what leads and what falls. Synthetic values only.

const NOW = new Date("2026-11-04T12:00:00Z");
const fp = (char: string): string => char.repeat(64);
const line = (char: string, words: string, over: Record<string, unknown> = {}): BeliefLine =>
  BeliefLine.parse({
    fact: fp(char),
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

describe("a first read's sections", () => {
  it("leave a fragment off the whole page, say more, and serve it to a domain's read", () => {
    const useful = { section: "career" as const, line: line("1", "Situation: working on a new resume") };
    const fragment = { section: "career" as const, line: line("2", "Situation: traveling") };
    const whole = buildSections({ lines: [useful, fragment], people: new Map(), now: NOW });
    expect(whole[0]?.lines.map((one) => one.fact)).toEqual([fp("1")]);
    expect(whole[0]?.more).toBe(true);
    const domain = buildSections({ lines: [useful, fragment], people: new Map(), domain: "career", now: NOW });
    expect(domain[0]?.lines.map((one) => one.fact)).toEqual([fp("1"), fp("2")]);
    // What the owner confirmed and a constraint stay, however short.
    const short = [
      useful,
      { section: "career" as const, line: line("3", "Constraint: no alcohol", { kind: "constraint" }) },
      { section: "career" as const, line: line("4", "Situation: enrolled", { tier: "owner_confirmed" }) },
    ];
    expect(buildSections({ lines: short, people: new Map(), now: NOW })[0]?.lines).toHaveLength(3);
    // A card passes no clock, and keeps its lines.
    expect(buildSections({ lines: [useful, fragment], people: new Map() })[0]?.lines).toHaveLength(2);
  });
});

describe("a stale line", () => {
  it("is a passing state not said again in thirty days, ninety only when the owner confirmed it", () => {
    const old = { at: "2026-09-18T00:00:00Z", tier: "source" as const };
    expect(isStale(line("1", "Situation: working on a revised plan", old), NOW)).toBe(true);
    expect(isStale(line("2", "Need: a new battery charger", { ...old, kind: "need" }), NOW)).toBe(true);
    expect(isStale(line("3", "Situation: working on a revised plan", { tier: "source" }), NOW)).toBe(false);
    // The owner's own mail or chat said it once: that is no confirmation that it still holds.
    expect(isStale(line("6", "Situation: working on a revised plan", { ...old, tier: "owner" }), NOW)).toBe(true);
    expect(isStale(line("4", "Situation: enrolled in a course", { ...old, tier: "owner_confirmed" }), NOW)).toBe(false);
    expect(
      isStale(
        line("5", "Situation: enrolled in a course", { at: "2026-07-01T00:00:00Z", tier: "owner_confirmed" }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is never a line with a date still ahead, a goal or a constraint", () => {
    const old = { at: "2026-08-01T00:00:00Z" };
    expect(isStale(line("1", "Situation: abroad until spring", { ...old, until: "2026-12-31" }), NOW)).toBe(false);
    expect(isStale(line("2", "Goal: learn to sail well", { ...old, kind: "goal" }), NOW)).toBe(false);
    expect(isStale(line("3", "Constraint: no travel in winter", { ...old, kind: "constraint" }), NOW)).toBe(false);
  });

  it("falls below a trait on a first read, and keeps its place on a card, which passes no clock", () => {
    const stale = line("1", "Situation: working on a revised plan", { at: "2026-09-18T00:00:00Z", tier: "source" });
    const trait = line("2", "Prefers: quiet mornings at home", {
      kind: "preference",
      at: "2026-08-01T00:00:00Z",
      tier: "source",
    });
    expect(rankLines([stale, trait], new Map(), NOW).map((one) => one.fact)).toEqual([fp("2"), fp("1")]);
    expect(rankLines([stale, trait]).map((one) => one.fact)).toEqual([fp("1"), fp("2")]);
  });
});

describe("a goal", () => {
  it("leads the current lines of a section on a first read, whatever its tier or age", () => {
    const situation = line("1", "Situation: moving flat this month");
    const goal = line("2", "Goal: find a role I care about", {
      kind: "goal",
      tier: "owner_confirmed",
      at: "2026-10-01T00:00:00Z",
    });
    expect(rankLines([situation, goal], new Map(), NOW)[0]?.fact).toBe(fp("2"));
  });
});

describe("the sections' order on a first read", () => {
  it("goes by what is going on, so an instruction to agents keeps no section first", () => {
    const sections = buildSections({
      lines: [
        {
          section: "admin",
          line: line("1", "Prefers: agents write in my voice", { kind: "preference", at: "2026-11-03T00:00:00Z" }),
        },
        { section: "admin", line: line("2", "Situation: filing a claim form", { at: "2026-10-20T00:00:00Z" }) },
        {
          section: "career",
          line: line("3", "Goal: find a role I care about", { kind: "goal", at: "2026-10-30T00:00:00Z" }),
        },
      ],
      people: new Map(),
      now: NOW,
    });
    expect(sections.map((one) => one.domain)).toEqual(["career", "admin"]);
  });
});

describe("an administrative notice", () => {
  it("is a source's line about a delivery, an order, a bill or an account", () => {
    const source = { tier: "source" };
    for (const words of [
      "Situation: your parcel was delivered",
      "Alder Post, delivery: out for delivery",
      "Situation: new sign-in on your account",
      "Situation: your statement is ready",
      "Birch Bank, autopay: scheduled",
    ])
      expect(isAdminNotice(line("1", words, source))).toBe(true);
  });

  it("is never a source's line that merely uses such a word", () => {
    for (const words of [
      "Situation: leading the payment platform migration",
      "Alder Labs, subscription: contract renewal under negotiation",
      "Situation: signed a compensation package",
      "Situation: drafted the mission statement",
    ])
      expect(isAdminNotice(line("1", words, { tier: "source" }))).toBe(false);
  });

  it("is never the owner's own word, nor a source's line about anything else", () => {
    expect(isAdminNotice(line("1", "Situation: waiting on a delivery of parts"))).toBe(false);
    expect(isAdminNotice(line("2", "Alder Labs, hiring: second round", { tier: "source", kind: "status" }))).toBe(
      false,
    );
  });

  it("ranks low on a first read", () => {
    const notice = line("1", "Situation: your parcel was delivered", { tier: "source" });
    expect(useBandOf(notice, NOW)).toBeGreaterThanOrEqual(3);
  });
});

describe("the owner's first priority", () => {
  it("is the goal whose own statement says so, at the head, the others in the order given", () => {
    const goals = [
      { statement: { untrusted: "Run a marathon." } },
      { statement: { untrusted: "Find a role. My number one goal for the next three months." } },
      { statement: { untrusted: "Read more." } },
    ];
    const ranked = rankGoals(goals);
    expect(ranked.map((one) => one.statement.untrusted[0])).toEqual(["F", "R", "R"]);
    expect(ranked[0]).toMatchObject({ top: true });
    expect(ranked[1]).not.toHaveProperty("top");
  });

  it("comes before the owner's order within a domain, which orders the rest", () => {
    const goals = [
      { id: "a", statement: { untrusted: "Read more." } },
      { id: "b", statement: { untrusted: "Run a marathon." } },
      { id: "c", statement: { untrusted: "Find a role. My number one goal." } },
    ];
    expect(rankGoals(goals, new Map([["b", 1]])).map((one) => one.id)).toEqual(["c", "b", "a"]);
  });

  it("is read from a few plain ways of saying it", () => {
    for (const words of ["my top priority", "My #1 goal", "the most important thing", "main priority this year"])
      expect(isTopGoal(words)).toBe(true);
    for (const words of ["top of the mountain", "one goal", "get a priority pass"])
      expect(isTopGoal(words)).toBe(false);
  });
});

describe("applications", () => {
  const message = (id: string, subject: string, over: Record<string, unknown> = {}) => ({
    id: `msg_0000000000000000000000000${id}`,
    subject,
    from: `jobs@${id}.example`,
    at: `2026-10-2${id}T00:00:00.000Z`,
    bulk: true,
    outbound: false,
    ...over,
  });
  const none = { messages: [], lines: [], openItems: [] };

  it("reads a confirmation, an interview, an offer and a refusal from a subject, newest first", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Thank you for applying to Alder Labs"),
        message("2", "Invitation to interview at Birch"),
        message("3", "An update on your Cedar offer"),
        message("4", "Unfortunately we will not be moving forward with your application"),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["closed", "in_progress", "in_progress", "applied"]);
    expect(signs[3]).toMatchObject({
      what: { untrusted: "Thank you for applying to Alder Labs" },
      from: { untrusted: "jobs@1.example" },
    });
  });

  it("an update on an offer is not an offer; an offer letter is", () => {
    const state = (subject: string) => applicationSignsOf({ ...none, messages: [message("1", subject)] })[0]?.state;
    expect(state("An update on your Cedar offer")).toBe("in_progress");
    expect(state("Your offer letter from Cedar")).toBe("offer");
  });

  it("a body that ends it ends it, and a later end takes earlier signs of the same thing with it", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your offer from Cedar Project", { from: "team@cedar.example" }),
        message("2", "Your application to Birch", { from: "team@cedar.example" }),
        message("3", "An update on your Cedar offer", { from: "team@cedar.example", ended: true }),
      ],
    });
    expect(signs.map((one) => [one.state, one.what.untrusted])).toEqual([
      ["closed", "An update on your Cedar offer"],
      ["in_progress", "Your application to Birch"],
    ]);
  });

  it("a later end from another sender ends nothing, and an end before the sign ends nothing", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your application to Cedar was not successful", { from: "team@cedar.example" }),
        message("2", "Your offer from Cedar", { from: "team@cedar.example" }),
        message("3", "Your application to Birch", { from: "team@birch.example" }),
        message("4", "Your application to Birch was not successful", { from: "team@alder.example" }),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["closed", "in_progress", "offer", "closed"]);
  });

  it("an end from one sender leaves another application of that sender, and a generic end only an offer", () => {
    const from = { from: "no-reply@tracker.example" };
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your application for Software Engineer at Birch", from),
        message("2", "Your application for Software Engineer at Cedar was not successful", from),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["closed", "in_progress"]);
    const offer = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your application to Birch", from),
        message("2", "Your offer from Cedar", from),
        message("3", "An update on your offer", { ...from, ended: true }),
      ],
    });
    expect(offer.map((one) => [one.state, one.what.untrusted])).toEqual([
      ["closed", "An update on your offer"],
      ["in_progress", "Your application to Birch"],
    ]);
  });

  it("a generic end on a domain with two employers' offers ends neither", () => {
    const from = { from: "no-reply@tracker.example" };
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your offer from Birch", from),
        message("2", "Your offer from Cedar", from),
        message("3", "An update on your offer", { ...from, ended: true }),
      ],
    });
    expect(signs.map((one) => one.state).sort()).toEqual(["closed", "offer", "offer"]);
  });

  it("an end worded another way still takes an offer letter of the same employer", () => {
    const from = { from: "team@cedar.example" };
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your offer letter from Cedar", from),
        message("2", "Your offer from Cedar was withdrawn", { ...from, ended: true }),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["closed"]);
  });

  it("says a body ended it only from a plain way of saying so, above any quote", () => {
    expect(saysEnded("We are no longer able to move forward with your offer.")).toBe(true);
    expect(saysEnded("Unfortunately the role has been filled.")).toBe(true);
    expect(saysEnded("Your offer has been withdrawn.")).toBe(true);
    expect(saysEnded("We are excited to move forward with your application.")).toBe(false);
    expect(saysEnded("Please do not hesitate to reach out as we move forward.")).toBe(false);
    expect(saysEnded("Once your application form is filled out, send it back.")).toBe(false);
    expect(saysEnded("Good news.\n> we are no longer able to move forward")).toBe(false);
    expect(saysEnded("Good news.\nOn Mon, Nov 2 someone wrote:\nwe are no longer able to move forward")).toBe(false);
  });

  it("takes a line that names an application as its subject, not a program's", () => {
    const signs = (words: string) => applicationSignsOf({ ...none, lines: [line("1", words)] }).map((one) => one.state);
    expect(signs("Situation: Cedar Analyst application")).toEqual(["stated"]);
    expect(signs("Situation: Cedar application due soon")).toEqual(["stated"]);
    expect(signs("Situation: building a web application with the team")).toEqual([]);
    expect(signs("Situation: building a web application")).toEqual([]);
    expect(signs("Goal: ship the mobile application")).toEqual([]);
  });

  it("reads a refusal however it is worded, before it reads a live application", () => {
    for (const subject of ["Your application will not be moving forward", "Your application was not successful"])
      expect(applicationSignsOf({ ...none, messages: [message("1", subject)] })[0]?.state).toBe("closed");
  });

  it("takes no outbound mail about an application of software for one of the owner's", () => {
    const sent = (subject: string) => [message("1", subject, { outbound: true, bulk: false })];
    expect(applicationSignsOf({ ...none, messages: sent("web application review") })).toEqual([]);
    expect(applicationSignsOf({ ...none, messages: sent("My application for the role") })).toHaveLength(1);
  });

  it("takes no newsletter for an application", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Alder is hiring a chief of staff"),
        message("2", "Birch fellowship: applications close Sunday"),
        message("3", "Your exclusive offer ends soon"),
        message("4", "Apply now for a new card"),
      ],
    });
    expect(signs).toEqual([]);
  });

  it("counts a date to apply by only from mail written to the owner, and mail the owner sent about one", () => {
    const signs = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Application deadline is Friday"),
        message("2", "Application deadline is Monday", { bulk: false }),
        message("3", "Application for the operations role", { bulk: false, outbound: true }),
      ],
    });
    expect(signs.map((one) => one.state)).toEqual(["applied", "deadline"]);
  });

  it("counts one subject from one domain once, the newest, and shows at most fifteen", () => {
    const many = Array.from({ length: 20 }, (_, n) => ({
      ...message("1", "Your application to Alder"),
      id: `msg_000000000000000000000000${String(n).padStart(2, "0")}`,
      from: `jobs@d${n}.example`,
    }));
    expect(applicationSignsOf({ ...none, messages: many })).toHaveLength(15);
    const twice = applicationSignsOf({
      ...none,
      messages: [
        message("1", "Your application to Alder", { from: "a@alder.example" }),
        message("2", "Your application to Alder", { from: "b@alder.example" }),
        message("3", "Your application to Birch", { from: "b@alder.example" }),
      ],
    });
    expect(twice.map((one) => one.message)).toEqual([
      "msg_00000000000000000000000003",
      "msg_00000000000000000000000002",
    ]);
  });

  it("reads the owner's stated lines and a dated open item, and no preference about applying", () => {
    const signs = applicationSignsOf({
      messages: [],
      lines: [
        line("1", "Situation: Candidate for the operations lead role"),
        line("2", "Situation: applied to the Alder fellowship"),
        line("3", "Prefers: tracking of pending applications", { kind: "preference" }),
        line("5", "Situation: building mobile applications"),
        line("4", "Situation: moving flat this month"),
      ],
      openItems: [
        {
          what: { untrusted: "Alder fellowship application due" },
          due: "2026-11-08",
          source: { kind: "calendar", id: "evt_00000000000000000000000001" },
        },
        {
          what: { untrusted: "Dentist" },
          due: "2026-11-09",
          source: { kind: "calendar", id: "evt_00000000000000000000000002" },
        },
      ],
    });
    expect(signs.map((one) => one.state).sort()).toEqual(["deadline", "stated", "stated"]);
    expect(signs.find((one) => one.state === "deadline")).toMatchObject({
      due: "2026-11-08",
      event: "evt_00000000000000000000000001",
    });
    expect(signs.find((one) => one.state === "stated")?.fact).toMatch(/^[12]{64}$/);
  });
});

describe("a goal that calls itself first", () => {
  it("says so of the goal, and not of something else or in the negative", () => {
    expect(isTopGoal("My top priority is the launch")).toBe(true);
    expect(isTopGoal("The most important goal this year")).toBe(true);
    expect(isTopGoal("Meet the most important investors")).toBe(false);
    expect(isTopGoal("This is not my top priority")).toBe(false);
  });
});
