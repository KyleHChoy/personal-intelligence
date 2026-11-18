import {
  type ActivityCategory,
  CURRENT_MS,
  DEEP_SELF_SESSIONS,
  type DeepWorkDay,
  dayAfter,
  dayIn,
  FOCUS_HOURS,
  type HalfDay,
  type MeetingView,
  type ProjectTime,
  startOfDay,
  type TaskView,
  type TimeWeek,
  WORK_NOW_TOKENS,
  type WorkedOn,
  type WorkNow,
  type WorkSession,
  type WorkTarget,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { DAY_MS, dayWindow, HOUR_MS, halfDayWindows, MINUTE_MS } from "../days.ts";
import { tenths } from "../units.ts";
import {
  type Built,
  build,
  changedIn,
  commitmentItem,
  coverageOf,
  halfDayOf,
  halfDayTasks,
  sessionView,
  targetView,
  taskItem,
  tasksOf,
  taskView,
  type Window,
  whoOf,
} from "./work-time-build.ts";
import {
  clipAll,
  type Place,
  placeView,
  type Target,
  targetKey,
  targetOf,
  type WorkCommitment,
  type WorkInputs,
  type WorkRow,
} from "./work-time-credit.ts";
import { deepWorkOf } from "./work-time-deep.ts";
import { type SortView, sortOf, sortWindow } from "./work-time-sort.ts";
import { matchWindow, matchWorkedOn, type TaskState } from "./work-time-tasks.ts";
import { iso, sum } from "./work-time-units.ts";

// Work time and deep work. Pure: no clock, no key, no database. The drain's half seals one item's
// own fields (captureWorkOf); the read's half (workTime) computes every view from the rows, links,
// anchors and projects the caller's token returned, so a row the caller cannot see changes nothing
// it is served, and nothing it computes is stored. Times are milliseconds since the epoch.

// --------------------------------------------------------------------------------------------- The
// requests a read serves, and the windows each needs gathered.

export type WorkRequest =
  | { view: "now"; whole?: boolean }
  | { view: "day"; day: string }
  | { view: "project"; project: string; days: number }
  | { view: "timeline"; project: string; from: number; to: number }
  | { view: "matches"; commitments: readonly string[] }
  | { view: "week"; weekStart: string }
  // Get_work_time's local days, both included.
  | { view: "sort"; from: string; to: string };

// The union of windows, merged where they touch, in time order.
function unionOf(windows: readonly Window[]): Window[] {
  const sorted = windows.filter((one) => one.to > one.from).sort((a, b) => a.from - b.from);
  const merged: Window[] = [];
  for (const one of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && one.from <= last.to) last.to = Math.max(last.to, one.to);
    else merged.push({ ...one });
  }
  return merged;
}

type Served = { own: Window[]; tasks: TaskState[]; commitments: WorkCommitment[] };

// The window a request reads for itself, and the tasks and commitments whose worked-on minutes it
// serves. Task rows are gathered whole; this picks the ones the view shows.
function servedBy(
  request: WorkRequest,
  inputs: Pick<WorkInputs, "rows" | "commitments" | "projects" | "zone" | "now">,
  tasks: readonly TaskState[],
): Served {
  const { zone, now } = inputs;
  const today = dayIn(new Date(now), zone);
  switch (request.view) {
    case "now": {
      const windows = nowHalves(now, zone).map((one) => one.window);
      const changes = latestChanges(
        tasks,
        inputs.rows.filter((row) => row.kind === "meeting"),
        now,
      ).slice(0, 10);
      const shown = new Set<TaskState>([
        ...changes.flatMap((one) => (one.task === undefined ? [] : [one.task])),
        ...openTasks(tasks).slice(0, 5),
        ...windows.flatMap((window) => halfDayTasks(tasks, window).list),
      ]);
      return {
        own: [{ from: Math.min(now - FOCUS_HOURS * HOUR_MS, startOfDay(dayAfter(today, -1), zone)), to: now }],
        tasks: [...shown],
        commitments: [],
      };
    }
    case "day": {
      const window = dayWindow(request.day, zone);
      return {
        own: [window],
        tasks: halfDayWindows(request.day, zone).flatMap((half) => halfDayTasks(tasks, half).list),
        commitments: [],
      };
    }
    case "project":
      return {
        own: [{ from: now - Math.max(30, request.days) * DAY_MS, to: now }],
        tasks: tasks.filter((task) => task.project === request.project),
        commitments: [],
      };
    case "timeline":
      return {
        own: [{ from: request.from, to: request.to }],
        tasks: tasks.filter(
          (task) => task.project === request.project && changedIn(task, { from: request.from, to: request.to + 1 }),
        ),
        commitments: [],
      };
    case "matches":
      return {
        own: [],
        tasks: [],
        commitments: inputs.commitments.filter((one) => request.commitments.includes(one.id)),
      };
    case "week":
      return { own: [weekWindow(request.weekStart, zone)], tasks: [], commitments: [] };
    case "sort":
      return { own: [sortWindow(request, zone)], tasks: [], commitments: [] };
  }
}

// What capture rows a request needs, given the task rows and commitments gathered first: its own
// window and the match window of each item it serves.
export function workWindows(
  request: WorkRequest,
  inputs: Pick<WorkInputs, "rows" | "commitments" | "projects" | "zone" | "now">,
): Window[] {
  const tasks = tasksOf(inputs);
  const items = [...tasks.map(taskItem), ...inputs.commitments.map(commitmentItem)];
  const served = servedBy(request, inputs, tasks);
  const matches = [...served.tasks.map(taskItem), ...served.commitments.map(commitmentItem)]
    .map((item) => matchWindow(item, items))
    .filter((one): one is Window => one !== null);
  return unionOf([...served.own, ...matches]);
}

export type WorkViews = {
  now?: WorkNow;
  day?: { halfDays: HalfDay[]; deepWork: DeepWorkDay };
  project?: { time: ProjectTime; sessions: WorkSession[]; tasks: TaskView[] };
  timeline?: {
    sessions: WorkSession[];
    tasks: { at: string; change: "created" | "completed" | "reopened"; task: TaskView }[];
    meetings: { at: string; capture: string; meeting: MeetingView | null }[];
  };
  matches?: Record<string, WorkedOn | null>;
  week?: TimeWeek;
  sort?: SortView;
  shown: string[];
};

export function workTime(inputs: WorkInputs, request: WorkRequest): WorkViews {
  const built = build(inputs);
  const { zone } = inputs;
  const served = servedBy(request, inputs, built.tasks);
  const windows = workWindows(request, inputs);
  const servedTasks = new Set(served.tasks.map((task) => task.row.id));
  const shown = [
    ...new Set(
      inputs.rows
        .filter((row) =>
          row.kind === "task"
            ? servedTasks.has(row.id)
            : windows.some((window) => row.endedAt >= window.from && row.startedAt < window.to),
        )
        .map((row) => row.evidence),
    ),
  ].sort(byText);
  switch (request.view) {
    case "now":
      return { now: workNowOf(built, request.whole === true), shown };
    case "day": {
      const halfDays = halfDayWindows(request.day, zone).map((window) => halfDayOf(built, window, request.day));
      const window = dayWindow(request.day, zone);
      return {
        day: {
          halfDays,
          deepWork: deepWorkOf(request.day, built.spans, coverageOf(built, window, request.day), whoOf(built), zone),
        },
        shown,
      };
    }
    case "project":
      return { project: projectTimeOf(built, request.project, request.days, served.tasks), shown };
    case "timeline":
      return { timeline: timelineOf(built, request.project, request.from, request.to, served.tasks), shown };
    case "matches": {
      const matches: Record<string, WorkedOn | null> = {};
      for (const one of served.commitments)
        matches[one.id] = matchWorkedOn(
          commitmentItem(one),
          built.items,
          built.spans,
          built.sessions,
          inputs.partial.rows,
        );
      return { matches, shown };
    }
    case "week":
      return { week: weekOf(built, request.weekStart), shown };
    case "sort":
      return { sort: sortOf(built.spans, built.inputs, whoOf(built), sortWindow(request, zone)), shown };
  }
}

// Seven local days from `weekStart`, in the owner's zone.
const weekWindow = (weekStart: string, zone: string | null): Window => ({
  from: startOfDay(weekStart, zone),
  to: startOfDay(dayAfter(weekStart, 7), zone),
});

// Each day's observed minutes, deep minutes and longest deep session (its sessions come longest
// first) as deepWorkOf counts them; the week's credited minutes by project and observed minutes by
// kind, a meeting's as `meetings`; and what no project was credited, shown as such.
function weekOf(built: Built, weekStart: string): TimeWeek {
  const { zone } = built.inputs;
  const days = Array.from({ length: 7 }, (_, n) => {
    const date = dayAfter(weekStart, n);
    const deep = deepWorkOf(date, built.spans, coverageOf(built, dayWindow(date, zone), date), whoOf(built), zone);
    const dayProjects = new Map<string, number>();
    for (const span of clipAll(built.spans, startOfDay(date, zone), startOfDay(dayAfter(date, 1), zone)))
      if (span.project !== null) dayProjects.set(span.project, (dayProjects.get(span.project) ?? 0) + span.minutes);
    const byProject = [...dayProjects.entries()]
      .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
      .map(([project, minutes]) => ({
        project: project as TimeWeek["byProject"][number]["project"],
        minutes: tenths(minutes),
      }));
    return {
      date: date as TimeWeek["days"][number]["date"],
      minutes: deep.coverage.observedMinutes,
      deepMinutes: deep.deepMinutes,
      longestSessionMinutes: deep.sessions[0]?.minutes ?? 0,
      byProject,
    };
  });
  const window = weekWindow(weekStart, zone);
  const projects = new Map<string, number>();
  const kinds = new Map<ActivityCategory, number>();
  let unattributed = 0;
  for (const span of clipAll(built.spans, window.from, window.to)) {
    if (span.project === null) unattributed += span.minutes;
    else projects.set(span.project, (projects.get(span.project) ?? 0) + span.minutes);
    const kind: ActivityCategory = span.meeting ? "meetings" : (span.category ?? "other");
    kinds.set(kind, (kinds.get(kind) ?? 0) + span.minutes);
  }
  const byMinutes = <K extends string>(map: Map<K, number>): [K, number][] =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  return {
    days,
    byProject: byMinutes(projects).map(([project, minutes]) => ({
      project: project as TimeWeek["byProject"][number]["project"],
      name: whoOf(built)(project)?.name ?? null,
      minutes: tenths(minutes),
    })),
    byKind: byMinutes(kinds).map(([kind, minutes]) => ({ kind, minutes: tenths(minutes) })),
    unattributed: tenths(unattributed),
  };
}

const isOpen = (task: TaskState): boolean => task.completion === null;
const openTasks = (tasks: readonly TaskState[]): TaskState[] =>
  tasks.filter(isOpen).sort((a, b) => b.created - a.created || byText(a.row.id, b.row.id));

function projectTimeOf(built: Built, project: string, days: number, tasks: readonly TaskState[]) {
  const { now } = built.inputs;
  const minutesSince = (since: number): number =>
    tenths(
      sum(
        clipAll(built.spans, since, now)
          .filter((one) => one.project === project)
          .map((one) => one.minutes),
      ),
    );
  const onProject = built.sessions.filter((one) => "project" in one.target && one.target.project === project);
  const last = [...onProject].sort((a, b) => b.end - a.end)[0];
  const time: ProjectTime = {
    last7: minutesSince(now - 7 * DAY_MS),
    last30: minutesSince(now - 30 * DAY_MS),
    lastSession: last === undefined ? null : sessionView(built, last),
    openTasks: tasks.filter(isOpen).length,
    done30: tasks.filter((task) => task.completion !== null && task.completion >= now - 30 * DAY_MS).length,
    partial: built.inputs.partial.rows || built.inputs.partial.tasks,
  };
  return {
    time,
    sessions: onProject
      .filter((one) => one.end >= now - days * DAY_MS)
      .sort((a, b) => b.start - a.start)
      .map((one) => sessionView(built, one))
      .filter((one): one is WorkSession => one !== null),
    tasks: [...tasks].sort((a, b) => b.latest - a.latest).map((task) => taskView(built, task)),
  };
}

function timelineOf(built: Built, project: string, from: number, to: number, tasks: readonly TaskState[]) {
  const sessions = built.sessions
    .filter((one) => "project" in one.target && one.target.project === project && one.end >= from && one.start <= to)
    .sort((a, b) => b.start - a.start)
    .map((one) => sessionView(built, one))
    .filter((one): one is WorkSession => one !== null);
  const changes: { at: string; change: "created" | "completed" | "reopened"; task: TaskView }[] = [];
  for (const task of tasks) {
    const view = taskView(built, task);
    for (const event of task.events) {
      const at = Date.parse(event.at);
      if (event.kind === "edited" || at < from || at > to) continue;
      changes.push({ at: iso(at), change: event.kind, task: view });
    }
  }
  changes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const meetings = built.inputs.rows
    .filter(
      (row) =>
        row.kind === "meeting" &&
        row.startedAt >= from &&
        row.startedAt <= to &&
        built.linked(row, row.compartments) === project,
    )
    .sort((a, b) => b.startedAt - a.startedAt || byText(a.id, b.id))
    .map((row) => ({ at: iso(row.startedAt), capture: row.id, meeting: row.meeting ?? null }));
  return { sessions, tasks: changes, meetings };
}

function nowHalves(now: number, zone: string | null): { window: Window; day: string }[] {
  const today = dayIn(new Date(now), zone);
  const yesterday = dayAfter(today, -1);
  return [
    ...halfDayWindows(yesterday, zone).map((window) => ({ window, day: yesterday })),
    ...halfDayWindows(today, zone).map((window) => ({ window, day: today })),
  ]
    .filter((one) => one.window.from <= now)
    .slice(-2)
    .reverse();
}

type Change = { at: number; kind: WorkNow["changes"][number]["kind"]; task?: TaskState; capture?: string };

function latestChanges(tasks: readonly TaskState[], meetings: readonly WorkRow[], now: number): Change[] {
  const changes: Change[] = [];
  for (const task of tasks) {
    let completed = false;
    for (const event of task.events) {
      const at = Date.parse(event.at);
      if (at > now) continue;
      if (event.kind === "created") changes.push({ at, kind: "task_created", task });
      if (event.kind === "completed") {
        completed = true;
        changes.push({ at, kind: "task_completed", task });
      }
      if (event.kind === "reopened" && completed) changes.push({ at, kind: "task_reopened", task });
    }
  }
  for (const row of meetings)
    if (row.startedAt <= now) changes.push({ at: row.startedAt, kind: "meeting", capture: row.id });
  return changes.sort(
    (a, b) => b.at - a.at || byText(a.task?.row.id ?? a.capture ?? "", b.task?.row.id ?? b.capture ?? ""),
  );
}

function workNowOf(built: Built, whole: boolean): WorkNow {
  const { now, zone } = built.inputs;
  // `current`: the latest moment or meeting that ended within CURRENT_MS of now, with its project
  // link or its place; null when there is none, or when it is a meeting with no link, whose place
  // the reader cannot see.
  const latest = built.inputs.rows
    .filter((row) => (row.kind === "moment" && row.work?.kind === "moment") || row.kind === "meeting")
    .filter((row) => row.endedAt <= now && now - row.endedAt <= CURRENT_MS)
    .sort((a, b) => b.endedAt - a.endedAt || byText(a.id, b.id))[0];
  let current: WorkSession | null = null;
  if (latest !== undefined) {
    const project = built.linked(latest, latest.compartments);
    const who = project === null ? null : whoOf(built)(project);
    const where: Place | null =
      latest.work?.kind === "moment" ? { kind: "app", value: latest.work.bundle, strength: "strong" } : null;
    const target: WorkTarget | null =
      who !== null ? { project: who } : where !== null ? { where: placeView(where) } : null;
    if (target !== null) {
      current = {
        target,
        start: iso(latest.startedAt),
        end: iso(latest.endedAt),
        minutes: tenths((latest.endedAt - latest.startedAt) / MINUTE_MS),
        top: where === null ? null : placeView(where),
        basis: who === null ? "none" : latest.kind === "meeting" ? "meeting" : "moment",
      };
    }
  }
  // `focus`: the three targets with most credited minutes over FOCUS_HOURS, each with the end of
  // its latest session (the end of its latest credited time when it has none), ties by the later.
  const since = now - FOCUS_HOURS * HOUR_MS;
  const totals = new Map<string, { target: Target; minutes: number; spanEnd: number; sessionEnd: number | null }>();
  for (const span of clipAll(built.spans, since, now)) {
    const target = targetOf(span);
    if (target === null) continue;
    const key = targetKey(target);
    const entry = totals.get(key) ?? { target, minutes: 0, spanEnd: 0, sessionEnd: null };
    totals.set(key, { ...entry, minutes: entry.minutes + span.minutes, spanEnd: Math.max(entry.spanEnd, span.to) });
  }
  for (const session of built.sessions) {
    const entry = totals.get(targetKey(session.target));
    if (entry !== undefined && session.start <= now)
      entry.sessionEnd = Math.max(entry.sessionEnd ?? 0, Math.min(session.end, now));
  }
  const focus = [...totals.values()]
    .map((entry) => ({ ...entry, lastAt: entry.sessionEnd ?? entry.spanEnd }))
    .sort((a, b) => b.minutes - a.minutes || b.lastAt - a.lastAt)
    .map((entry) => ({
      view: targetView(built, entry.target),
      minutes: tenths(entry.minutes),
      lastAt: iso(entry.lastAt),
    }))
    .filter((one) => one.view !== null)
    .slice(0, 3)
    .map((one) => ({ target: one.view as WorkTarget, minutes: one.minutes, lastAt: one.lastAt }));
  const today = dayIn(new Date(now), zone);
  const halfDays = nowHalves(now, zone).map((one) => halfDayOf(built, one.window, one.day));
  const deepWork = [today, dayAfter(today, -1)].map((day) =>
    deepWorkOf(day, built.spans, coverageOf(built, dayWindow(day, zone), day), whoOf(built), zone, DEEP_SELF_SESSIONS),
  );
  const changes = latestChanges(
    built.tasks,
    built.inputs.rows.filter((row) => row.kind === "meeting"),
    now,
  );
  const open = openTasks(built.tasks);
  const views = new Map<TaskState, TaskView>();
  const viewOf = (task: TaskState): TaskView => {
    let view = views.get(task);
    if (view === undefined) {
      view = taskView(built, task);
      views.set(task, view);
    }
    return view;
  };
  const view: WorkNow = {
    asOf: iso(now),
    current,
    focus,
    halfDays,
    deepWork,
    changes: changes.slice(0, 10).map((change) => ({
      at: iso(change.at),
      kind: change.kind,
      ...(change.task === undefined ? {} : { task: viewOf(change.task) }),
      ...(change.capture === undefined ? {} : { capture: change.capture as WorkNow["changes"][number]["capture"] }),
    })),
    openTasks: open.slice(0, 5).map(viewOf),
    more:
      changes.length > 10 || open.length > 5 || halfDays.some((one) => one.more) || deepWork.some((one) => one.more),
  };
  return whole ? view : fitWorkNow(view);
}

const tokens = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length / 4;

export function fitWorkNow(view: WorkNow): WorkNow {
  const fitted: WorkNow = structuredClone(view);
  const older = fitted.halfDays[1];
  const newer = fitted.halfDays[0];
  const steps: (() => void)[] = [
    ...(older === undefined
      ? []
      : [
          () => void (older.pages === undefined ? undefined : (older.pages = [])),
          () => void (older.byPlace = []),
          () => void (older.threads = []),
          () => void (older.sessions = []),
          () => void (older.tasks = []),
        ].map((cut) => () => {
          cut();
          older.more = true;
        })),
    () => {
      const yesterday = fitted.deepWork[1];
      if (yesterday !== undefined && yesterday.sessions.length > 0) {
        yesterday.sessions = [];
        yesterday.more = true;
      }
    },
    ...(newer === undefined
      ? []
      : [
          () => void (newer.pages === undefined ? undefined : (newer.pages = [])),
          () => void (newer.byPlace = []),
          () => void (newer.threads = []),
          () => void (newer.sessions = []),
        ].map((cut) => () => {
          cut();
          newer.more = true;
        })),
    () => {
      const today = fitted.deepWork[0];
      if (today !== undefined && today.sessions.length > 0) {
        today.sessions = [];
        today.more = true;
      }
    },
    () => {
      if (newer !== undefined) {
        newer.tasks = [];
        newer.more = true;
      }
    },
    () => {
      fitted.changes = [];
      fitted.openTasks = [];
    },
  ];
  for (const step of steps) {
    if (tokens(fitted) <= WORK_NOW_TOKENS) break;
    step();
    fitted.more = true;
  }
  return fitted;
}
