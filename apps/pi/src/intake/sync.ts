import type { RawItem } from "@intelligence/contracts";
import { type PersonalLogger, RESTRICTED_LOCKED, type RestrictedCategory } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { ItemFacts, PersonalSource } from "@intelligence/personal-core/items";
import { contactKept, isConditional, isDraft, isJunk, ownerSent } from "@intelligence/personal-core/items";
import type { GoogleAccountRow, SyncCounts, Writer } from "@intelligence/personal-store";
import { DRIVE_CEILING_BYTES, googleSecretName, sourceAccountOf } from "@intelligence/personal-store";
import { codeOf } from "../env.ts";

import { DRIVE_PAGES_PER_RUN, driveOutcomeOf, syncDrive } from "./sync-drive.ts";
import { derive, noCounts, outcomeOf, PAGE_LIMIT, REFUSED_FOR_GOOD, record, type SyncKindOfRun } from "./sync-pages.ts";
// Personal ingest: each connected label's mail, then its calendar, then its
// contacts when the label's contacts token exists, page by page into
// the writer. A cursor moves only when its whole page is committed, so a run that is killed
// anywhere and run again ends with the rows of one that was not.

export type SyncKind = "gmail" | "calendar" | "contacts" | "drive";
export type SyncOutcome = { label: string; kind: SyncKind; outcome: string };
// `refused` is how many items were left out for a fault this run, in every account: those the
// writer refused for good, and those whose shape a connector refused.
export type SyncResult = { outcomes: SyncOutcome[]; rederive: "none" | "done" | "failed"; refused: number };

const KINDS = [
  { kind: "gmail", connector: "google_mail" },
  { kind: "calendar", connector: "google_calendar" },
  { kind: "contacts", connector: "google_contacts" },
] as const;

// A label reads contacts exactly when its contacts token exists. One
// without it makes no People call and records no outcome, whether it was never connected or the
// owner disconnected it: its contacts account, if any, is off, and its stored contacts stay until
// `pi contacts remove`.
export const kindsOf = (contacts: boolean) => KINDS.filter(({ kind }) => contacts || kind !== "contacts");
export const contactsOn = (secrets: string[], label: string): boolean =>
  secrets.includes(googleSecretName(label, "contacts_refresh_token"));

// One account's pages, until a page with nothing on it, no listing mark and no page after it
// is finished.
//
// How one item of a page is decided, in this order:
//   1. a draft is dropped, never stored;
//   2. junk is removed, as a message deleted at the source is: one stored before
//      it became junk goes with everything derived from it;
//   3. a conditional message is asked about with `ownerWrote`, and kept when the
//      owner has written to its sender or posted in its thread, else removed as junk is;
//   4. anything else is ingested.
// A page's items that the owner sent come first, so a message whose keeping depends on sent
// mail of the same page is decided after it. Junk and a conditional message left out are no
// fault and no skipped item, and still count as listed.
//
// A contact is decided by one rule of its own: one that
// `contactKept` does not keep, the owner's own or one with no address, is removed as junk is. No
// mail rule reads a contact.
async function syncAccount(
  writer: Writer,
  log: PersonalLogger,
  source: PersonalSource,
  account: GoogleAccountRow,
  {
    since,
    reset,
    at,
    restrictedOn,
    kind,
  }: { since: string; reset: boolean; at: string; restrictedOn: readonly RestrictedCategory[]; kind: SyncKindOfRun },
): Promise<{ outcome: string; recorded: boolean; refused: number }> {
  let skipped = 0;
  let refused = 0;
  // Items the screen restricted while the restricted keys were locked: not stored, waiting on an unlock.
  let waiting = 0;
  // For the coverage report: what history listed as added, summed over the pages that
  // report it (none for a calendar or contacts), and every item, skipped id and deletion the run
  // disposed of, however: stored, a repeat, held, junk, a draft, the category rule, erased,
  // suppressed, skipped or already gone.
  let added: number | undefined;
  let decided = 0;
  // What this run left out: junk, and conditional messages the category rule did not keep. It is no
  // fault and no skipped item: it has one line of its own. An item the owner erased, and mail from
  // an address an erasure suppressed, are not stored either; each is
  // counted under its name when there is one.
  const left = { junk: 0, category: 0 };
  const erased = { removed: 0, suppressed: 0 };
  // What the account's account_synced line counts: items stored, those stored unreadable or held,
  // what the reconciles removed, and the agent records removed with what this run deleted
  //.
  const synced = { stored: 0, unreadable: 0, removed: 0, held: 0, records_removed: 0 };
  // The contacts this run did not store, and those that carry a
  // refused address, over the items the connector handed over.
  const contacts = account.connector === "google_contacts";
  const notStored = { no_address: 0, own_contact: 0, suppressed: 0, removed: 0, unreadable: 0, bad_address: 0 };
  let outcome = "ok";
  try {
    const owner = contacts ? await writer.ownerAddresses() : [];
    const connector = source.connector(account.connector, account.id, { since });
    // A reset is stored, so a run that fails after it is still a reset on the next run: a mail
    // listing after one runs to the mailbox's end, whatever window the run that resumes it has.
    if (reset) await writer.setCursor(account, connector.resetCursor());
    while (true) {
      const page = await connector.listChanges(sourceAccountOf(account), await writer.cursor(account), PAGE_LIMIT);
      if (page.added !== undefined) added = (added ?? 0) + page.added;
      decided += page.skipped.length + page.deletions.length;
      // The items of this page that are not stored. Each is counted and has its log line, with
      // a code and the account and never the item's own id, which names a message.
      const skippedIds = page.skipped.map((one) => one.sourceItemId);
      for (const { reason } of page.skipped) {
        log.warn({ event: "item_skipped", code: reason, ids: { account: account.id } });
        // An item whose shape the connector refused is a fault, counted as one the writer
        // refused is. One the source will not hand over is the mailbox's own state.
        if (reason === "unsupported") refused += 1;
      }
      // A deletion of an item that is not stored does nothing.
      const leaveOut = async (raw: RawItem) => {
        synced.records_removed += (
          await writer.applyDeletion(account, {
            sourceAccount: account.id,
            sourceItemId: raw.sourceItemId,
            deletedAt: at,
          })
        ).recordsRemoved;
      };
      // Whether an item is left out by its kind's rules (the list above), with its count.
      const mailLeftOut = async (raw: RawItem): Promise<boolean> => {
        if (isDraft(raw)) return true;
        if (isJunk(raw)) {
          left.junk += 1;
          await leaveOut(raw);
          return true;
        }
        if (!isConditional(raw)) return false;
        const wrote = await writer.ownerWrote(account, {
          ...(raw.sender === undefined ? {} : { sender: raw.sender }),
          ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
        });
        if (wrote.sender || wrote.thread) return false;
        left.category += 1;
        await leaveOut(raw);
        return true;
      };
      const contactLeftOut = async (raw: RawItem): Promise<boolean> => {
        if (raw.markers.includes("bad_address")) notStored.bad_address += 1;
        const kept = contactKept(raw, owner);
        if (kept === "keep") return false;
        notStored[kept] += 1;
        await leaveOut(raw);
        return true;
      };
      const items = contacts
        ? page.items
        : [...page.items.filter(ownerSent), ...page.items.filter((one) => !ownerSent(one))];
      for (const raw of items) {
        if (await (contacts ? contactLeftOut : mailLeftOut)(raw)) {
          decided += 1;
          continue;
        }
        try {
          let facts: ItemFacts | undefined;
          // The restricted screen asks about the on categories at ingest, before anything is saved.
          const answer = await writer.ingestItem(
            account,
            raw,
            async (ctx) => (facts = await derive(raw, { ...ctx, restrictedOn })),
          );
          if (answer === "removed" || answer === "suppressed") (contacts ? notStored : erased)[answer] += 1;
          if (answer === "unread") {
            skipped += 1;
            log.info({ event: "item_unread", ids: { account: account.id } });
          }
          if (answer === "stored") {
            synced.stored += 1;
            if (facts?.kind === "email" && facts.message.unreadable) synced.unreadable += 1;
            if (facts?.kind === "email" && facts.message.held) synced.held += 1;
          }
        } catch (error) {
          // One item a retry cannot mend never stops its account: it is skipped as an item
          // the source refused is, and the page goes on. Anything else stops the account.
          const code = codeOf(error);
          if (code === RESTRICTED_LOCKED) waiting += 1;
          else {
            if (!REFUSED_FOR_GOOD.has(code)) throw error;
            refused += 1;
            skippedIds.push(raw.sourceItemId);
            log.warn({ event: "item_skipped", code, ids: { account: account.id } });
          }
        }
        decided += 1;
      }
      // A deletion of an item that is not stored does nothing.
      for (const deletion of page.deletions)
        synced.records_removed += (await writer.applyDeletion(account, deletion)).recordsRemoved;
      skipped += skippedIds.length;
      // A skipped item counts as listed and stops no reconcile: the listing
      // removes what the source no longer has, and leaves the skipped id as it is.
      const {
        removed,
        reconciled,
        recordsRemoved,
        unreadable = 0,
      } = await writer.finishPage(account, {
        ...(page.listing === undefined ? {} : { listing: page.listing }),
        // The page's items, and the ids it named without an item: the older pass of a
        // reconciling Gmail listing, which keeps what is older than the window stored.
        listedIds: [...page.items.map((raw) => raw.sourceItemId), ...(page.listed ?? [])],
        skippedIds,
        next: page.next,
      });
      synced.removed += removed;
      synced.records_removed += recordsRemoved;
      notStored.unreadable += unreadable;
      // Only a first listing, which ends at its window, reconciles nothing.
      if (page.listing?.ended !== undefined && !reconciled)
        log.info({ event: "reconcile_skipped", ids: { account: account.id } });
      // An empty page is not the end while the source says there is another: a page of changes
      // that hand nothing over can come before one that does.
      const empty = page.items.length + page.deletions.length + page.skipped.length === 0;
      if (empty && page.listing === undefined && !page.more) break;
    }
  } catch (error) {
    // The cursor stays where its last finished page left it.
    outcome = outcomeOf(error);
  }
  // Lines for the account, with counts and never an id: what it left out, when it left any out,
  // and what it stored and removed, also when its sync failed.
  if (left.junk + left.category + erased.removed + erased.suppressed > 0) {
    const counts = {
      ...left,
      ...(erased.removed > 0 ? { removed: erased.removed } : {}),
      ...(erased.suppressed > 0 ? { suppressed: erased.suppressed } : {}),
    };
    log.info({ event: "items_not_stored", ids: { account: account.id }, counts });
  }
  if (contacts) log.info({ event: "contacts_not_stored", ids: { account: account.id }, counts: notStored });
  if (waiting > 0)
    log.warn({ event: "items_waiting_unlock", ids: { account: account.id }, counts: { items: waiting } });
  log.info({ event: "account_synced", ids: { account: account.id }, counts: synced });
  const counts: SyncCounts = {
    kind,
    ...(added === undefined ? {} : { added }),
    stored: synced.stored,
    held: synced.held,
    junk: left.junk,
    decided,
    removed: synced.removed,
  };
  return { ...(await record(writer, account, outcome, at, skipped, counts)), refused };
}

export const DEFAULT_BACKFILL_DAYS = 90;

export async function runSync({
  writer,
  sources,
  log,
  now,
  backfillDays = DEFAULT_BACKFILL_DAYS,
  reset = [],
  contacts,
  drive = {},
  restrictedOn = [],
  fast = false,
  sendAs = false,
}: {
  writer: Writer;
  sources: PersonalSource[];
  log: PersonalLogger;
  now: Date;
  backfillDays?: number;
  reset?: SyncKind[];
  // The labels whose contacts this run reads. `pi sync` decides it once, from the secrets it
  // built its sources from, so a token stored meanwhile changes nothing until the next run.
  // Unset, it is read from the secrets here.
  contacts?: readonly string[];
  // The storage ceiling and a label's Drive pages a run.
  drive?: { ceilingBytes?: number; pagesPerRun?: number };
  // The on restricted categories, which `pi sync` checks against the key files first
  //. None by default: every category ships off.
  restrictedOn?: readonly RestrictedCategory[];
  // A fast run syncs each label's mail and calendar and nothing else; the caller passes no contacts
  // labels with it. `sendAs` reads each label's send-as list, which only the owner's
  // `pi sync --send-as` asks for.
  fast?: boolean;
  sendAs?: boolean;
}): Promise<SyncResult> {
  const at = now.toISOString();
  const since = new Date(now.getTime() - backfillDays * DAY_MS).toISOString();
  const runKind: SyncKindOfRun = fast ? "fast" : "full";
  const outcomes: SyncOutcome[] = [];
  let refused = 0;
  const secrets = contacts === undefined ? await writer.listSecretNames("google/") : [];
  const reading = contacts ?? sources.map((one) => one.label).filter((label) => contactsOn(secrets, label));

  // The address each label's profile gave, for its Drive's account check.
  const addresses = new Map<string, string>();
  for (const source of sources) {
    const { label, compartment } = source;
    const contacts = reading.includes(label);
    const accounts: { kind: SyncKind; account: GoogleAccountRow }[] = [];
    try {
      const { address } = await source.profile();
      addresses.set(label, address);
      for (const { kind, connector } of kindsOf(contacts))
        accounts.push({ kind, account: await writer.ensureSourceAccount(label, connector, compartment, address) });
      // The label's send-as list, read only when the owner asks with
      // `pi sync --send-as`: it changes rarely, and the account's own address is the owner's from
      // its first sync. The re-derive at the end makes a person who held the address the owner.
      // Only the primary address is added; a verified alias may be a group's or a role mailbox
      // (team@, support@) whose mail is other people's, so it is only counted, and the owner adds
      // their own with `pi owner add-address`. The primary is the owner's own by definition, so it is added
      // even when it looks like a role address. The others are kept, sealed, for
      // `pi owner aliases`. An answer that cannot be read leaves the label syncing, and the kept
      // list as it was.
      const mail = accounts.find((one) => one.account.connector === "google_mail")?.account;
      if (sendAs && source.sendAs !== undefined && mail !== undefined) {
        const listed = await source.sendAs().catch((error: unknown) => {
          log.warn({ event: "send_as_unread", ids: { account: mail.id }, code: outcomeOf(error) });
          return null;
        });
        if (listed !== null) {
          const primary = listed.filter((one) => one.primary).map((one) => one.address);
          if (primary.length > 0) await writer.addOwnerAddresses(mail, primary);
          const others = listed.filter((one) => !one.primary).map((one) => one.address);
          await writer.recordSendAs(mail, others);
          if (others.length > 0)
            log.info({ event: "send_as_aliases", ids: { account: mail.id }, counts: { not_added: others.length } });
        }
      }
    } catch (error) {
      // The label fails whole: the code goes on the accounts that exist and are on, their
      // cursors stay, and the next label still syncs.
      const outcome = outcomeOf(error);
      for (const { kind } of kindsOf(contacts)) outcomes.push({ label, kind, outcome });
      // Accounts that cannot be read, or an outcome that cannot be recorded, end the run.
      const existing = await writer.listSourceAccounts().then(
        (all) =>
          all.filter((account) => account.label === label && (contacts || account.connector !== "google_contacts")),
        () => null,
      );
      if (existing === null) return { outcomes, rederive: "none", refused };
      if (existing.length === 0) log.warn({ event: "label_skipped", code: outcome });
      const recorded = [];
      for (const account of existing)
        recorded.push((await record(writer, account, outcome, at, 0, noCounts(runKind))).recorded);
      if (recorded.includes(false)) return { outcomes, rederive: "none", refused };
      continue;
    }

    for (const { kind, account } of accounts) {
      const done = await syncAccount(writer, log, source, account, {
        since,
        reset: reset.includes(kind),
        at,
        restrictedOn,
        kind: runKind,
      });
      outcomes.push({ label, kind, outcome: done.outcome });
      refused += done.refused;
      if (!done.recorded) return { outcomes, rederive: "none", refused };
    }
  }

  // Only then each label's Drive, in label order, for a label with a
  // Drive grant and a root. A Drive failure is its own account's outcome and changes nothing of
  // mail or calendar.
  for (const source of fast ? [] : sources) {
    const address = addresses.get(source.label);
    if (source.driveProfile === undefined || address === undefined) continue;
    let account: GoogleAccountRow;
    let roots: { root: string }[];
    try {
      roots = await writer.listRoots(source.label);
      if (roots.length === 0) continue;
      account = await writer.ensureSourceAccount(source.label, "google_docs", source.compartment, address);
    } catch (error) {
      outcomes.push({ label: source.label, kind: "drive", outcome: driveOutcomeOf(error) });
      continue;
    }
    const done = await syncDrive(writer, log, source, account, {
      address,
      roots: roots.map((one) => one.root),
      reset: reset.includes("drive"),
      at,
      ceilingBytes: drive.ceilingBytes ?? DRIVE_CEILING_BYTES,
      pagesPerRun: drive.pagesPerRun ?? DRIVE_PAGES_PER_RUN,
      kind: runKind,
    });
    outcomes.push({ label: source.label, kind: "drive", outcome: done.outcome });
    refused += done.refused;
    if (!done.recorded) return { outcomes, rederive: "none", refused };
  }

  // Once, after every label: an owner address learned this run may have been a person's.
  let rederive: SyncResult["rederive"] = "none";
  try {
    const { rederived, items, coarser } = await writer.rederiveIfNeeded(derive);
    if (rederived) {
      rederive = "done";
      log.info({ event: "rederived", counts: { items } });
    }
    // Organization names a coarser fold would have widened, kept on their old keys, and domain
    // ignores narrowed to their addresses instead, each with a card; `pi org refold --dry-run`
    // counts them.
    if (coarser > 0) log.warn({ event: "rekey_coarser", counts: { kept: coarser } });
    // A claim stored before names were filed gets its name row here, and what names the owner's
    // re-derive filed are bound: only the writer binds a name to an organization. A run with none to
    // file costs one statement.
    const named = await writer.fileContactOrgNames({ dryRun: false });
    if (named.filed > 0)
      log.info({ event: "contact_names_filed", counts: { filed: named.filed, skipped: named.skipped } });
  } catch (error) {
    rederive = "failed";
    log.error({ event: "rederive_failed", code: outcomeOf(error) });
  }
  return { outcomes, rederive, refused };
}
