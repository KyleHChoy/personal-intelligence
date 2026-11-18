// @vitest-environment jsdom
import { FactDetail, OwnerDraft, OwnerMeeting } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DraftShown, FactSheet, MeetingSheet, MessageText } from "./opened.tsx";
import { internalsOn } from "./test-support/internals.ts";
import { ToastProvider } from "./toast.tsx";

// The reader loads the first time one opens: loaded once here, so a test's
// click opens one within its act.
beforeAll(async () => {
  await import("./opened.tsx");
});

// A fact opened in place carries its status and the owner's rulings; a
// timeline's meeting opens to what it was. Made-up values only.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const at = "2026-10-20T09:00:00.000Z";
const FACT = hex(71);
const DETAIL = FactDetail.parse({
  fact: {
    id: FACT,
    subject: { id: `ent_${ulid(99)}`, kind: "owner", name: null, address: null },
    statedBy: null,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at,
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
  },
  factKey: hex(70),
  compartments: ["own"],
  beliefs: { audiences: 1, status: ["active"] },
  rulings: [],
  declassification: null,
  lines: [],
});
const EVENT = `evt_${ulid(5)}`;
const MEETING = OwnerMeeting.parse({
  kind: "meeting",
  meeting: {
    id: EVENT,
    title: { untrusted: "Handbook check-in" },
    startsAt: at,
    endsAt: "2026-10-20T10:00:00.000Z",
    allDay: false,
    cancelled: false,
    participants: [{ id: `ent_${ulid(7)}`, kind: "person", name: { untrusted: "Person Seven" }, address: null }],
    response: "accepted",
  },
});

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
beforeEach(() => {
  calls = [];
  answers = {
    [`/api/factShow?fact=${FACT}`]: { status: 200, body: DETAIL },
    [`/api/meeting?meeting=${EVENT}`]: { status: 200, body: MEETING },
    "/api/session": { status: 200, body: { token: "form-token-1" } },
    "/api/rejectClaim": { status: 200, body: { result: `rul_${ulid(9)}` } },
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers[url];
    return answer === undefined ? reply(404, { refused: "not_here" }) : reply(answer.status, answer.body);
  });
});
let root: Root;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function show(element: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ToastProvider, null, element)));
  await settle();
  await settle();
}
const button = (text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll("button")].find((one) => one.textContent === text);
  if (found === undefined) throw new Error(`no ${text} button`);
  return found;
};

it("shows a fact's status and the rulings Self and People give it, each told with Undo", async () => {
  await show(createElement(FactSheet, { fact: FACT, onClose: () => {} }));
  const sheet = host.querySelector(".reader") as HTMLElement;
  expect(sheet.textContent).toContain("StatusIn force");
  for (const one of ["Edit", "No longer true", "Not true", "Ask an agent to check it", "Never use it", "Close"])
    expect(button(one)).toBeDefined();
  // One body in place: one action bar, last; nothing over the page.
  expect(sheet.querySelectorAll(".actbar")).toHaveLength(1);
  expect(sheet.lastElementChild?.classList.contains("actbar")).toBe(true);
  expect(host.querySelector("dialog, [role=dialog]")).toBeNull();
  // Asking an agent opens the task box in place; Cancel goes back to the rulings.
  await act(async () => button("Ask an agent to check it").click());
  expect(sheet.querySelector("textarea")).not.toBeNull();
  await act(async () => button("Cancel").click());
  await act(async () => button("Not true").click());
  await settle();
  expect(calls.find((call) => call.url === "/api/rejectClaim")?.body).toMatchObject({ fact: FACT });
  expect(sheet.textContent).toContain("Not true. It applies at the next run.");
  expect(host.querySelector(".toast")?.textContent).toContain("Undo");
  expect(internalsOn(host)).toEqual([]);
});

it("opens a meeting to its title, when, who and the answer from the owner", async () => {
  await show(createElement(MeetingSheet, { meeting: EVENT, onClose: () => {} }));
  const sheet = host.querySelector(".reader") as HTMLElement;
  expect(sheet.querySelector("h3")?.textContent).toBe("Handbook check-in");
  expect(sheet.textContent).toContain("WithPerson Seven");
  expect(sheet.textContent).toContain("Your answerGoing");
  expect(internalsOn(host)).toEqual([]);
});

// A draft names each recipient the owner knows with the address, and gives the exact send
// command, with the flags `pi send show` names.
it("names a draft's recipients and gives the exact send command", async () => {
  const draft = `drf_${ulid(11)}`;
  answers[`/api/draft?draft=${draft}`] = {
    status: 200,
    body: OwnerDraft.parse({
      id: draft,
      status: "made",
      at,
      account: "personal",
      to: [{ untrusted: "dana@example.test" }, { untrusted: "lee@example.test" }],
      cc: [],
      subject: { untrusted: "The venue" },
      text: { untrusted: "Hello" },
      newThread: true,
      names: [{ address: { untrusted: "dana@example.test" }, name: { untrusted: "Dana Example" } }],
      firstContact: true,
    }),
  };
  await show(createElement(DraftShown, { draft }));
  expect(host.textContent).toContain("ToDana Example <dana@example.test>, lee@example.test");
  expect([...host.querySelectorAll(".cmdline")].map((one) => one.textContent)).toEqual([
    `pi-send send show ${draft}`,
    `pi-send send draft ${draft} --code CODE --first-contact --new-thread`,
  ]);
});

it("opens a recorded meeting to its title, who was there and what was said, each fact opening in turn", async () => {
  const capture = `cap_${ulid(6)}`;
  answers[`/api/meeting?meeting=${capture}`] = {
    status: 200,
    body: OwnerMeeting.parse({
      kind: "captured_meeting",
      id: capture,
      title: { untrusted: "Handbook review" },
      startsAt: at,
      endsAt: "2026-10-20T09:40:00.000Z",
      participants: [{ id: `ent_${ulid(7)}`, kind: "person", name: { untrusted: "Person Seven" }, address: null }],
      facts: [{ id: FACT, words: { untrusted: "window seats" } }],
    }),
  };
  await show(createElement(MeetingSheet, { meeting: capture, onClose: () => {} }));
  const sheet = host.querySelector(".reader") as HTMLElement;
  expect(sheet.querySelector("h3")?.textContent).toBe("Handbook review");
  expect(sheet.textContent).toContain("WithPerson Seven");
  expect(sheet.textContent).toContain("What was saidwindow seats");
  expect(internalsOn(host)).toEqual([]);
  await act(async () => button("window seats").click());
  await settle();
  expect(calls.map((call) => call.url)).toContain(`/api/factShow?fact=${FACT}`);
  expect(host.querySelector(".reader")?.getAttribute("aria-label")).toBe("A fact");
  // Closed, the fact goes back to the meeting, to open the next.
  await act(async () => button("Close").click());
  await settle();
  expect(host.querySelector(".reader")?.getAttribute("aria-label")).toBe("A meeting");
});

it("shows a message's own words first, and the quoted thread and signature only when asked", async () => {
  const text = [
    "Where is the best place to park?",
    "",
    "On Wed, Aug 5, 2026 at 4:02 PM Someone wrote:",
    "> Earlier words",
  ].join("\n");
  const box = document.createElement("div");
  document.body.append(box);
  const own = createRoot(box);
  await act(async () => own.render(createElement(MessageText, { text })));
  expect(box.querySelector(".text")?.textContent).toBe("Where is the best place to park?");
  const more = box.querySelector<HTMLButtonElement>("button.more");
  expect(more?.textContent).toBe("Show the whole message");
  await act(async () => more?.click());
  expect(box.querySelector(".text")?.textContent).toContain("> Earlier words");
  await act(async () => own.unmount());
  box.remove();
});

it("never opens a forwarded message to an empty box", async () => {
  const text = ["> Earlier words first", "> and more of them", "", "Thanks"].join("\n");
  const box = document.createElement("div");
  document.body.append(box);
  const own = createRoot(box);
  await act(async () => own.render(createElement(MessageText, { text })));
  expect(box.querySelector(".text")?.textContent).toContain("> Earlier words first");
  await act(async () => own.unmount());
  box.remove();
});
