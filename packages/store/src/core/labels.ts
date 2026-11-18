// A label's compartments in the forms code compares, and the one rule of what is within what.

// A label as policy.label_key gives it: its compartments, each once, sorted bytewise, joined by `|`.
// The form a statement compares with, and clearance keys.
export const labelKey = (compartments: readonly string[]): string => [...new Set(compartments)].sort().join("|");

// A label sorted and joined by commas: a map's key, or the part of a fingerprint's input that has
// always had this form. No statement reads it, and it never compares with labelKey's form.
export const labelJoined = (compartments: readonly string[]): string => [...compartments].sort().join(",");

// Whether something under `inner` may be read under `outer`: every compartment of it is there. What
// keeps a run's label from widening, so a compartment list is never compared any other way.
export const within = (inner: readonly string[], outer: readonly string[]): boolean =>
  inner.every((one) => outer.includes(one));
