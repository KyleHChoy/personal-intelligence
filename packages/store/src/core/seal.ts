import { type DataKey, type Envelope, EvidenceId } from "@intelligence/contracts";
import { CodedError, RESTRICTED_LOCKED } from "@intelligence/contracts/personal";
import { deriveContentKey, open as openEnvelope, seal } from "./crypto/envelope.ts";
import type { SEALED_COLUMNS } from "./sealed-columns.ts";

// Where a sealed value lives: `table` is "<schema>.<table>", `id` the row's key, `column` its
// column. An envelope opens only there.
export type RowRef = { table: string; id: string; column: string };

// A sealed column's value, as a row holds it. Never `unknown`: a row type names its sealed columns.
export type Sealed = Envelope;

// Every sealed column as "<schema>.<table>.<column>" (a key file's check as "keyfile.check"), from
// sealed-columns.ts: a coordinate that differs by a letter does not compile.
type Table = keyof typeof SEALED_COLUMNS;
export type SealedColumn = { [T in Table]: `${T}.${(typeof SEALED_COLUMNS)[T][number]}` }[Table];
// The column's own name: what follows the last dot.
type NameOf<C extends string> = C extends `${string}.${infer Rest}` ? NameOf<Rest> : C;

// A row a sealed column is opened from: its key, its label, and the column by its own name.
export type SealedRow<C extends SealedColumn> = {
  readonly id: string;
  readonly compartments: readonly string[] | null;
} & {
  readonly [K in NameOf<C>]: Sealed | null | undefined;
};

// What a value that does not open means, by who asks:
// - `throw`: a writer that must have the value. A compartment whose key is wrapped and not open now
//   is `restricted_locked`, so it says why; any other failure (absent, a key the file lacks, sealed
//   under another key) is the one `open_failed`, so a caller learns nothing from which it was.
// - `null`: a pass or a card, which goes on without the row: every failure is null.
// - `withheld`: a read. Absent, or under a compartment whose key is not held, is null, as if the row
//   were not there; a value the held keys will not open is a fault, and throws.
export type OpenPolicy = "throw" | "null" | "withheld";

// Two coordinates more than one role opens: a stored secret, and a source account's address.
export const secretAt = (name: string): RowRef => ({ table: "policy.secrets", id: name, column: "value_enc" });
export const addressAt = (id: string): RowRef => ({ table: "vault.source_accounts", id, column: "address_enc" });

// What sealing and opening need of a key file. `locked`: the restricted compartments whose keys are
// wrapped and not open now (restricted-lock.ts).
type Keys = { compartments: ReadonlyMap<string, DataKey>; locked?: ReadonlySet<string> };

const binding = (at: RowRef) => ({ evidenceId: EvidenceId.parse(`${at.table}/${at.id}`), field: at.column });

function keyOf(keys: Keys, compartment: string): DataKey {
  const key = keys.compartments.get(compartment);
  if (key !== undefined) return key;
  throw new CodedError(keys.locked?.has(compartment) === true ? RESTRICTED_LOCKED : "unknown_compartment");
}

// Several compartments: the key derived from the compartments' keys, sorted. One compartment gives
// that compartment's own key, so every envelope sealRow made opens under it. A compartment the keys
// lack is refused before any key is tried, and so is an empty list.
function keyUnder(keys: Keys, compartments: readonly string[]): DataKey {
  if (compartments.length === 0) throw new CodedError("unknown_compartment");
  const own = [...new Set(compartments)].sort().map((compartment) => keyOf(keys, compartment));
  return deriveContentKey(own);
}

export function sealRow(keys: Keys, compartment: string, at: RowRef, value: string): Envelope {
  return seal(keyOf(keys, compartment), new TextEncoder().encode(value), binding(at));
}

export function sealUnder(keys: Keys, compartments: string[], at: RowRef, value: string): Envelope {
  return seal(keyUnder(keys, compartments), new TextEncoder().encode(value), binding(at));
}

// The crypto package does not export its error class, so `open_failed` is made here with the same
// name and code, which is all a caller reads.
const openFailed = (): Error => Object.assign(new Error("open_failed"), { name: "CryptoError", code: "open_failed" });

// Throws the crypto package's CryptoError with code "open_failed" when the envelope does not open.
const decrypt = (keys: Keys, compartments: readonly string[], at: RowRef, value: Sealed): string =>
  new TextDecoder().decode(openEnvelope(keyUnder(keys, compartments), value, binding(at)));

/** @deprecated Kept for the forwarders in tx.ts, read-ctx.ts and row-opener.ts; use `open`. */
export function openAt(
  keys: Keys,
  compartments: readonly string[] | null,
  at: RowRef,
  value: Sealed | null | undefined,
  policy: "throw",
): string;
export function openAt(
  keys: Keys,
  compartments: readonly string[] | null,
  at: RowRef,
  value: Sealed | null | undefined,
  policy: OpenPolicy,
): string | null;
export function openAt(
  keys: Keys,
  compartments: readonly string[] | null,
  at: RowRef,
  value: Sealed | null | undefined,
  policy: OpenPolicy,
): string | null {
  if (policy === "throw") {
    if (compartments?.some((compartment) => keys.locked?.has(compartment) === true) === true)
      throw new CodedError(RESTRICTED_LOCKED);
    if (value === null || value === undefined || compartments === null || compartments.length === 0) throw openFailed();
    if (!compartments.every((compartment) => keys.compartments.has(compartment))) throw openFailed();
    return decrypt(keys, compartments, at, value);
  }
  if (value === null || value === undefined || compartments === null) return null;
  if (!compartments.every((compartment) => keys.compartments.has(compartment))) return null;
  if (policy === "withheld") return decrypt(keys, compartments, at, value);
  try {
    return decrypt(keys, compartments, at, value);
  } catch {
    return null;
  }
}

// The one way a sealed value opens: the row's `column`, under every compartment of the row's label,
// failing as `policy` says.
export function open<C extends SealedColumn>(keys: Keys, row: SealedRow<C>, column: C, policy: "throw"): string;
export function open<C extends SealedColumn>(
  keys: Keys,
  row: SealedRow<C>,
  column: C,
  policy: "null" | "withheld",
): string | null;
export function open<C extends SealedColumn>(
  keys: Keys,
  row: SealedRow<C>,
  column: C,
  policy: OpenPolicy,
): string | null {
  const cut = column.lastIndexOf(".");
  const name = column.slice(cut + 1) as NameOf<C>;
  const at = { table: column.slice(0, cut), id: row.id, column: name };
  return openAt(keys, row.compartments, at, row[name], policy);
}

/** @deprecated Use `open(keys, row, column, "throw")`; a key the file lacks is `unknown_compartment` here. */
export const openRow = (keys: Keys, compartment: string, at: RowRef, envelope: Envelope): string =>
  decrypt(keys, [compartment], at, envelope);

/** @deprecated Use `open(keys, row, column, "throw")`; a key the file lacks is `unknown_compartment` here. */
export const openUnder = (keys: Keys, compartments: string[], at: RowRef, envelope: Envelope): string =>
  decrypt(keys, compartments, at, envelope);
