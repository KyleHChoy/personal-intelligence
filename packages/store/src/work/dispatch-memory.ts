import type { CardId, PersonalLogger } from "@intelligence/contracts/personal";
import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";

// The tick's rewrite card, as pi_work: the stale restatements counted by
// ledger.stale_restatements(), and one `stale_restatement` card for each client and fact key with
// three or more since that pair's latest decided card. The card has no body: its lines are code's,
// read when the owner lists it. No run is queued.

const BY = "system:memory";
const AT_LEAST = 3;

export type StaleRestatement = { client: string; caseKey: string };

export const staleRestatements = async (query: Query): Promise<StaleRestatement[]> =>
  (
    await query<{ client_id: string; case_key: string }>(
      "select client_id, case_key from ledger.stale_restatements() where count >= $1",
      [AT_LEAST],
    )
  ).map((row) => ({
    client: row.client_id,
    caseKey: row.case_key,
  }));

// One card for the pair, under the client's label, unless one for it is undecided (raiseCard
// answers that one as a replay). Null when none was raised.
export async function raiseStaleCard(
  query: Query,
  stale: StaleRestatement,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const [client] = await query<{ compartments: string[] }>("select compartments from policy.clients where id = $1", [
    stale.client,
  ]);
  if (client === undefined) return null;
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: "stale_restatement",
      author: BY,
      options: [...CARD_OPTIONS.stale_restatement],
      target: null,
      refs: [],
      compartments: [...new Set(client.compartments)].sort(),
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: stale.caseKey,
      run: null,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  return card.replayed ? null : card.id;
}
