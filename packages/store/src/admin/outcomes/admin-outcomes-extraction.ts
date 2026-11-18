import { VENDOR_FAILURE_CODES } from "@intelligence/personal-core/planner";
import type { Query } from "../../core/db.ts";
import { lever } from "../../core/settings.ts";

// `pi outcomes`' `extraction`: the items a vendor outage failed. `waiting`: those owed an automatic
// retry, scheduled or taken up again and not yet ended. `exhausted`: those whose tries are spent,
// which only the owner's retry runs again. Counts and codes only, from the status row's clear
// columns; only rows within the key file's compartments but the restricted ones are counted, as
// every outcome is.

export type ExtractionRetries = {
  // The failure codes that are retried, and the most automatic retries one item gets.
  codes: readonly string[];
  maxTries: number;
  waiting: number;
  exhausted: number;
  // Set while any item's tries are spent.
  code?: "retries_exhausted";
};

const RETRIES = `
  select count(*) filter (where vendor_retries > 0 and (retry_at is not null or waiting))::int as waiting,
    count(*) filter (where vendor_retries >= $2 and retry_at is null and not waiting)::int as exhausted
  from vault.pipeline_items where compartments <@ $1::text[]`;

export async function extractionRetries(query: Query, within: readonly string[]): Promise<ExtractionRetries> {
  const maxTries = await lever(query, "extract.vendor_retry_max");
  const [row] = await query<{ waiting: number; exhausted: number }>(RETRIES, [[...within], maxTries]);
  const exhausted = row?.exhausted ?? 0;
  return {
    codes: VENDOR_FAILURE_CODES,
    maxTries,
    waiting: row?.waiting ?? 0,
    exhausted,
    ...(exhausted > 0 ? { code: "retries_exhausted" as const } : {}),
  };
}
