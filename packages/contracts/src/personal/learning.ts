import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { ClientId, OpportunityId } from "./ids.ts";
import type { OpportunityKind, OpportunityStatus, SilenceReason } from "./opportunity-words.ts";

// Learning and evaluation: the owner's signals, the outcome checks and the reports. Every report is
// computed at read under pi_admin and shown to the owner alone: ids, words, counts, shares,
// intervals and times only. owner.ts reads HarmKind from here, so this file imports nothing of
// owner.ts, work.ts or ladder.ts at run time (each of them reaches owner.ts).

const word = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const count = z.number().int().nonnegative();
const share = z.number().min(0).max(1);

export const HarmKind = z.enum(["unwanted", "wrong_fact", "wrong_recipient", "exposure", "other"]);
export type HarmKind = z.infer<typeof HarmKind>;

export const SilenceVerdict = z.enum(["missed", "fine"]);
export type SilenceVerdict = z.infer<typeof SilenceVerdict>;

// The others say why the system could not judge.
export const JUDGMENT_SILENCES: readonly SilenceReason[] = Object.freeze([
  "nothing_to_do",
  "below_bar",
  "waiting_is_better",
] as const);

export const OutcomeCheck = z.enum(["answered", "done"]);
export type OutcomeCheck = z.infer<typeof OutcomeCheck>;

// The shared contracts' `unknown` is not a row here: a case not yet assessed has no row.
export const OutcomeResult = z.enum(["met", "not_met"]);
export type OutcomeResult = z.infer<typeof OutcomeResult>;

export const ResultKind = z.enum(["reply", "meeting"]);
export type ResultKind = z.infer<typeof ResultKind>;

// `from` is what the horizon counts from: the send's begun_at, the opportunity's first send, its
// event's start (no days), or its due time, else its go plus `horizonDays`. ledger.assess_outcomes
// holds the same numbers.
export type OutcomeCheckRow = Readonly<{
  check: OutcomeCheck;
  from: "send" | "first_send" | "event_start" | "due_or_go";
  horizonDays: number | null;
}>;
const row = (check: OutcomeCheck, from: OutcomeCheckRow["from"], horizonDays: number | null): OutcomeCheckRow =>
  Object.freeze({ check, from, horizonDays });
// An owner_question has no outcome check: it is done when the owner's reply is recorded, and
// ledger.assess_outcomes does not read it. Nor a research gap flag: it closes when its gap fills.
// Nor an introduction: whether it was made is the owner's confirmed connection; its sends are
// checked as every send is.
export const OUTCOME_CHECKS: Readonly<
  Record<"send" | Exclude<OpportunityKind, "owner_question" | "research" | "introduction">, OutcomeCheckRow>
> = Object.freeze({
  send: row("answered", "send", 14),
  follow_up: row("answered", "first_send", 14),
  reply: row("answered", "first_send", 14),
  meeting_prep: row("done", "event_start", null),
  investigate: row("done", "due_or_go", 30),
  goal_step: row("done", "due_or_go", 30),
  life_admin: row("done", "due_or_go", 30),
});

export const OUTCOME_LINK_DAYS = 30;
export const OUTCOME_SETTLE_DAYS = 3;

// `owner` today; a later source is named by the item that adds it.
export const ForecastSource = word;
export type ForecastSource = z.infer<typeof ForecastSource>;

// A 95 percent Wilson interval (the ladder's `wilson`), low first.
export const Interval = z
  .strictObject({ low: share, high: share })
  .refine((value) => value.low <= value.high, { message: "low after high" });
export type Interval = z.infer<typeof Interval>;

// Never without its review minutes and harm, so neither is optional.
export const HeadlineWeek = z.strictObject({
  // The Monday the week begins on, in UTC.
  week: DateOnly.refine((day) => new Date(`${day}T00:00:00Z`).getUTCDay() === 1, { message: "not a Monday" }),
  acted: count,
  cards: count,
  labelled: count,
  undeliberate: count,
  reviewMinutes: z.number().nonnegative(),
  unmeasured: count,
  silenceWeeksUnsampled: count,
  harm: z.strictObject({
    marked: z.strictObject(
      Object.fromEntries(HarmKind.options.map((kind) => [kind, count])) as Record<HarmKind, typeof count>,
    ),
    correctedAfterItLeft: count,
    exposures: count,
    reveals: count,
  }),
});
export type HeadlineWeek = z.infer<typeof HeadlineWeek>;

const Band = z.strictObject({
  from: share,
  to: share,
  count,
  meanProbability: share.nullable(),
  shareMet: share.nullable(),
  interval: Interval.nullable(),
});

// One source's forecasts against their assessments. Under 10 assessed cases a source shows its
// count and `insufficient`, and no score. A run's forecasts are scored by prompt version.
const ForecastScore = z
  .strictObject({
    source: ForecastSource,
    promptVersion: z.number().int().positive().nullable(),
    count,
    insufficient: z.boolean(),
    brier: share.nullable(),
    bands: z.array(Band),
  })
  .refine((score) => score.insufficient === score.count < 10, {
    message: "insufficient exactly under 10 cases",
    path: ["insufficient"],
  })
  .refine((score) => (score.brier === null) === score.insufficient, {
    message: "a score exactly when sufficient",
    path: ["brier"],
  });

// The share of deliberate go answers whose case was met, beside the undeliberate ones.
const ShareMet = z.strictObject({
  count,
  met: count,
  share: share.nullable(),
  interval: Interval.nullable(),
  undeliberate: count,
});

export const ScoreReport = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  forecasts: z.array(ForecastScore),
  owner: ShareMet,
  rungZero: ShareMet,
});
export type ScoreReport = z.infer<typeof ScoreReport>;

const CountShare = z.strictObject({ count, share: share.nullable(), interval: Interval.nullable() });
export const ClientStats = z.strictObject({
  client: ClientId,
  from: Timestamp,
  to: Timestamp,
  claims: count,
  corroborated: CountShare,
  disputed: CountShare,
  retracted: CountShare,
  unconfirmed: CountShare,
  records: count,
  flagged: count,
  tainted: count,
  // Null until the echo mark exists.
  echoes: count.nullable(),
});
export type ClientStats = z.infer<typeof ClientStats>;

// `scored` is false where the table says "not scored". At rung 1, `calibration` is the latest
// ledger.calibration_reports row as is.
export const RungReport = z.strictObject({
  point: word,
  version: z.number().int().positive(),
  rung: z.number().int().min(0).max(4),
  from: Timestamp,
  to: Timestamp,
  calls: count,
  decided: count,
  escalated: count,
  judged: count,
  agree: count,
  share: share.nullable(),
  interval: Interval.nullable(),
  scored: z.boolean(),
  calibration: z
    .strictObject({ at: Timestamp, agreement: share.nullable(), agreement28d: share.nullable() })
    .nullable(),
});
export type RungReport = z.infer<typeof RungReport>;

export const ReplayReport = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  client: ClientId.nullable(),
  decisions: count,
  agree: count,
  differ: count,
  generationChanged: count,
});
export type ReplayReport = z.infer<typeof ReplayReport>;

// The summary is the opportunity's, opened for the terminal.
const BOARD_STATUSES = [
  "proposed",
  "go",
  "claimed",
  "handed_to_owner",
  "later",
] as const satisfies readonly OpportunityStatus[];
export const BoardView = z.strictObject({
  columns: z.array(
    z.strictObject({
      status: z.enum(BOARD_STATUSES),
      items: z.array(
        z.strictObject({ id: OpportunityId, kind: word, dueAt: Timestamp.nullable(), summary: z.string() }),
      ),
    }),
  ),
  closed: z.strictObject({ done: count, noGo: count }),
});
export type BoardView = z.infer<typeof BoardView>;
