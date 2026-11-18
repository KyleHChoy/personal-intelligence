import { type ClaimRecord, FactId } from "@intelligence/contracts/personal";
import { claimOf } from "../cards/card-kinds-claims.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { authorWord } from "../core/locks.ts";
import { EXTRACT_AUTHOR, lockRows } from "../core/queue.ts";
import type { Tx } from "../core/tx.ts";

// A card of the two kinds with no match key, and its claim's content, or why none.
export type UnkeyedCard =
  | { card: string; content: ClaimRecord["claim"]["content"]; reason?: undefined }
  | { card: string; content: null; reason: "claim_gone" | "unreadable" | "not_agent" };

export async function unkeyedCards(tx: Tx, limit: { size: number; after?: string }): Promise<UnkeyedCard[]> {
  await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
  const rows = await tx.query<{ id: string; target_id: string; request_id: string; compartments: string[] }>(
    `select id, target_id, request_id, compartments from ledger.cards
       where created_by = 'system:extract' and kind in ('about_you', 'agent_claim') and match_fp is null and target_kind = 'claim' and id collate "C" > $2
       order by id collate "C" limit $1`,
    [limit.size, limit.after ?? ""],
  );
  const out: UnkeyedCard[] = [];
  for (const row of rows) {
    // The claim by its claim key when a generation raise remade its id, as a card's lines find it.
    let found: Awaited<ReturnType<typeof claimOf>>;
    try {
      found = await claimOf(
        {
          target: { kind: "claim", id: FactId.parse(row.target_id) },
          compartments: row.compartments,
          requestId: row.request_id,
        },
        tx,
      );
    } catch {
      found = "claim_unreadable";
    }
    if (typeof found === "string")
      out.push({ card: row.id, content: null, reason: found === "claim_removed" ? "claim_gone" : "unreadable" });
    // Only an agent record's claim takes a match key: a need question's or a title link's card
    // never does at its raise, so none is given one here.
    else if (found.record.origin !== "agent_record") out.push({ card: row.id, content: null, reason: "not_agent" });
    else out.push({ card: row.id, content: found.record.claim.content });
  }
  return out;
}

// One match key set on one card, only where it has none, under the author word.
export async function setMatchKey(tx: Tx, card: string, key: string): Promise<boolean> {
  await lockRows(tx.query, [authorWord(EXTRACT_AUTHOR)]);
  const rows = await tx.query("update ledger.cards set match_fp = $2 where id = $1 and match_fp is null returning id", [
    card,
    fingerprint(tx.keys, "fact", key),
  ]);
  return rows.length > 0;
}
