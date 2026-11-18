import { GapTrigger, LOOP_NAMES, type LoopName, type LoopRow, type LoopsView } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { RELAYED_CODE } from "../../cards/card-kind-row.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { OutcomeMetric } from "../../core/outcome-thresholds.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { KIND_ON } from "../extraction/admin-dream.ts";
import { claimedResults, gapSupplyLine } from "./admin-outcomes.ts";
import { defectsClosed } from "./admin-outcomes-goal.ts";
import type { Clock } from "./admin-outcomes-health.ts";
import { ownerQuestions } from "./admin-outcomes-questions.ts";
import { unattendedRoles } from "./admin-outcomes-roles.ts";
import { taskValue } from "./admin-outcomes-value.ts";

// `pia loops [--days N]`: what each autonomous loop produced over the last `days` days and over the
// `days` before, counts only, so a loop that stopped is seen. A number `pia outcomes` already
// computes is read from its own query; the rest count rows by when they were written. Every row
// with a label is counted within the key file's compartments but the restricted ones. Writes nothing.

export const LOOPS_DAYS = { min: 1, max: 90, unset: 7 } as const;

type Counts = Record<string, number>;

// The rows the outcomes queries do not already count, over [$1, $2) within $3.
const OWN = `
  select
    (select count(*)::int from knowledge.claims where created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as claims,
    (select count(*)::int from ledger.dream_nights where stopped in ('ok', 'budget') and ended_at >= $1 and ended_at < $2) as passes,
    (select count(*)::int from knowledge.claim_relations r
     where starts_with(r.judged_by, 'model:') and r.judged_at >= $1 and r.judged_at < $2 and r.compartments <@ $3::text[]) as relations,
    (select count(*)::int from knowledge.claim_relations r
     where starts_with(r.judged_by, 'model:') and r.compartments <@ $3::text[]
       and policy.relation_effective(r.id, r.judged_by, r.kind, r.judged_at, now()) and ${KIND_ON("r")}
       and exists (select 1 from ledger.source_checks s
                   where s.target = 'relation' and s.relation_id = r.id and s.live and s.verdict = 'supported'
                     and s.created_at >= $1 and s.created_at < $2)) as effective,
    (select count(*)::int from ledger.dream_findings where created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as findings,
    (select count(*)::int from ledger.dream_identity_candidates
     where created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as identity_candidates,
    (select count(*)::int from ledger.cards
     where kind = 'lesson' and tainted_at is null and created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as lessons_proposed,
    (select count(*)::int from ledger.record_events e join ledger.hypotheses h on h.id = e.row_id and h.kind = 'lesson'
     where e.row_kind = 'hypothesis' and e.event = 'confirmed' and e.by = 'owner' and e.tainted_at is null
       and e.code is distinct from '${RELAYED_CODE}'
       and e.at >= $1 and e.at < $2 and e.compartments <@ $3::text[]) as lessons_confirmed,
    (select count(*)::int from ledger.expected_outcomes
     where origin = 'stated' and created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as outcomes_stated,
    (select count(*)::int from ledger.outcome_links
     where applied and tainted_at is null and judged_at >= $1 and judged_at < $2 and compartments <@ $3::text[]) as links_applied,
    (select count(*)::int from ledger.improvements
     where tainted_at is null and created_at >= $1 and created_at < $2 and compartments <@ $3::text[]) as improvements_filed,
    (select count(*)::int from ledger.opportunities o
     where o.gap_trigger = 'owner_queue' and o.created_at >= $1 and o.created_at < $2 and o.compartments <@ $3::text[]) as handed_over,
    (select count(*)::int from ledger.opportunities o
     where o.gap_trigger = 'owner_queue' and o.created_at >= $1 and o.created_at < $2 and o.compartments <@ $3::text[]
       and exists (select 1 from ledger.record_events e where e.row_kind = 'opportunity' and e.row_id = o.id and e.event = 'done')) as handed_over_told`;

type Own = {
  claims: number;
  passes: number;
  relations: number;
  effective: number;
  findings: number;
  identity_candidates: number;
  lessons_proposed: number;
  lessons_confirmed: number;
  outcomes_stated: number;
  links_applied: number;
  improvements_filed: number;
  handed_over: number;
  handed_over_told: number;
};

const named = (metrics: OutcomeMetric[], name: string): OutcomeMetric | undefined =>
  metrics.find((one) => one.metric === name);
const part = (metric: OutcomeMetric | undefined, key: string): number => metric?.parts?.[key] ?? 0;

// One window, ending at `until`, `days` long.
async function windowCounts(
  query: Query,
  days: number,
  until: Date,
  within: string[],
): Promise<Record<LoopName, Counts>> {
  const clock: Clock = { now: until, within, ago: (back) => stamp(new Date(until.getTime() - back * DAY_MS)) };
  const since = clock.ago(days);
  const to = stamp(until);
  const [own] = (await query<Own>(OWN, [since, to, within])) as [Own];
  const gaps = await gapSupplyLine(query, days, clock);
  const claimed = await claimedResults(query, days, clock);
  const unattended = await unattendedRoles(query, clock);
  const value = await taskValue(query, since, to, within);
  const questions = await ownerQuestions(query, since, to, within);
  const asked = named(questions, "owner_questions_per_week");
  const bets = named(questions, "bets_used_share");
  const tried = named(questions, "owner_questions_attempted");
  const closed = await defectsClosed(query, since, to, within);
  const byTrigger = Object.fromEntries(
    Object.entries(gaps.parts ?? {}).filter(([key]) => key === "other" || GapTrigger.safeParse(key).success),
  );
  // Raised: every card with a choice in the window. Those a rule stopped, code or an agent settled,
  // or still held for an agent never reached the owner. `triedByAgent`: an agent's task answered it
  // before the owner did; `samePersonBatches`: what two agents could not settle, a kind of its own.
  const unreached = ["stopped_by_rule", "settled_by_code", "settled_by_agent", "waiting_on_agent"];
  return {
    extraction: { claims: own.claims },
    dreaming: {
      passes: own.passes,
      relations: own.relations,
      tookEffect: own.effective,
      findings: own.findings,
      identityCandidates: own.identity_candidates,
    },
    work_tick: { raised: gaps.sample, ...byTrigger },
    // As the window closed: roles whose work waits with none of their agents asking, and every task
    // in go and unheld for over a day. Neither is output, so neither makes the loop producing.
    agents: {
      claimed: claimed.sample,
      done: value.done,
      doneAndUsed: value.used,
      // Work agents approved with their own bets in the 28 days to the window's end.
      approvedByBet: part(bets, "approved"),
      unattendedRoles: unattended.metric.value ?? 0,
      waitingOver24h: unattended.waiting,
    },
    questions: {
      raised: unreached.reduce((sum, key) => sum + part(asked, key), asked?.sample ?? 0),
      reachedOwner: asked?.sample ?? 0,
      triedByCode: part(tried, "code"),
      triedByAgent: part(tried, "attempted"),
      samePersonBatches: part(tried, "agents"),
      stoppedByRule: part(asked, "stopped_by_rule"),
      // What stays the owner's call, handed over with a link once a day: tasks raised, and those
      // whose agent reported it told the owner.
      handedOver: own.handed_over,
      handedOverTold: own.handed_over_told,
    },
    planner: {
      lessonsProposed: own.lessons_proposed,
      lessonsConfirmed: own.lessons_confirmed,
    },
    outcome_loop: { expectedStated: own.outcomes_stated, linksApplied: own.links_applied },
    measures: { filed: own.improvements_filed, closed: closed.sample },
  };
}

// What each loop is for: the counts that are its output. Dreaming's `tookEffect` is the relations a
// read applies now whose check held in the window, whenever they were judged. A loop that ran and wrote rows but put out
// none of these is not producing: a dream pass that ended ok with nothing in effect is `idle` or `empty`.
const OUTPUT: Record<LoopName, readonly string[]> = {
  extraction: ["claims"],
  dreaming: ["tookEffect", "findings"],
  work_tick: ["raised"],
  agents: ["doneAndUsed"],
  questions: ["triedByCode", "triedByAgent", "stoppedByRule"],
  planner: ["lessonsConfirmed"],
  outcome_loop: ["linksApplied"],
  measures: ["closed"],
};
const any = (loop: LoopName, counts: Counts): boolean => OUTPUT[loop].some((key) => (counts[key] ?? 0) > 0);

export async function loops(admin: AdminContext, days: number): Promise<LoopsView> {
  if (!Number.isInteger(days) || days < LOOPS_DAYS.min || days > LOOPS_DAYS.max)
    throw new AdminError("invalid_argument");
  const now = admin.now();
  const within = unrestrictedOf(admin.keys);
  const { produced, before } = await admin.transaction(async (query) => ({
    produced: await windowCounts(query, days, now, within),
    before: await windowCounts(query, days, new Date(now.getTime() - days * DAY_MS), within),
  }));
  return {
    days,
    at: stamp(now),
    loops: LOOP_NAMES.map(
      (loop): LoopRow => ({
        loop,
        produced: produced[loop],
        before: before[loop],
        state: any(loop, produced[loop]) ? "producing" : any(loop, before[loop]) ? "idle" : "empty",
      }),
    ),
  };
}
