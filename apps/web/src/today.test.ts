// @vitest-environment jsdom
import {
  AgentActivity,
  CardDetail,
  CardsWithLines,
  GoalWork,
  LearnedSince,
  OwnerCommitments,
  OwnerGoals,
  OwnerOpenItems,
  OwnerResults,
  WeekEvents,
} from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { OpenRows } from "./parts.tsx";
import { ResultRow } from "./results.tsx";
import { RAW_CARDS, RAW_RESULTS } from "./test-support/raw-cards.ts";
import { roomHarness } from "./test-support/room-harness.ts";
import { Today } from "./today.tsx";

// The Today room from small fixtures, parsed by the contracts' shapes: For you is one
// list of rows led by verbs, each opening in place; the Schedule switches days and opens an event to
// who, prep and Join only for a link on the host list; Goals opens to its work.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = new Date(2026, 9, 29, 10, 0);
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const MARKUP = '<img src=x onerror="alert(1)">';
const raw = (kind: string) => {
  const found = RAW_CARDS.find((one) => one.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} card`);
  return found;
};
const ABOUT = raw("about_you");
const PROPOSAL = raw("goal_proposal");
const person = (n: number, name: string) => ({
  id: `ent_${ulid(n)}`,
  kind: "person",
  name: { untrusted: name },
  address: null,
});

const COMMITMENT = {
  item: {
    belief: {
      fact: hex(1),
      state: hex(101),
      kind: "commitment",
      type: "commitment",
      status: "active",
      disputed: false,
      provenance: "source",
      confirmedAt: "2026-10-01T09:00:00Z",
      reviewAfter: null,
    },
    direction: "owed_by_owner",
    counterparty: person(9, "Person Nine"),
    due: "2026-10-27",
    what: { untrusted: "Send the deck to Person Nine" },
    source: "mail",
    message: `msg_${ulid(1)}`,
    capture: null,
    segment: null,
  },
  lateDays: 2,
  ageDays: 4,
  stale: false,
  verb: "Send",
  rest: { untrusted: "the deck to Person Nine" },
};
const GOAL = `gol_${ulid(50)}`;

const bench = roomHarness(
  NOW,
  () => createElement(OpenRows, null, createElement(Today, {})),
  () => ({
    "/api/cardsWithLines": { status: 200, body: CardsWithLines.parse({ cards: [ABOUT, PROPOSAL], next: null }) },
    [`/api/card?card=${ABOUT.id}`]: { status: 200, body: CardDetail.parse(ABOUT) },
    "/api/agentActivity": {
      status: 200,
      body: AgentActivity.parse({ needsYou: { cards: [], handedToYou: [] }, working: [], finished: [], blocked: [] }),
    },
    "/api/commitments?state=open&limit=200": {
      status: 200,
      body: OwnerCommitments.parse({ commitments: [COMMITMENT], next: null }),
    },
    "/api/openItems": {
      status: 200,
      body: OwnerOpenItems.parse({
        items: [
          {
            what: COMMITMENT.item.what,
            due: COMMITMENT.item.due,
            source: { kind: "commitment", id: hex(1), message: `msg_${ulid(1)}` },
            whoActs: { id: `ent_${ulid(99)}`, kind: "owner", name: null, address: null },
            project: null,
            overdue: true,
            lateDays: 2,
            verb: "Send",
            rest: COMMITMENT.rest,
          },
        ],
        more: false,
      }),
    },
    "/api/weekEvents?from=2026-10-29&to=2026-11-04": {
      status: 200,
      body: WeekEvents.parse({
        events: [
          {
            id: `evt_${ulid(40)}`,
            title: { untrusted: "Call with Person Nine" },
            startsAt: at(60),
            endsAt: at(90),
            allDay: false,
            cancelled: false,
            participants: [person(9, "Person Nine")],
            callLink: { untrusted: "https://meet.google.com/abc-defg-hij" },
            inviteLink: { untrusted: "https://evil.example.net/invite" },
          },
          {
            id: `evt_${ulid(41)}`,
            title: { untrusted: MARKUP },
            startsAt: at(60 * 24),
            endsAt: at(60 * 25),
            allDay: false,
            cancelled: false,
            participants: [],
          },
        ],
        more: false,
      }),
    },
    "/api/results?limit=20": {
      status: 200,
      body: OwnerResults.parse({
        results: [],
        next: null,
        unopened: [
          {
            move: `mov_${ulid(70)}`,
            opportunity: `opp_${ulid(70)}`,
            kind: "research",
            agent: "agent-one",
            about: { kind: "entity", id: `ent_${ulid(9)}`, name: { untrusted: "Person Nine" } },
            doneAt: at(-60),
            outcome: "found",
            headline: { untrusted: "Leads partnerships at a lab" },
          },
          {
            move: `mov_${ulid(71)}`,
            opportunity: `opp_${ulid(71)}`,
            kind: "research",
            agent: "agent-one",
            about: { kind: "entity", id: `ent_${ulid(8)}`, name: { untrusted: "Person Eight" } },
            doneAt: at(-60),
            outcome: "stopped",
            headline: null,
          },
        ],
      }),
    },
    "/api/goals": {
      status: 200,
      body: OwnerGoals.parse({
        goals: [
          {
            goal: {
              id: GOAL,
              statement: { untrusted: "Find a full-time role" },
              status: "active",
              setAt: at(-60 * 24 * 40),
            },
            domain: null,
            target: { ...person(9, "Person Nine"), kind: "organization" },
            setBy: "owner",
          },
        ],
      }),
    },
    [`/api/goalWork?goal=${GOAL}`]: {
      status: 200,
      body: GoalWork.parse({
        work: [],
        next: { kind: "event", at: at(60), opportunity: null, card: null, event: `evt_${ulid(40)}` },
        proposals: [],
      }),
    },
    "/api/session": { status: 200, body: { token: "form-token-1" } },
    "/api/decide": { status: 200, body: { result: [{ ruling: "rul_1" }] } },
  }),
);

const panel = (title: string): HTMLElement => {
  const heading = [...bench.host.querySelectorAll("h2")].find((one) => one.textContent === title);
  const section = heading?.closest("section");
  if (section == null) throw new Error(`no ${title} panel`);
  return section;
};
const button = (within: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((one) =>
    one.textContent?.includes(text),
  );
  if (found === undefined) throw new Error(`no ${text} button`);
  return found;
};
const click = async (target: HTMLElement) => {
  await act(async () => target.click());
  await bench.settle();
};

it("lists For you as rows led by verbs, the late owed item in amber meta", async () => {
  await bench.show();
  const list = panel("For you");
  const verbs = [...list.querySelectorAll(".verb")].map((one) => one.textContent);
  expect(verbs).toEqual(["Answer", "Approve", "Send", "Read"]);
  const owed = button(list, "the deck to Person Nine");
  expect(owed.querySelector(".meta.warn")?.textContent).toContain("late");
  // Status is never a chip; nothing slides over the page.
  expect(bench.host.querySelector("dialog, .bsheet, .sheet")).toBeNull();
  expect(bench.host.innerHTML).not.toContain("<img");
});

it("steps about-you questions in place, Not quite opening a field", async () => {
  await bench.show();
  await click(button(panel("For you"), "Answer"));
  const body = bench.host.querySelector<HTMLElement>(".exp");
  if (body === null) throw new Error("not opened");
  expect(body.textContent).toContain("1 of 1");
  const labels = [...body.querySelectorAll(".actbar button")].map((one) => one.textContent);
  expect(labels.slice(0, 3)).toEqual(["Yes", "Not quite", "No"]);
  // The one action bar is last.
  expect(body.querySelector(".actbar")?.nextElementSibling ?? null).toBeNull();
  await click(button(body, "Not quite"));
  expect(bench.host.querySelector(".exp input, .exp textarea")).not.toBeNull();
});

it("groups finished research about people into one Read row with headlines", async () => {
  await bench.show();
  await click(button(panel("For you"), "Read"));
  const body = bench.host.querySelector<HTMLElement>(".exp");
  expect(body?.textContent).toContain("Leads partnerships at a lab");
  expect(body?.textContent).not.toContain("Person Eight");
});

it("switches the Schedule's day and opens an event with Join only for a listed host", async () => {
  await bench.show();
  const day = panel("Schedule");
  expect([...day.querySelectorAll(".toggle button")].map((one) => one.textContent)).toEqual([
    "Today",
    "Tomorrow",
    "Week",
  ]);
  await click(button(day, "Call with Person Nine"));
  const body = day.querySelector<HTMLElement>(".exp");
  if (body === null) throw new Error("not opened");
  expect(body.querySelector(".who")?.textContent).toContain("Person Nine");
  expect(body.textContent).toContain("You owe");
  expect(body.textContent).toContain("For your goal");
  // The call is on the host list and links; the invite's host is not, so there is no Calendar.
  const links = [...body.querySelectorAll("a")];
  expect(links.map((one) => [one.textContent, one.getAttribute("href"), one.rel])).toEqual([
    ["Join Meet", "https://meet.google.com/abc-defg-hij", "noopener noreferrer"],
  ]);
  await click(button(day, "Tomorrow"));
  expect(day.textContent).toContain(MARKUP);
  expect(day.innerHTML).not.toContain("<img");
});

it("shows the active goals as Work's goal rows, opening in place to their work and actions", async () => {
  await bench.show();
  const goals = panel("Goals");
  const row = button(goals, "Find a full-time role");
  expect(row.querySelector(".meta")?.textContent).not.toBe("");
  await click(row);
  const body = goals.querySelector<HTMLElement>(".exp");
  const actions = [...(body?.querySelectorAll(".actbar button") ?? [])].map((one) => one.textContent);
  expect(actions).toEqual(expect.arrayContaining(["Edit", "Mark done", "Remove"]));
});

// ---------- What the rebuild dropped, restored ----------

// The bodies the page posts from here on, by write, through the fetch the bench stubbed.
const posted = (): Record<string, unknown>[] => {
  const sent: Record<string, unknown>[] = [];
  const was = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") sent.push({ url, ...(JSON.parse(String(init.body ?? "{}")) as object) });
    return was(url, init);
  });
  return sent;
};
const open = async (within: HTMLElement, text: string): Promise<HTMLElement> => {
  const row = button(within, text);
  await click(row);
  const body = row.nextElementSibling;
  if (!(body instanceof HTMLElement) || !body.classList.contains("exp")) throw new Error(`${text} did not open`);
  return body;
};
const FACT = {
  id: hex(71),
  subject: { id: `ent_${ulid(99)}`, kind: "owner", name: null, address: null },
  statedBy: null,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at: at(-120),
  message: null,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: false,
  agentReported: false,
  provenance: "source",
  type: "preference",
  fields: { what: { untrusted: "window seats" }, polarity: "prefers", domain: "travel" },
};
const learnedItem = (n: number, claim: unknown, subject: unknown = null) => ({
  fact: hex(n),
  kind: "preference",
  type: "preference",
  self: subject === null,
  subject,
  status: "active",
  provenance: "source",
  change: "new",
  at: at(-120),
  waiting: false,
  claim,
});
const plusDays = (n: number): Date => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
const LEARNED_URL = `/api/learnedSince?${new URLSearchParams({ at: new Date(NOW.getTime() - 86_400_000).toISOString() })}`;

it("restores what was learned since yesterday as one Check row, each fact taking its rulings", async () => {
  bench.answers[LEARNED_URL] = {
    status: 200,
    body: LearnedSince.parse({
      since: at(-60 * 24),
      items: [learnedItem(72, FACT), learnedItem(73, null, person(7, "Person Seven"))],
      next: null,
    }),
  };
  bench.answers["/api/rejectClaim"] = { status: 200, body: { result: "rul_2" } };
  await bench.show();
  const list = panel("For you");
  expect(button(list, "learned since yesterday").textContent).toContain("2 facts");
  const body = await open(list, "learned since yesterday");
  // The one the page cannot open is said once, with an agent to read it.
  expect(body.textContent).toContain("learned about Person Seven");
  expect(button(body, "Ask an agent to read it")).toBeDefined();
  const fact = await open(body, "window seats");
  const labels = [...fact.querySelectorAll(".actbar button")].map((one) => one.textContent);
  expect(labels).toEqual(
    expect.arrayContaining(["No longer true", "Not true", "Never use it", "Ask an agent to check it"]),
  );
  const sent = posted();
  await click(button(fact, "Not true"));
  expect(sent.find((one) => one.url === "/api/rejectClaim")?.fact).toBe(hex(71));
});

it("asks whether this week's results were useful, Not useful with its reason, and says who asked", async () => {
  bench.answers["/api/results?limit=20"] = {
    status: 200,
    body: OwnerResults.parse({ results: [], next: null, thisWeek: [RAW_RESULTS.results[0]] }),
  };
  bench.answers["/api/judgeResult"] = { status: 200, body: { result: null } };
  await bench.show();
  const list = panel("For you");
  expect([...list.querySelectorAll(".verb")].map((one) => one.textContent)).toContain("Answer");
  const week = await open(list, "Was this useful?");
  const result = await open(week, "Two people run it");
  expect(result.textContent).toContain("Research you asked for");
  const sent = posted();
  await click(button(result, "Not useful"));
  // Not useful asks why first; the reason goes with the answer.
  const reason = result.querySelector<HTMLButtonElement>(".whynot .reasons button");
  if (reason === null) throw new Error("no reasons");
  await click(reason);
  const judged = sent.find((one) => one.url === "/api/judgeResult");
  expect(judged?.answer).toBe("not_useful");
  expect(typeof judged?.reason).toBe("string");
  // Judged, it leaves For you.
  expect(bench.host.textContent).not.toContain("Was this useful?");
});

it("clears a judgment by pressing the answer already given", async () => {
  bench.answers["/api/judgeResult"] = { status: 200, body: { result: null } };
  const kept = OwnerResults.parse(RAW_RESULTS).results[1];
  if (kept === undefined) throw new Error("no kept result");
  await bench.show(createElement(OpenRows, null, createElement(ResultRow, { result: kept, onJudged: () => {} })));
  await click(button(bench.host, "spring bookings"));
  const sent = posted();
  await click(button(bench.host, "Kept: clear"));
  expect(sent.find((one) => one.url === "/api/judgeResult")?.answer).toBe("none");
});

it("keeps open items due later and undated next steps under a quiet Later row", async () => {
  const item = (n: number, due: string | null, kind: string, words: string) => ({
    what: { untrusted: words },
    due,
    source: { kind, id: hex(n) },
    whoActs: { id: `ent_${ulid(99)}`, kind: "owner", name: null, address: null },
    project: null,
    overdue: false,
    lateDays: null,
  });
  bench.answers["/api/openItems"] = {
    status: 200,
    body: OwnerOpenItems.parse({
      items: [item(80, "2026-11-03", "plan", "Book the venue"), item(81, null, "next_step", "Draft the outline")],
      more: false,
    }),
  };
  await bench.show();
  const list = panel("For you");
  const later = await open(list, "2 open items");
  expect(later.textContent).toContain("Book the venue");
  expect(later.textContent).toContain("Draft the outline");
});

it("lets handed work with no live card be dropped with a note and a reason", async () => {
  bench.answers["/api/agentActivity"] = {
    status: 200,
    body: AgentActivity.parse({
      needsYou: {
        cards: [],
        handedToYou: [
          {
            opportunity: `opp_${ulid(60)}`,
            kind: "research",
            task: false,
            status: "handed_to_owner",
            role: null,
            holder: "agent-one",
            move: null,
            outcome: null,
            summary: { untrusted: "Send the signed form back" },
          },
        ],
      },
      working: [],
      finished: [],
      blocked: [],
    }),
  };
  bench.answers["/api/decideHanded"] = { status: 200, body: { result: [{ card: "crd_1" }] } };
  await bench.show();
  const body = await open(panel("For you"), "Send the signed form back");
  const note = body.querySelector<HTMLInputElement>("input");
  if (note === null) throw new Error("no note");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(note, "Posted it Monday");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sent = posted();
  await click(button(body, "No, drop it"));
  const reason = body.querySelector<HTMLButtonElement>(".whynot .reasons button");
  if (reason === null) throw new Error("no reasons");
  await click(reason);
  const decided = sent.find((one) => one.url === "/api/decideHanded");
  expect(decided?.answer).toBe("dismiss");
  expect(decided?.note).toBe("Posted it Monday");
  expect(typeof decided?.reason).toBe("string");
});

it("shows the owner's reply to an invite, cancelled events struck through, an unlisted invite as text, and more", async () => {
  const event = (n: number, minutes: number, over: object) => ({
    id: `evt_${ulid(n)}`,
    title: { untrusted: `Event ${n}` },
    startsAt: at(minutes),
    endsAt: at(minutes + 30),
    allDay: false,
    cancelled: false,
    participants: [],
    ...over,
  });
  bench.answers["/api/weekEvents?from=2026-10-29&to=2026-11-04"] = {
    status: 200,
    body: WeekEvents.parse({
      events: [
        event(42, 60, { response: "tentative", inviteLink: { untrusted: "https://evil.example.net/invite" } }),
        event(43, 120, { cancelled: true }),
        event(44, 60 * 24 * 3, {}),
      ],
      more: true,
    }),
  };
  await bench.show();
  const day = panel("Schedule");
  const body = await open(day, "Event 42");
  expect(body.textContent).toContain("Your answer");
  expect(body.textContent).toContain("Maybe");
  expect(body.querySelector("code")?.textContent).toBe("https://evil.example.net/invite");
  expect(body.querySelector("a")).toBeNull();
  expect(button(day, "Event 43").querySelector("s")?.textContent).toBe("Event 43");
  expect(day.textContent).toContain("More this week than are shown.");
  // A day three days out opens, and its event opens in turn.
  await click(button(day, "Week"));
  const third = await open(day, plusDays(3).toLocaleDateString(undefined, { weekday: "short" }));
  const opened = await open(third, "Event 44");
  expect(opened.querySelector(".lead")).not.toBeNull();
});

it("says focus so far in the Schedule, opening to the day's deep work by hour and by project", async () => {
  const deep = { target: { category: "coding" }, start: at(-120), end: at(-30), minutes: 90 };
  bench.answers["/api/timeDay"] = {
    status: 200,
    body: {
      day: "2026-10-29",
      zone: null,
      halfDays: [],
      deepWork: { sessions: [deep], deepMinutes: 90 },
      proposals: [],
    },
  };
  await bench.show();
  const body = await open(panel("Schedule"), "1 h 30 min");
  expect(body.textContent).toContain("By hour");
  expect(body.querySelector(".sub-list .when")?.textContent).not.toBe("");
});
