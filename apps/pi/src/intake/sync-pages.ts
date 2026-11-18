import type { RawItem } from "@intelligence/contracts";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import type { ItemContext, ItemFacts } from "@intelligence/personal-core/items";
import { deriveItem } from "@intelligence/personal-core/items";
import type { SourceAccountRow, SyncCounts, Writer } from "@intelligence/personal-store";
import { codeOf } from "../env.ts";

// What both syncs share: the item refusals no retry mends, the page size, the derive step, and
// how an account's outcome is recorded with its counts.

// What the writer refuses about one item that no retry can mend: the item does not parse, the
// facts read from it do not fit it, or the database will not take a value of it. An item the screen
// restricts while the restricted keys are locked is not one of them: it is not stored, never under
// its source compartment alone, and it is no fault and not listed as skipped. It waits on an unlock,
// counted by its account's items_waiting_unlock line.
export const REFUSED_FOR_GOOD = new Set(["invalid_item", "invalid_facts", "write_refused"]);

export const PAGE_LIMIT = 500;

export const derive = (raw: RawItem, ctx: ItemContext): Promise<ItemFacts> => deriveItem(raw, ctx, PERSONAL_LIMITS);

// The outcome a failure records. A refresh token Google no longer takes, or one granted other
// scopes (a label connected for metadata alone holds gmail.metadata), asks the owner to connect
// again; the identity port's failure is the database's.
export function outcomeOf(error: unknown): string {
  const code = codeOf(error);
  if (code === "oauth_failed" || code === "scope_mismatch") return "reconnect_google";
  return code === "control_unavailable" ? "unavailable" : code;
}

// Records an account's outcome, and answers what the run reports for it. An outcome that cannot be
// recorded ends the run: the database is gone, or the sync lock with it, and nothing more may be
// written. A failure keeps its own code; only an `ok` takes the recording's. It carries the sync's
// counts for the coverage report, its kind always.
export async function record(
  writer: Writer,
  account: SourceAccountRow,
  outcome: string,
  at: string,
  skipped: number,
  counts: SyncCounts,
): Promise<{ outcome: string; recorded: boolean }> {
  try {
    await writer.recordOutcome(account, outcome, at, skipped, counts);
    return { outcome, recorded: true };
  } catch (error) {
    return { outcome: outcome === "ok" ? outcomeOf(error) : outcome, recorded: false };
  }
}

export type SyncKindOfRun = SyncCounts["kind"];
export const noCounts = (kind: SyncKindOfRun): SyncCounts => ({
  kind,
  stored: 0,
  held: 0,
  junk: 0,
  decided: 0,
  removed: 0,
});
