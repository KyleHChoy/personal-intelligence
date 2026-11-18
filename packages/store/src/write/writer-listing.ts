// One page of a listing in one transaction: unreadable contacts removed, the page's listed rows,
// the reconciliation of what a finished listing left out, what left the owner's scope removed, and
// then the cursor stored.

import { isCoded } from "@intelligence/contracts/personal";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { storeCursor, storedAccount } from "./writer-accounts.ts";
import { isOccurrenceId } from "./writer-derived.ts";
import { removeSourceItem } from "./writer-item-removal.ts";
import type { ListingDone, ListingPage, SourceAccountRow } from "./writer-types.ts";

// One page of a listing, in one transaction.
export const finishListing = (
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  keys: Keys,
  given: SourceAccountRow,
  page: ListingPage,
): Promise<ListingDone> =>
  transaction(async (tx) => {
    const account = await storedAccount(tx, given);
    const { listing } = page;
    let removed = 0;
    let recordsRemoved = 0;
    let reconciled = false;
    // `unreadable` counts those, and they are in `removed` too; it is returned for a contacts
    // account only.
    let unreadable = 0;
    if (account.connector === "google_contacts") {
      for (const id of page.skippedIds) {
        const gone = await removeSourceItem(tx, account, fingerprint(keys, "source_id", id), "replaced");
        if (gone.removed) unreadable += 1;
        recordsRemoved += gone.recordsRemoved;
      }
      removed += unreadable;
    }
    if (listing !== undefined) {
      if (listing.first) await tx.query("delete from vault.listed_items where account_id = $1", [account.id]);
      // One row per id the page named: handed over, named by id alone, or skipped. A skipped
      // id counts as listed, so it is left as it is, stored or not, and never stops the
      // listing from reconciling everything else.
      const listed = new Set([...page.listedIds, ...page.skippedIds].map((id) => fingerprint(keys, "source_id", id)));
      // Each under its stored item's label, when it is stored: a restricted item's row is
      // never under the account's compartment alone.
      await tx.query(
        `insert into vault.listed_items (account_id, source_item_fp, compartments)
         select $1, one.fp, coalesce((select e.compartments from vault.evidence_items e
                                      where e.source_account_id = $1 and e.source_item_fp = one.fp order by e.revision desc limit 1), $2)
         from unnest($3::text[]) as one (fp)
         on conflict (account_id, source_item_fp) do nothing`,
        [account.id, [account.compartment], [...listed]],
      );

      if (listing.ended !== undefined) {
        if (listing.ended === "complete") {
          // A calendar listing covers only what ends after the bound it listed from, or has
          // no known end, and starts before its upper bound, or has no known start. A mail
          // listing covers the whole mailbox. An all-day event's times are stored as midnight
          // UTC of its dates, while the source reads the bounds in the calendar's own zone,
          // up to fourteen hours away: it is kept unless it ends more than fourteen hours
          // after the lower bound and starts more than fourteen hours before the upper one.
          const calendar = account.connector === "google_calendar";
          const [since, until] = calendar ? [listing.since ?? null, listing.until ?? null] : [null, null];
          // Past the upper bound, an occurrence of a recurring series goes and a one-off event
          // stays. A row stored before `recurring` was kept has none: it is read once from the
          // stored item's source id, and a row whose item does not open stays unknown and kept.
          // Only a row past the upper bound is read, the one place its kind decides anything.
          if (until !== null) {
            const unknown = await tx.query<{
              event_id: string;
              evidence_id: string;
              item_enc: Sealed;
              compartments: string[];
            }>(
              `select d.event_id, e.id as evidence_id, e.item_enc, e.compartments from knowledge.event_details d
               join knowledge.events v on v.id = d.event_id
               join vault.evidence_items e on e.id = v.evidence_id
               where d.account_id = $1 and d.recurring is null
                 and d.starts_at >= $2::timestamptz - case when d.all_day then interval '14 hours' else interval '0' end
                 and not exists (select 1 from vault.listed_items l where l.account_id = d.account_id and l.source_item_fp = d.source_event_fp)`,
              [account.id, until],
            );
            for (const row of unknown) {
              let sourceItemId: unknown;
              try {
                sourceItemId = (
                  JSON.parse(
                    open(
                      keys,
                      { id: row.evidence_id, compartments: row.compartments, item_enc: row.item_enc },
                      "vault.evidence_items.item_enc",
                      "throw",
                    ),
                  ) as { sourceItemId?: unknown }
                ).sourceItemId;
              } catch (error) {
                // Only an item that does not open is left unknown; any other failure fails the page.
                if (isCoded(error, "open_failed")) continue;
                throw error;
              }
              if (typeof sourceItemId === "string")
                await tx.query("update knowledge.event_details set recurring = $2 where event_id = $1", [
                  row.event_id,
                  isOccurrenceId(sourceItemId),
                ]);
            }
          }
          const unlisted = await tx.query<{ fp: string }>(
            `select distinct e.source_item_fp as fp from vault.evidence_items e
             where e.source_account_id = $1
               and not exists (select 1 from vault.listed_items l where l.account_id = e.source_account_id and l.source_item_fp = e.source_item_fp)
               and not exists (
                 select 1 from knowledge.event_details d
                 where d.account_id = e.source_account_id and d.source_event_fp = e.source_item_fp
                   and (d.ends_at <= $2::timestamptz + case when d.all_day then interval '14 hours' else interval '0' end
                     or (d.starts_at >= $3::timestamptz - case when d.all_day then interval '14 hours' else interval '0' end and d.recurring is not true)))`,
            [account.id, since, until],
          );
          for (const { fp } of unlisted) {
            const gone = await removeSourceItem(tx, account, fp, "deleted");
            if (gone.removed) removed += 1;
            recordsRemoved += gone.recordsRemoved;
          }
          reconciled = true;
        }
        await tx.query("delete from vault.listed_items where account_id = $1", [account.id]);
      }
    }
    // Its source still has it: dropped, not deleted.
    for (const id of page.leftIds ?? []) {
      const gone = await removeSourceItem(tx, account, fingerprint(keys, "source_id", id), "dropped");
      if (gone.removed) removed += 1;
      recordsRemoved += gone.recordsRemoved;
    }
    await storeCursor(tx, account, page.next);
    return {
      removed,
      reconciled,
      recordsRemoved,
      ...(account.connector === "google_contacts" ? { unreadable } : {}),
    };
  });
