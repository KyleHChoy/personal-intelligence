import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";

// A capture's item is the one exception: its facts hold what code derived beside what the device
// sent (the mentions an erasure removes, the owner's vouch for a backfill, a moment's chat lines),
// so they are sealed again here, and nowhere else. The setting admits this one statement and is
// cleared after it; it lasts only inside the caller's transaction, so outside one the update is
// refused.
const REWRITE = "select set_config('pi.evidence_rewrite', $1, true)";

export async function rewriteCaptureItem(
  query: Query,
  keys: Pick<Keys, "compartments">,
  item: { evidenceId: string; compartments: string[] },
  facts: object,
): Promise<void> {
  await query(REWRITE, ["capture_facts"]);
  await query("update vault.evidence_items set item_enc = $2 where id = $1", [
    item.evidenceId,
    sealUnder(
      keys,
      item.compartments,
      { table: "vault.evidence_items", id: item.evidenceId, column: "item_enc" },
      JSON.stringify(facts),
    ),
  ]);
  await query(REWRITE, [""]);
}
