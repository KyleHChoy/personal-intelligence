import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ClientId, ClientName, RequestId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";

// Learning from the owner's answers: how often they confirm what one agent proposes about them, by
// kind of fact, computed at read from their answers (policy.confirm_rates). Only their own answers
// on about-you cards count, and their Not true on a fact kept under a standing release as a reject;
// never a settlement, a ruling of the cleanup's or a release under a grant. Only answers after the
// cleanup's first apply count: they said their earlier confirms were no endorsement.

// A rate is over the latest 50 answers, none older than 60 days: the numbers are the function's.
// Below this many answers a kind stays asked by card and nothing is proposed or told.
const RATE_LEAST_ANSWERS = 30;
// At or above this rate, with no standing release on, one card proposes the owner turn one on; while
// one is on, the rate is over the held-out cards' answers alone, and below it one card proposes the
// lift. Neither card grants or lifts anything: the owner does that in the terminal.
const RATE_KEEP = 0.9;
// While one is on, the lift is also proposed when the owner marked more than this share of the facts
// it kept in the window not true, and at least NOT_TRUE_LEAST of them: counted apart from the rate,
// since they are no sample of the cards.
const NOT_TRUE_SHARE = 0.1;
const NOT_TRUE_LEAST = 3;
// At or below this rate the agent's brief says, in a line code writes, which kinds the owner mostly
// rejects from it, with counts, never the rejected words.
const RATE_TELL = 0.3;
// While a standing release is on, this share of that agent's quoted proposals of that kind is still
// asked by card, chosen from the record's id, so its answers keep the rate measured.
export const HOLDOUT_SHARE = 0.15;
// After the owner answers a proposal card, none for the same agent and kind for this many days.
export const SUGGESTION_QUIET_DAYS = 30;

// learning_switch: the owner's switch for one agent: off, no proposal card and no brief line for it.
export const LearningSwitchDetails = z.strictObject({ client: ClientId, on: z.boolean() });
export type LearningSwitchDetails = z.infer<typeof LearningSwitchDetails>;
// `facts_clean`, the owner's apply of the fact cleanup (`pia facts clean --apply --plan HASH`): the dry
// run's plan it applied, after which the confirm rates count answers.
export const FactsCleanDetails = z.strictObject({ plan: Hex64 });
export type FactsCleanDetails = z.infer<typeof FactsCleanDetails>;

// The dashboard's write and `pia facts learning AGENT on|off`.
export const LearningSwitchBody = z.strictObject({ client: ClientName, on: z.boolean(), requestId: RequestId });
export type LearningSwitchBody = z.infer<typeof LearningSwitchBody>;

// learning: still counting, or between the two thresholds; suggested: high enough that a standing
// release is proposed; granted: a standing release is on; told: low enough that the agent's brief
// says so. A switched-off agent is only ever learning or granted.
export const ConfirmRateState = z.enum(["learning", "suggested", "granted", "told"]);
export type ConfirmRateState = z.infer<typeof ConfirmRateState>;

// Settings: one row for an agent and a kind of fact. `kind` is a claim type word: about-you kinds
// and the people kinds an agent proposes through the same card. Under a grant, `answers` and
// `confirmed` are the held-out cards', and `kept` and `notTrue` the facts it kept in the window and
// those the owner marked not true; both 0 with none.
const ConfirmRateView = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  answers: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  notTrue: z.number().int().nonnegative(),
  state: ConfirmRateState,
});

// Settings: each agent with its switch and its rates; `since`, when counting began (the cleanup's
// first apply), null before it.
export const ConfirmRatesView = z.strictObject({
  since: Timestamp.nullable(),
  agents: z.array(z.strictObject({ client: ClientName, on: z.boolean(), rates: z.array(ConfirmRateView) })),
});
export type ConfirmRatesView = z.infer<typeof ConfirmRatesView>;

// The line an agent's brief carries when the owner mostly rejects some kinds from it: written by
// code from counts alone.
export const BriefRejected = z.string().max(600);
export type BriefRejected = z.infer<typeof BriefRejected>;

export type RateCounts = { kind: string; answers: number; confirmed: number };
export type GrantCounts = RateCounts & { granted: boolean; kept: number; notTrue: number };

// Whether a card proposes a standing release (none on, the rate high enough over enough answers)
// or its lift (one on, and its held-out rate fell, or too many of the facts it kept were not true).
export const grantDue = (row: GrantCounts): boolean =>
  !row.granted && row.answers >= RATE_LEAST_ANSWERS && row.confirmed / row.answers >= RATE_KEEP;
export const liftDue = (row: GrantCounts): boolean =>
  row.granted &&
  ((row.answers >= RATE_LEAST_ANSWERS && row.confirmed / row.answers < RATE_KEEP) ||
    (row.notTrue >= NOT_TRUE_LEAST && row.notTrue > row.kept * NOT_TRUE_SHARE));

// A rate's state from its counts, whether a standing release is on and whether learning is on.
export function rateState(counts: RateCounts, granted: boolean, on: boolean): ConfirmRateState {
  if (granted) return "granted";
  if (!on || counts.answers < RATE_LEAST_ANSWERS) return "learning";
  const rate = counts.confirmed / counts.answers;
  return rate >= RATE_KEEP ? "suggested" : rate <= RATE_TELL ? "told" : "learning";
}

// The brief's line from the agent's own counts, or null when no kind is low enough.
export function rejectedLine(rows: readonly RateCounts[]): string | null {
  const low = rows
    .filter((row) => row.answers >= RATE_LEAST_ANSWERS && row.confirmed / row.answers <= RATE_TELL)
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map((row) => `${row.kind}, ${row.answers - row.confirmed} of the last ${row.answers} rejected`);
  return low.length === 0
    ? null
    : `The owner rejects most of what you propose about them of these kinds: ${low.join("; ")}. Propose these only when you can quote their own words.`;
}
