// Connections and sessions as each role, and the refusals they meet.

import { normalizeAddress } from "@intelligence/personal-core";
import pg from "pg";
import { addOwnerAddress } from "../identity/identity-port.ts";
import type { RUNTIME_ROLES } from "./catalogue-grants.ts";
import { testId } from "./clients.ts";
import { queryAs, type TestDatabase } from "./database.ts";

// ---------------------------------------------------------------------------------------------
// Connections as each role
// ---------------------------------------------------------------------------------------------

export type Query = <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<Row[]>;

// Exactly one row, or a failure that says how many came.
export function one<Row>(rows: Row[]): Row {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return row;
}

// One pg client as the role in `url`, ended when `fn` settles.
export async function asClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// One connection as the role in `url`, ended when `fn` settles.
export async function session<T>(url: string, fn: (query: Query) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const query: Query = async <Row>(text: string, values?: unknown[]) =>
    (await client.query(text, values)).rows as Row[];
  try {
    return await fn(query);
  } finally {
    await client.end();
  }
}

// The label keys some row of a labelled table holds that policy.labels lacks, sorted (each such row
// is seen by no client). `url` is the database's bootstrap (the migrator, a member of pi_owner).
export async function labelsMissing(url: string): Promise<string[]> {
  return session(url, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      const tables = await query<{ schema: string; name: string }>(
        `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
         where n.nspname in ('policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue') and c.relkind in ('r', 'p')
           and a.attname = 'compartments' and a.atttypid = 'text[]'::regtype and not a.attisdropped
           and (n.nspname, c.relname) not in (('policy', 'clients'), ('policy', 'labels'))
         order by 1, 2`,
      );
      const missing = new Set<string>();
      for (const { schema, name } of tables) {
        const table = `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
        await query(`alter table ${table} no force row level security`);
        const rows = await query<{ key: string }>(
          `select distinct policy.label_key(t.compartments) as key from ${table} t
           where policy.label_key(t.compartments) <> '' and not exists (select 1 from policy.labels l where l.key = policy.label_key(t.compartments))`,
        );
        for (const { key } of rows) missing.add(key);
      }
      return [...missing].sort();
    } finally {
      await query("rollback");
    }
  });
}

// An owner address as a sync's send-as list adds one: the owner's account row, written as
// pi_writer, and no re-derive, so a person who held the address keeps its rows until the writer's
// next rederiveIfNeeded. Admin.addOwnerAddress re-derives in its own transaction, so a test of the
// re-derive itself makes one due with this.
export async function addOwnerAddressUnderived(db: TestDatabase, address: string, compartment: string): Promise<void> {
  const owner = normalizeAddress(address);
  if (owner === null) throw new Error("not an address");
  await session(db.urls.writer, (query) =>
    inTransaction(
      query,
      async () => undefined,
      (tx) => addOwnerAddress({ query: tx, keys: db.keys }, owner, [compartment]),
      "commit",
    ),
  );
}

async function inTransaction<T>(
  query: Query,
  setup: (query: Query) => Promise<unknown>,
  fn: (query: Query) => Promise<T>,
  end: "commit" | "rollback",
): Promise<T> {
  await query("begin");
  try {
    await setup(query);
    const result = await fn(query);
    await query(end);
    return result;
  } catch (error) {
    await query("rollback");
    throw error;
  }
}

// One transaction as the role in `url`, committed, or rolled back when `fn` throws.
export const committedAs = <T>(url: string, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(url, async (query) => {
    await query("begin");
    try {
      const result = await fn(query);
      await query("commit");
      return result;
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });

// One transaction under a client's token, set as the reader sets it. `null` sets no token.
export const withToken = <T>(query: Query, token: string | null, fn: (query: Query) => Promise<T>): Promise<T> =>
  inTransaction(
    query,
    async (run) => (token === null ? [] : run("select set_config('pi.client_token', $1, true)", [token])),
    fn,
    "commit",
  );

export const readAs = <T>(db: TestDatabase, token: string | null, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(db.urls.reader, (query) => withToken(query, token, fn));

// A session the client opened through policy.open_session, and its id.
export async function openSession(db: TestDatabase, client: { token: string }): Promise<string> {
  const id = testId("ses");
  await readAs(db, client.token, (query) => query("select policy.open_session($1)", [id]));
  return id;
}

// The label policy.record_label gives the client's records.
export const recordLabelOf = async (db: TestDatabase, client: { token: string }): Promise<string[]> =>
  one(await readAs(db, client.token, (query) => query<{ label: string[] }>("select policy.record_label() as label")))
    .label;

// One transaction as pi_owner, through the bootstrap's membership. Always rolled back: it is
// for positive controls and for reads, and keeps nothing.
export const withOwner = <T>(query: Query, fn: (query: Query) => Promise<T>): Promise<T> =>
  inTransaction(query, (run) => run("set local role pi_owner"), fn, "rollback");

export const asOwner = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(db.urls.bootstrap, (query) => withOwner(query, fn));

// Statements in one committed transaction as pi_owner, through the bootstrap's membership: the
// rows only the definer functions write.
export const ownerCommitted = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    const result = await fn(query);
    await query("commit");
    return result;
  });

// One committed transaction as pi_owner, the tables' owner, that may write every row of `tables`,
// under a policy made and dropped inside the transaction. No runtime role may update a claim or a
// label column, so a test that plants a changed claim, or a row under another label, does it here.
// The tables' triggers fire as for any writer.
export const asTablesOwner = <T>(
  db: TestDatabase,
  tables: readonly string[],
  fn: (query: Query) => Promise<T>,
): Promise<T> =>
  session(db.urls.bootstrap, (query) =>
    inTransaction(
      query,
      async (run) => {
        await run("set local role pi_owner");
        for (const table of tables)
          await run(`create policy zz_test_owner on ${table} for all to pi_owner using (true) with check (true)`);
      },
      async (run) => {
        const result = await fn(run);
        for (const table of tables) await run(`drop policy zz_test_owner on ${table}`);
        return result;
      },
      "commit",
    ),
  );

// The same for knowledge.claims and knowledge.claim_entities: the admin removes a claim only through
// the removal functions.
export const asClaimsOwner = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  asTablesOwner(db, ["knowledge.claims", "knowledge.claim_entities"], fn);

// What the database refused a statement with, or null when it ran.
export async function refusal(run: () => Promise<unknown>): Promise<{ code: string; constraint?: string } | null> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") throw error;
    const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
    return { code: error.code, ...(constraint === undefined ? {} : { constraint }) };
  }
  return null;
}

// The SQLSTATE a statement fails with, or null when it ran.
export const sqlState = async (run: () => Promise<unknown>): Promise<string | null> =>
  (await refusal(run))?.code ?? null;

// The code a call was rejected with ("thrown" when it had none), or undefined when it resolved.
export const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
  return undefined;
};

// What a call threw, or undefined when it returned.
export function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

// What one statement of a runtime role was refused with, or null when it ran; the reader under a
// client's token.
export const roleState = (
  db: TestDatabase,
  token: string,
  role: (typeof RUNTIME_ROLES)[number],
  text: string,
  values?: unknown[],
): Promise<string | null> => {
  if (role === "pi_reader") return sqlState(() => readAs(db, token, (query) => query(text, values)));
  const url = {
    pi_admin: db.urls.admin,
    pi_writer: db.urls.writer,
    pi_pipeline: db.urls.pipeline,
    pi_work: db.urls.work,
    pi_proxy: db.urls.proxy,
    pi_restricted: db.urls.restricted,
  }[role];
  return sqlState(() => queryAs(url, text, values));
};

// One statement as pi_owner, the table's owner, past its forced row security and its triggers: how a
// test moves a row's time or sets a column no runtime role may.
export const ownerStatement = (url: string, text: string, values: unknown[]): Promise<unknown> =>
  session(url, async (query) => {
    const table = /^\s*(?:update|insert into) (\S+)/.exec(text)?.[1];
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`alter table ${table} disable trigger user`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} enable trigger user`);
      await query(`alter table ${table} force row level security`);
    }
  });
