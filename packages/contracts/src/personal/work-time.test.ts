import {
  BLOCK_CUTS,
  BlockItem,
  CaptureItem,
  CaptureKey,
  CaptureKind,
  CaptureScopeRule,
  CaptureWork,
  CommitmentItem,
  DEEP_BREAK_MS,
  DEEP_CATEGORIES,
  DEEP_MIN_MS,
  DEEP_RULE,
  DEEP_SESSIONS,
  DeepWorkDay,
  EntityView,
  MATCH_RULE,
  PersonalSourceKind,
  ProjectTime,
  PushCaptureArgs,
  RetentionClass,
  SelfView,
  TASK_EVENTS,
  TaskItem,
  TaskView,
  TimelineEntry,
  WORK_RULE,
  WorkedOn,
  WorkNow,
  WorkSession,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The work time shapes. Made-up values on reserved domains only.

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = (time: string): string => `2026-10-01T${time}-05:00`;
const app = { bundle: "test.example.edit", name: "Edit" };

const block = (extra: Record<string, unknown> = {}) => ({
  kind: "block",
  key: `block:${ULID}`,
  revision: 0,
  day: "2026-10-01",
  blocks: [{ start: at("09:00:00"), end: at("09:30:00"), minutes: 30.5, app, ...extra }],
});
const attribute = { value: "forge.example.com/owner/alpha", method: "git_remote", v: 1 };

const task = {
  kind: "task",
  key: `task:${ULID}`,
  revision: 0,
  byOwner: true,
  title: "Call him back about the draft",
  project: "Alpha",
  events: [
    { kind: "created", at: at("09:00:00") },
    { kind: "completed", at: at("11:00:00") },
  ],
};

const who = { id: `ent_${ULID}`, kind: "project", name: { untrusted: "Alpha" }, address: null };
const where = { kind: "repository", value: { untrusted: "forge.example.com/owner/alpha" }, strength: "strong" };
const session = {
  target: { project: who },
  start: at("09:00:00"),
  end: at("10:00:00"),
  minutes: 55,
  top: where,
  basis: "anchor",
};
const workedOn = {
  rule: "match@1",
  advisory: true,
  minutes: 55,
  sessions: 1,
  from: at("09:00:00"),
  to: at("11:00:00"),
  shared: 0,
  partial: false,
};
const taskView = {
  capture: `cap_${ULID}`,
  title: { untrusted: "Call him back" },
  project: who,
  createdAt: at("09:00:00"),
  completionRecordedAt: at("11:00:00"),
  doneAt: null,
  reopened: 0,
  workedOn,
};
const coverage = {
  through: at("11:58:00"),
  observedMinutes: 170,
  creditedMinutes: 55,
  unattributedMinutes: 115,
  weakMinutes: 10,
  dayCutBlocks: 0,
  dayCutMinutes: 0,
  pendingMinutes: 0,
  partial: false,
};
const deepDay = {
  rule: "deep@1",
  day: "2026-10-01",
  coverage,
  complete: false,
  sessions: [
    {
      target: { project: who },
      start: at("09:00:00"),
      end: at("10:00:00"),
      minutes: 55,
      carriedMinutes: 8,
      interruptions: 1,
      interruptedMinutes: 4,
    },
  ],
  deepMinutes: 55,
  switchingMinutes: 115,
  meetingMinutes: 0,
  switches: 6,
  switchesPerHour: 2.1,
  interruptions: [{ category: "communication", count: 1, minutes: 4 }],
  more: false,
};

describe("WT1: block attributes", () => {
  it("a block attribute crosses with its method, version and optional moment reference and no text", () => {
    expect(accepts(BlockItem, block({ repository: attribute }))).toBe(true);
    expect(accepts(BlockItem, block({ repository: { ...attribute, ref: `moment:${ULID}` } }))).toBe(true);
    expect(accepts(BlockItem, block({ repository: { ...attribute, ref: `block:${ULID}` } }))).toBe(false);
    expect(accepts(BlockItem, block({ repository: { ...attribute, text: "look at repo alpha" } }))).toBe(false);
  });

  it("a block with an attribute lacking method is invalid", () => {
    const { method: _method, ...noMethod } = attribute;
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [block({ repository: noMethod })] })).toBe(false);
  });

  it("no digest or session item exists in the contract", () => {
    const kinds = CaptureItem.options.map((option) => option.shape.kind.value);
    expect(kinds).toEqual(expect.arrayContaining(["block", "forget", "meeting", "moment", "task"]));
    for (const kind of ["digest", "session", "half_day"]) expect(kinds, kind).not.toContain(kind);
    for (const kind of ["digest", "session", "half_day"])
      expect(accepts(CaptureItem, { ...task, kind }), kind).toBe(false);
  });
});

describe("a block day's cut", () => {
  it("a cut entry names a bundle with optional host and account, and its blocks and minutes; at most BLOCK_CUTS", () => {
    const cut = {
      app: "test.example.chat",
      host: "chat.example.com",
      account: "owner@example.com",
      blocks: 3,
      minutes: 1.5,
    };
    expect(accepts(BlockItem, { ...block(), cut: [cut] })).toBe(true);
    expect(accepts(BlockItem, { ...block(), cut: [] })).toBe(true);
    expect(accepts(BlockItem, { ...block(), cut: [{ ...cut, start: at("09:00:00") }] })).toBe(false);
    expect(accepts(BlockItem, { ...block(), cut: [{ ...cut, blocks: 0 }] })).toBe(false);
    expect(accepts(BlockItem, { ...block(), cut: Array.from({ length: BLOCK_CUTS + 1 }, () => cut) })).toBe(false);
  });
});

describe("the owner's tasks", () => {
  it("a task with its fields is a capture item, and its key is task:<ULID>", () => {
    expect(accepts(CaptureItem, task)).toBe(true);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [task] })).toBe(true);
    expect(accepts(CaptureKey, `task:${ULID}`)).toBe(true);
    expect(accepts(TaskItem, { ...task, key: `block:${ULID}` })).toBe(false);
  });

  it("byOwner false or absent still parses, so the box refuses that task alone (not_owner)", () => {
    const { byOwner: _byOwner, ...unmarked } = task;
    expect(accepts(TaskItem, unmarked)).toBe(true);
    expect(accepts(TaskItem, { ...task, byOwner: false })).toBe(true);
  });

  it("a title holds the claim text bounds: 1 to 300 code points and no control character", () => {
    expect(accepts(TaskItem, { ...task, title: "x".repeat(300) })).toBe(true);
    expect(accepts(TaskItem, { ...task, title: "x".repeat(301) })).toBe(false);
    expect(accepts(TaskItem, { ...task, title: "" })).toBe(false);
    expect(accepts(TaskItem, { ...task, title: "call\u0007back" })).toBe(false);
    expect(accepts(TaskItem, { ...task, project: "p".repeat(121) })).toBe(false);
  });

  it("events out of order, or not starting with created, are refused", () => {
    expect(accepts(TaskItem, { ...task, events: [{ kind: "completed", at: at("11:00:00") }] })).toBe(false);
    expect(
      accepts(TaskItem, {
        ...task,
        events: [
          { kind: "created", at: at("11:00:00") },
          { kind: "edited", at: at("10:00:00") },
        ],
      }),
    ).toBe(false);
    expect(
      accepts(TaskItem, {
        ...task,
        events: [
          { kind: "created", at: at("09:00:00") },
          { kind: "created", at: at("10:00:00") },
        ],
      }),
    ).toBe(false);
    expect(
      accepts(TaskItem, {
        ...task,
        events: [
          { kind: "created", at: at("09:00:00") },
          { kind: "edited", at: at("09:00:00") },
          { kind: "reopened", at: at("12:00:00") },
        ],
      }),
    ).toBe(true);
    expect(accepts(TaskItem, { ...task, events: [] })).toBe(false);
    const many = [
      { kind: "created", at: at("09:00:00") },
      ...Array.from({ length: TASK_EVENTS }, () => ({ kind: "edited", at: at("10:00:00") })),
    ];
    expect(accepts(TaskItem, { ...task, events: many })).toBe(false);
  });

  it("doneAt is optional and a timestamp", () => {
    expect(accepts(TaskItem, { ...task, doneAt: at("08:30:00") })).toBe(true);
    expect(accepts(TaskItem, { ...task, doneAt: "yesterday" })).toBe(false);
  });

  it("a scope rule naming task is refused; CaptureKind and the source and retention kinds gain task's", () => {
    const rule = {
      id: `csr_${ULID}`,
      match: "host",
      account: false,
      compartment: "own",
      kinds: ["task"],
      agentApp: false,
      client: null,
    };
    expect(accepts(CaptureScopeRule, rule)).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, kinds: ["moment", "task"] })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, kinds: ["moment"] })).toBe(true);
    expect(CaptureKind.options).toContain("task");
    expect(PersonalSourceKind.options).toContain("owner_task");
    expect(RetentionClass.options).toContain("capture_task");
  });
});

describe("CaptureWork, what the drain seals beside an item", () => {
  it("a block day's blocks with their kept attributes and category, and its split's cut totals", () => {
    const work = {
      kind: "block",
      blocks: [
        {
          start: at("09:00:00"),
          end: at("09:30:00"),
          minutes: 30.5,
          bundle: app.bundle,
          host: "docs.example.com",
          category: "coding",
          repository: { value: attribute.value, method: "git_remote" },
        },
      ],
      cut: { blocks: 0, minutes: 0 },
    };
    expect(accepts(CaptureWork, work)).toBe(true);
    expect(accepts(CaptureWork, { ...work, blocks: [{ ...work.blocks[0], category: null }] })).toBe(true);
    for (const extra of [
      { account: "owner@example.com" },
      { title: "secret.ts" },
      { repository: { ...work.blocks[0]?.repository, v: 1 } },
    ]) {
      expect(accepts(CaptureWork, { ...work, blocks: [{ ...work.blocks[0], ...extra }] }), JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it("a moment's bundle, thread and new-line count, and a task's fields, and nothing else", () => {
    expect(accepts(CaptureWork, { kind: "moment", bundle: "test.example.chat", thread: "Team", lines: 4 })).toBe(true);
    expect(accepts(CaptureWork, { kind: "moment", bundle: "test.example.chat", thread: null, lines: 0 })).toBe(true);
    expect(
      accepts(CaptureWork, { kind: "moment", bundle: "test.example.chat", thread: null, lines: 0, participants: [] }),
    ).toBe(false);
    const { kind: _kind, key: _key, revision: _revision, byOwner: _byOwner, ...fields } = task;
    expect(accepts(CaptureWork, { kind: "task", ...fields })).toBe(true);
    expect(accepts(CaptureWork, { kind: "task", ...fields, byOwner: true })).toBe(false);
    expect(accepts(CaptureWork, { kind: "task", ...fields, events: [{ kind: "completed", at: at("11:00:00") }] })).toBe(
      false,
    );
  });
});

describe("the views", () => {
  it("WorkedOn's advisory is the literal true and its rule match@1", () => {
    expect(MATCH_RULE).toBe("match@1");
    expect(accepts(WorkedOn, workedOn)).toBe(true);
    expect(accepts(WorkedOn, { ...workedOn, advisory: false })).toBe(false);
    expect(accepts(WorkedOn, { ...workedOn, rule: "match@2" })).toBe(false);
  });

  it("a session and a task view parse; a session's basis says whose ruling, and no other word", () => {
    expect(WORK_RULE).toBe("workTime@1");
    expect(accepts(WorkSession, session)).toBe(true);
    expect(accepts(WorkSession, { ...session, target: { where } })).toBe(true);
    expect(accepts(WorkSession, { ...session, basis: "ruling" })).toBe(true);
    expect(accepts(WorkSession, { ...session, basis: "proposed" })).toBe(true);
    expect(accepts(WorkSession, { ...session, basis: "guess" })).toBe(false);
    expect(accepts(TaskView, taskView)).toBe(true);
    expect(accepts(TaskView, { ...taskView, title: "Call him back" })).toBe(false);
  });

  it("DeepWorkDay's rule is the literal deep@1 and its lists keep their bounds", () => {
    expect(DEEP_RULE).toBe("deep@1");
    expect([DEEP_MIN_MS, DEEP_BREAK_MS, DEEP_SESSIONS]).toEqual([1_800_000, 300_000, 10]);
    expect(DEEP_CATEGORIES).toEqual(["coding", "writing", "research", "design"]);
    expect(accepts(DeepWorkDay, deepDay)).toBe(true);
    expect(accepts(DeepWorkDay, { ...deepDay, rule: "focus@1" })).toBe(false);
    expect(accepts(DeepWorkDay, { ...deepDay, switchesPerHour: null })).toBe(true);
    expect(
      accepts(DeepWorkDay, {
        ...deepDay,
        sessions: Array.from({ length: DEEP_SESSIONS + 1 }, () => deepDay.sessions[0]),
      }),
    ).toBe(false);
    expect(
      accepts(DeepWorkDay, { ...deepDay, sessions: [{ ...deepDay.sessions[0], target: { category: "research" } }] }),
    ).toBe(true);
    expect(
      accepts(DeepWorkDay, { ...deepDay, sessions: [{ ...deepDay.sessions[0], target: { category: "chores" } }] }),
    ).toBe(false);
  });

  it("get_self's work and a project's time are optional fields of their views", () => {
    const work = {
      asOf: at("12:30:00"),
      current: null,
      focus: [{ target: { project: who }, minutes: 55, lastAt: at("10:00:00") }],
      halfDays: [],
      deepWork: [deepDay],
      changes: [{ at: at("11:00:00"), kind: "task_completed", task: taskView }],
      openTasks: [],
      more: false,
    };
    expect(accepts(WorkNow, work)).toBe(true);
    expect(accepts(WorkNow, { ...work, deepWork: [deepDay, deepDay, deepDay] })).toBe(false);
    expect(SelfView.shape.work.safeParse(undefined).success).toBe(true);
    expect(SelfView.shape.work.safeParse(work).success).toBe(true);
    const time = { last7: 300, last30: 900, lastSession: session, openTasks: 2, done30: 5, partial: false };
    expect(accepts(ProjectTime, time)).toBe(true);
    expect(EntityView.shape.time.safeParse(time).success).toBe(true);
  });

  it("a timeline holds work sessions and task changes; a commitment its done times", () => {
    expect(accepts(TimelineEntry, { kind: "work_session", at: at("09:00:00"), session })).toBe(true);
    expect(accepts(TimelineEntry, { kind: "task", at: at("11:00:00"), change: "completed", task: taskView })).toBe(
      true,
    );
    expect(accepts(TimelineEntry, { kind: "task", at: at("11:00:00"), change: "edited", task: taskView })).toBe(false);
    const done = { closedAt: at("11:00:00"), doneAt: at("11:00:00"), workedOn };
    expect(CommitmentItem.shape.closedAt.safeParse(done.closedAt).success).toBe(true);
    const doneBy = CommitmentItem.shape.doneBy;
    for (const by of [
      { message: `msg_${ULID}` },
      { capture: `cap_${ULID}`, segment: 3 },
      { answer: `rec_${ULID}` },
      null,
    ])
      expect(doneBy.safeParse(by).success, JSON.stringify(by)).toBe(true);
    expect(doneBy.safeParse({ message: `msg_${ULID}`, answer: `rec_${ULID}` }).success).toBe(false);
  });
});
