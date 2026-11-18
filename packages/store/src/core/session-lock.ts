import type { Db } from "./job-db.ts";
import { unavailable } from "./tx.ts";

// A job's session lock (sync's, extraction's, the tick's), taken and given back on a connection of
// its own, and the gate every write of the job goes through.
export type LockedSession = {
  // `fn` while this process holds the lock; `already_running` when another session holds it. A
  // connection lost takes the lock with it, and the statement that gives the lock back then fails:
  // such a run is reported as `unavailable`, never as one that held the lock throughout.
  withLock<T>(fn: () => Promise<T>): Promise<T | "already_running">;
  // `call`, refused as `unavailable` before it touches the database once the lock's connection has
  // gone, until that `withLock` ends: another job may hold the lock by now. Reads need not use it.
  write<T>(call: () => Promise<T>): Promise<T>;
};

export function lockedSession(db: Db, lock: { try: string; give: string }): LockedSession {
  let lost: (() => boolean) | undefined;
  return {
    withLock: (fn) =>
      db.session(async (query, gone) => {
        const [taken] = await query<{ held: boolean }>(lock.try);
        if (taken?.held !== true) return "already_running";
        lost = gone;
        try {
          const result = await fn();
          await query(lock.give);
          return result;
        } finally {
          lost = undefined;
        }
      }),
    write: (call) => (lost?.() === true ? Promise.reject(unavailable()) : call()),
  };
}
