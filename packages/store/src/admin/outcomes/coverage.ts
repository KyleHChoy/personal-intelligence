import type { Timestamp } from "@intelligence/contracts";
import {
  CANARY_CLEARANCE,
  CANARY_DEVICE,
  COVERAGE_DAYS_MOST,
  CodedError,
  CoverageRow,
  type CoverageState,
  isCoded,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { raiseOnRecord } from "../../core/box-health.ts";
import { raiseDetected } from "../../core/box-health-detectors.ts";
import { byText, endOwnPool, ownPool, type Query } from "../../core/db.ts";
import { CAPTURE_KINDS, EXTRACTION_LANES } from "../../core/lanes.ts";
import { notCanaryClient } from "../../core/statements.ts";

// Coverage: one CoverageRow for each thing the owner connected or registered, with one state over a
// window of days, computed by ids and counts as pi_admin; the states recorded so a row that stays
// silent is reported once; and each scheduled job's own run row, written under the job's own role.
// Nothing here opens a sealed value, and nothing stops, retries or refuses because of a state.

// `pia status --coverage --days N`: 1 to 90, 7 when unset.
export const COVERAGE_DAYS = { min: 1, max: COVERAGE_DAYS_MOST, default: 7 } as const;

// One run of a scheduled job: `pi sync` as pi_writer, with its kind and whether the read hold was set as
// it started; `pi erase settle` as pi_admin; `pi work tick` as pi_work. `code` is the run's outcome code.
type JobRun =
  | {
      job: "sync";
      syncKind: "full" | "fast";
      readHold: boolean;
      startedAt: Timestamp;
      endedAt: Timestamp;
      code: string;
    }
  | { job: "erase_settle" | "work_tick"; startedAt: Timestamp; endedAt: Timestamp; code: string };

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

// How long a job waits for its row to be written, connection and statement each: the timer waits
// for the job, so a database that never answers must not hold it.
const JOB_RUN_TIMEOUT_MS = 5_000;

// Writes one ledger.job_runs row on a connection of its own, made from `url`, the job's own
// role's. A failure is `unavailable`, with nothing of the statement: the caller logs its code.
export async function recordJobRun({ url, log }: { url: string; log: PersonalLogger }, run: JobRun): Promise<void> {
  const code = CODE.test(run.code) ? run.code : "unknown";
  const pool = ownPool(url, 1, log, { timeoutMs: JOB_RUN_TIMEOUT_MS });
  try {
    await pool.query(
      "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ($1, $2, $3, $4, $5, $6)",
      [
        run.job,
        run.job === "sync" ? run.syncKind : null,
        run.job === "sync" ? run.readHold : null,
        run.startedAt,
        run.endedAt,
        code,
      ],
    );
  } catch {
    throw new CodedError("unavailable");
  } finally {
    await endOwnPool(pool);
  }
}

// What a job is, for withJobRun: the sync's kind, and whether the read hold is set, read when its
// run ends, as the timer reads the hold after the sync to decide whether to tick.
type JobOf =
  | { job: "erase_settle" | "work_tick" }
  | { job: "sync"; syncKind: "full" | "fast"; readHold: () => boolean };

// Runs one scheduled job and writes its ledger.job_runs row at the end, whatever its outcome: the
// result's code (`ok` unless `codeOfResult` says otherwise), or the error's (`codeOfError`). A row
// that cannot be written is logged as job_run_unrecorded with its code and changes nothing of the
// job's own result or error.
export async function withJobRun<T>(
  options: { url: string; log: PersonalLogger },
  job: JobOf,
  run: () => Promise<T>,
  codes: { ofError: (error: unknown) => string; ofResult?: (result: T) => string },
): Promise<T> {
  const startedAt = new Date().toISOString();
  let code = "unknown";
  try {
    const result = await run();
    code = codes.ofResult?.(result) ?? "ok";
    return result;
  } catch (error) {
    code = codes.ofError(error);
    throw error;
  } finally {
    const ended = { startedAt, endedAt: new Date().toISOString(), code };
    const row: JobRun =
      job.job === "sync"
        ? { job: "sync", syncKind: job.syncKind, readHold: job.readHold(), ...ended }
        : { job: job.job, ...ended };
    await recordJobRun(options, row).catch((error: unknown) =>
      options.log.warn({
        event: "job_run_unrecorded",
        code: isCoded(error) ? error.code : "unavailable",
      }),
    );
  }
}

// The connectors whose accounts sync, each with an outcome per run. Agent, web and Lens accounts
// have none: a device is its own row.
const SYNCED = ["google_mail", "google_calendar", "google_docs", "google_contacts", "contacts_import", "agent_people"];
// What a job's follower may take after a sync, and the longest a sync may wait for the next.
const FOLLOW_MS = 30 * 60_000;

const row = (
  kind: CoverageRow["kind"],
  id: string,
  state: CoverageState,
  counts: Record<string, number>,
  code?: string,
): CoverageRow => ({
  kind,
  id,
  state,
  ...(code === undefined ? {} : { code }),
  counts,
});
const byId = (a: CoverageRow, b: CoverageRow): number => byText(a.id, b.id);

async function accounts(query: Query, since: Date, now: Date): Promise<CoverageRow[]> {
  const found = await query<{ id: string; syncs: number; ok: number; added: number; decided: number }>(
    `select a.id, count(o.id)::int as syncs, count(o.id) filter (where o.code = 'ok')::int as ok,
       coalesce(sum(o.added), 0)::int as added, coalesce(sum(o.decided), 0)::int as decided
     from vault.source_accounts a
     left join vault.sync_outcomes o on o.account_id = a.id and o.started_at >= $1 and o.started_at <= $2
     where a.connector = any ($3::text[]) and not a.compartments && $4::text[]
     group by a.id`,
    [since, now, SYNCED, [...CANARY_CLEARANCE]],
  );
  return found
    .map(({ id, syncs, ok, added, decided }) => {
      const counts = { syncs, ok, added, decided };
      if (syncs === 0) return row("account", id, "inactive", counts);
      if (ok === 0) return row("account", id, "silent", counts, "no_success");
      // Never the cursor alone: only additions that history listed and nothing decided.
      if (added > 0 && decided === 0) return row("account", id, "silent", counts, "added_not_decided");
      return row("account", id, "covered", counts);
    })
    .sort(byId);
}

// A device, by its capture client, and each capture class: what it pushed by kind and UTC day,
// and its rows still waiting past two full syncs.
async function devices(query: Query, since: Date): Promise<CoverageRow[]> {
  // A device in `deny` mode admits kind block with no rule.
  const listed = await query<{ id: string; name: string; waiting: number; tasks: boolean; deny: boolean }>(
    `select d.capture_client_id as id, d.name, d.browsing = 'deny' as deny,
       (select count(*) from ledger.capture_inbox i where i.client_id = d.capture_client_id and i.taken_at is null and i.refused_code is null
          and (select count(*) from ledger.job_runs j where j.job = 'sync' and j.sync_kind = 'full' and j.started_at > i.received_at) >= 2)::int as waiting,
       exists (select 1 from vault.source_accounts a where a.connector = 'lens_tasks' and a.label = 'device:' || d.name) as tasks
     from policy.lens_devices d join policy.clients c on c.id = d.capture_client_id
     where c.status = 'active' and d.name <> '${CANARY_DEVICE}'`,
  );
  const days = await query<{ client_id: string; kind: string; day: string }>(
    `select client_id, kind, ((received_at at time zone 'utc')::date)::text as day from ledger.capture_inbox
     where kind <> 'forget' and received_at >= $1 group by 1, 2, 3`,
    [since],
  );
  const scoped = new Set(
    (await query<{ kind: string }>("select distinct unnest(kinds) as kind from policy.capture_scope")).map(
      (one) => one.kind,
    ),
  );
  const rows: CoverageRow[] = [];
  for (const { id, waiting, tasks, deny } of listed) {
    const mine = days.filter((one) => one.client_id === id);
    const pushed = new Set(mine.map((one) => one.day)).size;
    rows.push(
      waiting > 0
        ? row("device", id, "silent", { waiting, days: pushed }, "inbox_waiting")
        : row("device", id, pushed === 0 ? "inactive" : "covered", { waiting, days: pushed }),
    );
    for (const kind of CAPTURE_KINDS) {
      const classId = `${id}:${kind}`;
      // Every meeting is admitted whatever the scope rules, so meetings are never "not admitted".
      if (!(kind === "task" ? tasks : kind === "meeting" || scoped.has(kind) || (kind === "block" && deny))) {
        rows.push(row("capture_class", classId, "not_read", {}, "not_admitted"));
        continue;
      }
      const own = new Set(mine.filter((one) => one.kind === kind).map((one) => one.day));
      const quiet = new Set(mine.filter((one) => one.kind !== kind && !own.has(one.day)).map((one) => one.day)).size;
      const counts = { days: own.size, quiet_days: quiet };
      if (pushed === 0) rows.push(row("capture_class", classId, "inactive", counts));
      else
        rows.push(
          // Meetings come when they happen, so days without one are no sign of a broken capture.
          quiet >= 3 && kind !== "meeting"
            ? row("capture_class", classId, "silent", counts, "class_quiet")
            : row("capture_class", classId, "covered", counts),
        );
    }
  }
  return [
    ...rows.filter((one) => one.kind === "device").sort(byId),
    ...rows.filter((one) => one.kind === "capture_class").sort(byId),
  ];
}

async function lanes(query: Query, since: Date, generation: number): Promise<CoverageRow[]> {
  // The newest run that recorded its switches: a run of one capture or `pi extract age` records
  // none, since it may run from a shell without them.
  const [latest] = await query<{ lanes_off: string[] | null }>(
    "select lanes_off from vault.extraction_runs where lanes_off is not null order by seq desc limit 1",
  );
  const off = new Set(latest?.lanes_off ?? []);
  const rows: CoverageRow[] = [];
  // Each lane's due items at `generation` ($1) and its commits since the window's start ($2): a lane
  // is told by its items' source kind, as the pipeline reads them.
  for (const [lane, { due, kind }] of Object.entries(EXTRACTION_LANES)) {
    if (off.has(lane)) {
      rows.push(row("lane", lane, "not_read", {}, "switched_off"));
      continue;
    }
    const [dueRow] = await query<{ n: number }>(`select (${due})::int as n`, [generation]);
    const [commitRow] = await query<{ n: number }>(
      `select count(*)::int as n from vault.pipeline_items p join vault.evidence_items e on e.id = p.evidence_id
       where e.source_kind = $1 and not p.waiting and p.updated_at >= $2`,
      [kind, since],
    );
    const counts = { due: dueRow?.n ?? 0, committed: commitRow?.n ?? 0 };
    if (counts.due === 0) rows.push(row("lane", lane, "inactive", counts));
    else
      rows.push(
        counts.committed === 0
          ? row("lane", lane, "silent", counts, "due_not_committed")
          : row("lane", lane, "covered", counts),
      );
  }
  return rows.sort(byId);
}

// The sync's own state, from its runs in start order, the time now, the window's start and when the
// sync hold's cards were raised. It is judged by where it stands now, not by the worst gap of the
// window: silent while no sync has started for more than 30 minutes after the last one ended, and,
// once it resumes after such a gap, until syncs have run for 30 minutes again with no such gap. So
// one outage is silent while it lasts and for half an hour after, and never for the days the window
// still holds it. A gap during which a sync hold's card was raised is the owner's or a deploy's
// hold, not a silent source: the timer starts nothing under the hold, and raises that card once the
// hold has stood an hour. A hold lifted within the hour leaves no row to read, so a gap of 30 to 60
// minutes under one still reads silent, for half an hour. `gapMinutes`: the gap it was judged by.
export function syncState(
  syncs: readonly { start: number; end: number }[],
  at: number,
  since: number,
  holds: readonly number[] = [],
): { silent: boolean; gapMinutes: number } {
  const held = (from: number, to: number): boolean => holds.some((hold) => hold > from && hold <= to);
  const minutes = (gap: number): number => Math.max(0, Math.floor(gap / 60_000));
  const last = syncs.reduce((latest, one) => Math.max(latest, one.end), since);
  const trailing = at - last;
  if (trailing > FOLLOW_MS) return { silent: !held(last, at), gapMinutes: minutes(trailing) };
  for (let next = syncs.length - 1; next >= 1 && syncs[next]!.start > at - FOLLOW_MS; next -= 1) {
    const from = syncs[next - 1]!.end;
    const gap = syncs[next]!.start - from;
    if (gap > FOLLOW_MS && !held(from, syncs[next]!.start)) return { silent: true, gapMinutes: minutes(gap) };
  }
  return { silent: false, gapMinutes: minutes(trailing) };
}

// The timer has no fixed period: the sync is judged by syncState; a settle, and a tick after a sync
// with no read hold, must start within 30 minutes of each sync's end. The timer starts each of
// them when the sync ends. A job is never inactive, the night's pass aside.
async function jobs(query: Query, since: Date, now: Date): Promise<CoverageRow[]> {
  const runs = (
    await query<{ job: string; read_hold: boolean | null; started_at: Date; ended_at: Date }>(
      "select job, read_hold, started_at, ended_at from ledger.job_runs where started_at >= $1 and started_at <= $2 order by started_at, id",
      [since, now],
    )
  ).map((one) => ({
    job: one.job,
    readHold: one.read_hold === true,
    start: one.started_at.getTime(),
    end: one.ended_at.getTime(),
  }));
  const syncs = runs.filter((one) => one.job === "sync");
  const at = now.getTime();
  const holds = await query<{ created_at: Date }>(
    "select created_at from ledger.cards where case_key = 'box:hold:sync_hold' and created_at >= $1 and created_at <= $2",
    [since, now],
  );
  const judged = syncState(
    syncs,
    at,
    since.getTime(),
    holds.map((one) => one.created_at.getTime()),
  );
  const counts = { runs: syncs.length, gap_minutes: judged.gapMinutes };
  const sync = judged.silent ? row("job", "sync", "silent", counts, "sync_gap") : row("job", "sync", "covered", counts);
  // Only a sync whose 30 minutes since its end have passed expects its follower.
  const due = syncs.filter((one) => one.end + FOLLOW_MS <= at);
  const follower = (job: string, expects: typeof due, code: string): CoverageRow => {
    // The follower's starts, sorted: for each sync, the first start at or after the sync's own,
    // by binary search, must be no later than 30 minutes after its end.
    const starts = runs.filter((one) => one.job === job).map((one) => one.start);
    const firstFrom = (from: number): number | undefined => {
      let low = 0;
      let high = starts.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (starts[middle]! < from) low = middle + 1;
        else high = middle;
      }
      return starts[low];
    };
    const missing = expects.filter((one) => {
      const next = firstFrom(one.start);
      return next === undefined || next > one.end + FOLLOW_MS;
    }).length;
    const tally = { runs: starts.length, missing };
    return missing > 0 ? row("job", job, "silent", tally, code) : row("job", job, "covered", tally);
  };
  return [
    follower("erase_settle", due, "settle_missing"),
    sync,
    follower(
      "work_tick",
      due.filter((one) => !one.readHold),
      "tick_missing",
    ),
    await dream(query, now),
  ];
}

// The night's pass, over the last 36 hours whatever the window: inactive when
// the timer tried none (its gates were closed, or the lane was off: a `lane_off` row is no try),
// silent when it tried and none stopped `ok` or `budget` (`dream_missing`), so a pass that fails
// or is always busy for a day and a half raises a card.
const DREAM_WINDOW_MS = 36 * 60 * 60_000;
async function dream(query: Query, now: Date): Promise<CoverageRow> {
  const [counts] = await query<{ runs: number; ok: number }>(
    "select count(*)::int as runs, (count(*) filter (where code in ('ok', 'budget')))::int as ok from ledger.job_runs where job = 'dream' and code <> 'lane_off' and started_at > $1 and started_at <= $2",
    [new Date(now.getTime() - DREAM_WINDOW_MS), now],
  );
  const tally = { runs: counts?.runs ?? 0, ok: counts?.ok ?? 0 };
  if (tally.runs === 0) return row("job", "dream", "inactive", tally);
  return tally.ok === 0 ? row("job", "dream", "silent", tally, "dream_missing") : row("job", "dream", "covered", tally);
}

// An active agent client, a Lens mirror's left out (its device is its row): silent when a lease it
// held expired with no report, inactive with no call in the window.
async function clients(query: Query, since: Date, now: Date): Promise<CoverageRow[]> {
  const found = await query<{ id: string; calls: number; expired: number }>(
    `select c.id,
       (select count(*) from policy.calls k where k.client_id = c.id and k.at >= $1)::int as calls,
       ((select count(*) from queue.leases l where l.holder = c.id and l.lease_until < $2 and l.lease_until >= $1)
        + (select count(*) from ledger.record_events e
           where e.row_kind = 'opportunity' and e.code = 'lease_expired' and e.at >= $1
             and (select a.client_id from ledger.assignments a where a.opportunity_id = e.row_id and a.created_at <= e.at
                  order by a.created_at desc limit 1) = c.id))::int as expired
     from policy.clients c
     where c.status = 'active' and c.kind = 'agent' and ${notCanaryClient("c.name")} and not exists (select 1 from policy.lens_devices d where d.mirror_client_id = c.id)`,
    [since, now],
  );
  return found
    .map(({ id, calls, expired }) => {
      const counts = { calls, expired };
      if (expired > 0) return row("client", id, "silent", counts, "lease_expired");
      return row("client", id, calls === 0 ? "inactive" : "covered", counts);
    })
    .sort(byId);
}

// Admin.coverage: the rows over the last `days` days, up to now; `generation`, the extractor's,
// for what is due in each lane. One transaction, so every row reads the same moment.
export async function coverage(
  context: AdminContext,
  days: number,
  options: { generation: number },
): Promise<CoverageRow[]> {
  if (!Number.isInteger(days) || days < COVERAGE_DAYS.min || days > COVERAGE_DAYS.max)
    throw new AdminError("invalid_argument");
  const { generation } = options;
  const now = context.now();
  const since = new Date(now.getTime() - days * DAY_MS);
  return context.transaction(async (query) => [
    ...(await accounts(query, since, now)),
    ...(await devices(query, since)),
    ...(await lanes(query, since, generation)),
    ...(await jobs(query, since, now)),
    ...(await clients(query, since, now)),
  ]);
}

// Admin.recordCoverage: each row's state kept in ledger.coverage_states, its `since` moved only
// when its state changes, in one statement; and the rows that entered `silent` with this record,
// in their order. A row given twice counts once, as its last. In the same
// transaction, one box health card for each row that entered `silent`, withdrawn when its row
// leaves `silent`, the jobs' failure streaks and the backup reminder (box-health.ts), and the
// detectors' cards (box-health-detectors.ts).
export async function recordCoverage(context: AdminContext, rows: readonly CoverageRow[]): Promise<CoverageRow[]> {
  if (!rows.every((one) => CoverageRow.safeParse(one).success)) throw new AdminError("invalid_argument");
  const now = context.now();
  const last = [...new Map(rows.map((one) => [`${one.kind}/${one.id}`, one])).values()];
  return context.transaction(async (query) => {
    const stored = new Map(
      (
        await query<{ row_kind: string; row_id: string; state: string }>(
          "select row_kind, row_id, state from ledger.coverage_states",
        )
      ).map((one) => [`${one.row_kind}/${one.row_id}`, one.state]),
    );
    if (last.length > 0) {
      await query(
        `insert into ledger.coverage_states (row_kind, row_id, state, code, since)
         select k, i, s, c, $5 from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as given (k, i, s, c)
         on conflict (row_kind, row_id) do update set state = excluded.state, code = excluded.code,
           since = case when ledger.coverage_states.state = excluded.state then ledger.coverage_states.since else excluded.since end`,
        [
          last.map((one) => one.kind),
          last.map((one) => one.id),
          last.map((one) => one.state),
          last.map((one) => one.code ?? null),
          now,
        ],
      );
    }
    const silent = last.filter((one) => one.state === "silent" && stored.get(`${one.kind}/${one.id}`) !== "silent");
    const left = last.filter((one) => one.state !== "silent" && stored.get(`${one.kind}/${one.id}`) === "silent");
    await raiseOnRecord(
      query,
      now,
      context.log,
      silent,
      left,
      last.filter((one) => one.state === "silent"),
    );
    await raiseDetected(query, now, context.log, SYNCED, context.tlsUnverified ?? false);
    return silent;
  });
}
