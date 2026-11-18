import type { Query } from "../../core/db.ts";
import { latestEvent } from "../../core/statements.ts";

// `pi outcomes`' `runs`: whether reasoning runs happen, by UTC day. A next_run whose brief is
// cancelled at its deadline rolls back its call row, so the tool usage never counts it; what shows
// it is the reasoner's own failed exits and runs taken that end `failed` with `timeout`. Counts,
// codes and ids of days only.

type RunDay = {
  day: string;
  queued: number;
  taken: number;
  finished: number;
  failed: number;
  stopped: number;
  // How failed runs ended, by code.
  failedBy: Record<string, number>;
  // The reasoner process exiting non-zero: a brief cancelled, the agent API down or a failed run.
  reasonerFailed: number;
  // Wakes skipped because the day's budget or run count was reached.
  budgetSkips: number;
  spentMicroUsd: number;
};

// What each kind of wake cost over the window, and how much of it went to runs that failed.
type RunSource = {
  source: string;
  runs: number;
  finished: number;
  failed: number;
  spentMicroUsd: number;
  spentOnFailedMicroUsd: number;
};

export type RunsReliability = {
  queue: { queued: number; oldestQueuedAt: string | null; lastTakenAt: string | null };
  days: RunDay[];
  sources: RunSource[];
  ownerQuestions: { raised: number; ownerGo: number; policyGo: number; claimed: number; answered: number };
  handOffs: number;
  // Agent sessions that read in the window, and those holding a read of evidence removed since: a
  // session's write is refused once for that, and the session renewed.
  sessions: { read: number; readRemoved: number };
};

type Window = { since: string; until: string; within: readonly string[] };

const STATUS = (row: string): string => `(${latestEvent("run", `${row}.id`, "e")})`;

const QUEUE = `
  select count(*)::int as queued, to_char(min(r.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as oldest,
    (select to_char(max(a.taken_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from ledger.run_attempts a join ledger.runs t on t.id = a.run_id where t.compartments <@ $1::text[]) as last
  from ledger.runs r
  where r.tainted_at is null and r.compartments <@ $1::text[] and ${STATUS("r")} = 'queued'`;

// Each statement is one count of the day it happened on. A run's end is its status event's day.
const DAY = (at: string): string => `to_char(${at} at time zone 'UTC', 'YYYY-MM-DD')`;
const QUEUED = `
  select ${DAY("r.created_at")} as day, count(*)::int as n from ledger.runs r
  where r.created_at >= $1 and r.created_at <= $2 and r.compartments <@ $3::text[] group by 1`;
const TAKEN = `
  select ${DAY("a.taken_at")} as day, count(*)::int as n from ledger.run_attempts a join ledger.runs r on r.id = a.run_id
  where a.taken_at >= $1 and a.taken_at <= $2 and r.compartments <@ $3::text[] group by 1`;
const ENDED = `
  select ${DAY("e.at")} as day, e.event, coalesce(e.code, 'none') as code, count(*)::int as n
  from ledger.record_events e join ledger.runs r on r.id = e.row_id
  where e.row_kind = 'run' and e.event in ('finished', 'failed', 'stopped') and e.at >= $1 and e.at <= $2 and r.compartments <@ $3::text[]
  group by 1, 2, 3`;
const SPENT = `
  select ${DAY("s.created_at")} as day, coalesce(sum(s.cost_microusd), 0)::text as spent
  from ledger.run_steps s join ledger.runs r on r.id = s.run_id
  where s.kind = 'model_call' and s.created_at >= $1 and s.created_at <= $2 and r.compartments <@ $3::text[]
  group by 1`;
const EXITS = `
  select ${DAY("j.started_at")} as day, count(*)::int as n from ledger.job_runs j
  where j.job = 'reasoner' and j.code <> 'ok' and j.started_at >= $1 and j.started_at <= $2 group by 1`;
const BUDGET = `
  select ${DAY("x.created_at")} as day, count(*)::int as n from ledger.silences x
  where x.reason = 'budget' and x.created_at >= $1 and x.created_at <= $2 and x.compartments <@ $3::text[] group by 1`;

const SOURCES = `
  with windowed as (
    select r.id, r.wake_source, ${STATUS("r")} as status,
      coalesce((select sum(s.cost_microusd) from ledger.run_steps s where s.run_id = r.id and s.kind = 'model_call'), 0) as spent
    from ledger.runs r
    where r.created_at >= $1 and r.created_at <= $2 and r.compartments <@ $3::text[]
  )
  select wake_source as source, count(*)::int as runs,
    count(*) filter (where status = 'finished')::int as finished,
    count(*) filter (where status = 'failed')::int as failed,
    sum(spent)::text as spent,
    coalesce(sum(spent) filter (where status = 'failed'), 0)::text as failed_spent
  from windowed group by 1 order by 1`;

// The stages an owner_question passes: the go's author matters, since only the owner's lets an
// answer count. An `asked` question with rung 0's go, from before rung 0 left them alone, can never
// be answered.
const QUESTIONS = `
  select count(*)::int as raised,
    count(*) filter (where d.who = 'go/owner')::int as owner_go,
    count(*) filter (where d.who = 'go/policy')::int as policy_go,
    count(*) filter (where exists (select 1 from ledger.record_events e where e.row_kind = 'opportunity' and e.row_id = o.id and e.event = 'claimed'))::int as claimed,
    count(*) filter (where exists (select 1 from ledger.agent_writes w where w.opportunity_id = o.id and w.kind = 'answer'))::int as answered
  from ledger.opportunities o
  left join lateral (select x.decision || '/' || x.decided_by as who from ledger.opportunity_decisions x where x.opportunity_id = o.id order by x.id desc limit 1) d on true
  where o.kind = 'owner_question' and o.created_at >= $1 and o.created_at <= $2 and o.compartments <@ $3::text[]`;
const HAND_OFFS = `
  select count(*)::int as n from ledger.record_events e join ledger.opportunities o on o.id = e.row_id
  where e.row_kind = 'opportunity' and e.event = 'routed' and e.at >= $1 and e.at <= $2 and o.compartments <@ $3::text[]`;

const EMPTY = (day: string): RunDay => ({
  day,
  queued: 0,
  taken: 0,
  finished: 0,
  failed: 0,
  stopped: 0,
  failedBy: {},
  reasonerFailed: 0,
  budgetSkips: 0,
  spentMicroUsd: 0,
});

const SESSIONS = `
  select count(*)::int as read,
    count(*) filter (where exists (
      select 1 from ledger.read_log r cross join lateral unnest(r.bound) as b (one)
      where r.session_id = s.id and r.compartments <@ $3::text[] and b.one ~ '^[0-9a-f]{64}$'
        and not exists (select 1 from vault.evidence_items e where e.id = b.one)))::int as read_removed
  from ledger.sessions s
  where exists (select 1 from ledger.read_log r where r.session_id = s.id and r.read_at >= $1 and r.read_at <= $2 and r.compartments <@ $3::text[])`;

export async function runsReliability(query: Query, window: Window): Promise<RunsReliability> {
  const values = [window.since, window.until, window.within];
  const days = new Map<string, RunDay>();
  const on = (day: string): RunDay => {
    const found = days.get(day);
    if (found !== undefined) return found;
    const made = EMPTY(day);
    days.set(day, made);
    return made;
  };
  const counted = async (statement: string, field: "queued" | "taken" | "budgetSkips", bound: unknown[]) => {
    for (const row of await query<{ day: string; n: number }>(statement, bound)) on(row.day)[field] = row.n;
  };
  await counted(QUEUED, "queued", values);
  await counted(TAKEN, "taken", values);
  await counted(BUDGET, "budgetSkips", values);
  for (const row of await query<{ day: string; n: number }>(EXITS, [window.since, window.until]))
    on(row.day).reasonerFailed = row.n;
  for (const row of await query<{ day: string; event: string; code: string; n: number }>(ENDED, values)) {
    const day = on(row.day);
    if (row.event === "finished") day.finished += row.n;
    if (row.event === "stopped") day.stopped += row.n;
    if (row.event === "failed") {
      day.failed += row.n;
      day.failedBy[row.code] = (day.failedBy[row.code] ?? 0) + row.n;
    }
  }
  for (const row of await query<{ day: string; spent: string }>(SPENT, values))
    on(row.day).spentMicroUsd = Number(row.spent);
  const [queue] = await query<{ queued: number; oldest: string | null; last: string | null }>(QUEUE, [window.within]);
  const sources = await query<{
    source: string;
    runs: number;
    finished: number;
    failed: number;
    spent: string;
    failed_spent: string;
  }>(SOURCES, values);
  const [questions] = await query<{
    raised: number;
    owner_go: number;
    policy_go: number;
    claimed: number;
    answered: number;
  }>(QUESTIONS, values);
  const [handOffs] = await query<{ n: number }>(HAND_OFFS, values);
  const [sessions] = await query<{ read: number; read_removed: number }>(SESSIONS, values);
  return {
    queue: {
      queued: queue?.queued ?? 0,
      oldestQueuedAt: queue?.oldest ?? null,
      lastTakenAt: queue?.last ?? null,
    },
    days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    sources: sources.map((row) => ({
      source: row.source,
      runs: row.runs,
      finished: row.finished,
      failed: row.failed,
      spentMicroUsd: Number(row.spent),
      spentOnFailedMicroUsd: Number(row.failed_spent),
    })),
    ownerQuestions: {
      raised: questions?.raised ?? 0,
      ownerGo: questions?.owner_go ?? 0,
      policyGo: questions?.policy_go ?? 0,
      claimed: questions?.claimed ?? 0,
      answered: questions?.answered ?? 0,
    },
    handOffs: handOffs?.n ?? 0,
    sessions: { read: sessions?.read ?? 0, readRemoved: sessions?.read_removed ?? 0 },
  };
}
