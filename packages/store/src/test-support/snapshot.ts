// Reading every table as pi_admin: snapshots, row counts and comparable rows.

import { Envelope } from "@intelligence/contracts";
import { openRow } from "../core/seal.ts";
import { TABLES, type Table } from "./catalogue.ts";
import { SEALED } from "./catalogue-work.ts";
import { one, session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";

// ---------------------------------------------------------------------------------------------
// Reading every table as pi_admin
// ---------------------------------------------------------------------------------------------

// Every table pi_admin reads: all but ledger.handles, which no runtime role reads; it holds ids and
// handles only, as handles-database.db.test.ts checks. Nor policy.capture_push_refusals, pi_owner's alone
// the same way.
export const OWNER_ONLY_TABLES: readonly string[] = ["ledger.handles", "policy.capture_push_refusals", "policy.labels"];
const ADMIN_READ: readonly Table[] = TABLES.filter((table) => !OWNER_ONLY_TABLES.includes(table.name));

// "<table> <key>" to the row's xmin, for every row of every table pi_admin reads.
export async function snapshot(db: TestDatabase): Promise<Map<string, string>> {
  return session(db.urls.admin, async (query) => {
    const rows = new Map<string, string>();
    for (const table of ADMIN_READ) {
      for (const row of await query<{ key: string; xmin: string }>(
        `select (${table.key})::text as key, xmin::text as xmin from ${table.name}`,
      )) {
        rows.set(`${table.name} ${row.key}`, row.xmin);
      }
    }
    return rows;
  });
}

// A snapshot as sorted "(table, key, xmin)" lines, to compare two of them whole.
export const lines = (rows: Map<string, string>): string[] => [...rows].map(([key, xmin]) => `${key} ${xmin}`).sort();

export async function rowCounts(db: TestDatabase): Promise<Record<string, number>> {
  return session(db.urls.admin, async (query) => {
    const counts: Record<string, number> = {};
    for (const table of ADMIN_READ)
      counts[table.name] = one(await query<{ n: number }>(`select count(*)::int as n from ${table.name}`)).n;
    return counts;
  });
}

// The tables whose row count changed, with the change.
export function changed(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const table of TABLES) {
    const change = (after[table.name] ?? 0) - (before[table.name] ?? 0);
    if (change !== 0) delta[table.name] = change;
  }
  return delta;
}

// A stored envelope, opened at its own row and column under a compartment's key.
export const opened = (
  db: TestDatabase,
  compartment: string,
  at: { table: string; id: string; column: string },
  value: unknown,
): string => openRow(db.keys, compartment, at, Envelope.parse(value));

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, inner]) => [key, canonical(inner)]),
  );
};

// What two stores are compared on: every `id` column, every column holding another row's id and the
// time columns that default to now() are set aside. So is `cursor_updated_at`, which `setCursor`
// sets to the time it ran.
const SET_ASIDE = new Set([
  "id",
  "blob_ref",
  "entity_id",
  "evidence_id",
  "source_account_id",
  "account_id",
  "event_id",
  "client_id",
  "supersedes",
  "next_revision_id",
  "created_at",
  "updated_at",
  "applied_at",
  "at",
  "ingested_at",
  "cursor_updated_at",
]);

// Every table's rows in a form two databases with one key file can be compared in: sorted, with
// the columns above set aside and each envelope opened. The opened `item_enc` loses its
// `sourceAccount`, a random id in each database.
export async function comparableRows(db: TestDatabase): Promise<Record<string, string[]>> {
  return session(db.urls.admin, async (query) => {
    const tables: Record<string, string[]> = {};
    for (const table of ADMIN_READ) {
      const sealed = new Set(SEALED.filter((one) => one.table === table.name).map((one) => one.column));
      const rows = await query<{ key: string; row: Record<string, unknown> }>(
        `select (${table.key})::text as key, to_jsonb(t) as row from ${table.name} t`,
      );
      tables[table.name] = rows
        .map(({ key, row }) => {
          const compartments = Array.isArray(row.compartments) ? row.compartments : [];
          const compartment = typeof compartments[0] === "string" ? compartments[0] : "own";
          const kept: Record<string, unknown> = {};
          for (const [column, value] of Object.entries(row)) {
            if (SET_ASIDE.has(column)) continue;
            if (!sealed.has(column) || value === null) {
              kept[column] = value;
              continue;
            }
            const text = opened(db, compartment, { table: table.name, id: key, column }, value);
            // A message's sealed facts are JSON: compared as a value, whatever the order of its keys.
            if (column === "facts_enc") {
              kept[column] = JSON.parse(text) as unknown;
              continue;
            }
            if (column !== "item_enc") {
              kept[column] = text;
              continue;
            }
            const { sourceAccount: _, ...item } = JSON.parse(text) as Record<string, unknown>;
            kept[column] = item;
          }
          return JSON.stringify(canonical(kept));
        })
        .sort();
    }
    return tables;
  });
}
