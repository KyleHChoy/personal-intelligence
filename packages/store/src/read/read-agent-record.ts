import {
  type AgentRecord,
  type AgentRecordCounts,
  type AgentStanding,
  agentRecordOf,
  agentStandingOf,
} from "@intelligence/contracts/personal";
import type { Ctx } from "../core/read-ctx.ts";

// The caller's own record, counted by ledger.my_agent_record and
// ledger.my_bets within the caller's clearance alone, so no row it cannot see moves a number it is
// told (invariant 6). Its own alone: no client reads another's. Counts and decline codes only. Each
// function answers one row, called once and taken whole as JSON, so the statement has no order to
// give; `(f()).*` would run it once per column.
export const RECORD_COLUMNS = `r.done, r.used, r.raised, r.yes, r.no, r.deferred, r.by_agent as "byAgent", r.waiting,
  r.other, r.no_codes as "noCodes", r.overturned, r.refused`;
// A bets row's columns, as the record's counts name them.
export const BET_COLUMNS = `b.open as "betsOpen", b.used as "betsUsed", b.unused as "betsUnused", b.placed as "betsPlaced",
  b.earned as "betsEarned", b.taken_back as "betsTakenBack"`;
const MINE = "select to_jsonb(ledger.my_agent_record($1)) as record, to_jsonb(ledger.my_bets($1)) as bets";

type Row = Omit<AgentRecordCounts, "byAgent" | "noCodes" | `bets${string}`> & { by_agent: number; no_codes: string[] };
type Bets = { open: number; used: number; unused: number; placed: number; earned: number; taken_back: number };

export async function ownRecordOf(ctx: Ctx, now: Date): Promise<AgentRecord | null> {
  const [row] = await ctx.run<{ record: Row | null; bets: Bets | null }>(MINE, [now.toISOString()]);
  if (row?.record == null || row.bets === null) return null;
  const { by_agent, no_codes, ...rest } = row.record;
  return agentRecordOf({
    ...rest,
    byAgent: by_agent,
    noCodes: no_codes,
    betsOpen: row.bets.open,
    betsUsed: row.bets.used,
    betsUnused: row.bets.unused,
    betsPlaced: row.bets.placed,
    betsEarned: row.bets.earned,
    betsTakenBack: row.bets.taken_back,
  });
}

// The caller's standing over the last seven days, counted
// by ledger.my_standing within the caller's clearance alone. Null for a client with no clearance.
// One row, taken whole as JSON as the record is, so the statement has no order to give.
const STANDING = "select to_jsonb(ledger.my_standing($1)) as standing";
type Standing = {
  placed: number;
  earned: number;
  taken_back: number;
  asked: number;
  paid: number;
  refused: number;
  refusals: Record<string, number>;
};

export async function ownStandingOf(ctx: Ctx, now: Date): Promise<AgentStanding | null> {
  const [row] = await ctx.run<{ standing: Standing }>(STANDING, [now.toISOString()]);
  if (row === undefined) return null;
  const one = row.standing;
  return agentStandingOf({
    betsPlaced: one.placed,
    betsEarned: one.earned,
    betsTakenBack: one.taken_back,
    asked: one.asked,
    paid: one.paid,
    refused: one.refused,
    refusals: one.refusals,
  });
}
