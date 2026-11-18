import { FactId, type FactView } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { ADMIN_FACT_SOURCE } from "../../read/fact-source.ts";
import { claimRecordUnder } from "../admin-owner.ts";
import { type ClaimRow, renderFact } from "./admin-rulings.ts";

// Several claims as factShow renders each (the page's Settings names every join and split in one
// read, not one factShow a side), in one transaction. A claim the key file does not open, no longer
// held, or that does not render is left out of the map, and the rest stand.
export async function factViews(admin: AdminContext, ids: readonly FactId[]): Promise<Map<FactId, FactView>> {
  const wanted = [...new Set(ids.filter((id) => FactId.safeParse(id).success))];
  if (wanted.length === 0) return new Map();
  return admin.transaction(async (query) => {
    const rows = await query<ClaimRow>(
      `select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, e.source_account_id, e.source_item_fp, m.id as message_id, d.id as document_id, k.agent_app, ${ADMIN_FACT_SOURCE} as source
       from knowledge.claims c
       join vault.evidence_items e on e.id = c.evidence_id
       left join knowledge.messages m on m.evidence_id = c.evidence_id
       left join knowledge.documents d on d.evidence_id = c.evidence_id
       left join knowledge.captures k on k.evidence_id = c.evidence_id
       where c.id = any ($1::text[])
       order by c.id collate "C"`,
      [wanted],
    );
    const views = new Map<FactId, FactView>();
    for (const row of rows) {
      if (!row.compartments.every((one) => admin.keys.compartments.has(one))) continue;
      try {
        const record = claimRecordUnder(admin.keys, row);
        views.set(row.id, await renderFact(admin, query, row, record));
      } catch {
        // Named on the page as a fact it could not read, as a factShow that failed was.
      }
    }
    return views;
  });
}
