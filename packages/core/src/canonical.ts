// Fields the contracts define as sets. Their entries are encoded sorted, with repeats removed.
const SET_FIELDS = new Set(["compartments", "readers", "stores", "roles", "items"]);

// A refusal is a code only: an error never holds the value.
const refuse = (): never => {
  throw new Error("malformed");
};

// `within` holds the lists and objects the value is inside, so one that contains itself is refused.
function encode(value: unknown, asSet: boolean, within: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    // JSON would write negative zero as zero, and two values would share their bytes.
    return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : refuse();
  }
  if (typeof value !== "object" || within.has(value)) return refuse();
  within.add(value);
  let text: string;
  if (Array.isArray(value)) {
    const entries = Array.from(value, (entry) => encode(entry, false, within));
    text = `[${(asSet ? [...new Set(entries)].sort() : entries).join(",")}]`;
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return refuse();
    const fields = value as Record<string, unknown>;
    const parts = Object.keys(fields)
      .sort()
      // An absent optional field and one set to undefined are the same value, as in JSON.
      .filter((key) => fields[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${encode(fields[key], SET_FIELDS.has(key), within)}`);
    text = `{${parts.join(",")}}`;
  }
  within.delete(value);
  return text;
}

// The one byte encoding: JSON with no white space, object keys in code-unit order, as UTF-8.
// Only JSON values are encodable, so a signed value reads the same after it crosses HTTP.
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encode(value, false, new Set()));
}
