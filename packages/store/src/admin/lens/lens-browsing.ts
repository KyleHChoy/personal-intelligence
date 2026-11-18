import {
  CaptureAccountView,
  CaptureExcludeView,
  ExcludeHost,
  type LensBrowsingMode,
  LensBrowsingView,
  MappedAccount,
  MappedCompartment,
  ownLabel,
} from "@intelligence/contracts/personal";
import { registrableDomain } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint, scopeNormal } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { CAPTURE_ACCOUNTS_LOCK } from "../../core/locks.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";

// A device's browsing mode, the owner's exclude list and their account map, run as pi_admin for `pi
// lens browsing`. A host and an account are normalized as a scope rule's value and account are
// (keys.ts), fingerprinted under `capture_scope` and sealed under `own`; neither is returned but by
// `excludeValue` and `accountValue`, for `--show` on a terminal. The push function reads neither
// table; the drain reads both (capture-drain.ts).

const at = (
  table: "policy.capture_excludes" | "policy.capture_accounts",
  id: string,
  column: "value_enc" | "account_enc",
) => ({ table, id, column });

// Deletes one row by its id with `sql`, a delete that returns the id; `not_found` for an id that
// names none.
export async function removeById(admin: AdminContext, sql: string, id: string): Promise<void> {
  const removed = await admin.transaction((query) => query<{ id: string }>(sql, [id]));
  if (removed.length === 0) throw new AdminError("not_found");
}

// Only pi_admin writes it.
export async function setBrowsing(admin: AdminContext, device: string, mode: LensBrowsingMode): Promise<void> {
  const updated = await admin.transaction((query) =>
    query<{ name: string }>("update policy.lens_devices set browsing = $2 where name = $1 returning name", [
      device,
      mode,
    ]),
  );
  if (updated.length === 0) throw new AdminError("not_found");
}

// `not_found` for no such device.
export async function browsing(admin: AdminContext, device: string): Promise<LensBrowsingView> {
  const [row] = await admin.transaction((query) =>
    query<{ device: string; mode: string; excludes: number; accounts: number }>(
      `select d.name as device, d.browsing as mode, (select count(*) from policy.capture_excludes)::int as excludes, (select count(*) from policy.capture_accounts)::int as accounts
       from policy.lens_devices d where d.name = $1`,
      [device],
    ),
  );
  if (row === undefined) throw new AdminError("not_found");
  return LensBrowsingView.parse(row);
}

// Refused `invalid_argument` for anything else (a single label, a URL, a public suffix such as
// `co.uk`), and `duplicate_name` for a host already on it. Returns the row's id.
export async function addExclude(admin: AdminContext, host: string): Promise<string> {
  const normal = scopeNormal(host);
  if (!ExcludeHost.safeParse(normal).success || registrableDomain(normal) === null)
    throw new AdminError("invalid_argument");
  const id = newId("cex");
  const [made] = await admin.transaction((query) =>
    query<{ id: string }>(
      "insert into policy.capture_excludes (id, value_fp, value_enc, created_at) values ($1, $2, $3, $4) on conflict on constraint capture_excludes_value do nothing returning id",
      [
        id,
        fingerprint(admin.keys, "capture_scope", normal),
        sealUnder(admin.keys, ["own"], at("policy.capture_excludes", id, "value_enc"), normal),
        stamp(admin.now()),
      ],
    ),
  );
  if (made === undefined) throw new AdminError("duplicate_name");
  return made.id;
}

// Every exclusion, oldest first: its id and when it was added. No value.
export async function excludes(admin: AdminContext): Promise<CaptureExcludeView[]> {
  const rows = await admin.transaction((query) =>
    query<{ id: string; createdAt: Date }>(
      `select id, created_at as "createdAt" from policy.capture_excludes order by created_at, id`,
    ),
  );
  return rows.map((row) => CaptureExcludeView.parse({ id: row.id, createdAt: row.createdAt.toISOString() }));
}

// `exclude list --show`: one exclusion's host, opened under `own`; null for an id that names none.
export async function excludeValue(admin: AdminContext, id: string): Promise<string | null> {
  const [row] = await admin.transaction((query) =>
    query<{ value_enc: Sealed }>("select value_enc from policy.capture_excludes where id = $1", [id]),
  );
  return row === undefined
    ? null
    : open(
        admin.keys,
        { id, compartments: ownLabel(), value_enc: row.value_enc },
        "policy.capture_excludes.value_enc",
        "throw",
      );
}

// Removes an exclusion; `not_found` for an id that names none. It admits nothing again by itself.
export function removeExclude(admin: AdminContext, id: string): Promise<void> {
  return removeById(admin, "delete from policy.capture_excludes where id = $1 returning id", id);
}

async function conflicting(query: Query, accountFp: string, compartment: string): Promise<string[]> {
  return (
    await query<{ id: string }>(
      "select id from policy.capture_scope where account_fp = $1 and compartment <> $2 order by id",
      [accountFp, compartment],
    )
  ).map((row) => row.id);
}

// Refused `invalid_argument` for a malformed account or a compartment that is neither (public,
// restricted), `unknown_compartment` for an employer the key file lacks, `rule_conflict` (with the
// rules' ids) when a scope rule names the account with another compartment, and `duplicate_name`
// for an account already mapped. Returns the row's id.
export async function addAccount(admin: AdminContext, account: string, compartment: string): Promise<string> {
  const normal = scopeNormal(account);
  if (!MappedAccount.safeParse(normal).success || !MappedCompartment.safeParse(compartment).success)
    throw new AdminError("invalid_argument");
  if (!admin.keys.compartments.has(compartment)) throw new AdminError("unknown_compartment");
  const id = newId("cac");
  const accountFp = fingerprint(admin.keys, "capture_scope", normal);
  const [made] = await admin.transaction(async (query) => {
    await query(CAPTURE_ACCOUNTS_LOCK);
    const rules = await conflicting(query, accountFp, compartment);
    if (rules.length > 0) throw new AdminError("rule_conflict", undefined, undefined, rules);
    return query<{ id: string }>(
      `insert into policy.capture_accounts (id, account_fp, account_enc, compartment, created_at) values ($1, $2, $3, $4, $5)
       on conflict on constraint capture_accounts_account do nothing returning id`,
      [
        id,
        accountFp,
        sealUnder(admin.keys, ["own"], at("policy.capture_accounts", id, "account_enc"), normal),
        compartment,
        stamp(admin.now()),
      ],
    );
  });
  if (made === undefined) throw new AdminError("duplicate_name");
  return made.id;
}

// Every mapped account, oldest first: its id, compartment and when it was added. No account.
export async function accounts(admin: AdminContext): Promise<CaptureAccountView[]> {
  const rows = await admin.transaction((query) =>
    query<{ id: string; compartment: string; createdAt: Date }>(
      `select id, compartment, created_at as "createdAt" from policy.capture_accounts order by created_at, id`,
    ),
  );
  return rows.map((row) =>
    CaptureAccountView.parse({ id: row.id, compartment: row.compartment, createdAt: row.createdAt.toISOString() }),
  );
}

// `account list --show`: one mapped account, opened under `own`; null for an id that names none.
export async function accountValue(admin: AdminContext, id: string): Promise<string | null> {
  const [row] = await admin.transaction((query) =>
    query<{ account_enc: Sealed }>("select account_enc from policy.capture_accounts where id = $1", [id]),
  );
  return row === undefined
    ? null
    : open(
        admin.keys,
        { id, compartments: ownLabel(), account_enc: row.account_enc },
        "policy.capture_accounts.account_enc",
        "throw",
      );
}

// Removes a mapped account; `not_found` for an id that names none.
export function removeAccount(admin: AdminContext, id: string): Promise<void> {
  return removeById(admin, "delete from policy.capture_accounts where id = $1 returning id", id);
}

export async function mappedCompartment(query: Query, accountFp: string): Promise<string | undefined> {
  return (
    await query<{ compartment: string }>("select compartment from policy.capture_accounts where account_fp = $1", [
      accountFp,
    ])
  )[0]?.compartment;
}
