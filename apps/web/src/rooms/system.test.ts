// @vitest-environment jsdom
import {
  AgentActivity,
  AgentRecords,
  ClientRowView,
  StatusView,
  SystemDefects,
  SystemView,
  WorkStatusView,
} from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it } from "vitest";
import { RouteContext } from "../parts.tsx";
import { routeTo } from "../rooms.ts";
import { internalsOn } from "../test-support/internals.ts";
import { roomHarness } from "../test-support/room-harness.ts";
import { System } from "./system.tsx";

// The System room's Health, Measures and Agents views from small fixtures shaped by the contracts:
// verb rows that open in place, status as meta, the brake confirmed inside its panel, and nothing
// from the "Never in a browser" list as a button.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-20T12:00:00Z");
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const ago = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

const WORK = (killSwitch: "on" | "off") =>
  WorkStatusView.parse({
    killSwitch,
    planner: "split",
    goals: {},
    hypotheses: {},
    opportunities: {},
    runs: {},
    intentions: {},
    today: { runs: 2, maxRuns: 20, spentMicroUsd: 0, maxMicroUsd: 5 },
    todayBasis: { spent: { reported: 0, price_list: 0, assumed: 0 } },
    cards: { pending: 3, deferred: 0, maxPending: 10 },
    lastRuns: [],
    open: [],
    tasks: "on",
    routes: [],
    defaultRole: null,
    rules: { merges: "off", agentCloses: "on", grouping: "shadow" },
  });
const STATUS = StatusView.parse({
  migration: "0202",
  tables: {},
  missingKeys: [],
  missingLabels: 0,
  accounts: [],
  googleTokens: [],
  keyCheck: "ok",
  clients: [],
  drive: { documents: 1, held: 0, databaseBytes: 1_500_000_000, ceilingBytes: 3_200_000_000, ceilingWarning: false },
  boxHealth: [{ card: `crd_${ulid(31)}`, kind: "backup_due", about: "backup", code: null, at: ago(2) }],
  boxHealthSeen: [],
  learnings: [],
});
const measure = (metric: string, state: "ok" | "failing", failingSince: string | null) => ({
  metric,
  state,
  value: 0.12,
  sample: 40,
  readAt: ago(0, 1),
  healthy: { test: "at_least", value: 0.7 },
  minSample: 10,
  failingSince,
  stale: false,
});
const SYSTEM = SystemView.parse({
  at: NOW.toISOString(),
  commit: "0123456789abcdef0123456789abcdef01234567",
  measures: [
    measure("credited_share", "failing", ago(9)),
    measure("owner_questions_per_week", "failing", ago(0, 3)),
    measure("signals_picked_up", "ok", null),
  ],
});
const defect = (n: number, severity: string) => ({
  improvement: `imp_${ulid(n)}`,
  kind: "bug",
  severity,
  area: "work",
  status: "open",
  role: null,
  heldBy: null,
  fixRef: null,
  filedAt: ago(3),
  days: 3,
  reports: 1,
  filedBy: "system",
  cause: "measure_floor:credited_share",
  ownersToChange: false,
  words: null,
});
const DEFECTS = SystemDefects.parse({
  at: NOW.toISOString(),
  total: 7,
  open: 7,
  defectRole: "engineering",
  ownersToChange: 0,
  heldByOne: [],
  defects: [defect(1, "high"), ...[2, 3, 4, 5, 6, 7].map((n) => defect(n, "medium"))],
});
const client = (n: number, name: string, kind: string, roles: string[], status = "active") => ({
  id: `cli_${ulid(n)}`,
  name,
  kind,
  status,
  runtime: "local",
  vendorRetention: "none",
  compartments: ["own"],
  views: ["people"],
  tools: ["search"],
  roles,
  webhook: false,
  createdAt: ago(30),
  revokedAt: status === "revoked" ? ago(5) : null,
  lastCallAt: ago(0, 2),
});
const CLIENTS = ClientRowView.array().parse([
  client(20, "sable", "agent", ["research"]),
  client(21, "mac-one", "device", []),
  client(22, "probe", "agent", []),
  client(23, "wren", "agent", ["research"], "revoked"),
]);

// The room at one of its views, as the shell gives it the route.
const at = (view: string) =>
  createElement(RouteContext.Provider, { value: routeTo("System", view) }, createElement(System));
const bench = roomHarness(
  NOW,
  () => at("health"),
  () => ({
    "/api/session": { status: 200, body: { token: "form-token-1" } },
    "/api/system": { status: 200, body: SYSTEM },
    "/api/defects": { status: 200, body: DEFECTS },
    "/api/status": { status: 200, body: STATUS },
    "/api/workStatus": { status: 200, body: WORK("off") },
    "/api/spendToday": { status: 200, body: { lanes: [{ lane: "work", spentUsd: 1.5, capUsd: 5 }] } },
    "/api/listClients": { status: 200, body: CLIENTS },
    "/api/coverage": { status: 200, body: [{ kind: "device", id: `cli_${ulid(21)}`, state: "silent", counts: {} }] },
    "/api/agentActivity": {
      status: 200,
      body: AgentActivity.parse({ needsYou: { cards: [], handedToYou: [] }, working: [], finished: [], blocked: [] }),
    },
    "/api/agentRecords": { status: 200, body: AgentRecords.parse({ at: NOW.toISOString(), agents: [] }) },
    "/api/decide": { status: 200, body: { result: true } },
    "/api/stopWork": { status: 200, body: { result: true } },
    "/api/cardLoadSeries?days=30": {
      status: 200,
      body: {
        days: [
          { day: "2026-10-18", pending: 9 },
          { day: "2026-10-19", pending: 6 },
          { day: "2026-10-20", pending: 4 },
        ],
      },
    },
    "/api/addTask": { status: 200, body: { result: { task: `opp_${ulid(60)}` } } },
  }),
);
const { calls, answers, settle, show } = bench;

const panel = (title: string): HTMLElement => {
  const found = [...bench.host.querySelectorAll<HTMLElement>("section.panel")].find(
    (one) => one.querySelector("h2")?.textContent === title,
  );
  if (found === undefined) throw new Error(`no ${title} panel`);
  return found;
};
const titles = (within: HTMLElement): string[] =>
  [...within.querySelectorAll(":scope > .list > .row .t")].map((one) => one.textContent ?? "");
const button = (within: HTMLElement, words: string): HTMLButtonElement => {
  const found = [...within.querySelectorAll("button")].find((one) => one.textContent === words);
  if (found === undefined) throw new Error(`no ${words} button`);
  return found;
};
const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => target.click());
  await settle();
};

it("Health: what needs a look is a verb row that opens in place to Mark seen", async () => {
  await show();
  const look = panel("Needs a look");
  const row = look.querySelector<HTMLButtonElement>("button.row");
  expect(row?.querySelector(".verb")?.textContent).toBe("Check");
  expect(row?.querySelector(".meta")?.classList.contains("warn")).toBe(true);
  await click(row as HTMLButtonElement);
  expect(look.querySelector("details.fold summary")?.textContent).toBe("In the terminal");
  // Ask an agent about it: the shared task box in place, the item shown above an empty note.
  await click(button(look, "Ask an agent about it"));
  const note = look.querySelector("textarea") as HTMLTextAreaElement;
  expect(look.querySelector(".exp .lead2")?.textContent).toContain("On my dashboard's health page");
  expect(note.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(note, "Find out why");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button(look, "Hand it over"));
  expect(calls).toContain("POST /api/addTask");
  expect(look.querySelector("textarea")).toBeNull();
  await click(button(look, "Mark seen"));
  expect(calls).toContain("POST /api/decide");
  expect(look.querySelector("button.row")).toBeNull();
  expect(internalsOn(bench.host)).toEqual([]);
});

it("Health: defects show severity as plain meta, five at first and Show all in place", async () => {
  await show();
  const defects = panel("Open defects");
  expect(titles(defects)).toHaveLength(5);
  const metas = [...defects.querySelectorAll(".row .meta")];
  expect(metas[0]?.textContent).toBe("High");
  // Priority is plain meta: amber is only for what is late or wrong.
  expect(metas[0]?.classList.contains("warn")).toBe(false);
  expect(metas[1]?.classList.contains("warn")).toBe(false);
  await click(button(defects, "Show all 7"));
  expect(titles(defects)).toHaveLength(7);
  await click(defects.querySelector("button.row") as HTMLButtonElement);
  expect(defects.textContent).toContain("What's wrong");
});

it("Health: the brake is a link in the head, confirmed inside the panel; stopped, resuming is a command", async () => {
  await show();
  const box = panel("The box");
  expect(box.textContent).toContain("1.5 GB of 3.2 GB");
  await click(button(box, "Stop all agent work"));
  expect(box.textContent).toContain("Stop all agent work?");
  answers["/api/workStatus"] = { status: 200, body: WORK("on") };
  await click(button(box, "Stop agent work"));
  expect(calls).toContain("POST /api/stopWork");
  expect(box.querySelector(".stopped")?.textContent).toContain("pia work start");
  expect([...box.querySelectorAll("button")].some((one) => one.textContent?.includes("Resume"))).toBe(false);
});

it("Measures: what is off target, new today first in amber, each opening to its reading", async () => {
  await show(at("measures"));
  const off = panel("Off target");
  expect(off.querySelector(".line2")?.textContent).toBe("1 on target · 0 too new to tell");
  expect([...off.querySelectorAll(".label")].map((one) => one.textContent)).toEqual([
    "New today",
    "Ongoing",
    "Questions waiting for you",
  ]);
  const rows = [...off.querySelectorAll<HTMLButtonElement>("button.row")];
  // Every off-target value is amber, and its line reads "Failing for ...", never "off for Failing".
  expect(rows[0]?.querySelector(".meta")?.classList.contains("warn")).toBe(true);
  expect(rows[1]?.querySelector(".meta")?.classList.contains("warn")).toBe(true);
  expect(rows[1]?.querySelector(".s")?.textContent).toMatch(/^Failing for/);
  expect(off.textContent).not.toContain("off for");
  await click(rows[0] as HTMLButtonElement);
  expect(off.textContent).toContain("pia outcomes");
  expect(off.textContent).toContain("What it rests on");
  // The one small line: questions waiting for the owner each day, its counts said in words.
  expect(off.querySelector(".trend svg")?.getAttribute("aria-label")).toBe("9 waiting 3 days ago, 4 now");
  await click(button(off, "7 days"));
  expect(calls).toContain("GET /api/cardLoadSeries?days=7");
  await click(button(off, "Show all 3 measures"));
  expect(off.querySelectorAll("button.row")).toHaveLength(3);
});

it("Health: each look row keeps its own refusal; defects say area and first filed; the box's spend reads plainly", async () => {
  await show();
  const look = panel("Needs a look");
  answers["/api/decide"] = { status: 409, body: { error: "conflict" } };
  await click(look.querySelector("button.row") as HTMLButtonElement);
  await click(button(look, "Mark seen"));
  expect(look.querySelectorAll(".refused")).toHaveLength(1);
  answers["/api/decide"] = { status: 200, body: { result: true } };
  const defects = panel("Open defects");
  await click(defects.querySelector("button.row") as HTMLButtonElement);
  expect(defects.textContent).toContain("First filed");
  const box = panel("The box");
  expect(box.querySelector(":scope > .list > .sub-list")).toBeNull();
  expect(box.textContent).not.toMatch(/\$\d+\.\d\d \$/);
});

it("Agents: agents, devices with a stopped one in amber, and the rest behind their own Show", async () => {
  await show(at("agents"));
  const agents = panel("Your agents");
  expect(titles(agents)).toEqual([
    "Sable · Research",
    "Mac-one · Device",
    "What your agents learned this week",
    "Each agent's last 28 days",
  ]);
  const device = [...agents.querySelectorAll(".row")][1];
  expect(device?.querySelector(".meta")?.classList.contains("warn")).toBe(true);
  await click(button(agents, "Agents with no role, 1"));
  await click(button(agents, "Revoked, 1"));
  expect(titles(agents)).toContain("Probe · No role");
  expect(titles(agents)).toContain("Wren · Research");
  await click(agents.querySelector("button.row") as HTMLButtonElement);
  expect(agents.textContent).toContain("pia clients revoke sable");
  expect([...agents.querySelectorAll("button")].some((one) => one.textContent === "Pause")).toBe(false);
});
