import type { TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import type { Sealed } from "../../core/seal.ts";
import { sealRow } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { opened } from "../../core/tx.ts";
import { removeSourceItem } from "../../write/writer-item-removal.ts";
import { syncLock } from "../admin-base.ts";
import { documentsWaitAgain, tryExtractLock } from "../extraction/admin-extraction.ts";

// The Drive roots the owner sets, run as pi_admin. A root is a folder's id or one of the words
// `my-drive` and `shared-with-me`, sealed under the `own` key; its keyed fingerprint is what the
// writer matches a document's root against.

type RootMode = "extract" | "reference";
type RootKind = "folder" | "my-drive" | "shared-with-me";
export type RootRow = { id: string; label: string; kind: RootKind; mode: RootMode; documents: number };

const kindOf = (root: string): RootKind => (root === "my-drive" || root === "shared-with-me" ? root : "folder");
const rootAt = (id: string) => ({ table: "policy.drive_roots", id, column: "root_enc" });

// A new listing for a label's Drive at its next sync: unchanged files are in no feed entry, so only
// a listing finds what a change of roots brought into scope. It fetches only what is not stored, so
// nothing already stored is read again.
const RESET_CURSOR =
  "update vault.source_accounts set cursor_enc = null, cursor_updated_at = now() where label = $1 and connector = 'google_docs'";

// The same folder or word twice for one label is refused.
export async function addRoot(
  { query, keys, now }: TxAt,
  label: string,
  root: string,
  mode: RootMode,
): Promise<{ id: string }> {
  await syncLock(query);
  const rootFp = fingerprint(keys, "source_id", root);
  const id = newId("drt");
  const [made] = await query<{ id: string }>(
    `insert into policy.drive_roots (id, label, kind, root_fp, mode, created_at, root_enc) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (label, root_fp) do nothing returning id`,
    [id, label, kindOf(root), rootFp, mode, stamp(now), sealRow(keys, "own", rootAt(id), root)],
  );
  if (made === undefined) throw new AdminError("duplicate_name");
  await query(RESET_CURSOR, [label]);
  return made;
}

// Every root, by label then id, with how many documents are stored under it.
export async function roots(query: Query): Promise<RootRow[]> {
  return query<RootRow>(
    `select r.id, r.label, r.kind, r.mode, (select count(*) from knowledge.documents d where d.root_id = r.id)::int as documents
     from policy.drive_roots r order by r.label collate "C", r.id`,
  );
}

// A root's folder id or word, for `pi drive list --show` and `pi drive add`'s answer.
export async function rootValue({ query, keys }: Tx, id: string): Promise<string | null> {
  const [row] = await query<{ root_enc: Sealed }>("select root_enc from policy.drive_roots where id = $1", [id]);
  return row === undefined ? null : opened(keys, "own", rootAt(id), row.root_enc);
}

export async function setRootMode({ query, keys }: Tx, id: string, mode: RootMode): Promise<{ documents: number }> {
  await syncLock(query);
  await tryExtractLock({ query, keys });
  const [root] = await query<{ id: string }>("update policy.drive_roots set mode = $2 where id = $1 returning id", [
    id,
    mode,
  ]);
  if (root === undefined) throw new AdminError("not_found");
  const marked = await query<{ id: string }>(
    "update knowledge.documents set reference = $2 where root_id = $1 returning id",
    [id, mode === "reference"],
  );
  await documentsWaitAgain({ query, keys }, id);
  return { documents: marked.length };
}

// A document under it may still be in scope under an enclosing root, so the label's Drive lists
// again and stores it again.
export async function removeRoot({ query, keys }: Tx, id: string): Promise<{ removed: number }> {
  await syncLock(query);
  const [root] = await query<{ id: string; label: string }>(
    "select id, label from policy.drive_roots where id = $1 for update",
    [id],
  );
  if (root === undefined) throw new AdminError("not_found");
  const items = await query<{ account_id: string; compartment: string; fp: string }>(
    `select d.source_account_id as account_id, d.compartments[1] as compartment, e.source_item_fp as fp
     from knowledge.documents d join vault.evidence_items e on e.id = d.evidence_id where d.root_id = $1 order by d.id`,
    [id],
  );
  let removed = 0;
  for (const item of items)
    if (
      (
        await removeSourceItem(
          { query, keys },
          { id: item.account_id, compartment: item.compartment },
          item.fp,
          // The owner removed the folder that held it.
          "dropped",
        )
      ).removed
    )
      removed += 1;
  await query("delete from policy.drive_roots where id = $1", [id]);
  await query(RESET_CURSOR, [root.label]);
  return { removed };
}
