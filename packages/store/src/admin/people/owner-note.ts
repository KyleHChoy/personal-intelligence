import type { FactId, RulingId } from "@intelligence/contracts/personal";
import type { Query } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { Keys } from "../../core/keys.ts";

// The two facts a ruling needs of the owner's words, apart from owner-words.ts, which writes through
// rulings: what type a note is, and the claim a correction wrote.
export const OWNER_NOTE_TYPE = "owner_note";

export const correctionSource = (ruling: RulingId): string => `correct:${ruling}`;

// `liftIn` rejects it with the lift.
export async function correctionOf(query: Query, keys: Keys, ruling: RulingId): Promise<FactId | undefined> {
  const [row] = await query<{ id: FactId }>(
    "select c.id from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'owner_command' and e.source_item_fp = $1",
    [fingerprint(keys, "source_id", correctionSource(ruling))],
  );
  return row?.id;
}
