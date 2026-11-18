import { byText } from "../core/db.ts";

// How `search` matches and ranks. Everything here works on
// values the caller's token already returned and the reader opened: nothing here reads the
// database.

// NFKD, accents stripped, lower case; outer white space dropped and inner runs made one space.
export const normalized = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .join(" ");

// 0: the query is a whole name. 1: it is the start of a name from any word on, so a prefix of a word
// or of a run of words. 2: it is a substring of a whole address, or of an organization's domain.
export type Rank = 0 | 1 | 2;

// A candidate's best match, or null when nothing matches. The query and the candidate's values
// are already normalized.
export function bestMatch(query: string, candidate: { names: string[]; addresses: string[] }): Rank | null {
  if (query === "") return null;
  if (candidate.names.includes(query)) return 0;
  if (candidate.names.some((name) => ` ${name}`.includes(` ${query}`))) return 1;
  if (candidate.addresses.some((address) => address.includes(query))) return 2;
  return null;
}

// By match, then by the visible email count, most first, then by id.
export const byRank = (
  a: { id: string; rank: Rank; emails: number },
  b: { id: string; rank: Rank; emails: number },
): number => a.rank - b.rank || b.emails - a.emails || byText(a.id, b.id);

// By match, then by warmth (read-warmth.ts' warmthOrder: tier, then `warmth`), highest first,
// then as byRank; applied to every match before the page is cut, so the page is the top of the
// whole order, not of the page alone.
export const byRankAndWarmth = (
  a: { id: string; rank: Rank; emails: number; warmth: number },
  b: { id: string; rank: Rank; emails: number; warmth: number },
): number => a.rank - b.rank || b.warmth - a.warmth || byRank(a, b);

export const byAddressThenRank = (
  a: { id: string; rank: Rank; emails: number; warmth: number; nameOnly: boolean },
  b: { id: string; rank: Rank; emails: number; warmth: number; nameOnly: boolean },
): number => Number(a.nameOnly) - Number(b.nameOnly) || byRankAndWarmth(a, b);
