import { sealUnder } from "./seal.ts";
import { openStatus, type StatusFacts, statusAt } from "./status-facts.ts";
import type { Tx } from "./tx.ts";

// An item's status row set waiting, its facts sealed under the row's whole label (an agent
// record's has several compartments): the one statement the owner's retries and replays write.
export const writeStatus = (tx: Tx, evidenceId: string, compartments: string[], facts: StatusFacts) =>
  tx.query(
    `insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, updated_at, facts_enc, compartments)
     values ($1, true, false, false, 0, now(), $2, $3)
     on conflict (evidence_id) do update set waiting = true, withheld = false, screened = false, updated_at = now(), facts_enc = excluded.facts_enc,
       vendor_retries = 0, retry_at = null`,
    // Under the row's whole label: an agent record's has several compartments.
    [evidenceId, sealUnder(tx.keys, compartments, statusAt(evidenceId), JSON.stringify(facts)), compartments],
  );

// An item with no status row was never taken, and is due already. The caller holds the extract
// lock. Returns how many were set waiting. `more`, facts set on each beside them (the reroute's
// mark).
export async function waitToReplay(
  tx: Tx,
  evidenceIds: readonly string[],
  more: Pick<StatusFacts, "rerouted" | "ask"> = {},
): Promise<number> {
  const rows = await tx.query<{ evidence_id: string; compartments: string[]; facts_enc: unknown }>(
    'select evidence_id, compartments, facts_enc, extractor_generation, waiting from vault.pipeline_items where evidence_id = any ($1) order by evidence_id collate "C"',
    [evidenceIds],
  );
  for (const row of rows) {
    const facts = openStatus(tx, row.compartments, row.evidence_id, row.facts_enc);
    await writeStatus(tx, row.evidence_id, row.compartments, {
      lane: facts.lane,
      ...(facts.laneOverride === undefined ? {} : { laneOverride: facts.laneOverride }),
      override: facts.override,
      status: "waiting",
      attempts: 0,
      claims: facts.claims,
      unmapped: facts.unmapped,
      unresolved: facts.unresolved,
      // A retry not yet committed stays one, and a reroute.
      ...(facts.retried === true ? { retried: true as const } : {}),
      ...(facts.rerouted === true ? { rerouted: true as const } : {}),
      ...(facts.ask === undefined ? {} : { ask: facts.ask }),
      ...more,
    });
  }
  return rows.length;
}
