import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { MoveId, OpportunityId, RunId, ULID_PATTERN } from "./ids.ts";
import { CardDetail } from "./owner.ts";
import { SpendLane } from "./owner-reads.ts";
import { code, count, next, OWNER_PAGE_MOST, queryInt, usd } from "./owner-reads-paging.ts";
import { UntrustedString } from "./tools-args.ts";

// Counts, ids and codes only. A day is the owner's (their time zone, UTC while unset), spend's
// included (R-T8).
export const LedgerDayArgs = z.strictObject({ day: DateOnly });
export type LedgerDayArgs = z.infer<typeof LedgerDayArgs>;
export const LedgerDay = z.strictObject({
  day: DateOnly,
  runs: count,
  moves: count,
  spend: z.array(z.strictObject({ lane: SpendLane, usd })),
  itemsRead: count,
  claimsMade: count,
  decisions: count,
  sends: count,
});
export type LedgerDay = z.infer<typeof LedgerDay>;
// The piece of work an event or a span belongs to, where the ledger names one.
const ledgerWork = z.union([RunId, MoveId, OpportunityId]).nullable();
// A span on a worker's lane: a run (the reasoner's), a move from plan_move to report_move (its
// agent's, by client name), a sync (the pipeline's, no piece of work). `to` is null while open.
// `read`, a sync's only: what it read from the owner's accounts, the sums of the sync outcomes it recorded
// within the ledger's compartments: items looked at (`decided`), kept (`stored`), left out as junk,
// held back, and removed at the source; absent where it recorded none. `code`, a sync's only: how
// it ended (`ok`, or why it did not).
// `lastStep` and `heldUntil`, a move's that was never reported only: the time of its agent's last
// step on the work since its plan, and, while the move may still report (its agent holds the work's
// claim, taken before the plan, and no later move was planned on it), when that claim runs out. A
// move with neither is drawn from its plan to its last step: started, never reported back.
export const LedgerSpan = z.strictObject({
  worker: z.string().regex(/^(pipeline|identity|reasoner|owner|client:[a-z][a-z0-9-]{1,39})$/),
  from: Timestamp,
  to: Timestamp.nullable(),
  work: ledgerWork,
  read: z.strictObject({ decided: count, stored: count, junk: count, held: count, removed: count }).optional(),
  code: code.optional(),
  lastStep: Timestamp.optional(),
  heldUntil: Timestamp.optional(),
});
export type LedgerSpan = z.infer<typeof LedgerSpan>;
export const LedgerLanes = z.strictObject({ day: DateOnly, spans: z.array(LedgerSpan) });
export type LedgerLanes = z.infer<typeof LedgerLanes>;
// One `ledger.record_events` row, as the feed and the event stream serve it: the row it is an
// event of, the event and its code, who wrote it (`owner`, `reasoner`, `run:<id>`, `system:<code>`,
// or `client:<name>`; null for any other form) and its piece of work. Never its body.
export const LedgerEvent = z.strictObject({
  id: z.number().int().positive(),
  at: Timestamp,
  row: z.strictObject({ kind: code, id: z.string().min(1).max(80) }),
  event: code,
  code: code.nullable(),
  by: z
    .string()
    .regex(
      new RegExp(`^(owner|reasoner|run:run_${ULID_PATTERN}|system:[a-z][a-z0-9_]{0,63}|client:[a-z][a-z0-9-]{1,39})$`),
    )
    .nullable(),
  work: ledgerWork,
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;
// `works`: what each opportunity the page's events belong to is, its summary opened as the agent's
// words, so a row is named by what it is before the owner opens it. Untainted only; one the key file
// cannot open, or with no summary, is left out. `cards`: each card an event of the page is on, as
// the card read shows it (no view recorded), so "Your decisions" names what each answer was on and
// a card the system raised or withdrew is named by what it asked. Untainted, within the ledger's
// compartments.
export const LedgerFeed = z.strictObject({
  events: z.array(LedgerEvent).max(OWNER_PAGE_MOST),
  works: z.array(z.strictObject({ work: OpportunityId, summary: UntrustedString })).max(OWNER_PAGE_MOST),
  cards: z.array(CardDetail).max(OWNER_PAGE_MOST),
  next,
});
export type LedgerFeed = z.infer<typeof LedgerFeed>;
export const EventsArgs = z.strictObject({ after: queryInt(0, Number.MAX_SAFE_INTEGER) });
export type EventsArgs = z.infer<typeof EventsArgs>;
const SERIES_DAYS_MOST = 90;
export const SeriesArgs = z.strictObject({ days: queryInt(1, SERIES_DAYS_MOST) });
export type SeriesArgs = z.infer<typeof SeriesArgs>;
export const SpendSeries = z.strictObject({ days: z.array(z.strictObject({ day: DateOnly, lane: SpendLane, usd })) });
export type SpendSeries = z.infer<typeof SpendSeries>;
export const CardLoadSeries = z.strictObject({ days: z.array(z.strictObject({ day: DateOnly, pending: count })) });
export type CardLoadSeries = z.infer<typeof CardLoadSeries>;
