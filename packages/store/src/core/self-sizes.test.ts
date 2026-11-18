import {
  AGENT_REPORTS_SHOWN,
  CompiledBelief,
  compactResult,
  LIFE_DOMAINS,
  MeetingView,
  NEXT_MOVES_MOST,
  SELF_HOUSEKEEPING_LINES,
  SELF_SECTION_LINES,
  type SectionDomain,
  type SectionPerson,
  SelfView,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { boundHead, boundNotice, SELF_LINE_CODE_POINTS, SELF_PARTICIPANTS, sectionsOf } from "../read/read-self.ts";
import {
  boundWork,
  fitSelfPage,
  PAGE_HOUSEKEEPING_LINES,
  PAGE_SECTION_PEOPLE,
  SELF_WHOLE_PAGE_CODE_POINTS,
} from "../read/read-self-fit.ts";
import { SELF_MEETINGS } from "../read/read-tools-self.ts";

// get_self's size in its wire form, by context-sizes.test.ts's measure (code points of the JSON
// text), on a profile the size of the live one: 102 open beliefs of the owner over six kinds and
// every life domain, the owner's role and two affiliations, 10 closed beliefs, each citing three
// facts with long phrases, 8 meetings, 20 contacts, 10 changes, 5 goals and 5 people a section, with
// `sections` and `goals` in place of `stated`. And a worst case: every phrase, meeting title and
// change a thousand code points long, sixty-six beliefs in one domain, 30 meetings of 200 people.
// The reasoner takes at most 40 000 code points of one result (loop.ts, MAX_RESULT_CODE_POINTS) and
// cuts a larger get_self's lines to fit (fit.ts); an agent is sent it whole, so get_self's own
// bounds (read-self.ts and SELF_MEETINGS) hold even the worst case under SELF_MOST. One domain fits
// the reasoner's cap whole. Every name, address and text is made up.

const ulid = (n: number): string =>
  n
    .toString(32)
    .toUpperCase()
    .replace(/I/g, "J")
    .replace(/L/g, "K")
    .replace(/O/g, "P")
    .replace(/U/g, "V")
    .padStart(26, "0");
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const at = (n: number): string => new Date(Date.UTC(2026, 6, 1) + n * 3_600_000).toISOString();
const size = (value: unknown): number => [...JSON.stringify(value)].length;

const owner = {
  id: `ent_${ulid(1)}`,
  kind: "owner",
  name: { untrusted: "Sam Example" },
  address: { untrusted: "sam@example.com" },
};
const person = (n: number) => ({
  id: `ent_${ulid(500 + n)}`,
  kind: "person",
  name: { untrusted: `Person ${n}` },
  address: { untrusted: `person${n}@example.org` },
});
const organization = {
  id: `ent_${ulid(400)}`,
  kind: "organization",
  name: { untrusted: "Example Labs" },
  address: { untrusted: "example.org" },
};
const words = (n: number): string =>
  `Wants to keep Fridays clear for writing and to spend more time on hardware research, note ${n}; prefers short calls before noon.`;

let serial = 10;
const fact = (type: string, agent: boolean, fields: Record<string, unknown>, status: string) => {
  serial += 1;
  return {
    id: hex(serial),
    subject: owner,
    statedBy: agent ? null : owner,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: at(serial),
    message: agent ? null : `msg_${ulid(serial)}`,
    ...(agent ? { record: `rec_${ulid(serial)}` } : {}),
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: agent,
    provenance: agent ? "agent_reported" : "source",
    tier: agent ? "owner_confirmed" : "owner",
    status,
    type,
    fields,
  };
};
// The worst case's phrases: a thousand code points each.
let long = false;
const said = (n: number): string => (long ? words(n).repeat(10).slice(0, 1_000) : words(n));
const fieldsOf = (kind: string, n: number, values: Record<string, unknown>): Record<string, unknown> => {
  if (kind === "role") return { title: { untrusted: long ? said(n) : `Research engineer ${n}` }, organization };
  if (kind === "affiliation") return { relation: values.relation, organization };
  return {
    what: { untrusted: said(n) },
    ...(kind === "preference" ? { polarity: "prefers" } : {}),
    ...(values.domain === undefined ? {} : { domain: values.domain }),
  };
};
const belief = (kind: string, n: number, agent: boolean, values: Record<string, unknown>, status = "active") =>
  CompiledBelief.parse({
    fact: hex(100_000 + n),
    state: hex(200_000 + n),
    kind,
    type: kind,
    status,
    disputed: false,
    provenance: agent ? "owner" : "source",
    tier: agent ? "owner_confirmed" : "owner",
    confirmedAt: at(n),
    reviewAfter: null,
    subject: owner,
    values,
    cites: [0, 1, 2].map(() => fact(kind, agent, fieldsOf(kind, n, values), status)),
  });

// Six kinds over every life domain, a deadline on each goal and need.
const KINDS: [string, number][] = [
  ["goal", 15],
  ["preference", 40],
  ["need", 10],
  ["capability", 12],
  ["constraint", 15],
  ["situation", 10],
];
let place = 0;
const valuesOf = (kind: string): Record<string, unknown> => {
  const domain = LIFE_DOMAINS[(place += 1) % LIFE_DOMAINS.length];
  return {
    domain,
    ...(kind === "preference" ? { polarity: "prefers" } : {}),
    ...(kind === "goal" || kind === "need" ? { by: "2027-03-01" } : {}),
    ...(kind === "constraint" || kind === "situation" ? { until: "2026-12-31" } : {}),
  };
};
const open = [
  ...KINDS.flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, n) => belief(kind, serial + n, n % 2 === 0, valuesOf(kind))),
  ),
  belief("role", 800, false, { organization }),
  belief("affiliation", 801, false, { relation: "employee", organization }),
  belief("affiliation", 802, true, { relation: "founder", organization }),
];
const closed = Array.from({ length: 10 }, (_, n) =>
  belief("preference", 900 + n, false, { polarity: "prefers", domain: "career" }, "closed"),
);
const meeting = (n: number) => ({
  id: `evt_${ulid(900 + n)}`,
  title: { untrusted: `Planning call ${n}` },
  startsAt: at(n),
  endsAt: at(n + 1),
  allDay: false,
  cancelled: false,
  participants: [owner, person(n), person(n + 1)],
});
const head = {
  addresses: [{ untrusted: "sam@example.com" }],
  timeZone: "America/Chicago",
  upcoming: Array.from({ length: 8 }, (_, n) => meeting(n)),
  contacts: Array.from({ length: 20 }, (_, n) => ({
    ...person(n),
    emails30d: 20 - n,
    emails90d: 40 - n,
    meetings90d: n % 3,
  })),
  changes: Array.from({ length: 10 }, (_, n) => ({
    kind: "preference",
    status: "closed",
    at: "2026-09-01",
    what: { untrusted: words(n) },
  })),
};
const goals = Array.from({ length: 5 }, (_, n) => ({
  id: `gol_${ulid(700 + n)}`,
  statement: { untrusted: `Ship the hardware prototype, milestone ${n}, before the spring review.` },
  status: "active",
  setAt: at(n),
}));
const people = new Map<SectionDomain, SectionPerson[]>(
  [...LIFE_DOMAINS, "unsorted" as const].map((domain, d) => [
    domain,
    Array.from({ length: 6 }, (_, n) => ({ who: person(d * 10 + n) as SectionPerson["who"], claims: 12 - n })),
  ]),
);

const wire = (value: unknown): number => size(compactResult("get_self", SelfView.parse(value)));
const NOW = new Date(at(0));
const paged = (beliefs: CompiledBelief[], domain?: "career") =>
  sectionsOf({ beliefs, people, more: false, now: NOW, ...(domain === undefined ? {} : { domain }) });
const page = (beliefs: CompiledBelief[], domain?: "career") => paged(beliefs, domain).sections;
const after = wire({ ...head, sections: page(open), goals });
const history = wire({ ...head, sections: page([...open, ...closed]), goals });
const career = wire({ ...head, sections: page([...open, ...closed], "career"), goals });

// The worst case: every phrase long, seventy open beliefs in career besides the profile's, and the
// head get_self serves from 30 meetings of 200 people with long titles and 10 long changes
// (getSelf: SELF_MEETINGS, boundHead).
long = true;
const worstOpen = [
  ...KINDS.flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, n) => belief(kind, 2_000 + serial + n, n % 2 === 0, valuesOf(kind))),
  ),
  ...KINDS.flatMap(([kind]) =>
    Array.from({ length: 11 }, (_, n) =>
      belief(kind, 3_000 + serial + n, n % 2 === 0, { ...valuesOf(kind), domain: "career" }),
    ),
  ),
  belief("role", 3_800, false, { organization }),
  belief("affiliation", 3_801, false, { relation: "employee", organization }),
];
const worstClosed = Array.from({ length: 10 }, (_, n) =>
  belief("preference", 3_900 + n, false, { polarity: "prefers", domain: "career" }, "closed"),
);
const crowded = (n: number) =>
  MeetingView.parse({
    ...meeting(n),
    title: { untrusted: said(n) },
    participants: [owner, ...Array.from({ length: 200 }, (_, i) => person(100 + i))],
  });
const worstHead = boundHead({
  ...head,
  upcoming: Array.from({ length: 30 }, (_, n) => crowded(n)).slice(0, SELF_MEETINGS),
  changes: Array.from({ length: 10 }, (_, n) => ({
    kind: "preference" as const,
    status: "closed" as const,
    at: "2026-09-01",
    what: { untrusted: said(n) },
  })),
});
const worst = wire({ ...worstHead, sections: page([...worstOpen, ...worstClosed]), goals });
const worstCareer = wire({ ...worstHead, sections: page([...worstOpen, ...worstClosed], "career"), goals });

// The worst case's notices. Every situation of the worst profile is a system notice's, its sender
// address and subject line a thousand code points each, filled as get_self fills them (read-self's
// boundNotice), and in `housekeeping`, apart from the sections. And a page of nothing but such
// notices, with the worst head, over every domain and in one.
const noticed = (one: CompiledBelief): CompiledBelief =>
  one.kind === "situation"
    ? CompiledBelief.parse({
        ...one,
        tier: "system_notice",
        cites: one.cites.map((cite) => ({ ...cite, basis: "third_party", tier: "system_notice", statedBy: null })),
      })
    : one;
const longFrom = { untrusted: `${"n".repeat(990)}@x.example` };
const filled = (kept: ReturnType<typeof paged>) => ({
  sections: kept.sections,
  ...(kept.housekeeping === undefined
    ? {}
    : {
        housekeeping: {
          ...kept.housekeeping,
          lines: kept.housekeeping.lines.map((line) =>
            line.notice === undefined
              ? line
              : { ...line, notice: boundNotice(line.notice, longFrom, { untrusted: said(7) }) },
          ),
        },
      }),
});
const worstNoticed = [...worstOpen, ...worstClosed].map(noticed);
const worstNotices = wire({ ...worstHead, ...filled(paged(worstNoticed)), goals });
const worstNoticesCareer = wire({ ...worstHead, ...filled(paged(worstNoticed, "career")), goals });
const situations = (domain?: "career") =>
  Array.from({ length: 80 }, (_, n) =>
    belief("situation", 5_000 + n, false, {
      domain: domain ?? LIFE_DOMAINS[n % LIFE_DOMAINS.length],
      until: "2026-12-31",
    }),
  );
const onlyNotices = filled(paged(situations().map(noticed)));
const onlyNoticesCareer = filled(paged(situations("career").map(noticed), "career"));

// The largest a page can be: ten lines of the longest in every section, thirteen sections.
const fullPage = [...LIFE_DOMAINS, undefined].flatMap((domain, d) =>
  Array.from({ length: SELF_SECTION_LINES }, (_, n) =>
    belief("goal", 7_000 + d * 20 + n, false, { ...(domain === undefined ? {} : { domain }), by: "2027-03-01" }),
  ),
);
const worstFull = wire({ ...worstHead, ...filled(paged([...fullPage, ...worstNoticed])), goals });
// The sizes of a typical owner's lines (sixty-odd code points of words, a source's phrase and the
// template's), thirteen sections of ten, under the same head and the profile's people.
long = false;
const typical = paged(
  [...LIFE_DOMAINS, undefined].flatMap((domain, d) =>
    Array.from({ length: SELF_SECTION_LINES }, (_, n) =>
      CompiledBelief.parse({
        ...belief("goal", 9_000 + d * 20 + n, false, { ...(domain === undefined ? {} : { domain }) }),
        cites: [
          {
            ...fact(
              "goal",
              false,
              { what: { untrusted: `Finish part ${n} of the plan for area ${d} by spring` } },
              "active",
            ),
          },
        ],
      }),
    ),
  ),
);
long = true;

const RESULT_CODE_POINTS = 40_000;
// A whole page, about 17 000 tokens: its lines' budget, the worst head and its people, and notices.
const SELF_MOST = 70_000;

// The rest of a whole page, the size the box's answer holds: every block a page can hold, with `next` at its most.
const who = (n: number) => person(n) as unknown as SectionPerson["who"];
const report = (n: number) => ({
  said: { untrusted: words(n).repeat(3).slice(0, 240) },
  record: `rec_${ulid(4_000 + n)}`,
  client: "scout",
  at: at(n),
  unconfirmed: true,
});
const worstNext = {
  moves: Array.from({ length: NEXT_MOVES_MOST }, (_, n) => ({
    kind: "reply",
    what: { untrusted: said(n).slice(0, SELF_LINE_CODE_POINTS) },
    why: "x".repeat(160),
    at: at(n),
    source: { kind: "message", id: `msg_${ulid(6_000 + n)}` },
    who: who(n),
    reported: Array.from({ length: AGENT_REPORTS_SHOWN }, (_, r) => report(r)),
    asks: true,
  })),
  more: true,
};
const hostAt = (n: number) => ({
  where: { kind: "host", value: { untrusted: `site-${n}.example.org` }, strength: "strong" },
});
const coverage = {
  through: at(0),
  observedMinutes: 400,
  creditedMinutes: 0,
  unattributedMinutes: 400,
  weakMinutes: 0,
  dayCutBlocks: 0,
  dayCutMinutes: 0,
  pendingMinutes: 0,
  partial: false,
};
const session = (n: number) => ({
  target: hostAt(n),
  start: at(n),
  end: at(n + 1),
  minutes: 60 - n,
  top: hostAt(n).where,
  basis: "none",
});
const halfDay = (n: number) => ({
  from: at(n),
  to: at(n + 12),
  coverage,
  targets: Array.from({ length: 10 }, (_, i) => ({ target: hostAt(i), minutes: 60 - i })),
  byPlace: Array.from({ length: 12 }, (_, i) => ({
    by: "host",
    value: { untrusted: `site-${i}.example.org` },
    minutes: i,
  })),
  pages: Array.from({ length: 10 }, (_, i) => ({
    url: { untrusted: `https://site-${i}.example.org/some/long/path/to/a/page` },
    title: { untrusted: `The page numbered ${i}, a long title` },
    query: null,
    visits: 10 - i,
  })),
  byCategory: [{ category: "coding", minutes: 100 }],
  sessions: Array.from({ length: 12 }, (_, i) => session(i)),
  meetings: [],
  threads: Array.from({ length: 5 }, (_, i) => ({
    app: { untrusted: "com.example.chat" },
    thread: { untrusted: `Thread ${i}` },
    lines: 9,
  })),
  tasks: [],
  more: false,
});
const fullWork = {
  asOf: at(0),
  current: null,
  focus: Array.from({ length: 3 }, (_, i) => ({ target: hostAt(i), minutes: 60, lastAt: at(i) })),
  halfDays: [halfDay(0), halfDay(12)],
  deepWork: [0, 1].map((n) => ({
    rule: "deep@1",
    day: `2026-07-0${n + 1}`,
    coverage,
    complete: false,
    sessions: Array.from({ length: 3 }, (_, i) => ({
      target: { category: "coding" },
      start: at(i),
      end: at(i + 1),
      minutes: 60,
      carriedMinutes: 0,
      interruptions: 0,
      interruptedMinutes: 0,
    })),
    deepMinutes: 100,
    switchingMinutes: 10,
    meetingMinutes: 0,
    switches: 1,
    switchesPerHour: 1,
    interruptions: [],
    more: false,
  })),
  changes: [],
  openTasks: [],
  more: false,
};
const applications = Array.from({ length: 5 }, (_, n) => ({
  state: "applied",
  what: { untrusted: said(n).slice(0, SELF_LINE_CODE_POINTS) },
  from: { untrusted: "team@example.org" },
  at: at(n),
  message: `msg_${ulid(7_000 + n)}`,
}));
const openItems = {
  items: Array.from({ length: 4 }, (_, n) => ({
    what: { untrusted: said(n).slice(0, SELF_LINE_CODE_POINTS) },
    due: "2026-11-06",
    source: { kind: "calendar", id: `evt_${ulid(8_000 + n)}` },
    whoActs: owner,
    project: null,
    overdue: false,
    lateDays: null,
  })),
  more: false,
};
// As the box's: six moves, a note beside one.
const typicalNext = {
  moves: worstNext.moves
    .slice(0, 6)
    .map(({ reported, ...move }, n) => (n === 0 ? { ...move, reported: reported.slice(0, 1) } : move)),
  more: true,
};
type Whole = Parameters<typeof fitSelfPage>[0];
const SELF_WORST_WHOLE_PAGE = 45_000;
const wholePage = (over: Record<string, unknown>) =>
  fitSelfPage(
    SelfView.parse({ ...worstHead, goals, next: worstNext, openItems, applications, work: fullWork, ...over }) as Whole,
  );
const onTheWire = (value: SelfView): number => size(compactResult("get_self", value));

describe("get_self's whole page, what next and work in it", () => {
  it("the worst case's whole page, next at its most, stays under what a client holds inline", () => {
    const fitted = wholePage(filled(paged([...fullPage, ...worstNoticed])));
    process.stdout.write(`whole page, worst ${onTheWire(fitted)} (code points)\n`);
    // What is always wanted outweighs the target only here: every title and note at its longest, every section with a line.
    expect(onTheWire(fitted)).toBeLessThan(SELF_WORST_WHOLE_PAGE);
    expect(fitted.next?.moves).toHaveLength(NEXT_MOVES_MOST);
    expect(fitted.applications).toHaveLength(applications.length);
    expect(fitted.goals).toHaveLength(goals.length);
    expect(fitted.next?.moves.every((move) => (move.reported?.length ?? 0) <= 1)).toBe(true);
    expect(fitted.sections.every((section) => section.people.length <= PAGE_SECTION_PEOPLE)).toBe(true);
  });

  it("a page of a typical owner's lines fits, and every section keeps a line and says more", () => {
    long = false;
    const fitted = wholePage({
      // No people, as the box's sections hold none.
      sections: typical.sections.map((section) => ({ ...section, people: [] })),
      upcoming: head.upcoming,
      contacts: head.contacts,
      changes: head.changes,
      next: typicalNext,
      work: { ...fullWork, halfDays: [halfDay(0)] },
    });
    long = true;
    process.stdout.write(`whole page, typical ${onTheWire(fitted)} (code points)\n`);
    expect(onTheWire(fitted)).toBeLessThan(SELF_WHOLE_PAGE_CODE_POINTS * 1.05);
    expect(fitted.sections.every((section) => section.lines.length >= 1 && section.more)).toBe(true);
    expect(fitted.sections.reduce((sum, section) => sum + section.lines.length, 0)).toBeGreaterThan(20);
    fitted.sections.forEach((section, index) => {
      const whole = typical.sections[index]?.lines.slice(0, section.lines.length).map((line) => line.fact);
      expect(section.lines.map((line) => line.fact)).toEqual(whole);
    });
  });

  it("a note cut from a move says more; asking for history keeps the lines", () => {
    const cut = wholePage({ sections: [], next: { moves: worstNext.moves.slice(0, 1), more: false } });
    expect(cut.next?.more).toBe(true);
    const sections = page(fullPage);
    const kept = fitSelfPage(SelfView.parse({ ...worstHead, goals, sections }) as Whole, { keepLines: true });
    expect(kept.sections.flatMap((section) => section.lines)).toHaveLength(sections.flatMap((one) => one.lines).length);
  });

  it("the owner's constraints are kept ahead of other lines, and served in their rank", () => {
    const lineOf = (section: ReturnType<typeof page>[number], n: number, kind: string, tier: string) => ({
      ...(section.lines[0] as (typeof section.lines)[number]),
      fact: hex(50_000 + n),
      kind,
      tier,
    });
    const crowded = page(fullPage).map((section, d) => ({
      ...section,
      people: [],
      more: false,
      // Eight other lines, then a constraint of the owner's and one a source said, ranked last.
      lines: [
        ...section.lines.slice(0, 8),
        lineOf(section, d * 10, "constraint", "owner"),
        lineOf(section, d * 10 + 1, "constraint", "source"),
      ],
    }));
    const fitted = wholePage({
      sections: crowded,
      next: typicalNext,
      upcoming: head.upcoming,
      contacts: head.contacts,
    });
    for (const section of fitted.sections) {
      expect(section.lines.some((line) => line.kind === "constraint" && line.tier === "owner")).toBe(true);
      expect(section.lines.length).toBeLessThan(10);
      expect(section.constraintsLeftOff).toBeUndefined();
    }
    // A section's own order holds: the constraint keeps its place after the goals kept.
    const [first] = fitted.sections;
    expect(first?.lines.at(-1)?.kind).toBe("constraint");
  });

  it("past the budget, the owner's constraints left off are counted", () => {
    const section = page(fullPage)[0] as ReturnType<typeof page>[number];
    const lines = Array.from({ length: 10 }, (_, n) => ({
      ...(section.lines[0] as (typeof section.lines)[number]),
      fact: hex(60_000 + n),
      kind: "constraint" as const,
      tier: "owner" as const,
    }));
    const fitted = wholePage({
      ...filled(paged([...fullPage, ...worstNoticed])),
      sections: [{ ...section, lines, people: [] }],
    });
    const [only] = fitted.sections;
    expect(only?.lines.length).toBeLessThan(10);
    expect(only?.constraintsLeftOff).toBe(10 - (only?.lines.length ?? 0));
    expect(only?.more).toBe(true);
  });

  it("a page already small is left whole", () => {
    const sections = page(open.slice(0, 3)).map((section) => ({ ...section, people: [] }));
    const small = SelfView.parse({ ...head, upcoming: [], contacts: [], changes: [], sections, goals });
    expect(fitSelfPage(small as Whole)).toEqual(small);
  });

  it("notices keep their first lines and say more; a domain read's are not this function's", () => {
    const fitted = wholePage(filled(paged(situations().map(noticed))));
    expect(fitted.housekeeping?.lines).toHaveLength(PAGE_HOUSEKEEPING_LINES);
    expect(fitted.housekeeping?.more).toBe(true);
  });

  it("a stale line the page cuts is counted among those left off", () => {
    const stale = (section: ReturnType<typeof page>[number]) => ({
      ...section,
      more: false,
      lines: section.lines.map((line) => ({ ...line, stale: true as const })),
    });
    const fitted = wholePage({ sections: page(fullPage).map(stale) });
    const cut = fitted.sections.find((section) => (section.staleLeftOff ?? 0) > 0);
    expect(cut).toBeDefined();
    expect(cut?.more).toBe(true);
  });

  it("work on the page keeps what says what the time was on, says more, and moves no total", () => {
    const whole = SelfView.parse({ ...head, sections: [], work: fullWork }).work as NonNullable<SelfView["work"]>;
    const bounded = boundWork(whole);
    expect(bounded.more).toBe(true);
    for (const [index, day] of bounded.halfDays.entries()) {
      const before = whole.halfDays[index] as (typeof whole.halfDays)[number];
      expect(day.more).toBe(true);
      expect(day.threads).toEqual(before.threads);
      expect(day.coverage).toEqual(before.coverage);
      expect(day.byCategory).toEqual(before.byCategory);
      expect(day.pages?.length).toBe(5);
      expect(day.sessions.map((one) => one.minutes)).toEqual([60, 59, 58]);
    }
    expect(bounded.deepWork[0]?.deepMinutes).toBe(whole.deepWork[0]?.deepMinutes);
    expect(size(bounded)).toBeLessThan(size(whole) * 0.6);
    // A day of few places keeps them and says nothing is missing.
    const small = {
      ...whole,
      deepWork: [],
      more: false,
      halfDays: [
        {
          ...(whole.halfDays[0] as (typeof whole.halfDays)[number]),
          targets: [],
          byPlace: (whole.halfDays[0] as (typeof whole.halfDays)[number]).byPlace.slice(0, 3),
          pages: [],
          sessions: [],
          more: false,
        },
      ],
    };
    expect(boundWork(small)).toEqual(small);
    // Nothing to cut: as it was.
    const none = { ...whole, halfDays: [], deepWork: [], more: false };
    expect(boundWork(none)).toEqual(none);
  });
});

describe("get_self's size with the self page", () => {
  it("prints the sizes; get_self, with history too, stays within its bound, and one domain is under about 8 000 tokens", () => {
    process.stdout.write(
      `\nget_self ${after}, history ${history}, domain career ${career}, worst ${worst}, worst career ${worstCareer} (code points)\n`,
    );
    expect(after).toBeLessThan(SELF_MOST);
    expect(history).toBeLessThan(SELF_MOST);
    expect(career).toBeLessThan(32_000);
  });

  it("the worst case stays within the bound, and a domain call fits the reasoner's result cap whole", () => {
    expect(
      worstOpen.filter((one) => "domain" in one.values && one.values.domain === "career").length,
    ).toBeGreaterThanOrEqual(60);
    expect(worstHead.upcoming.every((one) => one.participants.length === SELF_PARTICIPANTS)).toBe(true);
    expect(worst).toBeLessThan(SELF_MOST);
    expect(worstCareer).toBeLessThan(RESULT_CODE_POINTS);
  });

  it("with every situation a system notice's and its headers a thousand code points long, the worst case still fits, and so does a page of notices alone", () => {
    const noticesOnly = wire({ ...worstHead, ...onlyNotices, goals });
    const noticesOnlyCareer = wire({ ...worstHead, ...onlyNoticesCareer, goals });
    process.stdout.write(
      `notices: worst ${worstNotices}, worst career ${worstNoticesCareer}, notices alone ${noticesOnly}, in career ${noticesOnlyCareer}, full page ${worstFull}\n`,
    );
    expect(worstNoticed.filter((one) => one.tier === "system_notice").length).toBeGreaterThanOrEqual(20);
    expect(worstNotices).toBeLessThan(SELF_MOST);
    expect(worstNoticesCareer).toBeLessThan(RESULT_CODE_POINTS);
    expect(noticesOnly).toBeLessThan(RESULT_CODE_POINTS);
    expect(noticesOnlyCareer).toBeLessThan(RESULT_CODE_POINTS);
    expect(worstFull).toBeLessThan(SELF_MOST);
    // No notice in a life domain's section.
    for (const kept of [paged(worstNoticed), paged(worstNoticed, "career")])
      expect(kept.sections.flatMap((section) => section.lines).some((line) => line.notice !== undefined)).toBe(false);
    const lines = onlyNotices.housekeeping?.lines ?? [];
    const career = onlyNoticesCareer.housekeeping?.lines ?? [];
    expect(lines).toHaveLength(SELF_HOUSEKEEPING_LINES);
    expect(career).toHaveLength(SELF_HOUSEKEEPING_LINES);
    expect(onlyNotices.sections).toEqual([]);
    for (const line of [...lines, ...career]) {
      // The mark is the tier and `notice`, code's fields beside the words, never in them.
      expect(line.tier).toBe("system_notice");
      expect(line.line.untrusted).not.toContain("system notice");
      expect([...line.line.untrusted].length).toBeLessThanOrEqual(SELF_LINE_CODE_POINTS);
      expect([...(line.notice?.from?.untrusted ?? "")].length).toBe(SELF_LINE_CODE_POINTS);
      expect([...(line.notice?.subject?.untrusted ?? "")].length).toBe(SELF_LINE_CODE_POINTS);
    }
  });

  it("a typical owner's lines fill every section to its limit, within the bound", () => {
    expect(typical.sections).toHaveLength(LIFE_DOMAINS.length + 1);
    const counts = typical.sections.map((section) => section.lines.length);
    expect(counts.every((count) => count === SELF_SECTION_LINES)).toBe(true);
    expect(wire({ ...worstHead, sections: typical.sections, goals })).toBeLessThan(SELF_MOST);
  });
});
