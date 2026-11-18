import { ActivityCategory, type ActivityDay, ActivityTable, type BlockItem } from "@intelligence/contracts/personal";
import { repoFile } from "../repo-root.ts";
import { tenths } from "../units.ts";

// The owner's time by activity, a view over Lens's time blocks, rebuilt from the versioned rule
// table `ontology/activity-categories.json` whenever it is read. Code, not a model, applies it;
// nothing it gives is stored as knowledge. Pure but for reading the table once.

// The surface one block (or a moment) was on: its bundle, its host, and its URL when it has one.
export type ActivitySurface = { bundle: string; host?: string | null | undefined; url?: string | null | undefined };

// The most specific row wins: a host's row with a path prefix the URL starts with, the longest
// host then the longest prefix; then a host's row, the longest host (a row's host matches itself
// and its subdomains); then the bundle's row, in any case; else `other`. A block has no URL, so a
// prefix row never matches one: a host with prefix rows needs a row of its own for its blocks.
export function categoryOf(surface: ActivitySurface, table: ActivityTable): ActivityCategory {
  const host = surface.host?.toLowerCase().replace(/\.$/, "") ?? null;
  const url = surface.url === undefined || surface.url === null ? null : URL.parse(surface.url);
  const path = url?.pathname ?? null;
  const under = (rule: string): boolean => host !== null && (host === rule || host.endsWith(`.${rule}`));
  let best: { score: [number, number, number]; category: ActivityCategory } | null = null;
  for (const rule of table.rules) {
    let score: [number, number, number] | null = null;
    if (rule.host !== undefined && under(rule.host)) {
      if (rule.prefix === undefined) score = [1, rule.host.length, 0];
      else if (path !== null && (path === rule.prefix || path.startsWith(`${rule.prefix}/`)))
        score = [2, rule.host.length, rule.prefix.length];
    } else if (rule.bundle !== undefined && rule.bundle.toLowerCase() === surface.bundle.toLowerCase())
      score = [0, 0, 0];
    if (score === null) continue;
    if (best === null || compare(score, best.score) > 0) best = { score, category: rule.category };
  }
  return best?.category ?? "other";
}

const compare = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// One local day's minutes by category, every category present, from its blocks.
export function activityDay(
  day: string,
  blocks: readonly { app: BlockItem["blocks"][number]["app"]; host?: string | null | undefined; minutes: number }[],
  table: ActivityTable,
): ActivityDay {
  const minutes = Object.fromEntries(ActivityCategory.options.map((category) => [category, 0])) as Record<
    ActivityCategory,
    number
  >;
  for (const block of blocks) {
    const category = categoryOf({ bundle: block.app.bundle, host: block.host ?? null }, table);
    minutes[category] += block.minutes;
  }
  for (const category of ActivityCategory.options) minutes[category] = tenths(minutes[category]);
  return {
    day: day as ActivityDay["day"],
    version: table.version,
    minutes,
    total: tenths(blocks.reduce((total, block) => total + block.minutes, 0)),
  };
}

// The table as text, parsed; a table that does not parse throws, so a bad commit fails its tests.
export const parseActivityTable = (text: string): ActivityTable => ActivityTable.parse(JSON.parse(text));

// The repository's table, read once, on first use.
export const activityTable: () => ActivityTable = repoFile("ontology/activity-categories.json", parseActivityTable);
