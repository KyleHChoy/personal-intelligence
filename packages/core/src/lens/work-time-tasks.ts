// Work time's tasks and the advisory matcher, from the rows and credited sub-spans
// work-time-credit.ts gives. Pure.

import { MATCH_DAYS, MATCH_RULE, type TaskEvent, type WorkedOn } from "@intelligence/contracts/personal";
import { DAY_MS } from "../days.ts";
import { tenths } from "../units.ts";
import { clipAll, type Session, type SubSpan, type WorkProject, type WorkRow } from "./work-time-credit.ts";
import { iso, sum, within } from "./work-time-units.ts";

// ---------------------------------------------------------------------------------------------
// Tasks.

export type TaskState = {
  row: WorkRow;
  title: string;
  project: string | null;
  created: number;
  completion: number | null;
  doneAt: number | null;
  reopened: number;
  latest: number;
  events: readonly TaskEvent[];
};

const normalName = (name: string): string => name.toLowerCase().replace(/\s+/gu, " ").trim();

// `reopened` counts reopenings that follow a completion.
export function taskStateOf(row: WorkRow, projects: readonly WorkProject[]): TaskState | null {
  if (row.work?.kind !== "task") return null;
  const work = row.work;
  let completion: number | null = null;
  let reopened = 0;
  for (const event of work.events) {
    if (event.kind === "completed") completion = Date.parse(event.at);
    if (event.kind === "reopened" && completion !== null) {
      completion = null;
      reopened += 1;
    }
  }
  const typed = work.project === undefined ? null : normalName(work.project);
  const named =
    typed === null
      ? []
      : projects.filter(
          (project) =>
            project.active && within(project.compartments, row.compartments) && normalName(project.name) === typed,
        );
  return {
    row,
    title: work.title,
    project: named.length === 1 ? (named[0]?.id ?? null) : null,
    created: Date.parse(work.events[0]?.at ?? ""),
    completion,
    doneAt: work.doneAt === undefined ? null : Date.parse(work.doneAt),
    reopened,
    latest: Date.parse(work.events.at(-1)?.at ?? ""),
    events: work.events,
  };
}

// --------------------------------------------------------------------------------------------- The
// advisory matcher.

export type Matchable = { id: string; start: number; close: number | null; targets: readonly string[] };

export const doneTime = (task: TaskState): number | null =>
  task.completion === null ? null : (task.doneAt ?? task.completion);

export function matchWindow(item: Matchable, others: readonly Matchable[]): { from: number; to: number } | null {
  const c = item.close;
  if (c === null || item.targets.length === 0) return null;
  const sharing = others.filter(
    (other) => other.id !== item.id && other.targets.some((target) => item.targets.includes(target)),
  );
  const closes = sharing.map((other) => other.close).filter((close): close is number => close !== null && close < c);
  const from = Math.max(...(item.start <= c ? [item.start] : []), c - MATCH_DAYS * DAY_MS, ...closes);
  return { from, to: c };
}

// It closes nothing.
export function matchWorkedOn(
  item: Matchable,
  others: readonly Matchable[],
  spans: readonly SubSpan[],
  sessions: readonly Session[],
  partial: boolean,
): WorkedOn | null {
  const window = matchWindow(item, others);
  if (window === null) return null;
  const onTarget = (project: string | null): boolean => project !== null && item.targets.includes(project);
  const minutes = sum(
    clipAll(spans, window.from, window.to)
      .filter((one) => onTarget(one.project))
      .map((one) => one.minutes),
  );
  const count = sessions.filter(
    (one) =>
      "project" in one.target && onTarget(one.target.project) && one.end >= window.from && one.start <= window.to,
  ).length;
  const shared = others.filter(
    (other) =>
      other.id !== item.id &&
      other.targets.some((target) => item.targets.includes(target)) &&
      other.start <= window.to &&
      (other.close === null || other.close > window.from),
  ).length;
  return {
    rule: MATCH_RULE,
    advisory: true,
    minutes: tenths(minutes),
    sessions: count,
    from: iso(window.from),
    to: iso(window.to),
    shared,
    partial,
  };
}
