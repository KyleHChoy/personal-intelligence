import { GoalReview } from "@intelligence/contracts/personal";
import { DAY_MS, repoFile } from "@intelligence/personal-core";

// A goal's review window (`ontology/goals.json`) and when a goal is stale by it, which the reader's
// computed goals and the owner's goal review both read.
export const goalReview = repoFile("ontology/goals.json", (text) => GoalReview.parse(JSON.parse(text)));

// A day number in the owner's zone (UTC while unset).
const dayOf = (ms: number, zone: string | null): number =>
  Date.parse(
    `${new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))}T00:00:00Z`,
  ) / DAY_MS;

// Stale when more than `days` of the owner's local days lie between the last support and the
// read; support dated after the read counts as at the read.
export const isStale = (last: number, now: number, days: number, zone: string | null): boolean =>
  dayOf(now, zone) - dayOf(Math.min(last, now), zone) > days;
