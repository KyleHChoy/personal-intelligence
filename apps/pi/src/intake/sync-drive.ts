import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { ItemFacts, PersonalSource } from "@intelligence/personal-core/items";
import type { GoogleAccountRow, SyncCounts, Writer } from "@intelligence/personal-store";
import { sourceAccountOf } from "@intelligence/personal-store";
import { codeOf, refusal } from "../env.ts";

import { derive, PAGE_LIMIT, REFUSED_FOR_GOOD, record, type SyncKindOfRun } from "./sync-pages.ts";

export const DRIVE_PAGES_PER_RUN = 8;

// A Drive token Google no longer takes, or one of other scopes, asks
// for a Drive consent.
export function driveOutcomeOf(error: unknown): string {
  const code = codeOf(error);
  if (code === "oauth_failed" || code === "scope_mismatch") return "reconnect_drive";
  return code === "control_unavailable" ? "unavailable" : code;
}

// One label's Drive, at most `pagesPerRun` pages. Before each page the database's size is read:
// below the ceiling the page runs as a mail page does, with what left scope removed; at or over it,
// the removals pass instead, which applies the feed's deletions and trashed files, fetches nothing
// and stores no new cursor.
export async function syncDrive(
  writer: Writer,
  log: PersonalLogger,
  source: PersonalSource,
  account: GoogleAccountRow,
  options: {
    address: string;
    roots: string[];
    reset: boolean;
    at: string;
    ceilingBytes: number;
    pagesPerRun: number;
    kind: SyncKindOfRun;
  },
): Promise<{ outcome: string; recorded: boolean; refused: number }> {
  const { at } = options;
  let skipped = 0;
  let refused = 0;
  // For the coverage report: every item, skipped id and deletion of the full passes' pages.
  let decided = 0;
  const notStored = { left: 0, removed: 0 };
  const synced = { stored: 0, unreadable: 0, removed: 0, held: 0, records_removed: 0 };
  let outcome = "ok";
  try {
    // The Drive token is the label's own address's, before anything
    // is listed.
    const about = await (source.driveProfile as () => Promise<{ address: string }>)();
    if (about.address.trim().toLowerCase() !== options.address.trim().toLowerCase()) throw refusal("account_mismatch");
    const connector = source.connector("google_docs", account.id, {
      roots: options.roots,
      stored: (id, tag) => writer.hasRevision(account, id, tag),
    });
    if (options.reset) await writer.setCursor(account, connector.resetCursor());
    for (let pages = 0; pages < options.pagesPerRun; pages += 1) {
      if ((await writer.databaseBytes()) >= options.ceilingBytes) {
        outcome = "storage_ceiling";
        const removals = source.connector("google_docs", account.id, { roots: options.roots, removalsOnly: true });
        const stored = await writer.cursor(account);
        let from = stored;
        for (; pages < options.pagesPerRun && stored !== null; pages += 1) {
          const page = await removals.listChanges(sourceAccountOf(account), from, PAGE_LIMIT);
          for (const deletion of page.deletions)
            synced.records_removed += (await writer.applyDeletion(account, deletion)).recordsRemoved;
          // The cursor stored is the one the pass began at: the full pass resumes from it.
          const { removed, recordsRemoved } = await writer.finishPage(account, {
            listedIds: [],
            skippedIds: [],
            leftIds: page.left ?? [],
            next: stored,
          });
          synced.removed += removed;
          synced.records_removed += recordsRemoved;
          from = page.next;
          if (!page.more) break;
        }
        break;
      }
      const page = await connector.listChanges(sourceAccountOf(account), await writer.cursor(account), PAGE_LIMIT);
      decided += page.items.length + page.skipped.length + page.deletions.length;
      const skippedIds = page.skipped.map((one) => one.sourceItemId);
      for (const { reason } of page.skipped) {
        log.warn({ event: "item_skipped", code: reason, ids: { account: account.id } });
        if (reason === "unsupported") refused += 1;
      }
      const leftIds = [...(page.left ?? [])];
      for (const raw of page.items) {
        try {
          let facts: ItemFacts | undefined;
          const answer = await writer.ingestItem(account, raw, async (ctx) => (facts = await derive(raw, ctx)));
          if (answer === "removed") notStored.removed += 1;
          // Its root went since the connector was built: it left
          // scope.
          if (answer === "left") leftIds.push(raw.sourceItemId);
          if (answer === "unread") {
            skipped += 1;
            log.info({ event: "item_unread", ids: { account: account.id } });
          }
          if (answer === "stored" && facts?.kind === "document") {
            synced.stored += 1;
            if (facts.document.text === null) synced.unreadable += 1;
            if (facts.document.held) synced.held += 1;
          }
        } catch (error) {
          const code = codeOf(error);
          if (!REFUSED_FOR_GOOD.has(code)) throw error;
          refused += 1;
          skippedIds.push(raw.sourceItemId);
          log.warn({ event: "item_skipped", code, ids: { account: account.id } });
        }
      }
      for (const deletion of page.deletions)
        synced.records_removed += (await writer.applyDeletion(account, deletion)).recordsRemoved;
      notStored.left += leftIds.length;
      skipped += skippedIds.length;
      const { removed, recordsRemoved } = await writer.finishPage(account, {
        ...(page.listing === undefined ? {} : { listing: page.listing }),
        listedIds: [...page.items.map((raw) => raw.sourceItemId), ...(page.listed ?? [])],
        skippedIds,
        leftIds,
        next: page.next,
      });
      synced.removed += removed;
      synced.records_removed += recordsRemoved;
      if (!page.more) break;
    }
  } catch (error) {
    outcome = driveOutcomeOf(error);
  }
  if (notStored.left + notStored.removed > 0) {
    const counts = {
      ...(notStored.left > 0 ? { left: notStored.left } : {}),
      ...(notStored.removed > 0 ? { removed: notStored.removed } : {}),
    };
    log.info({ event: "items_not_stored", ids: { account: account.id }, counts });
  }
  log.info({ event: "account_synced", ids: { account: account.id }, counts: synced });
  const counts: SyncCounts = {
    kind: options.kind,
    stored: synced.stored,
    held: synced.held,
    junk: 0,
    decided,
    removed: synced.removed,
  };
  return { ...(await record(writer, account, outcome, at, skipped, counts)), refused };
}
