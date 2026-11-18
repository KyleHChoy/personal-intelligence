import type { Timestamp } from "@intelligence/contracts";
import { IMPORT_LABEL_PREFIX } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stampOrNull } from "../../core/db.ts";
import { removeSourceItem } from "../../write/writer-item-removal.ts";
import { syncLock } from "../admin-base.ts";

// Contact import: the owner's list of their imports and the removal of one, as pi_admin. An import
// is a `contacts_import` source account labelled `import:<name>`; removing it removes every stored
// contact of it through the deletion path, as `pi contacts remove` does a label's saved contacts.
// It is no erasure: it writes no suppression and no removed evidence, so importing the file again
// stores it again. The account row stays, holding nothing, so the name can be imported again.

type ImportView = { name: string; contacts: number; lastImportAt: Timestamp | null; lastOutcome: string | null };

// Each import, by name: how many contacts it holds and when it last ran.
export function listImports(admin: AdminContext): Promise<ImportView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      label: string;
      contacts: number;
      last_sync_at: Date | null;
      last_outcome: string | null;
    }>(
      `select a.label, (select count(*)::int from knowledge.contacts c where c.account_id = a.id) as contacts, a.last_sync_at, a.last_outcome
       from vault.source_accounts a where a.connector = 'contacts_import' order by a.label collate "C"`,
    );
    return rows.map((row) => ({
      name: row.label.slice(IMPORT_LABEL_PREFIX.length),
      contacts: row.contacts,
      lastImportAt: stampOrNull(row.last_sync_at),
      lastOutcome: row.last_outcome,
    }));
  });
}

// Every stored item of the import removed, in one transaction under the sync lock.
export function removeImport(
  admin: AdminContext,
  name: string,
  _options: { requestId: string },
): Promise<{ items: number }> {
  return admin.transaction(async (query) => {
    await syncLock(query);
    const [account] = await query<{ id: string; compartments: string[] }>(
      "select id, compartments from vault.source_accounts where label = $1 and connector = 'contacts_import'",
      [`${IMPORT_LABEL_PREFIX}${name}`],
    );
    if (account === undefined) throw new AdminError("not_found");
    const items = await query<{ source_item_fp: string }>(
      "select distinct source_item_fp from vault.evidence_items where source_account_id = $1 order by 1",
      [account.id],
    );
    let removed = 0;
    for (const item of items) {
      const gone = await removeSourceItem(
        { query, keys: admin.keys },
        { id: account.id, compartment: account.compartments[0] ?? "" },
        item.source_item_fp,
        // The owner removed the import that held it.
        "dropped",
      );
      if (gone.removed) removed += 1;
    }
    return { items: removed };
  });
}
