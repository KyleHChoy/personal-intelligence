// @vitest-environment jsdom
import {
  FactRulingNamedView,
  IgnoredView,
  SourceAccountView,
  VetoNamedView,
  WorkStatusView,
} from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it } from "vitest";
import { internalsOn } from "../test-support/internals.ts";
import { CONFIRM_RATES } from "../test-support/learning.ts";
import { roomHarness } from "../test-support/room-harness.ts";
import { Settings } from "./settings.tsx";

// Settings from small fixtures shaped by the contracts: one row per setting, each opening in place
// to what it holds, the page's writes (learning, Lift) one decision a request, and every other
// change a command in the terminal fold.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-20T12:00:00Z");
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const ACCOUNTS = SourceAccountView.array().parse([
  {
    id: `acc_${ulid(30)}`,
    label: "Home mail",
    connector: "gmail",
    compartment: "own",
    address: null,
    lastSyncAt: "2026-10-20T11:00:00Z",
    lastOutcome: "ok",
  },
  {
    id: `acc_${ulid(31)}`,
    label: "School mail",
    connector: "gmail",
    compartment: "own",
    address: null,
    lastSyncAt: null,
    lastOutcome: "token_expired",
  },
]);
const VETOES = VetoNamedView.array().parse([
  {
    id: `rul_${ulid(3)}`,
    subject: "person",
    entity: `ent_${ulid(4)}`,
    kind: "role",
    at: "2026-10-02T09:00:00Z",
    who: { id: `ent_${ulid(4)}`, kind: "person", name: { untrusted: "Person Four" }, address: null },
  },
  // The person this veto named is gone: it is on them, never on every person.
  {
    id: `rul_${ulid(5)}`,
    subject: "person",
    entity: `ent_${ulid(6)}`,
    kind: null,
    at: "2026-10-03T09:00:00Z",
    who: null,
  },
]);
const IGNORED = IgnoredView.array().parse([
  {
    id: `rul_${ulid(7)}`,
    target: "entity",
    subject: "address",
    values: 1,
    at: "2026-10-04T09:00:00Z",
    liftedAt: null,
    who: [
      {
        id: `ent_${ulid(8)}`,
        kind: "person",
        name: { untrusted: "Person Eight" },
        address: { untrusted: "eight@example.test" },
      },
    ],
  },
  {
    id: `rul_${ulid(9)}`,
    target: "domain",
    subject: "domain",
    values: 1,
    at: "2026-10-05T09:00:00Z",
    liftedAt: "2026-10-06T09:00:00Z",
    who: [],
  },
]);
const JOINS = FactRulingNamedView.array().parse([
  {
    id: `rul_${ulid(10)}`,
    verdict: "join",
    a: "a".repeat(64),
    b: "b".repeat(64),
    at: "2026-10-05T09:00:00Z",
    liftedAt: null,
    gone: false,
    aClaim: null,
    bClaim: null,
    aFact: null,
    bFact: null,
  },
]);

const WORK = WorkStatusView.parse({
  killSwitch: "off",
  planner: "split",
  goals: {},
  hypotheses: {},
  opportunities: {},
  runs: {},
  intentions: {},
  today: { runs: 0, maxRuns: 20, spentMicroUsd: 0, maxMicroUsd: 5 },
  todayBasis: { spent: { reported: 0, price_list: 0, assumed: 0 } },
  cards: { pending: 0, deferred: 0, maxPending: 10 },
  lastRuns: [],
  open: [],
  tasks: "on",
  routes: [],
  defaultRole: null,
  rules: { merges: "off", agentCloses: "on", grouping: "shadow" },
});

const bench = roomHarness(
  NOW,
  () => createElement(Settings),
  () => ({
    "/api/session": { status: 200, body: { token: "form-token-1" } },
    "/api/confirmRates": { status: 200, body: CONFIRM_RATES },
    "/api/workStatus": { status: 200, body: WORK },
    "/api/releaseGrants": { status: 200, body: [] },
    "/api/lessons": { status: 200, body: { lessons: [] } },
    "/api/listSourceAccounts": { status: 200, body: ACCOUNTS },
    "/api/coverage": { status: 200, body: [] },
    "/api/spendToday": { status: 200, body: { lanes: [{ lane: "work", spentUsd: 6.67, capUsd: 32 }] } },
    "/api/listIgnore": { status: 200, body: IGNORED },
    "/api/liftIgnore": { status: 200, body: { result: true } },
    "/api/ignorePerson": { status: 200, body: { result: `rul_${ulid(41)}` } },
    "/api/status": { status: 404, body: {} },
    "/api/listClients": { status: 200, body: [] },
    "/api/budget": { status: 404, body: {} },
    "/api/listVetoes": { status: 200, body: VETOES },
    "/api/listFactRulings": { status: 200, body: JOINS },
    "/api/setLearning": { status: 200, body: { result: `rul_${ulid(40)}` } },
    "/api/liftVeto": { status: 200, body: { result: true } },
  }),
);
const { calls, settle, show } = bench;

const row = (title: string): HTMLButtonElement => {
  const found = [...bench.host.querySelectorAll<HTMLButtonElement>("button.row")].find(
    (one) => one.querySelector(".t")?.textContent === title,
  );
  if (found === undefined) throw new Error(`no ${title} row`);
  return found;
};
const click = async (target: Element | undefined): Promise<void> => {
  await act(async () => (target as HTMLElement).click());
  await settle();
};
const buttonOf = (words: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent === words);

it("lists one row per setting, its state the meta, and the terminal fold at the panel's foot", async () => {
  await show();
  const rows = [...bench.host.querySelectorAll("button.row")].map((one) => [
    one.querySelector(".t")?.textContent,
    one.querySelector(".meta")?.textContent ?? "",
  ]);
  expect(rows).toEqual([
    ["Autonomy", "Agents running"],
    ["Learning", "On for 2 of 3 agents"],
    ["Sources", "2 sources, 1 stopped"],
    ["Spend", "$6.67 of $32.00"],
    ["Identity", "Names and rulings"],
    ["Privacy and forgetting", "What was shown, what is kept apart"],
  ]);
  expect(row("Sources").querySelector(".meta")?.classList.contains("warn")).toBe(true);
  expect(bench.host.querySelector(".foot details.fold")?.textContent).toContain("pia erase list");
  expect(internalsOn(bench.host)).toEqual([]);
});

it("Learning turns one agent off here, one request, with Undo", async () => {
  await show();
  await click(row("Learning"));
  await click(buttonOf("Turn off"));
  expect(calls.filter((one) => one === "POST /api/setLearning")).toHaveLength(1);
  await click(buttonOf("Undo"));
  expect(calls.filter((one) => one === "POST /api/setLearning")).toHaveLength(2);
});

it("Sources show a stopped account in amber and its reconnect in the fold", async () => {
  await show();
  await click(row("Sources"));
  const open = bench.host.querySelector("[data-open]");
  expect(open?.querySelector(".meta.warn")?.textContent).toBe("Stopped: token expired");
  await click(row("School mail"));
  const fold = bench.host.querySelector("[data-open] [data-open] details.fold")?.textContent ?? "";
  expect(fold).toContain("pia google connect --account 'School mail'");
  // Disconnecting takes the contacts first; the healthy account offers no reconnect.
  expect(fold).toContain("pia google disconnect 'School mail' --contacts");
  await click(row("Home mail"));
  expect(bench.host.querySelector("[data-open] [data-open] details.fold")?.textContent).not.toContain(
    "connect --account",
  );
  expect(bench.host.textContent).toContain("pia extract status");
});

it("Identity lifts a veto in place; nothing else there is a browser write", async () => {
  await show();
  await click(row("Identity"));
  expect(bench.host.textContent).toContain("Person Four: role facts");
  await click(buttonOf("Lift"));
  expect(calls).toContain("POST /api/liftVeto");
  expect(bench.host.textContent).toContain("Lifted");
});

it("Autonomy's settings of several values pick the value to make it, and name that value's command", async () => {
  await show();
  await click(row("Autonomy"));
  const planner = [...bench.host.querySelectorAll(".pick")].find(
    (one) => one.querySelector(".t")?.textContent === "Planner",
  );
  expect(planner?.querySelector(".meta")?.textContent).toBe("Ideas first, then work");
  expect(planner?.querySelector(".cmdline")?.textContent).toBe("pia work budget --planner research_only");
  const onePass = [...(planner?.querySelectorAll(".seg button") ?? [])].find(
    (one) => one.textContent === "Work in one pass",
  );
  await click(onePass);
  expect(planner?.querySelector(".cmdline")?.textContent).toBe("pia work budget --planner one_pass");
  // A two-valued setting names the other value's command alone, with no picker.
  const merges = [...bench.host.querySelectorAll(".pick")].find(
    (one) => one.querySelector(".t")?.textContent === "Automatic same-person merges",
  );
  expect(merges?.querySelector(".seg")).toBeNull();
  expect(merges?.querySelector(".cmdline")?.textContent).toBe("pia identity merges on");
  // These change only in the terminal: the page wrote nothing.
  expect(calls.some((one) => one.startsWith("POST"))).toBe(false);
});

it("Identity names each ruling's own id in its command, and a veto on someone gone is not on every person", async () => {
  await show();
  await click(row("Identity"));
  expect(bench.host.textContent).toContain("Someone no longer known: every fact");
  expect(bench.host.textContent).not.toContain("Every person");
  await click(row("Person Eight"));
  expect(bench.host.textContent).toContain(`pia ignore lift rul_${ulid(7)}`);
  expect(bench.host.textContent).toContain("eight@example.test");
  await click(row("A domain no one known is at"));
  expect(bench.host.textContent).toContain("Lifted");
  await click(row("A fact no longer held, and a fact no longer held"));
  expect(bench.host.textContent).toContain(`pia facts lift rul_${ulid(10)}`);
  expect(bench.host.textContent).not.toContain("RULING");
});

it("lifting an ignore comes with Undo, which ignores them again", async () => {
  await show();
  await click(row("Identity"));
  await click(row("Person Eight"));
  await click(
    [...bench.host.querySelectorAll<HTMLButtonElement>(".actbar button")].find((one) => one.textContent === "Lift"),
  );
  expect(calls.filter((one) => one === "POST /api/liftIgnore")).toHaveLength(1);
  await click(buttonOf("Undo"));
  expect(calls).toContain("POST /api/ignorePerson");
});
