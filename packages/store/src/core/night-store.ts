import type { PersonalLogger } from "@intelligence/contracts/personal";
import { trackedCalls } from "./decision-calls.ts";
import { createDb, type Db } from "./job-db.ts";
import type { Keys } from "./keys.ts";

// What a night pass's store is made from: the pass's database url, the keys and the logger.
export type NightOptions = { url: string; keys: Keys; log: PersonalLogger };

// What every night pass's store shares: the keyed replay of its saved model calls, with the id of
// the saved call its last find or save named, and its close.
export type NightStore = {
  calls(): ReturnType<typeof trackedCalls>;
  close(): Promise<void>;
};

// A night pass's own pool, and the shared half of its store over it. The pass's store spreads
// `shared` and wires its other methods to plain functions over `db`.
export function nightStore({ url, keys, log }: NightOptions): { db: Db; shared: NightStore } {
  const db = createDb(url, log);
  return { db, shared: { calls: () => trackedCalls(db.query, keys), close: () => db.close() } };
}
