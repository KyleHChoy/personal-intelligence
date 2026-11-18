// Work time's views: the rows built once for a read, and the half-day, coverage, session and task
// views workTime (work-time.ts) serves from them. Pure, as work-time.ts is.
import {
  type ActivityCategory,
  type Coverage,
  HALF_DAY_PAGES,
  type HalfDay,
  type TaskView,
  type Who,
  type WorkSession,
  type WorkTarget,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { tenths } from "../units.ts";
import {
  type BlockInterval,
  blockIntervals,
  clipAll,
  creditIntervals,
  linkLookup,
  type Place,
  placeView,
  type Session,
  type SubSpan,
  sessionsOf,
  type Target,
  targetKey,
  targetOf,
  type WorkCommitment,
  type WorkInputs,
  type WorkProject,
  type WorkRow,
  withLinesPast,
} from "./work-time-credit.ts";
import { dayCut } from "./work-time-seal.ts";
import { doneTime, type Matchable, matchWorkedOn, type TaskState, taskStateOf } from "./work-time-tasks.ts";
import { iso, sum, top, untrusted } from "./work-time-units.ts";

// ---------------------------------------------------------------------------------------------
// The views.

export type Window = { from: number; to: number };

export type Built = {
  inputs: WorkInputs;
  intervals: BlockInterval[];
  spans: SubSpan[];
  sessions: Session[];
  tasks: TaskState[];
  items: Matchable[];
  projects: Map<string, WorkProject>;
  linked: (row: WorkRow, label: readonly string[]) => string | null;
};

export const taskItem = (task: TaskState): Matchable => ({
  id: task.row.id,
  start: task.created,
  close: doneTime(task),
  targets: task.project === null ? [] : [task.project],
});
export const commitmentItem = (one: WorkCommitment): Matchable => ({
  id: one.id,
  start: one.start,
  close: one.close,
  targets: one.targets,
});
export const tasksOf = (inputs: Pick<WorkInputs, "rows" | "projects">): TaskState[] =>
  inputs.rows
    .map((row) => (row.kind === "task" ? taskStateOf(row, inputs.projects) : null))
    .filter((one): one is TaskState => one !== null);

export function build(inputs: WorkInputs): Built {
  const spans = creditIntervals(inputs);
  const tasks = tasksOf(inputs);
  return {
    inputs,
    intervals: blockIntervals(inputs.rows),
    spans,
    sessions: sessionsOf(spans),
    tasks,
    items: [...tasks.map(taskItem), ...inputs.commitments.map(commitmentItem)],
    projects: new Map(inputs.projects.map((project) => [project.id, project])),
    linked: linkLookup(inputs),
  };
}

export const whoOf =
  (built: Built) =>
  (project: string): Who | null =>
    built.projects.get(project)?.who ?? null;

export function targetView(built: Built, target: Target): WorkTarget | null {
  if ("where" in target) return { where: placeView(target.where) };
  const who = whoOf(built)(target.project);
  return who === null ? null : { project: who };
}

export function sessionView(built: Built, session: Session): WorkSession | null {
  const target = targetView(built, session.target);
  if (target === null) return null;
  return {
    target,
    start: iso(session.start),
    end: iso(session.end),
    minutes: tenths(session.minutes),
    top: session.top === null ? null : placeView(session.top),
    basis: session.basis,
  };
}

export function taskView(built: Built, task: TaskState): TaskView {
  return {
    capture: task.row.id as TaskView["capture"],
    title: untrusted(task.title),
    project: task.project === null ? null : whoOf(built)(task.project),
    createdAt: iso(task.created),
    completionRecordedAt: task.completion === null ? null : iso(task.completion),
    doneAt: task.doneAt === null ? null : iso(task.doneAt),
    reopened: task.reopened,
    workedOn: matchWorkedOn(taskItem(task), built.items, built.spans, built.sessions, built.inputs.partial.rows),
  };
}

export function coverageOf(built: Built, window: Window, day: string): Coverage {
  const spans = clipAll(built.spans, window.from, window.to);
  const ends = built.intervals.filter((one) => one.end > window.from && one.start < window.to).map((one) => one.end);
  for (const row of built.inputs.rows) {
    if (
      row.kind !== "block" ||
      row.work?.kind !== "block" ||
      row.work.coveredThrough === undefined ||
      row.startedAt >= window.to
    )
      continue;
    const seen = Date.parse(row.work.coveredThrough);
    if (seen > window.from) ends.push(seen);
  }
  const through = ends.length === 0 ? null : Math.min(window.to, Math.max(...ends));
  const dayRows = built.inputs.rows.filter((row) => row.kind === "block" && row.day === day);
  const observed = sum(spans.map((one) => one.minutes));
  const credited = sum(spans.filter((one) => one.project !== null).map((one) => one.minutes));
  const weak = sum(
    spans.filter((one) => one.project === null && one.where?.strength === "weak").map((one) => one.minutes),
  );
  return {
    through: through === null ? null : iso(through),
    observedMinutes: tenths(observed),
    creditedMinutes: tenths(credited),
    unattributedMinutes: tenths(observed - credited),
    weakMinutes: tenths(weak),
    ...dayCut(dayRows, built.inputs.clearance ?? []),
    pendingMinutes: tenths(sum(dayRows.map((row) => (row.work === null ? (row.minutes ?? 0) : 0)))),
    partial: built.inputs.partial.rows,
  };
}

export const changedIn = (task: TaskState, window: Window): boolean =>
  task.events.some((event) => Date.parse(event.at) >= window.from && Date.parse(event.at) < window.to);
export const halfDayTasks = (tasks: readonly TaskState[], window: Window) =>
  top(
    tasks.filter((task) => changedIn(task, window)),
    10,
    (a, b) => b.latest - a.latest || byText(a.row.id, b.row.id),
  );

export function halfDayOf(built: Built, window: Window, day: string): HalfDay {
  const spans = clipAll(built.spans, window.from, window.to);
  const targets = new Map<string, { target: Target; minutes: number }>();
  const places = new Map<string, { place: Place; minutes: number }>();
  const categories = new Map<ActivityCategory, number>();
  for (const span of spans) {
    const target = targetOf(span);
    if (target !== null) {
      const key = targetKey(target);
      targets.set(key, { target, minutes: (targets.get(key)?.minutes ?? 0) + span.minutes });
    }
    for (const place of span.places) {
      const key = `${place.kind}:${place.value}`;
      places.set(key, { place, minutes: (places.get(key)?.minutes ?? 0) + span.minutes });
    }
    const category = span.category ?? "other";
    categories.set(category, (categories.get(category) ?? 0) + span.minutes);
  }
  const targetList = top(
    [...targets.entries()].map(([key, entry]) => ({ key, ...entry })),
    10,
    (a, b) => b.minutes - a.minutes || byText(a.key, b.key),
  );
  const placeList = top(
    [...places.entries()].map(([key, entry]) => ({ key, ...entry })),
    30,
    (a, b) => b.minutes - a.minutes || byText(a.key, b.key),
  );
  const sessionList = top(
    built.sessions.filter((one) => one.end > window.from && one.start < window.to),
    20,
    (a, b) => b.minutes - a.minutes || a.start - b.start,
  );
  const meetingList = top(
    built.inputs.rows.filter(
      (row) => row.kind === "meeting" && row.startedAt >= window.from && row.startedAt < window.to,
    ),
    10,
    (a, b) => a.startedAt - b.startedAt || byText(a.id, b.id),
  );
  const threads = new Map<string, { app: string; thread: string | null; lines: number }>();
  for (const row of built.inputs.rows) {
    if (
      row.kind !== "moment" ||
      row.work?.kind !== "moment" ||
      row.startedAt < window.from ||
      row.startedAt >= window.to
    )
      continue;
    const key = JSON.stringify([row.work.bundle, row.work.thread]);
    threads.set(key, {
      app: row.work.bundle,
      thread: row.work.thread,
      lines: (threads.get(key)?.lines ?? 0) + row.work.lines,
    });
  }
  const threadList = top([...threads.entries()], 5, (a, b) => b[1].lines - a[1].lines || byText(a[0], b[0]));
  const pageList = halfDayPages(built, window);
  const taskList = halfDayTasks(built.tasks, window);
  const targetViews = targetList.list
    .map((entry) => ({ view: targetView(built, entry.target), minutes: entry.minutes }))
    .filter((one) => one.view !== null);
  return {
    from: iso(window.from),
    to: iso(window.to),
    coverage: withLinesPast(coverageOf(built, window, day), built.inputs.rows, window),
    targets: targetViews.map((one) => ({ target: one.view as WorkTarget, minutes: tenths(one.minutes) })),
    byPlace: placeList.list.map((one) => ({
      by: one.place.kind,
      value: untrusted(one.place.value),
      minutes: tenths(one.minutes),
    })),
    ...(pageList === null ? {} : { pages: pageList.list }),
    byCategory: [...categories.entries()]
      .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
      .map(([category, minutes]) => ({ category, minutes: tenths(minutes) })),
    sessions: sessionList.list.map((one) => sessionView(built, one)).filter((one): one is WorkSession => one !== null),
    meetings: meetingList.list.map((row) => {
      const project = built.linked(row, row.compartments);
      return {
        meeting: row.meeting ?? null,
        capture: row.id as HalfDay["meetings"][number]["capture"],
        start: iso(row.startedAt),
        end: iso(row.endedAt),
        project: project === null ? null : whoOf(built)(project),
      };
    }),
    threads: threadList.list.map(([, one]) => ({
      app: untrusted(one.app),
      thread: one.thread === null ? null : untrusted(one.thread),
      lines: one.lines,
    })),
    tasks: taskList.list.map((task) => taskView(built, task)),
    more:
      targetList.more ||
      placeList.more ||
      sessionList.more ||
      meetingList.more ||
      threadList.more ||
      taskList.more ||
      pageList?.more === true,
  };
}

// They credit no minute and add no place.
function halfDayPages(built: Built, window: Window): { list: NonNullable<HalfDay["pages"]>; more: boolean } | null {
  const pages = new Map<
    string,
    { url: string; title: string | null; query: string | null; visits: number; latest: number }
  >();
  let any = false;
  for (const row of built.inputs.rows) {
    if (row.kind !== "block" || row.work?.kind !== "block") continue;
    for (const block of row.work.blocks) {
      for (const page of block.pages ?? []) {
        const last = Date.parse(page.lastAt);
        if (last < window.from || Date.parse(page.firstAt) >= window.to) continue;
        any = true;
        const key = JSON.stringify([page.url, page.query ?? null]);
        const held = pages.get(key);
        if (held === undefined)
          pages.set(key, {
            url: page.url,
            title: page.title ?? null,
            query: page.query ?? null,
            visits: page.count,
            latest: last,
          });
        else {
          held.visits += page.count;
          if (last > held.latest) Object.assign(held, { latest: last, title: page.title ?? null });
        }
      }
    }
  }
  if (!any) return null;
  const listed = top(
    [...pages.values()],
    HALF_DAY_PAGES,
    (a, b) =>
      b.visits - a.visits || b.latest - a.latest || byText(a.url, b.url) || byText(a.query ?? "", b.query ?? ""),
  );
  return {
    list: listed.list.map((one) => ({
      url: untrusted(one.url),
      title: one.title === null ? null : untrusted(one.title),
      query: one.query === null ? null : untrusted(one.query),
      visits: one.visits,
    })),
    more: listed.more,
  };
}
