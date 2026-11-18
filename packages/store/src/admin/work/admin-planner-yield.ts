import { weekDayOf } from "../../cards/asked-less.ts";
import { byText, type Query } from "../../core/db.ts";

// `pi work report`'s planner yield: of what each planner run proposed, what the owner answered, what
// they accepted and what was then used, and per UTC week and prompt the cost of each accepted and
// each used item, so a run cap can be judged from what the runs gave them. Counts and ids only. Every
// row a `used` turns on is read within the key file's unrestricted compartments, as the measure of
// finished work reads (`ledger.task_value`), so a row the owner's terminal cannot see marks nothing
// used (invariant 6).

// The owner's answers that let the work go ahead: an opportunity's go, a question's or a lesson's
// confirm, an idea's pursue.
export const APPROVING: ReadonlySet<string> = new Set(["go", "confirm", "pursue"]);

export type ProposalYield = { proposed: number; answered: number; accepted: number; used: number };

export type PlannerWeek = ProposalYield & {
  // The week's Monday, UTC, as YYYY-MM-DD; the window's first and last weeks may be partial.
  week: string;
  prompt: string;
  runs: number;
  // The runs that proposed anything.
  proposing: number;
  costMicroUsd: number;
  // Null while nothing was accepted, or used.
  costPerAcceptedMicroUsd: number | null;
  costPerUsedMicroUsd: number | null;
};

type Proposal = { rowKind: "opportunity" | "hypothesis"; id: string; kind: string };

// Accepted work whose agents' part ended, `done` or, for a kind whose last stages are the owner's
// (a follow-up, a reply, an introduction), `handed_to_owner`: used by the signals of finished work as
// `ledger.task_value` reads them for a task, here for a planner's opportunity, which is no task: the
// owner's Keep, or with no judgment of theirs, a record of its last move cited by another client, the
// owner acting on what it was about, or confirming a fact its records made, each within seven days
// of that end. Every row read is within $2 and not restricted, the work's own label included. Keep
// it in step with `ledger.task_value`'s `facts`.
const OPPORTUNITIES_USED = `
  with finished as (
    select o.id, o.about_kind, o.about_id, e.at as done_at, m.created_by as mover, m.created_at as moved_at
    from ledger.opportunities o
    cross join lateral (select r.event, r.at from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id
                        order by r.id desc limit 1) e
    join lateral (select v.id, v.created_by, v.created_at from ledger.moves v
                  where v.opportunity_id = o.id and v.tainted_at is null order by v.created_at desc, v.id desc limit 1) m on true
    where o.id = any($1::text[]) and e.event in ('done', 'handed_to_owner') and o.tainted_at is null
      and o.compartments <@ $2::text[] and not policy.is_restricted(o.compartments)
  ), signals as (
    select f.*,
      array(select w.id from ledger.agent_writes w
            where 'client:' || w.client_id = f.mover and w.refused_code is null and w.tainted_at is null
              and w.created_at >= f.moved_at and w.created_at <= f.done_at and w.compartments <@ $2::text[]) as records,
      array(select w.evidence_id from ledger.agent_writes w
            where 'client:' || w.client_id = f.mover and w.refused_code is null and w.tainted_at is null and w.evidence_id is not null
              and w.created_at >= f.moved_at and w.created_at <= f.done_at and w.compartments <@ $2::text[]) as evidence
    from finished f
  ), facts as (
    select s.id,
      exists (select 1 from ledger.basis b
              where b.ref_kind = 'agent_record' and b.ref_id = any (s.records) and b.tainted_at is null and b.compartments <@ $2::text[]
                and not exists (select 1 from ledger.hypotheses h where b.row_kind = 'hypothesis' and h.id = b.row_id and h.created_by = s.mover)
                and not exists (select 1 from ledger.opportunities x where b.row_kind = 'opportunity' and x.id = b.row_id and x.created_by = s.mover)
                and not exists (select 1 from ledger.moves v where b.row_kind = 'move' and v.id = b.row_id and v.created_by = s.mover))
      or exists (select 1 from ledger.read_log l
                 where 'client:' || l.client_id <> s.mover and l.read_at > s.done_at and l.read_at <= s.done_at + interval '7 days'
                   and l.compartments <@ $2::text[]
                   and ((l.tool in ('read_record', 'find_records') and l.shown && s.records) or l.bound && s.evidence)
                   and not exists (select 1 from policy.clients k where k.id = l.client_id and 'start_outcome_test' = any (k.tools))) as cited,
      (case s.about_kind
         when 'entity' then
           exists (select 1 from knowledge.interaction_log i
                   where i.entity_id = s.about_id and i.direction = 'outbound' and i.compartments <@ $2::text[]
                     and i.occurred_at > s.done_at and i.occurred_at <= s.done_at + interval '7 days')
           or exists (select 1 from knowledge.chat_lines c
                      where c.entity_id = s.about_id and c.direction = 'outbound' and c.compartments <@ $2::text[]
                        and c.occurred_at > s.done_at and c.occurred_at <= s.done_at + interval '7 days')
         when 'message' then
           exists (select 1 from knowledge.messages a join knowledge.messages m on m.thread_fp = a.thread_fp
                   where a.id = s.about_id and m.direction = 'outbound' and m.compartments <@ $2::text[]
                     and m.sent_at > s.done_at and m.sent_at <= s.done_at + interval '7 days')
         else false end
       or exists (select 1 from knowledge.owner_decisions d
                  where d.target_id = s.about_id and d.kind <> 'result_eval' and d.tainted_at is null and d.compartments <@ $2::text[]
                    and d.decided_at > s.done_at and d.decided_at <= s.done_at + interval '7 days')
       or exists (select 1 from ledger.signal_marks g
                  where g.state = 'handled' and g.tainted_at is null and g.compartments <@ $2::text[] and g.created_by <> s.mover
                    and (g.ref_id = s.id or g.ref_id = s.about_id)
                    and g.created_at >= s.done_at and g.created_at <= s.done_at + interval '7 days')) as acted,
      exists (select 1 from knowledge.claims k join ledger.cards c on c.target_id = k.id
              join knowledge.owner_decisions d on d.card_id = c.id
              where k.evidence_id = any (s.evidence) and d.kind = 'answer' and d.answer = 'confirm'
                and d.tainted_at is null and d.compartments <@ $2::text[]) as confirmed,
      (select j.answer from (select d.answer from knowledge.owner_decisions d join ledger.moves v on v.id = d.target_id
                             where d.kind = 'result_eval' and d.target_kind = 'move' and v.opportunity_id = s.id and d.tainted_at is null
                               and d.compartments <@ $2::text[]
                             order by d.decided_at desc, d.id collate "C" desc limit 1) j
       where j.answer in ('keep', 'not_useful')) as judged
    from signals s
  )
  select f.id from facts f
  where f.judged is not distinct from 'keep' or (f.judged is null and (f.cited or f.acted or f.confirmed))`;

// A pursued idea is used once the owner accepted an opportunity that rests on it, by their latest
// answer the report can see on it.
const IDEAS_USED = `
  select distinct x.hypothesis_id as id from ledger.opportunities x
  join ledger.hypotheses h on h.id = x.hypothesis_id and h.compartments <@ $2::text[] and not policy.is_restricted(h.compartments)
  cross join lateral (select d.answer from knowledge.owner_decisions d
                      where d.kind = 'answer' and d.target_id = x.id and d.tainted_at is null and d.compartments <@ $2::text[]
                      order by d.decided_at desc, d.id desc limit 1) d
  where x.hypothesis_id = any($1::text[]) and x.tainted_at is null and d.answer = any($3::text[])
    and x.compartments <@ $2::text[] and not policy.is_restricted(x.compartments)`;

// A confirmed lesson is used once a move's report named it.
const LESSONS_USED = `
  select distinct m.lesson_id as id from ledger.move_lessons m
  join ledger.moves v on v.id = m.move_id and v.tainted_at is null
  join ledger.hypotheses h on h.id = m.lesson_id and h.compartments <@ $2::text[] and not policy.is_restricted(h.compartments)
  where m.lesson_id = any($1::text[]) and m.compartments <@ $2::text[] and not policy.is_restricted(m.compartments)`;

// Of the accepted proposals, the ids used. A question the owner confirmed has no later sign of use:
// their confirm is all it asked, so it counts as accepted and never as used.
export async function usedProposals(
  query: Query,
  accepted: readonly Proposal[],
  within: readonly string[],
): Promise<Set<string>> {
  const ids = (keep: (one: Proposal) => boolean): string[] => accepted.filter(keep).map((one) => one.id);
  const opportunities = ids((one) => one.rowKind === "opportunity");
  const ideas = ids((one) => one.rowKind === "hypothesis" && one.kind === "idea");
  const lessons = ids((one) => one.rowKind === "hypothesis" && one.kind === "lesson");
  const used = new Set<string>();
  const read = async (text: string, from: string[], extra: unknown[] = []): Promise<void> => {
    if (from.length === 0) return;
    for (const row of await query<{ id: string }>(text, [from, [...within], ...extra])) used.add(row.id);
  };
  await read(OPPORTUNITIES_USED, opportunities);
  await read(IDEAS_USED, ideas, [[...APPROVING]]);
  await read(LESSONS_USED, lessons);
  return used;
}

// The week's Monday, UTC.
const per = (cost: number, n: number): number | null => (n === 0 ? null : Math.round(cost / n));

// The window's runs summed by UTC week and prompt id, in that order.
export function plannerWeeks(
  runs: readonly { at: Date; prompt: string; costMicroUsd: number; yield: ProposalYield }[],
): PlannerWeek[] {
  const weeks = new Map<string, Omit<PlannerWeek, "costPerAcceptedMicroUsd" | "costPerUsedMicroUsd">>();
  for (const run of runs) {
    const week = weekDayOf(run.at);
    const key = `${week}\u0000${run.prompt}`;
    const one = weeks.get(key) ?? {
      week,
      prompt: run.prompt,
      runs: 0,
      proposing: 0,
      costMicroUsd: 0,
      proposed: 0,
      answered: 0,
      accepted: 0,
      used: 0,
    };
    one.runs += 1;
    if (run.yield.proposed > 0) one.proposing += 1;
    one.costMicroUsd += run.costMicroUsd;
    one.proposed += run.yield.proposed;
    one.answered += run.yield.answered;
    one.accepted += run.yield.accepted;
    one.used += run.yield.used;
    weeks.set(key, one);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([, one]) => ({
      ...one,
      costPerAcceptedMicroUsd: per(one.costMicroUsd, one.accepted),
      costPerUsedMicroUsd: per(one.costMicroUsd, one.used),
    }));
}
