import { AGENT_RECORD_DAYS, type KnownCardKind } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { AGENT_SETTLED_CODES_SQL, attemptsOn, HELD_FOR_AGENT } from "../../cards/agent-attempts.ts";
import { SETTLED_CODES_SQL } from "../../cards/asked-less.ts";
import { HELD_FOR_RELAY } from "../../cards/questions-through-agent.ts";
import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric } from "../../core/outcome-thresholds.ts";
import { latestRow, quoted } from "../../core/statements.ts";
import { windowIsFull } from "./admin-outcomes-goal.ts";

// `pi outcomes`' measure of the owner's goal: the owner is asked less over time, and the questions that
// remain are ones nobody else could settle. Questions a week by kind, repeats, the share something tried
// first and, beside them, the share of what was settled without the owner that the owner overturned, so
// fewer questions cannot pass for worse answers. Counts over `within` alone (invariant 6). Planner cards
// count: a card with one option only tells the owner something, and is no question.

// The kinds whose every card something tried before the owner was asked: `agents`, a same-person
// batch, which is what two agents could not settle; `code`, an opportunity's decision, which rung 0
// could not make. A new kind that only reaches the owner past an agent or code joins one of them.
export const TRIED_FIRST_KINDS = {
  agents: ["same_person_batch"],
  code: ["opportunity_decision"],
} as const satisfies Record<string, readonly KnownCardKind[]>;

// A card asked the owner something: more than one option, not withdrawn by a rule, and not an
// outcome code settled without the owner, which reaches the owner only when the owner reopens it.
// Something tried first: a card of a kind above, or one an agent's task answered before the owner
// did. An agent's proposal is no attempt to answer for the owner, so a card an agent raised counts
// only by one of those. `attempts`: whether agents try a card first (the autonomy switch), read at
// each call.
const questionsSql = (attempts: boolean): string => `
  select c.kind, to_char(date_trunc('week', c.created_at at time zone 'UTC'), 'YYYY-MM-DD') as week,
    count(*)::int as n,
    count(*) filter (where s.asked and (t.agents or t.code or t.attempted))::int as tried,
    count(*) filter (where s.asked and t.attempted)::int as attempted,
    count(*) filter (where s.by_agent)::int as by_agent,
    count(*) filter (where s.waiting)::int as waiting,
    count(*) filter (where s.asked and t.relayed)::int as relayed,
    count(*) filter (where s.asked and t.agents)::int as agents,
    count(*) filter (where s.asked and t.code)::int as code,
    count(*) filter (where (c.case_key is not null or c.match_fp is not null) and exists (
      select 1 from ledger.cards p
      where p.id <> c.id and p.created_at < c.created_at and p.compartments <@ $3::text[] and p.tainted_at is null
        and (p.case_key = c.case_key or p.match_fp = c.match_fp)
        and exists (select 1 from ledger.record_events r where r.row_kind = 'card' and r.row_id = p.id and r.event = 'decided')))::int as repeats,
    count(*) filter (where s.stopped)::int as stopped,
    count(*) filter (where s.settled)::int as settled
  from ledger.cards c
  cross join lateral (select coalesce(l.code = 'rule_stopped', false) as stopped,
                        coalesce(l.code in (${SETTLED_CODES_SQL}), false) as settled,
                        coalesce(l.code in (${AGENT_SETTLED_CODES_SQL}), false) as by_agent,
                        l.waiting,
                        coalesce(l.code not in ('rule_stopped', ${SETTLED_CODES_SQL}, ${AGENT_SETTLED_CODES_SQL}), true) and not l.waiting as asked
                      from (select (${latestRow("r.code", "card", "c.id")}) as code,
                              coalesce((${latestRow("r.event", "card", "c.id")}) in ('pending', 'deferred'), false)
                                and (${attempts ? HELD_FOR_AGENT("$2") : "false"} or ${HELD_FOR_RELAY("$2")}) as waiting) l) s
  cross join lateral (
    select c.kind in (${quoted(TRIED_FIRST_KINDS.agents)}) as agents, c.kind in (${quoted(TRIED_FIRST_KINDS.code)}) as code,
      exists (select 1 from ledger.card_answers a
              where a.card_id = c.id and a.compartments <@ $3::text[]
                and a.created_at <= coalesce((select min(d.at) from ledger.record_events d
                                              where d.row_kind = 'card' and d.row_id = c.id and d.event = 'decided'), $2::timestamptz)) as attempted,
      exists (select 1 from ledger.card_relays y
              where y.card_id = c.id and y.compartments <@ $3::text[] and y.created_at <= $2::timestamptz) as relayed
  ) t
  where c.created_at >= $1 and c.created_at <= $2 and c.compartments <@ $3::text[] and c.tainted_at is null
    and cardinality(c.options) > 1
  group by 1, 2`;

// Settled without the owner: rulings by code's merges, agents' answers and rules; facts code settled by an
// earlier answer; cards a rule stopped; outcomes code settled from the report and the code judge. A rule
// the owner confirmed is the owner's own word, not one of these.
// Overturned: a ruling a person lifted, not one a deletion lifted, which is nobody's no; a settled fact
// reopened; a rule lifted in the window, and the stops it ended count as settled above; a settled
// outcome whose card the owner reopened.
const OVERTURNED = `
  select
    (select count(*)::int from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
      where d.kind = 'identity_policy' and r.created_at >= $1 and r.created_at <= $2 and d.compartments <@ $3::text[])
    + (select count(*)::int from ledger.fact_settlements s where s.created_at >= $1 and s.created_at <= $2 and s.compartments <@ $3::text[])
    + (select count(*)::int from ledger.record_events e where e.row_kind = 'card' and e.code in ('rule_stopped', ${SETTLED_CODES_SQL}, ${AGENT_SETTLED_CODES_SQL}) and e.at >= $1 and e.at <= $2 and e.compartments <@ $3::text[]) as settled,
    (select count(*)::int from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
      where d.kind = 'identity_policy' and r.lifted_at is not null and not r.lifted_by_deletion and r.created_at >= $1 and r.created_at <= $2 and d.compartments <@ $3::text[])
    + (select count(*)::int from ledger.fact_settlements s where s.reopened_at is not null and s.created_at >= $1 and s.created_at <= $2 and s.compartments <@ $3::text[])
    + (select count(*)::int from ledger.question_rules q where q.status = 'lifted' and q.lifted_at >= $1 and q.lifted_at <= $2 and q.compartments <@ $3::text[])
    + (select count(*)::int from ledger.record_events e
       where e.row_kind = 'card' and e.code in (${SETTLED_CODES_SQL}, ${AGENT_SETTLED_CODES_SQL}) and e.at >= $1 and e.at <= $2 and e.compartments <@ $3::text[]
         and exists (select 1 from ledger.record_events o
                     where o.row_kind = 'card' and o.row_id = e.row_id and o.id > e.id and o.event = 'pending' and o.by = 'owner')) as overturned`;

// An answer of the owner's is not settled without the owner, so neither is in the share above: each
// is a part beside it.
const RELAYED_OVERTURNED = `
  select count(*)::int as applied, count(*) filter (where y.reopened_at is not null)::int as overturned
  from ledger.card_relays y
  where y.applied_at >= $1 and y.applied_at <= $2 and y.compartments <@ $3::text[]`;

// A relay the owner's process has not applied an hour on, whenever it was taken: `pi web` applies
// one within the minute, so any here says it is down or stuck. A gauge, not a window.
const RELAYED_UNAPPLIED = `
  select count(*)::int as n from ledger.card_relays y
  where y.ruling_id is null and y.failed_code is null and y.compartments <@ $2::text[]
    and y.created_at < $1::timestamptz - interval '1 hour'`;

// Of the cards an agent's answer settled in the window, within the caller's
// label, those the owner marked right or wrong on the week's sample. Precision is right over marked.
const AGENT_PRECISION = `
  select count(*) filter (where a.owner_mark = 'right')::int as right, count(*) filter (where a.owner_mark = 'wrong')::int as wrong
  from ledger.card_answers a join ledger.cards c on c.id = a.card_id
  where a.owner_mark is not null and a.created_at >= $1 and a.created_at <= $2 and a.compartments <@ $3::text[] and c.tainted_at is null`;

// A question is work an agent proposed as an owner_question, handed to the owner, or carried a
// checked `tried` on. A decisionNeeded is sealed, so one put before `tried` was required, without
// it, is not seen. and each signal an agent marked needs_owner in the window, paid when it carries
// a checked `tried`.
const PAID = `
  select coalesce(sum(q.asked), 0)::int as asked, coalesce(sum(q.paid), 0)::int as paid from (
    select count(*) as asked,
      count(*) filter (where o.question_paid_at >= $1 and o.question_paid_at <= $2) as paid
    from ledger.opportunities o
    where o.compartments <@ $3::text[] and o.tainted_at is null
      and ((o.question_paid_at >= $1 and o.question_paid_at <= $2)
        or (o.kind = 'owner_question' and o.created_by like 'client:%' and o.created_at >= $1 and o.created_at <= $2)
        or exists (select 1 from ledger.record_events e
                   where e.row_kind = 'opportunity' and e.row_id = o.id and e.event = 'handed_to_owner' and e.by like 'client:%'
                     and e.at >= $1 and e.at <= $2 and e.compartments <@ $3::text[]))
    union all
    select count(*), count(*) filter (where m.question_paid_at is not null)
    from ledger.signal_marks m
    where m.state = 'needs_owner' and m.created_at >= $1 and m.created_at <= $2
      and m.compartments <@ $3::text[] and m.tainted_at is null) q`;

const BETS = `
  select coalesce(sum(b.used), 0)::int as used, coalesce(sum(b.unused), 0)::int as unused
  from ledger.bets_within($1::timestamptz, $2::text[], null) b`;

const APPROVED = `
  select count(*)::int as approved,
    count(*) filter (where exists (
      select 1 from ledger.opportunity_decisions n
      where n.opportunity_id = d.opportunity_id and n.id > d.id and n.decided_by = 'owner' and n.decision = 'no_go'
        and n.created_at <= $1::timestamptz and n.tainted_at is null and n.compartments <@ $2::text[]))::int as lifted
  from ledger.opportunity_decisions d
  where d.decided_by = 'agent' and d.decision = 'go' and d.tainted_at is null and d.compartments <@ $2::text[]
    and d.created_at > $1::timestamptz - make_interval(days => $3) and d.created_at <= $1::timestamptz`;

const MS_WEEK = 7 * DAY_MS;
type Tried = { tried: number; agents: number; code: number; attempted: number };
type Left = { stopped: number; settled: number; by_agent: number; waiting: number };
type Relayed = { relayed: number };

export async function ownerQuestions(
  query: Query,
  since: string,
  until: string,
  within: string[],
): Promise<OutcomeMetric[]> {
  const rows = await query<{ kind: string; week: string; n: number; repeats: number } & Left & Tried & Relayed>(
    questionsSql(attemptsOn()),
    [since, until, within],
  );
  const [over] = await query<{ settled: number; overturned: number }>(OVERTURNED, [since, until, within]);
  const [relayed] = await query<{ applied: number; overturned: number }>(RELAYED_OVERTURNED, [since, until, within]);
  const [unapplied] = await query<{ n: number }>(RELAYED_UNAPPLIED, [until, within]);
  const [paid] = await query<{ asked: number; paid: number }>(PAID, [since, until, within]);
  const [marked] = await query<{ right: number; wrong: number }>(AGENT_PRECISION, [since, until, within]);
  const markedAll = (marked?.right ?? 0) + (marked?.wrong ?? 0);
  const [bets] = await query<{ used: number; unused: number }>(BETS, [until, within]);
  const [approved] = await query<{ approved: number; lifted: number }>(APPROVED, [until, within, AGENT_RECORD_DAYS]);
  // Pairs no agent could prove, resting until one can: a gauge over what the caller may see, not a window.
  const [resting] = await query<{ n: number }>(
    "select count(*)::int as n from ledger.identity_questions where state = 'resting' and passed_code = 'nothing_to_read' and compartments <@ $1::text[]",
    [within],
  );
  const settledBets = (bets?.used ?? 0) + (bets?.unused ?? 0);
  const days = Math.round((Date.parse(until) - Date.parse(since)) / DAY_MS);
  const window = { fromDaysAgo: days, toDaysAgo: 0 };
  // What reached the owner's queue: not a rule's stop, not what code or an agent's answer settled,
  // and not a card still waiting on its agent.
  const reached = (row: { n: number } & Left): number => row.n - row.stopped - row.settled - row.by_agent - row.waiting;
  const asked = rows.reduce((sum, row) => sum + reached(row), 0);
  const sum = (field: keyof Tried | keyof Left | keyof Relayed | "repeats"): number =>
    rows.reduce((total, row) => total + row[field], 0);
  const byKind: Record<string, number> = {};
  const byWeek: Record<string, number> = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + reached(row);
    byWeek[`week_${row.week}`] = (byWeek[`week_${row.week}`] ?? 0) + reached(row);
  }
  const weeks = (Date.parse(until) - Date.parse(since)) / MS_WEEK;
  // No question over a window the store was there for the whole of is 0 and healthy; none on a
  // store younger than the window says nothing yet.
  const full = asked > 0 || (await windowIsFull(query, since));
  return [
    outcomeMetric("owner_questions_per_week", {
      value: weeks > 0 && full ? asked / weeks : null,
      sample: asked,
      window,
      ...(full ? {} : { code: "window_not_full" }),
      parts: {
        ...byKind,
        ...byWeek,
        repeats: sum("repeats"),
        stopped_by_rule: sum("stopped"),
        settled_by_code: sum("settled"),
        settled_by_agent: sum("by_agent"),
        waiting_on_agent: sum("waiting"),
        relayed: sum("relayed"),
        relayed_unapplied: unapplied?.n ?? 0,
        nothing_to_read: resting?.n ?? 0,
      },
    }),
    outcomeMetric("owner_questions_attempted", {
      value: asked > 0 ? sum("tried") / asked : null,
      sample: asked,
      window,
      parts: {
        agents: sum("agents"),
        code: sum("code"),
        attempted: sum("attempted"),
        untried: asked - sum("tried"),
      },
    }),
    outcomeMetric("questions_paid_share", {
      value: (paid?.asked ?? 0) > 0 ? (paid?.paid ?? 0) / (paid?.asked ?? 1) : null,
      sample: paid?.asked ?? 0,
      window,
      parts: { asked: paid?.asked ?? 0, paid: paid?.paid ?? 0 },
    }),
    outcomeMetric("bets_used_share", {
      value: settledBets > 0 ? (bets?.used ?? 0) / settledBets : null,
      sample: settledBets,
      window: { fromDaysAgo: AGENT_RECORD_DAYS, toDaysAgo: 0 },
      parts: {
        used: bets?.used ?? 0,
        unused: bets?.unused ?? 0,
        approved: approved?.approved ?? 0,
        approved_lifted: approved?.lifted ?? 0,
      },
    }),
    outcomeMetric("agent_settled_precision", {
      value: markedAll > 0 ? (marked?.right ?? 0) / markedAll : null,
      sample: markedAll,
      window,
      parts: { right: marked?.right ?? 0, wrong: marked?.wrong ?? 0 },
    }),
    outcomeMetric("settled_without_owner_overturned", {
      value: (over?.settled ?? 0) > 0 ? (over?.overturned ?? 0) / (over?.settled ?? 1) : null,
      sample: over?.settled ?? 0,
      window,
      parts: {
        settled: over?.settled ?? 0,
        overturned: over?.overturned ?? 0,
        relayed_applied: relayed?.applied ?? 0,
        relayed_overturned: relayed?.overturned ?? 0,
      },
    }),
  ];
}
