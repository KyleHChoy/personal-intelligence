import { RestrictedCategory, type RestrictedCount } from "@intelligence/contracts/personal";
import { restrictedCategories } from "@intelligence/personal-core/items";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { restrictionRequestId } from "../../core/ids.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedOrNull, type Tx } from "../../core/tx.ts";

// The restricted items' owner side in the store, run as pi_admin. Counts and category names only:
// nothing an item says.

// A category turned on: its row, after its key is in the restricted file. A second add of the same
// category writes nothing, so an add stopped between the key and the row is simply run again.
export async function addRestrictedCategory(query: Query, category: RestrictedCategory): Promise<void> {
  if (!RestrictedCategory.safeParse(category).success) throw new AdminError("invalid_argument");
  await query("insert into policy.restricted_categories (category) values ($1) on conflict (category) do nothing", [
    category,
  ]);
}

// For each on category: the source items that carry it, its pending requests and its lifts.
export async function restrictedCounts(query: Query): Promise<RestrictedCount[]> {
  const rows = await query<{ category: RestrictedCategory; items: number; pending: number; lifts: number }>(
    `select r.category,
       (select count(*)::int from (select distinct e.source_account_id, e.source_item_fp from vault.evidence_items e
                                   where ('restricted:' || r.category) = any (e.compartments)) i) as items,
       (select count(*)::int from vault.restriction_requests q where q.category = r.category and q.applied_at is null) as pending,
       (select count(*)::int from vault.restriction_lifts l where l.category = r.category) as lifts
     from policy.restricted_categories r
     order by r.category`,
  );
  return rows.map((row) => ({ category: row.category, items: row.items, pending: row.pending, lifts: row.lifts }));
}

// One stored message as the reclassification reads it: its sealed subject and text, and its item.
type StoredMessage = {
  id: string;
  evidence_id: string;
  compartments: string[];
  subject_enc: Sealed;
  body_enc: Sealed;
  account_id: string;
  source_item_fp: string;
  label: string[];
};

const PAGE = 500;

// The next page of stored messages after `after`, by id, with their item's label.
const nextPage = (query: Query, after: string): Promise<StoredMessage[]> =>
  query<StoredMessage>(
    `select m.id, m.evidence_id, m.compartments, m.subject_enc, m.body_enc,
            e.source_account_id as account_id, e.source_item_fp, e.compartments as label
     from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
     where m.id > $1 order by m.id limit ${PAGE}`,
    [after],
  );

// The owner's one-time reclassification of stored mail: the rung 0 term screen, the deterministic
// rule sync applies at ingest, over every stored message. Each message whose subject or lead text
// holds a term of an on category its item does not carry, and that the owner has not lifted for its
// item, gets a pending restriction request, and its item's messages are kept from every client at
// once (`restricting`) until sync's relabel moves the item into the category. With `apply` false
// nothing is written. Counts only, by category: nothing a message says.
export async function reclassifyStored(
  { query, keys }: Tx,
  apply: boolean,
): Promise<{ category: RestrictedCategory; items: number }[]> {
  const on = (
    await query<{ category: string }>("select category from policy.restricted_categories order by category")
  ).map((row) => RestrictedCategory.parse(row.category));
  const found = new Map(on.map((category) => [category, 0]));
  if (on.length === 0) return [];
  // An item's revisions are several messages, each screened; an item is counted once per category.
  const counted = new Set<string>();
  let after = "";
  for (let page = await nextPage(query, after); page.length > 0; page = await nextPage(query, after)) {
    after = page[page.length - 1]?.id ?? after;
    for (const row of page) {
      const at = (column: string) => ({ table: "knowledge.messages", id: row.id, column });
      const subject = openedOrNull(keys, row.compartments, at("subject_enc"), row.subject_enc);
      const text = openedOrNull(keys, row.compartments, at("body_enc"), row.body_enc);
      const matched = restrictedCategories({ subject, text }, on).filter(
        (category) => !row.label.includes(`restricted:${category}`),
      );
      if (matched.length === 0) continue;
      const lifted = new Set(
        (
          await query<{ category: string }>(
            "select category from vault.restriction_lifts where account_id = $1 and source_item_fp = $2",
            [row.account_id, row.source_item_fp],
          )
        ).map((one) => one.category),
      );
      const asked = matched.filter((category) => !lifted.has(category));
      for (const category of asked) {
        const key = `${row.account_id}/${row.source_item_fp}/${category}`;
        if (counted.has(key)) continue;
        counted.add(key);
        found.set(category, (found.get(category) ?? 0) + 1);
      }
      if (!apply || asked.length === 0) continue;
      for (const category of asked)
        await query(
          `insert into vault.restriction_requests (id, evidence_id, kind, category, requested_by, compartments)
           values ($1, $2, 'restrict', $3, 'screen', $4)
           on conflict (evidence_id, kind, category) where applied_at is null do nothing`,
          [restrictionRequestId(), row.evidence_id, category, row.label],
        );
      await query(
        `update knowledge.messages m set restricting = true
         where not m.restricting
           and m.evidence_id in (select e.id from vault.evidence_items e where e.source_account_id = $1 and e.source_item_fp = $2)`,
        [row.account_id, row.source_item_fp],
      );
    }
  }
  return [...found].map(([category, items]) => ({ category, items }));
}
