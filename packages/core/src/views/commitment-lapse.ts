import { dayAfter, dayIn } from "@intelligence/contracts/personal";
import { dayOf } from "../days.ts";

// How many days past the date it names a commitment stays open: long enough to be seen late and
// closed by hand, short enough that a date that passed in silence stops reading as owed. Counted from
// when it was last confirmed if that is later, so a promise restated with no new date still stands.
// Computed at every read, so nothing is stored and the claim stays as it was said.
const DUE_LAPSE_DAYS = 14;

// How long an undated chat remark stays open with nothing to bind it: said in chat, not in mail, and on no
// project. Provisional, read from real commitments: of the undated ones the owner cleared by hand, half had
// stood under 10 days, and those let go from chat ran up to 40. A remark owed to the owner asks nothing of
// them, so it goes sooner; one they owe keeps the courtesy's 30 days, since a lost obligation costs more
// than a line that stays. Nothing is stored and a reopen restarts it.
// How long a courtesy commitment stays open with nothing to reconfirm it.
export const COURTESY_DAYS = 30;

export const REMARK_OWED_TO_OWNER_DAYS = 14;
const REMARK_OWED_BY_OWNER_DAYS = COURTESY_DAYS;
export const remarkDays = (direction: "owed_by_owner" | "owed_to_owner"): number =>
  direction === "owed_to_owner" ? REMARK_OWED_TO_OWNER_DAYS : REMARK_OWED_BY_OWNER_DAYS;

// The last day, in the owner's zone, a commitment due then stays open; null for what is no date.
export function lastOpenDay(due: string, confirmedAt: string, zone: string | null): string | null {
  const dueDay = dayOf(due, zone);
  if (dueDay === null) return null;
  const confirmed = dayOf(confirmedAt, zone);
  return dayAfter(confirmed !== null && confirmed > dueDay ? confirmed : dueDay, DUE_LAPSE_DAYS);
}

export function dueLapsed(due: string | null, confirmedAt: string, now: Date, zone: string | null): boolean {
  const last = due === null ? null : lastOpenDay(due, confirmedAt, zone);
  return last !== null && dayIn(now, zone) > last;
}

// When a commitment was last said to stand: confirmed by a source, or reopened by the owner, whose
// word outranks a lapse and starts its clock again.
export const lastStood = (confirmedAt: string, reopenedAt: string | undefined): string =>
  reopenedAt !== undefined && Date.parse(reopenedAt) > Date.parse(confirmedAt) ? reopenedAt : confirmedAt;

// What a stored belief says of a commitment's sides and dates, as far as its lapse needs.
export type StoredCommitment = {
  kind?: unknown;
  subject?: unknown;
  values?: { counterparty?: unknown; due?: unknown };
  lastConfirmedAt?: unknown;
};

// A commitment with the owner on neither side has no reopen and nobody who closes it, so it is only
// ever somebody's remark: past the same lapse it is no longer read as standing. By UTC's day, since
// a day's difference in the owner's zone changes nothing a reader can rest on.
export function thirdPartyLapsed(belief: StoredCommitment, isOwner: (id: string) => boolean, now: Date): boolean {
  const { kind, subject, values, lastConfirmedAt } = belief;
  if (kind !== "commitment" || typeof subject !== "string" || isOwner(subject)) return false;
  if (typeof values?.counterparty === "string" && isOwner(values.counterparty)) return false;
  if (typeof lastConfirmedAt !== "string") return false;
  const first = lapseDayOf(typeof values?.due === "string" ? values.due : null, lastConfirmedAt, null);
  return first !== null && dayIn(now, null) >= first;
}

// The first day a commitment that stood then is no longer open: past its date, or undated, past
// `undatedDays`, a courtesy's by default. Null for a date that is no date.
export function lapseDayOf(
  due: string | null,
  stood: string,
  zone: string | null,
  undatedDays: number = COURTESY_DAYS,
): string | null {
  if (due !== null) {
    const last = lastOpenDay(due, stood, zone);
    return last === null ? null : dayAfter(last, 1);
  }
  const day = dayOf(stood, zone);
  return day === null ? null : dayAfter(day, undatedDays + 1);
}
