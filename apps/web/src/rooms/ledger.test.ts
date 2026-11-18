// @vitest-environment jsdom
import { LedgerDay, LedgerEvent, LedgerFeed, LedgerLanes } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { internalsOn } from "../test-support/internals.ts";
import { roomHarness } from "../test-support/room-harness.ts";
import { Ledger, stepOf, whoOf } from "./ledger.tsx";

// The Ledger view: the day's figures, then what happened, newest first, as plain rows; only a piece
// of an agent's work opens. Small fixtures shaped by the contracts.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-20T15:00:00Z");
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const OPP = `opp_${ulid(2)}`;
const dateOf = (when: Date): string =>
  `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
const event = (id: number, over: Record<string, unknown> = {}): LedgerEvent =>
  LedgerEvent.parse({
    id,
    at: new Date(NOW.getTime() - (20 - id) * 60_000).toISOString(),
    row: { kind: "move", id: `mov_${ulid(id)}` },
    event: "planned",
    code: null,
    by: "client:agent-one",
    work: OPP,
    ...over,
  });
const DAY = LedgerDay.parse({
  day: dateOf(NOW),
  runs: 2,
  moves: 3,
  spend: [
    { lane: "work", usd: 1.25 },
    { lane: "extraction", usd: 0.5 },
  ],
  itemsRead: 41,
  claimsMade: 23,
  decisions: 2,
  sends: 0,
});
const FEED = LedgerFeed.parse({
  events: [
    event(10, { row: { kind: "run", id: `run_${ulid(1)}` }, event: "completed", by: "reasoner", work: null }),
    event(12, { event: "reported", code: "done" }),
  ],
  works: [{ work: OPP, summary: { untrusted: "Find the venue's spring prices" } }],
  cards: [],
  next: null,
});

const LANES = LedgerLanes.parse({
  day: dateOf(NOW),
  spans: [
    {
      worker: "pipeline",
      from: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      to: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      work: null,
      read: { decided: 9, stored: 6, junk: 2, held: 1, removed: 0 },
    },
  ],
});

class NoStream extends EventTarget {
  close(): void {}
}

const bench = roomHarness(
  NOW,
  () => createElement(Ledger),
  () => ({
    [`/api/ledgerDay?day=${dateOf(NOW)}`]: { status: 200, body: DAY },
    "/api/ledgerFeed?limit=50": { status: 200, body: FEED },
    [`/api/ledgerLanes?day=${dateOf(NOW)}`]: { status: 200, body: LANES },
    "/api/ledgerFeed?limit=1": { status: 200, body: { events: [] } },
  }),
);

const rows = (): string[] =>
  [...bench.host.querySelectorAll(".row")].map((row) => row.querySelector(".t")?.textContent ?? "");

it("shows the day's figures, then what happened newest first, with no chips", async () => {
  vi.stubGlobal("EventSource", NoStream);
  await bench.show();
  const figures = [...bench.host.querySelectorAll(".fig")].map((one) => [
    one.querySelector(".k")?.textContent,
    one.querySelector(".v")?.textContent,
  ]);
  expect(figures).toEqual([
    ["Messages read", "41 items"],
    ["Learned", "23 facts"],
    ["Agent work", "5 pieces"],
    ["Spent", "$1.75"],
    ["Your decisions", "2"],
    ["Sent", "Nothing"],
  ]);
  expect(rows()).toEqual([
    "Read your new mail and messages",
    "Find the venue's spring prices",
    "The planner looked over your work",
  ]);
  expect(bench.host.querySelectorAll(".row .meta")[1]?.textContent).toMatch(/^done /);
  expect(bench.host.querySelector(".verb")).toBeNull();
  expect(internalsOn(bench.host)).toEqual([]);
});

it("opens a piece of work to its steps, and the syncs to what each read", async () => {
  vi.stubGlobal("EventSource", NoStream);
  await bench.show();
  const [sync, work] = [...bench.host.querySelectorAll("button.row")];
  await act(async () => (work as HTMLButtonElement).click());
  expect(bench.host.querySelector("[data-open]")?.textContent).toContain("Reported back: done");
  await act(async () => (sync as HTMLButtonElement).click());
  const body = bench.host.querySelector("[data-open]")?.textContent ?? "";
  expect(body).toContain("9 new items from your accounts: 6 kept, 2 left out as junk, 1 held back");
});

it("says each step in words, by who took it", () => {
  const cards = new Map([[`crd_${ulid(5)}`, "Is Person Four at Northwind?"]]);
  expect(stepOf(event(1), cards)).toBe("Started");
  expect(
    stepOf(event(2, { row: { kind: "card", id: `crd_${ulid(5)}` }, event: "decided", code: null, by: "owner" }), cards),
  ).toBe("You answered: Is Person Four at Northwind?");
  expect(whoOf("owner")).toBe("You");
  expect(whoOf("system:pipeline")).toBe("Reading mail");
  expect(whoOf("client:agent-one")).toBe("Agent-one");
});
