import { byText } from "../compare.ts";
import { isFormat, normalChars } from "../text.ts";
import type { ViewKind } from "./view-kind.ts";

// The match mode of search: computed at read over the need and capability claims the caller's token
// returned. Pure: a claim's score is its own, and nothing here counts across claims (no document
// frequency, no length norm, no BM25).

// Each mode and the side of the match index it reads. The index's role side is not a mode.
export const MATCH_SIDES = Object.freeze({ needs: "need", capabilities: "capability" } as const satisfies Record<
  string,
  ViewKind
>);
export type MatchMode = keyof typeof MATCH_SIDES;

// A reversal says the need or capability no longer holds, and a claim of a message the system
// sent is no one's statement: neither is a side of a match.
export const isMatchSide = (claim: { statementKind: string; systemOriginated: boolean }): boolean =>
  claim.statementKind !== "reversal" && !claim.systemOriginated;

// The same normal form as grounding.ts's `normal`, over the text alone: format characters dropped, quotes and dashes made one, runs of white space one space, lower case. One
// difference: the whole text is put in NFKC first, so a decomposed accent composes with its letter. grounding.ts takes each code point's own form to keep positions, which
// matching needs not.
const normal = (text: string): string =>
  normalChars(
    [...text]
      .filter((point) => !isFormat(point))
      .join("")
      .normalize("NFKC"),
  );

// A word's own punctuation at its ends is not part of it ("designer." is "designer").
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// The text in normal form, split at white space, each word once, in the order first seen.
export const matchWords = (text: string): string[] => [
  ...new Set(
    normal(text)
      .split(" ")
      .map((word) => word.replace(EDGES, ""))
      .filter((word) => word !== ""),
  ),
];

// How many distinct words of the query the text holds, each whole.
export function matchScore(query: readonly string[], text: string): number {
  const words = new Set(matchWords(text));
  return query.filter((word) => words.has(word)).length;
}

// By score, most first, then newest, then by id.
export const byMatch = (
  a: { id: string; at: string; score: number },
  b: { id: string; at: string; score: number },
): number => b.score - a.score || Date.parse(b.at) - Date.parse(a.at) || byText(a.id, b.id);
