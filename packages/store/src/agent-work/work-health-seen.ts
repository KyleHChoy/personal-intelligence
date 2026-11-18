import type { MarkHealthSeenArgs, MarkHealthSeenResult } from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { answered, type Done, isRefused, refused, refusedAs, type WorkCall } from "../core/work-refs.ts";

// mark_health_seen, as pi_reader: an agent's seen on one box health card. The definer decides
// everything, from what the caller is cleared for: which card it can see, whether its kind is one
// an agent may mark, whether it came back after an agent's seen, whether it still waits. It answers
// a code and, when the card is the caller's seen, its time.

const SQL = "select code, seen_at from ledger.mark_health_seen($1, $2, $3)";

const REFUSALS = ["owners_card", "came_back_after_seen", "card_closed"] as const;
type Refusal = (typeof REFUSALS)[number];
const isRefusal = (code: string | undefined): code is Refusal => (REFUSALS as readonly string[]).includes(code ?? "");

export async function markHealthSeen(call: WorkCall, valid: MarkHealthSeenArgs): Promise<Done<MarkHealthSeenResult>> {
  const rows = await call.fn<{ code: string; seen_at: Date | null }>(SQL, [
    valid.card,
    valid.requestId,
    await call.session(),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row?.code === "ok" && row.seen_at !== null) return answered({ card: valid.card, seenAt: stamp(row.seen_at) });
  const code = row?.code;
  if (isRefusal(code)) return refusedAs(code);
  return refused("not_found");
}
