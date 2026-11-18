import type { ClientId, OpportunityId, OpportunityStatus, OutcomeLinkKind } from "@intelligence/contracts/personal";
import {
  type ModelHold,
  modelHold,
  type OutcomeFlowSkip,
  pairKey,
  planOutcome,
} from "@intelligence/personal-core/planner";
import { relationRules } from "@intelligence/personal-core/views";
import { type Query, stamp } from "../core/db.ts";
import { outcomeRules } from "../core/outcome-rules.ts";
import { lockRows } from "../core/queue.ts";
import { latestRow } from "../core/statements.ts";
import { OUTCOME_RAISE } from "../pipeline/triggers.ts";
import { closeWork, recordEvent } from "./dispatch-write.ts";

// As pi_work, the tick raises the trigger rows applied outcome links and a model's unapplied links
// wrote, one work a transaction; a model's link it lets act it applies (ledger.apply_outcome_link). It
// locks the work, reads its state and its links afresh, asks planOutcome (personal-core) what they do,
// and writes that: the work's status through ledger.record_events, a close's lease and intentions given
// up as every close gives them up, the notice to the agent that holds or last held it
// (ledger.outcome_notice, which checks its clearance for the work and the link), and the rows' raised
// mark. A model's links count only while modelHold holds nothing: the owner's word outranks them, and
// reversals of their closes past the relation switch's bound turn them off. Safe to repeat: a row raised
// is never read again. Ids, codes and counts.

const BY = "system:outcomes";
// The works a tick takes at most; the rest wait for the next.
const WORKS_PER_TICK = 200;

// The works whose outcome rows wait, oldest row first.
const WAITING = `
  select t.fact_key_fp as opportunity from ledger.trigger_log t
  where t.raise = '${OUTCOME_RAISE}' and t.raised_at is null
  group by t.fact_key_fp order by min(t.id) limit $1`;

// The work's rows not yet raised, with their links.
const ROWS = `
  select t.id::text as id, l.id::text as link, l.kind, l.expected_outcome_id::text as expectation, l.evidence_id, l.applied, l.tainted_at, l.move_result_link_id, l.compartments, l.judge
  from ledger.trigger_log t join ledger.outcome_links l on l.id = t.outcome_link_id
  where t.raise = '${OUTCOME_RAISE}' and t.raised_at is null and t.fact_key_fp = $1 and l.opportunity_id = $1
  order by t.id`;

// The pairs of its links raised in earlier ticks.
const RAISED = `
  select l.id::text as link, l.expected_outcome_id::text as expectation, l.evidence_id
  from ledger.trigger_log t join ledger.outcome_links l on l.id = t.outcome_link_id
  where t.raise = '${OUTCOME_RAISE}' and t.raised_at is not null and t.fact_key_fp = $1 and l.opportunity_id = $1`;

const STATE = `
  select o.compartments, o.tainted_at is not null as tainted, r.event, r.at, r.by
  from ledger.opportunities o
  left join lateral (${latestRow("e.event, e.at, e.by", "opportunity", "o.id", { alias: "e" })}) r on true
  where o.id = $1`;

// A model judge's links, by the judge's class.
const MODEL_JUDGE = "model:";

// The closes a model's link decided in the window, and of them those reversed. The unit is one
// close: an `outcome_met` or `outcome_not_met` the tick wrote, whose deciding link was a model's.
// The tick marks the trigger rows of the links it raised with the close's own time, so the links
// that could have decided a close are its work's applied links of its kind whose rows were raised
// at that instant. The close is the model's when every one of them is a model's: one a rule's link
// could have decided, alone or beside a model's, is not counted. However many links one tick
// applied, each close counts once. A close is reversed when, before the tick closes the work again,
// an agent's report on a move of that work says the opposite: `failed` or `blocked` after
// `outcome_met`, `done` after `outcome_not_met`, which report_move takes as reopening it. Order is
// by the events' ids, never by comparing two clocks. The owner's Done or Drop on an outcome card is
// not counted: it ends the work and says nothing of whether its outcome came.
// The links that could have decided close `e`: its work's applied links of its kind, raised with it.
const DECIDERS = `
  select 1 from ledger.outcome_links l join ledger.trigger_log t on t.outcome_link_id = l.id and t.raise = '${OUTCOME_RAISE}'
  where l.opportunity_id = e.row_id and l.applied and l.tainted_at is null and l.move_result_link_id is null
    and l.kind = case e.event when 'outcome_met' then 'met' else 'not_met' end and t.raised_at = e.at`;
const MODEL_OVERTURNS = `
  select count(*)::int as closed,
    count(*) filter (where exists (
      select 1 from ledger.moves v join ledger.record_events r on r.row_kind = 'move' and r.row_id = v.id
      where v.opportunity_id = e.row_id and r.by like 'client:%' and r.id > e.id
        and ((e.event = 'outcome_met' and r.event in ('failed', 'blocked')) or (e.event = 'outcome_not_met' and r.event = 'done'))
        and not exists (
          select 1 from ledger.record_events n
          where n.row_kind = 'opportunity' and n.row_id = e.row_id and n.by = '${BY}'
            and n.event in ('outcome_met', 'outcome_not_met') and n.id > e.id and n.id < r.id)))::int as overturned
  from ledger.record_events e
  where e.row_kind = 'opportunity' and e.by = '${BY}' and e.event in ('outcome_met', 'outcome_not_met')
    and e.at > $1::timestamptz - make_interval(days => $2)
    and exists (${DECIDERS} and l.judge like '${MODEL_JUDGE}%')
    and not exists (${DECIDERS} and l.judge not like '${MODEL_JUDGE}%')`;

// The open statuses an outcome moves (planOutcome moves none of `proposed`, `later` or `go`).
const OPEN: readonly string[] = ["claimed", "handed_to_owner"];

export type RaisedOutcome = {
  rows: number;
  status: OpportunityStatus | null;
  woke: ClientId | null;
  skip: OutcomeFlowSkip | "gone" | null;
  // Why the work's model links counted for nothing, when they did.
  held: ModelHold | null;
};

// The closes a model's link decided within the relation switch's window, and those reversed.
export async function modelOverturns(query: Query, now: Date): Promise<{ closed: number; overturned: number }> {
  const [row] = await query<{ closed: number; overturned: number }>(MODEL_OVERTURNS, [
    stamp(now),
    relationRules().switch.rateWindowDays,
  ]);
  return row ?? { closed: 0, overturned: 0 };
}

export const outcomeWorks = async (query: Query): Promise<OpportunityId[]> =>
  (await query<{ opportunity: OpportunityId }>(WAITING, [WORKS_PER_TICK])).map((row) => row.opportunity);

export async function raiseOutcome(query: Query, opportunity: OpportunityId, now: Date): Promise<RaisedOutcome> {
  await lockRows(query, [opportunity]);
  const rows = await query<{
    id: string;
    link: string;
    kind: OutcomeLinkKind;
    expectation: string | null;
    evidence_id: string | null;
    applied: boolean;
    tainted_at: Date | null;
    move_result_link_id: string | null;
    compartments: string[];
    judge: string;
  }>(ROWS, [opportunity]);
  if (rows.length === 0) return { rows: 0, status: null, woke: null, skip: null, held: null };
  const mark = async (): Promise<void> => {
    await query("update ledger.trigger_log set raised_at = $2 where id = any ($1::bigint[]) and raised_at is null", [
      rows.map((row) => row.id),
      stamp(now),
    ]);
  };
  const [state] = await query<{
    compartments: string[];
    tainted: boolean;
    event: OpportunityStatus | null;
    at: Date | null;
    by: string | null;
  }>(STATE, [opportunity]);
  if (state === undefined) {
    await mark();
    return { rows: rows.length, status: null, woke: null, skip: "gone", held: null };
  }
  const raised = await query<{ link: string; expectation: string | null; evidence_id: string | null }>(RAISED, [
    opportunity,
  ]);
  // A link tainted since its row was written, or never one that flows, moves nothing; nor does a
  // model's while modelHold holds it. A model's link comes unapplied, and is applied here when the
  // tick lets it through, so one held never takes effect anywhere.
  const byModel = (row: { judge: string }): boolean => row.judge.startsWith(MODEL_JUDGE);
  const live = rows.filter(
    (row) => (row.applied || byModel(row)) && row.tainted_at === null && row.move_result_link_id === null,
  );
  let held: ModelHold | null = null;
  if (live.some(byModel)) {
    held = modelHold(
      { status: state.event, by: state.by },
      await modelOverturns(query, now),
      relationRules().switch.overturnRateMax,
    );
  }
  const flowing = held === null ? live : live.filter((row) => !byModel(row));
  const plan = planOutcome(
    {
      status: state.event,
      statusAt: state.at,
      tainted: state.tainted,
      links: flowing.map((row) => ({
        id: Number(row.link),
        kind: row.kind,
        expectation: row.expectation,
        evidence: row.evidence_id,
      })),
      raisedPairs: new Set(
        raised.map((row) => pairKey({ id: Number(row.link), expectation: row.expectation, evidence: row.evidence_id })),
      ),
    },
    now,
    outcomeRules().graceDays,
  );
  if ("skip" in plan) {
    await mark();
    return { rows: rows.length, status: null, woke: null, skip: plan.skip, held };
  }
  // Every model link the tick lets through takes effect now, the one that decides a close and the
  // others alike, in the transaction that moves the work and before the notice, which names only an
  // applied link. A held link is not among them and stays unapplied. When the function applies one
  // not (it was tainted since it was read), the tick moves and wakes nothing and leaves the rows
  // unraised, so the next tick reads the work again without it.
  for (const row of flowing) {
    if (!byModel(row) || row.applied) continue;
    const [done] = await query<{ applied: boolean }>("select ledger.apply_outcome_link($1::bigint) as applied", [
      row.link,
    ]);
    if (done?.applied !== true) return { rows: rows.length, status: null, woke: null, skip: null, held };
  }
  if (plan.status !== null) {
    // Its label: the work's and the deciding link's (invariant 4), so a viewer not cleared for the
    // evidence sees no change it moved (invariant 6).
    const decided = flowing.find((row) => Number(row.link) === plan.decidedBy)?.compartments ?? [];
    await recordEvent(query, {
      kind: "opportunity",
      id: opportunity,
      event: plan.status,
      at: now,
      compartments: [...state.compartments, ...decided],
      by: BY,
    });
    // Work that was open gives up its lease and its intentions, as every close does, when the
    // evidence is within the work's label. Otherwise a viewer cleared for the work alone still
    // reads it open, so its lease runs out by itself and the tick cancels its intentions when due.
    if (
      state.event !== null &&
      OPEN.includes(state.event) &&
      decided.every((one) => state.compartments.includes(one))
    ) {
      await closeWork(query, opportunity, now, BY);
    }
  }
  const [woke] =
    plan.wake === null
      ? []
      : await query<{ client: ClientId | null }>("select ledger.outcome_notice($1, $2) as client", [
          opportunity,
          plan.wake,
        ]);
  await mark();
  return { rows: rows.length, status: plan.status, woke: woke?.client ?? null, skip: null, held };
}
