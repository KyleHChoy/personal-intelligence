// Promises that wait on a lock: whether one is still waiting, how it settled, a connection that
// holds a lock until it is released, the backends waiting, and an erasure hook added for one test.

import pg from "pg";
import type { ErasureHook } from "../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { one, type Query } from "./connections.ts";
import { queryAs, type TestDatabase } from "./database.ts";

// Whether a promise is still pending after a moment.
export const pending = async (promise: Promise<unknown>): Promise<boolean> => {
  const marker = Symbol("pending");
  const settled = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), 400)),
  ]);
  return settled === marker;
};

// What a promise settled to: its value, or the code it was rejected with.
export const outcome = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => value,
    (error: unknown) => ({ rejected: (error as { code?: string }).code }),
  );

// A connection that holds a transaction, and the lock its first statement took, until `release`.
export async function holdingLock(
  url: string,
  sql: string,
  values?: unknown[],
): Promise<{ query: pg.Client["query"]; release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("begin");
  await client.query(sql, values);
  return {
    query: client.query.bind(client),
    release: async () => {
      await client.query("commit");
      await client.end();
    },
  };
}

// Whether a promise has settled, without waiting for it.
export async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  return done;
}

// One connection of a test's own, and its backend's pid.
export type Connection = { client: pg.Client; pid: number; query: Query };
export async function connectTo(url: string): Promise<Connection> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const query: Query = async <Row>(text: string, values?: unknown[]) =>
    (await client.query(text, values)).rows as Row[];
  const pid = one(await query<{ pid: number }>("select pg_backend_pid() as pid")).pid;
  return { client, pid, query };
}

// One connection to each url for `fn`, all ended when it settles.
export async function withConnections<T>(urls: string[], fn: (connections: Connection[]) => Promise<T>): Promise<T> {
  const connections: Connection[] = [];
  try {
    for (const url of urls) connections.push(await connectTo(url));
    return await fn(connections);
  } finally {
    for (const connection of connections) await connection.client.end().catch(() => {});
  }
}

// Whether a backend is waiting for a lock, polled from pg_locks.
export async function waitingForLock(db: TestDatabase, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryAs<{ n: number }>(
      db.urls.admin,
      "select count(*)::int as n from pg_locks where pid = $1 and not granted",
      [pid],
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// A backend's advisory locks on one bigint key each, as "<key> <mode> <granted|waiting>".
export async function advisoryLocks(db: TestDatabase, pid: number): Promise<string[]> {
  const rows = await queryAs<{ line: string }>(
    db.urls.admin,
    `select ((classid::bigint << 32) | objid::bigint)::text || ' ' || mode || ' ' || case when granted then 'granted' else 'waiting' end as line
     from pg_locks where locktype = 'advisory' and objsubid = 1 and pid = $1`,
    [pid],
  );
  return rows.map((row) => row.line).sort();
}

// A hook added for one test, after the standing ones, taken out after it.
export async function withErasureHook<T>(hook: ErasureHook, fn: () => Promise<T>): Promise<T> {
  const hooks = ERASURE_HOOKS as ErasureHook[];
  hooks.push(hook);
  try {
    return await fn();
  } finally {
    hooks.splice(hooks.indexOf(hook), 1);
  }
}
