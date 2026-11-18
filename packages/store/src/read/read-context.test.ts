import { type Cite, CONTEXT_CODE_POINTS, ContextView, compactResult } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { at, belief, cite, fp, OWNER, ownerSide, person } from "../test-support/card-fixtures.ts";
import { linesOf } from "./read-card.ts";
import { domainsOf, fit, readOf, sectionPeople, sectionsForPeople } from "./read-context.ts";

// context's pure parts. Synthetic values only.

describe("the domains a task picks", () => {
  it("takes the pinned words in R4's normal form, most words first, then in the domains' order", () => {
    expect(domainsOf("Prepare for my job INTERVIEW, next week!")).toEqual(["career"]);
    expect(domainsOf("plan a trip to see my parents")).toEqual(["family", "travel"]);
    expect(domainsOf("money for the trip, the flight and the hotel")).toEqual(["travel", "money"]);
    expect(domainsOf("what is next")).toEqual([]);
  });

  it("picks at most three", () => {
    expect(domainsOf("job startup school money health family")).toEqual(["career", "ventures", "education"]);
  });
});

describe("the people a section names", () => {
  it("counts the cites that name each person, the speaker and the people in its fields and values, never the owner or an organization", () => {
    const ada = person(1);
    const bo = person(2);
    const org = { ...person(3), kind: "organization" as const };
    const beliefs = [
      ownerSide("goal", 1, "career", "ship the review", 0, ada),
      ownerSide("need", 2, "career", "a reviewer", 1, ada),
      belief("goal", 3, { domain: "career" }, [
        cite("goal", { what: { untrusted: "hire" }, domain: "career" }, { by: bo }),
      ]),
      ownerSide("goal", 4, "health", "sleep more", 0, org),
      ownerSide("goal", 5, "health", "walk daily"),
    ];
    const people = sectionPeople(
      linesOf(beliefs),
      new Map(beliefs.map((one) => [one.fact, Object.values(one.values)])),
    );
    expect(people.get("career")).toEqual([
      { who: ada, claims: 2 },
      { who: bo, claims: 1 },
    ]);
    expect(people.get("health")).toEqual([]);
    expect(JSON.stringify([...people])).not.toContain(OWNER.id);
  });
});

describe("the read set", () => {
  const ada = person(1);
  const contactCite = {
    ...(cite("goal", { what: { untrusted: "from a contact" }, domain: "career" }) as object),
    id: fp(77),
    message: null,
  } as Cite;
  const [own] = linesOf([belief("goal", 7, { domain: "career" }, [contactCite])]);
  const value = ContextView.parse({
    domains: ["career"],
    sections: [{ domain: "career", lines: [own!.line], people: [], activeAt: at(0), more: false }],
    // Ada's lines were all cut by fit; Ada's head's role and affiliation are still served.
    people: [
      {
        who: ada,
        current: {
          role: { title: { untrusted: "Head of Research" }, organization: null, organizationName: null, since: at(0) },
        },
        lastAt: null,
        nextMeeting: null,
        lines: [],
        more: true,
      },
    ],
    commitments: [],
    goals: [],
    evidence: [],
    more: true,
  });
  const served = [
    { person: value.people[0]!, cites: new Map(), evidence: () => [], bound: ["evd_ada"], current: [fp(5), fp(6)] },
  ];
  // The section line's belief cites a contact's claim and two more: each binds, and a finding shows.
  const ownBound = new Map([[own!.line.fact, ["evd_contact", "evd_second", "evd_third"]]]);
  const ownShown = new Map([[own!.line.fact, ["rec_finding"]]]);
  const read = readOf(value, { ownBound, ownShown, citeOf: new Map(), served, commitmentsBound: [], passages: [] });

  it("names the fact keys of a served person's role and affiliation even when fit cut their lines", () => {
    expect(read.factKeyFps).toEqual(expect.arrayContaining([fp(5), fp(6), fp(7)]));
    expect(
      readOf(
        { ...value, people: [] },
        { ownBound: new Map(), ownShown: new Map(), citeOf: new Map(), served, commitmentsBound: [], passages: [] },
      ).factKeyFps,
    ).not.toContain(fp(5));
  });

  it("binds every cite a section line drew on, an own contact's as a message's, and shows its findings' records", () => {
    expect(read.bound).toEqual(expect.arrayContaining(["evd_contact", "evd_second", "evd_third", "evd_ada"]));
    expect(read.shown).toContain("rec_finding");
    // A line fit cut binds nothing.
    const cut = readOf(
      { ...value, sections: [] },
      { ownBound, ownShown, citeOf: new Map(), served, commitmentsBound: [], passages: [] },
    );
    expect(cut.bound).toEqual(["evd_ada"]);
    expect(cut.shown).toEqual([]);
  });
});

describe("the whole within CONTEXT_CODE_POINTS", () => {
  const line = (n: number) =>
    ({
      fact: fp(n),
      kind: "goal",
      domain: "career",
      line: { untrusted: "x".repeat(200) },
      tier: "owner",
      status: "active",
      since: at(0),
      at: at(n),
      cites: 1,
    }) as const;
  const view = ContextView.parse({
    domains: ["career"],
    sections: [
      {
        domain: "career",
        lines: Array.from({ length: 10 }, (_, n) => line(n)),
        people: [],
        activeAt: at(9),
        more: false,
      },
    ],
    people: [],
    commitments: [],
    goals: [],
    evidence: Array.from({ length: 6 }, (_, n) => ({
      fact: fp(n),
      claim: fp(100 + n),
      source: { kind: "message", id: `msg_${String(n).padStart(26, "0")}` },
      passage: { untrusted: "y".repeat(400) },
      cut: false,
    })),
    more: false,
  });
  const size = (value: ContextView): number => [...JSON.stringify(compactResult("context", value))].length;

  it("leaves a view that fits as it is", () => {
    expect(fit(view)).toEqual(view);
    expect(size(view)).toBeLessThan(CONTEXT_CODE_POINTS);
  });

  it("a stale line its fit cuts joins what the section says it left off", () => {
    const stale = {
      ...view,
      sections: view.sections.map((one) => ({
        ...one,
        lines: one.lines.map((each) => ({ ...each, stale: true as const })),
        staleLeftOff: 2,
      })),
    };
    const cut = fit(stale, 1_500).sections[0];
    const gone = 10 - (cut?.lines.length ?? 0);
    expect(gone).toBeGreaterThan(0);
    expect(cut?.staleLeftOff).toBe(2 + gone);
  });

  it("cuts passages first, then lines, and says more", () => {
    const smaller = fit(view, size(view) - 1);
    expect(smaller.evidence).toHaveLength(5);
    expect(smaller.sections[0]?.lines).toHaveLength(10);
    expect(smaller.more).toBe(true);
    const tiny = fit(view, 1_000);
    expect(tiny.evidence).toEqual([]);
    expect(tiny.sections[0]?.more).toBe(true);
    expect(size(tiny)).toBeLessThanOrEqual(1_000);
  });
});

describe("sectionsForPeople", () => {
  const section = (domain: string) =>
    ({ domain, lines: [], people: [], activeAt: "2026-01-01T00:00:00.000Z", more: false }) as never;
  // Names the person even where the section's own list was cut to its top few.
  const namedIn = new Map([["family", [{ who: { id: "ent_met" }, claims: 1 }]]]) as never;

  it("serves the sections naming the people, then career, ventures and education, never recency's", () => {
    const built = [
      section("admin"),
      section("money"),
      section("interests"),
      section("education"),
      section("family"),
      section("career"),
    ];
    expect(
      sectionsForPeople(built, namedIn, new Set(["ent_met"])).map((one: { domain: string }) => one.domain),
    ).toEqual(["family", "career", "education"]);
  });

  it("serves nothing rather than a section that says nothing about them", () => {
    expect(sectionsForPeople([section("admin"), section("money")], namedIn, new Set(["ent_met"]))).toEqual([]);
  });
});
