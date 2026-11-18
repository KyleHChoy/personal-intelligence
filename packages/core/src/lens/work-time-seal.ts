// The drain's half of work time: what is sealed in work_enc for one block day, moment or task,
// with the attribute checks and title fingerprints it applies. Pure: no clock, no key, no
// database.

import {
  type ActivityTable,
  type BlockAttribute,
  type BlockAttributeMethod,
  type BlockCut,
  type BlockItem,
  type CaptureWork,
  type CutReasons,
  type MomentItem,
  type TaskItem,
  TITLE_NAMES_MOST,
} from "@intelligence/contracts/personal";
import { tenths } from "../units.ts";
import { categoryOf } from "./activity.ts";
import { deviceAnchorKey, titleMatchKeys } from "./anchors.ts";
import { sum, within } from "./work-time-units.ts";

// ---------------------------------------------------------------------------------------------
// The drain's half.

type AttributeKind = "repository" | "folder" | "document";

// A path's last segment, in Unicode's default lower case.
const lastSegment = (value: string): string =>
  value
    .split("/")
    .filter((part) => part.length > 0)
    .at(-1)
    ?.toLowerCase() ?? "";
// A character that cannot be inside a path segment as a title shows one.
const SEGMENT_EDGE = /[\s/\\"'()[\]{}<>:;,|—–]/u;

export function attributeCheck(
  kind: AttributeKind,
  attribute: Pick<BlockAttribute, "value" | "method">,
  title: string | undefined,
): boolean {
  const answer = deviceAnchorKey(kind === "repository" ? "repository" : "document", attribute.value);
  if (!("key" in answer)) return false;
  if (attribute.method !== "window_title_path") return true;
  if (title === undefined) return false;
  const segment = lastSegment(attribute.value);
  const text = title.toLowerCase();
  if (segment.length === 0) return false;
  for (let at = text.indexOf(segment); at !== -1; at = text.indexOf(segment, at + 1)) {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + segment.length] ?? "";
    if ((before === "" || SEGMENT_EDGE.test(before)) && (after === "" || SEGMENT_EDGE.test(after))) return true;
  }
  return false;
}

export const lineCount = (text: string): number => text.split("\n").filter((line) => /[\p{L}\p{N}]/u.test(line)).length;

export type WorkSealed = { work: CaptureWork; refused: Partial<Record<BlockAttributeMethod, number>> };

function sealedThrough(through: string, blocks: readonly { end: string }[]): string {
  const minute = through.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(?:\.\d+)?/, "$1:00");
  const last = blocks.reduce<string | null>(
    (latest, one) => (latest === null || Date.parse(one.end) > Date.parse(latest) ? one.end : latest),
    null,
  );
  return last !== null && Date.parse(last) > Date.parse(minute) ? last : minute;
}

// A block day is the caller's split for one compartment, with that split's cut entries; its
// category is the activity category table's word for the block's raw fields, null with no table. A
// moment's bundle and thread are its CaptureFacts' as the captures hook leaves them. A task's
// fields are as pushed. Given the store's keyed fingerprints (`titles`: `fp`, of the `anchor`
// kind), a block's title and a moment's thread title are sealed as the fingerprints of their
// `title:` keys (titleMatchKeys), never as text; without it, none is sealed, nor a title `kept`
// refuses. A block's title's `name` and `address` fingerprints (`names`) go in the day's `titles`
// (withTitles), so a person's erasure judges the title from work_enc alone; a moment's thread is
// sealed already.
export type TitleSeal = {
  fp: (key: string) => string;
  names: (title: string) => readonly string[];
  kept?: (title: string) => boolean;
};
export function captureWorkOf(
  item: (Omit<BlockItem, "cut"> & { cut?: readonly BlockCut[] | undefined }) | MomentItem | TaskItem,
  context: {
    table: ActivityTable | null;
    facts?: { bundle: string; thread: string | null };
    titles?: TitleSeal;
    unfiled?: Extract<CaptureWork, { kind: "block" }>["cut"]["unfiled"];
  },
): WorkSealed {
  const refused: Partial<Record<BlockAttributeMethod, number>> = {};
  const fpsOf = titleFpsOf(context.titles);
  switch (item.kind) {
    case "block": {
      const blocks = item.blocks.map((one) => {
        const kept = (kind: AttributeKind, attribute: BlockAttribute | undefined) => {
          if (attribute === undefined) return {};
          if (attributeCheck(kind, attribute, one.title))
            return { [kind]: { value: attribute.value, method: attribute.method } };
          refused[attribute.method] = (refused[attribute.method] ?? 0) + 1;
          return {};
        };
        const sealed = {
          start: one.start,
          end: one.end,
          minutes: one.minutes,
          bundle: one.app.bundle,
          ...(one.host === undefined ? {} : { host: one.host }),
          category:
            context.table === null
              ? null
              : categoryOf({ bundle: one.app.bundle, host: one.host ?? null }, context.table),
          ...kept("repository", one.repository),
          ...kept("folder", one.folder),
          ...kept("document", one.document),
          ...(one.pages === undefined || one.pages.length === 0 ? {} : { pages: one.pages }),
        };
        return sealed;
      });
      const cut = item.cut ?? [];
      const seen = item.coveredThrough === undefined ? undefined : sealedThrough(item.coveredThrough, item.blocks);
      const day: BlockWork = {
        kind: "block",
        blocks,
        cut: {
          blocks: sum(cut.map((one) => one.blocks)),
          minutes: tenths(sum(cut.map((one) => one.minutes))),
          ...(context.unfiled === undefined ? {} : { unfiled: context.unfiled }),
        },
        ...(seen === undefined ? {} : { coveredThrough: seen }),
      };
      const { titles } = context;
      if (titles === undefined) return { work: day, refused };
      const titleOf = (_block: WorkBlock, at: number) => {
        const one = item.blocks[at];
        return one === undefined ? null : sealedTitle(fpsOf, titles, one.title, () => one.app.name);
      };
      return { work: withTitles(day, titleOf), refused };
    }
    case "moment": {
      if (context.facts === undefined) throw new Error("work: a moment's work needs its facts");
      const threadFps = fpsOf(context.facts.thread, () => item.app.name);
      return {
        work: {
          kind: "moment",
          bundle: context.facts.bundle,
          thread: context.facts.thread,
          lines: lineCount(item.text),
          ...(threadFps.length === 0 ? {} : { threadFps }),
        },
        refused,
      };
    }
    case "task":
      return {
        work: {
          kind: "task",
          title: item.title,
          ...(item.project === undefined ? {} : { project: item.project }),
          events: item.events,
          ...(item.doneAt === undefined ? {} : { doneAt: item.doneAt }),
        },
        refused,
      };
  }
}

type BlockWork = Extract<CaptureWork, { kind: "block" }>;
type WorkBlock = BlockWork["blocks"][number];

// A title's fingerprints under `seal`, or none, memoized by title and app for one item (the app's
// name read only for a title), since a block day repeats its window titles and titleMatchKeys
// normalizes every word-end prefix of one.
export function titleFpsOf(
  seal: TitleSeal | undefined,
): (title: string | null | undefined, appName: () => string) => string[] {
  const memo = new Map<string, string[]>();
  return (title, appName) => {
    if (seal === undefined || title === null || title === undefined || seal.kept?.(title) === false) return [];
    const app = appName();
    const key = `${app}\u0000${title}`;
    let fps = memo.get(key);
    if (fps === undefined) memo.set(key, (fps = titleMatchKeys(title, app).map(seal.fp)));
    return fps;
  };
}

// A block title's fingerprints and name fingerprints, as withTitles takes them; null for none. None
// for a title with more name fingerprints than TITLE_NAMES_MOST, so work_enc always parses and the
// erasure never judges a title it lacks names for.
export function sealedTitle(
  fpsOf: ReturnType<typeof titleFpsOf>,
  seal: TitleSeal,
  title: string | null | undefined,
  appName: () => string,
): { fps: readonly string[]; names: readonly string[] } | null {
  if (title === null || title === undefined) return null;
  const names = seal.names(title);
  if (new Set(names).size > TITLE_NAMES_MOST) return null;
  const fps = fpsOf(title, appName);
  return fps.length === 0 ? null : { fps, names };
}

// A block day with each block's title as `titleOf` gives it (its fingerprints, and its name
// fingerprints once a day in `titles`, at the block's `titleAt`), or none. The drain, the catch-up
// and the erasure build a day's titles with it alone.
export function withTitles(
  work: BlockWork,
  titleOf: (block: WorkBlock, at: number) => { fps: readonly string[]; names: readonly string[] } | null,
): BlockWork {
  const titles: string[][] = [];
  const places = new Map<string, number>();
  const blocks = work.blocks.map((block, at) => {
    const { titleFps: _fps, titleAt: _at, ...rest } = block;
    const title = titleOf(block, at);
    if (title === null || title.fps.length === 0) return rest;
    const names = [...new Set(title.names)].sort();
    const key = names.join(" ");
    let place = places.get(key);
    if (place === undefined) {
      places.set(key, (place = titles.length));
      titles.push(names);
    }
    return { ...rest, titleFps: [...title.fps], titleAt: place };
  });
  const { titles: _titles, ...day } = work;
  return { ...day, blocks, ...(titles.length === 0 ? {} : { titles }) };
}

export function dayCut(
  rows: readonly { work: CaptureWork | null }[],
  clearance: readonly string[],
): { dayCutBlocks: number; dayCutMinutes: number; dayCutReasons?: CutReasons } {
  const reasons: CutReasons = {};
  const add = (reason: keyof CutReasons, count: { blocks: number; minutes: number } | undefined): void => {
    if (count === undefined || count.blocks === 0) return;
    const held = reasons[reason] ?? { blocks: 0, minutes: 0 };
    reasons[reason] = { blocks: held.blocks + count.blocks, minutes: tenths(held.minutes + count.minutes) };
  };
  for (const { work } of rows) {
    if (work?.kind !== "block") continue;
    const { cut } = work;
    add("other", cut);
    if (cut.unfiled !== undefined && within(cut.unfiled.among, clearance))
      for (const reason of ["no_account", "no_host", "no_app", "other"] as const)
        add(reason, cut.unfiled.reasons[reason]);
  }
  const counted = Object.values(reasons).filter((one) => one !== undefined);
  return {
    dayCutBlocks: sum(counted.map((one) => one.blocks)),
    dayCutMinutes: tenths(sum(counted.map((one) => one.minutes))),
    ...(counted.length === 0 ? {} : { dayCutReasons: reasons }),
  };
}
