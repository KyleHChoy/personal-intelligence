import { compactResult, type PersonalReadTool } from "@intelligence/contracts/personal";

// A get_self or get_entity result over the reasoner's cap, cut to fit: a
// profile with the agents' compartments can come to hundreds of thousands of code points, which the
// planner would never see. Neither tool takes a limit, so neither can be asked again smaller. The
// agent API sends a result in its wire form (compactResult), which this takes as it is.
// get_entity's compiled facts are what grows, and code cuts, in this order:
//   1. Each belief keeps its latest cite, without its claim id, which only get_evidence_span takes.
//   2. The facts that rest in no belief go.
//   3. Beliefs go, the least recently confirmed first, until it fits.
// `more` is set when anything of 2 or 3 went: get_beliefs pages the rest by kind. get_self's
// sections are cut by fitSelf below. Pure: nothing a source wrote is read but to measure it, and
// nothing is added.

export type Fitted = { text: string; dropped: number };

// The length of a text in code points, which the reasoner's budgets count.
export const codePoints = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

const sizeOf = (value: unknown): number => codePoints(JSON.stringify(value) ?? "null");

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObject) : []);

// A belief's latest cite, without its claim id, which only get_evidence_span takes; a held cite
// keeps only its time.
const latest = (cite: Obj): Obj => {
  if (cite.held === true) return { held: true, at: cite.at };
  const { id: _id, ...rest } = cite;
  return rest;
};

// get_self's sections. The automated notices in `housekeeping` go first, the oldest first; then
// lines go one at a time from the largest section (in code points, the first of equal ones), its
// last line first, which is its least by rank, and that section says
// `more`; with no line left, the latest meetings go. Null when it cannot fit even so.
// get_self({ domain }) serves a cut section whole.
function fitSelf(result: Obj, max: number): Fitted | null {
  if (!Array.isArray(result.sections)) return null;
  const sections: { section: Obj; lines: Obj[]; more: boolean }[] = listOf(result.sections).map((section) => ({
    section,
    lines: listOf(section.lines),
    more: section.more === true,
  }));
  const upcoming = listOf(result.upcoming);
  const housekeeping = isObject(result.housekeeping) ? result.housekeeping : undefined;
  const notices = housekeeping === undefined ? [] : listOf(housekeeping.lines);
  const noticesGiven = notices.length;
  const build = () => ({
    ...result,
    ...(housekeeping === undefined
      ? {}
      : { housekeeping: { lines: notices, more: housekeeping.more === true || notices.length < noticesGiven } }),
    sections: sections.map((one) => ({ ...one.section, lines: one.lines, more: one.more })),
    upcoming,
  });
  const sizeOfSection = (one: (typeof sections)[number]): number => sizeOf({ ...one.section, lines: one.lines });
  let dropped = 0;
  for (;;) {
    const text = JSON.stringify(build());
    if (codePoints(text) <= max) return { text, dropped };
    if (notices.pop() !== undefined) {
      dropped += 1;
      continue;
    }
    const largest = sections.reduce<(typeof sections)[number] | undefined>(
      (best, one) =>
        one.lines.length > 0 && (best === undefined || sizeOfSection(one) > sizeOfSection(best)) ? one : best,
      undefined,
    );
    if (largest !== undefined) {
      largest.lines.pop();
      largest.more = true;
    } else if (upcoming.pop() === undefined) return null;
    dropped += 1;
  }
}

// The text to send, within `max` code points, or null when the result is not one of the two or
// cannot fit even with no belief.
export function fitResult(tool: PersonalReadTool, value: unknown, max: number): Fitted | null {
  if (tool === "get_self") {
    const result = compactResult(tool, value);
    return isObject(result) ? fitSelf(result, max) : null;
  }
  // get_entity keeps its compiled facts under `facts`.
  const key = "facts";
  if (tool !== "get_entity") return null;
  const result = compactResult(tool, value);
  if (!isObject(result) || !isObject(result[key])) return null;
  const facts = result[key];
  const beliefs: Obj[] = listOf(facts.beliefs).map((belief) => ({
    ...belief,
    cites: listOf(belief.cites).slice(0, 1).map(latest),
  }));
  const claims = listOf(facts.claims);
  const build = (kept: readonly Obj[], withClaims: boolean) => ({
    ...result,
    [key]: {
      beliefs: kept,
      ...(withClaims && claims.length > 0 ? { claims } : {}),
      more: facts.more === true || !withClaims || kept.length < beliefs.length,
    },
  });

  if (sizeOf(build(beliefs, true)) <= max) return { text: JSON.stringify(build(beliefs, true)), dropped: 0 };
  // The oldest confirmed go first, ties by place; what is kept keeps its order.
  const order = beliefs.map((belief, index) => ({
    index,
    at: Date.parse(String(belief.confirmedAt)),
    size: sizeOf(belief) + 1,
  }));
  order.sort((a, b) => a.at - b.at || a.index - b.index);
  const gone = new Set<number>();
  let size = sizeOf(build(beliefs, false));
  for (const one of order) {
    if (size <= max) break;
    gone.add(one.index);
    size -= one.size;
  }
  // The sizes are exact but for a separator: measure again, and take one more while over.
  for (;;) {
    const kept = beliefs.filter((_, index) => !gone.has(index));
    const text = JSON.stringify(build(kept, false));
    if (codePoints(text) <= max) return { text, dropped: claims.length + gone.size };
    const next = order.find((one) => !gone.has(one.index));
    if (next === undefined) return null;
    gone.add(next.index);
  }
}
