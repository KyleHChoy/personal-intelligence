import {
  TIERS,
  type Tier,
  type TierSource,
  tierPlace,
  type WarmthChannel,
  type WarmthLine,
} from "@intelligence/contracts/personal";
import { warmthRules } from "@intelligence/personal-core/views";
import { byText } from "../core/db.ts";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import { rankWarmth } from "../identity/warmth-days.ts";

// The warmth line of each person, ranked at read from the per-label days within the calling
// client's clearance (identity/warmth-days.ts rankWarmth). pi_reader's policy returns only rows
// within that clearance, so nothing here names an audience and nothing read rests on a row the
// caller cannot see.

// The client's clearance, and the transaction's clock: the ranking is computed as of the reader's own
// clock (`ctx.now`, the owner's reads' too), or this one where a call was given none.
const CLEARANCE = "select policy.client_clearance() as clearance, now() as now";

export const WARMTH_COLUMNS =
  "w.entity_id, w.members, w.tier, w.tier_source, w.dormant, w.warmth, w.active, w.depth, w.first_two_way_at, w.last_two_way_at, w.reply_rate, w.reply_hours, w.they_start, w.channels";

export type WarmthRow = {
  entity_id: string;
  members: string[];
  tier: Tier;
  tier_source: TierSource;
  dormant: boolean;
  warmth: number | string;
  active: number | string;
  depth: number | string;
  first_two_way_at: Date | string | null;
  last_two_way_at: Date | string | null;
  reply_rate: number | string | null;
  reply_hours: number | string | null;
  they_start: number | string | null;
  channels: WarmthChannel[];
};

const number = (value: number | string): number => Number(value);
const numberOrNull = (value: number | string | null): number | null => (value === null ? null : Number(value));
const instantOrNull = (value: Date | string | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

// No tier and no number: a removal emptied the audience (`rebuilding`), or the stored row rests on
// a group the reader no longer computes (`stale`, after a lift).
const unknownLine = (flags: { stale: boolean; rebuilding: boolean }): WarmthLine => ({
  tier: null,
  tierSource: null,
  dormant: false,
  warmth: null,
  active: null,
  depth: null,
  firstTwoWayAt: null,
  lastTwoWayAt: null,
  replyRate: null,
  replyHours: null,
  theyStart: null,
  channels: [],
  ...flags,
});

const lineOfRow = (row: WarmthRow, stale: boolean): WarmthLine => ({
  tier: row.tier,
  tierSource: row.tier_source,
  dormant: row.dormant,
  warmth: number(row.warmth),
  active: number(row.active),
  depth: number(row.depth),
  firstTwoWayAt: instantOrNull(row.first_two_way_at),
  lastTwoWayAt: instantOrNull(row.last_two_way_at),
  replyRate: numberOrNull(row.reply_rate),
  replyHours: numberOrNull(row.reply_hours),
  theyStart: numberOrNull(row.they_start),
  channels: [...row.channels],
  stale,
  rebuilding: false,
});

// Best tier first, then the most warmth, then by id: the order list_people serves and the best
// member row a merged group is served.
export const byTierRow = (a: WarmthRow, b: WarmthRow): number =>
  tierPlace(a.tier) - tierPlace(b.tier) || number(b.warmth) - number(a.warmth) || byText(a.entity_id, b.entity_id);

// Item 17: the line of a group whose visible members are `members`, from the stored rows that hold
// any of them. One row with exactly those members is served as it is. Rows that each hold only
// members of the group (a merge since the build) serve the best-tiered of them, `stale`. A row
// that holds someone outside the group (a lift since the build) serves no tier, `stale`. No row,
// no line.
export function groupLine(rows: readonly WarmthRow[], members: readonly string[]): WarmthLine | undefined {
  const mine = new Set(members);
  const held = rows.filter((row) => row.members.some((one) => mine.has(one)));
  if (held.length === 0) return undefined;
  if (held.some((row) => row.members.some((one) => !mine.has(one))))
    return unknownLine({ stale: true, rebuilding: false });
  const best = [...held].sort(byTierRow)[0] as WarmthRow;
  // Every row holds only members of the group, so one row of as many members holds them all.
  return lineOfRow(best, !(held.length === 1 && best.members.length === mine.size));
}

// The whole ranking of the caller's clearance, by the caller's groups, or `rebuilding` while no
// label within it is built or a removal emptied one. One row a person.
export async function clientRanking(ctx: Ctx, groups: ClientGroups): Promise<WarmthRow[] | "rebuilding"> {
  const [asked] = await ctx.run<{ clearance: string[]; now: Date }>(CLEARANCE, []);
  if (asked === undefined) return "rebuilding";
  const ranked = await rankWarmth(
    { query: (text, values) => ctx.run(text, values ?? []), keys: ctx.keys },
    { kind: "client" },
    asked.clearance,
    groups,
    { today: ctx.now?.() ?? asked.now },
  );
  return ranked === "rebuilding" ? ranked : [...ranked.values()];
}

// The warmth line of each id given (a group's id, or a person alone), from the caller's ranking,
// none for no id. While the clearance is `rebuilding`, every id is served `rebuilding` with no tier.
// A person with no row has no line.
export async function warmthOf(
  ctx: Ctx,
  groups: ClientGroups,
  ids: readonly string[],
): Promise<Map<string, WarmthLine>> {
  const out = new Map<string, WarmthLine>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows = await clientRanking(ctx, groups);
  for (const id of unique) {
    const line =
      rows === "rebuilding" ? unknownLine({ stale: false, rebuilding: true }) : groupLine(rows, groups.membersOf(id));
    if (line !== undefined) out.set(id, line);
  }
  return out;
}

// The order of people by warmth, highest first, as one number: the tier's band, then
// `warmth` within it. No tier (none stored, `stale` after a lift, `rebuilding`) ranks below every
// tier, by `warmth` when there is one. `tiers` false orders by `warmth` alone, for a client that
// may not learn the owner's confirmed closeness, which sets a tier but never `warmth`.
const BAND = 1_000_000;
export const warmthOrder = (line: WarmthLine | undefined, tiers = true): number =>
  line === undefined ? 0 : (tiers ? (TIERS.length - tierPlace(line.tier)) * BAND : 0) + (line.warmth ?? 0);

// find_paths' own-tie hop: the tier's weight from the rule table; none without a tier,
// so core's floor applies.
export const pathWeight = (line: WarmthLine | undefined): number | undefined =>
  line?.tier === undefined || line.tier === null ? undefined : warmthRules().pathWeights[line.tier];
