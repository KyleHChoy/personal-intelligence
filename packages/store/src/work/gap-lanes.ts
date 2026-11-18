import { type AutonomyRules, isRestricted, ownLabel, type PersonalLogger } from "@intelligence/contracts/personal";
import { autonomyRules, closeNoTieRule } from "@intelligence/personal-core/planner";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import type { Query } from "../core/db.ts";
import { createDb } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import type { Tx } from "../core/tx.ts";
import { audienceGroups } from "../identity/warmth-build.ts";
import { type RankedWarmth, rankWarmth, warmthRebuilding } from "../identity/warmth-days.ts";
import { audiencesOf, ownerAudienceOf } from "../pipeline/pipeline-read.ts";
import * as gaps from "./dispatch-gaps.ts";

// The pipeline's pass over the three warmth lanes, as pi_pipeline: close_no_tie, close_no_role and
// explore rest on warmth, which is ranked at read with the keys, so the work tick, which holds none,
// leaves them to this pass, run after each day build.
// The same reads, raise and close as the tick's (work/dispatch-gaps.ts), each through a definer that
// gives this role its lanes' flags alone; the candidates from the rankings computed here.

// Close people with no tie, and with no role, from each audience's ranking handed in as `people`,
// each with its group's members.
const CLOSE_NO_TIE = `
  select ${gaps.GAP_COLUMNS}, members
  from ledger.close_no_tie_gaps($1::text[], $2::integer, $3::jsonb)`;
const CLOSE_NO_ROLE = `
  select ${gaps.GAP_COLUMNS}, members
  from ledger.close_no_role_gaps($1::text[], $2::integer, $3::text[], $4::jsonb)`;
// The frontier's nodes under `own`, each namer by its tier in `own`'s ranking ($3, id to tier).
const EXPLORE = `
  select ${gaps.GAP_COLUMNS}, goal_target, goal_path, goals, meeting_soon, namer_tiers, named_days, missing
  from ledger.explore_gaps($1::timestamptz, $2::integer, $3::jsonb)`;
// The newest day build within a clearance: a person's time when no two-way contact gives one.
const BUILT = "select max(built_at) as at from projections.warmth_day_builds where compartments <@ $1::text[]";

// An audience's ranking's people as the two close lanes take them: each group by its representative,
// with the audience, its members, tier and its source, warmth, time and the labels it was ranked
// from. Only the tiers the lanes read, so the list stays short.
function closePeople(
  audience: readonly string[],
  ranked: Map<string, RankedWarmth>,
  tiers: readonly string[],
  built: Date | null,
): object[] {
  return [...ranked.values()]
    .filter((one) => tiers.includes(one.tier))
    .map((one) => ({
      audience,
      entity_id: one.entity_id,
      members: one.members,
      tier: one.tier,
      tier_source: one.tier_source,
      warmth: one.warmth,
      at: one.last_two_way_at ?? built?.toISOString() ?? null,
      compartments: one.compartments,
    }));
}

// Each member of each ranked group to the group's tier, as ledger.gap_frontier reads a namer's.
const tiersOf = (ranked: Map<string, RankedWarmth> | "rebuilding"): Record<string, string> =>
  ranked === "rebuilding"
    ? {}
    : Object.fromEntries([...ranked.values()].flatMap((one) => one.members.map((member) => [member, one.tier])));

// A clearance's ranking as the owner reads it, by its own groups.
const rankingOf = async (tx: Tx, clearance: string[], now: Date): Promise<Map<string, RankedWarmth> | "rebuilding"> =>
  clearance.length === 0
    ? "rebuilding"
    : rankWarmth(tx, { kind: "owner" }, clearance, await audienceGroups(tx.query, clearance), { today: now });

// Each namer's tier for the frontier's nodes (JSON for `tiers`): `own`'s ranking alone, the one label
// the nodes are read and raised under, so nothing under another label changes a value (invariant 6).
export async function exploreTiers(tx: Tx, now: Date): Promise<string> {
  return JSON.stringify(tiersOf(await rankingOf(tx, ownLabel(), now)));
}

// The audiences the close lanes rank, as the stored build had them (policy.audiences(), every
// active client's clearance, and the owner's), each under no restricted compartment: the pipeline
// has no restricted pass.
async function closeAudiences(query: Tx["query"]): Promise<string[][]> {
  const all = [...(await audiencesOf(query)), await ownerAudienceOf(query)].filter(
    (one) => one.length > 0 && !one.some(isRestricted),
  );
  return [...new Map(all.map((one) => [[...one].sort().join(","), [...one].sort()])).values()];
}

// Whether the close lanes wait: while the owner's ranking is being rebuilt, the lanes neither raise
// nor close a close person's flag, so a rebuild's gap closes nothing that still holds. With no owner's
// audience yet (no claim that builds a belief), there is no ranking of theirs to wait for.
export async function closesWait(query: Tx["query"]): Promise<boolean> {
  const owner = await ownerAudienceOf(query);
  return owner.length > 0 && !owner.some(isRestricted) && (await warmthRebuilding(query, owner));
}

// Each audience's ranking as the two close lanes take it, ranked apart as the stored build ranked
// each audience apart, so a person's place in one depends on no one outside it (invariant 6), JSON
// for `people`; null while the close lanes wait. An audience being rebuilt adds no one.
export async function closeLanePeople(tx: Tx, now: Date, tiers: readonly string[]): Promise<string | null> {
  if (await closesWait(tx.query)) return null;
  const people: object[] = [];
  for (const audience of await closeAudiences(tx.query)) {
    const ranked = await rankingOf(tx, audience, now);
    if (ranked === "rebuilding") continue;
    const [built] = await tx.query<{ at: Date | null }>(BUILT, [audience]);
    people.push(...closePeople(audience, ranked, tiers, built?.at ?? null));
  }
  return JSON.stringify(people);
}

// The three lanes' gaps now; no close person while the close lanes wait.
async function laneCandidates(tx: Tx, now: Date, rules: AutonomyRules): Promise<gaps.GapRow[]> {
  const close = closeNoTieRule(rules);
  const rows: gaps.CandidateRow[] = await tx.query<gaps.CandidateRow>(EXPLORE, [
    now.toISOString(),
    secondDegreeRules().namedMeetingHours,
    await exploreTiers(tx, now),
  ]);
  const people = await closeLanePeople(tx, now, close.tiers);
  if (people !== null) {
    rows.push(...(await tx.query<gaps.CandidateRow>(CLOSE_NO_TIE, [close.tiers, close.people, people])));
    rows.push(
      ...(await tx.query<gaps.CandidateRow>(CLOSE_NO_ROLE, [
        close.tiers,
        close.people,
        await gaps.closeNoRoleHeld(tx.query, now),
        people,
      ])),
    );
  }
  return gaps.gapRowsOf(rows, rules);
}

const CLOSE_LANES: readonly string[] = ["close_no_tie", "close_no_role"];

export type GapLaneStore = {
  gapCandidates(now: Date, rules?: AutonomyRules): Promise<gaps.GapRow[]>;
  gapFlags(now: Date): Promise<gaps.GapFlags>;
  gapSupply(now: Date): ReturnType<typeof gaps.gapSupply>;
  raiseGapFlag(gap: gaps.GapRow, decide: boolean, check?: gaps.GapRaiseCheck): ReturnType<typeof gaps.raiseGapChecked>;
  closeGapFlag(id: string, now: Date): Promise<boolean>;
  underGapPass<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

// The lanes' store, from PI_DATABASE_URL_PIPELINE and the keys: the shape of the tick's dispatch
// that core's gap pass takes. Each write is its own transaction.
export function createGapLaneStore({ url, keys, log }: { url: string; keys: Keys; log: PersonalLogger }): GapLaneStore {
  const db = createDb(url, log);
  const inWrite = <T>(fn: (query: Query) => Promise<T>): Promise<T> => db.transaction(fn);
  return {
    gapCandidates: (now, rules = autonomyRules()) =>
      db.transaction((query) => laneCandidates({ query, keys }, now, rules)),
    // While the close lanes wait, their open flags are no part of the pass, so none is closed for
    // the gap it no longer finds.
    gapFlags: async (now) => {
      const flags = await gaps.gapFlags(db.query, now);
      if (!(await closesWait(db.query))) return flags;
      return { ...flags, open: flags.open.filter((flag) => !CLOSE_LANES.includes(flag.trigger)) };
    },
    gapSupply: (now) => gaps.gapSupply(db.query, now),
    raiseGapFlag: (gap, decide, check) => gaps.raiseGapChecked(inWrite, gap, decide, check),
    closeGapFlag: (id, now) => inWrite((query) => gaps.closeGapFlag(query, id, now)),
    underGapPass: (fn) => gaps.underGapPass(db, fn),
    close: () => db.close(),
  };
}
