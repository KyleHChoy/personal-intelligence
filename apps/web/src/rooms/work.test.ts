// @vitest-environment jsdom

import {
  AgentActivity,
  AgentLongWork,
  AgentSettlements,
  DreamSampleView,
  GoalWork,
  OwnerCommitments,
  OwnerGoals,
  OwnerIdeas,
  OwnerProjects,
  OwnerResults,
  TimeWeek,
} from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it } from "vitest";
import { roomHarness } from "../test-support/room-harness.ts";
import { mondayOf } from "../today-time.tsx";
import { Work } from "./work.tsx";
import { dayHours, weekStart } from "./work-time.tsx";

// The Work room on small fixtures, parsed by the contracts' shapes: each view's rows, that a row
// opens in place to one body with its action bar last, that chips are verbs only, and that an
// agent's words render as text.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-11-04T15:00:00Z");
const MARKUP = '<img src=x onerror="alert(1)">';
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const GOAL = `gol_${ulid(10)}`;
const PROJECT = `ent_${ulid(50)}`;

const item = (n: number, over: Record<string, unknown> = {}) => ({
  opportunity: `opp_${ulid(n)}`,
  kind: "research",
  task: false,
  status: "claimed",
  role: "researcher",
  holder: "wren",
  move: { id: `mov_${ulid(n)}`, stage: "investigate", status: null, at: "2026-11-03T09:00:00Z" },
  outcome: null,
  summary: { untrusted: `Task ${n}` },
  about: { kind: "goal", id: GOAL, name: null },
  ...over,
});
const ACTIVITY = AgentActivity.parse({
  needsYou: { cards: [], handedToYou: [] },
  working: [{ ...item(30, { summary: { untrusted: MARKUP } }), since: "2026-11-04T08:00:00Z" }],
  finished: [{ ...item(31, { status: "done" }), doneAt: "2026-11-03T09:00:00Z", findings: [] }],
  blocked: [{ ...item(33, { task: true, holder: null, status: "go", about: null }), code: "no_agent", reason: null }],
});
const commitment = (n: number, direction: "owed_by_owner" | "owed_to_owner", late: number | null) => ({
  item: {
    belief: {
      fact: hex(n),
      state: hex(n + 100),
      kind: "commitment",
      type: "commitment",
      status: "active",
      disputed: false,
      provenance: "source",
      confirmedAt: "2026-10-01T09:00:00Z",
      reviewAfter: null,
    },
    direction,
    counterparty: { id: `ent_${ulid(n)}`, kind: "person", name: { untrusted: `Person ${n}` }, address: null },
    due: "2026-11-01",
    what: { untrusted: "send the numbers" },
    message: null,
    capture: null,
    segment: null,
  },
  lateDays: late,
  ageDays: 10,
  stale: false,
  ...(direction === "owed_by_owner" ? { verb: "Send", rest: { untrusted: "the numbers" } } : {}),
});
const COMMITMENTS = OwnerCommitments.parse({
  commitments: [commitment(1, "owed_by_owner", 3), commitment(2, "owed_to_owner", null)],
  next: null,
});
const goal = (id: string, words: string, status: string) => ({
  goal: { id, statement: { untrusted: words }, status, setAt: "2026-09-01T09:00:00Z" },
  domain: "career",
  target: null,
  setBy: "owner",
});
const GOALS = OwnerGoals.parse({
  goals: [
    goal(GOAL, "Find a full-time role", "active"),
    goal(`gol_${ulid(12)}`, "Meet ambitious people", "active"),
    goal(`gol_${ulid(11)}`, "Learn to sail", "dropped"),
  ],
});
const project = (id: string, name: string, value: string, area: string | null = null) => ({
  id,
  name: { untrusted: name },
  status: { value, asOf: "2026-11-02T09:00:00Z", by: { kind: "owner" } },
  ownerRole: null,
  goal: null,
  dueAt: null,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-11-02T09:00:00Z",
  createdBy: "owner",
  area,
  work: [],
  changes: [],
  more: false,
});
const PROJECTS = OwnerProjects.parse({
  at: "2026-11-04T09:00:00Z",
  projects: [project(PROJECT, "Atlas", "active", "ventures"), project(`ent_${ulid(51)}`, "Northwind", "blocked")],
  areas: [{ key: "ventures", name: { untrusted: "Ventures" }, retired: false }],
  more: false,
});
const WEEK = TimeWeek.parse({
  days: [0, 1, 2, 3, 4, 5, 6].map((n) => ({
    date: `2026-11-0${n + 2}`,
    minutes: n === 0 ? 360 : 0,
    deepMinutes: 0,
    longestSessionMinutes: 0,
  })),
  byProject: [{ project: PROJECT, name: { untrusted: "Atlas" }, minutes: 360 }],
  byKind: [],
  unattributed: 0,
});
const IDEAS = OwnerIdeas.parse({ at: "2026-11-04T09:00:00Z", filedThisWeek: 0, ideas: [] });

const ok = (body: unknown) => ({ status: 200, body });
const bench = roomHarness(
  NOW,
  () => createElement(Work),
  () => ({
    "/api/agentActivity": ok(ACTIVITY),
    "/api/commitments?state=open&limit=200": ok(COMMITMENTS),
    "/api/goals": ok(GOALS),
    [`/api/goalWork?goal=${GOAL}`]: ok(GoalWork.parse({ work: [item(40)] })),
    "/api/projects": ok(PROJECTS),
    [`/api/timeWeek?weekStart=${mondayOf(NOW)}`]: ok(WEEK),
    "/api/ideas": ok(IDEAS),
    "/api/session": ok({ token: "form-token-1" }),
  }),
);
const show = (view: string) => bench.show(createElement(Work, { view }));
const rowNamed = (words: string): HTMLButtonElement => {
  const row = [...bench.host.querySelectorAll<HTMLButtonElement>("button.row")].find((one) =>
    one.textContent?.includes(words),
  );
  if (row === undefined) throw new Error(`no row ${words}`);
  return row;
};
const open = async (words: string) => {
  await act(async () => rowNamed(words).click());
  await bench.settle();
};
const press = async (label: string) => {
  await act(async () =>
    [...bench.host.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent === label)?.click(),
  );
  await bench.settle();
};
// What each POST sent, by its path, the last one kept.
const sent = (): Record<string, Record<string, unknown>> => {
  const bodies: Record<string, Record<string, unknown>> = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (typeof init.body === "string") bodies[url] = JSON.parse(init.body) as Record<string, unknown>;
    return real(url, init);
  }) as typeof fetch;
  return bodies;
};
const buttons = () =>
  [...bench.host.querySelectorAll<HTMLButtonElement>(".exp .actbar button")].map((one) => one.textContent);
// Chips are verbs only.
const VERBS = new Set([
  "Answer",
  "Choose",
  "Approve",
  "Read",
  "Send",
  "Submit",
  "Write",
  "Reply",
  "Check",
  "Run",
  "Do",
]);
const chipsAreVerbs = () =>
  expect([...bench.host.querySelectorAll(".verb")].every((one) => VERBS.has(one.textContent ?? ""))).toBe(true);

it("lays out agents' work as Working, Finished and Stopped, each row naming its goal, an agent's words as text", async () => {
  await show("agents");
  const heads = [...bench.host.querySelectorAll("h2")].map((one) => one.textContent);
  expect(heads).toEqual(expect.arrayContaining(["Working", "Finished", "Stopped", "Agents and your answers"]));
  expect(bench.host.querySelector("img")).toBeNull();
  expect(rowNamed("Task 31").textContent).toContain("for Find a full-time role");
  expect(rowNamed("Task 33").textContent).toContain("upkeep");
  expect(bench.host.querySelector("[role=dialog], .sheet, .overlay")).toBeNull();
});

it("opens running work in place with Add to it, and the New task box at the top of Working", async () => {
  await show("agents");
  await open("Wren");
  expect(buttons()).toEqual(["Add to it"]);
  expect(bench.host.querySelector(".exp .fold summary")?.textContent).toBe("How Wren got here");
  await act(async () =>
    [...bench.host.querySelectorAll<HTMLButtonElement>(".end button, button")]
      .find((one) => one.textContent === "New task")
      ?.click(),
  );
  expect(bench.host.querySelector("textarea")).not.toBeNull();
});

it("opens stopped work to Give it to another agent, with Let it go quiet at the right", async () => {
  await show("agents");
  await open("Task 33");
  expect(buttons()).toEqual(["Give it to another agent", "Let it go"]);
  expect(bench.host.querySelector(".exp .actbar .lnk")?.textContent).toBe("Let it go");
});

it("leads what is owed with its verb, late in amber, and opens it to Mark done, help and Let it go", async () => {
  await show("owed");
  chipsAreVerbs();
  const row = rowNamed("the numbers");
  expect(row.querySelector(".verb")?.textContent).toBe("Send");
  expect(row.querySelector(".meta.warn")).not.toBeNull();
  await open("the numbers");
  expect(buttons()).toEqual(["Mark done", "Ask an agent to help", "Let it go", "Cancelled"]);
  bench.answers["/api/closeCommitment"] = ok({});
  await act(async () => [...bench.host.querySelectorAll<HTMLButtonElement>(".exp .actbar button")][0]?.click());
  await bench.settle();
  expect(bench.calls).toContain("POST /api/closeCommitment");
  expect(rowNamed("Person 2").textContent).toContain("send the numbers");
});

it("opens a goal to the work toward it and Edit, Mark done and a quiet Remove; done and dropped expand in place", async () => {
  await show("goals");
  await open("Find a full-time role");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Work toward it");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Task 40");
  // The first of its part of life moves only down, quietly, before Remove.
  expect(buttons()).toEqual(["Ask an agent for the next step", "Edit", "Mark done", "Pause", "Move down", "Remove"]);
  bench.answers["/api/rankGoal"] = ok({});
  await press("Move down");
  await bench.settle();
  expect(bench.calls).toContain("POST /api/rankGoal");
  expect(bench.host.textContent).not.toContain("Learn to sail");
  await act(async () => bench.host.querySelector<HTMLButtonElement>(".more")?.click());
  expect(bench.host.textContent).toContain("Learn to sail");
});

it("shows a project's hours, its standing only when held up and in amber, and offers an agent to unblock it", async () => {
  await show("projects");
  // In the owner's area order, each with its area after its name; terminal-only actions folded at the foot.
  expect(rowNamed("Atlas").querySelector(".t")?.textContent).toBe("Atlas · Ventures");
  expect(bench.host.querySelector(".fold .cmdline")?.textContent).toBe("pia project list");
  expect(rowNamed("Atlas").querySelector(".meta")?.textContent).toBe("6 h");
  expect(rowNamed("Northwind").querySelector(".meta.warn")?.textContent).toBe("Held up");
  await open("Northwind");
  expect(buttons()).toEqual(["Ask an agent to unblock it"]);
});

it("draws the week as bars, then projects by their hours, each opening in place", async () => {
  await show("time");
  expect(bench.host.querySelectorAll(".bars > div")).toHaveLength(7);
  expect(bench.host.querySelector(".fold .cmdline")?.textContent).toBe("pia time agents lift --client NAME");
  await open("Atlas");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Open work");
});

it("splits a week's hours so the days add up to the week's rounded total", () => {
  expect(dayHours([90, 90, 90])).toEqual([2, 2, 1]);
  expect(dayHours([0, 30, 29]).reduce((a, b) => a + b, 0)).toBe(1);
});

it("pauses an active goal quietly, resumes a paused one, and brings an ended one back to active", async () => {
  bench.answers["/api/goals"] = ok(
    OwnerGoals.parse({
      goals: [goal(GOAL, "Find a full-time role", "paused"), goal(`gol_${ulid(11)}`, "Learn to sail", "done")],
    }),
  );
  await show("goals");
  await open("Find a full-time role");
  expect(buttons()).toContain("Resume");
  const body = sent();
  bench.answers["/api/setGoalStatus"] = ok({});
  await press("Resume");
  expect(body["/api/setGoalStatus"]).toMatchObject({ goal: GOAL, status: "active" });
  await act(async () => bench.host.querySelector<HTMLButtonElement>(".more")?.click());
  await open("Learn to sail");
  expect(buttons()).toContain("Back to active");
});

it("changes or clears a goal's target already set", async () => {
  bench.answers["/api/goals"] = ok(
    OwnerGoals.parse({
      goals: [
        {
          ...goal(GOAL, "Find a full-time role", "active"),
          target: { id: `ent_${ulid(7)}`, kind: "person", name: { untrusted: "Ada" }, address: null },
        },
      ],
    }),
  );
  await show("goals");
  await open("Find a full-time role");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Ada");
  await press("Change target");
  expect(bench.host.querySelector(".exp input")).not.toBeNull();
  const body = sent();
  bench.answers["/api/setGoalTarget"] = ok({});
  await press("Clear target");
  expect(body["/api/setGoalTarget"]).toMatchObject({ goal: GOAL, entity: null });
});

it("reorders a goal by dragging it onto another in its part of life", async () => {
  await show("goals");
  const rows = [...bench.host.querySelectorAll<HTMLElement>("[draggable=true]")];
  expect(rows).toHaveLength(2);
  const body = sent();
  bench.answers["/api/rankGoal"] = ok({});
  await act(async () => {
    rows[0]?.dispatchEvent(new Event("dragstart", { bubbles: true }));
    rows[1]?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    rows[1]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  });
  await bench.settle();
  expect(body["/api/rankGoal"]).toMatchObject({ goal: GOAL, after: `gol_${ulid(12)}` });
});

it("judges a finished result Keep or Not useful with a reason, and clears it", async () => {
  bench.answers["/api/results?limit=20"] = ok(
    OwnerResults.parse({
      results: [{ move: `mov_${ulid(31)}`, reportedAt: "2026-11-03T09:00:00Z", lines: [], judged: "keep" }],
      next: null,
    }),
  );
  await show("agents");
  await open("Task 31");
  // The judgment is the main choice, first; a follow-up after it.
  expect(buttons()).toEqual(["Kept: clear", "Ask a follow-up", "Not useful"]);
  await press("Not useful");
  expect(bench.host.querySelector(".exp .whynot")).not.toBeNull();
  const body = sent();
  bench.answers["/api/judgeResult"] = ok({});
  await press("Not worth it");
  expect(body["/api/judgeResult"]).toMatchObject({
    move: `mov_${ulid(31)}`,
    answer: "not_useful",
    reason: "not_worth_it",
  });
  await press("Not useful: clear");
  expect(body["/api/judgeResult"]).toMatchObject({ answer: "none" });
});

it("drops handed work with a reason and the owner's note", async () => {
  bench.answers["/api/agentActivity"] = ok(
    AgentActivity.parse({
      ...ACTIVITY,
      needsYou: {
        cards: [],
        handedToYou: [item(34, { status: "handed_to_owner", summary: { untrusted: "Call the bank" } })],
      },
    }),
  );
  await show("agents");
  await open("Call the bank");
  expect(buttons()).toEqual(["Yes, it's done", "No, drop it"]);
  await act(async () => {
    const note = bench.host.querySelector<HTMLInputElement>(".exp input");
    if (note === null) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(note, "done by phone");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("No, drop it");
  const body = sent();
  bench.answers["/api/decideHanded"] = ok({});
  await press("Already handled");
  expect(body["/api/decideHanded"]).toMatchObject({
    answer: "dismiss",
    reason: "already_handled",
    note: "done by phone",
  });
});

it("groups what is owed as Late, Stale and by direction, each with Cancelled", async () => {
  bench.answers["/api/commitments?state=open&limit=200"] = ok(
    OwnerCommitments.parse({
      commitments: [
        commitment(1, "owed_by_owner", 3),
        { ...commitment(3, "owed_by_owner", null), stale: true },
        commitment(2, "owed_to_owner", null),
      ],
      next: null,
    }),
  );
  await show("owed");
  // Two panels, as the mockup draws them: what the owner owes, then what is owed to them.
  expect([...bench.host.querySelectorAll(".panel h2")].map((one) => one.textContent)).toEqual([
    "You owe",
    "Owed to you",
  ]);
  const labels = [...bench.host.querySelectorAll("h3.label")].map((one) => one.textContent);
  expect(labels).toEqual(["Late", "Stale: still yours to do?"]);
  await act(async () => [...bench.host.querySelectorAll<HTMLButtonElement>("button.row")][0]?.click());
  expect(buttons()).toContain("Cancelled");
});

it("shows who holds what by agent, parked work with no holder kept, each opening to its progress", async () => {
  const long = (n: number, over: Record<string, unknown>) => ({
    opportunity: `opp_${ulid(n)}`,
    kind: "research",
    task: false,
    status: "claimed",
    role: null,
    holder: null,
    lapsed: false,
    lapsedAt: null,
    theirsUntil: null,
    since: null,
    project: null,
    dueAt: null,
    summary: { untrusted: `Long ${n}` },
    progress: null,
    parkedBy: null,
    parkedUntil: null,
    ...over,
  });
  bench.answers["/api/longWork"] = ok(
    AgentLongWork.parse({
      at: "2026-11-04T09:00:00Z",
      more: false,
      work: [
        long(60, {
          holder: "wren",
          since: "2026-11-03T09:00:00Z",
          progress: {
            done: [{ untrusted: "Read the filings" }],
            next: { untrusted: "Draft the memo" },
            waitingOn: { untrusted: "the bank" },
            resumeAt: "2026-11-05T09:00:00Z",
            at: "2026-11-04T08:00:00Z",
            by: "wren",
          },
        }),
        long(61, { parkedUntil: "2026-11-06T09:00:00Z" }),
      ],
    }),
  );
  await show("agents");
  await open("Who holds what");
  expect(bench.host.textContent).toContain("Held, by an agent no longer registered");
  expect(bench.host.textContent).toContain("Long 61");
  await open("Long 60");
  const body = bench.host.querySelector("[data-open^=long-]")?.textContent ?? "";
  for (const words of ["Read the filings", "Draft the memo", "the bank", "Resumes", "Reported"])
    expect(body).toContain(words);
});

it("opens a project to whose it is and who made it, and says the week's hours by area and on no project", async () => {
  await show("projects");
  expect(bench.host.querySelector(".line2")?.textContent).toContain("on no project");
  expect(bench.host.querySelector(".line2")?.textContent).toContain("Ventures 6 h");
  await open("Atlas");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Whose it is");
  expect(bench.host.querySelector(".exp")?.textContent).toContain("Made by you");
});

it("stacks each day by project, says deep work and the longest session, and goes back past three weeks", async () => {
  bench.answers[`/api/timeWeek?weekStart=${mondayOf(NOW)}`] = ok(
    TimeWeek.parse({
      ...WEEK,
      days: WEEK.days.map((day, n) =>
        n === 0
          ? { ...day, deepMinutes: 120, longestSessionMinutes: 90, byProject: [{ project: PROJECT, minutes: 300 }] }
          : day,
      ),
    }),
  );
  await show("time");
  const first = bench.host.querySelector(".bars > div");
  expect([...(first?.querySelectorAll("i") ?? [])].map((one) => one.style.background)).toEqual([
    "var(--p1)",
    "var(--p4)",
  ]);
  expect(first?.getAttribute("title")).toContain("Deep 2h");
  expect(bench.host.querySelector(".line2")?.textContent).toContain("Longest session");
  await press("Earlier");
  expect(bench.calls).toContain(`GET /api/timeWeek?weekStart=${weekStart(4)}`);
});

it("opens each settled answer to what it cited, whether taken back, and the command to reopen it", async () => {
  bench.answers["/api/agentSettlements"] = ok(
    AgentSettlements.parse({
      week: "2026-11-02",
      settlements: [
        {
          card: `crd_${ulid(70)}`,
          kind: "about_you",
          agent: "wren",
          answer: "yes",
          at: "2026-11-03T09:00:00Z",
          cited: [{ kind: "message", id: "m1" }],
          mark: null,
          reopened: true,
        },
      ],
    }),
  );
  await show("agents");
  await open("Settled for you last week");
  await open("answered Yes");
  const body = bench.host.querySelector("[data-open^=settled-]")?.textContent ?? "";
  expect(body).toContain("1 sources");
  expect(body).toContain("Taken back by you");
  expect(bench.host.querySelector("[data-open^=settled-] .cmdline")?.textContent).toBe(
    `pia cards reopen crd_${ulid(70)}`,
  );
});

it("opens a dreaming check to all its claims and the second model's verdict", async () => {
  bench.answers["/api/dreamSample"] = ok(
    DreamSampleView.parse({
      week: "2026-11-02",
      checks: [
        {
          check: "1",
          target: "relation",
          kind: "contradicts",
          finding: null,
          judge: null,
          checker: "m",
          verdict: "supported",
          at: "2026-11-03T09:00:00Z",
          mark: null,
          newToMe: null,
          claims: [
            { fact: "a", type: "t", phrase: { untrusted: "Ada lives in Austin" } },
            { fact: "b", type: "t", phrase: { untrusted: "Ada lives in Boston" } },
          ],
        },
      ],
    }),
  );
  await show("agents");
  await open("What dreaming found");
  await open("Ada lives in Austin");
  const body = bench.host.querySelector("[data-open^=dream-]")?.textContent ?? "";
  expect(body).toContain("Ada lives in Boston");
  expect(body).toContain("Found it held");
});

it("reads ideas afresh each time the view opens", async () => {
  await show("ideas");
  await bench.hide();
  await show("ideas");
  expect(bench.calls.filter((one) => one === "GET /api/ideas")).toHaveLength(2);
});
