import type { Timestamp } from "@intelligence/contracts";
import {
  type BoxHealthRow,
  type BoxHealthSeenRow,
  CANARY_CLIENT_PREFIX,
  CANARY_COMPARTMENT,
  type ClientName,
  CodedError,
  canonicalTimeZone,
  EntityId,
  isCanaryCompartment,
  type RecentLearningRow,
  type SourceAccountId,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { normalizeAddress, PERSONAL_LIMITS } from "@intelligence/personal-core";
import { deriveItem } from "@intelligence/personal-core/items";
import pg from "pg";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { openHealth, seenHealth } from "../../core/box-health.ts";
import { byText, stamp, stampOrNull } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { CAPTURE_LANES } from "../../core/lanes.ts";
import { addressAt, open, type Sealed, sealUnder, secretAt } from "../../core/seal.ts";
import { noCanaryIn, OWNER_ACCOUNT_FPS } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import * as writerIdentity from "../../identity/identity-port.ts";
import { DATABASE_SIZE } from "../../lens/capture-push.ts";
import { rederive } from "../../write/rederive.ts";
import { syncLock } from "../admin-base.ts";
import { recentLearnings } from "../work/admin-learnings.ts";
import { CLIENTS, type StoredClient } from "./admin-clients.ts";

// The owner's accounts and the box's reads, run as pi_admin: the owner's addresses and the send-as
// aliases not yet theirs, their time zone, the secrets, the source accounts, the database's size,
// `status` and `inspect`.

// The writer's SourceAccountRow with its address and last sync. An agent, web or Lens account
// has no address.
export type SourceAccountView = {
  id: SourceAccountId;
  label: string;
  connector:
    | "google_mail"
    | "google_calendar"
    | "google_docs"
    | "google_contacts"
    | "contacts_import"
    | "agent"
    | LensConnector;
  compartment: string;
  address: string | null;
  lastSyncAt: Timestamp | null;
  lastOutcome: string | null;
};

export type StatusView = {
  // The number of the latest migration applied, so what the database holds can be set beside the
  // commit the box runs; null before any.
  migration: string | null;
  // "<schema>.<table>", for every table of every schema the migrations made, to its row count
  // (`pia status`), or the catalogue's estimate of it (the dashboard's read, which shows none).
  tables: Record<string, number>;
  missingKeys: string[];
  // How many label keys stored rows hold that policy.labels lacks. A
  // row whose label is missing is seen by no client; 0 unless a path past the labels' triggers
  // wrote it (a column added with a default, a trigger disabled, a partial restore).
  missingLabels: number;
  accounts: {
    id: SourceAccountId;
    label: string;
    connector: "google_mail" | "google_calendar" | "google_docs" | "agent" | LensConnector;
    compartment: string;
    lastSyncAt: Timestamp | null;
    lastOutcome: string | null;
    cursorUpdatedAt: Timestamp | null;
    skippedItems: number;
  }[];
  googleTokens: { label: string; updatedAt: Timestamp }[];
  keyCheck: "ok" | "failed";
  clients: { name: ClientName; status: "active" | "revoked"; lastCallAt: Timestamp | null }[];
  // No name and no Google id.
  drive: { documents: number; held: number; databaseBytes: number; ceilingBytes: number; ceilingWarning: boolean };
  // The open box health cards, oldest first (box-health.ts).
  boxHealth: BoxHealthRow[];
  // The box health cards an agent marked seen lately, newest first, with the agent.
  boxHealthSeen: BoxHealthSeenRow[];
  // The active learnings agents filed lately, newest first, their words opened.
  learnings: RecentLearningRow[];
};

export const DRIVE_CEILING_BYTES = 3 * 1024 * 1024 * 1024;
const CEILING_WARNING = 0.8;

type InspectView = {
  id: EntityId;
  kind: SubjectKind;
  names: { value: string; compartment: string }[];
  addresses: { value: string; compartment: string }[];
  // The last ten interaction_log rows.
  interactions: {
    at: Timestamp;
    direction: "inbound" | "outbound";
    role: "sender" | "recipient";
    compartment: string;
  }[];
};

// Lens's connectors whose accounts this reads: a device's accounts, each with no address.
type LensConnector = (typeof CAPTURE_LANES)["meeting" | "moment" | "block"]["connector"];

type StoredAccount = {
  id: string;
  label: string;
  connector: "google_mail" | "google_calendar" | "google_docs" | "agent" | LensConnector;
  compartments: string[];
  address_enc: Sealed;
  cursor_updated_at: Date | null;
  last_sync_at: Date | null;
  last_outcome: string | null;
  skipped_items: number;
};

type ValueRow = { id: string; compartments: string[]; value_enc: Sealed };

const ACCOUNTS = `
  select id, label, connector, compartments, address_enc, cursor_updated_at, last_sync_at, last_outcome, skipped_items
  from vault.source_accounts where not (label = '${CANARY_COMPARTMENT}' or starts_with(label, 'agent:${CANARY_CLIENT_PREFIX}') or starts_with(label, 'device:${CANARY_CLIENT_PREFIX}'))
  order by label collate "C", connector collate "C"`;

const REFRESH_TOKEN = /^google\/([^/]+)\/refresh_token$/;
const INSPECTED_INTERACTIONS = 10;

// The owner's account row for the address under the compartment, the owner entity if there is none,
// and, in the same transaction, the re-derive when a person held the address: that person's rows
// are the owner's at the commit, not at the next sync. Under the sync lock, tried: `sync_running`
// while a sync holds it. A re-derive rebuilds every derived row from the vault and costs local CPU
// only; the claims it removes are extracted again by the next `pi extract`, from the saved calls.
// Throws AdminError "invalid_address", or a plain Error with code "unknown_compartment".
export async function addOwnerAddress(
  admin: AdminContext,
  address: string,
  compartment: string,
): Promise<{ rederived: boolean; items: number }> {
  const owner = normalizeAddress(address);
  if (owner === null) throw new AdminError("invalid_address");
  if (!admin.keys.compartments.has(compartment)) throw new CodedError("unknown_compartment");
  return admin.transaction(async (query) => {
    await syncLock(query);
    const tx = { query, keys: admin.keys };
    await writerIdentity.addOwnerAddress(tx, owner, [compartment]);
    const { rederived, items, coarser } = await rederive(tx, (raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
    // What a coarser fold would have widened: names kept on their old keys, and
    // domain ignores narrowed to their addresses, each with a card.
    if (coarser > 0) admin.log.warn({ event: "rekey_coarser", counts: { kept: coarser } });
    return { rederived, items };
  });
}

// Each mail account's verified send-as aliases, as its latest sync read them, that are not yet
// owner addresses under any compartment, so the owner can add their own with `pi owner
// add-address`. By label, then address. The owner's alone: no agent reads it.
export async function sendAsAliases(
  admin: AdminContext,
): Promise<{ label: string; compartment: string; address: string }[]> {
  return admin.transaction(async (query) => {
    const accounts = await query<{ id: string; label: string; compartments: string[]; send_as_enc: Sealed }>(
      `select id, label, compartments, send_as_enc from vault.source_accounts
       where connector = 'google_mail' and send_as_enc is not null order by label collate "C"`,
    );
    const owned = new Set((await query<{ value_fp: string }>(OWNER_ACCOUNT_FPS)).map((row) => row.value_fp));
    return accounts.flatMap((row) => {
      const listed = JSON.parse(open(admin.keys, row, "vault.source_accounts.send_as_enc", "throw")) as string[];
      return listed
        .filter((address) => !owned.has(fingerprint(admin.keys, "address", address)))
        .map((address) => ({ label: row.label, compartment: row.compartments[0] ?? "", address }));
    });
  });
}

// The owner's time zone, an IANA name this runtime knows, stored in its canonical
// form, which it returns. Any other name is refused invalid_argument and nothing is written.
export async function setTimeZone(admin: AdminContext, zone: string): Promise<string> {
  const canonical = canonicalTimeZone(zone);
  if (canonical === null) throw new AdminError("invalid_argument");
  await admin.transaction((query) => query("update policy.owner_settings set time_zone = $1", [canonical]));
  return canonical;
}

// Sealed under the `own` key, bound to the secret's name.
export async function setSecret(admin: AdminContext, name: string, value: string): Promise<void> {
  const sealed = sealUnder(admin.keys, ["own"], secretAt(name), value);
  await admin.transaction((query) =>
    query(
      `insert into policy.secrets (name, value_enc, updated_at) values ($1, $2, $3)
       on conflict (name) do update set value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      [name, sealed, stamp(admin.now())],
    ),
  );
}

export async function deleteSecret(admin: AdminContext, name: string): Promise<void> {
  await admin.transaction((query) => query("delete from policy.secrets where name = $1", [name]));
}

// A prefix is text, never a pattern.
export async function listSecretNames(admin: AdminContext, prefix: string): Promise<string[]> {
  const rows = await admin.transaction((query) =>
    query<{ name: string }>(`select name from policy.secrets where starts_with(name, $1) order by name collate "C"`, [
      prefix,
    ]),
  );
  return rows.map((row) => row.name);
}

// When a secret was last written, or null when it is not stored. Never its value.
export async function secretUpdatedAt(admin: AdminContext, name: string): Promise<Timestamp | null> {
  const [row] = await admin.transaction((query) =>
    query<{ updated_at: Date }>("select updated_at from policy.secrets where name = $1", [name]),
  );
  return row === undefined ? null : stamp(row.updated_at);
}

export async function secret(admin: AdminContext, name: string): Promise<string | null> {
  const [row] = await admin.transaction((query) =>
    query<{ value_enc: Sealed }>("select value_enc from policy.secrets where name = $1", [name]),
  );
  return row === undefined ? null : openedUnder(admin.keys, ["own"], secretAt(name), row.value_enc);
}

// By label, then connector.
export async function listSourceAccounts(admin: AdminContext): Promise<SourceAccountView[]> {
  const rows = await admin.transaction((query) => query<StoredAccount>(ACCOUNTS));
  return rows.map((row) => {
    const compartment = row.compartments[0] ?? "";
    return {
      id: row.id as SourceAccountId,
      label: row.label,
      connector: row.connector,
      compartment,
      // source_accounts_agent_address: an account with no address is one of a connector that has none.
      address:
        row.address_enc === null ? null : openedUnder(admin.keys, row.compartments, addressAt(row.id), row.address_enc),
      lastSyncAt: stampOrNull(row.last_sync_at),
      lastOutcome: row.last_outcome,
    };
  });
}

// Stored fields only. The database's size alone, for `pi status --storage`'s alarm: one statement,
// a total and no row.
export async function databaseBytes(admin: AdminContext): Promise<number> {
  const [row] = await admin.transaction((query) => query<{ bytes: string }>(DATABASE_SIZE));
  return Number(row?.bytes ?? 0);
}

// `tables: "estimate"` (the dashboard's Settings, which shows no table's count) takes each count
// from the catalogue's estimate, pg_class.reltuples, and counts nothing; `pia status` counts.
export function status(
  admin: AdminContext,
  options: { driveCeilingBytes?: number; tables?: "count" | "estimate" } = {},
): Promise<StatusView> {
  const ceilingBytes = options.driveCeilingBytes ?? DRIVE_CEILING_BYTES;
  return admin.transaction(async (query) => {
    // The names come from the catalogue, quoted as identifiers: never from a caller. Every
    // schema but the system's, so a later migration's schema is counted with no change here.
    // ledger.handles, policy.capture_push_refusals and policy.labels are left out: no runtime
    // role reads any of them, and none holds a row's label (policy.labels' compartments are the
    // labels other rows hold, each counted where that row is).
    const names = await query<{ schema: string; name: string; labelled: boolean; estimate: number }>(
      `select n.nspname as schema, c.relname as name,
         exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'compartments' and not a.attisdropped) as labelled,
         greatest(c.reltuples, 0)::float8 as estimate
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'public') and c.relkind in ('r', 'p')
         and not (n.nspname = 'ledger' and c.relname = 'handles')
         and not (n.nspname = 'policy' and c.relname = 'capture_push_refusals')
         and not (n.nspname = 'policy' and c.relname = 'labels')
       order by n.nspname, c.relname`,
    );
    // Settings reads this on each load, so it takes few statements: one counts every table, or
    // none when estimates are asked for, and one more reads each labelled table's distinct
    // labels once, keying only those rather than every row.
    const quoted = names.map(({ schema, name, labelled }) => ({
      key: `${schema}.${name}`,
      table: `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`,
      labelled,
      clearance: schema === "policy" && name === "clients",
    }));
    const tables: Record<string, number> = {};
    if (options.tables === "estimate") {
      for (const [index, { key }] of quoted.entries()) tables[key] = Math.round(names[index]?.estimate ?? 0);
    } else if (quoted.length > 0) {
      const counted = await query<{ name: string; rows: number }>(
        quoted
          .map(
            ({ key, table, labelled }) =>
              `select ${pg.escapeLiteral(key)} as name, count(*)::int as rows from ${table}${labelled ? ` where ${noCanaryIn("compartments")}` : ""}`,
          )
          .join("\nunion all\n"),
      );
      for (const { key } of quoted) tables[key] = 0;
      for (const { name, rows } of counted) tables[name] = rows;
    }
    // Each labelled table's distinct labels, read once: the compartments they carry, and the
    // key of each, which policy.labels must hold. policy.clients' compartments are a clearance,
    // not a row's label: a client whose clearance no row holds yet is no missing label (the
    // label triggers pass over it too). Qualified by an alias no table uses: a table with a
    // column of the alias's name would make the bare name ambiguous.
    const labelled = quoted.filter((one) => one.labelled);
    const [held] =
      labelled.length === 0
        ? []
        : await query<{ carried: string[]; missing: number }>(
            `with held (compartments, clearance) as (
               ${labelled.map(({ table, clearance }) => `select distinct compartments, ${clearance} from ${table}`).join("\n union ")}
             )
             select array(select distinct label_part.compartment from held, unnest(held.compartments) as label_part (compartment)) as carried,
               policy.labels_missing(array(select distinct policy.label_key(held.compartments) from held where not held.clearance)) as missing`,
          );
    const missingKeys = (held?.carried ?? [])
      .filter((compartment) => !admin.keys.compartments.has(compartment) && !isCanaryCompartment(compartment))
      .sort(byText);

    const accounts = await query<StoredAccount>(ACCOUNTS);
    const secrets = await query<{ name: string; updated_at: Date }>(
      `select name, updated_at from policy.secrets where starts_with(name, 'google/') order by name collate "C"`,
    );
    const clients = await query<StoredClient>(CLIENTS);

    // Every account's address opens under its compartment's key, or the check fails. A key
    // that is absent and one that is wrong fail alike. An agent, web or Lens account has no
    // address: its key is checked by its presence.
    let keyCheck: StatusView["keyCheck"] = "ok";
    for (const account of accounts) {
      if (account.address_enc === null) {
        if (!account.compartments.every((compartment) => admin.keys.compartments.has(compartment))) keyCheck = "failed";
        continue;
      }
      try {
        openedUnder(admin.keys, account.compartments, addressAt(account.id), account.address_enc);
      } catch {
        keyCheck = "failed";
      }
    }

    const [documents] = await query<{ documents: number; held: number; bytes: string }>(
      `select count(*)::int as documents, count(*) filter (where held)::int as held, pg_database_size(current_database())::text as bytes from knowledge.documents where ${noCanaryIn("compartments")}`,
    );
    const databaseBytes = Number(documents?.bytes ?? 0);
    const drive = {
      documents: documents?.documents ?? 0,
      held: documents?.held ?? 0,
      databaseBytes,
      ceilingBytes,
      ceilingWarning: databaseBytes >= CEILING_WARNING * ceilingBytes,
    };

    // Names sort by their number, which is their first four characters.
    const [applied] = await query<{ name: string | null }>("select max(name) as name from policy.migrations");

    return {
      migration: applied?.name?.slice(0, 4) ?? null,
      drive,
      tables,
      missingKeys,
      missingLabels: held?.missing ?? 0,
      accounts: accounts.map((row) => ({
        id: row.id as SourceAccountId,
        label: row.label,
        connector: row.connector,
        compartment: row.compartments[0] ?? "",
        lastSyncAt: stampOrNull(row.last_sync_at),
        lastOutcome: row.last_outcome,
        cursorUpdatedAt: stampOrNull(row.cursor_updated_at),
        skippedItems: row.skipped_items,
      })),
      googleTokens: secrets.flatMap((row) => {
        const label = REFRESH_TOKEN.exec(row.name)?.[1];
        return label === undefined ? [] : [{ label, updatedAt: stamp(row.updated_at) }];
      }),
      keyCheck,
      clients: clients.map((row) => ({
        name: row.name,
        status: row.status,
        lastCallAt: stampOrNull(row.last_call_at),
      })),
      boxHealth: await openHealth(query),
      boxHealthSeen: await seenHealth(query, admin.now()),
      learnings: await recentLearnings(query, admin.keys, admin.now()),
    };
  });
}

// By entity id or by address; null for an unknown query. An address the owner holds finds
// the owner, even while a person's row still holds it.
export function inspect(admin: AdminContext, query: EntityId | string): Promise<InspectView | null> {
  const keys = admin.keys;
  // Each value under its row's whole label, which `compartment` names, joined.
  const open = (table: string, column: string, row: ValueRow) => ({
    value: openedUnder(keys, row.compartments, { table, id: row.id, column }, row.value_enc),
    compartment: row.compartments.join(","),
  });
  return admin.transaction(async (run) => {
    let id: string | undefined;
    if (EntityId.safeParse(query).success) id = query;
    else {
      const address = normalizeAddress(query);
      if (address === null) return null;
      const [holder] = await run<{ entity_id: string }>(
        `select a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
         where a.value_fp = $1 order by (e.kind = 'owner') desc, a.id limit 1`,
        [fingerprint(keys, "address", address)],
      );
      id = holder?.entity_id;
    }
    if (id === undefined) return null;
    const [entity] = await run<{ id: string; kind: SubjectKind }>(
      "select id, kind from knowledge.entities where id = $1",
      [id],
    );
    if (entity === undefined) return null;

    // One row per name under each compartment; an address or a domain has one row there.
    const names = await run<ValueRow>(
      `select distinct on (value_fp, compartments) id, compartments, value_enc from knowledge.aliases
       where entity_id = $1 order by value_fp, compartments, id`,
      [id],
    );
    const accounts = await run<ValueRow>(
      "select id, compartments, value_enc from knowledge.accounts where entity_id = $1 order by id",
      [id],
    );
    const domains = await run<ValueRow>(
      "select id, compartments, domain_enc as value_enc from knowledge.domains where entity_id = $1 order by id",
      [id],
    );
    const interactions = await run<{
      occurred_at: Date;
      direction: "inbound" | "outbound";
      entity_role: "sender" | "recipient";
      compartments: string[];
    }>(
      `select occurred_at, direction, entity_role, compartments from knowledge.interaction_log
       where entity_id = $1 order by occurred_at desc, id desc limit $2`,
      [id, INSPECTED_INTERACTIONS],
    );
    return {
      id: entity.id as EntityId,
      kind: entity.kind,
      names: names
        .map((row) => open("knowledge.aliases", "value_enc", row))
        .sort((a, b) => byText(a.value, b.value) || byText(a.compartment, b.compartment)),
      addresses: [
        ...accounts.map((row) => open("knowledge.accounts", "value_enc", row)),
        ...domains.map((row) => open("knowledge.domains", "domain_enc", row)),
      ],
      interactions: interactions.map((row) => ({
        at: stamp(row.occurred_at),
        direction: row.direction,
        role: row.entity_role,
        compartment: row.compartments.join(","),
      })),
    };
  });
}
