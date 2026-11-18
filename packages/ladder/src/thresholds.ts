import type { Band } from "@intelligence/contracts/personal";

// A rung that asks more than one question bands on the larger probability, as calibration scores it.
// `reject` is a value, `below_accept` (no middle band) or null (no reject band).
export function bandFor(
  p: number | readonly number[],
  accept: number,
  reject: number | "below_accept" | null,
): Exclude<Band, "fallback"> {
  const answers = typeof p === "number" ? [p] : p;
  if (answers.length === 0 || answers.some((one) => !(one >= 0 && one <= 1)))
    throw new RangeError("a probability is between 0 and 1");
  const top = Math.max(...answers);
  if (top >= accept) return "accept";
  if (reject === "below_accept") return "reject";
  return reject !== null && top <= reject ? "reject" : "next";
}
