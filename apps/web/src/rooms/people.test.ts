// @vitest-environment jsdom
import {
  EntityPageView,
  NetworkView,
  OwnerNoteView,
  OwnerPaths,
  OwnerTimeline,
  PersonPanel,
  WeekEvents,
} from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { beforeAll, expect, it, vi } from "vitest";
import { GoContext, OpenRows } from "../parts.tsx";
import { roomHarness } from "../test-support/room-harness.ts";
import { MapRoom } from "./map.tsx";
import { People } from "./people.tsx";
import { ownTiePath, pathsOr, type Ties } from "./people-parts.tsx";

// The People room and the Map from small fixtures shaped like the contracts' reads: neutral
// made-up values. Each test pins one behaviour of the approved design: rows open in
// place, the person's menu opens under its head, nothing slides over the page, and every person
// write keeps its request shape.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(async () => {
  await import("../opened.tsx");
});

const NOW = new Date("2026-10-20T12:00:00Z");
const at = "2026-10-18T09:00:00Z";
const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const ent = (n: number): string => `ent_${ulid(n)}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const MARKUP = '<img src=x onerror="alert(1)"><b>bold</b>';
const [OWNER, ONE, TWO, ORG] = [ent(100), ent(1), ent(2), ent(4)];
const ORG_AT = { id: ORG, name: { untrusted: "An Organization" } };

const tierRow = (entity: string, name: string, tier: string, dormant = false, organization: unknown = null) => ({
  entity,
  name,
  tier,
  tierSource: "inferred",
  dormant,
  lastTwoWayAt: at,
  organization,
});
// Seven regulars, so a tier has more than its first five.
const TIERS = {
  people: [
    tierRow(ONE, MARKUP, "inner", false, ORG_AT),
    tierRow(TWO, "Person Two", "close", false, ORG_AT),
    ...Array.from({ length: 7 }, (_, index) => tierRow(ent(10 + index), `Regular ${index + 1}`, "regular")),
    tierRow(ent(30), "Person Dormant", "close", true),
  ],
  next: null,
};
const LISTS = [{ id: `lst_${ulid(1)}`, name: "A list", members: [TWO] }];
const who = (id: string, name: string) => ({ id, kind: "person", name: { untrusted: name }, address: null });
const PERSON = PersonPanel.parse({
  who: who(ONE, MARKUP),
  warmth: {
    tier: "inner",
    tierSource: "inferred",
    dormant: false,
    warmth: 4,
    active: 1,
    depth: 1,
    firstTwoWayAt: "2024-03-01T09:00:00Z",
    lastTwoWayAt: at,
    replyRate: 0.82,
    replyHours: 3,
    theyStart: 0.5,
    channels: ["email"],
    stale: false,
    rebuilding: false,
  },
  ruledTier: null,
  commitments: { owedByOwner: 0, owedToOwner: 0 },
  lead: { tie: null, lastContact: null, lastThread: null, lastChat: null, lastMeeting: null },
  identityRulings: [`rul_${ulid(1)}`],
  ignoreRuling: null,
  nameRuling: null,
});
const fact = (id: number, title: string) => ({
  id: hex(id),
  type: "role",
  subject: who(ONE, "Person One"),
  statedBy: null,
  basis: "third_party",
  statementKind: "stated_fact",
  at,
  message: `msg_${ulid(id)}`,
  source: "mail",
  thirdParty: true,
  agentReported: false,
  provenance: "source",
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  fields: { title: { untrusted: title } },
});
const ENTITY = EntityPageView.parse({
  entity: who(ONE, "Person One"),
  facts: {
    beliefs: [
      {
        fact: hex(11),
        state: hex(12),
        kind: "role",
        type: "role",
        status: "active",
        disputed: false,
        provenance: "source",
        confirmedAt: at,
        reviewAfter: null,
        subject: who(ONE, "Person One"),
        values: {},
        cites: [fact(10, "Head of research"), fact(13, "Head of research")],
      },
    ],
    claims: [],
    more: false,
  },
});
const TIMELINE = OwnerTimeline.parse({
  month: "2026-10",
  entries: [{ kind: "mail", id: `msg_${ulid(2)}`, at, title: { untrusted: "The outline" } }],
  next: null,
});
const NOTES = OwnerNoteView.array().parse([
  { note: hex(1), role: "note", text: "Met at the conference", compartments: ["own"], at },
]);
const day = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const WEEK = WeekEvents.parse({
  events: [
    {
      id: `evt_${ulid(7)}`,
      title: { untrusted: "Lunch together" },
      startsAt: "2026-10-22T12:00:00Z",
      endsAt: null,
      allDay: false,
      cancelled: false,
      participants: [who(ONE, "Person One")],
    },
  ],
  more: false,
});
const node = (id: string, kind: string, name: string | null, tier: string | null) => ({
  id,
  kind,
  name: name === null ? null : { untrusted: name },
  tier,
  dormant: false,
  warmth: null,
});
const NETWORK = NetworkView.parse({
  nodes: [
    node(OWNER, "owner", null, null),
    node(ONE, "person", "Person One", "inner"),
    node(ORG, "organization", "An Organization", null),
  ],
  edges: [
    { from: OWNER, to: ONE, kind: "tie", weight: 1, fact: null },
    { from: ONE, to: ORG, kind: "affiliation", weight: 1, fact: hex(14) },
  ],
  more: false,
});
const NO_PATHS = OwnerPaths.parse({ paths: [] });

const ok = (body: unknown) => ({ status: 200, body });
const WRITES = [
  "setTier",
  "clearTier",
  "ignorePerson",
  "addToList",
  "createList",
  "deleteList",
  "rejectClaim",
  "addNote",
  "retireNote",
  "addTask",
];
const bench = roomHarness(
  NOW,
  () => createElement(OpenRows, null, createElement(People)),
  () => ({
    "/api/session": ok({ token: "form-token-1" }),
    "/api/peopleTiers?limit=200": ok(TIERS),
    "/api/lists": ok(LISTS),
    [`/api/person?entity=${ONE}`]: ok(PERSON),
    [`/api/entityPage?entity=${ONE}`]: ok(ENTITY),
    [`/api/timeline?entity=${ONE}`]: ok(TIMELINE),
    [`/api/notes?person=${ONE}`]: ok(NOTES),
    [`/api/weekEvents?from=${day(NOW)}&to=${day(new Date(NOW.getTime() + 7 * 86_400_000))}`]: ok(WEEK),
    "/api/goals": ok({ goals: [] }),
    "/api/projects": ok({ at, projects: [], areas: [], more: false }),
    "/api/network?tiers=inner%2Cclose%2Cregular": ok(NETWORK),
    [`/api/paths?target=${ONE}`]: ok(NO_PATHS),
    ...Object.fromEntries(WRITES.map((name) => [`/api/${name}`, ok({ result: `rul_${ulid(900)}` })])),
  }),
);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const host = (): HTMLElement => bench.host;
const posted = (name: string): number => bench.calls.filter((call) => call === `POST /api/${name}`).length;
const button = (text: string, within: Element = host()): HTMLElement => {
  const found = [...within.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"]')].find((one) =>
    (one.getAttribute("aria-label") ?? one.querySelector(".t")?.textContent ?? one.textContent ?? "")
      .trim()
      .startsWith(text),
  );
  if (found === undefined) throw new Error(`no ${text} button`);
  return found;
};
const click = async (target: Element): Promise<void> => {
  await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
};
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  await settle();
}
const phone = (on: boolean): void => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
};
const noSheet = (): void => expect(host().querySelector(".sheet, .overlay, [role='dialog']")).toBeNull();
const show = (view?: string, want: { id: string; name: string | null; at: number } | null = null) =>
  bench.show(createElement(OpenRows, null, createElement(People, { view, want })));

it("lists people by tier, a name's markup as text, five a tier until Show all, and a filter by name", async () => {
  await show();
  const text = host().textContent ?? "";
  expect(text).toContain("Inner · 1");
  expect(text).toContain("Regular · 7");
  expect(text).toContain("Dormant · 1");
  expect(host().querySelector("img, b")).toBeNull();
  expect(text).not.toContain("Regular 6");
  await click(button("Show all 7"));
  expect(host().textContent).toContain("Regular 7");
  await type(host().querySelector("input") as HTMLInputElement, "two");
  expect(host().querySelectorAll(".plist .row")).toHaveLength(1);
});

it("opens the first person beside the list on the desk: head as plain text, the three figures, coming up, believed, lately, notes", async () => {
  await show();
  const person = host().querySelector(".panel.person") as HTMLElement;
  expect(person.querySelector("h2")?.textContent).toBe(MARKUP);
  expect(person.querySelector(".person-head .lead2")?.textContent).toBe("Inner tier · An Organization");
  expect([...person.querySelectorAll(".person-figs .k")].map((one) => one.textContent)).toEqual([
    "Last contact",
    "Replies",
    "Known since",
  ]);
  expect(person.querySelector(".person-figs")?.textContent).toContain("82%");
  for (const words of [
    "Coming up",
    "Lunch together",
    "Believed",
    "Head of research",
    "Lately",
    "The outline",
    "Met at the conference",
  ])
    expect(person.textContent).toContain(words);
  expect(person.querySelector(".chip, .pill")).toBeNull();
});

it("opens a belief in place to what it rests on, Edit and the quiet It's not true, which rules it", async () => {
  await show();
  await click(button("Head of research"));
  const body = host().querySelector("[data-open^='fact-']") as HTMLElement;
  expect(body.textContent).toContain("What it rests on");
  expect(body.querySelectorAll(".rests li")).toHaveLength(2);
  expect(button("Edit", body).className).toContain("go");
  expect(button("It's not true", body).className).toContain("lnk");
  noSheet();
  await click(button("Ask an agent to check it", body));
  // What it is about is shown above the note, never put in it: the note is the owner's own words.
  expect(body.querySelector(".lead2")?.textContent).toContain("Head of research");
  expect((body.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  await click(button("Cancel", body));
  await click(button("It's not true", body));
  expect(posted("rejectClaim")).toBe(1);
});

it("opens the menu's choices under the head: Change tier sets it, Not someone I know removes them", async () => {
  await show();
  await click(button("More for"));
  const items = [...host().querySelectorAll("[role='menuitem']")].map((one) => one.textContent);
  expect(items).toEqual([
    "Change tier",
    "Add to a list",
    "Records joined into them",
    "Edit their name",
    "Not someone I know",
  ]);
  await click(button("Change tier"));
  const inline = host().querySelector(".person-inline") as HTMLElement;
  expect(inline).not.toBeNull();
  noSheet();
  await click(button("Close", inline));
  expect(posted("setTier")).toBe(1);
  expect(host().querySelector(".person-inline")).toBeNull();

  await click(button("More for"));
  await click(button("Records joined into them"));
  expect(host().querySelector(".person-inline")?.textContent).toContain("Your ruling 1");

  await click(button("More for"));
  await click(button("Not someone I know"));
  expect(posted("ignorePerson")).toBe(1);
});

it("adds them to a list from the menu, in place", async () => {
  await show();
  await click(button("More for"));
  await click(button("Add to a list"));
  await click(button("A list", host().querySelector(".person-inline") as HTMLElement));
  expect(posted("addToList")).toBe(1);
});

it("replaces Ask an agent about them with a task box where it was asked, and edits a note in place", async () => {
  await show();
  await click(button("Ask an agent about them"));
  expect(host().querySelector(".panel.person textarea")).not.toBeNull();
  noSheet();
  await click(button("Met at the conference"));
  const field = host().querySelector(".panel.person .exp textarea") as HTMLTextAreaElement;
  expect(field.value).toBe("Met at the conference");
});

it("shows a person as a page of its own on the phone, with a back link and no list", async () => {
  phone(true);
  await show(undefined, { id: ONE, name: null, at: 0 });
  expect(button("People").className).toBe("backlink");
  expect(host().querySelector(".plist")).toBeNull();
  expect(host().querySelector("h2")?.textContent).toBe(MARKUP);
  const went: unknown[] = [];
  await bench.hide();
  await bench.show(
    createElement(
      GoContext.Provider,
      { value: (route: unknown) => went.push(route) },
      createElement(OpenRows, null, createElement(People, { want: { id: ONE, name: null, at: 0 } })),
    ),
  );
  await click(button("People"));
  expect(went).toEqual([{ room: "People", view: "everyone", person: null }]);
  vi.unstubAllGlobals();
});

it("opens an organization in place to its people and Ask an agent about it", async () => {
  await show("orgs");
  await click(button("An Organization"));
  const body = host().querySelector("[data-open^='org-']") as HTMLElement;
  expect(body.textContent).toContain("2 of your people are there");
  expect(body.textContent).toContain("Person Two");
  expect(button("Ask an agent about it", body)).toBeTruthy();
});

it("opens a list to its members with a quiet Delete the list that asks once, and makes a list in place", async () => {
  await show("lists");
  await click(button("A list"));
  const body = host().querySelector("[data-open^='list-']") as HTMLElement;
  expect(body.textContent).toContain("Person Two");
  expect(button("Delete the list", body).className).toContain("danger");
  await click(button("Delete the list", body));
  await click(button("Delete the list", host().querySelector("[data-open^='list-']") as HTMLElement));
  expect(posted("deleteList")).toBe(1);

  await click(button("Make a list"));
  await type(host().querySelector(".exp input") as HTMLInputElement, "Founders");
  await click(button("Save"));
  expect(posted("createList")).toBe(1);
});

it("draws the map on the desk and the phone; a node chosen is where Find a path goes", async () => {
  await bench.show(createElement(MapRoom, { focus: null, onOpenPerson: () => {} }));
  expect(host().querySelectorAll("svg.map .node")).toHaveLength(3);
  await click(host().querySelector("svg.map .node[aria-label='Person One']") as Element);
  expect(bench.calls).toContain(`GET /api/paths?target=${ONE}`);
  const drawnAt = () => host().querySelector("svg.map > g")?.getAttribute("transform");
  const fitted = drawnAt();
  await click(button("Zoom in"));
  expect(drawnAt()).not.toBe(fitted);
  await click(button("Fit"));
  expect(drawnAt()).toBe(fitted);
  await click(button("Hide organizations"));
  expect(host().querySelectorAll("svg.map .node")).toHaveLength(2);
  // The paths read found none: the owner's own tie on the map is the path.
  expect(host().textContent).toContain("In touch with you · Inner");
  await bench.hide();
  phone(true);
  await bench.show(createElement(MapRoom, { focus: null, onOpenPerson: () => {} }));
  expect(host().querySelector("svg.map")).not.toBeNull();
  vi.unstubAllGlobals();
});

it("says who the chosen node is, how it is linked, the key, and opens an organization in place", async () => {
  bench.answers[`/api/paths?target=${ORG}`] = ok(NO_PATHS);
  await bench.show(createElement(MapRoom, { focus: null, onOpenPerson: () => {} }));
  expect(host().textContent).toContain("○ a person · □ an organization");
  await click(host().querySelector("svg.map .node[aria-label='Person One']") as Element);
  expect(host().textContent).toContain("Person One · Inner tier");
  expect(host().textContent).toContain("How they are linked");
  expect(button("An Organization").textContent).toContain("Works there");
  await click(host().querySelector("svg.map .node[aria-label='An Organization']") as Element);
  expect(host().textContent).toContain("People there");
  expect(host().textContent).toContain("Known about it");
  // The last Person One is the organization's own row, after the path's.
  await click(
    [...host().querySelectorAll("button.row")]
      .filter((one) => one.textContent?.includes("Person One"))
      .at(-1) as Element,
  );
  expect(button("Show on the map")).toBeTruthy();
  noSheet();
});

it("shows one tier with the Group choice, and sets a tier when someone is dropped on it", async () => {
  await show();
  await click(button("Regular", host().querySelector("[aria-label='Group']") as HTMLElement));
  expect(host().textContent).toContain("Regular 7");
  expect(host().textContent).not.toContain("Person Two");
  await click(button("By tier"));
  const row = [...host().querySelectorAll(".plist .row")].find((one) =>
    one.textContent?.includes("Person Two"),
  ) as HTMLElement;
  await act(async () => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
  await settle();
  const inner = host().querySelector("[data-drop='inner']") as HTMLElement;
  await act(async () => inner.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
  await settle();
  expect(posted("setTier")).toBe(1);
});

it("takes the owner's own tie as a path, else one through someone of theirs at the organization", () => {
  const ties = { nodes: Object.fromEntries(NETWORK.nodes.map((one) => [one.id, one])), edges: NETWORK.edges } as Ties;
  expect(ownTiePath(ties, ONE)?.nodes.map((one) => one.id)).toEqual([OWNER, ONE]);
  expect(ownTiePath(ties, ORG)?.nodes.map((one) => one.id)).toEqual([OWNER, ONE, ORG]);
  expect(pathsOr([], ties, TWO)).toEqual([]);
});

// ---------- What the rebuild dropped, restored ----------

it("lists the paths to them through others under You know them through, the owner as You", async () => {
  bench.answers[`/api/paths?target=${ONE}`] = ok(
    OwnerPaths.parse({
      paths: [
        {
          nodes: [
            node(OWNER, "owner", null, null),
            node(TWO, "person", "Person Two", "close"),
            node(ONE, "person", "Person One", "inner"),
          ],
          edges: [
            { from: OWNER, to: TWO, kind: "tie", weight: 1, fact: null },
            { from: TWO, to: ONE, kind: "tie", weight: 0.5, fact: null },
          ],
          weakest: 0.5,
        },
      ],
    }),
  );
  await show();
  const person = host().querySelector(".panel.person") as HTMLElement;
  expect(person.textContent).toContain("You know them through");
  expect(person.textContent).toContain("You → Person Two → Person One");
  expect(person.textContent).toContain("2 steps");
});

it("says who starts, the channels, and opens the last email and meeting in place", async () => {
  bench.answers[`/api/person?entity=${ONE}`] = ok(
    PersonPanel.parse({
      ...PERSON,
      lead: {
        ...PERSON.lead,
        lastThread: { message: `msg_${ulid(3)}`, at, subject: { untrusted: "Quarterly notes" } },
        lastMeeting: { meeting: `mtg_${ulid(4)}`, at, title: { untrusted: "Planning call" } },
      },
    }),
  );
  await show();
  const person = host().querySelector(".panel.person") as HTMLElement;
  for (const words of ["Who starts", "Each of you, half the time", "Channels", "Email"])
    expect(person.textContent).toContain(words);
  expect(button("Quarterly notes", person).textContent).toContain("Last email");
  expect(button("Planning call", person).textContent).toContain("Last meeting");
  await click(button("Quarterly notes", person));
  expect(host().querySelector("[data-open^='item-message-']")).not.toBeNull();
  noSheet();
});

it("heads them with the address, Dormant, their lists and a pending tier, and opens their organization in place", async () => {
  bench.answers[`/api/person?entity=${ONE}`] = ok(
    PersonPanel.parse({
      ...PERSON,
      who: { ...PERSON.who, address: { untrusted: "one@example.test" } },
      warmth: { ...PERSON.warmth, dormant: true },
      ruledTier: "close",
    }),
  );
  bench.answers["/api/lists"] = ok([{ id: `lst_${ulid(1)}`, name: "A list", members: [ONE] }]);
  const went: unknown[][] = [];
  await bench.show(
    createElement(
      GoContext.Provider,
      { value: (...args: unknown[]) => went.push(args) },
      createElement(OpenRows, null, createElement(People)),
    ),
  );
  const head = host().querySelector(".person-head") as HTMLElement;
  for (const words of ["one@example.test", "Dormant", "On A list", "Your tier applies at the next run."])
    expect(head.textContent).toContain(words);
  await click(button("An Organization", head));
  expect(went).toEqual([[{ room: "People", view: "orgs", person: null }, `org-${ORG}`]]);
});

it("shows where someone opened from search works, from what is believed of them", async () => {
  const OTHER = ent(50);
  bench.answers[`/api/person?entity=${OTHER}`] = ok(PersonPanel.parse({ ...PERSON, who: who(OTHER, "Person Fifty") }));
  const page = ENTITY as NonNullable<typeof ENTITY>;
  const [belief] = page.facts.beliefs;
  bench.answers[`/api/entityPage?entity=${OTHER}`] = ok(
    EntityPageView.parse({
      ...page,
      entity: who(OTHER, "Person Fifty"),
      facts: {
        ...page.facts,
        beliefs: [
          {
            ...belief,
            kind: "affiliation",
            type: "affiliation",
            values: {
              relation: "employee",
              organization: { id: ORG, kind: "organization", name: { untrusted: "Elsewhere Ltd" }, address: null },
            },
          },
        ],
      },
    }),
  );
  await show(undefined, { id: OTHER, name: "Person Fifty", at: 1 });
  expect(host().querySelector(".person-head .lead2")?.textContent).toContain("Elsewhere Ltd");
});

it("lists bios first with each note's date, and writes a new one as a bio when asked", async () => {
  bench.answers[`/api/notes?person=${ONE}`] = ok(
    OwnerNoteView.array().parse([
      { note: hex(1), role: "note", text: "Met at the conference", compartments: ["own"], at },
      { note: hex(2), role: "bio", text: "Runs a research group", compartments: ["own"], at: "2026-09-01T09:00:00Z" },
    ]),
  );
  await show();
  const person = host().querySelector(".panel.person") as HTMLElement;
  const notes = [...person.querySelectorAll("button.row .t")].map((one) => one.textContent);
  expect(notes.indexOf("Runs a research group")).toBeLessThan(notes.indexOf("Met at the conference"));
  expect(button("Runs a research group", person).textContent).toContain("Bio, yours ·");
  await click(button("Add a note", person));
  await click(button("Bio", person));
  expect(person.querySelector(".exp textarea")?.getAttribute("aria-label")).toBe(`A bio of ${MARKUP}`);
  await type(person.querySelector(".exp textarea") as HTMLTextAreaElement, "Leads the lab");
  await click(button("Save", person));
  expect(posted("addNote")).toBe(1);
});

it("groups the timeline by month and reads the next page with Older", async () => {
  const cursor = "page-2";
  bench.answers[`/api/timeline?entity=${ONE}`] = ok(OwnerTimeline.parse({ ...TIMELINE, next: cursor }));
  bench.answers[`/api/timeline?entity=${ONE}&cursor=${cursor}`] = ok(
    OwnerTimeline.parse({
      month: "2026-09",
      entries: [
        { kind: "mail", id: `msg_${ulid(5)}`, at: "2026-09-10T09:00:00Z", title: { untrusted: "An older thread" } },
      ],
      next: null,
    }),
  );
  await show();
  const person = host().querySelector(".panel.person") as HTMLElement;
  const october = new Date(2026, 9, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  expect(person.textContent).toContain(october);
  expect(person.textContent).not.toContain("An older thread");
  await click(button("Older", person));
  expect(bench.calls).toContain(`GET /api/timeline?entity=${ONE}&cursor=${cursor}`);
  expect(person.textContent).toContain("An older thread");
  expect(() => button("Older", person)).toThrow();
});

it("draws each row on Everyone as the mockup does: initials, the name, when last in touch", async () => {
  await show();
  const list = host().querySelector(".plist") as HTMLElement;
  const two = [...list.querySelectorAll("button.row")].find((one) =>
    one.textContent?.includes("Person Two"),
  ) as HTMLElement;
  expect(two.querySelector(".av")?.textContent).toBe("PT");
  // Removing someone is the person's ··· menu (Not someone I know), never a button on every row.
  expect(list.textContent).not.toContain("Remove");
});
