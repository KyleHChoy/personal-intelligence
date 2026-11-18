import { asTablesOwner, ownerCommitted, type Query } from "./connections.ts";
import type { TestDatabase } from "./database.ts";

// A test that pins its reader's clock to a world date (WORLD_NOW) seeds its rows at the real time,
// after that date; a belief computed at read counts only the claims and rulings known by its clock
// (policy.belief_inputs_core compares each with `as_of`). knownBy moves every such
// time to `at` at the latest, as the tables' owner, so the world reads as known by its own date.
// Test support only: production rows are never redated.

// Each table and the times policy.belief_inputs_core and policy.belief_inputs_under compare with
// `as_of`. A lifted row's lift moves too, so a ruling lifted in the run stays lifted at the world's
// date.
const TIMES: Readonly<Record<string, readonly string[]>> = {
  "knowledge.claims": ["first_known_at", "created_at"],
  "knowledge.belief_rulings": ["created_at", "lifted_at"],
  "knowledge.fact_rulings": ["created_at", "lifted_at"],
  "knowledge.claim_relations": ["judged_at"],
  "policy.relation_switches": ["decided_at"],
  "ledger.belief_settlements": ["created_at", "lifted_at"],
  "ledger.source_checks": ["created_at"],
  "knowledge.same_fact_judgments": ["updated_at"],
};

// The tables of TIMES this database has: a table a later migration drops is skipped.
const presentTables = (db: TestDatabase): Promise<string[]> =>
  asTablesOwner(db, [], async (query) =>
    (
      await query<{ name: string }>(
        "select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any ($1) order by 1",
        [Object.keys(TIMES)],
      )
    ).map((row) => row.name),
  );

async function moveTimes(query: Query, tables: readonly string[], at: Date): Promise<void> {
  for (const table of tables) {
    const columns = TIMES[table] ?? [];
    // Never least(): it skips a null, so it would lift every ruling made after `at`.
    const set = columns
      .map((column) => `${column} = case when ${column} > $1::timestamptz then $1::timestamptz else ${column} end`)
      .join(", ");
    const later = columns.map((column) => `${column} > $1::timestamptz`).join(" or ");
    await query(`update ${table} set ${set} where ${later}`, [at.toISOString()]);
  }
}

export async function knownBy(db: TestDatabase, at: Date): Promise<void> {
  const present = await presentTables(db);
  await asTablesOwner(db, present, (query) => moveTimes(query, present, at));
}

// knownBy for a test that moves times while a reader's transaction is open. knownBy makes its
// policies inside its own transaction, and making one waits on every open transaction that read the
// table, so it would wait on the held reader. Here they are made before `fn` runs and dropped after,
// and `known` only updates rows, which waits on no reader.
export async function whileReading<T>(
  db: TestDatabase,
  fn: (known: (at: Date) => Promise<void>) => Promise<T>,
): Promise<T> {
  const present = await presentTables(db);
  const policies = (verb: "create" | "drop") =>
    ownerCommitted(db, async (query) => {
      for (const table of present)
        await query(
          verb === "create"
            ? `create policy zz_test_known on ${table} for all to pi_owner using (true) with check (true)`
            : `drop policy zz_test_known on ${table}`,
        );
    });
  await policies("create");
  try {
    return await fn((at) => ownerCommitted(db, (query) => moveTimes(query, present, at)));
  } finally {
    await policies("drop");
  }
}
