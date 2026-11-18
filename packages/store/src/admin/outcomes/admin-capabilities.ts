import { CAPABILITY_LEDGER_DAYS, CapabilityLedger } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { Query } from "../../core/db.ts";

// `pia ledger`: the capability ledger. One row for each job ledger.job_runs' check accepts, read from
// the check itself so a job added there shows here with nothing else to change: its run count over
// the last 14 days, and its latest run's start and code. A job that never ran shows a count of zero.
// A retired job, which the check still accepts so its old rows stay valid, is left out: nothing
// runs it any more, so its row would read as a capability gone dormant: the box's task executor,
// whose code, user and timer step were removed.
// Ids, counts, times and codes only; ledger.job_runs holds no compartment, so every row is the
// owner's to count.

const RETIRED_JOBS = ["executor"];

const LEDGER = `
  with jobs as (
    select distinct m[1] as job
    from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
    where c.conrelid = 'ledger.job_runs'::regclass and c.conname = 'job_runs_job' and m[1] <> all ($3::text[])
  )
  select j.job as id,
    (select count(*)::int from ledger.job_runs r where r.job = j.job and r.started_at > $1 and r.started_at <= $2) as runs,
    l.started_at as last_run_at, l.code as last_status
  from jobs j
  left join lateral (
    select r.started_at, r.code from ledger.job_runs r
    where r.job = j.job and r.started_at <= $2 order by r.started_at desc, r.id desc limit 1
  ) l on true
  order by j.job collate "C"`;

export async function capabilityLedger(query: Query, now: Date): Promise<CapabilityLedger> {
  const since = new Date(now.getTime() - CAPABILITY_LEDGER_DAYS * DAY_MS);
  const rows = await query<{ id: string; runs: number; last_run_at: Date | null; last_status: string | null }>(LEDGER, [
    since,
    now,
    RETIRED_JOBS,
  ]);
  return CapabilityLedger.parse({
    at: now.toISOString(),
    days: CAPABILITY_LEDGER_DAYS,
    capabilities: rows.map((row) => ({
      id: row.id,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      runs: row.runs,
      lastStatus: row.last_status,
    })),
  });
}
