import { count, isRecord, type Json } from "./completion.ts";
// What one answer cost. The shared response carries US dollars; everything personal code stores or
// compares is in micro-dollars.

// What a call whose cost is not known counts as, in micro-dollars: one cent, an assumed figure,
// not a measured one.
export const ASSUMED_CALL_MICRO_USD = 10_000;

// Whole millionths of a US dollar, rounded up. The figure is first rounded to a millionth of a
// micro-dollar, so a dollar figure's binary noise never adds one.
export const microUsd = (dollars: number): number => Math.ceil(Math.round(dollars * 1e12) / 1e6);

// The token counts of an answer's usage, and its cost in US dollars when it gives one.
export const usageOf = (usage: unknown): { inputTokens: number; outputTokens: number; cost: number | undefined } => {
  const fields: Json = isRecord(usage) ? usage : {};
  const cost = fields.cost;
  return {
    inputTokens: count(fields.prompt_tokens),
    outputTokens: count(fields.completion_tokens),
    cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
  };
};
