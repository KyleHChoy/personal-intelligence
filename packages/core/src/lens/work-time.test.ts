import {
  type ActivityCategory,
  type BlockItem,
  CaptureWork,
  DEEP_SESSIONS,
  type MomentItem,
  type TaskItem,
  TITLE_NAMES_MOST,
  type Who,
  WORK_NOW_TOKENS,
  WORK_VECTORS,
  type WorkVector,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { halfDayWindows } from "../days.ts";
import { parseActivityTable } from "./activity.ts";
import { fitWorkNow, workTime, workWindows } from "./work-time.ts";
import {
  creditIntervals,
  type SubSpan,
  sessionsOf,
  type WorkInputs,
  type WorkProject,
  type WorkRow,
} from "./work-time-credit.ts";
import { deepWorkOf } from "./work-time-deep.ts";
import { attributeCheck, captureWorkOf, lineCount } from "./work-time-seal.ts";
import { matchWindow } from "./work-time-tasks.ts";

// Work time's pure rule, on made-up values only.

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T14:00:00.000Z");
const at = (minute: number): string => new Date(T0 + minute * MIN).toISOString();
const ULID = (n: number): string => `01JABCDEFGHJKMNPQRSTVW${String(n).padStart(4, "0")}`;
const who = (id: string): Who => ({ id: id as Who["id"], kind: "project", name: { untrusted: id }, address: null });
const project = (id: string, compartments: string[] = ["own"], name = id): WorkProject => ({
  id,
  who: who(id),
  name,
  compartments,
  active: true,
});

let next = 0;
const row = (
  kind: WorkRow["kind"],
  from: number,
  to: number,
  work: CaptureWork | null,
  extra: Partial<WorkRow> = {},
): WorkRow => {
  next += 1;
  return {
    id: `cap_${ULID(next)}`,
    evidence: `evi_${ULID(next)}`,
    kind,
    startedAt: T0 + from * MIN,
    endedAt: T0 + to * MIN,
    minutes: null,
    day: null,
    compartments: ["own"],
    work,
    ...extra,
  };
};
const blockWork = (
  blocks: {
    from: number;
    to: number;
    minutes?: number;
    bundle: string;
    category?: ActivityCategory | null;
    repository?: { value: string; method: "git_remote" | "prompt_mention" };
    host?: string;
  }[],
  cut = { blocks: 0, minutes: 0 },
): CaptureWork => ({
  kind: "block",
  blocks: blocks.map((one) => ({
    start: at(one.from),
    end: at(one.to),
    minutes: one.minutes ?? one.to - one.from,
    bundle: one.bundle,
    category: one.category === undefined ? "coding" : one.category,
    ...(one.host === undefined ? {} : { host: one.host }),
    ...(one.repository === undefined ? {} : { repository: one.repository }),
  })),
  cut,
});
const inputs = (over: Partial<WorkInputs>): WorkInputs => ({
  rows: [],
  links: [],
  anchors: [],
  projects: [],
  commitments: [],
  partial: { rows: false, tasks: false },
  zone: null,
  now: T0 + 24 * 60 * MIN,
  ...over,
});
const spanOf = (one: {
  from: number;
  to: number;
  minutes?: number;
  project?: string;
  category?: ActivityCategory;
  meeting?: true;
}): SubSpan => ({
  from: T0 + one.from * MIN,
  to: T0 + one.to * MIN,
  minutes: one.minutes ?? one.to - one.from,
  project: one.project ?? null,
  basis: one.meeting ? "meeting" : one.project === undefined ? "none" : "anchor",
  places: [],
  where: null,
  category: one.meeting ? "meetings" : (one.category ?? null),
  meeting: one.meeting === true,
  row: "cap_x",
});
const coverage = (through: string | null = null) => ({
  through,
  observedMinutes: 0,
  creditedMinutes: 0,
  unattributedMinutes: 0,
  weakMinutes: 0,
  dayCutBlocks: 0,
  dayCutMinutes: 0,
  pendingMinutes: 0,
  partial: false,
});
const r1 = (value: number): number => Math.round(value * 10) / 10;

describe("a cut no rule could file", () => {
  const day = at(0).slice(0, 10);
  const unfiled = {
    among: ["employer:example", "own"],
    reasons: { no_account: { blocks: 2, minutes: 40 }, no_app: { blocks: 1, minutes: 3 } },
  };
  const blocks = (cut: Parameters<typeof blockWork>[1]) =>
    row("block", 0, 60, blockWork([{ from: 0, to: 60, bundle: "test.example.term" }], cut), { day });
  const coverageFor = (clearance: readonly string[] | undefined) => {
    const rows = [blocks({ blocks: 3, minutes: 2, unfiled } as never)];
    const views = workTime(inputs({ rows, ...(clearance === undefined ? {} : { clearance }) }), { view: "day", day });
    return views.day;
  };

  it("is added, with its reasons, for a caller cleared for all of among, on both half-days", () => {
    const found = coverageFor(["employer:example", "own"]);
    for (const half of found?.halfDays ?? [])
      expect(half.coverage).toMatchObject({
        dayCutBlocks: 6,
        dayCutMinutes: 45,
        dayCutReasons: {
          other: { blocks: 3, minutes: 2 },
          no_account: { blocks: 2, minutes: 40 },
          no_app: { blocks: 1, minutes: 3 },
        },
      });
  });

  it("changes nothing for a caller not cleared for one of them, or with no clearance given", () => {
    for (const clearance of [["own"], undefined]) {
      const coverage = coverageFor(clearance)?.halfDays[0]?.coverage;
      expect(coverage).toMatchObject({
        dayCutBlocks: 3,
        dayCutMinutes: 2,
        dayCutReasons: { other: { blocks: 3, minutes: 2 } },
      });
      expect(coverage?.dayCutReasons).not.toHaveProperty("no_account");
    }
  });

  it("a day with no cut carries no reasons", () => {
    const views = workTime(inputs({ rows: [blocks({ blocks: 0, minutes: 0 })] }), { view: "day", day });
    expect(views.day?.halfDays[0]?.coverage.dayCutReasons).toBeUndefined();
  });

  it("a day with a cut the caller may be told is not complete, however late Lens saw it", () => {
    const whole = (cut: Parameters<typeof blockWork>[1]) => {
      const work = {
        ...blockWork([{ from: 0, to: 60, bundle: "test.example.term" }], cut),
        coveredThrough: at(24 * 60 - 1),
      } as CaptureWork;
      return workTime(inputs({ rows: [row("block", 0, 60, work, { day })], clearance: ["employer:example", "own"] }), {
        view: "day",
        day,
      }).day?.deepWork.complete;
    };
    expect(whole({ blocks: 0, minutes: 0 })).toBe(true);
    expect(whole({ blocks: 1, minutes: 5 })).toBe(false);
    expect(whole({ blocks: 3, minutes: 0 })).toBe(false);
    expect(whole({ blocks: 0, minutes: 0, unfiled } as never)).toBe(false);
  });

  it("sealing carries it on the split given it, and no other", () => {
    const item = {
      kind: "block" as const,
      key: "block:01JWT100000000000000000001" as never,
      revision: 0,
      day,
      blocks: [{ start: at(0), end: at(60), minutes: 60, app: { bundle: "test.example.term", name: "Term" } }],
    };
    expect(captureWorkOf(item, { table: null, unfiled }).work).toMatchObject({
      cut: { blocks: 0, minutes: 0, unfiled },
    });
    expect(captureWorkOf(item, { table: null }).work).toMatchObject({ cut: { blocks: 0, minutes: 0 } });
    expect(CaptureWork.safeParse(captureWorkOf(item, { table: null, unfiled }).work).success).toBe(true);
  });
});

describe("WORK_VECTORS: every case passes", () => {
  const ofRule = <R extends WorkVector["rule"]>(rule: R) =>
    WORK_VECTORS.filter((one): one is Extract<WorkVector, { rule: R }> => one.rule === rule);

  it("holds a case for each rule it covers", () => {
    for (const rule of ["R3", "R12", "R20", "R34", "R82"] as const)
      expect(ofRule(rule).length, rule).toBeGreaterThan(0);
  });

  for (const vector of ofRule("R3")) {
    it(`${vector.name}`, () => expect(attributeCheck(vector.kind, vector.attribute, vector.title)).toBe(vector.kept));
  }
  for (const vector of ofRule("R34")) {
    it(`${vector.name}`, () => expect(lineCount(vector.text)).toBe(vector.lines));
  }
  for (const vector of ofRule("R12")) {
    it(`${vector.name}`, () => {
      const blocks = row("block", 0, 0, blockWork(vector.blocks.map((one) => ({ ...one, category: "coding" }))));
      const meetings = vector.meetings.map((one) => row("meeting", one.from, one.to, null));
      const moments = vector.moments.map((one) =>
        row("moment", one.from, one.to, { kind: "moment", bundle: one.bundle, thread: null, lines: 1 }),
      );
      const links = [
        ...vector.meetings.map((one, index) => ({ capture: meetings[index]?.id ?? "", project: one.project })),
        ...vector.moments.map((one, index) => ({ capture: moments[index]?.id ?? "", project: one.project })),
      ].filter((link): link is { capture: string; project: string } => link.project !== null);
      const names = new Set([...links.map((link) => link.project), ...vector.anchors.map((anchor) => anchor.project)]);
      const spans = creditIntervals({
        rows: [blocks, ...meetings, ...moments],
        links,
        anchors: vector.anchors,
        projects: [...names].map((id) => project(id)),
      });
      expect(
        spans.map((one) => [(one.from - T0) / MIN, (one.to - T0) / MIN, r1(one.minutes), one.project, one.basis]),
      ).toEqual(vector.credits);
    });
  }
  for (const vector of ofRule("R20")) {
    it(`${vector.name}`, () => {
      const sessions = sessionsOf(vector.spans.map(spanOf));
      expect(
        sessions.map((one) => ["project" in one.target ? one.target.project : one.target.where.value, r1(one.minutes)]),
      ).toEqual(vector.sessions);
    });
  }
  for (const vector of ofRule("R82")) {
    it(`${vector.name}`, () => {
      const day = deepWorkOf("2026-10-01", vector.spans.map(spanOf), coverage(), (id) => who(id), null);
      expect(
        day.sessions.map((one) => [
          "project" in one.target ? `p:${String(one.target.project.id)}` : `c:${one.target.category}`,
          one.minutes,
          one.carriedMinutes,
        ]),
      ).toEqual(vector.sessions);
    });
  }
});

describe("the drain's half", () => {
  const table = parseActivityTable(
    JSON.stringify({
      version: 1,
      rules: [
        { bundle: "test.example.term", category: "coding" },
        { host: "docs.example.com", category: "research" },
      ],
    }),
  );
  const block: BlockItem = {
    kind: "block",
    key: `block:${ULID(1)}`,
    revision: 0,
    day: "2026-10-01",
    blocks: [
      {
        start: at(0),
        end: at(30),
        minutes: 30,
        app: { bundle: "test.example.term", name: "Term" },
        title: "secret.ts — alpha",
        account: "owner@example.com",
        repository: { value: "forge.example.com/owner/alpha", method: "git_remote", v: 1 },
        folder: { value: "~/Downloads", method: "ax_document", v: 1 },
      },
      {
        start: at(30),
        end: at(40),
        minutes: 10,
        app: { bundle: "test.example.web", name: "Web" },
        host: "docs.example.com",
        document: { value: "~/Code/alpha/plan.md", method: "window_title_path", v: 1 },
      },
    ],
  };

  it("WT2: keeps a good attribute, drops a generic one and a title path not in the title, counted by method, and absent from work_enc", () => {
    const sealed = captureWorkOf({ ...block, cut: [{ app: "test.example.chat", blocks: 2, minutes: 1.5 }] }, { table });
    expect(sealed.refused).toEqual({ ax_document: 1, window_title_path: 1 });
    expect(sealed.work).toEqual({
      kind: "block",
      blocks: [
        {
          start: at(0),
          end: at(30),
          minutes: 30,
          bundle: "test.example.term",
          category: "coding",
          repository: { value: "forge.example.com/owner/alpha", method: "git_remote" },
        },
        {
          start: at(30),
          end: at(40),
          minutes: 10,
          bundle: "test.example.web",
          host: "docs.example.com",
          category: "research",
        },
      ],
      cut: { blocks: 2, minutes: 1.5 },
    });
    expect(JSON.stringify(sealed.work)).not.toMatch(/owner@example|secret|"v":/);
  });

  it("the category is the box's table's, over the block's raw fields; with no table it is null and nothing else changes", () => {
    const none = captureWorkOf(block, { table: null });
    expect(none.work.kind === "block" && none.work.blocks.map((one) => one.category)).toEqual([null, null]);
    expect(none.work.kind === "block" && none.work.cut).toEqual({ blocks: 0, minutes: 0 });
  });

  it("a moment's bundle and thread from its facts with its line count; a task's fields as pushed", () => {
    const moment = { kind: "moment", text: "hello\n\nworld 2" } as MomentItem;
    expect(captureWorkOf(moment, { table, facts: { bundle: "test.example.chat", thread: "Team" } }).work).toEqual({
      kind: "moment",
      bundle: "test.example.chat",
      thread: "Team",
      lines: 2,
    });
    const task: TaskItem = {
      kind: "task",
      key: `task:${ULID(2)}`,
      revision: 1,
      byOwner: true,
      title: "Write the plan",
      project: "Alpha",
      events: [{ kind: "created", at: at(0) }],
      doneAt: at(5),
    };
    expect(captureWorkOf(task, { table }).work).toEqual({
      kind: "task",
      title: "Write the plan",
      project: "Alpha",
      events: [{ kind: "created", at: at(0) }],
      doneAt: at(5),
    });
  });
});

describe("credit at read", () => {
  const alpha = { value: "forge.example.com/owner/alpha", method: "git_remote" as const };
  const anchors = [{ key: "repository:forge.example.com/owner/alpha", project: "alpha" }];

  it("WT4: minutes of all targets sum to the observed minutes, whatever order the rows come in", () => {
    const blocks = row(
      "block",
      0,
      0,
      blockWork([
        { from: 0, to: 60, bundle: "test.example.term", repository: alpha },
        { from: 60, to: 90, bundle: "test.example.call" },
      ]),
    );
    const meeting = row("meeting", 70, 120, null);
    const links = [{ capture: meeting.id, project: "beta" }];
    const projects = [project("alpha"), project("beta")];
    const one = creditIntervals({ rows: [blocks, meeting], links, anchors, projects });
    const two = creditIntervals({ rows: [meeting, blocks], links, anchors, projects });
    expect(two).toEqual(one);
    expect(r1(one.reduce((total, span) => total + span.minutes, 0))).toBe(60 + 30 + 30);
    expect(one.map((span) => [span.project, span.basis, r1(span.minutes)])).toEqual([
      ["alpha", "anchor", 60],
      [null, "none", 10],
      ["beta", "meeting", 20],
      ["beta", "meeting", 30],
    ]);
  });

  it("an own block is never credited to an employer project, by anchor, meeting or moment", () => {
    const blocks = row("block", 0, 0, blockWork([{ from: 0, to: 60, bundle: "test.example.term", repository: alpha }]));
    const meeting = row("meeting", 0, 30, null, { compartments: ["own"] });
    const moment = row("moment", 30, 60, { kind: "moment", bundle: "test.example.term", thread: null, lines: 1 });
    const spans = creditIntervals({
      rows: [blocks, meeting, moment],
      links: [
        { capture: meeting.id, project: "work" },
        { capture: moment.id, project: "work" },
      ],
      anchors: [{ key: anchors[0]?.key ?? "", project: "work" }],
      projects: [project("work", ["employer:example"])],
    });
    expect(spans.every((span) => span.project === null)).toBe(true);
  });

  describe("step 4b2: a thread named exactly for a project", () => {
    const app = "test.example.chat";
    const day = () => row("block", 0, 0, blockWork([{ from: 0, to: 60, bundle: app }]));
    const thread = (title: string | null, from = 10, to = 20, extra: Partial<WorkRow> = {}) =>
      row("moment", from, to, { kind: "moment", bundle: app, thread: title, lines: 5, threadFps: ["fp"] }, extra);
    const credited = (rows: WorkRow[], projects: WorkProject[], over: Partial<WorkInputs> = {}) =>
      creditIntervals({ rows, links: [], anchors: [], projects, ...over })
        .filter((span) => span.project !== null)
        .map((span) => [span.project, span.basis, r1(span.minutes)]);

    it("credits the thread's own span, whatever its case or spacing, and 10 minutes past it", () => {
      const rows = [day(), thread("  personal   LEDGER ")];
      expect(credited(rows, [project("p", ["own"], "Personal Ledger")])).toEqual([["p", "title", 20]]);
    });

    it("a thread that only begins with the name, or holds its last word, credits nothing", () => {
      const named = [project("p", ["own"], "Personal Ledger")];
      expect(credited([day(), thread("Personal Ledger plan")], named)).toEqual([]);
      expect(credited([day(), thread("ledger")], named)).toEqual([]);
    });

    it("a thread whose title keys a person's erasure dropped credits nothing", () => {
      const erased = row("moment", 10, 20, { kind: "moment", bundle: app, thread: "Personal Ledger", lines: 5 });
      expect(credited([day(), erased], [project("p", ["own"], "Personal Ledger")])).toEqual([]);
    });

    it("a one-word name proves nothing, and two projects of one name give none", () => {
      expect(credited([day(), thread("Bridge")], [project("p", ["own"], "Bridge")])).toEqual([]);
      const both = [project("p", ["own"], "Personal Ledger"), project("q", ["own"], "personal ledger")];
      expect(credited([day(), thread("Personal Ledger")], both)).toEqual([]);
    });

    it("a closed project, or one outside the block's label, credits nothing", () => {
      const closed = { ...project("p", ["own"], "Personal Ledger"), active: false };
      expect(credited([day(), thread("Personal Ledger")], [closed])).toEqual([]);
      expect(
        credited([day(), thread("Personal Ledger")], [project("p", ["employer:example"], "Personal Ledger")]),
      ).toEqual([]);
    });

    it("a moment wider than its block still credits it, as a linked one does", () => {
      const wide = thread("Personal Ledger", 10, 20, { compartments: ["agent:one", "own"] });
      expect(credited([day(), wide], [project("p", ["own"], "Personal Ledger")])).toEqual([["p", "title", 20]]);
    });

    it("every word of the owner's goes first: a ruling, a link and a title anchor each outrank it", () => {
      const named = project("p", ["own"], "Personal Ledger");
      const other = project("o", ["own"], "Other Work");
      const chat = thread("Personal Ledger");
      const none = { from: T0, to: T0 + 60 * MIN, project: null, source: "owner", compartments: ["own"] } as const;
      expect(credited([day(), chat], [named], { rulings: [none] })).toEqual([]);
      expect(credited([day(), chat], [named, other], { links: [{ capture: chat.id, project: "o" }] })).toEqual([
        ["o", "moment", 20],
      ]);
    });

    it("beside a thread of another project at one instant, gives none", () => {
      const named = [project("p", ["own"], "Personal Ledger"), project("q", ["own"], "Other Ledger")];
      expect(credited([day(), thread("Personal Ledger"), thread("Other Ledger")], named)).toEqual([]);
    });
  });

  it("a meeting outside the block's label credits it nothing", () => {
    const blocks = row("block", 0, 0, blockWork([{ from: 0, to: 60, bundle: "test.example.call" }]));
    const meeting = row("meeting", 0, 60, null, { compartments: ["own", "employer:example"] });
    const spans = creditIntervals({
      rows: [blocks, meeting],
      links: [{ capture: meeting.id, project: "alpha" }],
      anchors: [],
      projects: [project("alpha")],
    });
    expect(spans.map((span) => [span.project, span.basis])).toEqual([[null, "none"]]);
  });

  it("a meeting recorded twice counts its hour once, the earlier-started one's", () => {
    const first = row("meeting", 0, 60, null);
    const second = row("meeting", 10, 60, null);
    const spans = creditIntervals({ rows: [second, first], links: [], anchors: [], projects: [] });
    expect(r1(spans.reduce((total, span) => total + span.minutes, 0))).toBe(60);
    expect(new Set(spans.map((span) => span.row))).toEqual(new Set([first.id]));
  });

  it("WT6: unattributed time keeps its most specific place and its category", () => {
    const blocks = row(
      "block",
      0,
      0,
      blockWork([{ from: 0, to: 30, bundle: "test.example.web", host: "Docs.Example.com.", category: "research" }]),
    );
    const [span] = creditIntervals({ rows: [blocks], links: [], anchors: [], projects: [] });
    expect(span?.where).toEqual({ kind: "host", value: "docs.example.com", strength: "strong" });
    expect(span?.places.map((place) => place.kind)).toEqual(["host", "app"]);
    expect(span?.category).toBe("research");
  });
});

describe("half-days", () => {
  it("WT13: a half-day equals a hand count, with places counted under every place a block has", () => {
    const day = "2026-10-01";
    const blocks = row(
      "block",
      0,
      0,
      blockWork(
        [
          {
            from: 0,
            to: 60,
            bundle: "test.example.term",
            repository: { value: "forge.example.com/owner/alpha", method: "git_remote" },
          },
          { from: 60, to: 80, bundle: "test.example.web", host: "docs.example.com", category: "research" },
        ],
        { blocks: 3, minutes: 2 },
      ),
      { day },
    );
    const views = workTime(
      inputs({
        rows: [blocks],
        anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "alpha" }],
        projects: [project("alpha")],
      }),
      { view: "day", day },
    );
    const [am, pm] = views.day?.halfDays ?? [];
    // 14:00 to 15:20 UTC is the afternoon.
    expect(am?.coverage.observedMinutes).toBe(0);
    expect(pm?.coverage).toMatchObject({
      observedMinutes: 80,
      creditedMinutes: 60,
      unattributedMinutes: 20,
      dayCutBlocks: 3,
      dayCutMinutes: 2,
      through: at(80),
    });
    expect(am?.coverage.dayCutBlocks).toBe(3);
    expect(
      pm?.targets.map((one) => [
        "project" in one.target ? one.target.project.id : one.target.where.value.untrusted,
        one.minutes,
      ]),
    ).toEqual([
      ["alpha", 60],
      ["docs.example.com", 20],
    ]);
    expect(pm?.byPlace.map((one) => [one.by, one.minutes])).toEqual([
      ["app", 60],
      ["repository", 60],
      ["app", 20],
      ["host", 20],
    ]);
    expect(pm?.byCategory).toEqual([
      { category: "coding", minutes: 60 },
      { category: "research", minutes: 20 },
    ]);
    expect(views.shown).toEqual([blocks.evidence]);
  });

  it("a block day whose work_enc is null counts its clear minutes as pending, neither observed nor cut", () => {
    const day = "2026-10-01";
    const pending = row("block", 0, 0, null, { day, minutes: 45 });
    const views = workTime(inputs({ rows: [pending] }), { view: "day", day });
    expect(views.day?.halfDays[1]?.coverage).toMatchObject({
      observedMinutes: 0,
      pendingMinutes: 45,
      dayCutBlocks: 0,
      through: null,
    });
  });

  it("past WORK_ITEMS the coverage says partial", () => {
    const views = workTime(inputs({ partial: { rows: true, tasks: false } }), { view: "day", day: "2026-10-01" });
    expect(views.day?.halfDays.every((one) => one.coverage.partial)).toBe(true);
    expect(views.day?.deepWork.coverage.partial).toBe(true);
  });

  it("WT13: on the days the zone changes to and from daylight time the windows are 11 and 13 hours", () => {
    const hours = (day: string) => halfDayWindows(day, "America/Chicago").map((one) => (one.to - one.from) / 3_600_000);
    expect(hours("2026-03-08")).toEqual([11, 12]);
    expect(hours("2026-11-01")).toEqual([13, 12]);
    expect(hours("2026-10-01")).toEqual([12, 12]);
  });
});

describe("tasks and the matcher (R52 to R56)", () => {
  const task = (events: [string, number][], extra: Partial<Extract<CaptureWork, { kind: "task" }>> = {}): WorkRow =>
    row("task", events[0]?.[1] ?? 0, events.at(-1)?.[1] ?? 0, {
      kind: "task",
      title: "Ship it",
      events: events.map(([kind, minute]) => ({ kind: kind as "created", at: at(minute) })),
      ...extra,
    });

  it("a reopened task is open; its project links by exact name, not inside a word, not with two of one name, not outside its label", () => {
    const reopened = task(
      [
        ["created", 0],
        ["completed", 10],
        ["reopened", 20],
      ],
      { project: "  ALPHA  " },
    );
    const inWord = task([["created", 0]], { project: "alph" });
    const now = T0 + 30 * MIN;
    const views = (projects: WorkProject[]) =>
      workTime(inputs({ rows: [reopened, inWord], projects, now }), { view: "now" }).now?.openTasks ?? [];
    const open = views([project("alpha", ["own"], "Alpha")]);
    expect(open.map((one) => [one.capture, one.project?.id ?? null, one.reopened, one.completionRecordedAt])).toEqual([
      [reopened.id, "alpha", 1, null],
      [inWord.id, null, 0, null],
    ]);
    expect(views([project("alpha", ["own"], "Alpha"), project("other", ["own"], "alpha")])[0]?.project).toBeNull();
    expect(views([project("alpha", ["employer:example"], "Alpha")])[0]?.project).toBeNull();
  });

  it("completionRecordedAt is the event's time and doneAt only what was stated", () => {
    const done = task([
      ["created", 0],
      ["completed", 90],
    ]);
    const stated = task(
      [
        ["created", 0],
        ["completed", 90],
      ],
      { doneAt: at(60) },
    );
    const views = workTime(inputs({ rows: [done, stated], now: T0 + 100 * MIN }), { view: "now" }).now;
    const completed = views?.changes
      .filter((one) => one.kind === "task_completed")
      .map((one) => [one.task?.capture, one.task?.completionRecordedAt, one.task?.doneAt]);
    expect(completed).toEqual(
      expect.arrayContaining([
        [done.id, at(90), null],
        [stated.id, at(90), at(60)],
      ]),
    );
  });

  it("WT20: the window starts at the latest of the start, fourteen days before and the previous close on the target", () => {
    const DAY = 1440;
    expect(matchWindow({ id: "a", start: T0, close: T0 + 60 * MIN, targets: ["p"] }, [])).toEqual({
      from: T0,
      to: T0 + 60 * MIN,
    });
    expect(matchWindow({ id: "a", start: T0, close: T0 + 20 * DAY * MIN, targets: ["p"] }, [])).toEqual({
      from: T0 + 6 * DAY * MIN,
      to: T0 + 20 * DAY * MIN,
    });
    const previous = { id: "b", start: T0, close: T0 + 30 * MIN, targets: ["p"] };
    expect(matchWindow({ id: "a", start: T0, close: T0 + 60 * MIN, targets: ["p"] }, [previous])).toEqual({
      from: T0 + 30 * MIN,
      to: T0 + 60 * MIN,
    });
    // A task logged after the work it records is bounded by the other two.
    expect(matchWindow({ id: "a", start: T0 + 120 * MIN, close: T0 + 60 * MIN, targets: ["p"] }, [])).toEqual({
      from: T0 + 60 * MIN - 14 * DAY * MIN,
      to: T0 + 60 * MIN,
    });
    expect(matchWindow({ id: "a", start: T0, close: T0 + 60 * MIN, targets: [] }, [])).toBeNull();
    expect(matchWindow({ id: "a", start: T0, close: null, targets: ["p"] }, [])).toBeNull();
  });

  it("two open tasks of one project split the time at the first close, with shared 1; advisory is true; nothing closes", () => {
    const blocks = row(
      "block",
      0,
      0,
      blockWork([
        {
          from: 0,
          to: 120,
          bundle: "test.example.term",
          repository: { value: "forge.example.com/owner/alpha", method: "git_remote" },
        },
      ]),
    );
    const first = task(
      [
        ["created", 0],
        ["completed", 50],
      ],
      { project: "alpha" },
    );
    const second = task(
      [
        ["created", 0],
        ["completed", 120],
      ],
      { project: "alpha" },
    );
    const views = workTime(
      inputs({
        rows: [blocks, first, second],
        anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "alpha" }],
        projects: [project("alpha")],
        now: T0 + 200 * MIN,
      }),
      { view: "project", project: "alpha", days: 30 },
    );
    const byTask = new Map(views.project?.tasks.map((one) => [one.capture, one.workedOn]));
    expect(byTask.get(first.id as never)).toMatchObject({
      rule: "match@1",
      advisory: true,
      minutes: 50,
      shared: 1,
      from: at(0),
      to: at(50),
    });
    expect(byTask.get(second.id as never)).toMatchObject({ minutes: 70, shared: 0, from: at(50), to: at(120) });
  });

  it("only the items a call serves have their windows gathered", () => {
    const DAY = 1440;
    const tasks = Array.from({ length: 30 }, (_, index) =>
      task(
        [
          ["created", -index * 30 * DAY],
          ["completed", -index * 30 * DAY + 60],
        ],
        { project: "alpha" },
      ),
    );
    const windows = workWindows(
      { view: "day", day: "2026-10-01" },
      { rows: tasks, commitments: [], projects: [project("alpha")], zone: null, now: T0 + 600 * MIN },
    );
    expect(windows.every((one) => one.from >= Date.parse("2026-09-17T00:00:00.000Z"))).toBe(true);
  });

  it("WT20: a task with no project gets no match", () => {
    const loose = task([
      ["created", 0],
      ["completed", 10],
    ]);
    expect(
      workTime(inputs({ rows: [loose] }), { view: "day", day: "2026-10-01" }).day?.halfDays[1]?.tasks[0]?.workedOn,
    ).toBeNull();
  });

  it("the windows to gather are the union of each item's, never their hull", () => {
    const DAY = 1440;
    const old = { id: "c1", start: T0 - 200 * DAY * MIN, close: T0 - 199 * DAY * MIN, targets: ["p"] };
    const recent = { id: "c2", start: T0 - 2 * DAY * MIN, close: T0 - 1 * DAY * MIN, targets: ["q"] };
    const windows = workWindows(
      { view: "matches", commitments: ["c1", "c2"] },
      { rows: [], commitments: [old, recent], projects: [], zone: null, now: T0 },
    );
    expect(windows).toEqual([
      { from: old.start, to: old.close },
      { from: recent.start, to: recent.close },
    ]);
  });
});

describe("deep work", () => {
  const day = (spans: Parameters<typeof spanOf>[0][], through: string | null = null) =>
    deepWorkOf("2026-10-01", spans.map(spanOf), coverage(through), (id) => who(id), null);

  it("WT25: meeting, deep and switching minutes are disjoint and sum to the observed minutes", () => {
    const result = day([
      { from: 0, to: 20, project: "a" },
      { from: 20, to: 24, project: "a", meeting: true },
      { from: 24, to: 44, project: "a" },
      { from: 50, to: 60, category: "communication" },
    ]);
    expect(result.sessions.map((one) => [one.minutes, one.interruptions, one.interruptedMinutes])).toEqual([
      [40, 1, 4],
    ]);
    expect([result.meetingMinutes, result.deepMinutes, result.switchingMinutes]).toEqual([4, 40, 10]);
    expect(result.interruptions).toEqual([{ category: "meetings", count: 1, minutes: 4 }]);
  });

  it("switches by key, none into or out of a carried stretch, none after a gap over M; per hour to one decimal; null with nothing observed", () => {
    const loop = day([
      { from: 0, to: 12, project: "a" },
      { from: 12, to: 18, category: "coding" },
      { from: 18, to: 40, project: "a" },
      { from: 40, to: 44, category: "communication" },
      { from: 44, to: 60, category: "research" },
      { from: 70, to: 80, category: "research" },
    ]);
    // a (carried coding) a, then mail, then research: two switches; the research after ten idle minutes is a start.
    expect(loop.switches).toBe(2);
    expect(loop.switchesPerHour).toBe(r1(2 / (70 / 60)));
    expect(day([]).switchesPerHour).toBeNull();
  });

  it("two apps of one category make no switch: they are one key", () => {
    const result = day([
      { from: 0, to: 10, category: "coding" },
      { from: 10, to: 20, category: "coding" },
    ]);
    expect(result.switches).toBe(0);
  });

  it("eleven sessions serve ten with more, and the totals of all eleven", () => {
    const spans = Array.from({ length: 11 }, (_, index) => ({
      from: index * 45,
      to: index * 45 + 30 + index,
      project: `p${index}`,
    }));
    const result = day(spans);
    expect(result.sessions).toHaveLength(DEEP_SESSIONS);
    expect(result.more).toBe(true);
    expect(result.deepMinutes).toBe(spans.reduce((total, one) => total + (one.to - one.from), 0));
  });

  it("a run from 23:40 to 00:20 gives two days' runs, neither a session", () => {
    const late = Date.parse("2026-10-01T23:40:00.000Z");
    const span: SubSpan = { ...spanOf({ from: 0, to: 40, project: "a" }), from: late, to: late + 40 * MIN };
    expect(deepWorkOf("2026-10-01", [span], coverage(), (id) => who(id), null).sessions).toEqual([]);
    expect(deepWorkOf("2026-10-02", [span], coverage(), (id) => who(id), null).sessions).toEqual([]);
    expect(deepWorkOf("2026-10-01", [span], coverage(), (id) => who(id), null).deepMinutes).toBe(0);
  });

  it("complete only when the day's blocks reach its end; through null is incomplete", () => {
    expect(day([], null).complete).toBe(false);
    expect(day([], "2026-10-01T12:00:00.000Z").complete).toBe(false);
    expect(day([], "2026-10-01T23:55:00.000Z").complete).toBe(true);
  });

  it("time per project, sessions and half-days are the same whether or not the day's deep work is computed", () => {
    const blocks = row(
      "block",
      0,
      0,
      blockWork([
        {
          from: 0,
          to: 40,
          bundle: "test.example.term",
          repository: { value: "forge.example.com/owner/alpha", method: "git_remote" },
        },
      ]),
      { day: "2026-10-01" },
    );
    const base = inputs({
      rows: [blocks],
      anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "alpha" }],
      projects: [project("alpha")],
    });
    const viewed = workTime(base, { view: "day", day: "2026-10-01" });
    expect(viewed.day?.deepWork.deepMinutes).toBe(40);
    expect(viewed.day?.halfDays[1]?.coverage.creditedMinutes).toBe(40);
    expect(workTime(base, { view: "project", project: "alpha", days: 30 }).project?.time.last30).toBe(40);
  });
});

describe("get_self's work", () => {
  it("current comes from a moment within thirty minutes, and none past it", () => {
    const moment = row("moment", 0, 10, { kind: "moment", bundle: "test.example.chat", thread: "Team", lines: 2 });
    const near = workTime(inputs({ rows: [moment], now: T0 + 30 * MIN }), { view: "now" }).now;
    expect(near?.current?.target).toEqual({
      where: { kind: "app", value: { untrusted: "test.example.chat" }, strength: "strong" },
    });
    expect(workTime(inputs({ rows: [moment], now: T0 + 41 * MIN }), { view: "now" }).now?.current).toBeNull();
  });

  it("holds two half-days, newest first, and today's and yesterday's deep work", () => {
    const now = Date.parse("2026-10-02T15:00:00.000Z");
    const view = workTime(inputs({ now }), { view: "now" }).now;
    expect(view?.halfDays.map((one) => one.from)).toEqual(["2026-10-02T12:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect(view?.deepWork.map((one) => one.day)).toEqual(["2026-10-02", "2026-10-01"]);
  });

  it("a maximal view is cut in R60's order to fit its bound, totals kept", () => {
    const long = "x".repeat(250);
    const where = { kind: "document" as const, value: { untrusted: long }, strength: "strong" as const };
    const session = { target: { where }, start: at(0), end: at(10), minutes: 10, top: where, basis: "none" as const };
    const half = {
      from: at(0),
      to: at(1),
      coverage: coverage(),
      targets: Array.from({ length: 10 }, () => ({ target: { where }, minutes: 1 })),
      byPlace: Array.from({ length: 30 }, () => ({ by: "document" as const, value: { untrusted: long }, minutes: 1 })),
      byCategory: [],
      sessions: Array.from({ length: 20 }, () => session),
      meetings: [],
      threads: [],
      tasks: [],
      more: false,
    };
    const view = {
      asOf: at(0),
      current: null,
      focus: [],
      halfDays: [half, half],
      deepWork: [],
      changes: [],
      openTasks: [],
      more: false,
    };
    const fitted = fitWorkNow(view);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length / 4).toBeLessThanOrEqual(WORK_NOW_TOKENS);
    expect(fitted.more).toBe(true);
    expect(fitted.halfDays[1]?.byPlace).toEqual([]);
    expect(fitted.halfDays[0]?.coverage).toEqual(half.coverage);
  });
});

describe("WT26: history pages and how far Lens saw the day", () => {
  const day = "2026-10-01";
  // A block from 14:00 to 15:00 UTC; the day's afternoon window is 12:00 to 24:00 UTC.
  const withSeen = (coveredThrough: string | undefined, extra: Partial<WorkRow> = {}) => {
    const work = blockWork([
      { from: 0, to: 60, bundle: "test.example.web", host: "docs.example.com", category: "research" },
    ]);
    return row(
      "block",
      0,
      60,
      work.kind === "block" ? { ...work, ...(coveredThrough === undefined ? {} : { coveredThrough }) } : work,
      { day, ...extra },
    );
  };
  const pm = (rows: WorkRow[]) => workTime(inputs({ rows }), { view: "day", day }).day?.halfDays[1];

  it("a day Lens watched to its end is complete; through capped at the window's end", () => {
    const seen = pm([withSeen(at(599))]);
    expect(seen?.coverage.through).toBe(at(599));
    const late = pm([withSeen(new Date(T0 + 700 * MIN).toISOString())]);
    expect(late?.coverage.through).toBe(at(600));
    const views = workTime(inputs({ rows: [withSeen(at(599))] }), { view: "day", day });
    expect(views.day?.deepWork.complete).toBe(true);
  });

  it("without coveredThrough the block-end rule stands, and the day is incomplete", () => {
    expect(pm([withSeen(undefined)])?.coverage.through).toBe(at(60));
    expect(workTime(inputs({ rows: [withSeen(undefined)] }), { view: "day", day }).day?.deepWork.complete).toBe(false);
  });

  it("a coveredThrough before the window's start, or a next day's, never completes the window", () => {
    // The morning window, 00:00 to 12:00 UTC: this row's blocks start at 14:00, after its end.
    const am = workTime(inputs({ rows: [withSeen(at(599))] }), { view: "day", day }).day?.halfDays[0];
    expect(am?.coverage.through).toBeNull();
    // The day after: its first block starts after this window's end.
    const tomorrow = row(
      "block",
      1440,
      1500,
      { kind: "block", blocks: [], cut: { blocks: 0, minutes: 0 }, coveredThrough: at(1900) },
      { day: "2026-10-02" },
    );
    expect(pm([withSeen(undefined), tomorrow])?.coverage.through).toBe(at(60));
  });

  it("a half-day lists its visible pages by visits, summed per URL and query, at most 10 with more", () => {
    const page = (n: number, count: number, query?: string) => ({
      url: `https://docs.example.com/p/${n}`,
      title: `Page ${n}`,
      firstAt: at(5),
      lastAt: at(10 + n),
      count,
      ...(query === undefined ? {} : { query }),
    });
    const work = blockWork([{ from: 0, to: 60, bundle: "test.example.web", host: "docs.example.com" }]);
    if (work.kind !== "block") throw new Error("a block");
    const pages = [...Array.from({ length: 11 }, (_, n) => page(n, n + 1)), page(0, 5, "alpha budget")];
    const one = row("block", 0, 60, { ...work, blocks: work.blocks.map((block) => ({ ...block, pages })) }, { day });
    const again = row(
      "block",
      0,
      60,
      { ...work, blocks: work.blocks.map((block) => ({ ...block, pages: [page(0, 30)] })) },
      { day },
    );
    const half = pm([one, again]);
    expect(half?.pages?.length).toBe(10);
    expect(half?.pages?.[0]).toEqual({
      url: { untrusted: "https://docs.example.com/p/0" },
      title: { untrusted: "Page 0" },
      query: null,
      visits: 31,
    });
    expect(half?.pages?.some((entry) => entry.query?.untrusted === "alpha budget")).toBe(true);
    expect(half?.more).toBe(true);
    expect(pm([withSeen(undefined)])?.pages).toBeUndefined();
    // A page outside the window lists nothing there: the morning has no pages field.
    expect(workTime(inputs({ rows: [one] }), { view: "day", day }).day?.halfDays[0]?.pages).toBeUndefined();
  });

  it("fitWorkNow empties a half-day's pages first", () => {
    const views = workTime(inputs({ rows: [withSeen(at(599))] }), { view: "now" });
    const now = views.now;
    if (now === undefined) throw new Error("a view");
    const big = structuredClone(now);
    const half = big.halfDays[1] ?? big.halfDays[0];
    if (half === undefined) throw new Error("a half-day");
    half.pages = Array.from({ length: 10 }, (_, n) => ({
      url: { untrusted: `https://docs.example.com/${"x".repeat(1500)}/${n}` },
      title: null,
      query: null,
      visits: 1,
    }));
    const fitted = fitWorkNow(big);
    expect((fitted.halfDays[1] ?? fitted.halfDays[0])?.pages).toEqual([]);
  });
});

describe("captureWorkOf seals coveredThrough to the minute, never before the split's last block end, and keeps pages", () => {
  const item = (coveredThrough: string | undefined): BlockItem => ({
    kind: "block",
    key: `block:${ULID(1)}`,
    revision: 0,
    day: "2026-10-01",
    blocks: [
      {
        start: "2026-10-01T09:00:00-05:00",
        end: "2026-10-01T09:30:20-05:00",
        minutes: 30,
        app: { bundle: "test.example.web", name: "Web" },
        host: "docs.example.com",
        pages: [
          {
            url: "https://docs.example.com/a",
            title: "Alpha",
            firstAt: "2026-10-01T09:01:00-05:00",
            lastAt: "2026-10-01T09:02:00-05:00",
            count: 2,
          },
        ],
      },
    ],
    ...(coveredThrough === undefined ? {} : { coveredThrough }),
  });
  const sealed = (coveredThrough: string | undefined) => captureWorkOf(item(coveredThrough), { table: null }).work;

  it("truncates to the minute, keeping the Mac's offset", () => {
    const work = sealed("2026-10-01T23:59:42.123-05:00");
    expect(work.kind === "block" ? work.coveredThrough : null).toBe("2026-10-01T23:59:00-05:00");
  });
  it("is never before the split's own last block end", () => {
    const work = sealed("2026-10-01T09:30:40-05:00");
    expect(work.kind === "block" ? work.coveredThrough : null).toBe("2026-10-01T09:30:20-05:00");
  });
  it("is absent when Lens sent none, and the pages are kept", () => {
    const work = sealed(undefined);
    expect(work.kind === "block" ? work.coveredThrough : "x").toBeUndefined();
    expect(work.kind === "block" ? work.blocks[0]?.pages?.[0]?.title : null).toBe("Alpha");
  });
});

describe("window title anchors", () => {
  // A stand-in for the store's keyed fingerprint: 64 hex digits per key, the key never in it.
  const fp = (key: string): string => {
    let hash = 0x811c9dc5;
    for (const char of key) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
    return hash.toString(16).padStart(8, "0").repeat(8);
  };
  // And of a title's name fingerprints (the store's titleFpsMemo), one per title here.
  const SEAL = { fp, names: (title: string) => [fp(`name:${title}`)] };
  const titleAnchor = (title: string, projectId: string) => ({
    key: `title:${fp(`title:${title}`)}`,
    project: projectId,
  });
  const sealedTitles = (title: string, app = "Writer"): string[] => {
    const item: BlockItem = {
      kind: "block",
      key: `block:${ULID(90)}`,
      revision: 0,
      day: "2026-10-01",
      blocks: [{ start: at(0), end: at(30), minutes: 30, app: { bundle: "test.example.writer", name: app }, title }],
    };
    const work = captureWorkOf(item, { table: null, titles: SEAL }).work;
    return work.kind === "block" ? (work.blocks[0]?.titleFps ?? []) : [];
  };
  const titled = (
    from: number,
    to: number,
    title: string,
    extra: { bundle?: string; repository?: { value: string; method: "git_remote" } } = {},
  ) => {
    const work = blockWork([
      {
        from,
        to,
        bundle: extra.bundle ?? "test.example.writer",
        ...(extra.repository === undefined ? {} : { repository: extra.repository }),
      },
    ]);
    if (work.kind === "block" && work.blocks[0] !== undefined) {
      const fps = sealedTitles(title);
      if (fps.length > 0) work.blocks[0].titleFps = fps;
    }
    return row("block", 0, 0, work);
  };
  const chat = (from: number, to: number, thread: string | null, bundle = "test.example.chat"): WorkRow => {
    const work = captureWorkOf({ kind: "moment", text: "hello", app: { bundle, name: "Chat" } } as MomentItem, {
      table: null,
      facts: { bundle, thread },
      titles: SEAL,
    }).work;
    return row("moment", from, to, work);
  };
  const credit = (spans: SubSpan[]) =>
    spans.map((one) => [(one.from - T0) / MIN, (one.to - T0) / MIN, r1(one.minutes), one.project, one.basis]);

  it("the drain seals a title's fingerprints and never the title; without the store's key nothing is sealed", () => {
    const fps = sealedTitles("Alpha Plan — draft");
    expect(fps).toEqual(["title:alpha", "title:alpha plan", "title:alpha plan — draft"].map(fp));
    const item: BlockItem = {
      kind: "block",
      key: `block:${ULID(91)}`,
      revision: 0,
      day: "2026-10-01",
      blocks: [
        {
          start: at(0),
          end: at(30),
          minutes: 30,
          app: { bundle: "test.example.writer", name: "Writer" },
          title: "Canary Plan secret",
        },
      ],
    };
    const sealed = JSON.stringify(captureWorkOf(item, { table: null, titles: SEAL }).work);
    expect(sealed).not.toMatch(/canary|Canary|secret/);
    const work = captureWorkOf(item, { table: null }).work;
    expect(work.kind === "block" && "titleFps" in (work.blocks[0] ?? {})).toBe(false);
    // A window showing only its app's name, or a generic title, seals nothing.
    expect(sealedTitles("Writer")).toEqual([]);
    expect(sealedTitles("New Tab")).toEqual([]);
    // A title `titleKept` refuses (one naming an erased person) seals nothing.
    const refused = captureWorkOf(item, {
      table: null,
      titles: { ...SEAL, kept: (title) => !title.includes("Canary") },
    }).work;
    expect(refused.kind === "block" && "titleFps" in (refused.blocks[0] ?? {})).toBe(false);
    // A title's name fingerprints are sealed once a day, at each block's
    // titleAt, so the erasure needs no blob; a block with no title has neither.
    const twice: BlockItem = {
      ...item,
      blocks: [
        item.blocks[0],
        { ...item.blocks[0], start: at(30), end: at(40), minutes: 10 },
        { ...item.blocks[0], start: at(40), end: at(50), minutes: 10, title: "Writer" },
        { ...item.blocks[0], start: at(50), end: at(60), minutes: 10, title: "Heron notes" },
      ],
    } as BlockItem;
    const day = captureWorkOf(twice, { table: null, titles: SEAL }).work;
    expect(day.kind === "block" && CaptureWork.safeParse(day).success).toBe(true);
    expect(day.kind === "block" ? [day.blocks.map((one) => one.titleAt), day.titles] : null).toEqual([
      [0, 0, undefined, 1],
      [[fp("name:Canary Plan secret")], [fp("name:Heron notes")]],
    ]);
    // A moment's thread title is sealed the same way; its null thread seals none.
    const moment = chat(0, 5, "harbor rota");
    expect(moment.work).toEqual({
      kind: "moment",
      bundle: "test.example.chat",
      thread: "harbor rota",
      lines: 1,
      threadFps: [fp("title:harbor"), fp("title:harbor rota")],
    });
    expect(chat(0, 5, null).work).toEqual({ kind: "moment", bundle: "test.example.chat", thread: null, lines: 1 });
    expect(chat(0, 5, "Claude").work).toEqual({
      kind: "moment",
      bundle: "test.example.chat",
      thread: "Claude",
      lines: 1,
    });
  });

  it("a title with more name fingerprints than TITLE_NAMES_MOST seals none, and the day still parses", () => {
    const many = {
      fp,
      names: (title: string) =>
        title.startsWith("Many")
          ? Array.from({ length: TITLE_NAMES_MOST + 1 }, (_, n) => fp(`name:${n}`))
          : [fp(`name:${title}`)],
    };
    const block = {
      start: at(0),
      end: at(30),
      minutes: 30,
      app: { bundle: "test.example.writer", name: "Writer" },
      title: "Many words here",
    };
    const item: BlockItem = {
      kind: "block",
      key: `block:${ULID(92)}`,
      revision: 0,
      day: "2026-10-01",
      blocks: [block, { ...block, start: at(30), end: at(40), minutes: 10, title: "Heron notes" }],
    };
    const day = captureWorkOf(item, { table: null, titles: many }).work;
    expect(CaptureWork.safeParse(day).success).toBe(true);
    expect(
      day.kind === "block" ? [day.blocks.map((one) => [one.titleFps === undefined, one.titleAt]), day.titles] : null,
    ).toEqual([
      [
        [true, undefined],
        [false, 0],
      ],
      [[fp("name:Heron notes")]],
    ]);
  });

  it("a block whose title meets one project's title anchor is credited to it, exactly or at a word's end, never inside a word", () => {
    const anchors = [titleAnchor("alpha plan", "alpha")];
    const projects = [project("alpha")];
    expect(
      credit(creditIntervals({ rows: [titled(0, 30, "Alpha  Plan - v2")], links: [], anchors, projects })),
    ).toEqual([[0, 30, 30, "alpha", "title"]]);
    expect(credit(creditIntervals({ rows: [titled(0, 30, "Alpha Planning")], links: [], anchors, projects }))).toEqual([
      [0, 30, 30, null, "none"],
    ]);
    expect(credit(creditIntervals({ rows: [titled(0, 30, "The Alpha Plan")], links: [], anchors, projects }))).toEqual([
      [0, 30, 30, null, "none"],
    ]);
  });

  it("precedence: a meeting's link, a strong device anchor and a linked moment come first; a title anchor comes before none", () => {
    const alpha = { value: "forge.example.com/owner/alpha", method: "git_remote" as const };
    const projects = [project("alpha"), project("beta"), project("gamma")];
    const anchors = [
      { key: "repository:forge.example.com/owner/alpha", project: "alpha" },
      titleAnchor("beta notes", "beta"),
    ];
    // Strong key beats the title.
    expect(
      credit(
        creditIntervals({ rows: [titled(0, 30, "Beta notes", { repository: alpha })], links: [], anchors, projects }),
      ),
    ).toEqual([[0, 30, 30, "alpha", "anchor"]]);
    // A linked meeting beats the title where it covers.
    const meeting = row("meeting", 0, 10, null);
    expect(
      credit(
        creditIntervals({
          rows: [titled(0, 30, "Beta notes"), meeting],
          links: [{ capture: meeting.id, project: "gamma" }],
          anchors,
          projects,
        }),
      ),
    ).toEqual([
      [0, 10, 10, "gamma", "meeting"],
      [10, 30, 20, "beta", "title"],
    ]);
    // A linked moment of the same app, the owner's link of one
    // item, beats the title's prefix rule where it covers (invariant 11); the title decides the rest.
    const moment = row("moment", 0, 10, { kind: "moment", bundle: "test.example.writer", thread: null, lines: 1 });
    expect(
      credit(
        creditIntervals({
          rows: [titled(0, 30, "Beta notes"), moment],
          links: [{ capture: moment.id, project: "gamma" }],
          anchors,
          projects,
        }),
      ),
    ).toEqual([
      [0, 10, 10, "gamma", "moment"],
      [10, 30, 20, "beta", "title"],
    ]);
    // So does a linked moment whose own thread title meets another project's anchor.
    const linkedChat = chat(0, 30, "Beta notes", "test.example.writer");
    expect(
      credit(
        creditIntervals({
          rows: [titled(0, 30, "Beta notes"), linkedChat],
          links: [{ capture: linkedChat.id, project: "gamma" }],
          anchors,
          projects,
        }),
      ),
    ).toEqual([[0, 30, 30, "gamma", "moment"]]);
  });

  it("an anchor a word-boundary prefix of another project's leaves the longer one's titles to it", () => {
    const projects = [project("alpha"), project("beta")];
    const anchors = [titleAnchor("alpha", "alpha"), titleAnchor("alpha plan", "beta")];
    expect(
      credit(creditIntervals({ rows: [titled(0, 30, "Alpha plan \u2014 draft")], links: [], anchors, projects })),
    ).toEqual([[0, 30, 30, "beta", "title"]]);
    expect(credit(creditIntervals({ rows: [titled(0, 30, "Alpha notes")], links: [], anchors, projects }))).toEqual([
      [0, 30, 30, "alpha", "title"],
    ]);
  });

  it("ambiguity: the block's title and a covering moment's meeting two projects credit none at that step, and the next step decides", () => {
    const projects = [project("alpha"), project("beta"), project("gamma")];
    const anchors = [titleAnchor("alpha notes", "alpha"), titleAnchor("beta plan", "beta")];
    const moment = chat(0, 30, "Beta plan", "test.example.writer");
    expect(
      credit(creditIntervals({ rows: [titled(0, 30, "Alpha notes"), moment], links: [], anchors, projects })),
    ).toEqual([[0, 30, 30, null, "none"]]);
    expect(
      credit(
        creditIntervals({
          rows: [titled(0, 30, "Alpha notes"), moment],
          links: [{ capture: moment.id, project: "gamma" }],
          anchors,
          projects,
        }),
      ),
    ).toEqual([[0, 30, 30, "gamma", "moment"]]);
  });

  it("a moment wider than its block, an agent app's, credits its own span for a caller the token returned it to", () => {
    const block = row("block", 0, 0, blockWork([{ from: 0, to: 30, bundle: "test.example.chat" }]));
    const wider = row(
      "moment",
      10,
      20,
      { kind: "moment", bundle: "test.example.chat", thread: null, lines: 3 },
      {
        compartments: ["own", "agent:test"],
      },
    );
    const links = [{ capture: wider.id, project: "alpha" }];
    const projects = [project("alpha")];
    expect(credit(creditIntervals({ rows: [block, wider], links, anchors: [], projects }))).toEqual([
      [0, 10, 10, null, "none"],
      [10, 30, 20, "alpha", "moment"],
    ]);
    // A caller not cleared for the moment's label has no such row: the block is as if it never was.
    expect(credit(creditIntervals({ rows: [block], links: [], anchors: [], projects }))).toEqual([
      [0, 30, 30, null, "none"],
    ]);
    // A project wider than the block stays out, however wide the moment.
    expect(
      credit(
        creditIntervals({
          rows: [block, wider],
          links,
          anchors: [],
          projects: [project("alpha", ["own", "agent:test"])],
        }),
      ),
    ).toEqual([[0, 30, 30, null, "none"]]);
  });

  it("lines past the blocks are said beside the minutes, and none are said once the blocks reach them", () => {
    const day = "2026-10-01";
    const moment = (from: number, to: number, lines: number) =>
      row("moment", from, to, { kind: "moment", bundle: "test.example.chat", thread: "Team", lines });
    const before = { ...blockWork([{ from: 0, to: 30, bundle: "test.example.chat" }]), coveredThrough: at(30) };
    const blocks = (work: CaptureWork) => row("block", 0, 30, work, { minutes: 30, day });
    const halfOf = (rows: WorkRow[]) => {
      const views = workTime(inputs({ rows }), { view: "day", day });
      return views.day?.halfDays.find((half) => half.threads.length > 0 || half.coverage.observedMinutes > 0);
    };
    const late = [moment(60, 70, 300), moment(90, 91, 179), moment(100, 200, 0), moment(30, 31, 5)];
    expect(halfOf([blocks(before), ...late])?.coverage.linesPast).toMatchObject({ lines: 479, until: at(91) });
    expect(halfOf([blocks(before), ...late])?.coverage.linesPast?.note).toContain("Lines do not measure time");
    const reached = { ...blockWork([{ from: 0, to: 120, bundle: "test.example.chat" }]), coveredThrough: at(120) };
    expect(halfOf([blocks(reached), ...late])?.coverage.linesPast).toBeUndefined();
    // With no block at all, every line of the window is past them.
    expect(halfOf(late)?.coverage).toMatchObject({ through: null, observedMinutes: 0, linesPast: { lines: 484 } });
  });

  it("compartments: a title anchor of a project outside the block's label credits nothing, and a moment outside it lends no title", () => {
    const anchors = [titleAnchor("alpha plan", "work")];
    expect(
      credit(
        creditIntervals({
          rows: [titled(0, 30, "Alpha plan")],
          links: [],
          anchors,
          projects: [project("work", ["employer:example"])],
        }),
      ),
    ).toEqual([[0, 30, 30, null, "none"]]);
    const block = row("block", 0, 0, blockWork([{ from: 0, to: 30, bundle: "test.example.chat" }]));
    const outside = { ...chat(0, 30, "Alpha plan"), compartments: ["employer:example"] };
    expect(
      credit(
        creditIntervals({
          rows: [block, outside],
          links: [],
          anchors: [titleAnchor("alpha plan", "alpha")],
          projects: [project("alpha")],
        }),
      ),
    ).toEqual([[0, 30, 30, null, "none"]]);
  });

  it("an app window titled only with the app's name: the same-app moments' thread titles credit their spans, each held until the app's next moment or 10 minutes", () => {
    // A chat app's block (its window titled "Chat", sealing nothing) and two of its threads.
    const block = row("block", 0, 0, blockWork([{ from: 0, to: 60, bundle: "test.example.chat" }]));
    const projects = [project("rota"), project("lantern")];
    const anchors = [titleAnchor("harbor rota", "rota"), titleAnchor("lantern survey", "lantern")];
    // The rota thread holds until the lantern thread's moment at 25; the lantern thread holds 10
    // minutes past its end, since another app's moment cuts nothing; then none.
    const rows = [
      block,
      chat(5, 20, "harbor rota"),
      chat(25, 45, "Lantern Survey"),
      chat(45, 50, "Lantern Survey", "test.example.other"),
    ];
    expect(credit(creditIntervals({ rows, links: [], anchors, projects }))).toEqual([
      [0, 5, 5, null, "none"],
      [5, 25, 20, "rota", "title"],
      [25, 55, 30, "lantern", "title"],
      [55, 60, 5, null, "none"],
    ]);
    // A newer thread still on screen when an older one ends takes the window: the older holds nothing.
    const newer = [block, chat(0, 20, "harbor rota"), chat(15, 25, "Lantern Survey")];
    expect(credit(creditIntervals({ rows: newer, links: [], anchors, projects }))).toEqual([
      [0, 15, 15, "rota", "title"],
      [15, 20, 5, null, "none"],
      [20, 35, 15, "lantern", "title"],
      [35, 60, 25, null, "none"],
    ]);
    // A moment of no length holds nothing.
    expect(
      credit(creditIntervals({ rows: [block, chat(30, 30, "harbor rota")], links: [], anchors, projects })),
    ).toEqual([[0, 60, 60, null, "none"]]);
    // A moment step 4 may not read under the block's label cuts no hold.
    const other = { ...chat(22, 23, null), compartments: ["employer:example"] };
    expect(
      credit(creditIntervals({ rows: [block, chat(5, 20, "harbor rota"), other], links: [], anchors, projects })),
    ).toEqual([
      [0, 5, 5, null, "none"],
      [5, 30, 25, "rota", "title"],
      [30, 60, 30, null, "none"],
    ]);
    // A thread held past its moment never outranks a moment on screen, nor an owner's ruling.
    const ruled = {
      from: T0 + 20 * MIN,
      to: T0 + 25 * MIN,
      project: null,
      source: "owner",
      compartments: ["own"],
    } as const;
    expect(credit(creditIntervals({ rows, links: [], anchors, projects, rulings: [ruled] }))).toEqual([
      [0, 5, 5, null, "none"],
      [5, 20, 15, "rota", "title"],
      [20, 25, 5, null, "ruling"],
      [25, 55, 30, "lantern", "title"],
      [55, 60, 5, null, "none"],
    ]);
    // Two threads of two projects over one stretch credit none there.
    const both = [block, chat(0, 60, "harbor rota"), chat(10, 20, "Lantern Survey")];
    expect(credit(creditIntervals({ rows: both, links: [], anchors, projects }))).toEqual([
      [0, 10, 10, "rota", "title"],
      [10, 20, 10, null, "none"],
      [20, 60, 40, "rota", "title"],
    ]);
  });

  it("a title's credit has basis title, and a session of it too, never anchor", () => {
    const anchors = [titleAnchor("alpha plan", "alpha")];
    const spans = creditIntervals({
      rows: [titled(0, 30, "Alpha plan")],
      links: [],
      anchors,
      projects: [project("alpha")],
    });
    expect(sessionsOf(spans).map((one) => one.basis)).toEqual(["title"]);
  });

  it("with no window title anchor, every credit is what it was", () => {
    const block = titled(0, 30, "Alpha plan");
    const plain = {
      ...block,
      work:
        block.work?.kind === "block"
          ? { ...block.work, blocks: block.work.blocks.map(({ titleFps: _fps, ...rest }) => rest) }
          : null,
    };
    const anchors = [{ key: "repository:forge.example.com/owner/alpha", project: "alpha" }];
    expect(
      creditIntervals({
        rows: [block, chat(0, 10, "Alpha plan", "test.example.writer")],
        links: [],
        anchors,
        projects: [project("alpha")],
      }),
    ).toEqual(
      creditIntervals({
        rows: [plain, { ...chat(0, 10, null, "test.example.writer") }],
        links: [],
        anchors,
        projects: [project("alpha")],
      }).map((one) => ({ ...one, row: block.id })),
    );
  });
});

describe("the week", () => {
  // Day one (T0 is its 14:00 UTC): an hour of coding no project is credited, then a meeting linked
  // to beta. Day two: half an hour of research. Day eight, outside the week: an hour that must not
  // count.
  const DAY = 24 * 60;
  const blocks = row("block", 0, 0, blockWork([{ from: 0, to: 60, bundle: "test.example.term" }]));
  const meeting = row("meeting", 120, 150, null);
  const second = row(
    "block",
    DAY,
    DAY,
    blockWork([{ from: DAY, to: DAY + 30, bundle: "test.example.web", category: "research" }]),
  );
  const later = row(
    "block",
    7 * DAY,
    7 * DAY,
    blockWork([{ from: 7 * DAY, to: 7 * DAY + 60, bundle: "test.example.term" }]),
  );
  const week = inputs({
    rows: [blocks, meeting, second, later],
    links: [{ capture: meeting.id, project: "beta" }],
    projects: [project("beta")],
    now: T0 + 8 * DAY * MIN,
  });

  it("counts a week's minutes by day, project and kind, the minutes no project was credited shown as such", () => {
    const view = workTime(week, { view: "week", weekStart: "2026-10-01" }).week;
    expect(view?.days.map((one) => [one.date, one.minutes])).toEqual([
      ["2026-10-01", 90],
      ["2026-10-02", 30],
      ["2026-10-03", 0],
      ["2026-10-04", 0],
      ["2026-10-05", 0],
      ["2026-10-06", 0],
      ["2026-10-07", 0],
    ]);
    expect(view?.byProject).toEqual([{ project: "beta", name: { untrusted: "beta" }, minutes: 30 }]);
    // Each day's credited minutes by project, so the day's bar splits by them: beta's meeting on day one.
    expect(view?.days.map((one) => one.byProject)).toEqual([
      [{ project: "beta", minutes: 30 }],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(view?.byKind).toEqual([
      { kind: "coding", minutes: 60 },
      { kind: "meetings", minutes: 30 },
      { kind: "research", minutes: 30 },
    ]);
    expect(view?.unattributed).toBe(90);
  });

  it("gives each day the deep minutes and longest deep session of that day's own view", () => {
    const view = workTime(week, { view: "week", weekStart: "2026-10-01" }).week;
    for (const day of view?.days ?? []) {
      const deep = workTime(week, { view: "day", day: day.date }).day?.deepWork;
      expect([day.date, day.deepMinutes, day.longestSessionMinutes]).toEqual([
        day.date,
        deep?.deepMinutes,
        deep?.sessions[0]?.minutes ?? 0,
      ]);
    }
    expect(view?.days[0]?.longestSessionMinutes).toBeGreaterThan(0);
  });

  it("gathers the week's window alone", () => {
    expect(workWindows({ view: "week", weekStart: "2026-10-01" }, week)).toEqual([
      { from: Date.parse("2026-10-01T00:00:00.000Z"), to: Date.parse("2026-10-08T00:00:00.000Z") },
    ]);
  });
});
