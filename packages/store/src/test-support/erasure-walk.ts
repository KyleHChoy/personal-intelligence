import pg from "pg";
import { session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";

// The catalogue walk the erasure tests stand on: every clear column of the five schemas that can hold
// an id or a fingerprint, read with row-level security lifted in a transaction rolled back. A column
// of any name may hold one, since the values looked for are unique strings. A sealed `_enc` column
// is left out: it holds no value in clear.

const SCHEMAS = ["vault", "knowledge", "ledger", "projections", "policy"];

export type Lifted = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
export type Column = { tbl: string; col: string; udt: string };

export const lifted = (table: string): string => `alter table ${table} no force row level security`;

export async function asOwner<T>(db: TestDatabase, fn: (query: Lifted) => Promise<T>): Promise<T> {
  return session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      return await fn(query as Lifted);
    } finally {
      await query("rollback");
    }
  });
}

export const columns = (db: TestDatabase): Promise<Column[]> =>
  asOwner(
    db,
    async (query) =>
      (await query(
        `select n.nspname || '.' || c.relname as tbl, a.attname as col, t.typname as udt
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type t on t.oid = a.atttypid
         where c.relkind in ('r', 'p') and n.nspname = any ($1) and a.attnum > 0 and not a.attisdropped
           and t.typname in ('text', '_text', 'varchar', '_varchar', 'jsonb') and a.attname not like '%\\_enc'
         order by 1, 2`,
        [SCHEMAS],
      )) as Column[],
  );

// Every "<table>.<column>" that holds any of `values`: equal to one, an array holding one, or jsonb
// whose text contains one.
export async function holding(db: TestDatabase, values: readonly string[]): Promise<string[]> {
  const all = await columns(db);
  return asOwner(db, async (query) => {
    for (const table of new Set(all.map((column) => column.tbl))) await query(lifted(table));
    const found: string[] = [];
    for (const { tbl, col, udt } of all) {
      const column = pg.escapeIdentifier(col);
      const where =
        udt === "jsonb"
          ? `exists (select 1 from unnest($1::text[]) as v (id) where strpos(${column}::text, v.id) > 0)`
          : udt.startsWith("_")
            ? `${column}::text[] && $1::text[]`
            : `${column}::text = any ($1)`;
      const [row] = await query(`select exists (select 1 from ${tbl} where ${where}) as yes`, [values]);
      if (row?.yes === true) found.push(`${tbl}.${col}`);
    }
    return found;
  });
}

// The same walk for many values at once: for each value, the columns that hold it.
export async function holdingEach(db: TestDatabase, values: readonly string[]): Promise<Map<string, string[]>> {
  const all = await columns(db);
  const found = new Map<string, string[]>(values.map((value) => [value, []]));
  await asOwner(db, async (query) => {
    for (const table of new Set(all.map((column) => column.tbl))) await query(lifted(table));
    for (const { tbl, col, udt } of all) {
      const column = pg.escapeIdentifier(col);
      const select =
        udt === "jsonb"
          ? `select v.id from unnest($1::text[]) as v (id) where exists (select 1 from ${tbl} t where strpos(t.${column}::text, v.id) > 0)`
          : udt.startsWith("_")
            ? `select distinct x::text as id from ${tbl} t cross join lateral unnest(t.${column}) as x where x::text = any ($1)`
            : `select distinct t.${column}::text as id from ${tbl} t where t.${column}::text = any ($1)`;
      for (const row of await query(select, [values])) found.get(String(row.id))?.push(`${tbl}.${col}`);
    }
  });
  return found;
}
