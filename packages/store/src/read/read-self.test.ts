import {
  CompiledBelief,
  LIFE_DOMAINS,
  NOTICE_LAPSE_DAYS,
  SELF_HOUSEKEEPING_LINES,
  SELF_SECTION_LINES,
  SELF_SECTION_PEOPLE,
  type SectionDomain,
  type SectionPerson,
  SelfSection,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  capText,
  countPeople,
  knownPeople,
  markedLine,
  type Named,
  SELF_DOMAIN_LINES,
  SELF_LINE_CODE_POINTS,
  SELF_PAGE_CODE_POINTS,
  sectionsOf,
  TEXT_CUT,
  withStaleLeftOff,
} from "./read-self.ts";

// Synthetic values only.

const fp = (n: number): string => n.toString(16).padStart(64, "0");
const owner = { id: "ent_00000000000000000000000001", kind: "owner", name: null, address: null } as const;
const org = {
  id: "ent_00000000000000000000000003",
  kind: "organization",
  name: { untrusted: "Example Co" },
  address: { untrusted: "example.com" },
} as const;
const at = (day: number): string => new Date(Date.UTC(2026, 8, day, 10)).toISOString();

let serial = 0;
const cite = (type: string, fields: Record<string, unknown>, when: string) => ({
  id: fp(10_000 + (serial += 1)),
  subject: owner,
  statedBy: owner,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at: when,
  message: `msg_${String(serial).padStart(26, "0")}`,
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
});

// A compiled belief of the owner, checked against the contract. `what` is its cite's phrase.
function belief(
  n: number,
  kind: string,
  values: Record<string, unknown>,
  what: string,
  when: string,
  over: Record<string, unknown> = {},
): CompiledBelief {
  const fields =
    kind === "role"
      ? { title: { untrusted: what } }
      : kind === "affiliation"
        ? { relation: values.relation, organization_name: { untrusted: what } }
        : { what: { untrusted: what }, ...(kind === "preference" ? { polarity: values.polarity } : {}) };
  return CompiledBelief.parse({
    fact: fp(n),
    state: fp(1_000 + n),
    kind,
    type: kind,
    status: "active",
    disputed: false,
    provenance: "source",
    tier: "owner",
    confirmedAt: when,
    reviewAfter: null,
    subject: owner,
    values,
    // A system notice's belief has a notice's cite, as a run builds one.
    cites: [{ ...cite(kind, fields, when), ...(over.tier === "system_notice" ? { tier: "system_notice" } : {}) }],
    ...over,
  });
}
const person = (n: number, claims: number): SectionPerson => ({
  who: {
    id: `ent_${String(100 + n).padStart(26, "0")}` as never,
    kind: "person",
    name: { untrusted: `Person ${n}` },
    address: null,
  },
  claims,
});
const none = new Map();
const NOW = new Date(Date.UTC(2026, 9, 1));

describe("the self page's sections", () => {
  const role = belief(1, "role", { organization: org }, "Engineer", at(2));
  const employed = belief(2, "affiliation", { relation: "employee", organization: org }, "employed", at(3));
  const founder = belief(3, "affiliation", { relation: "founder" }, "founded", at(4));
  const marathon = belief(4, "goal", { by: "2027-04-01", domain: "health" }, "run a marathon", at(20));
  const loose = belief(5, "preference", { polarity: "prefers" }, "short calls", at(25));
  const offer = belief(6, "goal", { by: "2026-12-01", domain: "career" }, "land an offer", at(10));

  it("puts each belief in its section, newest section first, unsorted last, a role and an employee affiliation in career", () => {
    const { sections } = sectionsOf({
      beliefs: [role, employed, founder, marathon, loose, offer],
      people: none,
      more: false,
      now: NOW,
    });
    for (const section of sections) SelfSection.parse(section);
    expect(sections.map((one) => one.domain)).toEqual(["health", "career", "ventures", "unsorted"]);
    const career = sections.find((one) => one.domain === "career") as SelfSection;
    expect(career.lines.map((line) => line.line.untrusted)).toEqual([
      "Goal: land an offer, by 2026-12-01",
      "Employee at Example Co, since 2026-09-03",
      "Engineer at Example Co, since 2026-09-02",
    ]);
    expect(career.activeAt).toBe(at(10));
    expect(sections.every((one) => !one.more)).toBe(true);
  });

  it("cuts a section at ten lines without domain, and to ten of each kind with it", () => {
    const prefs = Array.from({ length: 12 }, (_, n) =>
      belief(100 + n, "preference", { polarity: "prefers", domain: "career" }, `option number ${n}`, at(1 + n)),
    );
    const all = [...prefs, offer, role, marathon];
    const page = sectionsOf({ beliefs: all, people: none, more: false, now: NOW }).sections;
    const career = page.find((one) => one.domain === "career") as SelfSection;
    expect(career.lines).toHaveLength(SELF_SECTION_LINES);
    expect(career.more).toBe(true);
    const whole = sectionsOf({ beliefs: all, people: none, domain: "career", more: false, now: NOW }).sections;
    expect(whole.map((one) => one.domain)).toEqual(["career"]);
    const lines = (whole[0] as SelfSection).lines;
    expect(lines.filter((line) => line.kind === "preference")).toHaveLength(SELF_SECTION_LINES);
    expect(lines.map((line) => line.kind)).toEqual(expect.arrayContaining(["goal", "role"]));
    expect((whole[0] as SelfSection).more).toBe(true);
  });

  it("fills every section to its limit where lines exist, and says more only of those it cut", () => {
    // Thirteen sections, the page's most, of ten plain lines and two past the limit: three a section
    // was what a budget of lines left.
    const all = [...LIFE_DOMAINS, undefined].flatMap((domain, d) =>
      Array.from({ length: SELF_SECTION_LINES + 2 }, (_, n) =>
        belief(200 + d * 20 + n, "goal", domain === undefined ? {} : { domain }, `finish part ${n} of ${d}`, at(1 + n)),
      ),
    );
    const { sections } = sectionsOf({ beliefs: all, people: none, more: false, now: NOW });
    expect(sections).toHaveLength(LIFE_DOMAINS.length + 1);
    for (const section of sections) {
      expect(section.lines).toHaveLength(SELF_SECTION_LINES);
      expect(section.more).toBe(true);
      expect(section.lines.map((line) => line.at)).toEqual([...section.lines.map((line) => line.at)].sort().reverse());
    }
    const small = sectionsOf({ beliefs: all.slice(0, 4), people: none, more: false, now: NOW }).sections;
    expect(small[0]?.lines).toHaveLength(4);
    expect(small[0]?.more).toBe(false);
  });

  it("deals the page's code points one round at a time when long lines use them up, each section's best first", () => {
    const long = "x".repeat(5 * SELF_LINE_CODE_POINTS);
    const all = [...LIFE_DOMAINS, undefined].flatMap((domain, d) =>
      Array.from({ length: SELF_SECTION_LINES }, (_, n) =>
        belief(200 + d * 20 + n, "goal", domain === undefined ? {} : { domain }, `${long} ${n}`, at(1 + n), {
          fact: fp(200 + d * 20 + n),
        }),
      ),
    );
    const { sections } = sectionsOf({ beliefs: all, people: none, more: false, now: NOW });
    const counts = sections.map((section) => section.lines.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(
      sections.flatMap((section) => section.lines).reduce((sum, line) => sum + JSON.stringify(line).length + 1, 0),
    ).toBeLessThanOrEqual(SELF_PAGE_CODE_POINTS);
    expect(sections.every((section) => section.more)).toBe(true);
  });

  it("orders lines by tier, then the newest cite", () => {
    const sourced = belief(7, "goal", { domain: "career" }, "write a book", at(28), { tier: "source" });
    const { sections } = sectionsOf({ beliefs: [sourced, role, offer], people: none, more: false, now: NOW });
    expect(sections[0]?.lines.map((line) => line.fact)).toEqual([offer.fact, role.fact, sourced.fact]);
  });

  it("collapses a joined fact's two beliefs to the one of the higher tier", () => {
    const group = fp(9_999);
    const mine = belief(8, "goal", { domain: "career" }, "ship it", at(5), { group, tier: "owner" });
    const theirs = belief(9, "goal", { domain: "career" }, "ship it soon", at(6), { group, tier: "source" });
    const { sections } = sectionsOf({ beliefs: [theirs, mine], people: none, more: false, now: NOW });
    expect(sections[0]?.lines.map((line) => line.fact)).toEqual([mine.fact]);
  });

  it("gives a section its people, at most five, and marks every section when the compiled read was cut", () => {
    const people = new Map([
      ["career", Array.from({ length: SELF_SECTION_PEOPLE + 1 }, (_, n) => person(n, 10 - n))],
    ] as const);
    const { sections } = sectionsOf({ beliefs: [offer, marathon], people, more: true, now: NOW });
    const career = sections.find((one) => one.domain === "career") as SelfSection;
    expect(career.people.map((one) => one.claims)).toEqual([10, 9, 8, 7, 6]);
    expect(sections.every((one) => one.more)).toBe(true);
  });

  it("keeps each served line's belief, every cite of it", () => {
    const { beliefOf } = sectionsOf({ beliefs: [offer], people: none, more: false, now: NOW });
    expect(beliefOf.get(offer.fact)).toEqual(offer);
  });

  it("cuts a long line's text to SELF_LINE_CODE_POINTS, ending it with TEXT_CUT, and leaves a short one whole", () => {
    const long = belief(10, "goal", { domain: "career" }, "x".repeat(5 * SELF_LINE_CODE_POINTS), at(12));
    const [line] = sectionsOf({ beliefs: [long], people: none, more: false, now: NOW }).sections[0]?.lines ?? [];
    expect([...(line?.line.untrusted ?? "")]).toHaveLength(SELF_LINE_CODE_POINTS);
    expect(line?.line.untrusted.startsWith("Goal: xxx")).toBe(true);
    expect(line?.line.untrusted.endsWith(TEXT_CUT)).toBe(true);
    expect(capText("short")).toBe("short");
    // Code points, not UTF-16 units: an astral character is never split.
    expect(capText("\u{1F600}".repeat(3), 2)).toBe(`\u{1F600}${TEXT_CUT}`);
  });

  // A notice line's words are cut as any line's, with no mark in them:
  // its mark is its tier and `notice`, code's fields beside the words.
  it("cuts a long system notice's line as any other, and keeps its tier and notice", () => {
    const sent = NOW.toISOString();
    const long = belief(11, "situation", { domain: "travel" }, "x".repeat(5 * SELF_LINE_CODE_POINTS), sent, {
      tier: "system_notice",
    });
    const [line] = sectionsOf({ beliefs: [long], people: none, more: false, now: NOW }).housekeeping?.lines ?? [];
    expect([...(line?.line.untrusted ?? "")]).toHaveLength(SELF_LINE_CODE_POINTS);
    expect(line?.line.untrusted.endsWith(TEXT_CUT)).toBe(true);
    expect(line?.tier).toBe("system_notice");
    expect(line?.notice).toBeDefined();
    const short = belief(12, "situation", { domain: "travel" }, "passport application is In Process", sent, {
      tier: "system_notice",
    });
    expect(
      sectionsOf({ beliefs: [short], people: none, more: false, now: NOW }).housekeeping?.lines[0]?.line.untrusted,
    ).toBe("Situation: passport application is In Process");
  });

  describe("automated notices", () => {
    const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const notice = (n: number, words: string, when: string, domain = "money") =>
      belief(n, "situation", { domain }, words, when, { tier: "system_notice" });
    const question = belief(20, "situation", { domain: "money" }, "deciding how to fund the next year", daysAgo(90));

    it("no notice sits in a life domain's section, however new, and the owner's line still leads it", () => {
      const { sections, housekeeping } = sectionsOf({
        beliefs: [notice(21, "your statement is ready", daysAgo(0)), question],
        people: none,
        more: false,
        now: NOW,
      });
      expect(sections.map((section) => section.domain)).toEqual(["money"]);
      expect(sections[0]?.lines.map((line) => line.fact)).toEqual([question.fact]);
      expect(housekeeping?.lines.map((line) => line.line.untrusted)).toEqual(["Situation: your statement is ready"]);
      expect(housekeeping?.more).toBe(false);
    });

    it("a notice whose every cite is held stays out of the sections, and is in neither part", () => {
      const held = CompiledBelief.parse({
        ...notice(21, "your statement is ready", daysAgo(0)),
        cites: [{ held: true, fact: fp(90), type: "situation", at: daysAgo(0) }],
      });
      const { sections, housekeeping } = sectionsOf({ beliefs: [held], people: none, more: false, now: NOW });
      expect(sections).toEqual([]);
      expect(housekeeping).toBeUndefined();
    });

    it("says more when the compiled read was cut", () => {
      const page = sectionsOf({
        beliefs: [notice(21, "your statement is ready", daysAgo(0))],
        people: none,
        more: true,
        now: NOW,
      });
      expect(page.housekeeping?.more).toBe(true);
    });

    it("a section of notices alone is no section", () => {
      const { sections, housekeeping } = sectionsOf({
        beliefs: [notice(21, "your package has shipped", daysAgo(1), "home")],
        people: none,
        more: false,
        now: NOW,
      });
      expect(sections).toEqual([]);
      expect(housekeeping?.lines).toHaveLength(1);
    });

    it(`lapses after ${NOTICE_LAPSE_DAYS} days, and history still reaches it`, () => {
      const old = notice(21, "sign-in from a new device", daysAgo(NOTICE_LAPSE_DAYS + 1));
      const kept = notice(22, "pull request was merged today", daysAgo(NOTICE_LAPSE_DAYS - 1));
      const page = sectionsOf({ beliefs: [old, kept], people: none, more: false, now: NOW }).housekeeping;
      expect(page?.lines.map((line) => line.fact)).toEqual([kept.fact]);
      expect(page?.more).toBe(true);
      expect(sectionsOf({ beliefs: [old], people: none, more: false, now: NOW }).housekeeping).toBeUndefined();
      const all = sectionsOf({ beliefs: [old, kept], people: none, more: false, now: NOW, history: true }).housekeeping;
      expect(all?.lines.map((line) => line.fact)).toEqual([kept.fact, old.fact]);
      expect(all?.more).toBe(false);
    });

    it(`serves the newest ${SELF_HOUSEKEEPING_LINES}, and with domain only that domain's`, () => {
      const many = Array.from({ length: SELF_HOUSEKEEPING_LINES + 2 }, (_, n) =>
        notice(30 + n, `statement ${n} is ready now`, daysAgo(n), n % 2 === 0 ? "money" : "home"),
      );
      const page = sectionsOf({ beliefs: many, people: none, more: false, now: NOW }).housekeeping;
      expect(page?.lines.map((line) => line.fact)).toEqual(
        many.slice(0, SELF_HOUSEKEEPING_LINES).map((one) => one.fact),
      );
      expect(page?.more).toBe(true);
      const home = sectionsOf({ beliefs: many, people: none, domain: "home", more: false, now: NOW }).housekeeping;
      expect(home?.lines.every((line) => line.domain === "home")).toBe(true);
    });
  });

  describe("what a caller cannot see", () => {
    const owned = Array.from({ length: 6 }, (_, n) =>
      belief(40 + n, "goal", { domain: "career" }, `reach milestone ${n} of the plan`, at(1 + n)),
    );
    const notices = [
      belief(50, "situation", { domain: "money" }, "statement is ready", NOW.toISOString(), { tier: "system_notice" }),
    ];
    const hidden = belief(60, "goal", { domain: "career" }, "canary hidden goal for one reader", at(20));

    it("leaves the same order, counts and more; the viewer who can see it does (positive control)", () => {
      const without = sectionsOf({ beliefs: [...owned, ...notices], people: none, more: false, now: NOW });
      // The other viewer's rows, with one more line: the first viewer's call never holds it, so its
      // answer is a function of its own rows, and its lines keep their relative order in the other's.
      const within = sectionsOf({ beliefs: [...owned, ...notices, hidden], people: none, more: false, now: NOW });
      expect(JSON.stringify(without.sections)).not.toContain("canary");
      expect(JSON.stringify(within.sections)).toContain("canary");
      expect(within.sections[0]?.lines.filter((line) => line.fact !== hidden.fact)).toEqual(without.sections[0]?.lines);
      expect(within.sections[0]?.lines.length).toBe((without.sections[0]?.lines.length ?? 0) + 1);
      expect(within.housekeeping).toEqual(without.housekeeping);
      expect(without.sections[0]?.more).toBe(false);
    });
  });

  it("serves at most SELF_DOMAIN_LINES lines with domain, the best first, and says more", () => {
    const kinds = ["goal", "need", "capability", "constraint", "situation", "preference"] as const;
    const all = kinds.flatMap((kind, k) =>
      Array.from({ length: SELF_SECTION_LINES }, (_, n) =>
        belief(
          300 + k * 20 + n,
          kind,
          { domain: "career", ...(kind === "preference" ? { polarity: "prefers" } : {}) },
          `item ${k} ${n}`,
          at(1 + n),
        ),
      ),
    );
    const [career] = sectionsOf({ beliefs: all, people: none, domain: "career", more: false, now: NOW }).sections;
    expect(career?.lines).toHaveLength(SELF_DOMAIN_LINES);
    expect(career?.more).toBe(true);
    // What is going on before what the owner is like, each the newest first.
    const lines = career?.lines ?? [];
    const firstTaste = lines.findIndex((line) => line.kind === "preference" || line.kind === "capability");
    expect(lines.slice(firstTaste).every((line) => line.kind === "preference" || line.kind === "capability")).toBe(
      true,
    );
    // On a first read a goal leads what is going on.
    const goals = lines.slice(0, firstTaste).filter((line) => line.kind === "goal");
    expect(lines.slice(0, goals.length)).toEqual(goals);
    const leading = lines.slice(goals.length, firstTaste).map((line) => line.at);
    expect(leading).toEqual([...leading].sort().reverse());
  });
});

describe("the people of a section", () => {
  const sections = new Map<string, ReadonlySet<SectionDomain>>([
    ["c1", new Set(["career"])],
    ["c2", new Set(["career"])],
    ["c3", new Set(["career"])],
    ["h1", new Set(["health"])],
  ]);

  it("counts distinct claims per person by group, leaves out the withheld and claims of no served belief, most claims first", () => {
    const named: Named[] = [
      { claim_id: "c1", entity_id: "ent_b" },
      { claim_id: "c2", entity_id: "ent_b" },
      { claim_id: "c1", entity_id: "ent_a" },
      // ent_c is ent_a's group: one person, and c1 counted once for it.
      { claim_id: "c1", entity_id: "ent_c" },
      { claim_id: "c3", entity_id: "ent_c" },
      { claim_id: "c3", entity_id: "ent_w" },
      { claim_id: "h1", entity_id: "ent_b" },
      { claim_id: "x9", entity_id: "ent_d" },
    ];
    const counted = countPeople(named, sections, new Set(["ent_w"]), (id) => (id === "ent_c" ? "ent_a" : id));
    expect(Object.fromEntries(counted)).toEqual({
      career: [
        { id: "ent_a", claims: 2 },
        { id: "ent_b", claims: 2 },
      ],
      health: [{ id: "ent_b", claims: 1 }],
    });
  });

  it("counts a claim that supports beliefs in two sections in each", () => {
    const both = new Map<string, ReadonlySet<SectionDomain>>([["c1", new Set(["career", "health"])]]);
    const counted = countPeople([{ claim_id: "c1", entity_id: "ent_a" }], both, new Set(), (id) => id);
    expect(Object.fromEntries(counted)).toEqual({
      career: [{ id: "ent_a", claims: 1 }],
      health: [{ id: "ent_a", claims: 1 }],
    });
  });

  const counted = (n: number) =>
    new Map<SectionDomain, { id: string; claims: number }[]>([
      ["career", Array.from({ length: n }, (_, i) => ({ id: `ent_${i}`, claims: 20 - i }))],
    ]);
  const whoOf = (id: string) => ({ id: id as never, kind: "person" as const, name: { untrusted: id }, address: null });

  it("names one more than a section shows, asking once when every one is named, so its more is known", async () => {
    const asked: string[][] = [];
    const people = await knownPeople(counted(9), async (ids) => {
      asked.push(ids);
      return new Map(ids.map((id) => [id, whoOf(id)]));
    });
    expect(people.get("career")?.map((one) => one.who.id)).toEqual([
      "ent_0",
      "ent_1",
      "ent_2",
      "ent_3",
      "ent_4",
      "ent_5",
    ]);
    expect(asked).toEqual([["ent_0", "ent_1", "ent_2", "ent_3", "ent_4", "ent_5"]]);
  });

  it("takes the next person in place of one the token cannot name, so more stays right", async () => {
    // Seven people, the second unnamed: six are named, so the section shows five and says more.
    const people = await knownPeople(
      counted(7),
      async (ids) => new Map(ids.filter((id) => id !== "ent_1").map((id) => [id, whoOf(id)])),
    );
    expect(people.get("career")?.map((one) => one.who.id)).toEqual([
      "ent_0",
      "ent_2",
      "ent_3",
      "ent_4",
      "ent_5",
      "ent_6",
    ]);
    const [section] = sectionsOf({
      beliefs: [belief(40, "goal", { domain: "career" }, "aim", at(3))],
      people,
      more: false,
      now: NOW,
    }).sections;
    expect(section?.people).toHaveLength(SELF_SECTION_PEOPLE);
    expect(section?.more).toBe(true);
    // Six people, one unnamed: five named, so nothing is cut.
    const fewer = await knownPeople(
      counted(6),
      async (ids) => new Map(ids.filter((id) => id !== "ent_1").map((id) => [id, whoOf(id)])),
    );
    const [whole] = sectionsOf({
      beliefs: [belief(41, "goal", { domain: "career" }, "aim", at(3))],
      people: fewer,
      more: false,
      now: NOW,
    }).sections;
    expect([whole?.people.length, whole?.more]).toEqual([SELF_SECTION_PEOPLE, false]);
  });
});

describe("stale lines a section's cut left off", () => {
  const NOW = new Date("2026-11-05T00:00:00.000Z");
  const at = (back: number): string => new Date(NOW.getTime() - back * 86_400_000).toISOString();
  const fresh = Array.from({ length: 10 }, (_, n) =>
    belief(n + 1, "situation", { domain: "ventures" }, `current line ${n}`, at(n + 1)),
  );
  const old = [
    belief(20, "situation", { domain: "ventures" }, "an old line", at(60)),
    belief(21, "situation", { domain: "ventures" }, "another old line", at(70)),
  ];

  it("are counted on a page that shows none of them, and absent when none were", () => {
    const [cut] = sectionsOf({ beliefs: [...fresh, ...old], people: none, more: false, now: NOW }).sections;
    expect(cut?.lines.some((line) => line.stale === true)).toBe(false);
    expect(cut?.staleLeftOff).toBe(2);
    const [whole] = sectionsOf({ beliefs: fresh, people: none, more: false, now: NOW }).sections;
    expect(whole?.staleLeftOff).toBeUndefined();
  });

  it("are listed, marked, in the domain's own read", () => {
    const [section] = sectionsOf({
      beliefs: [...fresh.slice(0, 8), ...old],
      people: none,
      domain: "ventures",
      more: false,
      now: NOW,
    }).sections;
    expect(section?.lines.filter((line) => line.stale === true)).toHaveLength(2);
    expect(section?.staleLeftOff).toBeUndefined();
  });
});

describe("what context and get_self share", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const line = (fact: string, words: string, at: string) =>
    ({
      fact: fact.repeat(64),
      kind: "situation",
      domain: "career",
      line: { untrusted: words },
      tier: "owner",
      status: "active",
      since: at,
      at,
      cites: 1,
    }) as const;

  it("marks a line whose own date is over, and only that", () => {
    const over = markedLine(
      line("a", "Situation: waiting on the offer until 2026-10-01", "2026-09-20T00:00:00.000Z"),
      now,
    );
    expect(over.stale).toBe(true);
    const live = markedLine(line("b", "Situation: lives near the office", "2026-11-01T00:00:00.000Z"), now);
    expect(live).not.toHaveProperty("stale");
  });

  it("counts the stale lines a section's cut left off, and says nothing when none", () => {
    const stale = { ...line("a", "Situation: old", "2026-09-20T00:00:00.000Z"), stale: true as const };
    const kept = line("b", "Situation: new", "2026-11-01T00:00:00.000Z");
    const section = SelfSection.parse({ domain: "career", lines: [kept], people: [], activeAt: kept.at, more: true });
    const lines = [
      { section: "career" as const, line: kept },
      { section: "career" as const, line: stale },
    ];
    expect(withStaleLeftOff([section], lines)[0]?.staleLeftOff).toBe(1);
    expect(withStaleLeftOff([section], [lines[0] as (typeof lines)[0]])[0]).not.toHaveProperty("staleLeftOff");
  });
});
