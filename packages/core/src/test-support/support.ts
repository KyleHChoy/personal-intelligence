import { ConnectorCursor, Timestamp } from "@intelligence/contracts";
import { CodedError } from "@intelligence/contracts/personal";
import type { ConnectorOptions } from "../items/types.ts";

// What the two fake sources share: injected failures, and an opaque cursor of their own.

// How a call can be made to fail. `not_found` on a history or sync-token read is no error:
// the cursor expired, as the connector reads a 404 or a 410.
export type FailureKind = "unavailable" | "rate_limited" | "oauth_failed" | "not_found";

// A connector fails by throwing an Error with a string `code`. A caller reads only `code`.
export const coded = (code: string): Error => new CodedError(code);

// Counts calls from 1, and makes the calls a test named fail once.
export function callPlan(): {
  failAt(n: number, kind: FailureKind): void;
  next(): FailureKind | undefined;
  readonly calls: number;
} {
  const planned = new Map<number, FailureKind>();
  let calls = 0;
  return {
    failAt: (n, kind) => void planned.set(n, kind),
    next() {
      calls += 1;
      return planned.get(calls);
    },
    get calls() {
      return calls;
    },
  };
}

// The page size a caller asked for. One that is not a positive integer is refused as the
// connector refuses it, before any cursor is read.
export function pageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw coded("bad_request");
  return limit;
}

// The window's start a connector is built with. One that is no timestamp is refused when the
// connector is made, as the real one refuses it: read as a time it would be no window at all.
export function windowStart(options: ConnectorOptions): Timestamp | undefined {
  if (options.since !== undefined && !Timestamp.safeParse(options.since).success) throw coded("bad_request");
  return options.since;
}

// A cursor is base64url JSON that names the fake that made it. One that does not decode, or
// that another fake made, is refused as the connector refuses one: `bad_cursor`.
export const encodeCursor = (state: { fake: string }): ConnectorCursor =>
  ConnectorCursor.parse(Buffer.from(JSON.stringify(state)).toString("base64url"));

export function decodeCursor<State extends { fake: string }>(cursor: ConnectorCursor, fake: State["fake"]): State {
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw coded("bad_cursor");
  }
  if (typeof state !== "object" || state === null || (state as { fake?: unknown }).fake !== fake)
    throw coded("bad_cursor");
  return state as State;
}
