// The re-ask of an item whose every candidate was refused for its wording costs a model call. It
// is worth that only while it rescues something: once the last REASK_WINDOW re-asks that named a
// refusal code, under one wording of the re-ask, rescued no claim at all, that code is no longer
// re-asked under that wording. The rule lifts by itself when the wording changes, since a new
// wording starts with no re-asks counted against it. Counts and codes only.

export const REASK_WINDOW = 200;

// One code's measure under one wording: of its latest re-asks, at most REASK_WINDOW, how many were
// asked and how many ended with a claim kept.
export type ReaskRate = { code: string; asked: number; rescued: number };

export const reaskStopped = (rate: Pick<ReaskRate, "asked" | "rescued"> | undefined): boolean =>
  rate !== undefined && rate.asked >= REASK_WINDOW && rate.rescued === 0;

// Whether an item refused with these codes is asked again: while any of them is not stopped.
export const reaskWorthAsking = (codes: readonly string[], rates: readonly ReaskRate[]): boolean =>
  codes.some((code) => !reaskStopped(rates.find((rate) => rate.code === code)));
