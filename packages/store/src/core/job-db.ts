import { CodedError, type PersonalLogger } from "@intelligence/contracts/personal";
import {
  connectionLost,
  driverError,
  inTransaction,
  ownPool,
  type Query,
  TRANSACTION,
  type Transaction,
} from "./db.ts";
import { unavailable } from "./tx.ts";

// The writer's connections. Every value goes to the database as a bind parameter, never in the
// text of a statement. The pool, the transaction and what is kept of a driver's error are the
// store's own (db.ts); the session that holds the sync lock is the writer's alone.

export type Db = {
  query: Query;
  // One transaction: it commits whole or not at all. No savepoints. `statements` other than read
  // committed's: the trigger pass's, at repeatable read, begun under a held lock.
  transaction<T>(fn: (query: Query) => Promise<T>, statements?: Transaction): Promise<T>;
  // One connection of its own for the length of `fn`, closed after it, so whatever the session
  // held (an advisory lock) is released with it. `lost` says whether that connection has gone,
  // without asking the server: once it has, the session's statements fail as `unavailable`.
  session<T>(fn: (query: Query, lost: () => boolean) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

// A driver error of SQLSTATE class 22 (a bad value) or 23 (a constraint): the same call would
// fail the same way again.
const REFUSED = /^2[23][0-9A-Z]{3}$/;

// The job roles' pools (sync's writer, extraction's pipeline, the tick's work
// role, the notice sender's, the night's stores) end any one statement past five minutes, so a
// statement that never answers ends its job, `unavailable`, rather than holding the box; the timer's
// own limit on the job is the backstop.
const JOB_STATEMENT_TIMEOUT_MS = 5 * 60_000;

export function createDb(url: string, log: PersonalLogger): Db {
  const pool = ownPool(url, 4, log, { statementMs: JOB_STATEMENT_TIMEOUT_MS });

  // What a caller is told of a database error: `write_refused` for a value or a constraint the
  // database refused, which no retry mends, and `unavailable` for everything else. An SQLSTATE
  // is never a code. The driver's error goes no further than here: its message, detail and
  // context can quote a bound value, and an error's cause is printed when the error is. The
  // cause is a small object of this function's own, with the SQLSTATE and the constraint's name
  // when the server gave them. The log line carries the code alone.
  const failure = (error: unknown): Error => {
    const { sqlstate, constraint } = driverError(error);
    const code = sqlstate !== undefined && REFUSED.test(sqlstate) ? "write_refused" : "unavailable";
    log.error({ event: "write_failed", code });
    const cause = {
      ...(sqlstate === undefined ? {} : { sqlstate }),
      ...(constraint === undefined ? {} : { constraint }),
    };
    return new CodedError(code, { cause });
  };

  return {
    // One statement on any connection of the pool.
    async query<Row>(text: string, values?: unknown[]) {
      try {
        return (await pool.query(text, values)).rows as Row[];
      } catch (error) {
        throw failure(error);
      }
    },
    transaction: (fn, statements = TRANSACTION) => inTransaction(pool, statements, failure, fn),
    async session(fn) {
      // Listened to for as long as it is out of the pool.
      const client = await pool.connect().catch((error: unknown) => {
        throw failure(error);
      });
      client.on("error", connectionLost);
      // The loss is noted when the connection says so, which may be long before anything is
      // asked of it, and logged once.
      let lost = false;
      const note = (): void => {
        if (lost) return;
        lost = true;
        log.warn({ event: "connection_lost", code: "unavailable" });
      };
      client.on("error", note);
      client.on("end", note);
      const query: Query = async <Row>(text: string, values?: unknown[]) => {
        if (lost) throw unavailable();
        try {
          return (await client.query(text, values)).rows as Row[];
        } catch (error) {
          // A statement the loss itself ended: already logged.
          if (lost) throw unavailable();
          throw failure(error);
        }
      };
      try {
        return await fn(query, () => lost);
      } finally {
        client.removeListener("error", note);
        client.removeListener("end", note);
        client.removeListener("error", connectionLost);
        client.release(true);
      }
    },
    close: () => pool.end(),
  };
}
