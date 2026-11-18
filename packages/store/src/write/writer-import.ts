import { IMPORT_LABEL_PREFIX } from "@intelligence/contracts/personal";
import { isProfileKey } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import { makesPerson, markOf } from "../core/account-kinds.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { IDENTITY_AUTHOR, LATEST_CARD_EVENT, OWNER_ACCOUNT_FPS } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { suppressedFps } from "../identity/identity-port.ts";
import { CAP } from "../identity/identity-sweep.ts";

// Contact import: what importing a file would do, read as pi_writer in one read-only transaction,
// with nothing written and nothing opened. The import itself reads it first too, for its guards.
// Identity is reported as the sweep's room: the cards open now and how many more its cap allows;
// the sweep finds its own candidates.

// One item the import would hand the writer: its id and tag, and its addresses.
export type ImportPreviewItem = { sourceItemId: string; revisionTag: string; addresses: string[] };

export type ImportPreview = {
  // The contacts the import holds now.
  stored: number;
  // Against them: stored for the first time, a new revision, the same, stored but no longer in the
  // file; `erased`, an item the owner erased; `suppressed`, one that lists an address an erasure
  // suppressed. The writer answers the first of the two before the second, and so does this.
  items: { new: number; changed: number; unchanged: number; removed: number; erased: number; suppressed: number };
  // Items whose address is a person's already, and the people its addresses would make.
  people: { matched: number; created: number };
  // For each item, in order, how many people its addresses name: the subjects of its claims.
  subjects: number[];
  // The identity cards undecided now, the sweep's cap, and the room it leaves.
  identity: { open: number; cap: number; room: number };
};

export async function previewImport(tx: Tx, name: string, items: readonly ImportPreviewItem[]): Promise<ImportPreview> {
  await tx.query("set transaction read only");
  const fp = (kind: "address" | "source_id" | "revision_tag", value: string): string =>
    fingerprint(tx.keys, kind, value);
  const [account] = await tx.query<{ id: string }>(
    "select id from vault.source_accounts where label = $1 and connector = 'contacts_import'",
    [`${IMPORT_LABEL_PREFIX}${name}`],
  );
  const stored = new Map(
    account === undefined
      ? []
      : (
          await tx.query<{ source_item_fp: string; revision_tag_fp: string }>(
            `select distinct on (source_item_fp) source_item_fp, revision_tag_fp from vault.evidence_items
             where source_account_id = $1 order by source_item_fp, revision desc`,
            [account.id],
          )
        ).map((row) => [row.source_item_fp, row.revision_tag_fp]),
  );
  const itemFps = items.map((item) => fp("source_id", item.sourceItemId));
  const erased = new Set(
    account === undefined
      ? []
      : (
          await tx.query<{ source_item_fp: string }>(
            "select source_item_fp from knowledge.removed_evidence where source_account_id = $1 and source_item_fp = any($2)",
            [account.id, itemFps],
          )
        ).map((row) => row.source_item_fp),
  );
  const addresses = [...new Set(items.flatMap((item) => item.addresses))];
  const addressFps = addresses.map((one) => fp("address", one));
  const owner = new Set((await tx.query<{ value_fp: string }>(OWNER_ACCOUNT_FPS)).map((row) => row.value_fp));
  const holders = new Map(
    (
      await tx.query<{ value_fp: string; entity_id: string }>(
        `select distinct on (a.value_fp) a.value_fp, a.entity_id from knowledge.accounts a
         join knowledge.entities e on e.id = a.entity_id and e.kind = 'person' where a.value_fp = any($1) order by a.value_fp, a.id`,
        [addressFps],
      )
    ).map((row) => [row.value_fp, row.entity_id]),
  );
  const suppressed = await suppressedFps(tx, addressFps);
  // Whether an address would name a person: not the owner's, not suppressed, and of a person's kind.
  const person = new Map<string, boolean>();
  for (const [i, address] of addresses.entries()) {
    const one = addressFps[i] ?? "";
    person.set(
      address,
      !owner.has(one) &&
        !suppressed.has(one) &&
        (isProfileKey(address) || makesPerson(addressKind(address, await markOf(tx.query, one)))),
    );
  }

  const counts: ImportPreview["items"] = { new: 0, changed: 0, unchanged: 0, removed: 0, erased: 0, suppressed: 0 };
  const people = { matched: 0, created: 0 };
  const subjects: number[] = [];
  for (const [i, item] of items.entries()) {
    const itemFp = itemFps[i] ?? "";
    const skip = erased.has(itemFp)
      ? "erased"
      : item.addresses.some((one) => suppressed.has(fp("address", one)))
        ? "suppressed"
        : undefined;
    if (skip !== undefined) {
      counts[skip] += 1;
      subjects.push(0);
      continue;
    }
    const tag = stored.get(itemFp);
    if (tag === undefined) counts.new += 1;
    else if (tag === fp("revision_tag", item.revisionTag)) counts.unchanged += 1;
    else counts.changed += 1;
    // Each identifier names its holder or a new person, as deriveContact resolves them.
    const entities = new Set(
      item.addresses
        .filter((one) => person.get(one) === true)
        .map((one) => holders.get(fp("address", one)) ?? `new:${one}`),
    );
    subjects.push(entities.size);
    if ([...entities].some((one) => !one.startsWith("new:"))) people.matched += 1;
    people.created += [...entities].filter((one) => one.startsWith("new:")).length;
  }
  const listed = new Set(itemFps);
  counts.removed = [...stored.keys()].filter((one) => !listed.has(one)).length;

  const [cards] = await tx.query<{ n: number }>(
    `select count(*)::int as n from ledger.cards c where c.created_by = $1
       and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')`,
    [IDENTITY_AUTHOR],
  );
  const open = cards?.n ?? 0;
  return {
    stored: stored.size,
    items: counts,
    people,
    subjects,
    identity: { open, cap: CAP, room: Math.max(0, CAP - open) },
  };
}
