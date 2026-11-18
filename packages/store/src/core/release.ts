import { RELEASED_LABEL } from "@intelligence/contracts/personal";
import { type Query, stamp } from "./db.ts";

// The owner's release of one agent record's claims under the owner's own label, `own`, as
// one knowledge.claim_releases row, written as pi_admin and only from the owner's own paths: the
// effect of the owner's confirm on an about_you card, and `pia facts release`. The database refuses
// a row whose decision is not the owner's own, in force, on that record, and one whose decision a
// relay made, which no release may rest on (knowledge.claim_releases_check).
// The pipeline makes the released claims at its next run. No agent API path reaches this module.

type ReleaseVia = "card" | "command";

// Invariant 11: whether the owner vetoed or retired, in force, a fact key (version 2
// or version 1) of a claim of the record, its released claim's included, as
// policy.released_records() reads it. Such a record is not released: the owner's veto outranks their
// earlier confirm. A veto lifted after the confirm leaves the record unreleased until `pia facts
// release`.
export async function vetoedRecord(query: Query, evidenceId: string): Promise<boolean> {
  const rows = await query(
    `select 1 from knowledge.claims c join knowledge.belief_rulings b on b.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp)
     where c.evidence_id = $1 and b.verdict in ('veto', 'retire') and b.lifted_at is null limit 1`,
    [evidenceId],
  );
  return rows.length > 0;
}

// An unlifted release of the record whose decision is no longer in force (tainted
// or superseded) or whose lift a replay journalled ends here, its lift naming its own ruling, so
// the record may be released again. A vetoed record is never released, so it never reaches here.
const END_STALE = `
  update knowledge.claim_releases r set lifted_at = $2, lift_ruling_id = r.ruling_id
  where r.evidence_id = $1 and r.lifted_at is null
    and (exists (select 1 from knowledge.owner_decisions o where o.id = r.ruling_id
                 and (o.tainted_at is not null or exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)))
      or exists (select 1 from knowledge.release_lifts l where l.ruling_id = r.ruling_id))`;

// Whether a row was written: false when a release of the record is already in force, or when the
// evidence row is no agent record's (a claim of origin agent_record is always one's; this keeps a
// confirm from failing on a row that is not).
export async function insertRelease(
  query: Query,
  release: { ruling: string; evidenceId: string; via: ReleaseVia; now: Date },
): Promise<boolean> {
  await query(END_STALE, [release.evidenceId, stamp(release.now)]);
  const rows = await query<{ ruling_id: string }>(
    `insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments)
     select $1::text, $2::text, $3::text, $4::timestamptz, $5::text[] where exists (select 1 from vault.evidence_items e where e.id = $2::text and e.source_kind = 'agent_record')
     on conflict do nothing returning ruling_id`,
    [release.ruling, release.evidenceId, release.via, stamp(release.now), [...RELEASED_LABEL]],
  );
  return rows.length > 0;
}
