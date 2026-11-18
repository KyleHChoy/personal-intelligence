// The deterministic measure that picks same-fact candidate pairs. Pure, so which pairs a model is
// asked about never depends on a model.

export const SAME_FACT_SIMILARITY = 0.35;

const wordSet = (phrase: string): Set<string> => new Set(phrase.split(" ").filter((word) => word !== ""));

// Two empty phrases share nothing: 0.
export function phraseSimilarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const either = left.size + right.size - shared;
  return either === 0 ? 0 : shared / either;
}
