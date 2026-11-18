// What the rooms last read, by read and arguments (kept.ts `useKept`): a room shown again, or
// another room reading the same, shows it at once, with no read, as the page's memory holds it.
// Every write the page makes, and five minutes, retire all of it, so nothing the page changed is
// shown as it was; the ledger's event stream retires the reads it moves (`moved`), and the rooms
// showing them read them again. A leaf: the request path (api.ts) retires and forgets from here
// directly, so what a session's end clears depends on nothing being loaded.

const KEPT_MS = 5 * 60_000;
let writes = 0;
const kept = new Map<string, { at: number; writes: number; moved: string; value: unknown }>();
// How often the stream moved each read (by name), and every read: a kept answer read before the
// latest move of its read is retired. A key with no "?" (a room's own memo) is never moved.
const movedBy = new Map<string, number>();
let movedAll = 0;
const nameOf = (key: string): string | null => (key.includes("?") ? key.slice(0, key.indexOf("?")) : null);
export const movedOf = (name: string | null): string => (name === null ? "" : `${movedAll}.${movedBy.get(name) ?? 0}`);
const movedWatchers = new Set<() => void>();
export const watchMoved = (watch: () => void): (() => void) => {
  movedWatchers.add(watch);
  return () => movedWatchers.delete(watch);
};
// The ledger moved the reads named, or every read (null): what is kept of them is retired, and the
// rooms showing them read them again.
export function moved(names: readonly string[] | null): void {
  if (names === null) movedAll += 1;
  else for (const name of names) movedBy.set(name, (movedBy.get(name) ?? 0) + 1);
  for (const watch of movedWatchers) watch();
}
export function keptOf<T>(key: string): T | undefined {
  const one = kept.get(key);
  return one !== undefined &&
    one.writes === writes &&
    one.moved === movedOf(nameOf(key)) &&
    Date.now() - one.at < KEPT_MS
    ? (one.value as T)
    : undefined;
}
// The page's writes so far: a read takes it when it is sent, and what it answers is kept only if
// no write came between (a write may have changed what it read); `at`, the stream's moves of it
// when it was sent, likewise.
export const writesSoFar = (): number => writes;
export const keep = (key: string, value: unknown, since: number = writes, at: string = movedOf(nameOf(key))): void => {
  if (since === writes && at === movedOf(nameOf(key))) kept.set(key, { at: Date.now(), writes, moved: at, value });
};
// A write went, or its answer was lost and it may still have been applied: what is kept is retired
// all the same.
export const wrote = (): void => {
  writes += 1;
};

// The newest ledger event the page saw, where the stream resumes (kept.ts).
export const ledgerSeen: { id: number | null } = { id: null };

// Everything kept, forgotten: a session that ended, a test's next page.
export const forgetKept = (): void => {
  kept.clear();
  ledgerSeen.id = null;
};
