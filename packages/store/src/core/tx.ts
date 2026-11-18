import { ClaimRecord, CodedError, isCoded } from "@intelligence/contracts/personal";
import { driverError, type Query, sqlstateOf } from "./db.ts";
import type { Keys } from "./keys.ts";
import { open, openAt, type RowRef, type Sealed } from "./seal.ts";

// What every role's code shares on a transaction: the statements and keys it works on, the two
// failures it answers with, and how a sealed value opens.

// What the writer's helpers work on: one connection's statements, and the keys.
export type Tx = {
  query: Query;
  keys: Keys;
};

// What a caller is told when the database could not be asked, or was not: no answer of the
// server's to say anything of.
export const unavailable = (): Error => new CodedError("unavailable", { cause: {} });

/** @deprecated Use `open(keys, row, column, "throw")`; a locked compartment is `open_failed` here. */
export function opened(keys: Keys, compartment: string, at: RowRef, envelope: unknown): string {
  return openAt(keys, keys.compartments.has(compartment) ? [compartment] : [], at, envelope as Sealed, "throw");
}

/** @deprecated Use `open(keys, row, column, "throw")`. */
export const openedUnder = (keys: Keys, compartments: string[], at: RowRef, envelope: unknown): string =>
  openAt(keys, compartments, at, envelope as Sealed, "throw");

/** @deprecated Use `open(keys, row, column, "null")`. */
export const openedOrNull = (keys: Keys, compartments: string[], at: RowRef, envelope: unknown): string | null =>
  openAt(keys, compartments, at, envelope as Sealed, "null");

// A claim's record from its opened text: null for none, or text that holds no record.
export function claimRecordOf(text: string | null): ClaimRecord | null {
  if (text === null) return null;
  try {
    const record = ClaimRecord.safeParse(JSON.parse(text));
    return record.success ? record.data : null;
  } catch {
    return null;
  }
}

/** @deprecated Use `claimRecordOf(open(keys, row, "knowledge.claims.content_enc", "null"))`. */
export const claimRecordOrNull = (
  keys: Keys,
  row: { id: string; compartments: string[]; content_enc: unknown },
): ClaimRecord | null =>
  claimRecordOf(open(keys, { ...row, content_enc: row.content_enc as Sealed }, "knowledge.claims.content_enc", "null"));

// A connection lost, not a row refused: SQLSTATE class 08, or 57P01 to 57P03 (the server shut
// down or is not taking connections); a socket error; or `unavailable` with no SQLSTATE kept, which
// the store's wrappers throw only when the server never answered. A trigger's refusal, a deadlock, a
// serialization failure or a cancelled statement is coded `unavailable` too, with its SQLSTATE: one
// row's failure, not the connection's.
const LOST_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[1-3])$/;
const SOCKET = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);

function connectionLostError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SOCKET.has(code)) return true;
  const sqlstate = sqlstateOf(error) ?? driverError(error).sqlstate;
  if (sqlstate !== undefined) return LOST_SQLSTATE.test(sqlstate);
  return isCoded(error, "unavailable");
}

// Each row in its own transaction, which `step` opens: a row that fails is counted and left for the
// next run, and the loop goes on. A lost connection ends the loop, since every row after it would
// fail the same way. Returns how many rows failed.
export async function eachInOwnTransaction<Row>(
  rows: Iterable<Row>,
  step: (row: Row) => Promise<unknown>,
): Promise<number> {
  let failed = 0;
  for (const row of rows) {
    try {
      await step(row);
    } catch (error) {
      if (connectionLostError(error)) throw error;
      failed += 1;
    }
  }
  return failed;
}
