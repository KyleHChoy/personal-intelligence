import { ClaimRecord } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { claimKeysOf, valueFpOf } from "../../core/claim-columns.ts";
import type { Query } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";

// As pi_admin: `pia extract value-fp-backfill` and `pia extract carry-over`. Ids and counts only.

// The backfill's batch, each batch one transaction.
const BACKFILL_BATCH = 1_000;

type Unvalued = {
  id: string;
  evidence_id: string;
  fact_key_fp: string;
  legacy_fact_key_fp: string | null;
  legacy_alt_fact_key_fp: string | null;
  compartments: string[];
  content_enc: Sealed;
};

// One batch: the value rows of up to BACKFILL_BATCH claims stored with none, after `after` in id
// order. A claim whose label holds a compartment the keys lack, or whose sealed record is no
// ClaimRecord, is skipped and counted. `knowledge.claims` is never updated: its dates stay null
// until the claim is written again.
export async function backfillValues(
  query: Query,
  keys: Keys,
  after: string,
): Promise<{ last: string | null; written: number; skipped: number }> {
  const rows = await query<Unvalued>(
    `select c.id, c.evidence_id, c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp, c.compartments, c.content_enc
     from knowledge.claims c
     where c.id collate "C" > $1 and not exists (select 1 from knowledge.claim_values v where v.claim_id = c.id)
     order by c.id collate "C" limit $2`,
    [after, BACKFILL_BATCH],
  );
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.compartments.every((compartment) => keys.compartments.has(compartment))) {
      skipped += 1;
      continue;
    }
    const record = ClaimRecord.safeParse(JSON.parse(open(keys, row, "knowledge.claims.content_enc", "throw")));
    if (!record.success) {
      skipped += 1;
      continue;
    }
    const claimKeys = claimKeysOf({ keys }, row.evidence_id, [
      row.fact_key_fp,
      row.legacy_fact_key_fp,
      row.legacy_alt_fact_key_fp,
    ]);
    await query(
      `insert into knowledge.claim_values (claim_id, claim_key, value_fp, compartments)
       select $1, k.key, $3, $4 from unnest($2::text[]) as k (key) order by k.key collate "C" on conflict do nothing`,
      [row.id, claimKeys, valueFpOf(keys, record.data), row.compartments],
    );
    written += 1;
  }
  return { last: rows.at(-1)?.id ?? null, written, skipped };
}

export type CarryOverReport = {
  generation: number;
  rulings: { checked: number; unfound: string[] };
  relations: { checked: number; unfound: string[] };
};

// Before a raised generation's claims are served, every ruling in force and every relation the
// owner judged must find a claim of that generation or later, by key or through the carry: a claim
// whose own fact key is the ruled one, or whose version 1 key is (a veto's or a retire's only on an
// item it was made on, a reject's only on its own item); a relation's claim by any claim key it is
// known by (its value rows hold its version 1 keys' too). Those that find none are listed, ids
// only. A relation's claim key made over an earlier revision of its item is not followed to a later
// revision: it is listed. A ruling re-attached by a `ruling_carry` finds its claim through that
// carry, so it is not listed; the carry is, if it finds none.
export async function carryOver(query: Query, { generation }: { generation: number }): Promise<CarryOverReport> {
  const [counts] = await query<{ rulings: number; relations: number }>(
    `select ((select count(*) from knowledge.belief_rulings where lifted_at is null) + (select count(*) from knowledge.fact_rulings where lifted_at is null))::int as rulings,
       (select count(*) from knowledge.claim_relations where starts_with(judged_by, 'owner:'))::int as relations`,
  );
  const rulings = await query<{ id: string }>(
    `select r.ruling_id as id from knowledge.belief_rulings r
     where r.lifted_at is null
       and not exists (select 1 from knowledge.owner_decisions d where d.kind = 'ruling_carry' and d.details ->> 'from' = r.ruling_id)
       and not exists (
       select 1 from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
       where c.extractor_generation >= $1
         and (c.fact_key_fp = r.fact_key_fp
           or ((c.legacy_fact_key_fp = r.fact_key_fp or c.legacy_alt_fact_key_fp = r.fact_key_fp)
             and (r.item_fps is null
               or exists (select 1 from unnest(r.item_account_ids, r.item_fps) as i (account_id, fp) where i.account_id = e.source_account_id and i.fp = e.source_item_fp))))
         and (r.verdict <> 'reject' or (e.source_account_id = r.source_account_id and e.source_item_fp = r.source_item_fp)))
     union
     select f.ruling_id from knowledge.fact_rulings f cross join unnest(array[f.a_fp, f.b_fp]) as s (fp)
     where f.lifted_at is null
       and not exists (select 1 from knowledge.owner_decisions d where d.kind = 'ruling_carry' and d.details ->> 'from' = f.ruling_id)
       and not exists (
       select 1 from knowledge.claims c
       where c.extractor_generation >= $1 and (c.fact_key_fp = s.fp or c.legacy_fact_key_fp = s.fp or c.legacy_alt_fact_key_fp = s.fp))
     order by 1`,
    [generation],
  );
  const relations = await query<{ id: string }>(
    `select distinct r.id::text as id from knowledge.claim_relations r cross join unnest(array[r.from_claim_key, r.to_claim_key]) as k (key)
     where starts_with(r.judged_by, 'owner:') and not exists (
       select 1 from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id
       where v.claim_key = k.key and c.extractor_generation >= $1)
     order by 1`,
    [generation],
  );
  return {
    generation,
    rulings: { checked: counts?.rulings ?? 0, unfound: rulings.map((row) => row.id) },
    relations: { checked: counts?.relations ?? 0, unfound: relations.map((row) => row.id) },
  };
}

// `pia extract value-fp-backfill`: the value rows of every claim stored without them, one
// transaction for each batch of 1,000.
export async function valueFpBackfill(admin: AdminContext): Promise<{ written: number; skipped: number }> {
  let after = "";
  const total = { written: 0, skipped: 0 };
  for (;;) {
    const batch = await admin.transaction((query) => backfillValues(query, admin.keys, after));
    total.written += batch.written;
    total.skipped += batch.skipped;
    if (batch.last === null) return total;
    after = batch.last;
  }
}
