import type { UntrustedString } from "@intelligence/contracts/personal";
import type { Keys } from "./keys.ts";
import { type Ctx, Unavailable } from "./read-ctx.ts";
import { open, type SealedColumn, type SealedRow } from "./seal.ts";

// A client's keys: those of its own compartments and no other (invariant 7's second barrier), so a
// row of another compartment that ever reached a read would not open.
export const clientKeys = (keys: Keys, compartments: readonly string[]): Keys => ({
  compartments: new Map([...keys.compartments].filter(([compartment]) => compartments.includes(compartment))),
  fingerprintKey: keys.fingerprintKey,
});

// The rows most reads open: an account's address and an alias.
export type AccountRow = SealedRow<"knowledge.accounts.value_enc">;
export type AliasRow = SealedRow<"knowledge.aliases.value_enc">;

// A sealed value a read serves to a client: `open` with the "throw" policy under the call's keys,
// which hold only the client's compartments, so a row outside them never opens. Any failure is the
// read's one answer, `unavailable`, and the text is served as untrusted data.
export function served<C extends SealedColumn>(ctx: Ctx, row: SealedRow<C>, column: C): UntrustedString {
  try {
    return { untrusted: open(ctx.keys, row, column, "throw") };
  } catch {
    throw new Unavailable();
  }
}

// The same for a column that may hold nothing: null when the row's value is null.
export function servedOrNone<C extends SealedColumn>(ctx: Ctx, row: SealedRow<C>, column: C): UntrustedString | null {
  const name = column.slice(column.lastIndexOf(".") + 1) as keyof SealedRow<C>;
  return row[name] === null ? null : served(ctx, row, column);
}

// A sealed JSON value of the writer's, for the caller to parse. One that does not read as JSON is a
// stored value that does not open.
export function servedJson<C extends SealedColumn>(ctx: Ctx, row: SealedRow<C>, column: C): unknown {
  const text = served(ctx, row, column).untrusted;
  try {
    return JSON.parse(text);
  } catch {
    throw new Unavailable();
  }
}

// A parse of a stored value: one that does not parse is a stored value that does not open.
export const parseOr = <T>(result: { success: true; data: T } | { success: false }): T => {
  if (!result.success) throw new Unavailable();
  return result.data;
};
