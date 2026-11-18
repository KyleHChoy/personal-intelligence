import { AsyncLocalStorage } from "node:async_hooks";
import type { Timestamp } from "@intelligence/contracts";
import { CodedError, type PersonalLogger } from "@intelligence/contracts/personal";
import pg from "pg";

// A database URL, parsed. One that does not parse is refused with nothing of it: the error Node
// raises for a bad URL carries the whole of it, password included. Every part of the store
// that takes a URL reads it through here, so every connection takes its TLS from `withTls`.
export function parseDatabaseUrl(url: string): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // Refused below, without the URL.
  }
  if (parsed?.protocol !== "postgres:" && parsed?.protocol !== "postgresql:") throw new CodedError("bad_url");
  return withTls(parsed);
}

// The hosts a connection reaches without leaving the machine: the local Docker server, and a
// Unix socket (no host).
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

// TLS to a server on another host. A URL with no `sslmode` gets `verify-full`, encrypted and the
// server's certificate checked against the CA, when it names one in `sslrootcert`: the box's
// entrypoint adds it to every role's URL once the owner has put the database's CA on the volume.
// With no CA it gets `require`, encrypted and checked against nothing, which the box reports as a
// `tls_unverified` health card (`tlsUnverified`). A URL to a local host is left as it is, and so is
// any URL that names its own `sslmode`: `sslmode=disable` is the switch for a test server on
// another host that has no TLS. Every mode means what libpq says it means (`uselibpqcompat`), as
// for the deploy scripts' psql: without it, the driver takes `require` for `verify-full`, which a
// server with its own certificate fails.
export function withTls(url: URL): URL {
  const tls = new URL(url.href);
  const params = tls.searchParams;
  if (!params.has("sslmode") && !LOCAL_HOSTS.has(tls.hostname))
    params.set("sslmode", params.has("sslrootcert") ? "verify-full" : "require");
  if (params.has("sslmode") && !params.has("uselibpqcompat")) params.set("uselibpqcompat", "true");
  return tls;
}

// Whether a connection made from `url` reaches another host without checking the server's
// certificate: any mode but `verify-ca` and `verify-full`, `require` and `disable` included. A
// local URL is not, and one that does not parse is not either: it is refused before any connection.
export function tlsUnverified(url: string): boolean {
  let parsed: URL;
  try {
    parsed = parseDatabaseUrl(url);
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) return false;
  const mode = parsed.searchParams.get("sslmode");
  return mode !== "verify-full" && mode !== "verify-ca";
}

// What the writer, the reader and the admin share of the database: a pool of their own, one
// transaction on one connection, what is kept of a driver's error, and how a time and a text
// read from it are stamped and compared. Each caller brings its own statements and its own
// word for a failure; nothing here logs, and nothing here names a table.

// One statement on a connection. Every value is a bind parameter, never in the text.
export type Query = <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<Row[]>;

// The pools `ownPool` made: the only ones `endOwnPool` ends.
const made = new WeakSet<pg.Pool>();

// One limit, by what a pool is for. `timeoutMs`: a connection that is not ready, and a statement
// that has not finished, in that time fails instead of waiting. `statementMs`: the server ends any
// one statement that runs longer, so one hung job cannot stop the box. `idleInTransactionMs`: the
// server ends a session left idle inside a transaction that long, since a client that died
// mid-transaction leaves its backend, and the locks it holds, behind until then.
type PoolLimit = { timeoutMs?: number | undefined } | { statementMs: number } | { idleInTransactionMs: number };

// A pool of the store's own. A URL that does not parse is refused with a plain Error, code
// "bad_url", that holds no part of it.
export function ownPool(url: string, max: number, log: PersonalLogger, limit: PoolLimit = {}): pg.Pool {
  const limits =
    "statementMs" in limit
      ? { statement_timeout: limit.statementMs }
      : "idleInTransactionMs" in limit
        ? { idle_in_transaction_session_timeout: limit.idleInTransactionMs }
        : limit.timeoutMs !== undefined
          ? {
              connectionTimeoutMillis: limit.timeoutMs,
              statement_timeout: limit.timeoutMs,
              query_timeout: limit.timeoutMs,
            }
          : {};
  // The server's compiler is off on every connection: the store's statements are short, and a
  // read's plan holds hundreds of row-policy subplans the compiler spends seconds on.
  const pool = new pg.Pool({ connectionString: parseDatabaseUrl(url).href, max, options: "-c jit=off", ...limits });
  // An idle connection the server closed.
  pool.on("error", () => log.warn({ event: "connection_lost", code: "unavailable" }));
  made.add(pool);
  return pool;
}

// Ends a pool `ownPool` made, once. A pool the caller made is the caller's to end.
export async function endOwnPool(pool: pg.Pool): Promise<void> {
  if (made.delete(pool)) await pool.end();
}

// pg-pool takes its own listener off a client it hands out, and an `error` event that nobody
// listens for ends the process. The loss itself shows as the failure of the next statement on
// that connection, which is what the caller is told; this only keeps the event from being
// uncaught.
export const connectionLost = (): void => {};

// The statements that open, keep and undo a transaction. With `hold`, a session lock taken
// before `begin` and given back after the transaction ends, so that a repeatable-read snapshot is
// taken only once the lock is granted.
export type Transaction = { begin: string; commit: string; rollback: string; hold?: { take: string; give: string } };

// The writer's and the admin's. Read committed, set explicitly rather than left to the server's
// default: a deletion's second pass over agent records must see every append that committed
// before its taint lock.
export const TRANSACTION: Transaction = {
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  commit: "commit",
  rollback: "rollback",
};

// What one tool call's work took, for the agent API's `tool_work` log line: the statements it sent,
// their time, and its wait for a connection. Each call has its own, by the async context it runs
// in; none is kept once the call ends. The line is written only where no client reads the log: this
// is the time the reply's deadline hides.
type StatementTally = { statements: number; sqlMs: number; waitMs: number };
const tally = new AsyncLocalStorage<StatementTally>();
export async function tallied<T>(fn: () => Promise<T>): Promise<{ value: T; tally: StatementTally }> {
  const counted: StatementTally = { statements: 0, sqlMs: 0, waitMs: 0 };
  return { value: await tally.run(counted, fn), tally: counted };
}

// One transaction on one connection of the pool: it commits whole or not at all. `failed` makes
// what the caller is told of a driver's error, for the connection and for every statement, so
// the driver's own error goes no further than here. An error `fn` throws is passed on as it is.
// `fn` is also given the connection's server process id, as the driver recorded it at connect,
// or null when it has none: the reader cancels its own statement by it (read-db.ts).
export async function inTransaction<T>(
  pool: pg.Pool,
  statements: Transaction,
  failed: (error: unknown) => Error,
  fn: (query: Query, backend: number | null) => Promise<T>,
): Promise<T> {
  const counted = tally.getStore();
  const asked = performance.now();
  const client = await pool
    .connect()
    .catch((error: unknown) => {
      throw failed(error);
    })
    .finally(() => {
      if (counted !== undefined) counted.waitMs += performance.now() - asked;
    });
  // A wrapped client may have no events.
  const listening = typeof client.on === "function";
  if (listening) client.on("error", connectionLost);
  // Every statement on this connection, the closing ones too, goes through here to be counted.
  const direct = async (text: string, values: unknown[] = []): Promise<pg.QueryResult> => {
    const sent = performance.now();
    try {
      return await client.query(text, values);
    } finally {
      if (counted !== undefined) {
        counted.statements += 1;
        counted.sqlMs += performance.now() - sent;
      }
    }
  };
  const query: Query = async <Row>(text: string, values: unknown[] = []) => {
    try {
      return (await direct(text, values)).rows as Row[];
    } catch (error) {
      throw failed(error);
    }
  };
  // A connection that cannot give back its held lock, like one that cannot roll back, is closed,
  // not reused: nothing set on it may outlive it. It keeps its listener: a lost connection may
  // have more to say.
  const end = async (broken: boolean): Promise<void> => {
    const hold = statements.hold;
    const lost =
      broken ||
      (hold !== undefined &&
        (await direct(hold.give).then(
          () => false,
          () => true,
        )));
    if (lost) client.release(true);
    else {
      if (listening) client.removeListener("error", connectionLost);
      client.release();
    }
  };
  try {
    if (statements.hold !== undefined) await query(statements.hold.take);
    await query(statements.begin);
    const { processID } = client as { processID?: unknown };
    const result = await fn(query, typeof processID === "number" ? processID : null);
    await query(statements.commit);
    await end(false);
    return result;
  } catch (error) {
    const broken = await direct(statements.rollback).then(
      () => false,
      () => true,
    );
    await end(broken);
    throw error;
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

// All that is kept of a driver's error: its SQLSTATE and the name of a constraint, each
// undefined unless the server gave it. Its message, its detail and its context can quote a
// bound value, and an error's cause is printed when the error is.
export function driverError(error: unknown): { sqlstate: string | undefined; constraint: string | undefined } {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return {
    sqlstate: typeof code === "string" && SQLSTATE.test(code) ? code : undefined,
    constraint: typeof constraint === "string" ? constraint : undefined,
  };
}

// The SQLSTATE a query's wrapper kept in the error it threw: in its cause, never in its code.
export const sqlstateOf = (error: unknown): string | undefined => {
  const sqlstate = (error as { cause?: { sqlstate?: unknown } } | null)?.cause?.sqlstate;
  return typeof sqlstate === "string" ? sqlstate : undefined;
};

export const stamp = (at: Date): Timestamp => at.toISOString();
export const stampOrNull = (at: Date | null): Timestamp | null => (at === null ? null : stamp(at));

// Text compares by code unit, as the database sorts an id or a name under the "C" collation.
export { byText } from "@intelligence/personal-core";
