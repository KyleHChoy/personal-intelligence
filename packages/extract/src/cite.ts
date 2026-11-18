export const PASSAGE_BYTES = 2_000;
const MARKER = "[…]";
const size = (text: string): number => Buffer.byteLength(text, "utf8");
export function cutPassage(text: string): string {
  if (size(text) <= PASSAGE_BYTES) return text;
  const points = Array.from(text);
  const room = PASSAGE_BYTES - size(MARKER);
  const take = (from: readonly string[], budget: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const point of from) {
      if (used + size(point) > budget) break;
      kept.push(point);
      used += size(point);
    }
    return kept;
  };
  const head = take(points, Math.floor(room * 0.8));
  const tail = take([...points].reverse(), room - size(head.join(""))).reverse();
  return `${head.join("")}${MARKER}${tail.join("")}`;
}

// Words too common to show that a cite came from its passage.
const STOPWORDS = new Set(
  "a an and are as at be but by for from had has have he her his i if in is it its me my no not of on or our she so that the their them they this to was we were will with you your".split(
    " ",
  ),
);
const CITE_WORDS = 3;
const CITE_POINTS = 12;

// A cite strong enough to count: at least CITE_WORDS words or CITE_POINTS code points, and not
// every word a stopword, so a cite of "the" verifies nothing.
export function strongCite(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  if (words.length < CITE_WORDS && Array.from(text).length < CITE_POINTS) return false;
  return words.some((word) => !STOPWORDS.has(word));
}
