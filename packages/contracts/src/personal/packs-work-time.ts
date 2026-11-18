import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { ActivityCategory } from "./activity.ts";
import { CutReasons } from "./capture-blocks.ts";
import { CaptureId, Handle } from "./ids.ts";
import { UntrustedString } from "./tools-args.ts";
import { MeetingView, TaskView, WhereKind, Who, WorkMinutes, WorkSession, WorkTarget } from "./tools-views.ts";
import { DEEP_RULE, DEEP_SESSIONS } from "./work-time.ts";

const count = z.number().int().nonnegative();

// Work time: get_self's `work` and a project's `time`, computed at read from the capture rows the
// caller can see and stored nowhere. Every minute is observed foreground time, not effort.
const minutes = WorkMinutes;

export const LINES_PAST_NOTE =
  "Chat lines past coverage.through: minutes come from block days, sent later than lines, so few minutes here do not mean nothing happened. Lines do not measure time.";

// What a share of time rests on, served with every share. `through` is the latest block end the caller can see in the window;
// `dayCut*` are the local day's cuts, the same on both its half-days, with what no rule could file for a caller cleared for all of
// them, and `dayCutReasons` says why, present when there is a cut; `pendingMinutes` a visible block day's clear minutes while its
// work_enc is null; `partial` that a read bound left rows out. `linesPast`, the new lines of the window's moments that began after
// `through` and when the last ended: minutes come from block days and lines from moments, sent apart, so lines beside no minutes
// mean the blocks have not reached those hours.
export const Coverage = z.strictObject({
  through: Timestamp.nullable(),
  observedMinutes: minutes,
  creditedMinutes: minutes,
  unattributedMinutes: minutes,
  weakMinutes: minutes,
  dayCutBlocks: count,
  dayCutMinutes: minutes,
  dayCutReasons: CutReasons.optional(),
  pendingMinutes: minutes,
  partial: z.boolean(),
  linesPast: z.strictObject({ lines: count, until: Timestamp, note: z.literal(LINES_PAST_NOTE) }).optional(),
});
export type Coverage = z.infer<typeof Coverage>;

// The most history pages a half-day lists.
export const HALF_DAY_PAGES = 10;

// One half of a local day in the owner's zone, 00:00 to 12:00 or 12:00 to 24:00.
export const HalfDay = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  coverage: Coverage,
  targets: z.array(z.strictObject({ target: WorkTarget, minutes })).max(10),
  byPlace: z.array(z.strictObject({ by: WhereKind, value: UntrustedString, minutes })).max(30),
  // The visible blocks' history pages in the window, most visits first.
  pages: z
    .array(
      z.strictObject({
        url: UntrustedString,
        title: UntrustedString.nullable(),
        query: UntrustedString.nullable(),
        visits: count,
      }),
    )
    .max(HALF_DAY_PAGES)
    .optional(),
  byCategory: z.array(z.strictObject({ category: ActivityCategory, minutes })).max(ActivityCategory.options.length),
  sessions: z.array(WorkSession).max(20),
  meetings: z
    .array(
      z.strictObject({
        meeting: MeetingView.nullable(),
        capture: CaptureId.or(Handle),
        start: Timestamp,
        end: Timestamp,
        project: Who.nullable(),
      }),
    )
    .max(10),
  threads: z.array(z.strictObject({ app: UntrustedString, thread: UntrustedString.nullable(), lines: count })).max(5),
  tasks: z.array(TaskView).max(10),
  more: z.boolean(),
});
export type HalfDay = z.infer<typeof HalfDay>;

// What a deep-work session was on: a project, or a work category.
export const DeepTarget = z.union([z.strictObject({ project: Who }), z.strictObject({ category: ActivityCategory })]);
export type DeepTarget = z.infer<typeof DeepTarget>;

// `minutes` is its focus, its own and carried, never its span.
export const DeepSession = z.strictObject({
  target: DeepTarget,
  start: Timestamp,
  end: Timestamp,
  minutes,
  carriedMinutes: minutes,
  interruptions: count,
  interruptedMinutes: minutes,
});
export type DeepSession = z.infer<typeof DeepSession>;

// One local day's deep work. The three totals are disjoint and sum to the coverage's observed
// minutes; every aggregate is over all of the day's sessions, of which at most DEEP_SESSIONS are
// listed. `complete` is false until the day's blocks are all in.
export const DeepWorkDay = z.strictObject({
  rule: z.literal(DEEP_RULE),
  day: DateOnly,
  coverage: Coverage,
  complete: z.boolean(),
  sessions: z.array(DeepSession).max(DEEP_SESSIONS),
  deepMinutes: minutes,
  switchingMinutes: minutes,
  meetingMinutes: minutes,
  switches: count,
  switchesPerHour: z.number().min(0).nullable(),
  interruptions: z
    .array(z.strictObject({ category: ActivityCategory, count, minutes }))
    .max(ActivityCategory.options.length),
  more: z.boolean(),
});
export type DeepWorkDay = z.infer<typeof DeepWorkDay>;

// get_self's `work`, for a client with the Self and Work views. The owner's stated goals stay in get_self's
// head; this is observed activity (`focus`: credited minutes by target over the last FOCUS_HOURS) and what
// changed.
export const WorkNow = z.strictObject({
  asOf: Timestamp,
  current: WorkSession.nullable(),
  focus: z.array(z.strictObject({ target: WorkTarget, minutes, lastAt: Timestamp })).max(3),
  halfDays: z.array(HalfDay).max(2),
  deepWork: z.array(DeepWorkDay).max(2),
  changes: z
    .array(
      z.strictObject({
        at: Timestamp,
        kind: z.enum(["task_created", "task_completed", "task_reopened", "meeting"]),
        task: TaskView.optional(),
        capture: CaptureId.or(Handle).optional(),
      }),
    )
    .max(10),
  openTasks: z.array(TaskView).max(5),
  more: z.boolean(),
});
export type WorkNow = z.infer<typeof WorkNow>;

// A project's time on its card.
export const ProjectTime = z.strictObject({
  last7: minutes,
  last30: minutes,
  lastSession: WorkSession.nullable(),
  openTasks: count,
  done30: count,
  partial: z.boolean(),
});
export type ProjectTime = z.infer<typeof ProjectTime>;
