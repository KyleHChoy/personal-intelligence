import { createHash } from "node:crypto";
import { DAY_MS } from "@intelligence/personal-core";
import { isoWeek, leverDefault } from "@intelligence/personal-core/planner";
import { quoted } from "../core/statements.ts";
import { attemptsOn, HELD_FOR_AGENT } from "./agent-attempts.ts";
import { HELD_FOR_RELAY } from "./questions-through-agent.ts";

// The rules by which the owner is asked less: which outcomes reach the owner as a card and what
// code settles the others with, which lessons a week's digest offers, and how long a box health
// card stands before the owner sees it. Nothing here reads a row: the tick, the owner's queue and a
// lessons run's finish call these. The outcome sample and the lesson digest are levers: their
// constants here are the levers' defaults, and the tick passes each rule the lever's value.

// Who settles what the owner is not asked: never the owner (invariant 11).
export const ASKED_LESS_BY = "system:asked_less";

// The Monday the ISO week of a moment starts on, in UTC.
export function weekStartOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 1 - (day.getUTCDay() || 7));
  return day;
}
// The same Monday as a date, "YYYY-MM-DD".
export const weekDayOf = (at: Date): string => weekStartOf(at).toISOString().slice(0, 10);

// Outcomes. The most outcome cards on a report that reach the owner in one ISO week, and
// the share of reports drawn for them: a draw, so not every report is a candidate. The week's
// sample is spread over it (outcomeAllowance).
export const OUTCOME_SAMPLE_WEEKLY = leverDefault("outcomes.sample_weekly");
export const OUTCOME_SAMPLE_SHARE = leverDefault("outcomes.sample_share");

// A report's draw in a week, in [0, 1): a hash of the week and the move's id, so a rerun agrees.
export const outcomeDraw = (move: string, week: string): number =>
  createHash("sha256").update(`outcome_sample\n${week}\n${move}`).digest().readUInt32BE(0) / 2 ** 32;

// So the first reports drawn on a busy Monday take one card and not the week's three, and the whole
// sample is open from Friday.
export const outcomeAllowance = (now: Date, weekly: number): number =>
  Math.ceil((weekly * (Math.floor((now.getTime() - weekStartOf(now).getTime()) / DAY_MS) + 1)) / 7);

// Whether a report's outcome card reaches the owner: drawn, and the sample open so far this week
// not yet taken.
// `sample`: the two levers' values.
export const outcomeSampled = (
  move: string,
  now: Date,
  sampledThisWeek: number,
  sample: { weekly: number; share: number } = { weekly: OUTCOME_SAMPLE_WEEKLY, share: OUTCOME_SAMPLE_SHARE },
): boolean =>
  sampledThisWeek < outcomeAllowance(now, sample.weekly) && outcomeDraw(move, isoWeek(now, "-W")) < sample.share;

// What code settles an outcome with, as the code on its card's `withdrawn` event: the owner's
// `acknowledge` would have said met and `dismiss` not met.
export const SETTLED_CODES = ["settled_met", "settled_not_met", "settled_unjudged"] as const;
type SettledCode = (typeof SETTLED_CODES)[number];
export const SETTLED_CODES_SQL = quoted(SETTLED_CODES);

// The label code gives a report's outcome: the code judge's latest link on the work when it has
// one that says met or not met, else the agent's own report (`done` met, `failed` not met), else
// none. A partial or advancing link judges nothing final, so the report decides.
export function outcomeLabel(of: { judged: string | null; move: string | null }): SettledCode {
  if (of.judged === "met") return "settled_met";
  if (of.judged === "not_met") return "settled_not_met";
  if (of.move === "done") return "settled_met";
  if (of.move === "failed") return "settled_not_met";
  return "settled_unjudged";
}

// Lessons. Every open lesson that can be asked reaches the owner: no
// weekly limit holds one back (the owner's ruling: questions that get past every rule that stops one
// being made are ones the owner wants to answer).

// `vetoed`: a veto of the owner's covers the lesson's basis, so no card is raised on it.
type LessonCandidate = { id: string; support: number; createdAt: Date; vetoed?: boolean };

// The lessons the tick raises a card on, in order: the most supported first (the owner's decisions
// each cites), then the oldest, then by id. A lesson whose basis a veto covers is left out: its card
// is never raised.
export function lessonsToAsk<T extends LessonCandidate>(candidates: readonly T[]): T[] {
  return candidates
    .filter((one) => one.vetoed !== true)
    .sort(
      (a, b) =>
        b.support - a.support ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

// A lesson's words as they are compared: case and spacing aside, nothing else.
const lessonWords = (text: string): string => text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

type StatedLesson = {
  lesson: string;
  basis: readonly unknown[];
  appliesTo?: { kinds?: readonly string[] | undefined; roles?: readonly string[] | undefined } | undefined;
  supersedes?: string | undefined;
};

// What makes two lessons the same lesson: the same words, for the same kinds and roles, replacing
// the same lesson.
export const lessonKey = (one: {
  words: string;
  kinds?: readonly string[] | null | undefined;
  roles?: readonly string[] | null | undefined;
  supersedes?: string | null | undefined;
}): string =>
  JSON.stringify([
    lessonWords(one.words),
    [...(one.kinds ?? [])].sort(),
    [...(one.roles ?? [])].sort(),
    one.supersedes ?? null,
  ]);

// The most refs a lesson's basis holds (the contract's and ledger.finish_run's limit).
const LESSON_BASIS_MOST = 20;

// A lessons run's output with exact duplicates merged: one that states a lesson already standing
// (open, asked or in force; `standing` holds their keys) is left out, and one stated twice is kept
// once, the first, with every decision either cites, up to the most a basis holds.
export function mergeLessons<T extends StatedLesson>(stated: readonly T[], standing: ReadonlySet<string>): T[] {
  const kept = new Map<string, T>();
  for (const one of stated) {
    const key = lessonKey({
      words: one.lesson,
      kinds: one.appliesTo?.kinds,
      roles: one.appliesTo?.roles,
      supersedes: one.supersedes,
    });
    if (standing.has(key)) continue;
    const first = kept.get(key);
    if (first === undefined) {
      kept.set(key, one);
      continue;
    }
    const seen = new Set(first.basis.map((ref) => JSON.stringify(ref)));
    const basis = [...first.basis, ...one.basis.filter((ref) => !seen.has(JSON.stringify(ref)))];
    kept.set(key, { ...first, basis: basis.slice(0, LESSON_BASIS_MOST) });
  }
  return [...kept.values()];
}

// Box health. How long a box health card stands before the owner's queue shows it.
export const BOX_HEALTH_QUIET_HOURS = 24;

// A hold's card is not held back: a hold stops reads or sync, and does not end by itself.
// A box health card's case key is `box:<kind>:<about>` (core/box-health.ts).
const HOLD_CASE = "box:hold:";

// Whether a card is in the owner's queue and its counts by this rule: any kind but box health at once, a
// hold's box health card at once, any other box health card once it has stood since it was raised for the
// quiet hours. The rule on a card's row (`id`, `kind`, `case_key`, `created_at`) aliased `card`, `now`
// the expression that holds the reader's clock. And a card an agent is asked first is not shown while it
// waits on its task, unless that rule is switched off. Nor is a card asked through an agent while its
// task is open: that rule holds nothing until the owner names a question role, so it has no switch here.
// The row also gives `expires_at`, `expires_after_days`, `target_kind` and `target_id`.
export const SHOWN_TO_OWNER = (now: string, card = "c", attempts: boolean = attemptsOn()): string =>
  `(${card}.kind <> 'box_health' or starts_with(coalesce(${card}.case_key, ''), '${HOLD_CASE}') or ${card}.created_at <= ${now}::timestamptz - make_interval(hours => ${BOX_HEALTH_QUIET_HOURS}))${
    attempts ? ` and not ${HELD_FOR_AGENT(now, card)}` : ""
  } and not ${HELD_FOR_RELAY(now, card)}`;
