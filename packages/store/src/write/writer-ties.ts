import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// The ties backfill's questions of what is stored, from fingerprints and clear columns. None writes
// or opens anything.

// Those of `ids` that are stored or that the owner erased: neither is fetched.
export async function tiesKnown(
  query: Query,
  keys: Keys,
  account: SourceAccountRow,
  ids: string[],
): Promise<Set<string>> {
  const idOf = new Map(ids.map((id) => [fingerprint(keys, "source_id", id), id]));
  const rows = await query<{ fp: string }>(
    `select source_item_fp as fp from vault.evidence_items where source_account_id = $1 and source_item_fp = any($2)
     union select source_item_fp from knowledge.removed_evidence where source_account_id = $1 and source_item_fp = any($2)`,
    [account.id, [...idOf.keys()]],
  );
  return new Set(rows.flatMap((row) => idOf.get(row.fp) ?? []));
}

// A pass lists newest first, so everything newer than this was already decided. Google's own
// receipt time, never the Date header a sender writes: one forged old date must not skip the years
// between.
export async function tiesOldest(
  query: Query,
  account: SourceAccountRow,
  direction: "outbound" | "inbound",
): Promise<Date | null> {
  const [row] = await query<{ at: Date | null }>(
    `select min(e.observed_at) as at from knowledge.interaction_log i
     join vault.evidence_items e on e.id = i.evidence_id
     where e.source_account_id = $1 and i.channel = 'mail_headers' and i.direction = $2`,
    [account.id, direction],
  );
  return row?.at ?? null;
}

export async function tiesListing(query: Query, account: SourceAccountRow): Promise<boolean> {
  const [row] = await query<{ yes: boolean }>(
    "select exists (select 1 from vault.listed_items where account_id = $1) as yes",
    [account.id],
  );
  return row?.yes === true;
}
