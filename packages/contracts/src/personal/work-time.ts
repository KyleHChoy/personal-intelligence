import type { ActivityCategory } from "./activity.ts";
import { deepFreeze } from "./capture-forms.ts";

// Work time and deep work: the rule names and constants every work-time view is computed with, at
// read, by core's `workTime`. The view shapes are in tools-views.ts (what a timeline entry holds) and
// packs.ts (get_self's `work`, a project's `time`); this file imports neither, so both may import it.

// The complete local days it looks back over; the most groups one request holds and the fewest
// minutes a group needs to be asked about; how long after a moment its thread still names the time
// in the same app; the most words of the owner's own one group shows; and the cards a day and the
// minutes a group needs before one proposes a new project.
export const TIME_PASS_DAYS = 14;
export const TIME_GROUPS_MAX = 40;
export const TIME_GROUP_MIN_MINUTES = 3;
export const TIME_THREAD_HOLD_MS = 1_800_000;
export const TIME_OWN_LINES = 3;
export const TIME_OWN_LINE_CHARS = 200;
export const TIME_EFFORT_CARDS_PER_DAY = 3;
export const TIME_EFFORT_MIN_MINUTES = 30;

export const WORK_RULE = "workTime@1";
export const MATCH_RULE = "match@1";
export const DEEP_RULE = "deep@1";

export const SESSION_GAP_MS = 600_000;
export const SESSION_MIN_MS = 300_000;
// `current` is the latest activity that ended within CURRENT_MS of now.
export const FOCUS_HOURS = 72;
export const CURRENT_MS = 1_800_000;
export const MATCH_DAYS = 14;
export const WORK_ITEMS = 10_000;
export const TASK_ITEMS = 10_000;
export const DEEP_MIN_MS = 1_800_000;
export const DEEP_BREAK_MS = 300_000;
export const DEEP_CATEGORIES: readonly ActivityCategory[] = deepFreeze(["coding", "writing", "research", "design"]);
export const DEEP_SESSIONS = 10;
export const DEEP_SELF_SESSIONS = 3;
export const TASK_FUTURE_MS = 300_000;
export const WORK_CATCH_UP = 500;
export const WORK_NOW_TOKENS = 2_500;

// Times in the other cases are minutes from a fixed start; a span's minutes are its length unless
// given.
export type WorkVector =
  | {
      readonly rule: "R3";
      readonly name: string;
      readonly kind: "repository" | "folder" | "document";
      readonly attribute: {
        readonly value: string;
        readonly method: "git_remote" | "ax_document" | "window_title_path" | "prompt_mention";
      };
      readonly title?: string;
      readonly kept: boolean;
    }
  | { readonly rule: "R34"; readonly name: string; readonly text: string; readonly lines: number }
  | {
      readonly rule: "R12";
      readonly name: string;
      readonly blocks: readonly {
        readonly from: number;
        readonly to: number;
        readonly minutes?: number;
        readonly bundle: string;
        readonly repository?: { readonly value: string; readonly method: "git_remote" | "prompt_mention" };
        readonly compartments?: readonly string[];
      }[];
      readonly meetings: readonly { readonly from: number; readonly to: number; readonly project: string | null }[];
      readonly moments: readonly {
        readonly from: number;
        readonly to: number;
        readonly bundle: string;
        readonly project: string | null;
      }[];
      readonly anchors: readonly { readonly key: string; readonly project: string }[];
      // [from, to, minutes, project, basis] for each credited sub-span, in time order.
      readonly credits: readonly (readonly [number, number, number, string | null, string])[];
    }
  | {
      readonly rule: "R20";
      readonly name: string;
      readonly spans: readonly VectorSpan[];
      readonly sessions: readonly (readonly [string, number])[];
    }
  | {
      readonly rule: "R82";
      readonly name: string;
      readonly spans: readonly VectorSpan[];
      readonly sessions: readonly (readonly [string, number, number])[];
    };

// A credited sub-span in a vector: its project, else its category; a meeting's is keyed meetings.
type VectorSpan = {
  readonly from: number;
  readonly to: number;
  readonly minutes?: number;
  readonly project?: string;
  readonly category?: ActivityCategory;
  readonly meeting?: true;
};

const span = (from: number, to: number, extra: Record<string, unknown> = {}) => ({ from, to, ...extra });

export const WORK_VECTORS: readonly WorkVector[] = deepFreeze([
  {
    rule: "R3",
    name: "a git remote's repository is kept",
    kind: "repository",
    attribute: { value: "forge.example.com/owner/alpha", method: "git_remote" },
    kept: true,
  },
  {
    rule: "R3",
    name: "a prompt's repository is kept, weak",
    kind: "repository",
    attribute: { value: "forge.example.com/owner/beta", method: "prompt_mention" },
    kept: true,
  },
  {
    rule: "R3",
    name: "a repository named src is generic",
    kind: "repository",
    attribute: { value: "forge.example.com/owner/src", method: "git_remote" },
    kept: false,
  },
  {
    rule: "R3",
    name: "an editor's folder is kept",
    kind: "folder",
    attribute: { value: "~/Code/alpha", method: "ax_document" },
    kept: true,
  },
  {
    rule: "R3",
    name: "a folder one segment under home is generic",
    kind: "folder",
    attribute: { value: "~/Downloads", method: "ax_document" },
    kept: false,
  },
  {
    rule: "R3",
    name: "a root path of two segments is generic",
    kind: "document",
    attribute: { value: "/tmp/x", method: "ax_document" },
    kept: false,
  },
  {
    rule: "R3",
    name: "a title's path in the title is kept",
    kind: "document",
    attribute: { value: "~/Code/alpha/notes.md", method: "window_title_path" },
    title: "notes.md — alpha",
    kept: true,
  },
  {
    rule: "R3",
    name: "a title's path in any case is kept",
    kind: "folder",
    attribute: { value: "~/Code/Alpha", method: "window_title_path" },
    title: "alpha — zsh",
    kept: true,
  },
  {
    rule: "R3",
    name: "a title's path not in the title is dropped",
    kind: "document",
    attribute: { value: "~/Code/alpha/notes.md", method: "window_title_path" },
    title: "Editor",
    kept: false,
  },
  {
    rule: "R3",
    name: "a title's path inside a word is dropped",
    kind: "document",
    attribute: { value: "~/Code/alpha/notes.md", method: "window_title_path" },
    title: "mynotes.md",
    kept: false,
  },
  {
    rule: "R3",
    name: "a title's path with no title is dropped",
    kind: "document",
    attribute: { value: "~/Code/alpha/notes.md", method: "window_title_path" },
    kept: false,
  },
  {
    rule: "R34",
    name: "new lines are those with a letter or a digit",
    text: "first line\n\n---\nsecond 2\n  \n3",
    lines: 3,
  },
  {
    rule: "R12",
    name: "a meeting, then the strong anchor, then a moment of the app, then none",
    blocks: [
      {
        from: 0,
        to: 240,
        bundle: "test.example.term",
        repository: { value: "forge.example.com/owner/alpha", method: "git_remote" },
      },
    ],
    meetings: [{ from: 0, to: 60, project: "met" }],
    moments: [],
    anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "anchored" }],
    credits: [
      [0, 60, 60, "met", "meeting"],
      [60, 240, 180, "anchored", "anchor"],
    ],
  },
  {
    rule: "R12",
    name: "a weak repository credits nothing even with an anchor on it; a moment of the app does",
    blocks: [
      {
        from: 0,
        to: 120,
        bundle: "test.example.term",
        repository: { value: "forge.example.com/owner/alpha", method: "prompt_mention" },
      },
    ],
    meetings: [],
    moments: [{ from: 60, to: 120, bundle: "test.example.term", project: "seen" }],
    anchors: [{ key: "repository:forge.example.com/owner/alpha", project: "anchored" }],
    credits: [
      [0, 60, 60, null, "none"],
      [60, 120, 60, "seen", "moment"],
    ],
  },
  {
    rule: "R12",
    name: "a meeting's own time counts only where no block covers it",
    blocks: [{ from: 30, to: 60, bundle: "test.example.call" }],
    meetings: [{ from: 0, to: 60, project: "met" }],
    moments: [],
    anchors: [],
    credits: [
      [0, 30, 30, "met", "meeting"],
      [30, 60, 30, "met", "meeting"],
    ],
  },
  {
    rule: "R12",
    name: "where two devices' blocks overlap the later-started block has the instant",
    blocks: [
      { from: 0, to: 60, bundle: "test.example.term" },
      { from: 30, to: 90, minutes: 30, bundle: "test.example.edit" },
    ],
    meetings: [],
    moments: [],
    anchors: [],
    credits: [
      [0, 30, 30, null, "none"],
      [30, 90, 30, null, "none"],
    ],
  },
  {
    rule: "R20",
    name: "a session joins across ten minutes, not eleven, and drops a run under five",
    spans: [
      span(0, 20, { project: "a" }),
      span(30, 50, { project: "a" }),
      span(61, 70, { project: "a" }),
      span(100, 104, { project: "a" }),
    ],
    sessions: [
      ["a", 40],
      ["a", 9],
    ],
  },
  {
    rule: "R20",
    name: "a session counts credited minutes, not its span, and survives another target's two minutes",
    spans: [span(0, 30, { project: "a", minutes: 20 }), span(30, 32, { project: "b" }), span(32, 60, { project: "a" })],
    sessions: [["a", 48]],
  },
  {
    rule: "R82",
    name: "thirty minutes of focus is a session",
    spans: [span(0, 30, { project: "a" })],
    sessions: [["p:a", 30, 0]],
  },
  { rule: "R82", name: "29.9 minutes is not", spans: [span(0, 30, { project: "a", minutes: 29.9 })], sessions: [] },
  {
    rule: "R82",
    name: "an excursion of 5:00 is tolerated and listed, one of 5:01 ends the run",
    spans: [
      span(0, 15, { project: "a" }),
      span(15, 20, { category: "communication" }),
      span(20, 35, { project: "a" }),
      span(100, 115, { project: "b" }),
      span(115, 120.0167, { category: "communication" }),
      span(120.0167, 135, { project: "b" }),
    ],
    sessions: [["p:a", 30, 0]],
  },
  {
    rule: "R82",
    name: "three short stretches away are one excursion of twelve minutes",
    spans: [
      span(0, 15, { project: "a" }),
      span(15, 19, { category: "communication" }),
      span(19, 23, { category: "admin" }),
      span(23, 27, { category: "media" }),
      span(27, 42, { project: "a" }),
    ],
    sessions: [],
  },
  {
    rule: "R82",
    name: "the loop of editor, Claude and browser on one project is one session",
    spans: [
      span(0, 12, { project: "a", category: "coding" }),
      span(12, 18, { category: "coding" }),
      span(18, 22, { category: "research" }),
      span(22, 40, { project: "a", category: "coding" }),
    ],
    sessions: [["p:a", 40, 10]],
  },
  {
    rule: "R82",
    name: "a carry of 10:00 joins",
    spans: [span(0, 15, { project: "a" }), span(15, 25, { category: "research" }), span(25, 40, { project: "a" })],
    sessions: [["p:a", 40, 10]],
  },
  {
    rule: "R82",
    name: "a carry of 10:01 does not",
    spans: [
      span(0, 15, { project: "a" }),
      span(15, 25.0167, { category: "research" }),
      span(25.0167, 40, { project: "a" }),
    ],
    sessions: [],
  },
  {
    rule: "R82",
    name: "carried minutes count toward N; over the project's own, no session",
    spans: [
      span(0, 5, { project: "a" }),
      span(5, 13, { category: "research" }),
      span(13, 33, { project: "a" }),
      span(100, 105, { project: "b" }),
      span(105, 114, { category: "research" }),
      span(114, 117, { project: "b" }),
      span(117, 126, { category: "research" }),
      span(126, 131, { project: "b" }),
      span(131, 140, { category: "research" }),
      span(140, 145, { project: "b" }),
    ],
    sessions: [["p:a", 33, 8]],
  },
  {
    rule: "R82",
    name: "idle time is never carried",
    spans: [span(0, 25, { project: "a" }), span(33, 43, { project: "a" })],
    sessions: [],
  },
  {
    rule: "R82",
    name: "a project session takes its carried minutes from any category session",
    spans: [
      span(0, 22, { category: "research" }),
      span(22, 25, { project: "a" }),
      span(25, 34, { category: "research" }),
      span(34, 64, { project: "a" }),
    ],
    sessions: [["p:a", 42, 9]],
  },
  {
    rule: "R82",
    name: "an hour of mail is never deep",
    spans: [span(0, 60, { category: "communication" })],
    sessions: [],
  },
  {
    rule: "R82",
    name: "a meeting is never deep, whatever its project",
    spans: [span(0, 60, { project: "a", meeting: true })],
    sessions: [],
  },
  {
    rule: "R82",
    name: "a category run of research is a session",
    spans: [span(0, 20, { category: "research" }), span(22, 34, { category: "research" })],
    sessions: [["c:research", 32, 0]],
  },
]);
