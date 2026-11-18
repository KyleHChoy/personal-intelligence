import type { CaptureId, FactView, TimelineEntry, Who } from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { ANCHOR_LINK_TYPE } from "../core/link-types.ts";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import { whoOf } from "./read-who.ts";

// get_timeline's two capture entries: a meeting Lens recorded and linked to no
// calendar event, and a run of a project's link facts. Every statement runs under the caller's
// token, so a capture row, a claim or a person it cannot see changes nothing it is served
// (invariant 6), and each ends in an order that includes a unique key.

const PARTICIPANT_TYPE = "capture.person";
type ItemKind = "meeting" | "moment";

// ---------------------------------------------------------------------------------------------
// Part 1: runs of link facts.

export type AnchorRun = {
  at: Date;
  id: string;
  run: { first: Date; count: number; item: ItemKind; facts: FactView[] };
};

// The item kind of each capture item the given facts cite, as the token returns its row.
const ITEM_KINDS = `
  select k.id, k.kind from knowledge.captures k
  where k.id = any($1) and k.kind in ('meeting', 'moment')
  order by k.id`;

export async function itemKindsOf(ctx: Ctx, facts: readonly FactView[]): Promise<Map<string, ItemKind>> {
  const links = facts.flatMap((fact) =>
    fact.type === ANCHOR_LINK_TYPE && fact.capture !== null ? [fact.capture] : [],
  );
  if (links.length === 0) return new Map();
  const captures = [...new Set(links)];
  return new Map(
    (await ctx.run<{ id: string; kind: ItemKind }>(ITEM_KINDS, [captures])).map((row) => [row.id, row.kind]),
  );
}

// Over a timeline's items, newest first: each run of two or more adjacent capture.anchor facts
// with one subject (the project) and one item kind becomes one item, at its newest fact's time,
// with its oldest fact's time, its count and its facts. Anything else between two facts ends a
// run; a fact whose item `kinds` does not hold is never folded.
export function collapseAnchorRuns<T extends { at: Date; id: string; fact?: FactView }>(
  items: readonly T[],
  kinds: ReadonlyMap<string, ItemKind>,
): (T | AnchorRun)[] {
  const keyOf = (one: T): { key: string; item: ItemKind } | null => {
    const fact = one.fact;
    if (fact?.type !== ANCHOR_LINK_TYPE || fact.capture === null) return null;
    const item = kinds.get(fact.capture);
    return item === undefined ? null : { key: `${fact.subject.id} ${item}`, item };
  };
  const out: (T | AnchorRun)[] = [];
  for (let i = 0; i < items.length; ) {
    const first = items[i] as T;
    const key = keyOf(first);
    let j = i + 1;
    while (key !== null && j < items.length && keyOf(items[j] as T)?.key === key.key) j += 1;
    if (key === null || j - i < 2) {
      out.push(first);
    } else {
      const run = items.slice(i, j);
      const facts = run.map((one) => one.fact as FactView);
      out.push({
        at: first.at,
        id: first.id,
        run: { first: (run.at(-1) as T).at, count: run.length, item: key.item, facts },
      });
    }
    i = j;
  }
  return out;
}

export const runEntry = (one: AnchorRun): TimelineEntry => ({
  kind: "anchor_run",
  at: stamp(one.at),
  first: stamp(one.run.first),
  count: one.run.count,
  item: one.run.item,
});

// ---------------------------------------------------------------------------------------------
// Part 2: a Lens meeting with no calendar event.

export type CapturedRow = { id: string; started_at: Date; ended_at: Date; evidence_id: string };

// A person's: the meetings with no event that a participant claim names the entity or a member of its
// group in, within the window, newest first, at most `$4`. `$1` to `$4` are the timeline's window, as
// its mail and events take it.
export const CAPTURED_MEETINGS_OF = `
  select k.id, k.started_at, k.ended_at, k.evidence_id
  from knowledge.captures k
  where k.kind = 'meeting' and k.event_id is null
    and k.evidence_id in (
      select c.evidence_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
      where c.type = '${PARTICIPANT_TYPE}' and n.entity_id = any($1))
    and k.started_at <= to_timestamp($3) and ($2::float8 is null or k.started_at >= to_timestamp($2))
  order by k.started_at desc, k.id
  limit $4`;

// A project's: of the meetings work time links to it, those with no event, newest first: every one,
// so each holds its own link fact whether or not the limit keeps it.
export const UNLINKED_MEETINGS = `
  select k.id, k.started_at, k.ended_at, k.evidence_id
  from knowledge.captures k
  where k.id = any($1) and k.kind = 'meeting' and k.event_id is null
  order by k.started_at desc, k.id`;

// The people each meeting's participant claims name, with each claim's fact key.
const PARTICIPANTS = `
  select k.id as capture, n.entity_id, c.fact_key_fp
  from knowledge.captures k
  join knowledge.claims c on c.evidence_id = k.evidence_id
  join knowledge.claim_entities n on n.claim_id = c.id
  where k.id = any($1) and c.type = '${PARTICIPANT_TYPE}'
  order by k.id, n.entity_id, c.id`;

// Each kept meeting as its entry: its participants the visible people its claims name, a group
// once by its id (as meetingsOf names an event's), by id; and the fact keys of the claims read.
export async function capturedMeetingsOf(
  ctx: Ctx,
  rows: readonly CapturedRow[],
  groups: ClientGroups,
): Promise<{ entries: Map<string, TimelineEntry>; factKeyFps: string[] }> {
  const entries = new Map<string, TimelineEntry>();
  if (rows.length === 0) return { entries, factKeyFps: [] };
  const listed = await ctx.run<{ capture: string; entity_id: string; fact_key_fp: string }>(PARTICIPANTS, [
    rows.map((row) => row.id),
  ]);
  const people = new Map<string, string[]>();
  for (const one of listed) {
    const entity = groups.idOf(one.entity_id);
    const list = people.get(one.capture) ?? [];
    if (!list.includes(entity)) people.set(one.capture, [...list, entity]);
  }
  const who = await whoOf(ctx, [...new Set([...people.values()].flat())]);
  for (const row of rows) {
    const participants = (people.get(row.id) ?? []).sort().flatMap((id): Who[] => {
      const one = who.get(id);
      return one === undefined ? [] : [one];
    });
    entries.set(row.id, {
      kind: "captured_meeting",
      at: stamp(row.started_at),
      capture: row.id as CaptureId,
      startsAt: stamp(row.started_at),
      endsAt: stamp(row.ended_at),
      participants,
    });
  }
  return { entries, factKeyFps: [...new Set(listed.map((one) => one.fact_key_fp))] };
}
