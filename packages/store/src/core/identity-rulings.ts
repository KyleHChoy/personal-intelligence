import type { IdentityVerdict } from "@intelligence/contracts/personal";
import { type Query, stamp } from "./db.ts";

// The owner's rulings on who is the same person, and the owner's own address fingerprints: what
// groupsOf takes, read by the admin, the identity sweep and the writer's named binding.

// One ruling as groupsOf (identity/groups.ts) takes it.
export type IdentityRuling = {
  id: string;
  verdict: IdentityVerdict;
  aFp: string;
  bFp: string | null;
  liftedAt: string | null;
  // An agent's ruling: it settles its own pair, and is not the owner's word about anyone else.
  byAgent?: boolean;
  // Lifted because a message it rested on was removed: nobody said no.
  liftedByDeletion?: boolean;
};

export type RulingRow = {
  ruling_id: string;
  verdict: IdentityVerdict;
  a_fp: string;
  b_fp: string | null;
  created_at: Date;
  lifted_at: Date | null;
};

// Every ruling, lifted ones included: groupsOf reads only those in force.
export async function allRulings(query: Query): Promise<IdentityRuling[]> {
  const rows = await query<RulingRow & { by_agent: boolean; lifted_by_deletion: boolean }>(
    `select ruling_id, verdict, a_fp, b_fp, created_at, lifted_at, by_agent, lifted_by_deletion
     from knowledge.identity_rulings order by created_at, ruling_id collate "C"`,
  );
  return rows.map((row) => ({
    id: row.ruling_id,
    verdict: row.verdict,
    aFp: row.a_fp,
    bFp: row.b_fp,
    liftedAt: row.lifted_at === null ? null : stamp(row.lifted_at),
    byAgent: row.by_agent,
    liftedByDeletion: row.lifted_by_deletion,
  }));
}

export async function ownerFps(query: Query): Promise<string[]> {
  const rows = await query<{ value_fp: string }>(
    "select distinct a.value_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner'",
  );
  return rows.map((row) => row.value_fp);
}
