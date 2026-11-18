import { ownLabel, type PersonalLabel, type RulingId } from "@intelligence/contracts/personal";
import { type Query, stamp } from "../../core/db.ts";
import { lockRows } from "../../core/queue.ts";
import { repeatedDecision } from "../admin-base.ts";

// What every owner ruling keyed by fingerprints shares (an ignore, a tier, a list member, a person's
// or an organization's name, an identity ruling): its lock word, taken first; the repeat of its
// request id; its label, from the rows that hold its fingerprints; and the lift of rulings in force.
// Each kind keeps its own table.

// A name as the owner types it for a person or an organization: 1 to 200 characters once
// trimmed, no control character.
export const OWNER_NAME = /^[^\p{Cc}]{1,200}$/u;

// The row-lock words of the owner's ruling commands, each taken before any other statement.
export const RULING_LOCKS = {
  identity: "identity:rulings",
  ignore: "identity:ignore",
  lists: "owner:lists",
  personNames: "person:names",
  organizationNames: "organization:names",
  time: "owner:time_rulings",
} as const;

// The kind's lock, then the decision a repeated request id wrote first, or undefined.
export async function lockedRepeat(query: Query, lock: string, requestId: string): Promise<RulingId | undefined> {
  await lockRows(query, [lock]);
  return repeatedDecision(query, requestId);
}

// The compartments of the account (or domain) rows holding the fingerprints, or `own` when none
// does: a ruling's label, as an identity ruling's is its people's (invariant 4).
export async function heldLabel(
  query: Query,
  holder: "account" | "domain",
  fps: readonly string[],
): Promise<PersonalLabel> {
  const [row] = await query<{ compartments: PersonalLabel }>(
    holder === "account"
      ? "select coalesce(array_agg(distinct c order by c), '{}') as compartments from knowledge.accounts a cross join unnest(a.compartments) as c where a.value_fp = any($1)"
      : "select coalesce(array_agg(distinct c order by c), '{}') as compartments from knowledge.domains d cross join unnest(d.compartments) as c where d.domain_fp = any($1)",
    [fps],
  );
  return row === undefined || row.compartments.length === 0 ? ownLabel() : row.compartments;
}

// Whether the owner holds the address: an owner ruling never covers the owner.
export async function ownerHolds(query: Query, fp: string): Promise<boolean> {
  const [row] = await query<{ yes: boolean }>(
    "select exists (select 1 from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner' and a.value_fp = $1) as yes",
    [fp],
  );
  return row?.yes === true;
}

// The rulings in force among `ids`, lifted by `lift` at `now`.
export const liftRulings = (query: Query, table: string, ids: readonly string[], lift: RulingId, now: Date) =>
  query(
    `update ${table} set lifted_at = $2, lift_ruling_id = $3 where ruling_id = any($1::text[]) and lifted_at is null`,
    [ids, stamp(now), lift],
  );
