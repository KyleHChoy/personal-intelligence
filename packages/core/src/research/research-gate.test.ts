import { ResearchGateCause, ResearchSettings } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  filingAnswer,
  type ResearchEvent,
  type ResearchFacts,
  type ResearchGateRequest,
  researchGate,
  resolveQuery,
  sealCandidates,
} from "./research-gate.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ENTITY = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";
const MESSAGE = "msg_01JABCDEFGHJKMNPQRSTVWXYZ0";

const SETTINGS = ResearchSettings.parse({
  clientLinkRequests: false,
  maxRequestsPerClientPerDay: 5,
  maxSearchesPerDay: 10,
  maxFetchesPerDay: 30,
  maxPagesPerRequest: 5,
  refetchAfterDays: 30,
  cardExpiryDays: 14,
});

const search = (identifiers: unknown[], template = "person_profile", templateVersion = 1): ResearchGateRequest => ({
  compartments: ["own"],
  body: { kind: "search", template, templateVersion, identifiers, about: ENTITY },
});
const link = (url: string): ResearchGateRequest => ({
  compartments: ["own"],
  body: { kind: "link", message: MESSAGE, url },
});
const typed = (url: string, about: string | null = null, privateUrl = false): ResearchGateRequest => ({
  compartments: ["own"],
  body: { kind: "url", url, about, names: [], privateUrl },
});
const person = { kind: "person_name", value: "Mara Ellison" } as const;
const organization = { kind: "organization_name", value: "Ellison Studio" } as const;
const domain = { kind: "domain", value: "ellisonstudio.example" } as const;

const filed: ResearchEvent = { event: "filed", decision: null };
const approved: ResearchEvent = { event: "approved", decision: { kind: "research", answer: "approve", details: {} } };
const typedEvent = (privateUrl = false): ResearchEvent => ({
  event: "approved",
  decision: { kind: "research", answer: "typed", details: privateUrl ? { privateUrl: true } : {} },
});

const run = (patch: Partial<ResearchFacts> = {}): ResearchFacts => ({
  stage: "run",
  events: [filed, approved],
  vetoed: false,
  erased: false,
  sealed: false,
  today: { day: "2026-10-05", searches: 0, fetches: 0 },
  settings: SETTINGS,
  ...patch,
});
const filing = (patch: Partial<ResearchFacts> = {}): ResearchFacts => ({
  ...run({ events: [filed] }),
  stage: "filing",
  ...patch,
});

describe("researchGate", () => {
  it("clears a request that passes every check, at filing and at run", () => {
    expect(researchGate(search([person]), filing(), NOW)).toEqual({ cleared: true, causes: [] });
    expect(researchGate(search([person]), run(), NOW)).toEqual({ cleared: true, causes: [] });
    expect(
      researchGate(typed("https://profiles.example/people/mara-ellison", ENTITY), run({ events: [typedEvent()] }), NOW),
    ).toEqual({ cleared: true, causes: [] });
    // An owner's URL with no subject.
    expect(
      researchGate(typed("https://profiles.example/people/mara-ellison"), run({ events: [typedEvent()] }), NOW),
    ).toEqual({ cleared: true, causes: [] });
    expect(researchGate(link("https://profiles.example/people/mara-ellison"), run(), NOW)).toEqual({
      cleared: true,
      causes: [],
    });
  });

  it("every check runs and every cause is returned, in the table's order", () => {
    const request: ResearchGateRequest = {
      compartments: ["own", "employer:example"],
      body: { kind: "link", message: MESSAGE, url: "https://share.example/d/8fK2mQ9xLp4RtZ7vWb3N" },
    };
    const facts = run({
      events: [filed],
      vetoed: true,
      erased: true,
      sealed: true,
      today: { day: "2026-10-05", searches: 10, fetches: 30 },
    });
    expect(researchGate(request, facts, NOW)).toEqual({
      cleared: false,
      causes: ["no_authority", "private_url", "origin", "vetoed", "erased", "sealed", "budget"],
    });
    const bad = {
      ...search([{ kind: "person_name", value: "ent_01JABCDEFGHJKMNPQRSTVWXYZ0" }]),
      compartments: ["agent:helper"],
    };
    expect(researchGate(bad, { ...facts, sealed: false }, NOW).causes).toEqual([
      "no_authority",
      "bad_form",
      "origin",
      "vetoed",
      "erased",
      "budget",
    ]);
    // The order is the contract's list of causes.
    const all = researchGate(request, facts, NOW).causes;
    expect(all).toEqual(ResearchGateCause.options.filter((cause) => all.includes(cause)));
  });

  it("at filing every check but authority and budget runs", () => {
    const facts = filing({ vetoed: true, today: { day: "2026-10-05", searches: 10, fetches: 30 } });
    expect(researchGate(search([person]), facts, NOW).causes).toEqual(["vetoed"]);
    // At filing, no today is needed.
    const { today: _today, ...noToday } = filing();
    expect(researchGate(search([person]), noToday, NOW)).toEqual({ cleared: true, causes: [] });
  });

  it("a request with no approved event is no_authority", () => {
    expect(researchGate(search([person]), run({ events: [filed] }), NOW).causes).toEqual(["no_authority"]);
    expect(researchGate(search([person]), run({ events: [] }), NOW).causes).toEqual(["no_authority"]);
    // An approved event that rests on no research decision, or on a decline, is no authority.
    expect(
      researchGate(search([person]), run({ events: [filed, { event: "approved", decision: null }] }), NOW).causes,
    ).toEqual(["no_authority"]);
    expect(
      researchGate(
        search([person]),
        run({ events: [filed, { event: "approved", decision: { kind: "veto", answer: "approve", details: {} } }] }),
        NOW,
      ).causes,
    ).toEqual(["no_authority"]);
    expect(
      researchGate(
        search([person]),
        run({ events: [filed, { event: "approved", decision: { kind: "research", answer: "decline", details: {} } }] }),
        NOW,
      ).causes,
    ).toEqual(["no_authority"]);
    // An approval undone by a later event is no authority.
    for (const event of ["declined", "expired", "withdrawn", "tainted", "failed", "done"] as const) {
      expect(
        researchGate(search([person]), run({ events: [filed, approved, { event, decision: null }] }), NOW).causes,
        event,
      ).toEqual(["no_authority"]);
    }
    // Running and waiting keep it.
    expect(
      researchGate(
        search([person]),
        run({ events: [filed, approved, { event: "running", decision: null }, { event: "waiting", decision: null }] }),
        NOW,
      ).cleared,
    ).toBe(true);
  });

  it("bad_form: an unknown template, an old version, identifiers the template does not take, an id-shaped value, a URL that is no page URL", () => {
    const facts = run();
    expect(researchGate(search([person], "person_secrets"), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(search([person], "person_profile", 2), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(search([domain], "person_profile"), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(search([]), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(search([person, organization, domain, person]), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(search([{ kind: "person_name", value: "Mara Ellison", extra: 1 }]), facts, NOW).causes).toEqual(
      ["bad_form"],
    );
    expect(
      researchGate(search([{ kind: "organization_name", value: "Studio 123456" }], "organization_profile"), facts, NOW)
        .causes,
    ).toEqual(["bad_form"]);
    expect(
      researchGate(
        {
          ...search([person]),
          body: {
            kind: "search",
            template: "person_profile",
            templateVersion: 1,
            identifiers: [person],
            about: "not an id",
          },
        },
        facts,
        NOW,
      ).causes,
    ).toEqual(["bad_form"]);
    expect(researchGate(link("https://intranet.local/x"), facts, NOW).causes).toEqual(["bad_form"]);
    expect(researchGate(typed("ftp://profiles.example/x"), run({ events: [typedEvent()] }), NOW).causes).toEqual([
      "bad_form",
    ]);
    // A URL must be given in its canonical form.
    expect(researchGate(link("https://Profiles.Example/people/mara-ellison"), facts, NOW).causes).toEqual(["bad_form"]);
    // The identifiers of a template's combination, in any order.
    expect(researchGate(search([organization, person], "person_role"), facts, NOW).cleared).toBe(true);
  });

  it("private_url: a link's private URL always; an owner's typed URL unless they gave --private-url", () => {
    const tokened = "https://share.example/d/8fK2mQ9xLp4RtZ7vWb3N";
    expect(researchGate(link(tokened), run(), NOW).causes).toEqual(["private_url"]);
    expect(researchGate(link(tokened), run({ events: [typedEvent(true)] }), NOW).causes).toEqual(["private_url"]);
    expect(researchGate(typed(tokened), run({ events: [typedEvent()] }), NOW).causes).toEqual(["private_url"]);
    expect(researchGate(typed(tokened, null, true), run({ events: [typedEvent(true)] }), NOW).causes).toEqual([]);
    // The body's flag and the owner's decision must both say so.
    expect(researchGate(typed(tokened, null, true), run({ events: [typedEvent()] }), NOW).causes).toEqual([
      "private_url",
    ]);
    expect(researchGate(typed(tokened), run({ events: [typedEvent(true)] }), NOW).causes).toEqual(["private_url"]);
    // A query is private too.
    expect(
      researchGate(typed("https://profiles.example/people?name=mara"), run({ events: [typedEvent()] }), NOW).causes,
    ).toEqual(["private_url"]);
  });

  it("an employer, a restricted:health and an unknown compartment in the label are each origin", () => {
    for (const compartment of [
      "employer:example",
      "employer:example-released",
      "restricted:health",
      "declassified",
      "agent:helper",
      "someday",
    ]) {
      expect(
        researchGate({ ...search([person]), compartments: ["own", compartment] }, run(), NOW).causes,
        compartment,
      ).toEqual(["origin"]);
    }
    expect(researchGate({ ...search([person]), compartments: [] }, run(), NOW).causes).toEqual(["origin"]);
    expect(researchGate({ ...search([person]), compartments: ["own", "public"] }, run(), NOW).causes).toEqual([]);
    expect(researchGate({ ...search([person]), compartments: ["public"] }, run(), NOW).causes).toEqual([]);
  });

  it("a veto on the about entity is vetoed; an erased URL or entity is erased", () => {
    expect(researchGate(search([person]), run({ vetoed: true }), NOW).causes).toEqual(["vetoed"]);
    expect(
      researchGate(link("https://profiles.example/people/mara-ellison"), run({ erased: true }), NOW).causes,
    ).toEqual(["erased"]);
  });

  it("a sealed host or domain identifier is sealed", () => {
    expect(
      researchGate(link("https://profiles.example/people/mara-ellison"), run({ sealed: true }), NOW).causes,
    ).toEqual(["sealed"]);
    expect(researchGate(search([person, domain]), run({ sealed: true }), NOW).causes).toEqual(["sealed"]);
  });

  it("sealCandidates names the host and each domain identifier with every parent domain, so a seal covers its subdomains", () => {
    expect(sealCandidates(link("https://a.b.profiles.example/x").body)).toEqual([
      "a.b.profiles.example",
      "b.profiles.example",
      "profiles.example",
    ]);
    expect(sealCandidates(search([person, domain]).body)).toEqual(["ellisonstudio.example"]);
    expect(sealCandidates(search([person]).body)).toEqual([]);
    expect(sealCandidates(link("not a url").body)).toEqual([]);
  });

  it("at the day's cap the only cause is budget", () => {
    const capped = (searches: number, fetches: number) => run({ today: { day: "2026-10-05", searches, fetches } });
    expect(researchGate(search([person]), capped(10, 0), NOW).causes).toEqual(["budget"]);
    expect(researchGate(search([person]), capped(0, 30), NOW).causes).toEqual(["budget"]);
    expect(researchGate(search([person]), capped(9, 29), NOW).causes).toEqual([]);
    // A fetch needs no search.
    expect(researchGate(link("https://profiles.example/people/mara-ellison"), capped(10, 0), NOW).causes).toEqual([]);
    expect(researchGate(link("https://profiles.example/people/mara-ellison"), capped(0, 30), NOW).causes).toEqual([
      "budget",
    ]);
  });

  it("counts of another day, or none, are budget: nothing leaves on counts the gate cannot trust", () => {
    expect(
      researchGate(search([person]), run({ today: { day: "2026-10-04", searches: 0, fetches: 0 } }), NOW).causes,
    ).toEqual(["budget"]);
    const { today: _today, ...noToday } = run();
    expect(researchGate(search([person]), noToday, NOW).causes).toEqual(["budget"]);
  });
});

describe("filingAnswer", () => {
  it("maps bad_form to invalid_request, and private_url and origin to not_permitted, the first in the table's order", () => {
    expect(filingAnswer(["bad_form"])).toBe("invalid_request");
    expect(filingAnswer(["private_url"])).toBe("not_permitted");
    expect(filingAnswer(["origin"])).toBe("not_permitted");
    expect(filingAnswer(["bad_form", "origin", "vetoed"])).toBe("invalid_request");
  });

  it("filingAnswer gives vetoed, erased and sealed the answer of no cause", () => {
    expect(filingAnswer([])).toBeNull();
    expect(filingAnswer(["vetoed"])).toBeNull();
    expect(filingAnswer(["erased"])).toBeNull();
    expect(filingAnswer(["sealed"])).toBeNull();
    expect(filingAnswer(["vetoed", "erased", "sealed"])).toBeNull();
  });
});

describe("resolveQuery", () => {
  it("is the template's own words and each value in the given order, never joined", () => {
    expect(resolveQuery("person_role", [person, organization])).toEqual({
      words: "current role and employer of this named person",
      values: ["Mara Ellison", "Ellison Studio"],
    });
    expect(resolveQuery("person_role", [organization, person])).toEqual({
      words: "current role and employer of this named person",
      values: ["Ellison Studio", "Mara Ellison"],
    });
  });

  it("two requests with the same template and values give the same query, whoever filed them", () => {
    const one = resolveQuery("organization_people", [organization]);
    const other = resolveQuery("organization_people", [{ ...organization }]);
    expect(one).toEqual(other);
  });

  it("refuses a template that is not one of the fixed ones", () => {
    expect(() => resolveQuery("person_secrets", [person])).toThrow("unknown_template");
  });
});
