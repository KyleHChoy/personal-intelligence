import { newId } from "./ids.ts";
import { sealUnder } from "./seal.ts";
import type { Tx } from "./tx.ts";

// Keeps a name an item showed for an entity, once per entity, name and item, sealed under the item's
// label like any other row that cites it.
export async function keepAlias(
  tx: Tx,
  alias: { entity: string; nameFp: string; evidenceId: string; name: string; label: string[] },
): Promise<void> {
  const id = newId("als");
  await tx.query(
    `insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments) values ($1, $2, $3, $4, $5, $6)
       on conflict (entity_id, value_fp, evidence_id) do nothing`,
    [
      id,
      alias.entity,
      alias.nameFp,
      alias.evidenceId,
      sealUnder(tx.keys, alias.label, { table: "knowledge.aliases", id, column: "value_enc" }, alias.name),
      alias.label,
    ],
  );
}
