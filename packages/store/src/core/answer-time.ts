import type { Query } from "./db.ts";
import type { Run } from "./read-ctx.ts";

// The time a belief computed when asked is computed as of, both for which claims and rulings are
// known and for how it stands: the database transaction's time (`now()`), so a live read never
// takes an application clock. A test that pins a world date pins it on the admin it makes (its
// `now`), and every transaction of that admin reads as of it; its fixtures seed claims and rulings
// known by then.

const pinned = new WeakMap<object, () => Date>();

// A transaction's statements read as of `now`: only an admin made with a pinned clock calls it.
export function pinClock(query: Query, now: () => Date): void {
  pinned.set(query, now);
}

// The clock a test pinned on this transaction, if any: an owner read that runs a reader's function
// hands it to the reader's context.
export const pinnedClock = (query: Query): (() => Date) | undefined => pinned.get(query);

// The read time: the pinned clock of the transaction, or the given one (a reader's pinned clock),
// else the database transaction's time.
export async function readTime(query: Run, given?: () => Date): Promise<Date> {
  const clock = given ?? pinned.get(query);
  if (clock !== undefined) return clock();
  const [row] = (await query<{ at: Date }>("select now() as at", [])) as [{ at: Date }];
  return row.at;
}
