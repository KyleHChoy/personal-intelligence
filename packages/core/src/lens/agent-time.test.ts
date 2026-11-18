import { describe, expect, it } from "vitest";
import { DAY_MS } from "../days.ts";
import { workTime } from "./work-time.ts";
import { creditBlock, creditIntervals, type WorkRow } from "./work-time-credit.ts";

// : an agent's ruling, then an agent's anchor, after every step the owner set or linked and the
// title steps, before a model's proposal.

const MIN = 60_000;
const block = {
  start: 0,
  end: 60 * MIN,
  minutes: 60,
  bundle: "a.b",
  keys: [
    { key: "app:a.b", strong: true },
    { key: "document:~/notes/alpha", strong: false },
  ],
};
const base = { rulings: [], meetings: [], moments: [], anchors: [] };
const all = { from: 0, to: 60 * MIN };
const one = (input: Parameters<typeof creditBlock>[0]) =>
  creditBlock(input).map((credit) => [credit.project, credit.basis]);

describe("an agent's ruling and anchor in workTime@1", () => {
  it("an agent's ruling credits what nothing the owner set does, with its own basis", () => {
    expect(one({ block, ...base, agentRulings: [{ ...all, project: "p" }] })).toEqual([["p", "agent_ruling"]]);
  });

  it("an agent's anchor meets the block's strong keys only, with its own basis", () => {
    expect(one({ block, ...base, agentAnchors: [{ key: "app:a.b", project: "p" }] })).toEqual([["p", "agent_anchor"]]);
    expect(one({ block, ...base, agentAnchors: [{ key: "document:~/notes/alpha", project: "p" }] })).toEqual([
      [null, "none"],
    ]);
  });

  it("every step the owner set outranks an agent's: a ruling (of none too), a meeting, an anchor, a moment, a title", () => {
    const agent = {
      agentRulings: [{ ...all, project: "agent" }],
      agentAnchors: [{ key: "app:a.b", project: "agent" }],
    };
    expect(one({ block, ...base, ...agent, rulings: [{ ...all, project: null }] })).toEqual([[null, "ruling"]]);
    expect(one({ block, ...base, ...agent, meetings: [{ ...all, project: "m" }] })).toEqual([["m", "meeting"]]);
    expect(one({ block, ...base, ...agent, anchors: [{ key: "app:a.b", project: "o" }] })).toEqual([["o", "anchor"]]);
    expect(one({ block, ...base, ...agent, moments: [{ ...all, bundle: "a.b", project: "s" }] })).toEqual([
      ["s", "moment"],
    ]);
    expect(
      one({
        block: { ...block, titles: ["title:t1"] },
        ...base,
        ...agent,
        anchors: [{ key: "title:t1", project: "t" }],
      }),
    ).toEqual([["t", "title"]]);
  });

  it("an agent's ruling outranks an agent's anchor, and each outranks a proposal", () => {
    const proposed = [{ ...all, project: "model" }];
    expect(
      one({
        block,
        ...base,
        proposed,
        agentRulings: [{ from: 0, to: 30 * MIN, project: "ruled" }],
        agentAnchors: [{ key: "app:a.b", project: "anchored" }],
      }),
    ).toEqual([
      ["ruled", "agent_ruling"],
      ["anchored", "agent_anchor"],
    ]);
    expect(one({ block, ...base, proposed, agentAnchors: [{ key: "app:a.b", project: "anchored" }] })).toEqual([
      ["anchored", "agent_anchor"],
    ]);
  });

  it("two agents' projects at one step give none there, and the next step is tried", () => {
    const proposed = [{ ...all, project: "model" }];
    const agentAnchors = [
      { key: "app:a.b", project: "a" },
      { key: "app:a.b", project: "b" },
    ];
    expect(one({ block, ...base, proposed, agentAnchors })).toEqual([["model", "proposed"]]);
    const agentRulings = [
      { ...all, project: "a" },
      { ...all, project: "b" },
    ];
    expect(one({ block, ...base, agentRulings, agentAnchors: [{ key: "app:a.b", project: "c" }] })).toEqual([
      ["c", "agent_anchor"],
    ]);
  });
});

describe("agents' rows over every visible block", () => {
  const blockOf = (id: string, compartments: string[]): WorkRow => ({
    id,
    evidence: `evd_${id}`,
    kind: "block",
    startedAt: 0,
    endedAt: 30 * MIN,
    minutes: 30,
    day: "2026-05-04",
    compartments,
    work: {
      kind: "block",
      blocks: [
        {
          start: new Date(0).toISOString(),
          end: new Date(30 * MIN).toISOString(),
          minutes: 30,
          bundle: "a.b",
          category: null,
        },
      ],
      cut: { blocks: 0, minutes: 0 },
    },
  });
  const projects = [
    { id: "own", who: {} as never, name: "own", compartments: ["own"], active: true },
    { id: "wide", who: {} as never, name: "wide", compartments: ["employer:example", "own"], active: true },
  ];

  it("a ruling or an anchor of a project outside the block's label credits nothing there", () => {
    const rows = [blockOf("cap_1", ["own"])];
    const ruled = creditIntervals({
      rows,
      links: [],
      anchors: [],
      projects,
      agentRulings: [
        {
          from: 0,
          to: 30 * MIN,
          project: "wide",
          compartments: ["employer:example", "own"],
          reach: ["employer:example", "own"],
        },
      ],
    });
    expect(ruled.map((span) => [span.project, span.basis])).toEqual([[null, "none"]]);
    const anchored = creditIntervals({
      rows,
      links: [],
      anchors: [],
      projects,
      agentAnchors: [{ key: "app:a.b", project: "wide" }],
    });
    expect(anchored.map((span) => [span.project, span.basis])).toEqual([[null, "none"]]);
    // The positive control: within the label, each credits.
    expect(
      creditIntervals({
        rows,
        links: [],
        anchors: [],
        projects,
        agentAnchors: [{ key: "app:a.b", project: "own" }],
      }).map((span) => [span.project, span.basis]),
    ).toEqual([["own", "agent_anchor"]]);
    expect(
      creditIntervals({
        rows,
        links: [],
        anchors: [],
        projects,
        agentRulings: [{ from: 0, to: 30 * MIN, project: "own", compartments: ["own"], reach: ["own"] }],
      }).map((span) => [span.project, span.basis]),
    ).toEqual([["own", "agent_ruling"]]);
  });

  it("a ruling credits only a block within what its agent could see", () => {
    const wide = [blockOf("cap_2", ["employer:example", "own"])];
    const ruling = { from: 0, to: 30 * MIN, project: "own", compartments: ["own"] };
    const credit = (reach: string[]) =>
      creditIntervals({ rows: wide, links: [], anchors: [], projects, agentRulings: [{ ...ruling, reach }] }).map(
        (span) => [span.project, span.basis],
      );
    expect(credit(["own"])).toEqual([[null, "none"]]);
    expect(credit(["employer:example", "own"])).toEqual([["own", "agent_ruling"]]);
  });
});

describe("get_work_time's view, computed at read", () => {
  const T = Date.parse("2026-05-04T10:00:00Z");
  const block = (id: string, from: number, bundle: string): WorkRow => ({
    id,
    evidence: `evd_${id}`,
    kind: "block",
    startedAt: T + from * MIN,
    endedAt: T + (from + 30) * MIN,
    minutes: 30,
    day: "2026-05-04",
    compartments: ["own"],
    work: {
      kind: "block",
      blocks: [
        {
          start: new Date(T + from * MIN).toISOString(),
          end: new Date(T + (from + 30) * MIN).toISOString(),
          minutes: 30,
          bundle,
          category: null,
        },
      ],
      cut: { blocks: 0, minutes: 0 },
    },
  });
  const moment: WorkRow = {
    id: "cap_m",
    evidence: "evd_m",
    kind: "moment",
    startedAt: T + 60 * MIN,
    endedAt: T + 61 * MIN,
    minutes: null,
    day: null,
    compartments: ["own"],
    work: { kind: "moment", bundle: "test.example.chat", thread: "Planning", lines: 1 },
  };
  const who = (id: string) => ({ id, kind: "project", name: { untrusted: id }, address: null }) as never;
  const projects = ["ent_a", "ent_b"].map((id) => ({
    id,
    who: who(id),
    name: id,
    compartments: ["own"],
    active: true,
  }));
  const view = () =>
    workTime(
      {
        rows: [
          block("cap_1", 0, "test.example.editor"),
          block("cap_2", 60, "test.example.chat"),
          moment,
          block("cap_3", 120, "test.example.term"),
          block("cap_4", 180, "test.example.mail"),
        ],
        links: [],
        anchors: [],
        projects,
        agentAnchors: [{ key: "app:test.example.term", project: "ent_a" }],
        rulings: [
          {
            from: T + 180 * MIN,
            to: T + 210 * MIN,
            project: "ent_b",
            source: "system",
            compartments: ["own"],
            proposal: "tpr_1",
          },
        ],
        commitments: [],
        partial: { rows: false, tasks: false },
        zone: null,
        now: T + DAY_MS,
      },
      { view: "sort", from: "2026-05-04", to: "2026-05-04" },
    ).sort;

  it("credits by project and basis, uncredited by place (the thread on screen, else the most specific place), and the live proposals", () => {
    const sort = view();
    expect(sort?.from).toBe("2026-05-04T00:00:00.000Z");
    expect(sort?.to).toBe("2026-05-05T00:00:00.000Z");
    expect(sort?.credited.map((one) => [one.project.id, one.basis, one.minutes])).toEqual([
      ["ent_a", "agent_anchor", 30],
      ["ent_b", "proposed", 30],
    ]);
    expect(sort?.uncredited.map((one) => [one.place.kind, one.place.value.untrusted, one.minutes])).toEqual([
      ["thread", "Planning", 30],
      ["app", "test.example.editor", 30],
    ]);
    expect(sort?.uncreditedMinutes).toBe(60);
    expect(sort?.proposals).toEqual([
      {
        proposal: "tpr_1",
        project: who("ent_b"),
        stretches: [{ from: "2026-05-04T13:00:00.000Z", to: "2026-05-04T13:30:00.000Z" }],
        place: { kind: "app", value: { untrusted: "test.example.mail" } },
      },
    ]);
    expect(sort?.more).toBe(false);
  });
});

describe("get_work_time's titles, for the title role alone", () => {
  const T = Date.parse("2026-05-04T10:00:00Z");
  const iso = (minute: number) => new Date(T + minute * MIN).toISOString();
  const browser = (id: string, from: number, pages: { url: string; title?: string }[]): WorkRow => ({
    id,
    evidence: `evd_${id}`,
    kind: "block",
    startedAt: T + from * MIN,
    endedAt: T + (from + 30) * MIN,
    minutes: 30,
    day: "2026-05-04",
    compartments: ["own"],
    work: {
      kind: "block",
      blocks: [
        {
          start: iso(from),
          end: iso(from + 30),
          minutes: 30,
          bundle: "test.example.browser",
          host: "docs.example.org",
          category: null,
          pages: pages.map((page) => ({ ...page, firstAt: iso(from), lastAt: iso(from + 1), count: 1 })),
        },
      ],
      cut: { blocks: 0, minutes: 0 },
    },
  });
  const meeting: WorkRow = {
    id: "cap_meet",
    evidence: "evd_meet",
    kind: "meeting",
    startedAt: T + 120 * MIN,
    endedAt: T + 150 * MIN,
    minutes: null,
    day: null,
    compartments: ["own"],
    work: null,
  };
  const rows = [
    browser("cap_1", 0, [
      { url: "https://docs.example.org/a", title: "Harbor guide" },
      { url: "https://docs.example.org/b" },
    ]),
    browser("cap_2", 60, [{ url: "https://docs.example.org/c", title: "Quay notes" }]),
    meeting,
  ];
  const sortWith = (titles?: Parameters<typeof workTime>[0]["titles"]) =>
    workTime(
      {
        rows,
        links: [],
        anchors: [],
        projects: [],
        commitments: [],
        partial: { rows: false, tasks: false },
        zone: null,
        now: T + DAY_MS,
        ...(titles === undefined ? {} : { titles }),
      },
      { view: "sort", from: "2026-05-04", to: "2026-05-04" },
    ).sort;
  const titles = {
    window: (stretch: { row: string }) => (stretch.row === "cap_1" ? "Harbor plan" : "Quay plan"),
    meeting: (row: string) => (row === "cap_meet" ? "Weekly sync" : null),
  };

  it("without titles, no group has a title or pages and no meeting is named", () => {
    const sort = sortWith();
    expect(sort?.uncredited.map((one) => one.minutes)).toEqual([60]);
    for (const group of sort?.uncredited ?? []) {
      expect(group).not.toHaveProperty("title");
      expect(group).not.toHaveProperty("pages");
    }
    expect(sort).not.toHaveProperty("meetings");
  });

  it("with titles, groups split by window title, each with its pages' titles, and the uncredited meeting by name, all untrusted", () => {
    const sort = sortWith(titles);
    expect(
      sort?.uncredited.map((one) => [one.title?.untrusted, one.pages?.map((page) => page.untrusted), one.minutes]),
    ).toEqual([
      ["Harbor plan", ["Harbor guide"], 30],
      ["Quay plan", ["Quay notes"], 30],
    ]);
    expect(sort?.meetings).toEqual([{ name: { untrusted: "Weekly sync" }, from: iso(120), to: iso(150), minutes: 30 }]);
  });

  it("a meeting with no name the store could serve is left out", () => {
    expect(sortWith({ ...titles, meeting: () => null })?.meetings).toEqual([]);
  });
});
