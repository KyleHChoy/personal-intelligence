// Crediting work time: who gets each instant of one block, the read's input rows, block
// intervals and credited sub-spans, sessions, task state and worked-on matching. Pure: every
// result comes from the rows the caller's token returned.

import {
  ActivityCategory,
  type Coverage,
  LINES_PAST_NOTE,
  SESSION_GAP_MS,
  SESSION_MIN_MS,
  STRONG_ATTRIBUTE_METHODS,
  type WhereKind,
  type Who,
  WORK_RULE,
  WorkBasisCode,
  type WorkWhere,
} from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";
import { MINUTE_MS } from "../days.ts";
import { blockMatchKeys, deviceAnchorKey, normalHost, normalTitle } from "./anchors.ts";
import { momentHolds } from "./work-time-holds.ts";
import type { WorkRow } from "./work-time-row.ts";
import { iso, sum, untrusted, within } from "./work-time-units.ts";

export type { WorkRow } from "./work-time-row.ts";

export const WORK_TIME_RULE = WORK_RULE;

// `title`, step 4b's window title anchor, apart from step 3's strong `anchor`, so a view never
// reads a prefix match over many items as an attribute match. `proposed`, the system's ruling,
// apart from the owner's `ruling`, so a view never reads a model's suggestion as the owner's word.
// `agent_ruling` and `agent_anchor`, an agent's ruling and anchor, apart from the owner's, so a
// view never reads an agent's word as the owner's.
type WorkBasis = WorkBasisCode;

export type CreditBlockInput = {
  // One block: its span, its minutes, its app's bundle and its keys, and its title's keys, `title:`
  // and a fingerprint each (titleKeysOf).
  block: {
    start: number;
    end: number;
    minutes: number;
    bundle: string;
    keys: readonly { key: string; strong: boolean }[];
    titles?: readonly string[];
  };
  // The owner's live time rulings within the block's label, project null for none.
  rulings: readonly { from: number; to: number; project: string | null }[];
  // The system's live rulings within the block's label, each naming a project.
  proposed?: readonly { from: number; to: number; project: string }[];
  // Agents' live rulings within the block's label, each naming a project.
  agentRulings?: readonly { from: number; to: number; project: string }[];
  // Agents' live anchors of projects within the block's label, at a block key's normal form: read
  // here alone, against the block's strong keys.
  agentAnchors?: readonly { key: string; project: string }[];
  // Meetings within the block's label, each with the one project it is linked to, or null.
  meetings: readonly { from: number; to: number; project: string | null }[];
  // Moments within the block's label or holding all of it, with their app's bundle, their one linked
  // project, their thread title's keys, and the one project their thread is named for, exactly.
  // `carriedTo`: where the moment's thread still holds the window after its own end, at least `to`.
  moments: readonly {
    from: number;
    to: number;
    carriedTo?: number;
    bundle: string;
    project: string | null;
    titles?: readonly string[];
    named?: string | null;
  }[];
  // The live device anchors of projects within the block's label; a window title anchor's key is
  // `title:` and its anchor_fp.
  anchors: readonly { key: string; project: string }[];
};

// One stretch of the block, given to one project or to none, with its share of the block's minutes.
export type WorkCredit = { from: number; to: number; minutes: number; project: string | null; basis: WorkBasis };

// The one value a step's matches agree on; undefined when nothing matched or two differ, so the
// next step is tried.
function single<T>(values: readonly T[]): { value: T } | undefined {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? { value: distinct[0] as T } : undefined;
}

// A partition of the block's span, each stretch decided by the first step that applies: (1) a ruling (two that
// disagree decide none: they are the owner's own, invariant 11), (2) a linked meeting, (3) the block's strong
// keys meeting the anchors of exactly one project, (4) a linked moment of the same bundle, (4b) the titles of
// the stretch, the block's own and those of the same-bundle moments covering it, meeting the window title
// anchors of exactly one project, (4b2) a thread named exactly for a project, over the moment's own span,
// (4b3) steps 4 to 4b2 again over the moments whose thread still holds the window after their own span, only
// where no moment of the app covers the instant itself, (4c1) an agent's ruling, (4c2) the block's strong keys
// meeting an agent's anchors of exactly one project, (4c) a ruling the system proposed, (5) none. A title
// anchor is a prefix rule over many items, so it comes after the owner's link of one item; every anchor and
// link the owner set comes before a proposed ruling (both invariant 11), and two proposals that disagree
// decide none. Adjacent stretches with one answer are one. A block of no length gives none.
export function creditBlock(input: CreditBlockInput): WorkCredit[] {
  const { block } = input;
  const span = block.end - block.start;
  if (span <= 0) return [];
  const inside = (at: number): boolean => at > block.start && at < block.end;
  const edges = [
    ...new Set([
      block.start,
      block.end,
      ...[
        ...input.rulings,
        ...(input.proposed ?? []),
        ...(input.agentRulings ?? []),
        ...input.meetings,
        ...input.moments,
      ]
        .flatMap((one) => [one.from, one.to])
        .filter(inside),
      ...input.moments.flatMap((one) => (one.carriedTo === undefined ? [] : [one.carriedTo])).filter(inside),
    ]),
  ].sort((a, b) => a - b);
  const strong = new Set(block.keys.filter((one) => one.strong).map((one) => one.key));
  const anchored = single(input.anchors.filter((anchor) => strong.has(anchor.key)).map((anchor) => anchor.project));
  const agentAnchored = single(
    (input.agentAnchors ?? []).filter((anchor) => strong.has(anchor.key)).map((anchor) => anchor.project),
  );
  const bundle = block.bundle.toLowerCase();
  const anchorsBy = new Map<string, string[]>();
  for (const anchor of input.anchors) anchorsBy.set(anchor.key, [...(anchorsBy.get(anchor.key) ?? []), anchor.project]);
  // A title meets the projects of the longest of its keys (they run shortest first) that an anchor
  // holds, so an anchor that is a word-boundary prefix of another project's ("alpha" and "alpha
  // plan") leaves the longer one's titles to it, never ambiguous.
  const titleProjects = (titles: readonly string[] = []): readonly string[] => {
    for (let at = titles.length - 1; at >= 0; at -= 1) {
      const projects = anchorsBy.get(titles[at] as string);
      if (projects !== undefined) return projects;
    }
    return [];
  };
  const blockTitled = titleProjects(block.titles);
  const sameApp = input.moments
    .filter((one) => one.bundle.toLowerCase() === bundle)
    .map((one) => ({ ...one, titled: titleProjects(one.titles) }));

  const decide = (from: number, to: number): { project: string | null; basis: WorkBasis } => {
    const covers = (one: { from: number; to: number }): boolean => one.from <= from && one.to >= to;
    const rulings = input.rulings.filter(covers).map((one) => one.project);
    if (rulings.length > 0) return { project: single(rulings)?.value ?? null, basis: "ruling" };
    const meeting = single(
      input.meetings.filter((one) => one.project !== null && covers(one)).map((one) => one.project),
    );
    if (meeting !== undefined) return { project: meeting.value, basis: "meeting" };
    if (anchored !== undefined) return { project: anchored.value, basis: "anchor" };
    // Steps 4 to 4b2 over these moments; the block's own title counts only with the moments on
    // screen, so a carried thread never repeats it.
    const byMoments = (
      covering: typeof sameApp,
      titles: readonly string[],
    ): { project: string; basis: WorkBasis } | undefined => {
      const moment = single(covering.filter((one) => one.project !== null).map((one) => one.project));
      if (moment !== undefined) return { project: moment.value as string, basis: "moment" };
      const titled = single([...titles, ...covering.flatMap((one) => one.titled)]);
      if (titled !== undefined) return { project: titled.value, basis: "title" };
      const named = single(
        covering.flatMap((one) => (one.named === null || one.named === undefined ? [] : [one.named])),
      );
      if (named !== undefined) return { project: named.value, basis: "title" };
      return undefined;
    };
    const covering = sameApp.filter(covers);
    const shown = byMoments(covering, blockTitled);
    if (shown !== undefined) return shown;
    // Step 4b3: a thread carried past its moment, where no moment of the app is on screen.
    if (covering.length === 0) {
      const carried = byMoments(
        sameApp.filter((one) => one.from <= from && (one.carriedTo ?? one.to) >= to),
        [],
      );
      if (carried !== undefined) return carried;
    }
    // An agent's ruling, then an agent's anchor, after every step the owner set or
    // linked and the title steps, and before a model's suggestion. Two agents' projects at one step
    // give none there, and the next step is tried.
    const agentRuled = single((input.agentRulings ?? []).filter(covers).map((one) => one.project));
    if (agentRuled !== undefined) return { project: agentRuled.value, basis: "agent_ruling" };
    if (agentAnchored !== undefined) return { project: agentAnchored.value, basis: "agent_anchor" };
    const proposed = single((input.proposed ?? []).filter(covers).map((one) => one.project));
    if (proposed !== undefined) return { project: proposed.value, basis: "proposed" };
    return { project: null, basis: "none" };
  };

  const credits: WorkCredit[] = [];
  for (let at = 0; at + 1 < edges.length; at += 1) {
    const from = edges[at] as number;
    const to = edges[at + 1] as number;
    const decided = decide(from, to);
    const minutes = (block.minutes * (to - from)) / span;
    const last = credits.at(-1);
    if (last !== undefined && last.project === decided.project && last.basis === decided.basis) {
      last.to = to;
      last.minutes += minutes;
    } else credits.push({ from, to, minutes, ...decided });
  }
  return credits;
}

// --------------------------------------------------------------------------------------------- The
// read's inputs, as the store gathers them under the caller's token.

type WorkRuling = {
  from: number;
  to: number;
  project: string | null;
  source: "owner" | "system";
  compartments: readonly string[];
  // A system ruling's proposal, for get_work_time's list of live ones.
  proposal?: string;
};

// A project the caller can see, with its compartments and status.
export type WorkProject = { id: string; who: Who; name: string; compartments: readonly string[]; active: boolean };

// A commitment for the matcher: its belief, the earliest visible supporting claim's time, its close
// (closedAt), and its targets.
export type WorkCommitment = { id: string; start: number; close: number | null; targets: readonly string[] };

export type WorkInputs = {
  rows: readonly WorkRow[];
  // capture.anchor facts and confirmed capture_project beliefs, each linking one capture item to
  // one project, with the compartments of the claim.
  links: readonly { capture: string; project: string }[];
  // The live time rulings the caller can see: `owner` the owner's, project null for none; `system`
  // a proposal the owner has not vetoed. Absent reads as none.
  rulings?: readonly WorkRuling[];
  // Agents' live rulings and anchors the caller can see, each with its label, which
  // is its project's; a ruling's `reach`, what of its agent's clearance the caller is cleared for, so
  // it credits only a block its agent could see. An anchor's key is a block key's normal form, found by
  // its fingerprint.
  agentRulings?: readonly {
    from: number;
    to: number;
    project: string;
    compartments: readonly string[];
    reach: readonly string[];
  }[];
  agentAnchors?: readonly { key: string; project: string }[];
  // Live device anchors at their normal forms.
  anchors: readonly { key: string; project: string }[];
  projects: readonly WorkProject[];
  commitments: readonly WorkCommitment[];
  partial: { rows: boolean; tasks: boolean };
  // With none, no unfiled cut is served.
  clearance?: readonly string[];
  // Absent, the sort view serves no window title, page title or meeting name.
  titles?: SortTitles;
  zone: string | null;
  now: number;
};

// A stretch's window title and a meeting row's name, each null when there is none to serve.
export type SortTitles = {
  window: (stretch: { row: string; evidence: string; bundle: string; from: number; to: number }) => string | null;
  meeting: (row: string) => string | null;
};

// ---------------------------------------------------------------------------------------------
// Intervals and credits.

export type Place = { kind: WhereKind; value: string; strength: "strong" | "weak" };

// One credited sub-span, the unit every view is built from. `places` are every place its block has;
// `where` the most specific. A meeting's own interval has no place and the category `meetings`.
export type SubSpan = {
  from: number;
  to: number;
  minutes: number;
  project: string | null;
  basis: WorkBasis;
  places: readonly Place[];
  where: Place | null;
  category: ActivityCategory | null;
  meeting: boolean;
  row: string;
};

export type BlockInterval = {
  row: WorkRow;
  index: number;
  start: number;
  end: number;
  minutes: number;
  bundle: string;
  places: Place[];
  category: ActivityCategory | null;
  keys: { key: string; strong: boolean }[];
  titles: string[];
};

// A title's keys as the read compares them with a window title anchor's: `title:` and each sealed
// fingerprint. The read never sees a title.
export const titleKeysOf = (fps: readonly string[] | undefined): string[] => (fps ?? []).map((fp) => `title:${fp}`);

const strengthOf = (method: string): "strong" | "weak" =>
  (STRONG_ATTRIBUTE_METHODS as readonly string[]).includes(method) ? "strong" : "weak";
const PLACE_ORDER: readonly WhereKind[] = ["document", "folder", "repository", "host", "app"];

export function blockIntervals(rows: readonly WorkRow[]): BlockInterval[] {
  const intervals: BlockInterval[] = [];
  for (const row of rows) {
    if (row.kind !== "block" || row.work?.kind !== "block") continue;
    row.work.blocks.forEach((one, index) => {
      const places: Place[] = [];
      if (one.document !== undefined)
        places.push({ kind: "document", value: one.document.value, strength: strengthOf(one.document.method) });
      if (one.folder !== undefined)
        places.push({ kind: "folder", value: one.folder.value, strength: strengthOf(one.folder.method) });
      if (one.repository !== undefined)
        places.push({ kind: "repository", value: one.repository.value, strength: strengthOf(one.repository.method) });
      const host = one.host === undefined ? null : normalHost(one.host);
      if (host !== null) places.push({ kind: "host", value: host, strength: "strong" });
      places.push({ kind: "app", value: one.bundle, strength: "strong" });
      intervals.push({
        row,
        index,
        start: Date.parse(one.start),
        end: Date.parse(one.end),
        minutes: one.minutes,
        bundle: one.bundle,
        places,
        category:
          one.category === null
            ? null
            : ActivityCategory.safeParse(one.category).success
              ? (one.category as ActivityCategory)
              : "other",
        keys: blockMatchKeys({
          app: { bundle: one.bundle },
          host: one.host,
          repository: one.repository,
          document: one.document,
          folder: one.folder,
        }),
        titles: titleKeysOf(one.titleFps),
      });
    });
  }
  return intervals;
}

const mostSpecific = (places: readonly Place[]): Place | null =>
  [...places].sort((a, b) => PLACE_ORDER.indexOf(a.kind) - PLACE_ORDER.indexOf(b.kind))[0] ?? null;

// Where two visible blocks overlap, an instant is the latest-started block's, ties by the lower row
// id, and only its minutes apply; a meeting's own interval counts only where no visible block
// covers it, the earlier-started meeting's where two overlap. Every meeting and project a block's
// credit reads has compartments within the block's; a moment's are within the block's or hold all
// of them.
export function creditIntervals(
  inputs: Pick<WorkInputs, "rows" | "links" | "anchors" | "projects" | "rulings" | "agentRulings" | "agentAnchors">,
): SubSpan[] {
  const linked = linkLookup(inputs);
  const projects = new Map(inputs.projects.map((project) => [project.id, project]));
  const blocks = blockIntervals(inputs.rows)
    .filter((one) => one.end > one.start)
    .sort((a, b) => a.start - b.start || byText(a.row.id, b.row.id) || a.index - b.index);
  const meetings = inputs.rows
    .filter((row) => row.kind === "meeting" && row.endedAt > row.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt || byText(a.id, b.id));
  const moments = inputs.rows
    .filter((row) => row.kind === "moment" && row.work?.kind === "moment")
    .sort((a, b) => a.startedAt - b.startedAt || byText(a.id, b.id));
  const reaching = moments.map((row) => ({ ...row, endedAt: row.endedAt + SESSION_GAP_MS }));
  const ownEnd = new Map(moments.map((row) => [row.id, row.endedAt]));
  const longestMoment = Math.max(0, ...reaching.map((row) => row.endedAt - row.startedAt));
  const holdsByLabel = new Map<string, Map<string, number>>();
  const holdsUnder = (label: readonly string[]): Map<string, number> => {
    const key = JSON.stringify(label);
    const holds = holdsByLabel.get(key) ?? momentHolds(moments, label);
    holdsByLabel.set(key, holds);
    return holds;
  };
  const longestMeeting = Math.max(0, ...meetings.map((row) => row.endedAt - row.startedAt));

  const owned = ownedPieces(blocks);

  // A ruling a block's credit may read: its label within the block's, and its project too, or none.
  const rulingsWithin = (label: readonly string[], from: number, to: number): WorkRuling[] =>
    (inputs.rulings ?? []).filter((one) => {
      if (one.to <= from || one.from >= to || !within(one.compartments, label)) return false;
      if (one.project === null) return true;
      const project = projects.get(one.project);
      return project !== undefined && within(project.compartments, label);
    });

  // What a block's credit may read, once per label.
  const projectWithin = (id: string, label: readonly string[]): boolean => {
    const project = projects.get(id);
    return project !== undefined && within(project.compartments, label);
  };
  // The owner's anchors and an agent's, each read once per label.
  const anchorsOf = (all: CreditBlockInput["anchors"]) => {
    const byLabel = new Map<string, CreditBlockInput["anchors"]>();
    return (label: readonly string[]): CreditBlockInput["anchors"] => {
      const key = JSON.stringify(label);
      const found = byLabel.get(key) ?? all.filter((anchor) => projectWithin(anchor.project, label));
      byLabel.set(key, found);
      return found;
    };
  };
  const anchorsWithin = anchorsOf(inputs.anchors);
  const agentAnchorsWithin = anchorsOf(inputs.agentAnchors ?? []);
  // An agent's ruling: within the block's label, and the block within what its agent could see.
  const agentRulingsWithin = (label: readonly string[], from: number, to: number) =>
    (inputs.agentRulings ?? []).filter(
      (one) =>
        one.to > from &&
        one.from < to &&
        within(one.compartments, label) &&
        within(label, one.reach) &&
        projectWithin(one.project, label),
    );

  // Code compares the two as text; nothing is stored and no model reads it. A thread with no title keys
  // makes none, as a person's erasure leaves one. To turn it off, this answers null.
  const projectsByName = new Map<string, WorkProject[]>();
  for (const one of inputs.projects) {
    const name = normalTitle(one.name);
    if (!one.active || !name.includes(" ") || !("key" in deviceAnchorKey("window_title", one.name))) continue;
    projectsByName.set(name, [...(projectsByName.get(name) ?? []), one]);
  }
  const threadProjectOf = (work: WorkRow["work"], label: readonly string[]): string | null => {
    if (work?.kind !== "moment" || work.thread === null || work.threadFps === undefined) return null;
    const named = (projectsByName.get(normalTitle(work.thread)) ?? []).filter((one) => within(one.compartments, label));
    return named.length === 1 ? (named[0] as WorkProject).id : null;
  };

  const spans: SubSpan[] = [];
  for (const piece of owned) {
    const block = piece.block;
    const label = block.row.compartments;
    const span = block.end - block.start;
    const near = (rows: readonly WorkRow[], longest: number): WorkRow[] =>
      overlapping(rows, piece.from, piece.to, longest).filter((row) => within(row.compartments, label));
    const credits = creditBlock({
      block: {
        start: piece.from,
        end: piece.to,
        minutes: (block.minutes * (piece.to - piece.from)) / span,
        bundle: block.bundle,
        keys: block.keys,
        titles: block.titles,
      },
      rulings: rulingsWithin(label, piece.from, piece.to).filter((one) => one.source === "owner"),
      // A proposal is written with its block's very label, so a narrower one is another block's.
      proposed: rulingsWithin(label, piece.from, piece.to).flatMap((one) =>
        one.source === "system" && one.project !== null && one.compartments.length === label.length
          ? [{ ...one, project: one.project }]
          : [],
      ),
      meetings: near(meetings, longestMeeting).map((row) => ({
        from: row.startedAt,
        to: row.endedAt,
        project: linked(row, label),
      })),
      // A moment may also be wider than the block: every row here is one the caller's token
      // returned, so a caller served this credit is cleared for both labels, and one who is not
      // never has the moment.
      moments: overlapping(reaching, piece.from, piece.to, longestMoment)
        .filter((row) => within(row.compartments, label) || within(label, row.compartments))
        .map((row) => ({
          from: row.startedAt,
          to: ownEnd.get(row.id) ?? row.endedAt,
          carriedTo: holdsUnder(label).get(row.id) ?? ownEnd.get(row.id) ?? row.endedAt,
          bundle: row.work?.kind === "moment" ? row.work.bundle : "",
          project: linked(row, label),
          titles: row.work?.kind === "moment" ? titleKeysOf(row.work.threadFps) : [],
          named: threadProjectOf(row.work, label),
        })),
      anchors: anchorsWithin(label),
      agentRulings: agentRulingsWithin(label, piece.from, piece.to),
      agentAnchors: agentAnchorsWithin(label),
    });
    for (const credit of credits) {
      spans.push({
        from: credit.from,
        to: credit.to,
        minutes: credit.minutes,
        project: credit.project,
        basis: credit.basis,
        places: block.places,
        where: mostSpecific(block.places),
        category: block.category,
        meeting: false,
        row: block.row.id,
      });
    }
  }

  spans.push(...meetingsUncovered(meetings, owned, longestMeeting, linked));
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}

type OwnedPiece = { block: BlockInterval; from: number; to: number };

// Elementary pieces of the blocks' union, each owned by one block: a sweep with the blocks
// active at each edge, the latest-started owning it, ties by the lower row id. `blocks` are in
// start order.
function ownedPieces(blocks: readonly BlockInterval[]): OwnedPiece[] {
  const edges = [...new Set(blocks.flatMap((one) => [one.start, one.end]))].sort((a, b) => a - b);
  const owned: OwnedPiece[] = [];
  let active: BlockInterval[] = [];
  let next = 0;
  for (let at = 0; at + 1 < edges.length; at += 1) {
    const from = edges[at] as number;
    const to = edges[at + 1] as number;
    while (next < blocks.length && (blocks[next] as BlockInterval).start <= from)
      active.push(blocks[next++] as BlockInterval);
    active = active.filter((one) => one.end > from);
    let owner: BlockInterval | undefined;
    for (const one of active) {
      if (one.end < to) continue;
      if (
        owner === undefined ||
        one.start > owner.start ||
        (one.start === owner.start &&
          (byText(one.row.id, owner.row.id) < 0 || (one.row.id === owner.row.id && one.index < owner.index)))
      )
        owner = one;
    }
    if (owner === undefined) continue;
    const last = owned.at(-1);
    if (last !== undefined && last.block === owner && last.to === from) last.to = to;
    else owned.push({ block: owner, from, to });
  }
  return owned;
}

// Meetings' own time where no visible block covers it, the earlier-started meeting's where two
// overlap. `owned` is in time order.
function meetingsUncovered(
  meetings: readonly WorkRow[],
  owned: readonly OwnedPiece[],
  longestMeeting: number,
  linked: ReturnType<typeof linkLookup>,
): SubSpan[] {
  const spans: SubSpan[] = [];
  const meetingEdges = [...new Set(meetings.flatMap((row) => [row.startedAt, row.endedAt]))].sort((a, b) => a - b);
  let cover = 0;
  for (let at = 0; at + 1 < meetingEdges.length; at += 1) {
    const from = meetingEdges[at] as number;
    const to = meetingEdges[at + 1] as number;
    const meeting = overlapping(meetings, from, to, longestMeeting).find(
      (row) => row.startedAt <= from && row.endedAt >= to,
    );
    if (meeting === undefined) continue;
    // The parts of [from, to) no block owns; `owned` is in time order.
    while (cover < owned.length && (owned[cover] as { to: number }).to <= from) cover += 1;
    let cursor = from;
    for (let index = cover; index < owned.length && cursor < to; index += 1) {
      const piece = owned[index] as { from: number; to: number };
      if (piece.from >= to) break;
      if (piece.from > cursor)
        spans.push(meetingSpan(meeting, cursor, piece.from, linked(meeting, meeting.compartments)));
      cursor = Math.max(cursor, piece.to);
    }
    if (cursor < to) spans.push(meetingSpan(meeting, cursor, to, linked(meeting, meeting.compartments)));
  }
  return spans;
}

// Rows sorted by start that overlap [from, to): a binary search to the first that can, given the
// longest row's length, then a scan. Kept in start order, ties by id.
function overlapping(rows: readonly WorkRow[], from: number, to: number, longest: number): WorkRow[] {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((rows[middle] as WorkRow).startedAt < from - longest) low = middle + 1;
    else high = middle;
  }
  const found: WorkRow[] = [];
  for (let index = low; index < rows.length; index += 1) {
    const row = rows[index] as WorkRow;
    if (row.startedAt >= to) break;
    if (row.endedAt > from) found.push(row);
  }
  return found;
}

// On a half-day's coverage alone, as its threads are.
export function withLinesPast(
  coverage: Coverage,
  rows: readonly WorkRow[],
  window: { from: number; to: number },
): Coverage {
  const through = coverage.through === null ? null : Date.parse(coverage.through);
  const from = through ?? window.from;
  let lines = 0;
  let until = from;
  for (const row of rows) {
    if (row.kind !== "moment" || row.work?.kind !== "moment") continue;
    if (row.work.lines === 0 || row.startedAt < from || row.startedAt >= window.to) continue;
    if (through !== null && row.startedAt === through) continue;
    lines += row.work.lines;
    until = Math.max(until, Math.min(row.endedAt, window.to));
  }
  return lines === 0 ? coverage : { ...coverage, linesPast: { lines, until: iso(until), note: LINES_PAST_NOTE } };
}

export function linkLookup(
  inputs: Pick<WorkInputs, "links" | "projects">,
): (row: WorkRow, label: readonly string[]) => string | null {
  const projects = new Map(inputs.projects.map((project) => [project.id, project]));
  const linksOf = new Map<string, string[]>();
  for (const link of inputs.links) linksOf.set(link.capture, [...(linksOf.get(link.capture) ?? []), link.project]);
  const memo = new Map<string, string | null>();
  return (row, label) => {
    const key = `${row.id} ${label.join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const candidates = (linksOf.get(row.id) ?? []).filter((id) => {
      const project = projects.get(id);
      return project !== undefined && within(project.compartments, label);
    });
    const answer = single(candidates)?.value ?? null;
    memo.set(key, answer);
    return answer;
  };
}

const meetingSpan = (meeting: WorkRow, from: number, to: number, project: string | null): SubSpan => ({
  from,
  to,
  minutes: (to - from) / MINUTE_MS,
  project,
  basis: project === null ? "none" : "meeting",
  places: [],
  where: null,
  category: "meetings",
  meeting: true,
  row: meeting.id,
});

// A sub-span clipped to [from, to), its minutes its share; null when nothing is left.
function clip(span: SubSpan, from: number, to: number): SubSpan | null {
  const start = Math.max(span.from, from);
  const end = Math.min(span.to, to);
  if (end <= start) return null;
  const length = span.to - span.from;
  return { ...span, from: start, to: end, minutes: length === 0 ? 0 : (span.minutes * (end - start)) / length };
}
export const clipAll = (spans: readonly SubSpan[], from: number, to: number): SubSpan[] =>
  spans.map((one) => clip(one, from, to)).filter((one): one is SubSpan => one !== null);

// ---------------------------------------------------------------------------------------------
// Targets and sessions.

export type Target = { project: string } | { where: Place };
export const targetOf = (span: SubSpan): Target | null =>
  span.project !== null ? { project: span.project } : span.where !== null ? { where: span.where } : null;
export const targetKey = (target: Target): string =>
  "project" in target ? `p:${target.project}` : `w:${target.where.kind}:${target.where.value}`;
export const placeView = (place: Place): WorkWhere => ({
  kind: place.kind,
  value: untrusted(place.value),
  strength: place.strength,
});

export type Session = {
  target: Target;
  start: number;
  end: number;
  minutes: number;
  top: Place | null;
  basis: WorkBasis;
};

const BASIS_ORDER: readonly WorkBasis[] = WorkBasisCode.options;

// Another target's shorter time inside it does not end it.
export function sessionsOf(spans: readonly SubSpan[]): Session[] {
  const byTarget = new Map<string, { target: Target; spans: SubSpan[] }>();
  for (const span of spans) {
    const target = targetOf(span);
    if (target === null) continue;
    const key = targetKey(target);
    const entry = byTarget.get(key) ?? { target, spans: [] };
    entry.spans.push(span);
    byTarget.set(key, entry);
  }
  const sessions: Session[] = [];
  for (const { target, spans: own } of byTarget.values()) {
    own.sort((a, b) => a.from - b.from);
    let run: SubSpan[] = [];
    const close = (): void => {
      const minutes = sum(run.map((one) => one.minutes));
      if (run.length > 0 && minutes * MINUTE_MS >= SESSION_MIN_MS) {
        const places = new Map<string, { place: Place; minutes: number }>();
        const bases = new Map<WorkBasis, number>();
        for (const one of run) {
          for (const place of one.where === null ? [] : [one.where]) {
            const key = `${place.kind}:${place.value}`;
            places.set(key, { place, minutes: (places.get(key)?.minutes ?? 0) + one.minutes });
          }
          bases.set(one.basis, (bases.get(one.basis) ?? 0) + one.minutes);
        }
        const top =
          [...places.values()].sort(
            (a, b) =>
              b.minutes - a.minutes ||
              PLACE_ORDER.indexOf(a.place.kind) - PLACE_ORDER.indexOf(b.place.kind) ||
              byText(a.place.value, b.place.value),
          )[0]?.place ?? null;
        const basis: WorkBasis =
          [...bases.entries()].sort(
            (a, b) => b[1] - a[1] || BASIS_ORDER.indexOf(a[0]) - BASIS_ORDER.indexOf(b[0]),
          )[0]?.[0] ?? "none";
        sessions.push({ target, start: run[0]?.from ?? 0, end: run.at(-1)?.to ?? 0, minutes, top, basis });
      }
      run = [];
    };
    for (const span of own) {
      const last = run.at(-1);
      if (last !== undefined && span.from - last.to > SESSION_GAP_MS) close();
      run.push(span);
    }
    close();
  }
  return sessions.sort((a, b) => a.start - b.start || byText(targetKey(a.target), targetKey(b.target)));
}
