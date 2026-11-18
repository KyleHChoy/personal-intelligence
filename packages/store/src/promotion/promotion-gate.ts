// The promotion gate: the only way a fact leaves this instance. The owner names the claims; the
// gate checks each, records the promotion in the ledger and emits its bundle, which the owner
// carries to the receiver. A revoke, or a claim the promotion carried that is gone since, makes its
// deletion notice. As pi_admin, from owner commands alone: no agent API path, pipeline or tick
// reaches this module, and nothing here sends.

import {
  ClaimRecord,
  FactId,
  PROMOTION_MOST_CLAIMS,
  type PromotionBundle,
  type PromotionDeletionNotice,
  PromotionId,
  type PromotionMessage,
  type PromotionView,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import { type Query, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { bundleOf, noticeOf, promotedClaims, whyNotPromotable } from "./promotion-bundle.ts";

type ClaimRow = { id: string; compartments: string[]; content_enc: Sealed; ruled: boolean; held: boolean };

// The claims named, each with whether the owner's veto or retire is in force on one of its fact keys
// (invariant 11: the veto outranks the approval) and whether its message or document is held.
const CLAIMS = `
  select c.id, c.compartments, c.content_enc,
    exists (select 1 from knowledge.belief_rulings b
            where b.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp)
              and b.verdict in ('veto', 'retire') and b.lifted_at is null) as ruled,
    exists (select 1 from knowledge.messages m where m.evidence_id = c.evidence_id and m.held)
      or exists (select 1 from knowledge.documents d where d.evidence_id = c.evidence_id and d.held) as held
  from knowledge.claims c
  where c.id = any($1::text[])
  order by c.id collate "C"`;

type PromotionRow = {
  id: string;
  provenance: string;
  claim_ids: string[];
  created_at: Date;
  revoked_at: Date | null;
};

const SENT = `
  select p.id, p.provenance, p.claim_ids, p.created_at, p.revoked_at from ledger.promotions p
  where p.direction = 'out' order by p.created_at, p.id collate "C"`;

// The bundle of a promotion from its claims as stored now, or undefined when one is gone or may no
// longer be promoted (then only its deletion notice may follow).
async function bundleFor(query: Query, keys: Keys, row: PromotionRow): Promise<PromotionBundle | undefined> {
  const rows = await query<ClaimRow>(CLAIMS, [row.claim_ids]);
  if (rows.length !== row.claim_ids.length || rows.some((one) => one.ruled || one.held)) return undefined;
  const records: ClaimRecord[] = [];
  for (const one of rows) {
    const record = ClaimRecord.parse(JSON.parse(open(keys, one, "knowledge.claims.content_enc", "throw")));
    if (whyNotPromotable(one.compartments, record) !== undefined) return undefined;
    records.push(record);
  }
  const claims = promotedClaims(records);
  return claims === undefined
    ? undefined
    : bundleOf(row.provenance, { by: "owner", via: "command", at: stamp(row.created_at) }, claims);
}

// `pia promotion add CLAIM...`: one promotion of the claims named, in one transaction. Every claim
// must exist and may be promoted, or nothing is written: `not_found` for a claim that is not there,
// `not_promotable` for one the gate may not send (its label, its origin, a third party's fact, a
// veto in force, a held source, or nothing of it that can cross). A repeated request id returns the
// first promotion's bundle; the same id with other claims is `invalid_argument`.
export function promote(
  admin: AdminContext,
  claims: readonly string[],
  options: { requestId: string },
): Promise<{ promotion: PromotionId; bundle: PromotionBundle }> {
  const ids = [...new Set(claims)].sort();
  if (ids.length === 0 || ids.length > PROMOTION_MOST_CLAIMS || !ids.every((id) => FactId.safeParse(id).success))
    return Promise.reject(new AdminError("invalid_argument"));
  return admin.transaction(async (query) => {
    const [repeated] = await query<PromotionRow>(
      "select p.id, p.provenance, p.claim_ids, p.created_at, p.revoked_at from ledger.promotions p where p.request_id = $1",
      [options.requestId],
    );
    if (repeated !== undefined) {
      if (repeated.claim_ids.join("\n") !== ids.join("\n")) throw new AdminError("invalid_argument");
      if (repeated.revoked_at !== null) throw new AdminError("promotion_revoked");
      const bundle = await bundleFor(query, admin.keys, repeated);
      if (bundle === undefined) throw new AdminError("not_promotable");
      return { promotion: PromotionId.parse(repeated.id), bundle };
    }
    const rows = await query<ClaimRow>(CLAIMS, [ids]);
    if (rows.length !== ids.length) throw new AdminError("not_found");
    if (rows.some((one) => one.ruled || one.held)) throw new AdminError("not_promotable");
    const id = newId("prm");
    const row: PromotionRow = {
      id,
      provenance: fingerprint(admin.keys, "promotion", [id, ...ids].join("\n")),
      claim_ids: ids,
      created_at: admin.now(),
      revoked_at: null,
    };
    const bundle = await bundleFor(query, admin.keys, row);
    if (bundle === undefined) throw new AdminError("not_promotable");
    await query(
      `insert into ledger.promotions (id, direction, request_id, provenance, claim_ids, created_at, compartments)
       values ($1, 'out', $2, $3, $4, $5, array['own'])`,
      [row.id, options.requestId, row.provenance, row.claim_ids, stamp(row.created_at)],
    );
    admin.log.info({ event: "promotion_sent", counts: { claims: ids.length } });
    return { promotion: PromotionId.parse(id), bundle };
  });
}

// `pia promotion revoke PROMOTION`: the promotion's deletion notice, its revoke recorded once. A
// second revoke returns the same notice. `not_found` for an id that is no promotion this instance
// sent.
export function revoke(admin: AdminContext, promotion: string): Promise<PromotionDeletionNotice> {
  if (!PromotionId.safeParse(promotion).success) return Promise.reject(new AdminError("not_found"));
  return admin.transaction(async (query) => {
    await query(
      "update ledger.promotions set revoked_at = $2 where id = $1 and direction = 'out' and revoked_at is null",
      [promotion, stamp(admin.now())],
    );
    const [row] = await query<{ provenance: string; revoked_at: Date }>(
      "select provenance, revoked_at from ledger.promotions where id = $1 and direction = 'out'",
      [promotion],
    );
    if (row === undefined) throw new AdminError("not_found");
    return noticeOf(row.provenance, stamp(row.revoked_at));
  });
}

// `pia promotion list`: every promotion sent, oldest first, by count; `broken` when a claim it
// carried is gone, so its deletion notice is due.
export function listPromotions(admin: AdminContext): Promise<PromotionView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<PromotionRow & { broken: boolean }>(
      `select p.id, p.provenance, p.claim_ids, p.created_at, p.revoked_at,
         exists (select 1 from unnest(p.claim_ids) as i (id) where not exists (select 1 from knowledge.claims c where c.id = i.id)) as broken
       from ledger.promotions p where p.direction = 'out' order by p.created_at, p.id collate "C"`,
    );
    return rows.map((row) => ({
      promotion: PromotionId.parse(row.id),
      provenance: row.provenance,
      claims: row.claim_ids.length,
      at: stamp(row.created_at),
      revokedAt: row.revoked_at === null ? null : stamp(row.revoked_at),
      broken: row.broken,
    }));
  });
}

// `pia promotion outbox`: everything the receiver should hold, oldest first: the bundle of each
// promotion in force, and the deletion notice of each revoked one. A promotion whose bundle can no
// longer be made (a claim it carried was erased, removed at its source, vetoed or held) is revoked
// here first, so its notice follows and it is never sent again (invariant 10).
export function outbox(admin: AdminContext): Promise<PromotionMessage[]> {
  return admin.transaction(async (query) => {
    const messages: PromotionMessage[] = [];
    for (const row of await query<PromotionRow>(SENT)) {
      const bundle = row.revoked_at === null ? await bundleFor(query, admin.keys, row) : undefined;
      if (bundle !== undefined) {
        messages.push(bundle);
        continue;
      }
      let revokedAt = row.revoked_at;
      if (revokedAt === null) {
        revokedAt = admin.now();
        await query("update ledger.promotions set revoked_at = $2 where id = $1 and revoked_at is null", [
          row.id,
          stamp(revokedAt),
        ]);
        admin.log.info({ event: "promotion_broken", counts: { claims: row.claim_ids.length } });
      }
      messages.push(noticeOf(row.provenance, stamp(revokedAt)));
    }
    return messages;
  });
}
