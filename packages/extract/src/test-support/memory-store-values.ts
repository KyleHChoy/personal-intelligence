// Two small values of the memory store's.

// Crockford base32 of a number, as the 26 characters of a ULID.
export const ulid = (n: number): string =>
  n
    .toString(32)
    .toUpperCase()
    .replace(/[ILOU]/g, (c) => ({ I: "W", L: "X", O: "Y", U: "Z" })[c] as string)
    .padStart(26, "0");

// JSON with object keys sorted: a belief's state, to tell a changed row from an unchanged one.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .filter((key) => fields[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
