import type { MirrorEntry } from "@intelligence/contracts/personal";
import { canonicalJson } from "../json.ts";

// Lens's mirror: the normalization each value takes before it is stamped, and what the store hashes
// for an entry's state. Pure, as memory.ts's entryValues is.

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Plain, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

// A Who: exactly an id, a kind, a name and an address.
const WHO = ["id", "kind", "name", "address"] as const;
// An entity as get_entity builds one: it carries its mail and its last and next meeting.
const ENTITY = ["id", "kind", "names", "addresses", "mail", "lastMeeting", "nextMeeting"] as const;

// So each value is built from its own source rows alone: a rename, a new mail or the passing of a
// meeting changes no entry but the one it belongs to.
export function mirrorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mirrorValue);
  if (!isPlain(value)) return value;
  if (keysAre(value, WHO)) return { id: value.id, kind: value.kind, name: null, address: null };
  const entity = ENTITY.every((key) => key in value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(entity && (key === "mail" || key === "lastMeeting" || key === "nextMeeting")))
      .map(([key, inner]) => [key, mirrorValue(inner)]),
  );
}

// Its SHA-256 is the stamp's state.
export function mirrorEntryValues(entry: MirrorEntry): string {
  const { stamp: _stamp, ...values } = entry;
  return canonicalJson(values);
}
