import { byText } from "../core/db.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// The owner's names or addresses under labels within `label`, each opened, sorted and once. Both
// tables' policies hold the reach: an alias row is returned to the pipeline only when it is the
// owner's entity's.
async function ownersOpened(
  tx: Tx,
  table: "knowledge.aliases" | "knowledge.accounts",
  label: string[],
): Promise<string[]> {
  const rows = await tx.query<{ id: string; value_enc: Sealed; compartments: string[] }>(
    `select a.id, a.value_enc, a.compartments from ${table} a join knowledge.entities e on e.id = a.entity_id
     where e.kind = 'owner' and a.compartments <@ $1::text[] order by a.id collate "C"`,
    [label],
  );
  return [...new Set(rows.map((one) => open(tx.keys, one, `${table}.value_enc`, "throw")))].sort(byText);
}

// The owner's addresses under labels within an item's label only: for an item under one
// compartment, those under exactly it. What the pipeline tells the owner's mail from others' by.
export const ownerAddressesOf = (tx: Tx, label: string[]): Promise<string[]> =>
  ownersOpened(tx, "knowledge.accounts", label);

// The owner's names and addresses under labels within a finding's own: what its `owner:this`
// mention grounds on. A name the owner's mail gave them under another label grounds nothing here,
// as it could not be read with the finding.
export async function ownerKeysOf(tx: Tx, label: string[]): Promise<{ names: string[]; addresses: string[] }> {
  return { names: await ownersOpened(tx, "knowledge.aliases", label), addresses: await ownerAddressesOf(tx, label) };
}
