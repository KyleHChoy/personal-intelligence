import { EntityId, type PersonalCompartment, type RulingId } from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import type { RuledTier } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { notOwnerAddress } from "../../core/statements.ts";
import { heldLabel, liftRulings } from "./owner-ruling.ts";

// The owner sets a person's tier, `pia people tier`, and their word outranks the score (invariant
// 11). A ruling is stored as the keyed fingerprints of the person's account addresses and phone
// keys (never one the owner holds), so it outlives a re-derive's new ids, as an ignore ruling does
// (admin-ignore.ts). One is in force per fingerprint: a new ruling lifts every ruling in force on
// any of its fingerprints, in the same transaction, with the new ruling as their lift. Each write
// is one transaction with its owner decision. The build reads the rulings through
// policy.tier_rulings_in (warmth-build.ts).

type Ruled = { fps: string[]; compartments: PersonalCompartment[] };

// The person a command names, by entity id or by address, and the fingerprints a ruling on them
// holds, with their label: the compartments of the account rows holding them, or `own`. An
// unknown id or an address no person holds is `not_found`; the owner, an organization or a
// project, or a person whose every address is the owner's, is `not_a_person`. The owner's lists
// key their members the same way (admin-lists.ts).
export async function ruledOf(admin: Pick<AdminContext, "keys">, query: Query, person: string): Promise<Ruled> {
  let id: string;
  let given: string[] = [];
  if (EntityId.safeParse(person).success) {
    const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1", [person]);
    if (entity === undefined) throw new AdminError("not_found");
    if (entity.kind !== "person") throw new AdminError("not_a_person");
    id = person;
  } else {
    const address = normalizeAddress(person);
    if (address === null) throw new AdminError("not_found");
    const fp = fingerprint(admin.keys, "address", address);
    const [holder] = await query<{ entity_id: string; kind: string }>(
      "select a.entity_id, e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by (e.kind = 'owner') desc, a.id limit 1",
      [fp],
    );
    if (holder === undefined) throw new AdminError("not_found");
    if (holder.kind !== "person") throw new AdminError("not_a_person");
    id = holder.entity_id;
    given = [fp];
  }
  const rows = await query<{ value_fp: string }>(
    `select distinct a.value_fp from knowledge.accounts a where a.entity_id = $1
       and ${notOwnerAddress("a.value_fp", "w")}
     order by a.value_fp`,
    [id],
  );
  const fps = [...new Set([...given, ...rows.map((row) => row.value_fp)])].sort(byText);
  if (fps.length === 0) throw new AdminError("not_a_person");
  return { fps, compartments: await heldLabel(query, "account", fps) };
}

// The rulings in force on any of these fingerprints, newest first.
export const inForce = (query: Query, fps: string[]) =>
  query<{ ruling_id: RulingId; tier: RuledTier; value_fps: string[] }>(
    `select ruling_id, tier, value_fps from knowledge.tier_rulings where lifted_at is null and value_fps && $1::text[]
     order by created_at desc, ruling_id collate "C" desc`,
    [fps],
  );

// `pia people tier PERSON TIER`: the owner's ruling. A ruling in force with the same tier that
// already holds every fingerprint is `already_settled` with its id, and writes nothing; a repeated
// request id returns the first ruling.
// One tier ruling and its decision, inside a transaction that holds TIER_LOCK: `setTier`'s, and
// each person a confirmed tier proposal names (tier-proposer.ts).
export async function writeTier(
  query: Query,
  keys: AdminContext["keys"],
  person: string,
  tier: RuledTier,
  requestId: string,
  now: Date,
): Promise<RulingId> {
  const { fps, compartments } = await ruledOf({ keys }, query, person);
  const live = await inForce(query, fps);
  const same = live.find((row) => row.tier === tier && fps.every((fp) => row.value_fps.includes(fp)));
  if (same !== undefined) throw new AdminError("already_settled", undefined, [same.ruling_id]);
  const ruling = await ownerDecision(
    query,
    {
      requestId,
      kind: "warmth_tier",
      answer: tier,
      supersedes: live[0]?.ruling_id ?? null,
      compartments,
      subjectFps: fps,
    },
    now,
  );
  if (live.length > 0) {
    await liftRulings(
      query,
      "knowledge.tier_rulings",
      live.map((row) => row.ruling_id),
      ruling,
      now,
    );
  }
  await query(
    "insert into knowledge.tier_rulings (ruling_id, tier, value_fps, created_at, compartments) values ($1, $2, $3, $4, $5)",
    [ruling, tier, fps, stamp(now), compartments],
  );
  return ruling;
}
