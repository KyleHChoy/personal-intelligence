// The promotions sent that a ruling or an erasure ends (invariants 10 and 11): each is revoked in
// the transaction of the veto or the erasure that ends it, so the next outbox carries its deletion
// notice. As pi_admin, inside the owner's commands.

import { type Query, stamp } from "./db.ts";
import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// The promotions in force that carry a claim of a fact key the owner just vetoed or retired, revoked
// in the ruling's own transaction, so the next outbox carries their deletion notices. The count
// revoked.
export async function revokeRuled(query: Query, factKeyFp: string, now: Date): Promise<number> {
  const rows = await query(
    `update ledger.promotions p set revoked_at = $2
     where p.direction = 'out' and p.revoked_at is null
       and exists (select 1 from knowledge.claims c where c.id = any (p.claim_ids)
                   and $1 in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp))
     returning p.id`,
    [factKeyFp, stamp(now)],
  );
  return rows.length;
}

// An erasure's part in the promotions sent: each that carried an erased claim is revoked in the
// erasure's transaction, if it was not already, so the next outbox carries its deletion notice, and
// keeps a keyed fingerprint of each erased claim id in its place, never the id. The count changed.
export async function revokeErased(query: Query, keys: Keys, claimIds: readonly string[], now: Date): Promise<number> {
  if (claimIds.length === 0) return 0;
  const erased = new Set(claimIds);
  const rows = await query<{ id: string; claim_ids: string[] }>(
    "select p.id, p.claim_ids from ledger.promotions p where p.direction = 'out' and p.claim_ids && $1::text[] for update",
    [[...erased]],
  );
  for (const row of rows) {
    const kept = row.claim_ids.map((id) => (erased.has(id) ? fingerprint(keys, "promotion", `erased\n${id}`) : id));
    await query("update ledger.promotions set claim_ids = $2, revoked_at = coalesce(revoked_at, $3) where id = $1", [
      row.id,
      kept,
      stamp(now),
    ]);
  }
  return rows.length;
}
