import type { Digest } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { SHOWN_TO_OWNER } from "../../cards/asked-less.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { stamp } from "../../core/db.ts";
import { latestRow, noCanaryIn } from "../../core/statements.ts";

// What waits for the owner, as counts only: one read transaction of three counting statements, one of them over the cards.
// A card's state is its latest event. Nothing sealed is selected, and no id, name, subject, compartment or text is
// returned.

const LATEST = `join lateral (${latestRow("r.event, r.at", "card", "c.id")}) s on true`;

export async function digest(admin: AdminContext): Promise<Digest> {
  const now = admin.now().getTime();
  return admin.transaction(async (query) => {
    // R-X3: the cards in one pass, by kind and latest event; pending and deferred only, so the
    // oldest pending is the least of the pending rows' times. A pending box health card counts once
    // it has stood for its quiet hours, as in the queue.
    const cards = await query<{ kind: string; event: "pending" | "deferred"; n: number; at: Date }>(
      `select c.kind, s.event, count(*)::int as n, min(s.at) as at from ledger.cards c ${LATEST} where s.event in ('pending', 'deferred') and ${noCanaryIn("c.compartments")} and (s.event = 'deferred' or ${SHOWN_TO_OWNER("$1")}) group by c.kind, s.event order by c.kind`,
      [stamp(admin.now())],
    );
    const [held] = await query<{ n: number }>("select count(*)::int as n from knowledge.messages where held");
    const [withheld] = await query<{ n: number }>(
      `select count(*)::int as n from vault.pipeline_items where withheld and ${noCanaryIn("compartments")}`,
    );
    const pending = cards.filter((row) => row.event === "pending");
    const at = pending.reduce<Date | null>((least, row) => (least === null || row.at < least ? row.at : least), null);
    return {
      pending: Object.fromEntries(pending.map((row) => [row.kind, row.n])),
      deferred: cards.reduce((sum, row) => sum + (row.event === "deferred" ? row.n : 0), 0),
      oldestPendingDays: at === null ? null : Math.max(0, Math.floor((now - at.getTime()) / DAY_MS)),
      heldMessages: held?.n ?? 0,
      withheldItems: withheld?.n ?? 0,
    };
  });
}
