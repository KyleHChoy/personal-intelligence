import { describe, expect, it } from "vitest";
import { checkedChoices, groupStretches, uncreditedStretches, without } from "./time-groups.ts";
import { creditBlock, creditIntervals, type SubSpan, type WorkRow } from "./work-time-credit.ts";

const MIN = 60_000;
const block = { start: 0, end: 60 * MIN, minutes: 60, bundle: "a.b", keys: [{ key: "app:a.b", strong: true }] };
const base = { rulings: [], meetings: [], moments: [], anchors: [] };

describe("a proposed ruling in workTime@1", () => {
  it("credits what nothing else does, with its own basis", () => {
    expect(creditBlock({ block, ...base, proposed: [{ from: 0, to: 60 * MIN, project: "p" }] })).toEqual([
      { from: 0, to: 60 * MIN, minutes: 60, project: "p", basis: "proposed" },
    ]);
  });

  it("comes after an anchor the owner set, and after the owner's ruling, even of none", () => {
    const proposed = [{ from: 0, to: 60 * MIN, project: "p" }];
    expect(creditBlock({ block, ...base, proposed, anchors: [{ key: "app:a.b", project: "q" }] })[0]).toMatchObject({
      project: "q",
      basis: "anchor",
    });
    expect(
      creditBlock({ block, ...base, proposed, rulings: [{ from: 0, to: 60 * MIN, project: null }] })[0],
    ).toMatchObject({ project: null, basis: "ruling" });
  });

  it("two that disagree decide none", () => {
    expect(
      creditBlock({
        block,
        ...base,
        proposed: [
          { from: 0, to: 60 * MIN, project: "p" },
          { from: 0, to: 60 * MIN, project: "q" },
        ],
      })[0],
    ).toMatchObject({ project: null, basis: "none" });
  });
});

const span = (from: number, to: number, more: Partial<SubSpan> = {}): SubSpan => ({
  from,
  to,
  minutes: (to - from) / MIN,
  project: null,
  basis: "none",
  places: [
    { kind: "host", value: "docs.example.org", strength: "strong" },
    { kind: "app", value: "a.b", strength: "strong" },
  ],
  where: null,
  category: null,
  meeting: false,
  row: "cap_1",
  ...more,
});
const momentRow = (id: string, at: number, thread: string): WorkRow => ({
  id,
  evidence: `evd_${id}`,
  kind: "moment",
  startedAt: at,
  endedAt: at,
  minutes: null,
  day: null,
  compartments: ["own"],
  work: { kind: "moment", bundle: "a.b", thread, lines: 1 },
});
const blockRow: WorkRow = {
  id: "cap_1",
  evidence: "evd_1",
  kind: "block",
  startedAt: 0,
  endedAt: 60 * MIN,
  minutes: 60,
  day: "2026-05-04",
  compartments: ["own"],
  work: null,
};
const day = { from: 0, to: 24 * 60 * MIN };
const noException = () => false;

describe("a proposal and its block's label", () => {
  const blockOf = (id: string, compartments: string[], from: number, to: number): WorkRow => ({
    id,
    evidence: `evd_${id}`,
    kind: "block",
    startedAt: from,
    endedAt: to,
    minutes: (to - from) / MIN,
    day: "2026-05-04",
    compartments,
    work: {
      kind: "block",
      blocks: [
        {
          start: new Date(from).toISOString(),
          end: new Date(to).toISOString(),
          minutes: (to - from) / MIN,
          bundle: "a.b",
          category: null,
        },
      ],
      cut: { blocks: 0, minutes: 0 },
    },
  });
  const projects = ["own", "both"].map((id) => ({
    id,
    who: {} as never,
    name: id,
    compartments: ["own"],
    active: true,
  }));

  it("a proposal of a narrower label says nothing for an overlapping wider block's time", () => {
    const rulings = [
      { from: 0, to: 30 * MIN, project: "own", source: "system" as const, compartments: ["own"] },
      { from: 0, to: 30 * MIN, project: "both", source: "system" as const, compartments: ["employer:example", "own"] },
    ];
    const spans = creditIntervals({
      rows: [blockOf("cap_1", ["own"], 0, 30 * MIN), blockOf("cap_0", ["employer:example", "own"], 0, 30 * MIN)],
      links: [],
      anchors: [],
      projects,
      rulings,
    });
    expect(spans.map((one) => [one.project, one.basis])).toEqual([["both", "proposed"]]);
  });
});

describe("the day's uncredited stretches", () => {
  it("takes only what no rule credited, never a meeting's own interval", () => {
    const stretches = uncreditedStretches(
      [
        span(0, 10 * MIN),
        span(10 * MIN, 20 * MIN, { project: "p", basis: "anchor" }),
        span(20 * MIN, 30 * MIN, { meeting: true }),
      ],
      [blockRow],
      day,
      [],
      noException,
    );
    expect(stretches.map((one) => [one.from, one.to])).toEqual([[0, 10 * MIN]]);
  });

  it("a stretch held by a veto is taken out, wherever it falls", () => {
    expect(
      without({ from: 0, to: 10 }, [
        { from: 2, to: 4 },
        { from: 6, to: 20 },
      ]),
    ).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]);
    expect(uncreditedStretches([span(0, 10 * MIN)], [blockRow], day, [{ from: 0, to: 10 * MIN }], noException)).toEqual(
      [],
    );
  });

  it("an excepted app or host is never taken", () => {
    expect(
      uncreditedStretches([span(0, 10 * MIN)], [blockRow], day, [], (_, host) => host === "docs.example.org"),
    ).toEqual([]);
  });

  it("a thread names the time in its app after its own seconds, until another is read or it runs out", () => {
    const rows = [blockRow, momentRow("cap_2", 5 * MIN, "Alpha"), momentRow("cap_3", 15 * MIN, "Beta")];
    const stretches = uncreditedStretches([span(0, 60 * MIN)], rows, day, [], noException);
    const named = stretches.map((one) => [
      one.from / MIN,
      one.moment?.work?.kind === "moment" ? one.moment.work.thread : null,
    ]);
    expect(named).toEqual([
      [0, null],
      [5, "Alpha"],
      [15, "Beta"],
      [45, null],
    ]);
  });
});

describe("groups", () => {
  it("gathers by app, host and words, biggest first, dropping the slightest", () => {
    const stretches = uncreditedStretches(
      [span(0, 20 * MIN), span(30 * MIN, 40 * MIN), span(50 * MIN, 51 * MIN)],
      [blockRow],
      day,
      [],
      noException,
    );
    const titles = new Map([
      [0, "Plan"],
      [30 * MIN, "plan "],
      [50 * MIN, "Glance"],
    ]);
    const groups = groupStretches(stretches, (one) => titles.get(one.from) ?? null);
    expect(groups.map((group) => [group.text, group.minutes])).toEqual([["Plan", 30]]);
  });
});

describe("the model's answer", () => {
  const groups = new Set(["g1", "g2", "g3"]);
  const allowed = new Set(["ent_a"]);

  it("keeps a choice code can check", () => {
    expect(
      checkedChoices({ assignments: [{ project: "ent_a", groups: ["g1"] }], newEfforts: ["g2"] }, groups, allowed),
    ).toEqual({ assigned: [{ group: "g1", project: "ent_a" }], efforts: ["g2"], refused: 0 });
  });

  it("refuses a project it may not name, a group it did not ask about, and a group named twice", () => {
    expect(
      checkedChoices(
        {
          assignments: [
            { project: "ent_other", groups: ["g1"] },
            { project: "ent_a", groups: ["g9", "g2"] },
          ],
          newEfforts: ["g2", "g3"],
        },
        groups,
        allowed,
      ),
    ).toEqual({ assigned: [], efforts: ["g3"], refused: 4 });
  });
});
