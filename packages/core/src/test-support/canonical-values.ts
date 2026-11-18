// The seed is fixed, so a failure repeats.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const SET_KEYS = ["compartments", "readers", "stores", "roles", "items"];

const KEYS = ["a", "b", "aa", "a.b", "", "é", 'a"b', "kind", "payload", "keyId", "𐍈", "～"];
const TEXTS = [
  "",
  "a",
  "b",
  "a,b",
  'a","b',
  "\\",
  "\n",
  "\u00e9",
  "e\u0301",
  "𐍈",
  "\ud800",
  "1",
  "true",
  "null",
  "[]",
  "{}",
  " a",
  "a ",
  "A",
];
const NUMBERS = [0, 1, -1, 7, 1.5, -2.25, 1e21, 1e-7, 123456789, 0.1];

// mulberry32
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;

function shuffled<T>(next: () => number, entries: readonly T[]): T[] {
  const out = [...entries];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// A random JSON value. With `sets`, some objects carry a set field holding distinct strings.
export function randomValue(next: () => number, sets: boolean, depth = 3): Json {
  const roll = next();
  if (depth === 0 || roll < 0.35) {
    const leaf = next();
    if (leaf < 0.4) return pick(next, TEXTS);
    if (leaf < 0.7) return pick(next, NUMBERS);
    if (leaf < 0.85) return next() < 0.5;
    return null;
  }
  if (roll < 0.55) return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, sets, depth - 1));
  const out: { [key: string]: Json } = {};
  for (const key of shuffled(next, KEYS).slice(0, Math.floor(next() * 5)))
    out[key] = randomValue(next, sets, depth - 1);
  if (sets && next() < 0.6) out[pick(next, SET_KEYS)] = shuffled(next, TEXTS).slice(0, Math.floor(next() * 5));
  return out;
}

// The same value written another way: object keys in another order everywhere, and every set
// field in another order with some entries repeated.
export function rewritten(next: () => number, value: Json, isSet = false): Json {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => rewritten(next, entry));
    if (!isSet || entries.length === 0) return entries;
    const repeats = entries.filter(() => next() < 0.5).map((entry) => rewritten(next, entry));
    return shuffled(next, [...entries, ...repeats]);
  }
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: Json } = {};
  for (const key of shuffled(next, Object.keys(value)))
    out[key] = rewritten(next, value[key] as Json, SET_KEYS.includes(key));
  return out;
}

// Every single change to a value: each field removed or altered, a field added to each object,
// an entry added to or dropped from each array. Each result is a different value from the one
// given, as long as its set fields hold no repeats and nothing in it is named or equal to the
// added markers.
export function* tamperings(value: Json, path = "$"): Generator<[what: string, changed: Json]> {
  if (Array.isArray(value)) {
    yield [`${path} gains an entry`, [...value, "zz-added"]];
    if (value.length > 0) yield [`${path} loses an entry`, value.slice(1)];
    for (const [i, entry] of value.entries()) {
      for (const [what, changed] of tamperings(entry, `${path}[${i}]`)) yield [what, value.with(i, changed)];
    }
  } else if (value !== null && typeof value === "object") {
    yield [`${path} gains a field`, { ...value, zz_added: "x" }];
    for (const [key, field] of Object.entries(value)) {
      const { [key]: _removed, ...rest } = value;
      yield [`${path}.${key} is removed`, rest];
      for (const [what, changed] of tamperings(field, `${path}.${key}`)) yield [what, { ...value, [key]: changed }];
    }
  } else if (typeof value === "string") yield [`${path} changes`, `${value}x`];
  else if (typeof value === "number") yield [`${path} changes`, value + (Math.abs(value) || 1)];
  else if (typeof value === "boolean") yield [`${path} changes`, !value];
  else yield [`${path} changes`, 0];
}
