// The pass rule every lane's evaluation scores by.
export const EVAL_RECALL = 0.8;
export const EVAL_EXTRAS_PER_ITEM = 0.2;

// How many of `of` expected facts a set must find, and how many extras it may hold. The small
// amounts keep a whole number's product from landing a hair off by rounding.
export const recallNeeded = (of: number): number => Math.ceil(EVAL_RECALL * of - 1e-9);
export const extrasAllowed = (of: number): number => Math.floor(of * EVAL_EXTRAS_PER_ITEM + 1e-9);
