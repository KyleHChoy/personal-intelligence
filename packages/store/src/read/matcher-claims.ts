import type { Run } from "../core/read-ctx.ts";
import { RELEASE_IN_FORCE } from "../core/visibility.ts";

// A belief computed at read leaves out of its support a claim a later reversal superseded (the
// claim relation the commit writes), but the commitment began when that claim was stated, and its
// thread's project is still its target.

// $2: the owner's audience, or null under a client's token, whose row policies hold it.
const KEY_CLAIMS = `
  select c.id, c.fact_key_fp from knowledge.claims c
  where c.fact_key_fp = any($1::text[]) and ${RELEASE_IN_FORCE} and ($2::text[] is null or c.compartments <@ $2::text[])
  order by c.id`;

// Each commitment's claims, by its row id.
export async function itemClaims(
  run: Run,
  rows: readonly { id: string; fact_key_fp: string; support: readonly string[] }[],
  audience: readonly string[] | null,
): Promise<Map<string, string[]>> {
  const found = await run<{ id: string; fact_key_fp: string }>(KEY_CLAIMS, [
    [...new Set(rows.map((row) => row.fact_key_fp))],
    audience === null ? null : [...audience],
  ]);
  const byKey = new Map<string, string[]>();
  for (const one of found) byKey.set(one.fact_key_fp, [...(byKey.get(one.fact_key_fp) ?? []), one.id]);
  return new Map(rows.map((row) => [row.id, [...new Set([...row.support, ...(byKey.get(row.fact_key_fp) ?? [])])]]));
}
