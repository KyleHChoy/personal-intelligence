import type { Timestamp } from "@intelligence/contracts";
import type { EntityId, PersonalCompartment, RulingId } from "@intelligence/contracts/personal";
import { ownLabel } from "@intelligence/contracts/personal";
import type { RuledTier } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp } from "../../core/db.ts";
import { TIER_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { inForce, ruledOf, writeTier } from "../rulings/admin-tier-rows.ts";
import { liftRulings, lockedRepeat } from "../rulings/owner-ruling.ts";
import { namesOf } from "./admin-warmth.ts";
import { proposeTiersAfterRuling } from "./tier-proposer.ts";

export type TierRulingView = {
  id: RulingId;
  tier: RuledTier;
  values: number;
  people: EntityId[];
  name: string | null;
  at: Timestamp;
};

// The owner sets a person's tier, `pia people tier`; then the tier proposer's pass, whose failure
// never fails the owner's ruling.
export async function setTier(
  admin: AdminContext,
  person: string,
  tier: RuledTier,
  options: { requestId: string },
): Promise<RulingId> {
  const ruling = await rule(admin, person, tier, options);
  await proposeTiersAfterRuling(admin);
  return ruling;
}

async function rule(
  admin: AdminContext,
  person: string,
  tier: RuledTier,
  options: { requestId: string },
): Promise<RulingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const repeat = await lockedRepeat(query, TIER_LOCK, options.requestId);
    if (repeat !== undefined) return repeat;
    return writeTier(query, admin.keys, person, tier, options.requestId, now);
  });
}

// `pia people tier PERSON --clear`: lifts every ruling in force on the person's fingerprints with
// one `warmth_tier_lift` decision. False when none is in force; a repeated request id answers true
// again and writes nothing.
export async function clearTier(admin: AdminContext, person: string, options: { requestId: string }): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [TIER_LOCK]);
    const [repeat] = await query<{ kind: string }>("select kind from knowledge.owner_decisions where request_id = $1", [
      options.requestId,
    ]);
    if (repeat !== undefined) {
      if (repeat.kind !== "warmth_tier_lift") throw new AdminError("invalid_argument");
      return true;
    }
    const { fps } = await ruledOf(admin, query, person);
    const live = await inForce(query, fps);
    if (live.length === 0) return false;
    const [label] = await query<{ compartments: PersonalCompartment[] }>(
      "select array_agg(distinct c order by c) as compartments from knowledge.tier_rulings r cross join unnest(r.compartments) as c where r.ruling_id = any($1::text[])",
      [live.map((row) => row.ruling_id)],
    );
    const lift = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "warmth_tier_lift",
        supersedes: live[0]!.ruling_id,
        compartments: label?.compartments ?? ownLabel(),
        subjectFps: live.flatMap((row) => row.value_fps),
      },
      now,
    );
    await liftRulings(
      query,
      "knowledge.tier_rulings",
      live.map((row) => row.ruling_id),
      lift,
      now,
    );
    return true;
  });
}

// `pia people tiers --ruled`: the rulings in force, oldest first, each with the people who hold
// its fingerprints now and the first one's name (the command prints to a terminal only).
export async function listTiers(admin: AdminContext): Promise<TierRulingView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      ruling_id: RulingId;
      tier: RuledTier;
      values: number;
      created_at: Date;
      people: string[];
    }>(
      `select r.ruling_id, r.tier, cardinality(r.value_fps) as values, r.created_at,
         array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
               where a.value_fp = any(r.value_fps) order by a.entity_id) as people
       from knowledge.tier_rulings r where r.lifted_at is null order by r.created_at, r.ruling_id collate "C"`,
    );
    const names = await namesOf(
      query,
      admin.keys,
      rows.flatMap((row) => row.people.slice(0, 1).map((one) => ({ entity_id: one, members: [] }))),
    );
    return rows.map((row) => ({
      id: row.ruling_id,
      tier: row.tier,
      values: row.values,
      people: row.people as EntityId[],
      name: row.people[0] === undefined ? null : (names.get(row.people[0]) ?? null),
      at: stamp(row.created_at),
    }));
  });
}
