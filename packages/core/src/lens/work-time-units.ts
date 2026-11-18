// Small numeric and formatting helpers that every part of work time shares: sums, subset checks and the wrapper that marks text untrusted.

export const within = (inner: readonly string[], outer: readonly string[]): boolean =>
  inner.every((one) => outer.includes(one));
export const untrusted = (value: string) => ({ untrusted: value });
export const iso = (at: number): string => new Date(at).toISOString();
export const sum = (values: readonly number[]): number => values.reduce((total, one) => total + one, 0);

export function top<T>(
  values: readonly T[],
  limit: number,
  order: (a: T, b: T) => number,
): { list: T[]; more: boolean } {
  const sorted = [...values].sort(order);
  return { list: sorted.slice(0, limit), more: sorted.length > limit };
}
