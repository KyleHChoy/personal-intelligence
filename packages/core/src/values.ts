// Small checks of a parsed value's shape, the one whitelist reader of untrusted JSON, and a list
// without repeats, shared by the builders.

export const isString = (value: unknown): value is string => typeof value === "string";
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The values in their first order, each once.
export const unique = (values: string[]): string[] => [...new Set(values)];

// The whitelist reader: an answer from Google or a stored value is read field by field, keeping only
// the keys a reading names, and a field of the wrong type refuses the whole reading. `Refused` is
// thrown inside a reading and never out of it: `whitelisted` turns it into null.
class Refused extends Error {}

export function whitelisted<Value>(read: () => Value): Value | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

// Refuses the reading it is called in.
export const refuse = (): never => {
  throw new Refused();
};

// A plain object's fields.
export function fields(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : refuse();
}

export function required<Value>(value: unknown, fits: (value: unknown) => value is Value): Value {
  return fits(value) ? value : refuse();
}

// A key that is absent, or that holds what its field takes.
export const optional = <Value>(value: unknown, fits: (value: unknown) => value is Value): Value | undefined =>
  value === undefined ? undefined : required(value, fits);

// A list of objects: absent is empty.
export function list(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(fields) : refuse();
}

// One of a closed set of words.
export const among =
  <Value extends string>(allowed: readonly Value[]) =>
  (value: unknown): value is Value =>
    allowed.some((one) => one === value);
