import { expect } from "vitest";

// Checks the contract tests make of many schemas, written once.

export type Parser = { safeParse(value: unknown): { success: boolean } };

// The value with one field taken away, once for every field at every depth. A nested field is
// named by its path, "parties.role", and a path runs through a list without an index: the field
// is taken from one element at a time.
function* without(value: unknown, path = ""): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      for (const [inner, rest] of without(element, path)) yield [inner, value.with(index, rest)];
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [field, child] of Object.entries(value)) {
    const here = path === "" ? field : `${path}.${field}`;
    const { [field]: _dropped, ...rest } = value as Record<string, unknown>;
    yield [here, rest];
    for (const [inner, changed] of without(child, here)) yield [inner, { ...value, [field]: changed }];
  }
}

// The value parses, and it stops parsing when any one of its required fields is taken away,
// nested fields included. A field listed as optional, by its path, may be taken away. Every
// field of the value is one or the other, so a sample must carry every optional field too, and
// a path that is listed must be in the sample.
export function needsEvery(
  schema: Parser,
  value: Record<string, unknown>,
  optional: readonly string[] = [],
  name = "",
): void {
  expect(schema.safeParse(value).success, `${name} as given`).toBe(true);
  const paths = new Set<string>();
  const wrong: string[] = [];
  for (const [path, rest] of without(value)) {
    paths.add(path);
    if (schema.safeParse(rest).success !== optional.includes(path)) wrong.push(`${name} without ${path}`.trim());
  }
  for (const path of optional) if (!paths.has(path)) wrong.push(`${name} has no ${path}`.trim());
  // Each entry is a field whose absence was taken when it is required, or refused when it is
  // listed as optional.
  expect([...new Set(wrong)]).toEqual([]);
}

// A strict schema refuses a key it does not name, a label, a reader and a member included.
export function refusesUnknownKeys(schema: Parser, value: Record<string, unknown>, name = ""): void {
  expect(schema.safeParse(value).success, `${name} as given`).toBe(true);
  for (const key of ["unknownKey", "label", "readers", "member", "store"]) {
    if (key in value) continue;
    expect(schema.safeParse({ ...value, [key]: "x" }).success, `${name} with ${key}`).toBe(false);
  }
}

// A closed list takes each of its values and nothing outside it.
export function closedList(schema: Parser & { options: readonly string[] }, expected: readonly string[]): void {
  expect([...schema.options]).toEqual(expected);
  for (const value of expected) expect(schema.safeParse(value).success, value).toBe(true);
  for (const value of ["", "something_else", expected[0]?.toUpperCase(), `${expected[0]} `, 1, null]) {
    expect(schema.safeParse(value).success, String(value)).toBe(false);
  }
}

// A field that takes a closed list refuses a value outside it.
export function refusesOutside(
  schema: Parser,
  value: Record<string, unknown>,
  field: string,
  outside: unknown = "something_else",
): void {
  expect(schema.safeParse(value).success, `${field} as given`).toBe(true);
  expect(schema.safeParse({ ...value, [field]: outside }).success, `${field}: ${String(outside)}`).toBe(false);
}
