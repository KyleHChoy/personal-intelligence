// get_work_time's view: work time over a window as an agent sorts it, from the credited sub-spans
// workTime@1 gives. Credited minutes by project and basis, uncredited minutes by place as the daily
// pass groups them, and the live proposals in the window. Pure; the store adds the caller's own
// anchors and rulings.

import {
  dayAfter,
  type GetWorkTimeResult,
  startOfDay,
  type Who,
  WORK_TIME_CREDITED,
  WORK_TIME_GROUPS,
  WORK_TIME_PAGES,
  WORK_TIME_STRETCHES,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { tenths } from "../units.ts";
import { groupStretches, uncreditedStretches } from "./time-groups.ts";
import {
  clipAll,
  type Place,
  type SortTitles,
  type SubSpan,
  type WorkInputs,
  type WorkRow,
} from "./work-time-credit.ts";
import { iso, sum, untrusted } from "./work-time-units.ts";

type Window = { from: number; to: number };

export type SortView = Omit<GetWorkTimeResult, "anchors" | "rulings">;

export const sortWindow = (request: { from: string; to: string }, zone: string | null): Window => ({
  from: startOfDay(request.from, zone),
  to: startOfDay(dayAfter(request.to), zone),
});

// The titles of the pages a block day row kept in the app over the stretch, in the order kept.
function pagesOf(
  rows: ReadonlyMap<string, WorkRow>,
  stretch: { row: string; bundle: string; from: number; to: number },
) {
  const work = rows.get(stretch.row)?.work;
  if (work?.kind !== "block") return [];
  return work.blocks.flatMap((block) =>
    block.bundle === stretch.bundle && Date.parse(block.start) < stretch.to && Date.parse(block.end) > stretch.from
      ? (block.pages ?? []).flatMap((page) =>
          page.title === undefined || page.title.trim() === "" ? [] : [page.title],
        )
      : [],
  );
}

// A place as an agent is served it: the chat thread on screen, else the block's most specific place.
// No window title, page title or meeting name unless `inputs.titles` is given: then groups are cut
// by window title, as the daily pass cuts them.
export function sortOf(
  allSpans: readonly SubSpan[],
  inputs: Pick<WorkInputs, "rows" | "rulings" | "partial" | "titles">,
  who: (project: string) => Who | null,
  window: Window,
): SortView {
  const spans = clipAll(allSpans, window.from, window.to);
  const stretchOf = (one: { from: number; to: number }) => ({ from: iso(one.from), to: iso(one.to) });
  const credited = new Map<string, { project: string; basis: SubSpan["basis"]; minutes: number }>();
  for (const span of spans) {
    if (span.project === null || span.basis === "none") continue;
    const key = `${span.project}\n${span.basis}`;
    const entry = credited.get(key) ?? { project: span.project, basis: span.basis, minutes: 0 };
    entry.minutes += span.minutes;
    credited.set(key, entry);
  }
  const creditedList = [...credited.values()]
    .sort((a, b) => b.minutes - a.minutes || byText(a.project, b.project) || byText(a.basis, b.basis))
    .flatMap((one) => {
      const project = who(one.project);
      return project === null || one.basis === "none"
        ? []
        : [{ project, basis: one.basis, minutes: tenths(one.minutes) }];
    });
  const titles = inputs.titles;
  const groups = groupStretches(
    uncreditedStretches(spans, inputs.rows, window, [], () => false),
    titles === undefined ? () => null : titles.window,
  );
  const rowsById = new Map(inputs.rows.map((row) => [row.id, row]));
  // groupStretches leaves out a group under TIME_GROUP_MIN_MINUTES; the total counts every minute.
  const uncreditedMinutes = sum(
    spans.filter((one) => !one.meeting && one.project === null && one.basis === "none").map((one) => one.minutes),
  );
  const uncredited = groups.map((group) => {
    const first = group.stretches[0];
    const thread = first?.moment?.work?.kind === "moment" ? first.moment.work.thread : null;
    const place = first?.places[0];
    const stretches = [...group.stretches].sort((a, b) => a.from - b.from);
    return {
      place:
        thread !== null && thread !== undefined
          ? { kind: "thread" as const, value: untrusted(thread) }
          : { kind: place?.kind ?? ("app" as const), value: untrusted(place?.value ?? group.bundle) },
      app: untrusted(group.bundle),
      host: group.host === null ? null : untrusted(group.host),
      minutes: tenths(group.minutes),
      stretches: stretches.slice(0, WORK_TIME_STRETCHES).map(stretchOf),
      more: stretches.length > WORK_TIME_STRETCHES,
      ...(titles === undefined ? {} : titled(group.stretches, thread ?? null, titles, rowsById)),
    };
  });
  // The live proposals any of whose stretches the window touches, with the place of the block they
  // cover most.
  const proposalRows = new Map<string, { project: string; stretches: { from: number; to: number }[] }>();
  for (const ruling of inputs.rulings ?? []) {
    if (ruling.source !== "system" || ruling.proposal === undefined || ruling.project === null) continue;
    if (ruling.to <= window.from || ruling.from >= window.to) continue;
    const entry = proposalRows.get(ruling.proposal) ?? { project: ruling.project, stretches: [] };
    entry.stretches.push({ from: ruling.from, to: ruling.to });
    proposalRows.set(ruling.proposal, entry);
  }
  const proposals = [...proposalRows.entries()]
    .sort((a, b) => byText(a[0], b[0]))
    .flatMap(([proposal, entry]) => {
      const project = who(entry.project);
      if (project === null) return [];
      const stretches = entry.stretches.sort((a, b) => a.from - b.from);
      const places = new Map<string, { place: Place; minutes: number }>();
      for (const stretch of stretches)
        for (const span of clipAll(spans, stretch.from, stretch.to))
          if (span.where !== null) {
            const key = `${span.where.kind}:${span.where.value}`;
            places.set(key, { place: span.where, minutes: (places.get(key)?.minutes ?? 0) + span.minutes });
          }
      const place = [...places.values()].sort(
        (a, b) => b.minutes - a.minutes || byText(a.place.value, b.place.value),
      )[0]?.place;
      return [
        {
          proposal: proposal as SortView["proposals"][number]["proposal"],
          project,
          stretches: stretches.slice(0, WORK_TIME_STRETCHES).map(stretchOf),
          place: place === undefined ? null : { kind: place.kind, value: untrusted(place.value) },
        },
      ];
    });
  const meetings = titles === undefined ? null : meetingsOf(spans, titles);
  return {
    from: iso(window.from),
    to: iso(window.to),
    credited: creditedList.slice(0, WORK_TIME_CREDITED),
    uncredited: uncredited.slice(0, WORK_TIME_GROUPS),
    uncreditedMinutes: tenths(uncreditedMinutes),
    ...(meetings === null ? {} : { meetings: meetings.slice(0, WORK_TIME_GROUPS) }),
    proposals: proposals.slice(0, WORK_TIME_GROUPS),
    more:
      inputs.partial.rows ||
      creditedList.length > WORK_TIME_CREDITED ||
      uncredited.length > WORK_TIME_GROUPS ||
      proposals.length > WORK_TIME_GROUPS ||
      (meetings?.length ?? 0) > WORK_TIME_GROUPS ||
      uncredited.some((one) => one.more),
  };
}

// A group's window title (when no thread names it) and its pages' titles, distinct, at most
// WORK_TIME_PAGES.
function titled(
  stretches: readonly { row: string; evidence: string; bundle: string; from: number; to: number }[],
  thread: string | null,
  titles: SortTitles,
  rows: ReadonlyMap<string, WorkRow>,
): { title?: { untrusted: string }; pages: { untrusted: string }[] } {
  const first = stretches[0];
  const title = thread !== null || first === undefined ? null : titles.window(first);
  const pages = [...new Set(stretches.flatMap((stretch) => pagesOf(rows, stretch)))];
  return {
    ...(title === null ? {} : { title: untrusted(title) }),
    pages: pages.slice(0, WORK_TIME_PAGES).map(untrusted),
  };
}

// The uncredited meetings in the window by name, oldest first; one with no name is left out.
function meetingsOf(spans: readonly SubSpan[], titles: SortTitles) {
  const byRow = new Map<string, { from: number; to: number; minutes: number }>();
  for (const span of spans) {
    if (!span.meeting || span.project !== null) continue;
    const entry = byRow.get(span.row);
    if (entry === undefined) byRow.set(span.row, { from: span.from, to: span.to, minutes: span.minutes });
    else {
      entry.from = Math.min(entry.from, span.from);
      entry.to = Math.max(entry.to, span.to);
      entry.minutes += span.minutes;
    }
  }
  return [...byRow.entries()]
    .sort((a, b) => a[1].from - b[1].from || byText(a[0], b[0]))
    .flatMap(([row, entry]) => {
      const name = titles.meeting(row);
      return name === null
        ? []
        : [{ name: untrusted(name), from: iso(entry.from), to: iso(entry.to), minutes: tenths(entry.minutes) }];
    });
}
