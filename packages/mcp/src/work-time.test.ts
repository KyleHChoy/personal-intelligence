import {
  CommitmentList,
  ContextPack,
  EntityView,
  SelfView,
  TimelineView,
  type WorkNow,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  handleAtOnce as handle,
  NO_WORK,
  readResult,
  request,
  rpcError,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";

// The agent API's half of work time. The four read tools that serve it say what its minutes are and
// are not, and their result schemas take the new fields and send them in the wire form; a value
// that breaks a strict work shape is never sent. Hand-written fixtures: reserved domains, ids that
// are valid but mean nothing.

const ALL = ["get_self", "search", "get_entity", "get_timeline", "get_commitments", "build_context_pack"];
const CLIENT = clientView({ tools: ALL, views: ["self", "people", "work"] });

const AT = "2026-10-15T14:00:00Z";
const START = "2026-10-15T13:00:00Z";
const END = "2026-10-15T13:40:00Z";
const PROJECT = { id: `ent_${ulid(2)}`, kind: "project", name: { untrusted: "Harbor tools" }, address: null } as const;
const QUENTIN = {
  id: `ent_${ulid(3)}`,
  kind: "person",
  name: { untrusted: "Quentin Lampwick" },
  address: null,
} as const;
const MESSAGE = `msg_${ulid(4)}`;
const CAPTURE = `cap_${ulid(5)}`;
const ANSWER = `rec_${ulid(6)}`;

const where = {
  kind: "repository",
  value: { untrusted: "forge.example.org/kestrel/harbor-tools" },
  strength: "strong",
} as const;
const session = {
  target: { project: PROJECT },
  start: START,
  end: END,
  minutes: 40,
  top: where,
  basis: "anchor",
} as const;
const workedOn = {
  rule: "match@1",
  advisory: true,
  minutes: 40,
  sessions: 1,
  from: "2026-10-14T13:00:00Z",
  to: AT,
  shared: 1,
  partial: false,
} as const;
const task = {
  capture: CAPTURE,
  title: { untrusted: "Call him back tomorrow" },
  project: PROJECT,
  createdAt: "2026-10-14T09:00:00Z",
  completionRecordedAt: AT,
  doneAt: null,
  reopened: 0,
  workedOn,
} as const;
const coverage = {
  through: END,
  observedMinutes: 60,
  creditedMinutes: 40,
  unattributedMinutes: 20,
  weakMinutes: 0,
  dayCutBlocks: 0,
  dayCutMinutes: 0,
  pendingMinutes: 0,
  partial: false,
} as const;
const halfDay = {
  from: "2026-10-15T12:00:00Z",
  to: "2026-10-16T00:00:00Z",
  coverage,
  targets: [
    { target: { project: PROJECT }, minutes: 40 },
    { target: { where: { kind: "app", value: { untrusted: "test.example.chat" }, strength: "strong" } }, minutes: 20 },
  ],
  byPlace: [{ by: "repository", value: { untrusted: "forge.example.org/kestrel/harbor-tools" }, minutes: 40 }],
  byCategory: [{ category: "coding", minutes: 40 }],
  sessions: [session],
  meetings: [],
  threads: [{ app: { untrusted: "test.example.chat" }, thread: { untrusted: "Harbor planning" }, lines: 3 }],
  tasks: [task],
  more: false,
} as const;
const deepDay = {
  rule: "deep@1",
  day: "2026-10-15",
  coverage,
  complete: false,
  sessions: [
    {
      target: { project: PROJECT },
      start: START,
      end: END,
      minutes: 40,
      carriedMinutes: 10,
      interruptions: 1,
      interruptedMinutes: 4,
    },
  ],
  deepMinutes: 40,
  switchingMinutes: 20,
  meetingMinutes: 0,
  switches: 2,
  switchesPerHour: 2,
  interruptions: [{ category: "communication", count: 1, minutes: 4 }],
  more: false,
} as const;
const WORK: WorkNow = {
  asOf: AT,
  current: {
    ...session,
    target: { where: { kind: "app", value: { untrusted: "test.example.chat" }, strength: "strong" } },
    top: null,
    basis: "none",
  },
  focus: [{ target: { project: PROJECT }, minutes: 40, lastAt: END }],
  halfDays: [halfDay],
  deepWork: [deepDay],
  changes: [{ at: AT, kind: "task_completed", task }],
  openTasks: [{ ...task, completionRecordedAt: null, workedOn: null }],
  more: false,
} as unknown as WorkNow;

const SELF = SelfView.parse({
  addresses: [{ untrusted: "owner@example.com" }],
  timeZone: null,
  upcoming: [],
  contacts: [],
  changes: [],
  work: WORK,
});
const CARD = EntityView.parse({
  id: PROJECT.id,
  kind: "project",
  names: [{ untrusted: "Harbor tools" }],
  addresses: [],
  organization: null,
  people: [],
  mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
  lastMeeting: null,
  nextMeeting: null,
  details: [],
  shared: false,
  status: "active",
  time: { last7: 135, last30: 135, lastSession: session, openTasks: 2, done30: 1, partial: false },
});
const TIMELINE = TimelineView.parse({
  entries: [
    { kind: "task", at: AT, change: "completed", task },
    { kind: "work_session", at: START, session },
    { kind: "task", at: "2026-10-14T09:00:00Z", change: "created", task },
  ],
});
const belief = {
  fact: "a".repeat(64),
  state: "b".repeat(64),
  kind: "commitment",
  type: "commitment",
  status: "closed",
  disputed: false,
  provenance: "source",
  confirmedAt: AT,
  reviewAfter: null,
} as const;
const commitment = {
  belief,
  direction: "owed_by_owner",
  counterparty: QUENTIN,
  due: null,
  what: { untrusted: "Send the harbor notes" },
  message: MESSAGE,
  capture: null,
  segment: null,
} as const;
const COMMITMENTS = CommitmentList.parse({
  commitments: [
    // Closed by a reversal in mail: done when sent, by that message.
    { ...commitment, closedAt: AT, doneAt: AT, doneBy: { message: MESSAGE }, workedOn },
    // Closed in a consented meeting line of the owner's: by the capture item and the segment.
    {
      ...commitment,
      message: null,
      capture: CAPTURE,
      segment: { from: 0, to: 30 },
      closedAt: AT,
      doneAt: AT,
      doneBy: { capture: CAPTURE, segment: 1 },
      workedOn: null,
    },
    // By the answer from the owner to a question the system asked.
    { ...commitment, closedAt: AT, doneAt: AT, doneBy: { answer: ANSWER }, workedOn: null },
    // Closed in a moment: said closed, never done.
    { ...commitment, message: null, capture: CAPTURE, closedAt: AT, doneAt: null, doneBy: null, workedOn: null },
    // Open: nothing closed it.
    {
      ...commitment,
      belief: { ...belief, status: "active" },
      closedAt: null,
      doneAt: null,
      doneBy: null,
      workedOn: null,
    },
  ],
  more: false,
});
const item = { section: "work", required: false, provenance: "source", asOf: AT } as const;
const PACK = ContextPack.parse({
  purpose: "agent_bootstrap",
  template: "agent_bootstrap@8",
  asOf: AT,
  items: [{ ...item, id: "work", kind: "work", work: WORK }],
  truncated: false,
  hash: "c".repeat(64),
});

const listed = async (): Promise<{ name: string; description: string }[]> => {
  const reply = await handle(
    { provider: fakeProvider(CLIENT).provider, work: NO_WORK },
    fakeLog().log,
    TOKEN,
    request("tools/list"),
  );
  return (reply as { result: { tools: { name: string; description: string }[] } }).result.tools;
};
const describedAs = async (name: string): Promise<string> => {
  const tool = (await listed()).find((one) => one.name === name);
  if (tool === undefined) throw new Error(`${name} is not listed`);
  return tool.description;
};
const ask = (over: Partial<Provider>, name: string, args: unknown) =>
  handle({ provider: fakeProvider(CLIENT, over).provider, work: NO_WORK }, fakeLog().log, TOKEN, call(name, args));
// A result that is not the strict shape is never sent: the call answers unavailable.
const UNAVAILABLE = rpcError(1, -32603, "unavailable");

describe("work time's descriptions", () => {
  it("observed, not effort: get_self, get_entity and get_timeline say a work minute is observed foreground time, not effort, and nothing of productivity", async () => {
    for (const name of ["get_self", "get_entity", "get_timeline"]) {
      const text = await describedAs(name);
      expect(text, name).toContain("observed");
      expect(text, name).toContain("not effort");
      expect(text.toLowerCase(), name).not.toContain("productiv");
      // The 600-character description bound holds with the new words.
      expect(text.length, name).toBeLessThanOrEqual(600);
    }
    // The control: a tool that serves no work time says neither.
    const other = await describedAs("search");
    expect(other).not.toContain("not effort");
  });

  it("closed is not kept: get_commitments says a done time is when it was said closed, not that it was kept", async () => {
    const text = await describedAs("get_commitments");
    expect(text).toContain("said closed");
    expect(text).toContain("not kept");
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("the matcher is advisory: get_commitments says workedOn is advisory", async () => {
    const text = await describedAs("get_commitments");
    expect(text).toContain("workedOn");
    expect(text).toContain("advisory");
  });

  it("get_timeline for a project: its description takes a project's id, and search no longer says a project's id is get_entity's alone", async () => {
    expect(await describedAs("get_timeline")).toContain("project");
    expect(await describedAs("search")).not.toContain("get_entity alone");
  });

  it("get_timeline's description names a recorded meeting with no calendar event and a run of project links, and keeps within 600 characters", async () => {
    const text = await describedAs("get_timeline");
    expect(text).toContain("captured_meeting");
    expect(text).toContain("anchor_run");
    expect(text.length).toBeLessThanOrEqual(600);
  });
});

describe("work time's result schemas", () => {
  it("get_self's work is sent in the wire form, and a work that breaks its strict shape is never sent", async () => {
    expect(await ask({ getSelf: async () => ({ ok: true, value: SELF }) }, "get_self", {})).toEqual(
      readResult("get_self", 1, SELF),
    );
    // An effort score is no field of WorkNow: the strict result refuses it and nothing is sent.
    const scored = { ...SELF, work: { ...WORK, effort: 0.9 } } as unknown as SelfView;
    expect(await ask({ getSelf: async () => ({ ok: true, value: scored }) }, "get_self", {})).toEqual(UNAVAILABLE);
    const bare = {
      ...SELF,
      work: { ...WORK, openTasks: [{ ...WORK.openTasks[0], title: "Call him back tomorrow" }] },
    } as unknown as SelfView;
    expect(await ask({ getSelf: async () => ({ ok: true, value: bare }) }, "get_self", {})).toEqual(UNAVAILABLE);
  });

  it("a project's card is sent with its time; a time with a field ProjectTime lacks is never sent", async () => {
    expect(await ask({ getEntity: async () => ({ ok: true, value: CARD }) }, "get_entity", { id: PROJECT.id })).toEqual(
      readResult("get_entity", 1, CARD),
    );
    const wrong = { ...CARD, time: { ...CARD.time, hours: 2 } } as unknown as EntityView;
    expect(
      await ask({ getEntity: async () => ({ ok: true, value: wrong }) }, "get_entity", { id: PROJECT.id }),
    ).toEqual(UNAVAILABLE);
  });

  it("get_timeline sends a project's work sessions and task transitions; an edited transition is no timeline change", async () => {
    expect(
      await ask({ getTimeline: async () => ({ ok: true, value: TIMELINE }) }, "get_timeline", { id: PROJECT.id }),
    ).toEqual(readResult("get_timeline", 1, TIMELINE));
    const edited = { entries: [{ kind: "task", at: AT, change: "edited", task }] } as unknown as TimelineView;
    expect(
      await ask({ getTimeline: async () => ({ ok: true, value: edited }) }, "get_timeline", { id: PROJECT.id }),
    ).toEqual(UNAVAILABLE);
  });

  it("get_commitments sends closedAt, doneAt, doneBy in each of its three forms, and workedOn; a workedOn that is not advisory is never sent", async () => {
    expect(
      await ask({ getCommitments: async () => ({ ok: true, value: COMMITMENTS }) }, "get_commitments", {}),
    ).toEqual(readResult("get_commitments", 1, COMMITMENTS));
    const first = COMMITMENTS.commitments[0];
    const binding = {
      commitments: [{ ...first, workedOn: { ...workedOn, advisory: false } }],
      more: false,
    } as unknown as CommitmentList;
    expect(await ask({ getCommitments: async () => ({ ok: true, value: binding }) }, "get_commitments", {})).toEqual(
      UNAVAILABLE,
    );
    const otherRule = {
      commitments: [{ ...first, workedOn: { ...workedOn, rule: "match@2" } }],
      more: false,
    } as unknown as CommitmentList;
    expect(await ask({ getCommitments: async () => ({ ok: true, value: otherRule }) }, "get_commitments", {})).toEqual(
      UNAVAILABLE,
    );
  });

  it("agent_bootstrap@8's work item is sent in the wire form", async () => {
    expect(
      await ask({ buildContextPack: async () => ({ ok: true, value: PACK }) }, "build_context_pack", {
        purpose: "agent_bootstrap",
      }),
    ).toEqual(readResult("build_context_pack", 1, PACK));
    // The control: an item kind the pack does not know is never sent.
    const unknownKind = { ...PACK, items: [{ ...PACK.items[0], kind: "work_time" }] } as unknown as ContextPack;
    expect(
      await ask({ buildContextPack: async () => ({ ok: true, value: unknownKind }) }, "build_context_pack", {
        purpose: "agent_bootstrap",
      }),
    ).toEqual(UNAVAILABLE);
  });
});
