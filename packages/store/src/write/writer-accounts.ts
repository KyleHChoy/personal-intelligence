// A stored source account and its cursor, as the writer and its ingest and listing parts read
// them. vault.source_accounts' label is single, so its one compartment is read here.

import { ConnectorCursor } from "@intelligence/contracts";
import { CodedError, SourceAccountId } from "@intelligence/contracts/personal";
import { normalizeAddress, THE_OWNER } from "@intelligence/personal-core";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { addOwnerAddress, writtenTo } from "../identity/identity-port.ts";
import type { GoogleAccountRow, SourceAccountRow, SyncCounts } from "./writer-types.ts";

export type StoredAccount = {
  id: string;
  label: string;
  connector: SourceAccountRow["connector"];
  source_kind: SourceAccountRow["sourceKind"];
  compartments: string[];
};

export const ACCOUNT = "id, label, connector, source_kind, compartments";
export const SOURCE_KIND = {
  google_mail: "email",
  google_calendar: "calendar",
  google_docs: "document",
  google_contacts: "crm",
} as const;

export const rowOf = (stored: StoredAccount): SourceAccountRow => ({
  id: SourceAccountId.parse(stored.id),
  label: stored.label,
  connector: stored.connector,
  sourceKind: stored.source_kind,
  compartment: stored.compartments[0] ?? "",
});

// The account as it is stored. A row's compartment is the stored account's, never one a caller
// hands in: an account that is not stored, or is stored under another compartment, is refused.
export async function storedAccount(tx: Tx, given: SourceAccountRow): Promise<SourceAccountRow> {
  const [stored] = await tx.query<StoredAccount>(`select ${ACCOUNT} from vault.source_accounts where id = $1`, [
    given.id,
  ]);
  if (stored === undefined || stored.compartments[0] !== given.compartment) throw new CodedError("account_mismatch");
  return rowOf(stored);
}

export const cursorAt = (account: SourceAccountRow) => ({
  table: "vault.source_accounts",
  id: account.id,
  column: "cursor_enc",
});

// Sealed, with the time it was set. Null clears it.
export async function storeCursor(tx: Tx, account: SourceAccountRow, cursor: ConnectorCursor | null): Promise<void> {
  const sealed = cursor === null ? null : sealUnder(tx.keys, [account.compartment], cursorAt(account), cursor);
  await tx.query("update vault.source_accounts set cursor_enc = $2, cursor_updated_at = now() where id = $1", [
    account.id,
    sealed,
  ]);
}

export async function listSourceAccounts(tx: Tx): Promise<SourceAccountRow[]> {
  return (
    await tx.query<StoredAccount>(
      `select ${ACCOUNT} from vault.source_accounts order by label collate "C", connector collate "C"`,
    )
  ).map(rowOf);
}

// The account's cursor, opened under its compartment; null when none is stored.
export async function cursorOf(tx: Tx, given: SourceAccountRow): Promise<ConnectorCursor | null> {
  const account = await storedAccount(tx, given);
  const [row] = await tx.query<{ cursor_enc: Sealed | null }>(
    "select cursor_enc from vault.source_accounts where id = $1",
    [account.id],
  );
  const sealed = row?.cursor_enc ?? null;
  return sealed === null
    ? null
    : ConnectorCursor.parse(
        open(
          tx.keys,
          { id: account.id, compartments: [account.compartment], cursor_enc: sealed },
          "vault.source_accounts.cursor_enc",
          "throw",
        ),
      );
}

// It writes nothing and opens nothing.
export async function ownerWrote(
  tx: Tx,
  account: SourceAccountRow,
  { sender, threadId, headers = false }: { sender?: string; threadId?: string; headers?: boolean },
): Promise<{ sender: boolean; thread: boolean }> {
  const [posted] =
    threadId === undefined
      ? []
      : await tx.query<{ thread: boolean }>(
          "select exists (select 1 from vault.evidence_items where source_account_id = $1 and thread_fp = $2 and sender_member = $3 and ($4 or not headers_only)) as thread",
          [account.id, fingerprint(tx.keys, "thread", threadId), THE_OWNER, headers],
        );
  return { sender: await writtenTo(tx, account.id, sender, headers), thread: posted?.thread === true };
}

// A mail account's send-as aliases, normalized, sealed under its compartment; none clears them.
export async function recordSendAs(tx: Tx, account: SourceAccountRow, given: readonly string[]): Promise<void> {
  const aliases = [...new Set(given.flatMap((one) => normalizeAddress(one) ?? []))].sort();
  const sealed =
    aliases.length === 0
      ? null
      : sealUnder(
          tx.keys,
          [account.compartment],
          { table: "vault.source_accounts", id: account.id, column: "send_as_enc" },
          JSON.stringify(aliases),
        );
  await tx.query("update vault.source_accounts set send_as_enc = $2 where id = $1", [account.id, sealed]);
}

// A Google account by label and connector, made the first time with its address sealed under its
// compartment; one stored under another compartment or address is `account_mismatch`.
export async function ensureGoogleAccount(
  tx: Tx,
  given: { label: string; connector: keyof typeof SOURCE_KIND; compartment: string; owner: string; addressFp: string },
): Promise<GoogleAccountRow> {
  const { label, connector, compartment, owner, addressFp } = given;
  const sourceKind = SOURCE_KIND[connector];
  const [found] = await tx.query<StoredAccount & { address_fp: string }>(
    `select ${ACCOUNT}, address_fp from vault.source_accounts where label = $1 and connector = $2`,
    [label, connector],
  );
  if (found !== undefined) {
    if (found.compartments[0] !== compartment || found.address_fp !== addressFp)
      throw new CodedError("account_mismatch");
    return { ...rowOf(found), connector, sourceKind };
  }
  const id = newId("acc");
  await tx.query(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
           values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      label,
      connector,
      sourceKind,
      [compartment],
      addressFp,
      sealUnder(tx.keys, [compartment], { table: "vault.source_accounts", id, column: "address_enc" }, owner),
    ],
  );
  // The account's own address is the owner's, under the account's compartment.
  await addOwnerAddress(tx, owner, [compartment]);
  return {
    ...rowOf({ id, label, connector, source_kind: sourceKind, compartments: [compartment] }),
    connector,
    sourceKind,
  };
}

// The statements of an `own` account of source kind `crm` with no address, by its connector.
const OWN_ACCOUNT = {
  contacts_import: {
    find: `select ${ACCOUNT} from vault.source_accounts where label = $1 and connector = 'contacts_import'`,
    make: "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'contacts_import', 'crm', '{own}')",
  },
  agent_people: {
    find: `select ${ACCOUNT} from vault.source_accounts where label = $1 and connector = 'agent_people'`,
    make: "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'agent_people', 'crm', '{own}')",
  },
} as const;

// An `own` account of source kind `crm` with no address, by label, made the first time.
export async function ensureOwnAccount(
  tx: Tx,
  connector: keyof typeof OWN_ACCOUNT,
  label: string,
): Promise<SourceAccountRow> {
  const [found] = await tx.query<StoredAccount>(OWN_ACCOUNT[connector].find, [label]);
  if (found !== undefined) return rowOf(found);
  const id = newId("acc");
  await tx.query(OWN_ACCOUNT[connector].make, [id, label]);
  return rowOf({ id, label, connector, source_kind: "crm", compartments: ["own"] });
}

// The account's last outcome and its sync_outcomes row, under the account's own label, its counts
// zero and its kind and `added` null without `counts`.
export async function recordOutcome(
  tx: Tx,
  account: string,
  outcome: { code: string; at: string; skippedItems: number; counts: SyncCounts | undefined },
): Promise<void> {
  const { code, at, skippedItems, counts } = outcome;
  await tx.query(
    "update vault.source_accounts set last_outcome = $2, last_sync_at = $3, skipped_items = $4 where id = $1",
    [account, code, at, skippedItems],
  );
  await tx.query(
    `insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, stored, held, junk, decided, removed, compartments)
             select id, $2, $3, $4, $5, $6, $7, $8, $9, $10, compartments from vault.source_accounts where id = $1`,
    [
      account,
      counts?.kind ?? null,
      at,
      code,
      counts?.added ?? null,
      counts?.stored ?? 0,
      counts?.held ?? 0,
      counts?.junk ?? 0,
      counts?.decided ?? 0,
      counts?.removed ?? 0,
    ],
  );
}
