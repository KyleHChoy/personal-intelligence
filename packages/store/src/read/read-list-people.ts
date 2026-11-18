import {
  EntityId,
  LIST_PEOPLE_MAX,
  ListPeopleArgs,
  type PeopleList,
  type PeopleListEntry,
  TIERS,
} from "@intelligence/contracts/personal";
import type { Ctx } from "../core/read-ctx.ts";
import { type Found, pageToken, pageTokenValue, shownOnly } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { byTierRow, clientRanking, groupLine, type WarmthRow } from "./read-warmth.ts";

// list_people: the people of the caller's clearance, ranked at read (read-warmth.ts clientRanking), in
// tier order, then warmth, then id, at most 50 a page, each named as search names a person. pi_reader's
// policy returns the caller's audience's rows alone, so every tier, order and page rests only on rows
// that audience can read (invariant 6). `after` is the cursor a page answered as `next`: issued by the
// server, opaque, the last row's place in the order. A cursor a client made reads nothing beyond its own
// audience's rows, and every page counts against its rows.

// `tier` is the tier's place in TIERS from 1, as SQL's array_position gives it.
type Cursor = { tier: number; warmth: number; id: string };

const cursorOf = (row: WarmthRow): string =>
  pageToken([TIERS.indexOf(row.tier) + 1, Number(row.warmth), row.entity_id]);

function parseCursor(text: string): Cursor | null {
  const value = pageTokenValue(text);
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [tier, warmth, id] = value as unknown[];
  if (!Number.isInteger(tier) || (tier as number) < 1 || (tier as number) > TIERS.length) return null;
  if (typeof warmth !== "number" || !Number.isFinite(warmth) || warmth < 0 || !EntityId.safeParse(id).success)
    return null;
  return { tier: tier as number, warmth, id: id as string };
}

async function listPeople(ctx: Ctx, args: ListPeopleArgs): Promise<Found<PeopleList> | "invalid_request"> {
  const after = args.after === undefined ? null : parseCursor(args.after);
  if (args.after !== undefined && after === null) return "invalid_request";
  const limit = args.limit ?? LIST_PEOPLE_MAX;
  // The ranking of the caller's clearance, by the caller's groups. While a removal has emptied a
  // label within it, or before its first build, no order by warmth is served.
  const groups = await loadGroups(ctx);
  const ranking = await clientRanking(ctx, groups);
  if (ranking === "rebuilding")
    return { value: { people: [], next: null, rebuilding: true }, rows: 0, read: shownOnly([]) };
  const place = (row: WarmthRow): [number, number, string] => [
    TIERS.indexOf(row.tier) + 1,
    -Number(row.warmth),
    row.entity_id,
  ];
  const past = (row: WarmthRow): boolean => {
    if (after === null) return true;
    const [tier, warmth, id] = place(row);
    return tier !== after.tier ? tier > after.tier : warmth !== -after.warmth ? warmth > -after.warmth : id > after.id;
  };
  const rows = ranking
    .filter(
      (row) =>
        (args.tiers === undefined || args.tiers.includes(row.tier)) &&
        (args.dormant === undefined || row.dormant === args.dormant) &&
        past(row),
    )
    .sort(byTierRow)
    .slice(0, limit + 1);
  const page = rows.slice(0, limit);
  // Each row as the group the caller's rulings make now, once a page.
  const ids = [...new Set(page.map((row) => groups.idOf(row.entity_id)))];
  const who = await groupWho(ctx, groups, ids);
  const people: PeopleListEntry[] = [];
  const served = new Set<string>();
  for (const row of page) {
    const id = groups.idOf(row.entity_id);
    const one = who.get(id);
    const warmth = groupLine([row], groups.membersOf(id));
    if (served.has(id) || one === undefined || warmth === undefined) continue;
    served.add(id);
    people.push({ id: id as EntityId, name: one.name, address: one.address, warmth });
  }
  const last = page.at(-1);
  return {
    value: { people, next: rows.length > limit && last !== undefined ? cursorOf(last) : null, rebuilding: false },
    rows: people.length,
    read: shownOnly([]),
  };
}

// The caller's audience's people in tier order, then warmth, view `people`: a list tool.
export const LIST_PEOPLE_TOOL: ReadTool<ListPeopleArgs, PeopleList> = {
  tool: "list_people",
  parse: (args) => parsed(ListPeopleArgs.safeParse(args)),
  work: (ctx, valid) => listPeople(ctx, valid),
};
