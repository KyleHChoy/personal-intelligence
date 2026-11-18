// Loggers and pools that record what they are given.
import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import pg from "pg";

export type LoggedCall = { level: "info" | "warn" | "error"; event: PersonalLogEvent };

export function recordingLogger(): { log: PersonalLogger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const at =
    (level: LoggedCall["level"]) =>
    (event: PersonalLogEvent): void =>
      void calls.push({ level, event });
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, calls };
}

// ---------------------------------------------------------------------------------------------
// recordingPool and eventLogger
// ---------------------------------------------------------------------------------------------

type QueryArguments = [text: unknown, ...rest: unknown[]];

// The taint lock a reader or Work call holds shared around its transaction: its first statement and
// its last.
export const HOLD_TAKE = "select pg_advisory_lock_shared(hashtext('intelligence personal ledger taint'))";
export const HOLD_GIVE = "select pg_advisory_unlock_shared(hashtext('intelligence personal ledger taint'))";

// A call's statements inside its taint hold: the first and the last are checked to be the hold's,
// and taken off.
export function insideHold(statements: string[]): string[] {
  if (statements[0] !== HOLD_TAKE || statements.at(-1) !== HOLD_GIVE)
    throw new Error("the call did not hold the taint lock around its transaction");
  return statements.slice(1, -1);
}

const textOf = (first: unknown): string =>
  typeof first === "string" ? first : String((first as { text?: unknown }).text ?? "");

// Wraps a pool and records the text of every query sent through it, on the pool itself and on every
// client it hands out. The reader and the admin use only pool.connect(), client.query(text, values)
// and client.release(), so nothing they send goes unrecorded. With `rejectWhen`, a query whose text
// it accepts is recorded and then rejected without reaching the database, as a database error would
// be. With `holdWhen` (the memory adapters' concurrency tests), the first query whose text it
// accepts is recorded and then held, not yet sent, until the test calls `held.release()`;
// `held.reached` settles when it is held, so the test knows where the call stopped.
export function recordingPool(
  pool: pg.Pool,
  options?: { rejectWhen?: (text: string) => boolean; holdWhen?: (text: string) => boolean },
): { pool: pg.Pool; statements: string[]; held: { reached: Promise<void>; release: () => void } } {
  const statements: string[] = [];
  let reach = (): void => {};
  let release = (): void => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = options?.holdWhen !== undefined;

  const run = (target: { query: (...args: never[]) => unknown }, args: QueryArguments): unknown => {
    const text = textOf(args[0]);
    statements.push(text);
    if (options?.rejectWhen?.(text) === true) {
      // An SQLSTATE and a message, neither of which may reach an answer or a log.
      return Promise.reject(Object.assign(new Error("canary-database-error"), { code: "57P01" }));
    }
    if (holding && options?.holdWhen?.(text) === true) {
      holding = false;
      reach();
      return released.then(() => target.query(...(args as unknown as never[])));
    }
    return target.query(...(args as unknown as never[]));
  };

  const passed = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };

  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get: (target, property) =>
        property === "query" ? (...args: QueryArguments) => run(target, args) : passed(target, property),
    });

  const wrapped = new Proxy(pool, {
    get: (target, property) => {
      if (property === "query") return (...args: QueryArguments) => run(target, args);
      if (property === "connect") {
        return async (...args: unknown[]) => {
          // A callback would hand out a client this wrapper never saw.
          if (args.length > 0) throw new Error("recordingPool: connect() takes no callback");
          return wrapClient(await target.connect());
        };
      }
      return passed(target, property);
    },
  });

  return { pool: wrapped, statements, held: { reached, release } };
}

export type SentStatement = { text: string; values: unknown[]; rows: number };

// The pool wrapper for the writer, which makes its own pool and so has none to wrap: while `fn`
// runs, every statement any `pg.Client` of this process sends is recorded with its values and,
// once it has answered, how many rows it brought back. Restored when `fn` settles. Call nothing
// else that queries inside `fn`: it would be recorded too.
export async function recordingStatements<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; statements: SentStatement[] }> {
  const statements: SentStatement[] = [];
  const original = pg.Client.prototype.query;
  const recorded = function (this: pg.Client, ...args: unknown[]): unknown {
    const [first, second] = args;
    const config = typeof first === "object" && first !== null ? (first as { values?: unknown }) : {};
    const values = Array.isArray(second) ? second : Array.isArray(config.values) ? config.values : [];
    const statement: SentStatement = { text: textOf(first), values: [...values], rows: 0 };
    statements.push(statement);
    // A pool's own `query` hands the client a callback and gets no promise back.
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (error: unknown, answer?: { rows?: unknown[] }): void => {
        statement.rows = answer?.rows?.length ?? 0;
        (last as (error: unknown, answer?: unknown) => void)(error, answer);
      };
    }
    const sent: unknown = (original as (...given: unknown[]) => unknown).apply(this, args);
    if (sent instanceof Promise)
      void sent.then(
        (answer: { rows?: unknown[] }) => (statement.rows = answer?.rows?.length ?? 0),
        () => undefined,
      );
    return sent;
  };
  pg.Client.prototype.query = recorded as typeof original;
  try {
    return { result: await fn(), statements };
  } finally {
    pg.Client.prototype.query = original;
  }
}

// Whether a statement's text names a sealed column, a blob's envelope, or every column at once:
// a `*` in a select list or a returning list, alone or as `t.*`. A `count(*)` is not, and neither
// is a product (`days * 24`), which opens nothing. Comments are no part of a statement, so a `*`
// behind one is still the list's; and a `distinct on (...)` is read as the `distinct` it is, so
// the `*` after its closing bracket is not taken for a product.
export const namesSealed = (text: string): boolean =>
  /_enc\b|\benvelope\b|(?:\.|,|\b(?:select|returning|distinct|all))\s*\*/i.test(
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
      .replaceAll(/--[^\n]*/g, " ")
      .replaceAll(/count\s*\(\s*\*\s*\)/gi, "count()")
      .replaceAll(/\bdistinct\s+on\s*\((?:[^()]|\([^()]*\))*\)/gi, "distinct"),
  );

// A `recordingLogger(): PersonalLogger & { events }` under another name: the `recordingLogger`
// above has that name and another shape, and this one is built on it. `events`
// is every event logged so far, at any level, in order.
export function eventLogger(): PersonalLogger & { readonly events: PersonalLogEvent[] } {
  const { log, calls } = recordingLogger();
  return {
    ...log,
    get events(): PersonalLogEvent[] {
      return calls.map((call) => call.event);
    },
  };
}
