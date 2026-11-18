// JSON helpers the context pack, the memory view, Lens capture and the send payload share.

// The value frozen at every depth, in place.
export const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

// JSON with keys sorted at every depth, arrays in order, no white space.
export function canonicalJson(value: unknown): string {
  const sorted = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(sorted);
    if (typeof inner === "object" && inner !== null)
      return Object.fromEntries(
        Object.keys(inner)
          .sort()
          .map((key) => [key, sorted((inner as Record<string, unknown>)[key])]),
      );
    return inner;
  };
  return JSON.stringify(sorted(value));
}
