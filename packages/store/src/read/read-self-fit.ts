import {
  type BeliefLine,
  compactResult,
  type SelfSection,
  type SelfView,
  type WorkNow,
} from "@intelligence/contracts/personal";
import { pointsOf } from "../core/read-ctx.ts";
import { fitPage } from "./read-self.ts";

// So the whole page, on the wire, aims under SELF_WHOLE_PAGE_CODE_POINTS. What is always wanted keeps its bounds: goals,
// next, open items, the week, contacts, applications. The bulky parts that have a read of their own give way: `work`
// (get_self with `work`), the notices and the sections' lines (get_self with `domain`), each saying `more`. The lines
// take what the rest leaves, so what a later change adds to the head comes out of them and not out of the client's limit.
export const SELF_WHOLE_PAGE_CODE_POINTS = 30_000;
export const PAGE_HOUSEKEEPING_LINES = 3;
export const PAGE_SECTION_PEOPLE = 2;
// One note beside a row of a list, as the lists already serve: a domain, a card or `moves` holds the rest.
const REPORTS_ON_PAGE = 1;
// What a half-day and a day keep on the page, the most minutes or visits first as served. The threads and the pages say
// what the time was on. A day of few places keeps them; past that the targets say the most of them and `more` says so.
const HALF_DAY_ROOM = { targets: 4, pages: 5, sessions: 3, meetings: 3 } as const;
const DEEP_SESSIONS_ON_PAGE = 2;
const WORK_CHANGES_ON_PAGE = 5;

const LINES_KEY_POINTS = '"lines":[],'.length;

// `work` as the page serves it. Nothing here moves a minute: a total stays over everything it was over.
export function boundWork(work: WorkNow): WorkNow {
  let cut = work.changes.length > WORK_CHANGES_ON_PAGE;
  const halfDays = work.halfDays.map((day) => {
    const smaller =
      day.targets.length > HALF_DAY_ROOM.targets ||
      day.byPlace.length > HALF_DAY_ROOM.targets ||
      (day.pages?.length ?? 0) > HALF_DAY_ROOM.pages ||
      day.sessions.length > HALF_DAY_ROOM.sessions ||
      day.meetings.length > HALF_DAY_ROOM.meetings;
    if (!smaller) return day;
    cut = true;
    return {
      ...day,
      targets: day.targets.slice(0, HALF_DAY_ROOM.targets),
      byPlace: [],
      ...(day.pages === undefined ? {} : { pages: day.pages.slice(0, HALF_DAY_ROOM.pages) }),
      sessions: [...day.sessions].sort((a, b) => b.minutes - a.minutes).slice(0, HALF_DAY_ROOM.sessions),
      meetings: day.meetings.slice(0, HALF_DAY_ROOM.meetings),
      more: true,
    };
  });
  const deepWork = work.deepWork.map((day) =>
    day.sessions.length <= DEEP_SESSIONS_ON_PAGE
      ? day
      : { ...day, sessions: day.sessions.slice(0, DEEP_SESSIONS_ON_PAGE), more: true },
  );
  if (deepWork.some((day, index) => day !== work.deepWork[index])) cut = true;
  return {
    ...work,
    halfDays,
    deepWork,
    changes: work.changes.slice(0, WORK_CHANGES_ON_PAGE),
    more: work.more || cut,
  };
}

// What a line costs on the wire, where null, false and empty fields are left out.
const lineOnWire = (line: BeliefLine): number => {
  const { housekeeping } = compactResult("get_self", {
    housekeeping: { lines: [line] },
  }) as { housekeeping: { lines: unknown[] } };
  return pointsOf(housekeeping.lines[0]) + 1;
};

// A constraint the owner stated outranks anything inferred (invariant 11), so it is kept ahead of every other line.
const ownersConstraint = (line: BeliefLine): boolean =>
  line.kind === "constraint" && (line.tier === "owner" || line.tier === "owner_confirmed");

// The lines the rest of the page leaves room for, each section's best first, one round at a time, and the owner's
// constraints before those: every section keeps its first, so no life domain vanishes. They are served in their rank, and
// a section says `more` when cut, how many stale lines it left off, and how many of the owner's constraints.
function fitLines(sections: readonly SelfSection[], budget: number): SelfSection[] {
  const ahead = sections.map((section) => ({
    ...section,
    lines: [...section.lines.filter(ownersConstraint), ...section.lines.filter((line) => !ownersConstraint(line))],
  }));
  const fitted = fitPage(ahead, budget, lineOnWire, true);
  return fitted.map((section, index) => {
    const before = sections[index] as SelfSection;
    const kept = new Set(section.lines);
    const lines = before.lines.filter((line) => kept.has(line));
    const leftOff = (test: (line: BeliefLine) => boolean): number =>
      before.lines.filter(test).length - lines.filter(test).length;
    const staleCut = leftOff((line) => line.stale === true);
    const constraintsCut = leftOff(ownersConstraint);
    return {
      ...section,
      lines,
      ...(staleCut === 0 ? {} : { staleLeftOff: (before.staleLeftOff ?? 0) + staleCut }),
      ...(constraintsCut === 0 ? {} : { constraintsLeftOff: constraintsCut }),
    };
  });
}

export function fitSelfPage(
  value: SelfView & { sections: SelfSection[] },
  // `history` asks for the past, whose lines rank last and would be the first cut: the head gives way, the lines stay.
  options: { keepLines?: boolean } = {},
): SelfView & { sections: SelfSection[] } {
  const housekeeping =
    value.housekeeping === undefined || value.housekeeping.lines.length <= PAGE_HOUSEKEEPING_LINES
      ? value.housekeeping
      : { lines: value.housekeeping.lines.slice(0, PAGE_HOUSEKEEPING_LINES), more: true };
  const bounded = {
    ...value,
    ...(value.next === undefined
      ? {}
      : {
          next: {
            more: value.next.more || value.next.moves.some((move) => (move.reported?.length ?? 0) > REPORTS_ON_PAGE),
            moves: value.next.moves.map(({ reported, ...move }) =>
              reported === undefined ? move : { ...move, reported: reported.slice(0, REPORTS_ON_PAGE) },
            ),
          },
        }),
    ...(housekeeping === undefined ? {} : { housekeeping }),
    ...(value.work === undefined ? {} : { work: boundWork(value.work) }),
    sections: value.sections.map((section) =>
      section.people.length <= PAGE_SECTION_PEOPLE
        ? section
        : { ...section, people: section.people.slice(0, PAGE_SECTION_PEOPLE), more: true },
    ),
  };
  if (options.keepLines === true) return bounded;
  // A section with its lines gone: its people and marks stay on the page, so they count against the lines' room.
  const rest = pointsOf(
    compactResult("get_self", {
      ...bounded,
      sections: bounded.sections.map((section) => ({ ...section, lines: [] })),
    }),
  );
  // A section's lines add their key and brackets back.
  const budget = SELF_WHOLE_PAGE_CODE_POINTS - rest - bounded.sections.length * LINES_KEY_POINTS;
  return { ...bounded, sections: fitLines(bounded.sections, budget) };
}
