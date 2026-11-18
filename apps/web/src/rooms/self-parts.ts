import { type FactId, type LifeDomain, SELF_LOW_USE, type SelfReviewRow } from "@intelligence/contracts/personal";
import { factTypeWords, LIFE_DOMAIN_WORDS, SELF_STATUS_WORDS } from "../enum-words.ts";
import { sameWords } from "../words.ts";

// The areas of the owner's life: every life domain and Unsorted, then, after a divider, Your
// activity and Housekeeping. Each is `#you-<area>`.
export const UNSORTED = "unsorted";
export const HOUSEKEEPING = "housekeeping";
export const ACTIVITY = "activity";
export type Area = LifeDomain | typeof UNSORTED | typeof HOUSEKEEPING | typeof ACTIVITY;
export const LIFE = [...(Object.keys(LIFE_DOMAIN_WORDS) as LifeDomain[]), UNSORTED] as const;
export const APART = [ACTIVITY, HOUSEKEEPING] as const;
const NAMES: Readonly<Record<string, string>> = {
  [UNSORTED]: "Unsorted",
  [HOUSEKEEPING]: "Housekeeping",
  [ACTIVITY]: "Your activity",
};
export const areaWords = (area: Area): string => NAMES[area] ?? LIFE_DOMAIN_WORDS[area as LifeDomain];
export const isDomain = (value: string | null): value is LifeDomain => value !== null && value in LIFE_DOMAIN_WORDS;
const isArea = (value: string): value is Area => isDomain(value) || value in NAMES;

// The area a hash names, Career for `#you` or anything else.
export const areaOf = (hash: string): Area => {
  const name = /^#?you-(.+)$/.exec(hash)?.[1] ?? "";
  return isArea(name) ? name : "career";
};

// A row's or a belief's status in words, "Held" for one the page has no words for.
export const statusOf = (status: string): string =>
  Object.hasOwn(SELF_STATUS_WORDS, status) ? SELF_STATUS_WORDS[status as keyof typeof SELF_STATUS_WORDS] : "Held";

// What has ended shows under "Show N that ended"; the rest by kind.
const ENDED = new Set(["expired", "closed", "retired"]);
export const ended = (row: SelfReviewRow): boolean => ENDED.has(row.status);

// One line of an area: rows saying the same sentence shown once (plan E: "the same sentence once"),
// the best ranked leading, every claim of them kept, how many rows it stands for, and those rows,
// each of which the owner can still rule on by itself.
export type Line = { row: SelfReviewRow; facts: FactId[]; held: number; rows: SelfReviewRow[] };
export function linesOf(rows: readonly SelfReviewRow[]): Line[] {
  const lines: Line[] = [];
  for (const row of [...rows].sort((a, b) => a.rank - b.rank)) {
    const same = lines.find(
      (line) => line.row.kind === row.kind && sameWords(line.row.words.untrusted, row.words.untrusted),
    );
    if (same === undefined) lines.push({ row, facts: [...row.facts], held: 1, rows: [row] });
    else {
      same.facts.push(...row.facts.filter((fact) => !same.facts.includes(fact)));
      same.held += 1;
      same.rows.push(row);
    }
  }
  return lines;
}

// A line too thin to lead (by the store's own use band) sits under "Also held", after the kinds.
export const tooThin = (line: Line): boolean => line.row.use >= SELF_LOW_USE;

// An area's lines by kind, each kind led by its best line, in the store's order (`rank`).
export function byKind(lines: readonly Line[]): { label: string; lines: Line[] }[] {
  const kinds = new Map<string, Line[]>();
  for (const line of lines) kinds.set(line.row.kind, [...(kinds.get(line.row.kind) ?? []), line]);
  return [...kinds].map(([kind, of]) => ({
    label: kind === "visited" ? "Your travel history" : factTypeWords(kind),
    lines: of,
  }));
}
