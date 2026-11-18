// A test's database, writer and store, and SQL as a role where the plan asks for it.

import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import pg from "pg";
import { Admin } from "../admin/admin.ts";
import { openUnder } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { KNOWLEDGE } from "./catalogue-grants.ts";
import { one, readAs } from "./connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "./database.ts";
import { eventLogger, type LoggedCall, recordingLogger, recordingPool } from "./recording.ts";

// ---------------------------------------------------------------------------------------------
// A database, and a writer on it
// ---------------------------------------------------------------------------------------------

type DatabaseOptions = NonNullable<Parameters<typeof createTestDatabase>[0]>;

// A test database of its own, dropped when `fn` settles. `fn` ends every pool and writer it
// opens before it returns: the forced drop cannot end a pi_* connection.
export async function withDatabase<T>(fn: (db: TestDatabase) => Promise<T>, options: DatabaseOptions = {}): Promise<T> {
  const db = await createTestDatabase(options);
  try {
    return await fn(db);
  } finally {
    await db.drop();
  }
}

export type Store = { db: TestDatabase; writer: Writer; logged: LoggedCall[] };

// A writer on a database, closed when `fn` settles.
export async function withWriter<T>(
  db: TestDatabase,
  fn: (writer: Writer, logged: LoggedCall[]) => Promise<T>,
): Promise<T> {
  const { log, calls } = recordingLogger();
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  try {
    return await fn(writer, calls);
  } finally {
    await writer.close();
  }
}

// A test database with one writer on it: the writer is closed, then the database dropped.
export const withStore = <T>(fn: (store: Store) => Promise<T>, options: DatabaseOptions = {}): Promise<T> =>
  withDatabase((db) => withWriter(db, (writer, logged) => fn({ db, writer, logged })), options);

// ---------------------------------------------------------------------------------------------
// A test's store: its database, and one admin, reader and writer on it
// ---------------------------------------------------------------------------------------------

export type TestStore = {
  db: TestDatabase;
  log: PersonalLogger & { readonly events: PersonalLogEvent[] };
  now: Date;
  adminPool: pg.Pool;
  readerPool: pg.Pool;
  admin: Admin;
  reader: Reader;
  // Throws when the store was opened with `writer: false`.
  writer: Writer;
  // Ends the writer and both pools, then drops the database.
  close(): Promise<void>;
};

// A database of its own, with the admin and the reader on pools this test owns. `now` is the
// clock handed to the reader and the admin. If any part fails to open, what did open is closed
// and the database dropped before the failure is thrown.
export async function openStore(options?: {
  compartments?: string[];
  restricted?: NonNullable<DatabaseOptions["restricted"]>;
  keyFile?: string;
  now?: Date;
  readerMax?: number;
  writer?: boolean;
}): Promise<TestStore> {
  const db = await createTestDatabase({
    ...(options?.compartments === undefined ? {} : { compartments: options.compartments }),
    ...(options?.keyFile === undefined ? {} : { keyFile: options.keyFile }),
    ...(options?.restricted === undefined ? {} : { restricted: options.restricted }),
  });
  const closers: (() => Promise<void>)[] = [];
  const close = async (): Promise<void> => {
    for (const end of closers.reverse()) await end().catch(() => {});
    closers.length = 0;
    await db.drop();
  };
  try {
    const log = eventLogger();
    const now = options?.now ?? new Date();
    const clock = options?.now === undefined ? {} : { now: () => now };

    // A connection timeout, so a client that was never released fails the next call and does not hang it.
    const adminPool = new pg.Pool({ connectionString: db.urls.admin, max: 2, connectionTimeoutMillis: 20_000 });
    closers.push(() => adminPool.end());
    const readerPool = new pg.Pool({
      connectionString: db.urls.reader,
      max: options?.readerMax ?? 2,
      connectionTimeoutMillis: 20_000,
    });
    closers.push(() => readerPool.end());

    let writer: Writer | undefined;
    if (options?.writer !== false) {
      const made = createWriter({ url: db.urls.writer, keys: db.keys, log });
      closers.push(() => made.close());
      writer = made;
    }

    const admin = new Admin({ pool: adminPool, keys: db.keys, log, ...clock });
    const reader = new Reader({ pool: readerPool, keys: db.keys, log, ...clock });

    return {
      db,
      log,
      now,
      adminPool,
      readerPool,
      admin,
      reader,
      get writer(): Writer {
        if (writer === undefined) throw new Error("this store was opened without a writer");
        return writer;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// A store opened with `options` for `fn`, closed when `fn` settles.
export async function inStore<T>(
  options: Parameters<typeof openStore>[0],
  fn: (store: TestStore) => Promise<T>,
): Promise<T> {
  const store = await openStore(options);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

// The id of the stored event with this title, opened from its sealed title.
export async function eventIdOf(store: TestStore, title: string): Promise<string> {
  const rows = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
    store.db.urls.admin,
    "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
  );
  const found = rows.find(
    (row) =>
      row.title_enc !== null &&
      openUnder(
        store.db.keys,
        row.compartments,
        { table: "knowledge.event_details", id: row.id, column: "title_enc" },
        row.title_enc as never,
      ) === title,
  );
  if (found === undefined) throw new Error(`no event titled ${title}`);
  return found.id;
}

// A reader on a recording pool over the store's own reader pool, and `during`, which runs one
// call and returns its answer with the statements it sent.
export function recordingReader(store: TestStore) {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: [...recorded.statements] };
  };
  return { reader, during };
}

// ---------------------------------------------------------------------------------------------
// SQL as a role, where the plan asks for it
// ---------------------------------------------------------------------------------------------

// The knowledge tables the catalogue lists, so a table added later is never passed over.
export async function knowledgeTables(adminUrl: string): Promise<string[]> {
  const rows = await queryAs<{ name: string }>(
    adminUrl,
    "select 'knowledge.' || tablename as name from pg_tables where schemaname = 'knowledge' order by 1",
  );
  return rows.map((row) => row.name);
}

// How many rows of each knowledge table pi_reader has a policy on (KNOWLEDGE) it sees inside one
// transaction that carries the token, by one named column of each (the reader may read only `id` and `kind` of an entity).
// With `null`, no token is set at all.
export const knowledgeRowsAs = (db: TestDatabase, token: string | null): Promise<Record<string, number>> =>
  readAs(db, token, async (query) => {
    const seen: Record<string, number> = {};
    for (const table of KNOWLEDGE) seen[table.name] = (await query(`select ${table.column} from ${table.name}`)).length;
    return seen;
  });

// What a pool's next connection shows once a call has ended, with no token set by the test: the
// backend it is, how many account rows it sees, the token setting left on it, and whether it is
// outside any transaction (inside one that an earlier statement began, now() is older than the
// statement). A connection left in a failed transaction refuses the query, and this throws.
export async function leftOn(
  pool: pg.Pool,
): Promise<{ backend: number; accounts: number; token: string; idle: boolean }> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ backend: number; accounts: number; token: string; idle: boolean }>(
      `select pg_backend_pid() as backend, (select count(*)::int from knowledge.accounts) as accounts,
              coalesce(current_setting('pi.client_token', true), '') as token, now() = statement_timestamp() as idle`,
    );
    return one(rows);
  } finally {
    client.release();
  }
}

export type CallRow = { client: string; tool: string; rows: number; outcome: string };

// The call log, oldest first, read as pi_admin.
export function callLog(adminUrl: string): Promise<CallRow[]> {
  return queryAs<CallRow>(
    adminUrl,
    `select k.name as client, c.tool, c.rows, c.outcome
     from policy.calls c join policy.clients k on k.id = c.client_id
     order by c.id`,
  );
}
