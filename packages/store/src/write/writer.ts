import type { ConnectorCursor, RawItem, SourceAccount, SourceDeletion, Timestamp } from "@intelligence/contracts";
import {
  CodedError,
  IMPORT_LABEL_PREFIX,
  type PersonalLogger,
  type RestrictedCategory,
  WORK_CATCH_UP,
} from "@intelligence/contracts/personal";
import { normalizeAddress } from "@intelligence/personal-core";
import type { ItemContext, ItemFacts } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import { createDb } from "../core/job-db.ts";
import { erasureLevel } from "../core/journal.ts";
import type { Keys } from "../core/keys.ts";
import { SYNC_SESSION } from "../core/locks.ts";
import { lockedSession } from "../core/session-lock.ts";
import type { Tx } from "../core/tx.ts";
import { addOwnerAddresses, backfillLocalNames, ownerAddresses } from "../identity/identity-port.ts";
import { type SweepCounts, sweepIdentity } from "../identity/identity-sweep.ts";
import type { RefoldPlan } from "../identity/org-fold.ts";
import { catchUpWork } from "../lens/capture-catch-up.ts";
import { type ContactsTaken, takeContacts } from "../lens/capture-contacts.ts";
import { type CaptureCounts, type DrainOptions, takeCapture } from "../lens/capture-drain.ts";
import { expireCaptures } from "../lens/capture-retention.ts";
import { backfillChatLines, type LinesBackfill } from "../lens/chat-lines.ts";
import { bindNamed, type NamedCounts } from "./named-binding.ts";
import { bindNamedOrgs, type FiledContactNames, fileStoredContactNames, type OrgCounts } from "./named-orgs.ts";
import { bindParticipants, type ParticipantCounts } from "./participant-binding.ts";
import { rederive, refoldOrganizations } from "./rederive.ts";
import {
  cursorOf,
  ensureGoogleAccount,
  ensureOwnAccount,
  listSourceAccounts,
  ownerWrote,
  recordOutcome,
  recordSendAs,
  storeCursor,
  storedAccount,
} from "./writer-accounts.ts";
import { AGENT_PEOPLE_PREFIX, type ConfirmedProposal, confirmedPeople } from "./writer-agent-people.ts";
import { type ContactClaimsVersion, reclaimContacts } from "./writer-contacts.ts";
import { isTimestamp } from "./writer-derived.ts";
import { rootsOf } from "./writer-documents.ts";
import { type ImportPreview, type ImportPreviewItem, previewImport } from "./writer-import.ts";
import { ingestOne, ingestParsed } from "./writer-ingest.ts";
import { applyDeletion } from "./writer-item-removal.ts";
import { finishListing } from "./writer-listing.ts";
import { databaseBytes, hasRevision, listSecretNames, restrictedOn, secretOf } from "./writer-reads.ts";
import { selectRecords, type TakeCounts, takeOne } from "./writer-records.ts";
import { landResearch, type ResearchCounts } from "./writer-research.ts";
import { tiesKnown, tiesListing, tiesOldest } from "./writer-ties.ts";
import type {
  GoogleAccountRow,
  IngestAnswer,
  ListingDone,
  ListingPage,
  SourceAccountRow,
  SyncCounts,
} from "./writer-types.ts";

// The writer, run as pi_writer. Each item commits in one transaction or not at all; there are no
// savepoints and no exception blocks.

// A client's agent source account has connector `agent` and source kind `agent_record`; a web
// account, connector `web` and source kind `web_research`.

export type Writer = {
  ensureSourceAccount(
    label: string,
    connector: "google_mail" | "google_calendar" | "google_docs" | "google_contacts",
    compartment: string,
    address: string,
  ): Promise<GoogleAccountRow>;
  listSourceAccounts(): Promise<SourceAccountRow[]>;
  // Contact import: the import's source account, `import:<name>` under `own`, with connector
  // `contacts_import`, source kind `crm` and no address, made the first time; and what importing
  // these items into it would do, written nowhere.
  ensureImportAccount(name: string): Promise<SourceAccountRow>;
  previewImport(name: string, items: readonly ImportPreviewItem[]): Promise<ImportPreview>;
  // An agent's people source, `agent-people:<client>` under `own`, connector `agent_people`, source
  // kind `crm`, no address, made the first time; and the people the owner confirmed from agents'
  // proposals, by agent.
  ensureAgentPeopleAccount(client: string): Promise<SourceAccountRow>;
  confirmedPeople(): Promise<ConfirmedProposal[]>;
  listSecretNames(prefix: string): Promise<string[]>;
  secret(name: string): Promise<string | null>;
  ownerAddresses(): Promise<string[]>;
  cursor(account: SourceAccountRow): Promise<ConnectorCursor | null>;
  setCursor(account: SourceAccountRow, cursor: ConnectorCursor | null): Promise<void>;
  ownerWrote(
    account: SourceAccountRow,
    about: { sender?: string; threadId?: string; headers?: boolean },
  ): Promise<{ sender: boolean; thread: boolean }>;
  // With the update of the account's last outcome, one vault.sync_outcomes row, its `started_at`
  // the time given. `counts` is a sync's: its kind and what it listed and decided. Without them (an
  // import, an agent's people, a label with no token) the row has no kind, no `added` and zero
  // counts.
  recordOutcome(
    account: SourceAccountRow,
    code: string,
    at: Timestamp,
    skippedItems?: number,
    counts?: SyncCounts,
  ): Promise<void>;
  withSyncLock<T>(fn: () => Promise<T>): Promise<T | "already_running">;
  // Refused with `restricted_keys_mismatch` when the two differ, so sync never starts on a category it cannot
  // seal or one the owner has not named.
  restrictedOn(): Promise<RestrictedCategory[]>;
  // Neither writes anything.
  ingestItem(
    account: SourceAccountRow,
    raw: RawItem,
    derive: (ctx: ItemContext) => Promise<ItemFacts>,
  ): Promise<IngestAnswer>;
  // The ties backfill: which of these source item ids are stored or were erased; the time of the
  // oldest message of the account read by its headers, by direction, from which a run resumes; and
  // whether a listing of the account is under way, whose reconcile would remove what was stored
  // behind it.
  tiesKnown(account: SourceAccountRow, ids: string[]): Promise<Set<string>>;
  tiesOldest(account: SourceAccountRow, direction: "outbound" | "inbound"): Promise<Date | null>;
  tiesListing(account: SourceAccountRow): Promise<boolean>;
  // `recordsRemoved`: the agent records removed with what was deleted.
  applyDeletion(account: SourceAccountRow, deletion: SourceDeletion): Promise<{ recordsRemoved: number }>;
  finishPage(
    account: SourceAccountRow,
    // `leftIds`: source items that left the owner's scope, removed before the cursor is stored.
    page: ListingPage,
  ): Promise<ListingDone>;
  // One query by fingerprints; it opens nothing.
  hasRevision(account: SourceAccountRow, sourceItemId: string, revisionTag?: string): Promise<boolean>;
  // A label's Drive roots, for `pi sync`; and the database's size, for the storage ceiling.
  listRoots(label: string): Promise<{ id: string; root: string; mode: "extract" | "reference" }[]>;
  databaseBytes(): Promise<number>;
  // The intake of agent records into the vault, at most `limit`, each in a transaction of its own.
  takeRecords(limit?: number): Promise<TakeCounts>;
  // Lens's drain: the inbox's capture items into the vault, at most `limit`, each in a transaction
  // of its own, after runSync. `options.boxHost` is the box's own host, which the default never
  // admits; with none, nothing is admitted by default.
  takeCapture(limit?: number, options?: DrainOptions): Promise<CaptureCounts>;
  takeContacts(limit?: number): Promise<ContactsTaken>;
  // Work time: the work_enc of at most `limit` older rows that have none, oldest first, from their
  // vault blobs and current facts; `failed` when any failed.
  catchUpWork(limit?: number): Promise<{ filled: number; failed?: number }>;
  // Capture retention: the capture items the owner's rules have aged out, at most `limit`, each
  // expired in a transaction of its own, after the drain. capture-retention.ts's.
  expireCapture(now: Date, limit?: number): Promise<{ expired: Record<string, number>; failed: number }>;
  rederiveIfNeeded(
    derive: (raw: RawItem, ctx: ItemContext) => Promise<ItemFacts>,
  ): Promise<{ rederived: boolean; items: number; coarser: number }>;
  // The sync's re-derive at its end makes a person who held one the owner. Returns how many it was
  // given that normalize.
  addOwnerAddresses(account: SourceAccountRow, addresses: readonly string[]): Promise<number>;
  // A mail account's verified send-as aliases other than the primary, as the sync just read them,
  // kept sealed under the account's compartment (`vault.source_accounts.send_as_enc`) so `pi owner
  // aliases` can list those not added as owner addresses; none clears it. One that does not
  // normalize is passed over.
  recordSendAs(account: SourceAccountRow, aliases: readonly string[]): Promise<void>;
  // The refold: what it would do, and with `dryRun` false a re-derive that does it, in one
  // transaction. Nothing to fold re-derives nothing. `ignores` counts the domain ignore rulings
  // re-keyed to the new fold, and those no stored account holds a key of, which the new list cannot
  // re-key (ignore-rekey.ts).
  refoldOrganizations(
    derive: (raw: RawItem, ctx: ItemContext) => Promise<ItemFacts>,
    options: { dryRun: boolean },
  ): Promise<{
    plan: RefoldPlan;
    ignores: { rekeyed: number; unmatched: number; coarser: number };
    names: { rekeyed: number; unmatched: number; coarser: number };
    rederived: boolean;
    items: number;
  }>;
  // `pi contacts reclaim`: every stored contact's claims made again at `version`
  // (CONTACT_CLAIMS_VERSION when not given), in one transaction; with `dryRun` nothing is written.
  // Counts only.
  reclaimContacts(options: {
    dryRun: boolean;
    version?: ContactClaimsVersion;
  }): Promise<{ contacts: number; changed: number; removed: number; written: number }>;
  // `pi contacts file-org-names`: the name row of each stored contact claim with none, under its own
  // label, then the binding step for organizations, which spends their own allowance. With `dryRun`
  // nothing is written. Counts only.
  fileContactOrgNames(options: { dryRun: boolean }): Promise<FiledContactNames & OrgCounts>;
  // Throws `journal_refused` for a journal that is refused, and a plain Error for a writer made
  // without the journal's path.
  erasureLevel(): Promise<"level" | "behind">;
  // It raises `same_person` and `shared_address` cards by `system:identity`, at most ten undecided,
  // and writes nothing else.
  proposeIdentity(now: Date): Promise<SweepCounts>;
  // `pi identity local-names-backfill`, called inside `withSyncLock`: each account with no
  // local_name_fps gets them, from its opened address, in one transaction. Only where null, so a
  // second run changes nothing.
  backfillLocalNames(): Promise<{ filled: number }>;
  // Each stored meeting's participants resolved through the identity service, a name bound by code
  // and a person made when nobody matches (participant-binding.ts).
  bindParticipants(now: Date, limit?: number): Promise<ParticipantCounts>;
  bindNamed(now: Date): Promise<NamedCounts>;
  landResearch(now: Date): Promise<ResearchCounts>;
  // `pi capture lines-backfill`, called inside `withSyncLock`: each stored source moment whose
  // facts lack `lines` has them derived again from its stored item and sealed again, its lines_fp
  // nulled. Idempotent; a dry run counts.
  backfillChatLines(options: { dryRun: boolean }): Promise<LinesBackfill>;
  close(): Promise<void>;
};

export function createWriter({
  url,
  keys,
  log,
  journal,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
  journal?: string;
}): Writer {
  const db = createDb(url, log);

  // Once the lock's connection has gone nothing is written: another sync may hold the lock by now,
  // and two listings of one account must not interleave. Every call that writes goes through
  // `write`, which refuses before touching the database.
  const sync = lockedSession(db, SYNC_SESSION);
  const write = sync.write;
  // Passes may outlive the lock: check again at each statement and before a transaction commits.
  const direct: Tx = { query: (text, values) => write(() => db.query(text, values)), keys };
  // The writer's own reads, which a lost lock does not refuse: they select only, so nothing of a
  // sync that lost its lock is written through them.
  const reading: Tx = { query: db.query, keys };
  const transaction = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    write(() =>
      db.transaction(async (query) => {
        const result = await fn({ query: (text, values) => write(() => query(text, values)), keys });
        return write(() => Promise.resolve(result));
      }),
    );

  // One item, in one transaction.
  const ingest = (
    given: SourceAccountRow,
    raw: RawItem,
    derive: (ctx: ItemContext) => Promise<ItemFacts>,
  ): Promise<IngestAnswer> => ingestOne(transaction, keys, given, raw, derive);

  // An `own` account with no address, made the first time.
  const ownAccount = (connector: "contacts_import" | "agent_people", label: string) =>
    write(async () => {
      if (!keys.compartments.has("own")) throw new CodedError("unknown_compartment");
      return transaction((tx) => ensureOwnAccount(tx, connector, label));
    });

  return {
    ensureSourceAccount: (label, connector, compartment, address) =>
      write(async () => {
        if (!keys.compartments.has(compartment)) throw new CodedError("unknown_compartment");
        const owner = normalizeAddress(address);
        if (owner === null) throw new CodedError("invalid_address");
        const addressFp = fingerprint(keys, "address", owner);
        return transaction((tx) => ensureGoogleAccount(tx, { label, connector, compartment, owner, addressFp }));
      }),
    ensureImportAccount: (name) => ownAccount("contacts_import", `${IMPORT_LABEL_PREFIX}${name}`),
    previewImport: (name, items) => db.transaction((query) => previewImport({ query, keys }, name, items)),
    ensureAgentPeopleAccount: (client) => ownAccount("agent_people", `${AGENT_PEOPLE_PREFIX}${client}`),
    confirmedPeople: () => transaction((tx) => confirmedPeople(tx)),
    listSourceAccounts: () => listSourceAccounts(reading),
    listSecretNames: (prefix) => listSecretNames(reading, prefix),
    secret: (name) => secretOf(reading, name),
    ownerAddresses: () => ownerAddresses(reading),
    cursor: (given) => cursorOf(reading, given),
    setCursor: (given, cursor) =>
      write(() => transaction(async (tx) => storeCursor(tx, await storedAccount(tx, given), cursor))),
    ownerWrote: (account, about) => ownerWrote(reading, account, about),

    // The account's sync_outcomes row in the same transaction.
    recordOutcome: (account, code, at, skippedItems = 0, counts) =>
      write(async () => {
        // A time that is none would be quoted back in the server's refusal.
        if (!isTimestamp(at)) throw new CodedError("invalid_argument");
        await transaction((tx) => recordOutcome(tx, account.id, { code, at, skippedItems, counts }));
      }),

    restrictedOn: () => restrictedOn(reading),

    // The lock is the session's: the connection is closed when `fn` ends, and the lock with it.
    // From a lost connection on, this writer writes nothing until `fn` ends (`write` above).
    withSyncLock: sync.withLock,
    ingestItem: (given, item, derive) => write(() => ingestParsed(ingest, given, item, derive)),

    tiesKnown: (account, ids) => tiesKnown(db.query, keys, account, ids),
    tiesOldest: (account, direction) => tiesOldest(db.query, account, direction),
    tiesListing: (account) => tiesListing(db.query, account),

    applyDeletion: (given, deletion) => write(() => transaction((tx) => applyDeletion(tx, given, deletion))),
    finishPage: (given, page) => write(() => finishListing(transaction, keys, given, page)),
    rederiveIfNeeded: (derive) => write(() => transaction((tx) => rederive(tx, derive))),
    addOwnerAddresses: (account, given) =>
      write(() => transaction((tx) => addOwnerAddresses(tx, account.compartment, given))),
    recordSendAs: (account, given) => write(() => recordSendAs(direct, account, given)),
    refoldOrganizations: (derive, { dryRun }) =>
      write(() => transaction((tx) => refoldOrganizations(tx, derive, dryRun))),
    reclaimContacts: (options) => write(() => transaction((tx) => reclaimContacts(tx, options))),

    fileContactOrgNames: ({ dryRun }) =>
      write(async () => {
        const filed = await transaction((tx) => fileStoredContactNames(tx, dryRun));
        const counts = { orgBound: 0, orgMade: 0, orgCapped: 0, orgSuppressed: 0, orgFailed: 0, orgRemoved: 0 };
        if (!dryRun) await bindNamedOrgs(direct, transaction, counts);
        return { ...filed, ...counts };
      }),

    erasureLevel() {
      if (journal === undefined) return Promise.reject(new Error("the writer was made without the journal's path"));
      return erasureLevel(db.query, journal);
    },

    hasRevision: (given, sourceItemId, revisionTag) => hasRevision(reading, given, sourceItemId, revisionTag),
    listRoots: (label) => rootsOf(reading, label),
    databaseBytes: () => databaseBytes(reading),
    // The selection is one statement; each row it selected is then taken in a transaction of its
    // own, with the row locked and read again. Nothing is thrown for a row: each is counted.
    takeRecords: (limit = 500) =>
      write(async () => {
        const { ids, waiting } = await selectRecords(direct, limit);
        const counts: TakeCounts = { taken: 0, removed: 0, refused: 0, waiting };
        for (const id of ids) {
          const outcome = await write(() => transaction((tx) => takeOne(tx, id)));
          if (outcome !== "skipped") counts[outcome] += 1;
        }
        return counts;
      }),

    takeCapture: (limit = 200, options) => takeCapture({ direct, transaction, write }, limit, options),
    takeContacts: (limit) => takeContacts({ direct, transaction, write, ingest, now: () => new Date() }, limit),
    catchUpWork: (limit = WORK_CATCH_UP) => catchUpWork({ direct, transaction, write }, limit),
    expireCapture: (now, limit) => expireCaptures({ direct, transaction, write }, now, limit),

    proposeIdentity: (now) =>
      write(() => sweepIdentity({ transaction: (fn) => transaction((tx) => fn(tx.query)), keys, log }, { now })),
    backfillLocalNames: () => write(() => transaction((tx) => backfillLocalNames(tx))),
    bindParticipants: (now, limit) => bindParticipants({ direct, transaction, write }, now, limit),
    bindNamed: (now) => bindNamed({ direct, transaction, write }, now),
    landResearch: (now) => write(() => landResearch({ direct, transaction }, now, log)),
    backfillChatLines: (options) => write(() => backfillChatLines({ direct, transaction }, options)),

    close: () => db.close(),
  };
}

// The contract shape a connector takes, built in memory and never stored. The external
// reference is the label, never the address.
export function sourceAccountOf(row: GoogleAccountRow): SourceAccount {
  return {
    id: row.id,
    connector: row.connector,
    sourceKind: row.sourceKind,
    vault: "personal",
    externalRef: row.label,
    accessSyncKind: "none",
    compartments: [row.compartment],
    markerCompartments: [],
  };
}
