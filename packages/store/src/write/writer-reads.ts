import { CodedError, isRestricted, RESTRICTED_PREFIX, RestrictedCategory } from "@intelligence/contracts/personal";
import { fingerprint } from "../core/fingerprint.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// The writer's reads that select only, so a lost sync lock refuses none of them: the secrets, the
// restricted categories, whether an item is stored, and the database's size.

// A prefix is text, never a pattern.
export async function listSecretNames(tx: Tx, prefix: string): Promise<string[]> {
  return (
    await tx.query<{ name: string }>(
      `select name from policy.secrets where starts_with(name, $1) order by name collate "C"`,
      [prefix],
    )
  ).map((row) => row.name);
}

// A secret is sealed under the `own` key, bound to its name.
export async function secretOf(tx: Tx, name: string): Promise<string | null> {
  const [row] = await tx.query<{ value_enc: Sealed }>("select value_enc from policy.secrets where name = $1", [name]);
  return row === undefined
    ? null
    : open(tx.keys, { id: name, compartments: ["own"], value_enc: row.value_enc }, "policy.secrets.value_enc", "throw");
}

export async function restrictedOn(tx: Tx): Promise<RestrictedCategory[]> {
  const named = (await tx.query<{ category: string }>("select category from policy.restricted_categories"))
    .map((row) => row.category)
    .sort();
  // A wrapped file's keys are there, locked: an item they would seal is refused at ingest.
  const held = [...tx.keys.compartments.keys(), ...(tx.keys.locked ?? [])]
    .filter(isRestricted)
    .map((name) => name.slice(RESTRICTED_PREFIX.length))
    .sort();
  if (named.join() !== held.join()) throw new CodedError("restricted_keys_mismatch");
  return named.map((category) => RestrictedCategory.parse(category));
}

// Whether an item is stored and, with a tag, its latest revision carries it; true too for an item
// the owner erased. One query by fingerprints; it opens nothing.
export async function hasRevision(
  tx: Tx,
  given: SourceAccountRow,
  sourceItemId: string,
  revisionTag?: string,
): Promise<boolean> {
  const itemFp = fingerprint(tx.keys, "source_id", sourceItemId);
  const tagFp = revisionTag === undefined ? null : fingerprint(tx.keys, "revision_tag", revisionTag);
  const [row] = await tx.query<{ has: boolean }>(
    `select exists (select 1 from knowledge.removed_evidence where source_account_id = $1 and source_item_fp = $2)
             or coalesce((select $3::text is null or e.revision_tag_fp = $3 from vault.evidence_items e
                          where e.source_account_id = $1 and e.source_item_fp = $2 order by e.revision desc limit 1), false) as has`,
    [given.id, itemFp, tagFp],
  );
  return row?.has === true;
}

export async function databaseBytes(tx: Tx): Promise<number> {
  const [row] = await tx.query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes");
  return Number(row?.bytes ?? 0);
}
