import { DAY_MS } from "@intelligence/personal-core";
import { RELAYED_CODE } from "../../cards/card-kind-row.ts";
import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, type OutcomeWindow, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { quoted } from "../../core/statements.ts";

// `pi outcomes`' measures of the goal itself: the owner's agents run and improve the system without
// the owner's attention. Two numbers here, beside the questions a week of
// admin-outcomes-questions.ts: the acts the owner took a week, and of the defects closed, the share
// closed with no act of the owner's. Ids, counts and codes, over `within` alone (invariant 6).
//
// Both are floors. An act counts only where the system keeps a row of it: what the owner does in a
// shell that records nothing (a deploy, a migration, a hold, a setting written in place) and what
// the owner only reads are not seen, and the spec lists them.

// Rulings code or an agent wrote into the owner's table: no act of the owner's. `identity_policy`
// is a merge or a ruling by code, an agent or a rule; `ruling_carry` is one row for each claim a
// reattach run carried, and the run itself keeps no row.
const CODE_KINDS = ["identity_policy", "ruling_carry"] as const;
// The kinds that are a part of their own; every other kind is a command.
const PART_OF_KIND: Readonly<Record<string, string>> = {
  answer: "card_answers",
  owner_answer: "owner_answers",
  send: "sends",
  send_settle: "sends",
};
const week = (column: string): string =>
  `to_char(date_trunc('week', ${column} at time zone 'UTC'), 'YYYY-MM-DD') as week`;

// Each act once. A card's answer is its `answer` ruling, one for each card; the rulings its effect
// wrote, which hold its card or its instant, are that answer and no second act. A command is a
// ruling with no card. A defect's dismissal, the stop and a relation switch keep rows of their own
// and write no ruling; so do a run the owner asked for, a lesson the owner added, retired or
// restored (its `confirmed` or `retired` event, but one a card's answer wrote at the answer's
// instant), and the mission, whose one row keeps its latest set alone. The answer a relay made is
// the relay's one act (RELAYED below) and no second.
const ACTS = `
  select 'ruling' as source, d.kind, ${week("d.decided_at")}, count(*)::int as n
  from knowledge.owner_decisions d
  where d.decided_at >= $1 and d.decided_at <= $2 and d.compartments <@ $3::text[]
    and d.kind not in (${quoted(CODE_KINDS)})
    and not exists (select 1 from ledger.card_relays y where y.ruling_id = d.id)
    and (d.kind in (${quoted(Object.keys(PART_OF_KIND))})
         or (d.card_id is null
             and not exists (select 1 from knowledge.owner_decisions a where a.kind = 'answer' and a.decided_at = d.decided_at and a.compartments <@ $3::text[])))
  group by 2, 3
  union all
  select 'defect_closes', null::text, ${week("e.created_at")}, count(*)::int
  from ledger.improvement_events e
  where e.created_by = 'owner' and e.created_at >= $1 and e.created_at <= $2 and e.compartments <@ $3::text[]
  group by 3
  union all
  select 'stops', null::text, ${week("k.created_at")}, count(*)::int
  from ledger.kill_switch k
  where k.created_by = 'owner' and k.created_at >= $1 and k.created_at <= $2 and k.compartments <@ $3::text[]
  group by 3
  union all
  select 'switch_changes', null::text, ${week("s.decided_at")}, count(*)::int
  from policy.relation_switches s
  where s.decided_by = 'owner' and s.decided_at >= $1 and s.decided_at <= $2
  group by 3
  union all
  select 'runs_asked', null::text, ${week("r.at")}, count(*)::int
  from ledger.record_events r
  where r.row_kind = 'run' and r.event = 'queued' and r.by = 'owner' and r.tainted_at is null
    and r.at >= $1 and r.at <= $2 and r.compartments <@ $3::text[]
  group by 3
  union all
  select 'lesson_changes', null::text, ${week("r.at")}, count(*)::int
  from ledger.record_events r
  where r.row_kind = 'hypothesis' and r.event in ('confirmed', 'retired') and r.by = 'owner' and r.tainted_at is null
    and r.code is distinct from '${RELAYED_CODE}'
    and r.at >= $1 and r.at <= $2 and r.compartments <@ $3::text[]
    and not exists (select 1 from knowledge.owner_decisions a where a.kind = 'answer' and a.decided_at = r.at and a.compartments <@ $3::text[])
  group by 3
  union all
  select 'mission_set', null::text, ${week("m.set_at")}, count(*)::int
  from projections.planner_mission m
  where m.set_at >= $1 and m.set_at <= $2 and m.compartments <@ $3::text[]
  group by 3`;

// Who changed a lever and when (policy.setting_changes: `changed_by`, `at`). No label: a setting is
// the same for every reader.
const LEVER_CHANGES = `
  select 'lever_changes' as source, null::text as kind, ${week("c.at")}, count(*)::int as n
  from policy.setting_changes c
  where c.changed_by = 'owner' and c.at >= $1 and c.at <= $2
  group by 3`;

// The owner's area commands, by what each leaves: the owner's `area` event on a project, one for
// each `project area`; and the times the areas' own rows were made or last changed, one for each
// command, since a command stamps every row it writes with one time. A floor: an area's row keeps
// its latest change alone, and a role's default area keeps no time at all.
const AREA_CHANGES = `
  select 'area_changes' as source, null::text as kind, ${week("x.at")}, count(*)::int as n
  from (
    select r.at from ledger.record_events r
    where r.row_kind = 'project' and r.event = 'updated' and r.code = 'area' and r.by = 'owner'
      and r.tainted_at is null and r.compartments <@ $3::text[]
    union all
    select t.at from (
      select a.created_at as at from knowledge.areas a where a.compartments <@ $3::text[]
      union
      select a.updated_at from knowledge.areas a where a.compartments <@ $3::text[]) t
  ) x
  where x.at >= $1 and x.at <= $2
  group by 3`;

// The owner's own answer on the card, and the owner's reopen of a relayed one, are acts of their
// own and count as every answer and command does.
const RELAYED = `
  select 'relayed' as source, null::text as kind, ${week("y.created_at")}, count(*)::int as n
  from ledger.card_relays y
  where y.created_at >= $1 and y.created_at <= $2 and y.compartments <@ $3::text[]
  group by 3`;

type ActRow = { source: string; kind: string | null; week: string; n: number };

const windowOf = (since: string, until: string): { window: OutcomeWindow; weeks: number } => {
  const days = (Date.parse(until) - Date.parse(since)) / DAY_MS;
  return { window: { fromDaysAgo: Math.round(days), toDaysAgo: 0 }, weeks: days / 7 };
};

// Whether the store is as old as the window: its first migration was applied at or before the
// window began. A week with no act is the goal reached only where the system was there to see it.
const WINDOW_FULL = "select coalesce(min(m.applied_at) <= $1::timestamptz, false) as full from policy.migrations m";
export async function windowIsFull(query: Query, since: string): Promise<boolean> {
  return (await query<{ full: boolean }>(WINDOW_FULL, [since]))[0]?.full === true;
}

// The acts a week, with `parts` by what the act was, each command's kind as `command_<kind>` and
// each week's acts as `week_<its Monday>`. With none seen over a window the store was there for
// the whole of (`full`), the value is 0 and healthy: the owner did not have to act. With none seen
// by a store younger than the window there is nothing to judge: `window_not_full`.
export function ownerActionsMetric(
  rows: readonly ActRow[],
  since: string,
  until: string,
  full: boolean,
): OutcomeMetric {
  const { window, weeks } = windowOf(since, until);
  const parts: Record<string, number> = {};
  const add = (key: string, n: number): void => {
    parts[key] = (parts[key] ?? 0) + n;
  };
  let acts = 0;
  for (const row of rows) {
    acts += row.n;
    add(`week_${row.week}`, row.n);
    if (row.source !== "ruling" || row.kind === null) {
      add(row.source, row.n);
      continue;
    }
    const part = PART_OF_KIND[row.kind];
    add(part ?? "commands", row.n);
    if (part === undefined) add(`command_${row.kind}`, row.n);
  }
  return outcomeMetric("owner_actions_per_week", {
    value: weeks > 0 && (acts > 0 || full) ? acts / weeks : null,
    sample: acts,
    window,
    ...(acts === 0 && !full ? { code: "window_not_full" } : {}),
    parts,
  });
}

export async function ownerActions(
  query: Query,
  since: string,
  until: string,
  within: string[],
): Promise<OutcomeMetric> {
  return ownerActionsMetric(
    [
      ...(await query<ActRow>(ACTS, [since, until, within])),
      ...(await query<ActRow>(LEVER_CHANGES, [since, until])),
      ...(await query<ActRow>(AREA_CHANGES, [since, until, within])),
      ...(await query<ActRow>(RELAYED, [since, until, within])),
    ],
    since,
    until,
    await windowIsFull(query, since),
  );
}

// The defects that stand closed, by the close that stands: the latest status of each, within the
// caller's label, set in the window. One counts as closed with no act of the owner's unless, between
// its opening (its filing, or the system's latest reopening) and its close, the owner ran a command
// on it: the owner's dismissal, the owner's change of its role, or the owner's change of a lever
// judged by the measure it was filed for (or of the lever it names). `parts` say what each was
// taken with, by the latest reference an agent set before the close: `pr` and `commit` are an
// agent's own claim and are checked by nothing, `lever` is a change the lever's history holds,
// `ops` an operation the system recorded, `none` a look with no fix claimed. `recovered_untaken`:
// the system closed it and no agent ever named anything. `agent_closed`: an agent closed one with
// no reference. So a reference is visible as what it is, and none is counted as proof of a fix.
const CLOSES = `
  select
    count(*)::int as closed,
    count(*) filter (where x.owner_command)::int as owner_command,
    count(*) filter (where x.fix = 'pr')::int as pr,
    count(*) filter (where x.fix = 'commit')::int as commit,
    count(*) filter (where x.fix = 'lever')::int as lever,
    count(*) filter (where x.fix = 'ops')::int as ops,
    count(*) filter (where x.fix = 'none')::int as none,
    count(*) filter (where x.fix is null and x.closed_by = 'system:measure')::int as recovered_untaken,
    count(*) filter (where x.fix is null and x.closed_by like 'client:%')::int as agent_closed,
    count(*) filter (where x.closed_by = 'system:measure' and x.cause_state = 'closed=no_data')::int as closed_no_data
  from (
    select c.created_by as closed_by, i.cause_state,
      (select split_part(f.fix_ref, ':', 1) from ledger.improvement_events f
       where f.improvement_id = i.id and f.event = 'status' and f.fix_ref is not null and f.created_by like 'client:%'
         and f.tainted_at is null and f.compartments <@ $3::text[] and f.created_at <= c.created_at
       order by f.created_at desc, f.id collate "C" desc limit 1) as fix,
      c.created_by = 'owner'
        or (i.owner_role_at is not null and i.owner_role_at >= o.opened_at and i.owner_role_at <= c.created_at)
        or exists (select 1 from policy.setting_changes sc
                   where sc.changed_by = 'owner' and sc.at >= o.opened_at and sc.at <= c.created_at
                     and (i.cause = 'measure_floor:' || sc.measure or i.cause = 'lever_change:' || sc.key)) as owner_command
    from ledger.improvements i
    cross join lateral (
      select e.status, e.created_by, e.created_at from ledger.improvement_events e
      where e.improvement_id = i.id and e.event = 'status' and e.tainted_at is null and e.compartments <@ $3::text[]
      order by e.created_at desc, e.id collate "C" desc limit 1) c
    cross join lateral (
      select coalesce((select max(e.created_at) from ledger.improvement_events e
                       where e.improvement_id = i.id and e.event = 'status' and e.status = 'open'
                         and e.created_by = 'system:measure' and e.created_at < c.created_at), i.created_at) as opened_at) o
    where i.tainted_at is null and i.compartments <@ $3::text[]
      and c.status in ('done', 'wont_do', 'duplicate') and c.created_at >= $1 and c.created_at <= $2) x`;
const DEFECT_ROLE = "select defect_role is not null as assigned from policy.work_settings";

export type CloseCounts = {
  closed: number;
  owner_command: number;
  pr: number;
  commit: number;
  lever: number;
  ops: number;
  none: number;
  recovered_untaken: number;
  agent_closed: number;
  closed_no_data: number;
};
const NO_CLOSES: CloseCounts = {
  closed: 0,
  owner_command: 0,
  pr: 0,
  commit: 0,
  lever: 0,
  ops: 0,
  none: 0,
  recovered_untaken: 0,
  agent_closed: 0,
  closed_no_data: 0,
};

// `assigned`: whether the owner has set the role defects go to. While none is set no agent is
// assigned a defect, so the share says nothing of the agents: no data, `no_defect_role`.
export function defectsClosedMetric(counts: CloseCounts, since: string, until: string, assigned = true): OutcomeMetric {
  const { closed, ...parts } = counts;
  return outcomeMetric("defects_closed_without_owner", {
    value: assigned ? shareOf(closed - counts.owner_command, closed) : null,
    sample: closed,
    window: windowOf(since, until).window,
    ...(assigned ? {} : { code: "no_defect_role" }),
    parts,
  });
}

export async function defectsClosed(
  query: Query,
  since: string,
  until: string,
  within: string[],
): Promise<OutcomeMetric> {
  const [row] = await query<CloseCounts>(CLOSES, [since, until, within]);
  const [role] = await query<{ assigned: boolean }>(DEFECT_ROLE);
  return defectsClosedMetric(row ?? NO_CLOSES, since, until, role?.assigned === true);
}

// The goal in one read: the owner's acts a week, the questions that reached the owner a week, and
// the share of defects closed with no act of the owner's, each with its state. `ownerQuestions` is
// null when the questions read holds no such metric.
export type GoalLine = {
  ownerActions: OutcomeMetric;
  ownerQuestions: OutcomeMetric | null;
  defectsWithoutOwner: OutcomeMetric;
};

export async function goalMeasures(
  query: Query,
  since: string,
  until: string,
  within: string[],
): Promise<{ ownerActions: OutcomeMetric; defectsWithoutOwner: OutcomeMetric }> {
  return {
    ownerActions: await ownerActions(query, since, until, within),
    defectsWithoutOwner: await defectsClosed(query, since, until, within),
  };
}

export const goalLine = (
  measures: { ownerActions: OutcomeMetric; defectsWithoutOwner: OutcomeMetric },
  questions: readonly OutcomeMetric[],
): GoalLine => ({
  ownerActions: measures.ownerActions,
  ownerQuestions: questions.find((one) => one.metric === "owner_questions_per_week") ?? null,
  defectsWithoutOwner: measures.defectsWithoutOwner,
});
