// @vitest-environment jsdom
import type { FactDetail } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { OpenRows } from "../parts.tsx";
import { roomHarness } from "../test-support/room-harness.ts";
import { Self } from "./self.tsx";
import { areaOf, linesOf } from "./self-parts.ts";
import { saidByOf } from "./self-sources.tsx";

// You, from small made-up fixtures: areas, rows that open in place to what they rest on, Edit and
// "It's not true" with Undo, the ended folded away, Housekeeping, and the As of menu.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKUP = '<img src=x onerror="alert(1)"><b>bold</b>';
const hex = (n: number): string => String(n).padStart(64, "0");
const RULING = `rul_01J${"7".padStart(23, "0")}`;
const row = (n: number, kind: string, words: string, domain: string | null, over: Record<string, unknown> = {}) => ({
  n,
  kind,
  status: "active",
  at: "2026-10-20T09:00:00Z",
  words: { untrusted: words },
  source: "mail",
  ownWords: false,
  fact: hex(n),
  facts: [hex(n)],
  factKey: hex(n + 1000),
  tier: "stated",
  domain,
  carried: [],
  use: 0,
  rank: n,
  notice: null,
  ...over,
});
const ROWS = [
  row(1, "goal", MARKUP, "career"),
  row(2, "goal", "Find a cofounder", "career"),
  row(3, "goal", "find a cofounder.", "career"),
  row(4, "capability", "Was enrolled", "career", { status: "closed" }),
  row(5, "plan", "A trip in spring", "travel"),
  row(6, "situation", "A parcel shipped", "career", { notice: "current", use: 5 }),
  row(7, "situation", "A statement is ready", "career", { notice: "older", use: 5 }),
  row(8, "situation", "A flight was booked", "travel", { tier: "system_notice" }),
  row(9, "plan", "Maybe a week in Lisbon", "travel", { use: 3 }),
];
const detail = (n: number, words: string) => ({
  fact: {
    id: hex(n),
    subject: { id: `ent_01J${"1".padStart(23, "0")}`, kind: "person", name: { untrusted: "Owner" }, address: null },
    statedBy: null,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: "2026-10-20T09:00:00Z",
    message: null,
    source: "mail",
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
    type: "goal",
    fields: { what: { untrusted: words }, domain: "career" },
  },
  factKey: hex(n + 1000),
  compartments: ["own"],
  beliefs: { audiences: 1, status: ["active"] },
  rulings: [],
  declassification: null,
  lines: [],
});

const bench = roomHarness(
  new Date("2026-11-16T12:00:00Z"),
  () => createElement(OpenRows, null, createElement(Self)),
  () => ({
    "/api/selfReview?limit=200": {
      status: 200,
      body: { owner: `ent_01J${"1".padStart(23, "0")}`, rows: ROWS, next: null },
    },
    [`/api/factShow?fact=${hex(2)}`]: { status: 200, body: detail(2, "Find a cofounder") },
    [`/api/factShow?fact=${hex(3)}`]: { status: 200, body: detail(3, "find a cofounder.") },
    [`/api/factShow?fact=${hex(4)}`]: { status: 200, body: detail(4, "Was enrolled") },
    [`/api/factShow?fact=${hex(6)}`]: { status: 200, body: detail(6, "A parcel shipped") },
    "/api/session": { status: 200, body: { token: "t" } },
    "/api/correctValue": { status: 200, body: { result: RULING } },
    "/api/rejectClaim": { status: 200, body: { result: RULING } },
    "/api/liftRuling": { status: 200, body: { result: true } },
  }),
);

const host = () => bench.host;
const panel = () => host().querySelector(".you-pane") as HTMLElement;
const buttonOf = (within: Element, text: string): HTMLButtonElement => {
  const found = [...within.querySelectorAll("button")].find((one) => one.textContent?.startsWith(text));
  if (found === undefined) throw new Error(`no ${text} button`);
  return found;
};
const click = async (target: HTMLElement) => {
  await act(async () => target.click());
  await bench.settle();
};
const posted = (name: string) => bench.calls.filter((call) => call === `POST /api/${name}`).length;

it("shows the areas, then Your activity and Housekeeping after the divider, the room named You", async () => {
  window.history.replaceState(null, "", "#you");
  await bench.show();
  // The shell names the room; You draws its areas beside the panel.
  expect(host().querySelector("nav.side")?.getAttribute("aria-label")).toBe("Areas of your life");
  const side = [...host().querySelectorAll(".side > *")].map((one) => one.textContent);
  expect(side.slice(0, 2)).toEqual(["Career2", "Ventures"]);
  expect(side.slice(-3)).toEqual(["", "Your activity", "Housekeeping1"]);
  // Markup in a fact is text; the same sentence twice is one row.
  expect(host().querySelector("img, b")).toBeNull();
  expect([...panel().querySelectorAll(".row .t")].map((one) => one.textContent)).toEqual([MARKUP, "Find a cofounder"]);
  expect(panel().querySelector(".label")?.textContent).toBe("Goal");
});

it("keeps the area in the address, and opens on the one the address names", async () => {
  window.history.replaceState(null, "", "#you-travel");
  await bench.show();
  expect(panel().querySelector("h2")?.textContent).toBe("Travel");
  await click(buttonOf(host().querySelector(".side") as Element, "Career"));
  expect(new URL(document.URL).hash).toBe("#you-career");
  expect(areaOf("#you-nowhere")).toBe("career");
});

it("opens a row in place to what it rests on, every claim of its near-same rows, no sheet", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  const line = buttonOf(panel(), "Find a cofounder");
  await click(line);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  const body = panel().querySelector(".exp") as HTMLElement;
  expect(body.textContent).toContain("What it rests on");
  expect(body.textContent).toContain("Held 2 times");
  expect(body.querySelectorAll(".ev")).toHaveLength(2);
  expect(host().querySelector(".sheet, [role=dialog]")).toBeNull();
});

it("edits a fact in place and undoes it from the toast", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  await click(buttonOf(panel(), "Find a cofounder"));
  await click(buttonOf(panel(), "Edit"));
  const field = panel().querySelector(".fact-edit input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "Find two cofounders");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(buttonOf(panel(), "Save"));
  expect(posted("correctValue")).toBe(1);
  expect(host().querySelector(".toast")?.textContent).toContain("Find two cofounders");
  await click(buttonOf(host().querySelector(".toast") as Element, "Undo"));
  expect(posted("liftRuling")).toBe(1);
});

it("marks a fact not true with a quiet link, and the row says so", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  await click(buttonOf(panel(), "Find a cofounder"));
  const quiet = buttonOf(panel(), "It's not true");
  expect(quiet.className).toContain("lnk");
  await click(quiet);
  expect(posted("rejectClaim")).toBe(1);
  expect(buttonOf(panel(), "Find a cofounder").textContent).toContain("Not true");
});

it("folds the ended away until asked, and keeps notices under Housekeeping", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  expect(panel().textContent).not.toContain("Was enrolled");
  await click(buttonOf(panel(), "Show 1 that ended"));
  expect(panel().textContent).toContain("Was enrolled");
  expect(panel().textContent).not.toContain("A parcel shipped");

  await click(buttonOf(host().querySelector(".side") as Element, "Housekeeping"));
  await click(buttonOf(panel(), "A parcel shipped"));
  expect(panel().querySelector(".exp")?.textContent).toContain("An automatic notice");
  expect(panel().textContent).not.toContain("A statement is ready");
  await click(buttonOf(panel(), "Show 1 older"));
  expect(panel().textContent).toContain("A statement is ready");
});

it("opens As of as a small menu in the panel head, and reads what was believed then", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  const asOf = buttonOf(panel().querySelector(".ph") as Element, "As of today");
  await click(asOf);
  const items = [...panel().querySelectorAll("[role=menuitem]")].map((one) => one.textContent);
  expect(items).toEqual(["Today", "A week ago", "A month ago"]);
  await click(buttonOf(panel(), "A week ago"));
  expect(panel().querySelector("[role=menu]")).toBeNull();
  expect(bench.calls.some((call) => call.startsWith("GET /api/beliefsAsOf?"))).toBe(true);
  expect(buttonOf(panel(), "As of ").textContent).toContain("9 Nov");
});

it("shows one line for the same sentence, the best ranked leading", () => {
  const lines = linesOf(ROWS.slice(1, 3) as never);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.held).toBe(2);
  expect(lines[0]?.facts).toEqual([hex(2), hex(3)]);
});

const RULING_2 = `rul_01J${"8".padStart(23, "0")}`;
const setValue = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

it("puts a line too thin to lead under Also held, after the kinds", async () => {
  window.history.replaceState(null, "", "#you-travel");
  await bench.show();
  const labels = [...panel().querySelectorAll(".label")].map((one) => one.textContent);
  expect(labels.at(-1)).toBe("Also held");
  const text = panel().textContent ?? "";
  expect(text.indexOf("Maybe a week in Lisbon")).toBeGreaterThan(text.indexOf("Also held"));
});

it("lets each near-same row be ruled on by itself, not only the top one", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  await click(buttonOf(panel(), "Find a cofounder"));
  const outer = panel().querySelector(".exp") as HTMLElement;
  expect(outer.textContent).toContain("The other times it is held");
  await click(buttonOf(outer, "find a cofounder."));
  const inner = outer.querySelector(".exp") as HTMLElement;
  await click(buttonOf(inner, "It's not true"));
  expect(posted("rejectClaim")).toBe(1);
  expect(buttonOf(outer, "find a cofounder.").textContent).toContain("Not true");
  expect(buttonOf(panel(), "Find a cofounder").textContent).not.toContain("Not true");
});

it("offers Lift on every ruling held, and a lifted one goes", async () => {
  window.history.replaceState(null, "", "#you-career");
  bench.answers[`/api/factShow?fact=${hex(2)}`] = {
    status: 200,
    body: { ...detail(2, "Find a cofounder"), rulings: [RULING, RULING_2] },
  };
  await bench.show();
  await click(buttonOf(panel(), "Find a cofounder"));
  const lifts = () => [...panel().querySelectorAll(".exp button")].filter((one) => one.textContent === "Lift");
  expect(lifts()).toHaveLength(2);
  await click(lifts()[1] as HTMLElement);
  expect(posted("liftRuling")).toBe(1);
  expect(lifts()).toHaveLength(1);
  // The lifted ruling offers no lift any more, and the body offers the rulings again.
  const body = panel().querySelector(".exp") as HTMLElement;
  expect(body.textContent).not.toContain("Lift your ruling");
  expect(body.textContent).toContain("Lifted your ruling");
  await click(lifts()[0] as HTMLElement);
  expect(posted("liftRuling")).toBe(2);
  expect(lifts()).toHaveLength(0);
});

it("reads a typed date only once it settles, not on every key of the year", async () => {
  window.history.replaceState(null, "", "#you-career");
  await bench.show();
  await click(buttonOf(panel().querySelector(".ph") as Element, "As of today"));
  const field = panel().querySelector(".asof-day input") as HTMLInputElement;
  await setValue(field, "0002-11-09");
  await setValue(field, "0020-11-09");
  await setValue(field, "2026-11-09");
  await bench.settle();
  const asked = () => bench.calls.filter((call) => call.startsWith("GET /api/beliefsAsOf?")).length;
  expect(asked()).toBe(0);
  await wait(450);
  await bench.settle();
  expect(asked()).toBe(1);
  expect(panel().querySelector("[role=menu]")).toBeNull();
});

it("says where each past belief came from and when it was confirmed, and keeps placed notices placed", async () => {
  window.history.replaceState(null, "", "#you-travel");
  const belief = (n: number, over: Record<string, unknown>) => ({
    fact: hex(n + 1000),
    kind: "situation",
    type: "situation",
    status: "active",
    disputed: false,
    provenance: "source",
    tier: "system_notice",
    source: "mail",
    values: { domain: "travel", what: `Belief ${n}` },
    confirmedAt: "2026-11-01T09:00:00Z",
    support: [hex(n)],
    supportCount: 2,
    ...over,
  });
  const answer = {
    subject: null,
    at: "2026-11-09T12:00:00Z",
    beliefs: [belief(8, {}), belief(6, {}), belief(5, { tier: "stated", provenance: "corroborated" })],
    next: null,
  };
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
    url.startsWith("/api/beliefsAsOf?")
      ? ({ ok: true, status: 200, json: async () => answer } as Response)
      : inner(url, init),
  );
  await bench.show();
  await click(buttonOf(panel().querySelector(".ph") as Element, "As of today"));
  await click(buttonOf(panel(), "A week ago"));
  const subs = [...panel().querySelectorAll(".row .s")].map((one) => one.textContent);
  // The notice the owner placed in Travel stays there; the one never placed is Housekeeping's.
  expect(subs).toHaveLength(2);
  expect(subs[0]).toMatch(/^From mail · confirmed .+ · said 2 times$/);
  expect(subs[1]).toMatch(/^From more than one source · confirmed /);
});

it("says the owner's own words as theirs, where they said them", () => {
  const one = detail(2, "Find a cofounder") as unknown as FactDetail;
  expect(saidByOf(true, one).startsWith("You, in mail")).toBe(true);
  expect(saidByOf(false, one).startsWith("You")).toBe(false);
});
