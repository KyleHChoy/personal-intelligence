import type {
  ClientId,
  ClientView,
  PersonalLogger,
  PersonalTool,
  PersonalView,
  ReadOutcome,
  RefusalWhy,
  SessionId,
} from "@intelligence/contracts/personal";
import type pg from "pg";
import { inTransaction, type Query, type Transaction } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { TAINT_HOLD } from "../core/locks.ts";
import { type Ctx, type ReadSet, type Run, Unavailable } from "../core/read-ctx.ts";
import { clientKeys } from "../core/served.ts";
import type { Sessions } from "../core/sessions.ts";

// What the reader's queries run on: one transaction
// under one client's token, as pi_reader. Row-level security returns only the rows the token is
// cleared for, so no query here names a compartment, and nothing here sees a row it filtered.
// The keys are those of the client's compartments alone, so a row of any other would not open.

// The one call path: every tool call of the Reader and of Work runs through withClient.

// One snapshot for a whole read: a sync that commits in the middle of it changes nothing the
// call reads, so one answer never disagrees with itself. A work write is read committed: under
// one snapshot, two claims at once would be a serialization failure.
const ISOLATION: Record<Isolation, Transaction> = {
  "repeatable read": { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ", commit: "COMMIT", rollback: "ROLLBACK" },
  "read committed": { begin: "BEGIN ISOLATION LEVEL READ COMMITTED", commit: "COMMIT", rollback: "ROLLBACK" },
};
export type Isolation = "repeatable read" | "read committed";

// The taint lock shared, held from before the transaction begins until
// after it ends. An erasure takes it alone, so it
// waits for every call in flight, and then links the exposures their read logs wrote; a call
// that starts while an erasure holds it waits, and its snapshot, taken only once the lock is
// granted, sees the erasure. A transaction-scoped lock would not do under repeatable read: the
// statement that took it would take the snapshot before the lock was granted. Taken first, as
// every ledger writer takes it; nothing a call locks after it is a row an erasure locks before
// the lock alone, so no cycle.

// For this transaction only: the setting is gone at its end. The token is set only in a session
// the row policies hold to a client's clearance; in any other it stays empty, no client is
// found, and the call is refused as any unknown token is. Three things must hold, in one
// statement with one text for every token:
// - `session_user` is pi_reader. It is the role that logged in, which `set role` cannot change,
//   so a privileged login that then set its role to pi_reader (and could reset it) is refused.
// - `current_user` is pi_reader, so a pi_reader login acting as any other role is refused too.
// - Row security is active for it. A name is not the property: a role named pi_reader that was
//   made a superuser, or given BYPASSRLS, would read every row. Either turns row security off
//   for every table at once, so one table shows it; the one asked about is `policy.clients`,
//   which pi_reader cannot read, so that a refused call still names nothing in `knowledge`.
// The second `when` is reached only by pi_reader: the branches of a `case` are tried in order,
// where the terms of an `and` are not. If that table is missing, or its schema is closed to
// pi_reader, the statement fails and the call answers `unavailable`.
// The same statement sets enable_seqscan off for the transaction, so the
// count of statements on every path stays as it was. That setting is a cost penalty on a
// sequential scan, not a ban: the planner still takes one when it finds no other path. It is best
// effort that a labelled table is reached by an index led by the label key, so that the work of a
// call follows the rows its client can see; the plan-shape test I3
// (core/reader-work-plans.db.slow-test.ts, its rule in core/plan-faults.test.ts) is what pins each
// reader statement's plan.
// This is the one copy of this statement in the store; the invariant 6 tests replay it by name.
export const SET_TOKEN =
  "select set_config('pi.client_token', case when session_user <> 'pi_reader' or current_user <> 'pi_reader' then '' when row_security_active('policy.clients') then $1 else '' end, true), set_config('enable_seqscan', 'off', true)";
const CURRENT_CLIENT = "select id, name, compartments, views, tools from policy.current_client()";
const LOG_CALL = "select policy.log_call($1, $2, $3)";
// With the code points of text the call served.
const LOG_CALL_CHARS = "select policy.log_call($1, $2, $3, $4)";
// Why a refused call is logged so: a claim check's own code; for an invalid_request, what the agent
// API said, else the store's; any other code has no why of its own.
export const whyOf = (outcome: ReadOutcome<unknown>, why?: RefusalWhy): RefusalWhy | undefined => {
  if (outcome.ok) return undefined;
  if (outcome.refusal !== undefined) return { reason: outcome.refusal };
  return outcome.code === "invalid_request" ? (why ?? { reason: "store" }) : undefined;
};
// With why it was refused: fixed codes alone.
const LOG_CALL_WHY = "select policy.log_call($1, $2, $3, $4::text, $5::text)";
const OPEN_SESSION = "select policy.open_session($1)";
// With the goal ids the call returned, and the lessons its briefs served.
const LOG_READ = "select policy.log_read($1, $2, $3, $4, $5, $6, $7)";
// For a call with a signal: the transaction's own backend, asked only
// when the driver has not recorded it, and its cancel, sent on another connection of the pool
// when the signal is aborted. pi_reader may cancel a backend of its own role.
const BACKEND = "select pg_backend_pid() as pid";
const CANCEL = "select pg_cancel_backend($1)";
// The most entries of one list in one read log row; a longer read set is logged as several rows.
const READ_LOG_ROW = 1000;

// What a call logs: its read set, and the lesson ids a work brief served.
type LoggedRead = ReadSet & { lessons?: string[] };

// A read set as read log rows: each list cut into slices of at most READ_LOG_ROW entries, and
// one row with five empty lists for a call that returned nothing by id.
function readLogRows(read: LoggedRead): Required<LoggedRead>[] {
  const goals = read.goals ?? [];
  const lessons = read.lessons ?? [];
  const count = Math.max(
    1,
    ...[read.bound, read.shown, read.factKeyFps, goals, lessons].map((list) => Math.ceil(list.length / READ_LOG_ROW)),
  );
  const slice = (list: string[], index: number): string[] =>
    list.slice(index * READ_LOG_ROW, (index + 1) * READ_LOG_ROW);
  return Array.from({ length: count }, (_, index) => ({
    bound: slice(read.bound, index),
    shown: slice(read.shown, index),
    factKeyFps: slice(read.factKeyFps, index),
    goals: slice(goals, index),
    lessons: slice(lessons, index),
  }));
}

// What withClient is bound to: the pool, the keys, the logger and the remembered sessions of
// one process, and what runs first in every transaction (the reader's erasure check).
export type ClientPath = {
  pool: pg.Pool;
  keys: Keys;
  log: PersonalLogger;
  sessions: Sessions;
  first?: (query: Query) => Promise<void>;
  // A pinned clock, given to every Ctx: a test's; a deployed reader gives none.
  now?: () => Date;
};

// What a call is given inside its transaction: the token's client, or null when the token is
// empty, unknown or revoked (all three take this one path); its statements; its Ctx; and the
// read log and the call log.
export type ClientCall = {
  client: ClientView | null;
  run: Run;
  // The keys of the client's compartments and no other, and its session.
  ctx(client: ClientView): Ctx;
  // What an ok call returned by id, after the tool's last query and before its call log row.
  logRead(ctx: Ctx, tool: string, read: LoggedRead): Promise<void>;
  // With `chars`, the code points of text a text tool served.
  logCall(tool: string, rows: number, outcome: string, chars?: number, why?: RefusalWhy): Promise<void>;
  // The call's session is to be forgotten once the call commits: a write it holds was refused for a
  // read of removed evidence.
  renewSession(): void;
};

// What is kept of a driver's error: its SQLSTATE, and whether a PL/pgSQL `raise` made it.
const unavailableOf = (error: unknown): Unavailable => {
  const { code, routine } = (error ?? {}) as { code?: unknown; routine?: unknown };
  return new Unavailable(typeof code === "string" ? code : undefined, routine === "exec_stmt_raise");
};

// One transaction under one token. A database error, or a value that does not open, rolls back
// and throws Unavailable; nothing of a statement, its values or the SQLSTATE leaves the store. A
// connection that cannot roll back is closed, not reused: its token must not outlive it. A
// session the transaction opened is remembered only once the transaction commits. The
// remembered sessions are read before the transaction takes its snapshot, so a session it is
// given is visible to that snapshot.
//
// With a `signal`: one aborted before the call sends no statement, and
// one aborted during it cancels the statement running, refuses every later one and rolls back
// instead of committing. Each throws Unavailable. Two limits. An abort that comes while COMMIT is
// already on its way cannot undo it: the agent API answers `unavailable` all the same, and a
// retry by request id answers what was written. And pg_cancel_backend only signals the backend:
// one that lands after its statement ended can fail the ROLLBACK, and inTransaction then closes
// that connection instead of reusing it. The cancel's own statement has returned before this does.
// With `lock`, that statement runs before any other the call makes (sync_memory's shared taint
// lock, under read committed), and an abort cancels it as it cancels any other; without, the
// call holds the taint lock shared around its transaction, taken before the signal is watched.
export async function withClient<T>(
  path: ClientPath,
  token: string,
  options: CallShape,
  fn: (call: ClientCall) => Promise<T>,
): Promise<T> {
  const { signal } = options;
  if (signal?.aborted === true) throw new Unavailable();
  const opened: { client?: ClientId; session?: Promise<SessionId> } = {};
  let renewal: { client: ClientId; session: SessionId } | undefined;
  const known = path.sessions.known();
  let cancelled: Promise<unknown> | undefined;
  let stop = (): void => {};
  const transaction =
    options.lock === undefined ? { ...ISOLATION[options.isolation], hold: TAINT_HOLD } : ISOLATION[options.isolation];
  const result = await inTransaction(path.pool, transaction, unavailableOf, async (query, recorded) => {
    let run: Query = query;
    if (signal !== undefined) {
      const backend = recorded ?? (await query<{ pid: number }>(BACKEND, []))[0]?.pid;
      const cancel = (): void => {
        cancelled = path.pool.query(CANCEL, [backend]).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      stop = () => signal.removeEventListener("abort", cancel);
      run = async <Row>(text: string, values: unknown[] = []): Promise<Row[]> => {
        if (signal.aborted) throw new Unavailable();
        return query<Row>(text, values);
      };
    }
    if (options.lock !== undefined) await run(options.lock, []);
    if (path.first !== undefined) await path.first(run);
    // A token the server could not take as text is no token.
    await run(SET_TOKEN, [typeof token === "string" && !token.includes("\0") ? token : ""]);
    const [row] = await run<ClientView>(CURRENT_CLIENT, []);
    const client =
      row === undefined
        ? null
        : {
            id: row.id as ClientId,
            name: row.name,
            compartments: row.compartments,
            views: row.views,
            tools: row.tools,
          };
    const ctx = (one: ClientView): Ctx => {
      const session = (): Promise<SessionId> => {
        const remembered = known.get(one.id);
        if (remembered !== undefined) return Promise.resolve(remembered);
        opened.client = one.id;
        opened.session ??= (async () => {
          const id = newId("ses") as SessionId;
          await run(OPEN_SESSION, [id]);
          return id;
        })();
        return opened.session;
      };
      return {
        run,
        keys: clientKeys(path.keys, one.compartments),
        session,
        log: path.log,
        served: { shown: new Set(), factKeyFps: new Set() },
        groups: {},
        ...(path.now === undefined ? {} : { now: path.now }),
      };
    };
    const logRead = async (one: Ctx, tool: string, given: LoggedRead): Promise<void> => {
      const id = await one.session();
      const served = one.served;
      const read =
        served === undefined
          ? given
          : {
              ...given,
              shown: [...new Set([...given.shown, ...served.shown])],
              factKeyFps: [...new Set([...given.factKeyFps, ...served.factKeyFps])],
            };
      for (const slice of readLogRows(read))
        await run(LOG_READ, [id, tool, slice.bound, slice.shown, slice.factKeyFps, slice.goals, slice.lessons]);
    };
    const logCall = async (
      tool: string,
      rows: number,
      outcome: string,
      chars?: number,
      why?: RefusalWhy,
    ): Promise<void> => {
      if (why !== undefined && outcome !== "ok") {
        await run(LOG_CALL_WHY, [tool, rows, outcome, why.reason, why.field ?? null]);
        return;
      }
      await (chars === undefined
        ? run(LOG_CALL, [tool, rows, outcome])
        : run(LOG_CALL_CHARS, [tool, rows, outcome, chars]));
    };
    const renewSession = (): void => {
      const remembered = client === null ? undefined : known.get(client.id);
      if (client !== null && remembered !== undefined) renewal = { client: client.id, session: remembered };
    };
    const value = await fn({ client, run, ctx, logRead, logCall, renewSession });
    // Aborted after the call's last statement: rolled back, never committed.
    if (signal?.aborted === true) throw new Unavailable();
    return value;
  }).finally(async () => {
    stop();
    await cancelled;
  });
  if (opened.client !== undefined && opened.session !== undefined)
    path.sessions.remember(opened.client, await opened.session);
  // Once it committed, as a session is remembered.
  if (renewal !== undefined) path.sessions.forget(renewal.client, renewal.session);
  return result;
}

export type CallShape = { isolation: Isolation; signal?: AbortSignal | undefined; lock?: string };

// What runs a call under a token: the Reader and Work, through withClient.
export type ClientRunner = {
  withClient<R>(token: string, shape: CallShape, fn: (call: ClientCall) => Promise<R>): Promise<R>;
};

// One tool at the gate: its name, the view it needs (null for a tool with none), its arguments'
// parse, and why a refusal there is logged so.
export type GateTool<A, T> = {
  name: PersonalTool;
  view: PersonalView | null;
  parse: () => A | null;
  why?: (outcome: ReadOutcome<T>) => RefusalWhy | undefined;
};

// What a tool's work answers, for the call row that follows it. `code` is the row's outcome where it
// is not the answer's; `chars` goes on an ok row alone; `why` wins over the tool's own. `unlogged`
// leaves no row at all.
export type Served<T> = {
  outcome: ReadOutcome<T>;
  rows: number;
  chars?: number | undefined;
  code?: string | undefined;
  why?: RefusalWhy | undefined;
  unlogged?: boolean;
};

export type GateWork<A, T> = (call: ClientCall & { client: ClientView }, args: A) => Promise<Served<T>>;

// One tool call, whichever port it comes from: a token with no current client writes nothing and
// reads nothing; then the tool and its view, then the arguments, each refusal one call row; then the
// work; then the session it asked renewed, and the call row. Every tool call passes here, so the view
// check and the call log are one rule. Unavailable, from a database error or a value that does not
// open, rolls back: `failed` logs it and the caller is told so.
export async function toolCall<A, T>(
  through: ClientRunner,
  failed: () => void,
  token: string,
  shape: CallShape,
  tool: GateTool<A, T>,
  work: GateWork<A, T>,
): Promise<ReadOutcome<T>> {
  try {
    return await through.withClient(token, shape, async (call): Promise<ReadOutcome<T>> => {
      const { client } = call;
      if (client === null) return { ok: false, code: "unauthorized" };
      const args = tool.parse();
      const served: Served<T> =
        !client.tools.includes(tool.name) || (tool.view !== null && !client.views.includes(tool.view))
          ? { outcome: { ok: false, code: "not_permitted" }, rows: 0 }
          : args === null
            ? { outcome: { ok: false, code: "invalid_request" }, rows: 0 }
            : await work({ ...call, client }, args);
      const { outcome } = served;
      if (served.unlogged === true) return outcome;
      if (!outcome.ok && outcome.refusal === "session_renewed") call.renewSession();
      await call.logCall(
        tool.name,
        served.rows,
        served.code ?? (outcome.ok ? "ok" : outcome.code),
        outcome.ok ? served.chars : undefined,
        served.why ?? tool.why?.(outcome),
      );
      return outcome;
    });
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    failed();
    return { ok: false, code: "unavailable" };
  }
}

// What the lens tools need of the Reader: its gate, and the two settings they serve under.
export type ReaderCalls = {
  tool<A, T>(token: string, shape: CallShape, tool: GateTool<A, T>, work: GateWork<A, T>): Promise<ReadOutcome<T>>;
  captureCeilingBytes: number;
  boxHost: string | undefined;
};
