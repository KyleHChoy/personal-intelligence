import { BeliefLine, type Cite, CompiledBelief, LIFE_DOMAINS, SectionPerson } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { keyWords } from "../key-phrase.ts";
import {
  AFFILIATION_SECTIONS,
  buildSections,
  collapseByGroup,
  DOMAIN_KEYWORDS,
  HELD_PHRASE,
  proposalLine,
  rankLines,
  renderLine,
  type SectionedLine,
  sectionOf,
} from "./lines.ts";

// Belief lines. Synthetic values only.

const fp = (char: string): string => char.repeat(64);
const owner = {
  id: "ent_00000000000000000000000001",
  kind: "owner",
  name: { untrusted: "Sam Example" },
  address: null,
} as const;
const ada = {
  id: "ent_00000000000000000000000002",
  kind: "person",
  name: { untrusted: "Ada Example" },
  address: null,
} as const;
const acme = {
  id: "ent_00000000000000000000000003",
  kind: "organization",
  name: { untrusted: "Example Co" },
  address: { untrusted: "example.com" },
} as const;

const cite = (
  type: string,
  fields: Record<string, unknown>,
  at = "2026-09-01T10:00:00Z",
  over: Record<string, unknown> = {},
) => ({
  id: fp("1"),
  subject: owner,
  statedBy: owner,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at,
  message: "msg_00000000000000000000000004",
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: false,
  agentReported: false,
  provenance: "source",
  type,
  fields,
  ...over,
});
const held = (type: string, at = "2026-08-01T10:00:00Z") => ({ held: true, fact: fp("9"), type, at });
const text = (untrusted: string) => ({ untrusted });

// A compiled belief, checked against the contract so a fixture cannot drift from it.
function belief(
  kind: string,
  values: Record<string, unknown>,
  cites: unknown[],
  over: Record<string, unknown> = {},
): CompiledBelief {
  const type = kind === "project_status" ? "project.status" : kind === "decision" ? "project.decision" : kind;
  return CompiledBelief.parse({
    fact: fp("a"),
    state: fp("b"),
    kind,
    type,
    status: "active",
    disputed: false,
    provenance: "owner",
    tier: "owner",
    confirmedAt: "2026-09-02T00:00:00Z",
    reviewAfter: null,
    subject: owner,
    values,
    cites,
    ...over,
  });
}
const lineOf = (one: CompiledBelief): string => {
  const rendered = BeliefLine.parse(renderLine(one, one.cites[0] as Cite));
  return rendered.line.untrusted;
};

describe("renderLine", () => {
  it("renders each owner-side kind from a stored shape, its phrase the cite's key phrase", () => {
    expect(
      lineOf(
        belief("goal", { domain: "career", by: "2026-11-01" }, [
          cite("goal", { what: text("raise seed round"), domain: "career" }),
        ]),
      ),
    ).toBe("Goal: raise seed round, by 2026-11-01");
    expect(
      lineOf(belief("need", { domain: "home" }, [cite("need", { what: text("new lease"), domain: "home" })])),
    ).toBe("Need: new lease");
    expect(
      lineOf(
        belief("capability", { domain: "career" }, [
          cite("capability", { what: text("financial modelling"), domain: "career" }),
        ]),
      ),
    ).toBe("Capability: financial modelling");
    expect(
      lineOf(
        belief("preference", { polarity: "avoids", domain: "interests" }, [
          cite("preference", { what: text("em dashes"), polarity: "avoids", domain: "interests" }),
        ]),
      ),
    ).toBe("Avoids: em dashes");
    expect(
      lineOf(
        belief("constraint", { domain: "health", until: "2026-12-01" }, [
          cite("constraint", { what: text("no travel"), domain: "health" }),
        ]),
      ),
    ).toBe("Constraint: no travel, until 2026-12-01");
    expect(
      lineOf(
        belief("situation", { domain: "home", momentary: false }, [
          cite("situation", { what: text("moving flats"), domain: "home" }),
        ]),
      ),
    ).toBe("Situation: moving flats");
  });

  it("renders a legacy claim's whole what, and a held cite's phrase as held", () => {
    expect(lineOf(belief("goal", {}, [cite("goal", { what: text("Ship the beta by June.") })]))).toBe(
      "Goal: Ship the beta by June.",
    );
    expect(
      lineOf(
        belief("preference", { polarity: "prefers" }, [
          cite("preference", { what: text("I prefer mornings."), polarity: "prefers" }),
        ]),
      ),
    ).toBe("Prefers: I prefer mornings.");
    expect(lineOf(belief("goal", { by: "2026-11-01" }, [held("goal")]))).toBe(`Goal: ${HELD_PHRASE}, by 2026-11-01`);
  });

  it("renders a capture item's cite's phrase, and a held cite's as held", () => {
    const captured = cite("need", { what: text("a quieter flat") }, "2026-09-01T10:00:00Z", {
      message: null,
      capture: "cap_00000000000000000000000005",
      segment: { from: 0, to: 14 },
    });
    expect(lineOf(belief("need", {}, [captured]))).toBe("Need: a quieter flat");
    expect(lineOf(belief("need", {}, [held("need")]))).toBe(`Need: ${HELD_PHRASE}`);
  });

  it("renders a role, an affiliation and a relationship from typed values and the cite's title", () => {
    const role = belief("role", { organization: acme }, [
      cite("role", { title: text("Head of Finance"), organization: acme }, "2026-09-01T10:00:00Z"),
      cite("role", { title: text("Finance lead") }, "2026-03-04T10:00:00Z"),
    ]);
    expect(lineOf(role)).toBe("Head of Finance at Example Co, since 2026-03-04");
    const named = belief("role", {}, [
      cite("role", { title: text("Analyst"), organization_name: text("Example Labs") }),
    ]);
    expect(lineOf(named)).toBe("Analyst at Example Labs, since 2026-09-01");
    expect(lineOf(belief("role", {}, [held("role")]))).toBe(`Role ${HELD_PHRASE}, since 2026-08-01`);
    expect(
      lineOf(
        belief("affiliation", { relation: "employee", organization: acme }, [
          cite("affiliation", { relation: "employee", organization: acme }),
        ]),
      ),
    ).toBe("Employee at Example Co, since 2026-09-01");
    expect(
      lineOf(
        belief("relationship", { counterparty: ada, relation: "friend" }, [
          cite("relationship", { counterparty: ada, relation: "friend" }),
        ]),
      ),
    ).toBe("Friend: Ada Example");
  });

  it("renders the other kinds, every word code's but the phrase and the names", () => {
    expect(
      lineOf(
        belief("commitment", { counterparty: ada, due: "2026-10-20" }, [
          cite("commitment", { counterparty: ada, what: text("send the deck"), due: "2026-10-20" }),
        ]),
      ),
    ).toBe("Commitment: send the deck, with Ada Example, due 2026-10-20");
    expect(
      lineOf(
        belief("consent", { about: "share_details" }, [
          cite("consent", { about: "share_details", what: text("may share my number") }),
        ]),
      ),
    ).toBe("Consent, share details: may share my number");
    expect(
      lineOf(
        belief("contact_rule", { rule: "do_not_contact", channel: "phone" }, [
          cite("contact_rule", { rule: "do_not_contact", channel: "phone", what: text("no calls") }),
        ]),
      ),
    ).toBe("Contact rule, do not contact by phone: no calls");
    expect(lineOf(belief("project_status", { status: "paused" }, [cite("project.status", { status: "paused" })]))).toBe(
      "Status: paused",
    );
    expect(lineOf(belief("decision", {}, [cite("project.decision", { what: text("use the new vendor") })]))).toBe(
      "Decision: use the new vendor",
    );
  });

  it("carries the belief's id, kind, domain, tier, status, span, deadline, cite count and channel", () => {
    const one = belief("goal", { domain: "career", by: "2026-11-01" }, [
      cite("goal", { what: text("raise seed round"), domain: "career" }, "2026-09-01T10:00:00Z", {
        channel: "claude-code",
      }),
      held("goal", "2026-07-01T10:00:00Z"),
    ]);
    expect(renderLine(one, one.cites[0] as Cite)).toEqual({
      fact: fp("a"),
      kind: "goal",
      domain: "career",
      line: { untrusted: "Goal: raise seed round, by 2026-11-01" },
      tier: "owner",
      status: "active",
      since: "2026-07-01T10:00:00Z",
      at: "2026-09-01T10:00:00Z",
      by: "2026-11-01",
      cites: 2,
      channel: "claude-code",
    });
    const legacy = belief("situation", { until: "2026-10-30" }, [cite("situation", { what: text("travelling") })], {
      tier: undefined,
    });
    expect(renderLine(legacy, legacy.cites[0] as Cite)).toMatchObject({
      domain: null,
      tier: null,
      until: "2026-10-30",
      cites: 1,
    });
    expect(renderLine(legacy, legacy.cites[0] as Cite)).not.toHaveProperty("channel");
  });
});

describe("sectionOf", () => {
  it("is a belief's own domain, else the pinned map for role, affiliation and relationship, else unsorted", () => {
    expect(sectionOf(belief("goal", { domain: "health" }, [held("goal")]))).toBe("health");
    expect(sectionOf(belief("goal", {}, [held("goal")]))).toBe("unsorted");
    expect(sectionOf(belief("role", { organization: acme }, [held("role")]))).toBe("career");
    for (const relation of ["employee", "contractor", "advisor", "board"] as const)
      expect(AFFILIATION_SECTIONS[relation]).toBe("career");
    for (const relation of ["founder", "owner", "investor"] as const)
      expect(AFFILIATION_SECTIONS[relation]).toBe("ventures");
    for (const relation of ["student", "alumnus"] as const) expect(AFFILIATION_SECTIONS[relation]).toBe("education");
    expect(sectionOf(belief("affiliation", { relation: "founder" }, [held("affiliation")]))).toBe("ventures");
    expect(sectionOf(belief("affiliation", { relation: "volunteer" }, [held("affiliation")]))).toBe("unsorted");
    expect(sectionOf(belief("relationship", { counterparty: ada, relation: "sibling" }, [held("relationship")]))).toBe(
      "family",
    );
    expect(sectionOf(belief("relationship", { counterparty: ada, relation: "partner" }, [held("relationship")]))).toBe(
      "relationships",
    );
    expect(sectionOf(belief("commitment", { counterparty: ada }, [held("commitment")]))).toBe("unsorted");
  });
});

const line = (fact: string, over: Partial<BeliefLine> = {}): BeliefLine => ({
  fact: fp(fact),
  kind: "goal",
  domain: "career",
  line: text(`Goal ${fact}`),
  tier: "source",
  status: "active",
  since: "2026-01-01T00:00:00Z",
  at: "2026-09-01T00:00:00Z",
  cites: 1,
  ...over,
});

describe("rankLines", () => {
  it("orders by tier, then the newest cite, then tie strength, then fact", () => {
    const lines = [
      line("1", { tier: null }),
      line("2", { tier: "source", at: "2026-09-02T00:00:00Z" }),
      line("3", { tier: "source" }),
      line("4", { tier: "source" }),
      line("5", { tier: "owner_confirmed" }),
      line("6", { tier: "owner", at: "2026-01-01T00:00:00Z" }),
    ];
    expect(rankLines(lines).map((one) => one.fact)).toEqual(["6", "5", "2", "3", "4", "1"].map(fp));
    expect(rankLines(lines, new Map([[fp("4"), 0.5]])).map((one) => one.fact)).toEqual(
      ["6", "5", "2", "4", "3", "1"].map(fp),
    );
    // The order does not depend on the order given.
    expect(rankLines([...lines].reverse())).toEqual(rankLines(lines));
  });
});

describe("collapseByGroup", () => {
  it("keeps, of each group, the first of the highest tier, and every item in no group", () => {
    const items = [
      { id: 1, group: fp("g"), tier: "source" as const },
      { id: 2 },
      { id: 3, group: fp("g"), tier: "owner" as const },
      { id: 4, group: fp("g"), tier: "owner" as const },
      { id: 5, group: fp("h"), tier: null },
    ];
    expect(collapseByGroup(items).map((one) => one.id)).toEqual([2, 3, 5]);
  });
});

describe("buildSections", () => {
  const person = (n: number, claims: number): SectionPerson =>
    SectionPerson.parse({
      who: { id: `ent_0000000000000000000000000${n}`, kind: "person", name: null, address: null },
      claims,
    });
  const at = (day: number): string => `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`;

  it("one section per domain with a line, newest first, unsorted last, each cut to ten lines and five people", () => {
    const career = Array.from(
      { length: 12 },
      (_, n): SectionedLine => ({ section: "career", line: line(n.toString(16), { at: at(1 + n) }) }),
    );
    const lines: SectionedLine[] = [
      { section: "unsorted", line: line("u", { at: at(28) }) },
      { section: "health", line: line("h", { at: at(20) }) },
      ...career,
    ];
    const people = new Map([["career" as const, [1, 2, 3, 4, 5, 6].map((n) => person(n, n))]]);
    const sections = buildSections({ lines, people });
    expect(sections.map((one) => one.domain)).toEqual(["health", "career", "unsorted"]);
    const [health, kept] = sections;
    expect(health).toMatchObject({ lines: [line("h", { at: at(20) })], people: [], activeAt: at(20), more: false });
    expect(kept?.lines.map((one) => one.fact)).toEqual(career.slice(0, 10).map((one) => one.line.fact));
    expect(kept?.people.map((one) => one.claims)).toEqual([6, 5, 4, 3, 2]);
    expect(kept?.activeAt).toBe(at(12));
    expect(kept?.more).toBe(true);
  });

  it("a system's notice does not make a section active, and a section of notices alone goes last", () => {
    const notice = (fact: string, day: number): SectionedLine => ({
      section: "money",
      line: line(fact, { at: at(day), tier: "system_notice" }),
    });
    const sections = buildSections({
      lines: [
        notice("statement", 29),
        { section: "money", line: line("m", { at: at(3) }) },
        { section: "career", line: line("c", { at: at(10) }) },
        { section: "health", line: line("n", { at: at(28), tier: "system_notice" }) },
      ],
      people: new Map(),
    });
    expect(sections.map((one) => [one.domain, one.activeAt])).toEqual([
      ["career", at(10)],
      ["money", at(3)],
      ["health", at(28)],
    ]);
  });

  it("with a domain, that section alone, ten lines of each kind", () => {
    const goals = Array.from(
      { length: 11 },
      (_, n): SectionedLine => ({
        section: "career",
        line: line(`${`${n}`.padStart(2, "0").slice(-1)}g`, { kind: "goal", fact: fp(n.toString(16)) }),
      }),
    );
    const role: SectionedLine = { section: "career", line: line("r", { kind: "role" }) };
    const sections = buildSections({
      lines: [...goals, role, { section: "health", line: line("h") }],
      people: new Map(),
      domain: "career",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.lines.filter((one) => one.kind === "goal")).toHaveLength(10);
    expect(sections[0]?.lines.filter((one) => one.kind === "role")).toHaveLength(1);
    expect(sections[0]?.more).toBe(true);
    expect(buildSections({ lines: [role], people: new Map(), domain: "faith" })).toEqual([]);
  });
});

describe("DOMAIN_KEYWORDS", () => {
  it("maps words in R4's normal form, each to one domain, for every domain", () => {
    expect(Object.keys(DOMAIN_KEYWORDS)).toEqual([...LIFE_DOMAINS]);
    expect(Object.isFrozen(DOMAIN_KEYWORDS)).toBe(true);
    const seen = new Map<string, string>();
    for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
      expect(words.length, domain).toBeGreaterThan(0);
      for (const word of words) {
        expect(keyWords(word), word).toEqual([word]);
        expect(seen.get(word), word).toBeUndefined();
        seen.set(word, domain);
      }
    }
  });
});

describe("proposalLine", () => {
  it("renders each owner-side kind's line with its domain after the kind's word", () => {
    expect(proposalLine("preference", { domain: "travel", object: "delta flash sales", polarity: "prefers" })).toBe(
      "Prefers (travel): delta flash sales",
    );
    expect(proposalLine("goal", { domain: "health", objective: "run a half marathon", by: "2027-05-01" })).toBe(
      "Goal (health): run a half marathon, by 2027-05-01",
    );
    expect(proposalLine("situation", { domain: "home", state: "moving in the spring", momentary: false })).toBe(
      "Situation (home): moving in the spring",
    );
    expect(proposalLine("constraint", { domain: "money", rule: "no flights over 500" })).toBe(
      "Constraint (money): no flights over 500",
    );
    expect(proposalLine("need", { domain: "interests", object: "a sailing coach" })).toBe(
      "Need (interests): a sailing coach",
    );
    expect(proposalLine("capability", { domain: "career", object: "speaks Portuguese" })).toBe(
      "Capability (career): speaks Portuguese",
    );
  });

  it("a legacy body's `what` is the phrase, and no domain gives the line without one", () => {
    expect(proposalLine("preference", { what: "window seats", polarity: "likes" })).toBe("Likes: window seats");
    expect(proposalLine("goal", { what: "ship the survey" })).toBe("Goal: ship the survey");
  });

  it("a fact with no phrase shows the held phrase, never an agent's other words", () => {
    expect(proposalLine("goal", { domain: "health" })).toBe(`Goal (health): ${HELD_PHRASE}`);
  });
});

// The mark is never words in the untrusted text.
describe("a system notice's line", () => {
  const sent = "2026-10-11T14:00:00.000Z";
  const noticeCite = cite("situation", { what: text("passport application is In Process"), domain: "travel" }, sent, {
    statedBy: null,
    basis: "third_party",
    thirdParty: false,
    tier: "system_notice",
  });
  const noticed = belief("situation", { domain: "travel" }, [noticeCite], {
    tier: "system_notice",
    provenance: "source",
  });

  it("says it is a system notice, carries the notice's sent time and nothing more, and parses", () => {
    const line = BeliefLine.parse(renderLine(noticed, noticed.cites[0] as Cite));
    expect(line.line.untrusted).toBe("Situation: passport application is In Process");
    expect(line.tier).toBe("system_notice");
    expect(line.notice).toEqual({ from: null, subject: null, sentAt: sent });
    expect(line.domain).toBe("travel");
    expect(sectionOf(noticed)).toBe("travel");
  });

  // Every cite of a notice belief is a notice's (eval-transactions.test.ts, "only a notice's
  // situation builds a notice belief"), so the line's notice is the cite it renders from.
  it("takes the notice's sent time from the cite it renders from", () => {
    const later = cite(
      "situation",
      { what: text("supporting documents were mailed"), domain: "travel" },
      "2026-10-18T14:00:00.000Z",
      { statedBy: null, basis: "third_party", thirdParty: false, tier: "system_notice" },
    );
    const both = belief("situation", { domain: "travel" }, [later, noticeCite], {
      tier: "system_notice",
      provenance: "source",
    });
    expect(renderLine(both, both.cites[0] as Cite).notice).toEqual({
      from: null,
      subject: null,
      sentAt: "2026-10-18T14:00:00.000Z",
    });
  });

  // The invariant is enforced in code. The notice is the first cite whose claim is a notice's; a
  // belief of the tier with none is no notice line.
  it("takes the notice from the first notice cite, never a person's; with none, no notice and no notice tier", () => {
    const person = cite(
      "situation",
      { what: text("passport application is In Process"), domain: "travel" },
      "2026-10-19T09:00:00.000Z",
      { tier: "source" },
    );
    const mixed = belief("situation", { domain: "travel" }, [person, noticeCite], {
      tier: "system_notice",
      provenance: "source",
    });
    const line = BeliefLine.parse(renderLine(mixed, mixed.cites[0] as Cite));
    expect(line.tier).toBe("system_notice");
    expect(line.notice).toEqual({ from: null, subject: null, sentAt: sent });
    const none = belief("situation", { domain: "travel" }, [person], { tier: "system_notice", provenance: "source" });
    const bare = BeliefLine.parse(renderLine(none, none.cites[0] as Cite));
    expect(bare.notice).toBeUndefined();
    expect(bare.tier).toBe("source");
  });

  it("a line of any other tier has no notice, and the contract refuses a notice on one, or a notice line without one", () => {
    const own = belief("situation", { domain: "travel" }, [
      cite("situation", { what: text("planning a trip to Lisbon"), domain: "travel" }),
    ]);
    const line = renderLine(own, own.cites[0] as Cite);
    expect(line.notice).toBeUndefined();
    expect(BeliefLine.safeParse({ ...line, notice: { from: null, subject: null, sentAt: sent } }).success).toBe(false);
    const { notice: _notice, ...bare } = renderLine(noticed, noticed.cites[0] as Cite);
    expect(BeliefLine.safeParse(bare).success).toBe(false);
  });

  it("ranks below every other line, whatever its tier and however new", () => {
    const at = "2026-10-20T00:00:00Z";
    const of = (tier: string, fact: string) =>
      belief(
        "situation",
        { domain: "travel" },
        [cite("situation", { what: text(fact), domain: "travel" }, at, tier === "system_notice" ? { tier } : {})],
        { tier, fact: fp(fact.charAt(0)) },
      );
    const lineAt = (tier: string, fact: string, when = at) => ({
      ...renderLine(of(tier, fact), of(tier, fact).cites[0] as Cite),
      at: when,
    });
    // The notice is the newest, and still ranks after the owner's own lines.
    const ranked = rankLines([
      lineAt("system_notice", "c", "2026-10-21T00:00:00Z"),
      lineAt("source", "d"),
      lineAt("owner", "e"),
      lineAt("owner_confirmed", "f"),
      lineAt("observed", "0"),
    ]);
    expect(ranked.map((one) => one.tier)).toEqual(["owner", "owner_confirmed", "observed", "source", "system_notice"]);
  });
});
