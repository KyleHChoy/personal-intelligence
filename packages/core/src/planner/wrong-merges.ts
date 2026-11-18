import { createHash } from "node:crypto";
import { sha256 } from "../hash.ts";

// Wrong merges: when two reports name the same split, who counts as a second agent, and which
// merges a week's audit samples. Pure: the database holds a twin of each, and the store's test
// holds the two to one answer.

// An open report with nobody agreeing closes for the owner after this many days.
export const WRONG_MERGE_WAIT_DAYS = 7;
// The standing rule's own merges audited each ISO week, for each label, of those made in the last
// MERGE_AUDIT_DAYS days.
export const MERGE_AUDIT_SAMPLE = 5;
export const MERGE_AUDIT_DAYS = 30;

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// One part as the report stores it: its people, each once, sorted by bytes and joined by a comma.
const partOf = (people: readonly string[]): string => [...new Set(people)].sort(byBytes).join(",");

// The key of a split: the parts sorted and joined. Two reports name the same split exactly when
// their keys are equal, whatever order the parts and the people in them came in. Null for what is
// no partition: fewer than two parts, an empty part, or one person in two parts.
export function partitionKey(parts: readonly (readonly string[])[]): string | null {
  if (parts.length < 2 || parts.some((part) => part.length === 0)) return null;
  const people = parts.flatMap((part) => [...new Set(part)]);
  if (new Set(people).size !== people.length) return null;
  return sha256(parts.map(partOf).sort(byBytes).join("|"));
}

// The key of the group a report is about: every person of it, sorted.
export const groupKey = (members: readonly string[]): string => sha256(partOf(members));

// The ISO week of a time, in UTC: `2026W46` with the separator `W`, as the database prints it,
// and `2026-W46` with `-W`.
export function isoWeek(at: Date, separator: "W" | "-W"): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // The week's Thursday decides its year.
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const first = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - first) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}${separator}${String(week).padStart(2, "0")}`;
}

// WM10: the week's sample of one label's merges: those with the lowest MD5 of the ruling's id and
// the week, at most `size` less what the label was already given this week. The same on every run
// of a week, and another draw the next.
export function weekSample(rulings: readonly string[], week: string, size: number, given = 0): string[] {
  const place = (id: string): string => createHash("md5").update(`${id} ${week}`, "utf8").digest("hex");
  return [...new Set(rulings)]
    .sort((a, b) => byBytes(place(a), place(b)) || byBytes(a, b))
    .slice(0, Math.max(0, size - given));
}
