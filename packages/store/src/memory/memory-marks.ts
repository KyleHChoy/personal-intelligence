import { entryLine, findStamps } from "@intelligence/personal-core/views";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";

// What the function takes of one change at most. A body of 8 000 code points can hold more
// lines: the first thousand are matched, at the call and again at intake.
const MOST_STAMPS = 100;
const MOST_LINES = 1000;

// The import and intake compute the same, one from the change and one from the opened body.
export function marksOf(keys: Keys, body: string): { stamps: string[]; lineFps: string[] } {
  const stamps = [...new Set(findStamps(body).map((stamp) => stamp.projection as string))].slice(0, MOST_STAMPS);
  const lines = [...new Set(body.split("\n").map(entryLine))].filter((line) => line !== "").slice(0, MOST_LINES);
  return { stamps, lineFps: lines.map((line) => fingerprint(keys, "memory_line", line)) };
}
