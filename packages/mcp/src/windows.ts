// Counting by fixed window, per address, for the HTTP server's and OAuth's limits.

// A table of addresses holds no more than this, so it cannot grow without bound.
export const MAX_ADDRESSES = 10_000;

export type Window = { count: number; since: number };
// The window a count at `at` falls in: the one seen, or a new one when it is over.
export const windowAt = (seen: Window | undefined, at: number, ms: number): Window =>
  seen !== undefined && at - seen.since < ms ? seen : { count: 0, since: at };
