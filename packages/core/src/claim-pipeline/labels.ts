// The label algebra. Pure functions: no database, file, environment, clock or key storage.
import { ALL_MEMBERS, Compartment, Label, NarrowRequest, type ReaderId } from "@intelligence/contracts";

// Every argument is checked against its contract schema before it is used, so a
// malformed one is refused and never half-read.
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

function parse<T>(schema: Schema<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseList<T>(schema: Schema<T>, values: unknown): T[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const items: T[] = [];
  for (const value of values) {
    const item = parse(schema, value);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

// A refusal by throw holds a code only, never what was refused.
function wellFormed(label: unknown): Label {
  const parsed = parse(Label, label);
  if (parsed === undefined) throw new Error("malformed");
  return parsed;
}

const sortedSet = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

const normalForm = ({ compartments, readers }: Label): Label => ({
  compartments: sortedSet(compartments),
  readers: readers.includes(ALL_MEMBERS) ? [ALL_MEMBERS] : sortedSet(readers),
});

export function normalize(label: Label): Label {
  return normalForm(wellFormed(label));
}

// Union of compartments, intersection of readers. ALL_MEMBERS is the identity
// of the intersection, so no directory is needed to expand it.
export function combine(labels: Label[]): Label {
  const inputs = parseList(Label, labels);
  if (inputs === undefined) throw new Error("malformed");
  if (inputs.length === 0) throw new Error("no_labels");
  const compartments: Compartment[] = [];
  let readers: ReaderId[] | undefined;
  for (const label of inputs) {
    compartments.push(...label.compartments);
    if (label.readers.includes(ALL_MEMBERS)) continue;
    const next = label.readers;
    readers = readers === undefined ? next : readers.filter((reader) => next.includes(reader));
  }
  return normalForm({ compartments, readers: readers ?? [ALL_MEMBERS] });
}

const stricter = (a: Label, b: Label): boolean =>
  b.compartments.every((compartment) => a.compartments.includes(compartment)) &&
  (b.readers.includes(ALL_MEMBERS) || a.readers.every((reader) => b.readers.includes(reader)));

export function isAtLeastAsStrict(a: Label, b: Label): boolean {
  const left = parse(Label, a);
  const right = parse(Label, b);
  return left !== undefined && right !== undefined && stricter(left, right);
}

// The only entry point for model output. It can add a compartment the caller
// allows, remove readers and keep only some readers, and nothing else: the
// request schema is strict, so any other key is refused.
export function narrow(base: Label, request: NarrowRequest, allowedAdditions: Compartment[]): Label {
  const from = normalize(base);
  const asked = parse(NarrowRequest, request);
  const allowed = parseList(Compartment, allowedAdditions);
  if (asked === undefined || allowed === undefined) throw new Error("bad_narrow_request");
  const { addCompartments = [], removeReaders = [], keepReaders } = asked;
  if (addCompartments.some((compartment) => !allowed.includes(compartment))) {
    throw new Error("bad_narrow_request");
  }
  let readers = from.readers;
  if (keepReaders !== undefined && !keepReaders.includes(ALL_MEMBERS)) {
    readers = readers.includes(ALL_MEMBERS) ? keepReaders : readers.filter((reader) => keepReaders.includes(reader));
  }
  // The group is not expanded here, so one member cannot be taken out of it.
  if (readers.includes(ALL_MEMBERS) && removeReaders.some((reader) => reader !== ALL_MEMBERS)) {
    throw new Error("bad_narrow_request");
  }
  return normalForm({
    compartments: [...from.compartments, ...addCompartments],
    readers: readers.filter((reader) => !removeReaders.includes(reader)),
  });
}
