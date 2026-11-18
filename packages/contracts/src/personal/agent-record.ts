import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { ClientName } from "./ids.ts";
import { DeclineReason } from "./primitives.ts";

// An agent's own record: what its work cost the owner and how much of it was used, over the last
// AGENT_RECORD_DAYS days. Not an agent record (agent-records.ts), which is a note an agent writes.
// Counts and decline codes only, never a word from a card, claim or message. Computed at read
// (ledger.agent_records_within): for an agent its own alone, within its own clearance; for the owner
// every agent's, over everything the owner's terminal sees. It changes no clearance, quota or
// threshold.

export const AGENT_RECORD_DAYS = 28;
// The decline reasons a record names, most given first.
const AGENT_RECORD_REASONS = 3;
// The owner's answers that are a no: the list ledger.auto_blocked treats as one, and a decline and a
// wrong, which say no to what an agent put to the owner.
export const AGENT_RECORD_NO_ANSWERS = [
  "reject",
  "no",
  "no_go",
  "dismiss",
  "not_now",
  "different",
  "decline",
  "wrong",
] as const;
// The owner's answers that put a question off rather than settle it. Every other answer is a yes.
export const AGENT_RECORD_DEFERRED_ANSWERS = ["later", "skip", "snooze", "leave", "cant_tell"] as const;

const count = z.number().int().nonnegative();

// Bets: work nobody asked for that an agent proposes as a task routed to itself. Its budget is the bets it
// may place in any BET_DAYS days: BET_BUDGET_START, plus one for each of its bets that settled used in the
// last BET_DAYS days, less BET_OVERTURN_COST for each answer of its own the owner took back in them, held
// to BET_BUDGET_LEAST to BET_BUDGET_MOST. A bet settles by the owner's own acts alone (a keep, a confirmed
// claim from its own evidence) within BET_DAYS of the work being done, so agents cannot raise each other;
// within that window the owner's latest judgment wins.
const BET_DAYS = 7;
const BET_BUDGET_START = 3;
const BET_BUDGET_LEAST = 1;
export const BET_BUDGET_MOST = 10;
const BET_OVERTURN_COST = 2;

// The budget from the bets settled used and the answers taken back, each in the last BET_DAYS days;
// ledger.bets_within computes the same.
export const betBudget = (earned: number, takenBack: number): number =>
  Math.min(BET_BUDGET_MOST, Math.max(BET_BUDGET_LEAST, BET_BUDGET_START + earned - BET_OVERTURN_COST * takenBack));

// `open`, `used` and `unused`: its bets placed in the window, by how each stands. `budget`: as
// betBudget; `left`: what the budget leaves after the bets placed in the last BET_DAYS days.
const AgentBets = z
  .strictObject({
    open: count,
    used: count,
    unused: count,
    budget: z.number().int().min(BET_BUDGET_LEAST).max(BET_BUDGET_MOST),
    left: count,
  })
  .refine((one) => one.left <= one.budget, { message: "left no more than the budget" });
type AgentBets = z.infer<typeof AgentBets>;

// `work`: its tasks finished in the window, by the client that wrote each one's last move, and those
// used (ledger.task_value's `used`: the owner's own signals, and also another agent citing the work
// or marking it handled, so it is said as "used", never as the owner's use).
// `questions`: the cards its work raised in the window, each counted for one agent (its author, else
// the author of the work it decides), by how each ended: the owner's latest answer a yes, a no or a
// deferral; settled from sources by another agent; still waiting in the owner's queue; or otherwise
// closed (withdrawn, expired, or decided with no answer of the owner's). `noReasons`: the reasons the
// owner gave for saying no to its work, from the decline still in force on each piece, most given
// first. `overturned`: answers it relayed as the owner's that the owner took back. `refused`: its
// calls refused for a fault of the call. `bets`: its bets and this week's budget (AgentBets).
export const AgentRecord = z
  .strictObject({
    days: z.literal(AGENT_RECORD_DAYS),
    work: z.strictObject({ done: count, used: count }),
    questions: z.strictObject({
      raised: count,
      yes: count,
      no: count,
      deferred: count,
      byAgent: count,
      waiting: count,
      other: count,
    }),
    noReasons: z
      .array(z.strictObject({ reason: DeclineReason, count: z.number().int().positive() }))
      .max(AGENT_RECORD_REASONS),
    overturned: count,
    refused: count,
    bets: AgentBets,
  })
  .refine((one) => one.work.used <= one.work.done, { message: "used no more than done" })
  .refine(({ questions: q }) => q.yes + q.no + q.deferred + q.byAgent + q.waiting + q.other === q.raised, {
    message: "each question ended one way",
  });
export type AgentRecord = z.infer<typeof AgentRecord>;

// The counts as the database gives them, before they are a record.
export type AgentRecordCounts = {
  done: number;
  used: number;
  raised: number;
  yes: number;
  no: number;
  deferred: number;
  byAgent: number;
  waiting: number;
  other: number;
  noCodes: readonly string[];
  overturned: number;
  refused: number;
  betsOpen: number;
  betsUsed: number;
  betsUnused: number;
  // Bets placed in the last BET_DAYS days.
  betsPlaced: number;
  // Bets that settled used, and answers taken back, in the last BET_DAYS days.
  betsEarned: number;
  betsTakenBack: number;
};

// The record from its counts: the decline codes counted, the most given first, ties in the list's
// order, at most AGENT_RECORD_REASONS; a code outside the list is left out.
export function agentRecordOf(counts: AgentRecordCounts): AgentRecord {
  const tally = new Map<DeclineReason, number>();
  for (const code of counts.noCodes) {
    const reason = DeclineReason.safeParse(code);
    if (reason.success) tally.set(reason.data, (tally.get(reason.data) ?? 0) + 1);
  }
  const order = DeclineReason.options;
  const noReasons = [...tally]
    .sort(([a, x], [b, y]) => y - x || order.indexOf(a) - order.indexOf(b))
    .slice(0, AGENT_RECORD_REASONS)
    .map(([reason, n]) => ({ reason, count: n }));
  const { raised, yes, no, deferred, byAgent, waiting, other } = counts;
  return {
    days: AGENT_RECORD_DAYS,
    work: { done: counts.done, used: counts.used },
    questions: { raised, yes, no, deferred, byAgent, waiting, other },
    noReasons,
    overturned: counts.overturned,
    refused: counts.refused,
    bets: betsOf(counts),
  };
}

function betsOf(counts: AgentRecordCounts): AgentBets {
  const budget = betBudget(counts.betsEarned, counts.betsTakenBack);
  return {
    open: counts.betsOpen,
    used: counts.betsUsed,
    unused: counts.betsUnused,
    budget,
    left: Math.max(0, budget - counts.betsPlaced),
  };
}

// The questions that reached the owner's queue: every one raised but those another agent settled.
export const agentRecordAsked = (record: AgentRecord): number => record.questions.raised - record.questions.byAgent;

// Whether a record holds anything: an empty one is not served in a pack.
export const agentRecordEmpty = (record: AgentRecord): boolean =>
  record.work.done === 0 &&
  record.questions.raised === 0 &&
  record.noReasons.length === 0 &&
  record.overturned === 0 &&
  record.refused === 0 &&
  record.bets.open + record.bets.used + record.bets.unused === 0;

// What the pack's record section tells the agent, code's own words.
export const AGENT_RECORD_SAY =
  "Your own record over the last 28 days: what your work cost the owner and how much of it was used. Ask the owner less where a source could answer.";

// A code a call was refused with: policy.calls' `reason`, else its outcome.
const RefusalCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

// An agent's standing: the first section of its start pack, so it meets them before anything else. Over
// the last STANDING_DAYS days: `bets`, those it placed, those that settled used (the budget's `earned`),
// its budget and what is left of it (as AgentBets); `questions`, those it put to the owner (an
// owner_question it proposed, work it handed to the owner, a write_back needs_owner), those carrying a
// checked `tried`, those not, and its calls refused question_unpaid; `refusals`, its calls refused for a
// fault of the call (AGENT_RECORD_REFUSALS), by code, most first, at most STANDING_CODES_MOST. Counted
// within the agent's own clearance; a call has no label, it is the agent's own act. Ids, counts and codes
// only.
const STANDING_DAYS = BET_DAYS;
export const STANDING_CODES_MOST = 5;
export const AgentStanding = z.strictObject({
  days: z.literal(STANDING_DAYS),
  bets: z
    .strictObject({
      placed: count,
      used: count,
      budget: z.number().int().min(BET_BUDGET_LEAST).max(BET_BUDGET_MOST),
      left: count,
    })
    .refine((one) => one.left <= one.budget, { message: "left no more than the budget" }),
  questions: z
    .strictObject({ asked: count, paid: count, unpaid: count, refused: count })
    .refine((one) => one.paid + one.unpaid === one.asked, { message: "each question paid or not" }),
  refusals: z.array(z.strictObject({ code: RefusalCode, count: z.number().int().positive() })).max(STANDING_CODES_MOST),
});
export type AgentStanding = z.infer<typeof AgentStanding>;

// The counts as the database gives them, before they are a standing.
type AgentStandingCounts = {
  betsPlaced: number;
  betsEarned: number;
  betsTakenBack: number;
  asked: number;
  paid: number;
  refused: number;
  // Its refused calls, counted by code.
  refusals: Readonly<Record<string, number>>;
};

// The standing from its counts: the refusal codes the most first, ties by code, at most
// STANDING_CODES_MOST; a code that is not one, or a count that is none, is left out.
export function agentStandingOf(counts: AgentStandingCounts): AgentStanding {
  const refusals = Object.entries(counts.refusals)
    .filter(([code, n]) => RefusalCode.safeParse(code).success && Number.isInteger(n) && n > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, STANDING_CODES_MOST)
    .map(([code, n]) => ({ code, count: n }));
  const budget = betBudget(counts.betsEarned, counts.betsTakenBack);
  return {
    days: STANDING_DAYS,
    bets: {
      placed: counts.betsPlaced,
      used: counts.betsEarned,
      budget,
      left: Math.max(0, budget - counts.betsPlaced),
    },
    questions: {
      asked: counts.asked,
      paid: counts.paid,
      unpaid: counts.asked - counts.paid,
      refused: counts.refused,
    },
    refusals,
  };
}

// What the pack's standing section tells the agent, code's own words.
export const AGENT_STANDING_SAY =
  "Your standing over the last 7 days. Bets are yours to use: place them on work nobody asked for that would help the owner. A question to the owner pays first: search and read, send tried, and ask only what that leaves open.";

// One ISO week of an agent's record: `week`, its Monday (UTC). `bets`: those
// placed in the week, by how each stands now (used, unused, open), and the budget and what was left
// of it at the week's end, or now for the week under way. `questions`: those put to the owner in the
// week (as AgentStanding counts them), those paid, and its calls refused question_unpaid. `takenBack`:
// answers it relayed as the owner's that the owner took back in the week.
export const AGENT_WEEKS_DEFAULT = 4;
export const AGENT_WEEKS_MOST = 26;
export const AgentWeek = z.strictObject({
  week: DateOnly,
  bets: z
    .strictObject({
      placed: count,
      used: count,
      unused: count,
      open: count,
      budget: z.number().int().min(BET_BUDGET_LEAST).max(BET_BUDGET_MOST),
      left: count,
    })
    .refine((one) => one.used + one.unused + one.open === one.placed, { message: "each bet stands one way" })
    .refine((one) => one.left <= one.budget, { message: "left no more than the budget" }),
  questions: z
    .strictObject({ asked: count, paid: count, refused: count })
    .refine((one) => one.paid <= one.asked, { message: "paid no more than asked" }),
  takenBack: count,
});
export type AgentWeek = z.infer<typeof AgentWeek>;

// `pia agents record`: every registered agent's weeks, newest first, by name.
export const AgentWeeks = z.strictObject({
  at: Timestamp,
  weeks: z.number().int().min(1).max(AGENT_WEEKS_MOST),
  agents: z.array(z.strictObject({ client: ClientName, weeks: z.array(AgentWeek).max(AGENT_WEEKS_MOST) })),
});
export type AgentWeeks = z.infer<typeof AgentWeeks>;

// The System room: every registered agent's record, by name, and its last AGENT_WEEKS_DEFAULT
// weeks, newest first.
export const AgentRecords = z.strictObject({
  at: Timestamp,
  agents: z.array(
    z.strictObject({
      client: ClientName,
      record: AgentRecord,
      weeks: z.array(AgentWeek).max(AGENT_WEEKS_DEFAULT),
    }),
  ),
});
export type AgentRecords = z.infer<typeof AgentRecords>;
