import {
  type BoxHealthKind,
  CANARY_CLEARANCE,
  JOB_NAMES,
  type JobName,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { leverDefault } from "@intelligence/personal-core/planner";
import { caseOf, closeHealth, HEALTH_AUTHOR, HEALTH_CARD, raiseHealth } from "./box-health.ts";
import type { Query } from "./db.ts";
import { lever } from "./settings.ts";
import { LATEST_CARD_EVENT, latestRow } from "./statements.ts";

// The box health detectors: four failures no run reports of itself, each read by code at the
// coverage record from rows the system already keeps, with no model, and the box's own connection
// to the database checking no certificate. Each is one statement, or the admin's connection
// setting, and one pure test. A card stands while its condition does: raised once (the queue's case
// rule), and withdrawn by `system:health` at the first record that finds the condition ended. Ids,
// counts and codes only: nothing here opens a sealed value. As pi_admin.

// An account stores nothing: every sync of the last QUIET_DAYS ended ok, there were at least
// QUIET_SYNCS of them, and none stored an item, while the account stored items on at least
// ACTIVE_DAYS of the BEFORE_DAYS before. Days, not a count of syncs: the timer syncs every few
// minutes, so an account's last few syncs storing nothing is its usual state. QUIET_DAYS (the lever
// `detect.quiet_days`, 3 by default), ACTIVE_DAYS, BUDGET_RUNS, BACKLOG_OVER and the stopped-after
// days are levers, the owner's to move: each constant here is its lever's default, and
// `raiseDetected` passes each test the lever's value.
const QUIET_SYNCS = 3;
const BEFORE_DAYS = 14;
// Nearly every day: an account that is quiet on weekends stores on ten of fourteen and is left
// alone, so a long weekend raises nothing.
const ACTIVE_DAYS = leverDefault("detect.active_days");
export const storesNothing = (
  row: { syncs: number; ok: number; stored: number; daysBefore: number },
  activeDays: number = ACTIVE_DAYS,
): boolean => row.syncs >= QUIET_SYNCS && row.ok === row.syncs && row.stored === 0 && row.daysBefore >= activeDays;

// A job keeps stopping on its budget: its last BUDGET_RUNS runs, those that found the lock held or
// their lane off aside, all ended `budget`, so the pass never finishes.
const BUDGET_RUNS = leverDefault("detect.budget_runs");
const NOT_A_RUN = ["busy", "already_running", "lane_off"];
export const budgetStopped = (codes: readonly string[], runs: number = BUDGET_RUNS): boolean =>
  codes.length >= runs && codes.slice(0, runs).every((code) => code === "budget");
// And it stands only while the stop is new or getting worse (imp_01M747YJ5NK761XN776VSHN3ME item
// 8), so a job that usually ends on its budget, as the night's pass may, or as extraction does on a
// day that reaches its line, does not keep a card standing every day. New: the streak of stops (the
// runs since the job's last run that ended otherwise) began within BUDGET_NEW_MS, and no stop came in
// the BUDGET_NEW_MS before it. Worse: the backlog its latest run left (the night's pass alone records
// one) is larger than the one the oldest of those runs left. `codes` and `backlogs` are newest first.
export const BUDGET_NEW_MS = 14 * DAY_MS;
export const budgetStands = (
  last: { codes: readonly string[]; backlogs: readonly (number | null)[]; since: Date | null; earlier: boolean },
  now: Date,
  runs: number = BUDGET_RUNS,
): boolean => {
  if (!budgetStopped(last.codes, runs)) return false;
  const fresh = last.since !== null && now.getTime() - last.since.getTime() <= BUDGET_NEW_MS && !last.earlier;
  const [latest] = last.backlogs;
  const oldest = last.backlogs[runs - 1];
  return fresh || (typeof latest === "number" && typeof oldest === "number" && latest > oldest);
};

// Every job but the night's pass, whose rule is budgetStands: its newest run stopped at its budget
// with work left, so a stop at the spending line is a card from the first one, and never reads as a
// run that finished. The backlog is what the run left: above 0, or not recorded, which is told
// rather than taken as none. `codes` and `backlogs` are newest first.
export const stoppedWithWork = (last: { codes: readonly string[]; backlogs: readonly (number | null)[] }): boolean =>
  last.codes[0] === "budget" && (last.backlogs[0] ?? 1) > 0;

// Extraction's backlog: the items its runs of this UTC day and the one before ended `failed` on
// (vault.extraction_runs.failed; a run row holds a day and no time), BACKLOG_OVER or more. Fifty
// is where `pi extract retry` already asks before it selects so many.
const BACKLOG_OVER = leverDefault("detect.backlog_over");
export const backlogOf = (runs: readonly { failed: number }[], over: number = BACKLOG_OVER): boolean =>
  runs.reduce((sum, run) => sum + run.failed, 0) >= over;

// A daily job stopped: it has a run recorded and none started for three of its periods. Only the
// jobs the timer records at least once a day whatever their state: a run, or `lane_off` while a
// switch or a hold keeps the job from starting. Those are the night's pass, extraction, the
// reasoner, the outcome test and the filing pass. A job with no run at all was never turned on.
// The standing check records nothing while it is off, so its silence cannot be told from a switch.
const DAILY: readonly JobName[] = ["dream", "extract", "reasoner", "outcome_test", "improvement_filing"];
export const STOPPED_AFTER_MS = leverDefault("detect.stopped_after_days") * DAY_MS;
export const stoppedSince = (last: Date | null, now: Date, afterMs: number = STOPPED_AFTER_MS): boolean =>
  last !== null && now.getTime() - last.getTime() > afterMs;
// The box itself was held: no job of any kind has a row from before this loop that is inside the
// stopped window. The timer starts nothing under the sync hold and records no row, so after a hold
// longer than the window every daily job looks stopped at the first record, and the next record
// would withdraw each card. `seen` is the latest run of any job started more than LOOP_MS ago,
// longer than the part of a loop that comes before its record (a sync, a settle, the record).
export const LOOP_MS = 60 * 60_000;
export const boxHeld = (seen: Date | null, now: Date, afterMs: number = STOPPED_AFTER_MS): boolean =>
  seen === null || now.getTime() - seen.getTime() > afterMs;

// Once the owner marks a detector's card seen while its condition stands, it is raised again no
// sooner than this long after their answer.
const AGAIN_MS = 7 * DAY_MS;

// One kind's cards set to what stands now: each open card whose thing no longer stands is
// withdrawn, and each thing standing gets its card, unless the owner answered its last one lately.
async function settle(
  query: Query,
  now: Date,
  log: PersonalLogger,
  kind: BoxHealthKind,
  standing: readonly string[],
): Promise<void> {
  const prefix = caseOf(kind, "");
  const open = await query<{ case_key: string }>(
    `select c.case_key from ledger.cards c
     where c.kind = $1 and c.created_by = $2 and left(c.case_key, length($3)) = $3
       and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
     order by c.created_at, c.id`,
    [HEALTH_CARD, HEALTH_AUTHOR, prefix],
  );
  for (const { case_key } of open) {
    const about = case_key.slice(prefix.length);
    if (!standing.includes(about)) await closeHealth(query, now, kind, about);
  }
  for (const about of standing) {
    const [last] = await query<{ event: string; at: Date }>(
      `select e.event, e.at from ledger.cards c cross join lateral (${latestRow("r.event, r.at", "card", "c.id")}) e
       where c.case_key = $1 order by c.created_at desc, c.id desc limit 1`,
      [caseOf(kind, about)],
    );
    if (last?.event === "decided" && now.getTime() - last.at.getTime() < AGAIN_MS) continue;
    // A card code withdrew is not raised again within a day: a condition that comes and goes
    // would otherwise file a new card and a new defect each time.
    if (last?.event === "withdrawn" && now.getTime() - last.at.getTime() < DAY_MS) continue;
    await raiseHealth(query, now, log, kind, about);
  }
}

// The database connection's TLS: a `tls_unverified` card about `database` stands while the admin's
// connection reaches another host with a mode that checks no certificate (db.ts, `tlsUnverified`),
// so `sslmode=require` with no CA configured is told rather than silent.
export const TLS_ABOUT = "database";

// What the coverage record raises and withdraws beside its states and box-health.ts's own
// (coverage.ts): the four detectors, each over rows read now, and the connection's TLS.
// `connectors`: those whose accounts sync. `tlsUnverified`: the admin's connection checks no
// certificate.
export async function raiseDetected(
  query: Query,
  now: Date,
  log: PersonalLogger,
  connectors: readonly string[],
  tlsUnverified = false,
): Promise<void> {
  await settle(query, now, log, "tls_unverified", tlsUnverified ? [TLS_ABOUT] : []);
  const quietDays = await lever(query, "detect.quiet_days");
  const activeDays = await lever(query, "detect.active_days");
  const budgetRuns = await lever(query, "detect.budget_runs");
  const backlogOver = await lever(query, "detect.backlog_over");
  const stoppedAfterMs = (await lever(query, "detect.stopped_after_days")) * DAY_MS;
  const quietFrom = new Date(now.getTime() - quietDays * DAY_MS);
  const accounts = await query<{ id: string; syncs: number; ok: number; stored: number; days_before: number }>(
    // A row with no sync kind was recorded outside a sync (an import), and the standing check's
    // accounts are its own.
    `select a.id,
       (count(*) filter (where o.started_at > $2))::int as syncs,
       (count(*) filter (where o.started_at > $2 and o.code = 'ok'))::int as ok,
       coalesce(sum(o.stored) filter (where o.started_at > $2), 0)::int as stored,
       (count(distinct (o.started_at at time zone 'utc')::date) filter (where o.started_at <= $2 and o.stored > 0))::int as days_before
     from vault.source_accounts a
     join vault.sync_outcomes o on o.account_id = a.id and o.started_at > $1 and o.started_at <= $3 and o.sync_kind is not null
     where a.connector = any ($4::text[]) and not a.compartments && $5::text[]
     group by a.id order by a.id collate "C"`,
    [new Date(quietFrom.getTime() - BEFORE_DAYS * DAY_MS), quietFrom, now, [...connectors], [...CANARY_CLEARANCE]],
  );
  await settle(
    query,
    now,
    log,
    "stores_nothing",
    accounts
      .filter((one) => storesNothing({ ...one, daysBefore: one.days_before }, activeDays))
      .map((one) => `account/${one.id}`),
  );

  // Each job's last runs, newest first; the start of its streak of stops, its first run after its
  // last that ended otherwise; and whether a stop came in the window before that start.
  const last = await query<{
    job: string;
    codes: string[];
    backlogs: (number | null)[];
    since: Date | null;
    earlier: boolean;
  }>(
    `select n.job, l.codes, l.backlogs, s.since,
       exists (select 1 from ledger.job_runs e where e.job = n.job and e.code = 'budget'
               and e.started_at >= s.since - make_interval(secs => $4) and e.started_at < s.since) as earlier
     from unnest($1::text[]) as n (job)
     cross join lateral (
       select coalesce(array_agg(t.code order by t.started_at desc, t.id desc), '{}') as codes,
              coalesce(array_agg(t.backlog order by t.started_at desc, t.id desc), '{}') as backlogs
       from (select r.id, r.started_at, r.code, r.backlog from ledger.job_runs r
             where r.job = n.job and r.code <> all ($2::text[]) order by r.started_at desc, r.id desc limit $3) t) l
     cross join lateral (
       select min(r.started_at) as since from ledger.job_runs r
       where r.job = n.job and r.code <> all ($2::text[])
         and r.started_at > coalesce((select max(o.started_at) from ledger.job_runs o
                                      where o.job = n.job and o.code <> all ($2::text[]) and o.code <> 'budget'), '-infinity')) s`,
    [[...JOB_NAMES], NOT_A_RUN, budgetRuns, BUDGET_NEW_MS / 1000],
  );
  await settle(
    query,
    now,
    log,
    "budget_stops",
    last
      .filter((one) => (one.job === "dream" ? budgetStands(one, now, budgetRuns) : stoppedWithWork(one)))
      .map((one) => one.job),
  );

  // Only the runs within the card's own label: the card is raised under `own`, so a run under any
  // other compartment adds nothing to what a reader of the card is told.
  const runs = await query<{ failed: number }>(
    `select failed from vault.extraction_runs
     where day >= ($1::timestamptz at time zone 'utc')::date - 1 and compartments <@ '{own}'::text[]`,
    [now],
  );
  await settle(query, now, log, "extract_backlog", backlogOf(runs, backlogOver) ? ["extract"] : []);

  const latest = await query<{ job: string; last: Date | null }>(
    `select n.job, (select max(r.started_at) from ledger.job_runs r where r.job = n.job and r.started_at <= $2) as last
     from unnest($1::text[]) as n (job)`,
    [[...DAILY], now],
  );
  // Silence proves nothing while the box was held: the cards stand as they are until the next record.
  const [seen] = await query<{ last: Date | null }>(
    "select max(started_at) as last from ledger.job_runs where started_at <= $1",
    [new Date(now.getTime() - LOOP_MS)],
  );
  if (boxHeld(seen?.last ?? null, now, stoppedAfterMs)) return;
  await settle(
    query,
    now,
    log,
    "detector_stopped",
    latest.filter((one) => stoppedSince(one.last, now, stoppedAfterMs)).map((one) => one.job),
  );
}
