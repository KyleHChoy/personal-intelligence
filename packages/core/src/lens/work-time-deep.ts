// Deep work: long stretches of focus on one target, built from credited sub-spans, and one day's
// deep sessions and totals.

import {
  type ActivityCategory,
  type Coverage,
  DEEP_BREAK_MS,
  DEEP_CATEGORIES,
  DEEP_MIN_MS,
  DEEP_RULE,
  DEEP_SESSIONS,
  type DeepSession,
  type DeepTarget,
  type DeepWorkDay,
  dayAfter,
  SESSION_GAP_MS,
  startOfDay,
  type Who,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { MINUTE_MS } from "../days.ts";
import { tenths } from "../units.ts";
import { clipAll, type SubSpan } from "./work-time-credit.ts";
import { iso, sum } from "./work-time-units.ts";

// ---------------------------------------------------------------------------------------------
// Deep work.

type Stretch = {
  key: string;
  from: number;
  to: number;
  minutes: number;
  project: string | null;
  category: ActivityCategory;
};

const focusKey = (span: SubSpan): string =>
  span.meeting || span.basis === "meeting" || span.category === "meetings"
    ? "m"
    : span.project !== null
      ? `p:${span.project}`
      : `c:${span.category ?? "other"}`;
const carryable = (stretch: Stretch): boolean =>
  stretch.key.startsWith("c:") && (DEEP_CATEGORIES as readonly string[]).includes(stretch.category);
const eligible = (key: string): boolean =>
  key.startsWith("p:") || (key.startsWith("c:") && (DEEP_CATEGORIES as readonly string[]).includes(key.slice(2)));

function stretchesOf(spans: readonly SubSpan[]): Stretch[] {
  const stretches: (Stretch & { byCategory: Map<ActivityCategory, number> })[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const key = focusKey(span);
    const category: ActivityCategory = span.meeting ? "meetings" : (span.category ?? "other");
    const last = stretches.at(-1);
    if (last !== undefined && last.key === key && span.from - last.to <= DEEP_BREAK_MS) {
      last.to = Math.max(last.to, span.to);
      last.minutes += span.minutes;
      last.byCategory.set(category, (last.byCategory.get(category) ?? 0) + span.minutes);
    } else
      stretches.push({
        key,
        from: span.from,
        to: span.to,
        minutes: span.minutes,
        project: span.project,
        category,
        byCategory: new Map([[category, span.minutes]]),
      });
  }
  // A stretch's category is the one with most of its minutes, ties by name.
  return stretches.map(({ byCategory, ...stretch }) => ({
    ...stretch,
    project: stretch.key.startsWith("p:") ? stretch.key.slice(2) : null,
    category: [...byCategory.entries()].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0] ?? "other",
  }));
}

type Deep = {
  key: string;
  first: number;
  last: number;
  own: number;
  carried: number;
  interrupting: number[];
  carriedIndexes: number[];
};

function runsOn(key: string, stretches: readonly Stretch[], taken: ReadonlySet<number>, carry: boolean): Deep[] {
  const indexes = stretches
    .map((one, index) => (one.key === key && !taken.has(index) ? index : -1))
    .filter((index) => index >= 0);
  const runs: Deep[] = [];
  let run: Deep | null = null;
  const finish = (): void => {
    if (run !== null) runs.push(run);
    run = null;
  };
  for (const index of indexes) {
    const stretch = stretches[index] as Stretch;
    if (run === null) {
      run = { key, first: index, last: index, own: stretch.minutes, carried: 0, interrupting: [], carriedIndexes: [] };
      continue;
    }
    const current: Deep = run;
    const between = stretches
      .slice(current.last + 1, index)
      .map((one, offset) => ({ one, index: current.last + 1 + offset }));
    const previous = stretches[current.last] as Stretch;
    const elapsed = stretch.from - previous.to;
    const gaps = elapsed - sum(between.map(({ one }) => one.to - one.from));
    const blocked = between.some(({ index: at }) => taken.has(at));
    const tolerated = !blocked && elapsed <= DEEP_BREAK_MS;
    const carried =
      !blocked &&
      carry &&
      between.length > 0 &&
      between.every(({ one }) => carryable(one)) &&
      gaps <= DEEP_BREAK_MS &&
      elapsed <= SESSION_GAP_MS;
    if (!tolerated && !carried) {
      finish();
      run = { key, first: index, last: index, own: stretch.minutes, carried: 0, interrupting: [], carriedIndexes: [] };
      continue;
    }
    for (const { one, index: at } of between) {
      if (carry && carryable(one)) {
        current.carried += one.minutes;
        current.carriedIndexes.push(at);
      } else current.interrupting.push(at);
    }
    current.own += stretch.minutes;
    current.last = index;
  }
  finish();
  return runs;
}

const isDeep = (run: Deep): boolean =>
  eligible(run.key) && (run.own + run.carried) * MINUTE_MS >= DEEP_MIN_MS && run.carried <= run.own;

// Each observed minute is in at most one session.
function deepSessionsOf(stretches: readonly Stretch[]): Deep[] {
  const taken = new Set<number>();
  const sessions: Deep[] = [];
  for (const phase of ["p:", "c:"] as const) {
    const keys = [
      ...new Set(stretches.map((one) => one.key).filter((key) => key.startsWith(phase) && eligible(key))),
    ].sort(byText);
    for (;;) {
      const candidates = keys.flatMap((key) => runsOn(key, stretches, taken, phase === "p:")).filter(isDeep);
      const best = candidates.sort(
        (a, b) =>
          b.own + b.carried - (a.own + a.carried) ||
          (stretches[a.first]?.from ?? 0) - (stretches[b.first]?.from ?? 0) ||
          byText(a.key, b.key),
      )[0];
      if (best === undefined) break;
      sessions.push(best);
      for (let index = best.first; index <= best.last; index += 1) taken.add(index);
    }
  }
  return sessions;
}

export function deepWorkOf(
  day: string,
  spans: readonly SubSpan[],
  coverage: Coverage,
  who: (project: string) => Who | null,
  zone: string | null,
  limit = DEEP_SESSIONS,
): DeepWorkDay {
  const from = startOfDay(day, zone);
  const to = startOfDay(dayAfter(day), zone);
  const clipped = clipAll(spans, from, to);
  const stretches = stretchesOf(clipped);
  const deep = deepSessionsOf(stretches);
  const carriedSet = new Set(deep.flatMap((one) => one.carriedIndexes));
  const observed = sum(clipped.map((one) => one.minutes));
  const meetingMinutes = sum(stretches.filter((one) => one.key === "m").map((one) => one.minutes));
  const deepMinutes = sum(deep.map((one) => one.own + one.carried));
  let switches = 0;
  for (let index = 0; index + 1 < stretches.length; index += 1) {
    const a = stretches[index] as Stretch;
    const b = stretches[index + 1] as Stretch;
    if (b.from - a.to <= DEEP_BREAK_MS && a.key !== b.key && !carriedSet.has(index) && !carriedSet.has(index + 1))
      switches += 1;
  }
  const interruptions = new Map<ActivityCategory, { count: number; minutes: number }>();
  for (const index of deep.flatMap((one) => one.interrupting)) {
    const stretch = stretches[index] as Stretch;
    const category: ActivityCategory = stretch.key === "m" ? "meetings" : stretch.category;
    const entry = interruptions.get(category) ?? { count: 0, minutes: 0 };
    interruptions.set(category, { count: entry.count + 1, minutes: entry.minutes + stretch.minutes });
  }
  const views: (DeepSession & { sort: number })[] = deep.map((one) => {
    const target: DeepTarget = one.key.startsWith("p:")
      ? (() => {
          const project = who(one.key.slice(2));
          return project === null ? { category: "other" as ActivityCategory } : { project };
        })()
      : { category: one.key.slice(2) as ActivityCategory };
    return {
      target,
      start: iso(stretches[one.first]?.from ?? from),
      end: iso(stretches[one.last]?.to ?? from),
      minutes: tenths(one.own + one.carried),
      carriedMinutes: tenths(one.carried),
      interruptions: one.interrupting.length,
      interruptedMinutes: tenths(sum(one.interrupting.map((index) => stretches[index]?.minutes ?? 0))),
      sort: stretches[one.first]?.from ?? from,
    };
  });
  views.sort((a, b) => b.minutes - a.minutes || a.sort - b.sort);
  return {
    rule: DEEP_RULE,
    day: day as DeepWorkDay["day"],
    coverage,
    // A day with blocks left out is not whole, however late Lens saw it.
    complete:
      coverage.through !== null && to - Date.parse(coverage.through) <= SESSION_GAP_MS && coverage.dayCutBlocks === 0,
    sessions: views.slice(0, limit).map(({ sort: _sort, ...view }) => view),
    deepMinutes: tenths(deepMinutes),
    switchingMinutes: tenths(Math.max(0, observed - meetingMinutes - deepMinutes)),
    meetingMinutes: tenths(meetingMinutes),
    switches,
    switchesPerHour: observed === 0 ? null : tenths(switches / (observed / 60)),
    interruptions: [...interruptions.entries()]
      .map(([category, entry]) => ({ category, count: entry.count, minutes: tenths(entry.minutes) }))
      .sort((a, b) => b.minutes - a.minutes || byText(a.category, b.category)),
    more: views.length > limit,
  };
}
