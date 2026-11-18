// The daily proposal pass's groups, pure: the stretches of a local day no rule credited, cut by the
// thread on screen and gathered by what code can see of them. Nothing here reads a model's words;
// the store opens what a group's text is made from and the extract package asks. A model chooses
// among these; code writes what it chooses.

import { TIME_GROUP_MIN_MINUTES, TIME_THREAD_HOLD_MS } from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { MINUTE_MS } from "../days.ts";
import type { Place, SubSpan, WorkRow } from "./work-time-credit.ts";

// One piece of uncredited time, with the moment whose thread names it, if any.
export type TimeStretch = {
  from: number;
  to: number;
  row: string;
  evidence: string;
  bundle: string;
  host: string | null;
  places: readonly Place[];
  moment: WorkRow | null;
};

export type Interval = { from: number; to: number };

// What is left of `span` once every interval of `cut` is taken out.
export function without(span: Interval, cut: readonly Interval[]): Interval[] {
  const left: Interval[] = [];
  let cursor = span.from;
  for (const one of [...cut].sort((a, b) => a.from - b.from)) {
    if (one.to <= cursor || one.from >= span.to) continue;
    if (one.from > cursor) left.push({ from: cursor, to: one.from });
    cursor = Math.max(cursor, one.to);
  }
  if (cursor < span.to) left.push({ from: cursor, to: span.to });
  return left;
}

const placeOf = (places: readonly Place[], kind: Place["kind"]): string | null =>
  places.find((one) => one.kind === kind)?.value ?? null;

// A moment says what a chat window showed for its own seconds, but the window stays on that thread.
// So a thread names the time in the same app from when it was read until another is read or
// TIME_THREAD_HOLD_MS after it was last read: the latest started at or before the piece, ties by
// the lower id, cut at each moment's start.
function byThread(span: Interval, moments: readonly WorkRow[]): { from: number; to: number; moment: WorkRow | null }[] {
  const edges = new Set([span.from, span.to]);
  for (const moment of moments) {
    for (const at of [moment.startedAt, moment.endedAt + TIME_THREAD_HOLD_MS])
      if (at > span.from && at < span.to) edges.add(at);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const pieces: { from: number; to: number; moment: WorkRow | null }[] = [];
  for (let at = 0; at + 1 < sorted.length; at += 1) {
    const from = sorted[at] as number;
    const to = sorted[at + 1] as number;
    const moment =
      moments
        .filter((one) => one.startedAt <= from && one.endedAt + TIME_THREAD_HOLD_MS >= to)
        .sort((a, b) => b.startedAt - a.startedAt || byText(a.id, b.id))[0] ?? null;
    const last = pieces.at(-1);
    if (last !== undefined && last.moment === moment && last.to === from) last.to = to;
    else pieces.push({ from, to, moment });
  }
  return pieces;
}

// The day's uncredited block time inside `day`, as credited under one label: never a meeting's own
// interval, never a stretch an earlier answer already holds (`settled`, which is what makes a veto
// stick), never an app or host the owner named (`excepted`).
export function uncreditedStretches(
  spans: readonly SubSpan[],
  rows: readonly WorkRow[],
  day: Interval,
  settled: readonly Interval[],
  excepted: (bundle: string, host: string | null) => boolean,
  // A moment's own host, a browser moment's URL's; null for none, undefined when it cannot be told.
  momentHost: (moment: WorkRow) => string | null | undefined = () => null,
): TimeStretch[] {
  const evidence = new Map(rows.map((row) => [row.id, row.evidence]));
  // A moment of a site or app the owner named says nothing, and one that cannot be told apart is
  // treated as one.
  const threads = new Map<string, { row: WorkRow; host: string | null }[]>();
  for (const row of rows) {
    if (row.work?.kind !== "moment" || row.work.thread === null) continue;
    const host = momentHost(row);
    if (host === undefined || excepted(row.work.bundle, host)) continue;
    const bundle = row.work.bundle.toLowerCase();
    threads.set(bundle, [...(threads.get(bundle) ?? []), { row, host }]);
  }
  const stretches: TimeStretch[] = [];
  for (const span of spans) {
    if (span.meeting || span.project !== null || span.basis !== "none") continue;
    const bundle = placeOf(span.places, "app");
    if (bundle === null) continue;
    const host = placeOf(span.places, "host");
    if (excepted(bundle, host)) continue;
    const inside = { from: Math.max(span.from, day.from), to: Math.min(span.to, day.to) };
    if (inside.to <= inside.from) continue;
    for (const left of without(inside, settled)) {
      // A moment on a site speaks only for that site's time in the same browser.
      const speaking = (threads.get(bundle.toLowerCase()) ?? [])
        .filter((one) => one.host === null || one.host === host)
        .map((one) => one.row);
      for (const piece of byThread(left, speaking)) {
        stretches.push({
          ...piece,
          row: span.row,
          evidence: evidence.get(span.row) ?? "",
          bundle,
          host,
          places: span.places,
        });
      }
    }
  }
  return stretches;
}

// One group: what code sees of its stretches is one thing. `text` is what a person would call it,
// the thread, else the block's title, else its most specific place.
export type TimeGroup = {
  key: string;
  text: string;
  bundle: string;
  host: string | null;
  minutes: number;
  stretches: TimeStretch[];
};

// `titleOf` gives a stretch's block title, opened and judged by the store; null when it has none.
export function groupStretches(
  stretches: readonly TimeStretch[],
  titleOf: (stretch: TimeStretch) => string | null,
): TimeGroup[] {
  const groups = new Map<string, TimeGroup>();
  for (const stretch of stretches) {
    const thread = stretch.moment?.work?.kind === "moment" ? stretch.moment.work.thread : null;
    const text = thread ?? titleOf(stretch) ?? stretch.places[0]?.value ?? stretch.bundle;
    const key = [stretch.bundle.toLowerCase(), stretch.host ?? "", text.trim().toLowerCase()].join("\n");
    let group = groups.get(key);
    if (group === undefined)
      groups.set(key, (group = { key, text, bundle: stretch.bundle, host: stretch.host, minutes: 0, stretches: [] }));
    group.minutes += (stretch.to - stretch.from) / MINUTE_MS;
    group.stretches.push(stretch);
  }
  return [...groups.values()]
    .filter((group) => group.minutes >= TIME_GROUP_MIN_MINUTES)
    .sort((a, b) => b.minutes - a.minutes || byText(a.key, b.key));
}

// What code makes of a model's answer for one day and label. Each group goes to at most one
// choice; one the model named twice, or a project it may not name, is refused and counted. A group
// the answer does not name stays uncredited. `allowed` is the active projects within the label;
// nothing else of the answer is read.
export type TimeChoices = {
  assigned: { group: string; project: string }[];
  efforts: string[];
  refused: number;
};
export function checkedChoices(
  answer: { assignments: readonly { project: string; groups: readonly string[] }[]; newEfforts: readonly string[] },
  groups: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): TimeChoices {
  const named = new Map<string, number>();
  for (const one of [...answer.assignments.flatMap((choice) => choice.groups), ...answer.newEfforts])
    named.set(one, (named.get(one) ?? 0) + 1);
  const usable = (group: string): boolean => groups.has(group) && named.get(group) === 1;
  const assigned: TimeChoices["assigned"] = [];
  let refused = 0;
  for (const choice of answer.assignments) {
    for (const group of choice.groups) {
      if (usable(group) && allowed.has(choice.project)) assigned.push({ group, project: choice.project });
      else refused += 1;
    }
  }
  const efforts = answer.newEfforts.filter(usable);
  refused += answer.newEfforts.length - efforts.length;
  return { assigned, efforts, refused };
}
