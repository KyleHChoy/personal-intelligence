import {
  BOX_HEALTH_KINDS,
  BOX_HEALTH_SEEN_DAYS,
  BOX_HEALTH_SEEN_MOST,
  type BoxHealthKind,
  type BoxHealthRow,
  type BoxHealthSeenRow,
  CANARY_SOURCES,
  CARD_OPTIONS,
  type CanaryCode,
  type CanarySource,
  type CardId,
  type ClientName,
  type CoverageRow,
  dayIn,
  type HoldName,
  hourIn,
  JOB_NAMES,
  type JobName,
  ownLabel,
  type PersonalLogger,
  type SupervisedName,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "./admin-context.ts";
import { type Query, stamp } from "./db.ts";
import { newId } from "./ids.ts";
import { caseWord } from "./locks.ts";
import { lockRows, raiseCard } from "./queue.ts";
import { LATEST_CARD_EVENT, latestRow } from "./statements.ts";
import { ownerZoneOf } from "./zone.ts";

// The box's health: one "box health" card for each thing that went wrong on the box and that no one
// would otherwise see: a coverage row that entered `silent`, a hold left on more than an hour, a job
// its time limit stopped, a job whose last three runs failed, a dump or its restore test not done, a
// supervised process that keeps restarting, and the page not joined to the owner's tailnet. Each
// card is `box_health`, author `system:health`, with the one option `seen`, no body and no target,
// in the owner's own compartment. Its case key, `box:<kind>:<about>`, holds what it is about, so one
// undecided card stands for one kind and one thing (the queue's case rule), and a failure streak is
// not raised again while one is open. Ids, words and codes only: nothing here opens a sealed value.
// As pi_admin. The four kinds a detector reads at the coverage record are box-health-detectors.ts's.

export const HEALTH_AUTHOR = "system:health";
export const HEALTH_CARD = "box_health";
// A failure streak: this many runs of one job in a row, none of them ending well.
const STREAK = 3;
// What a run may end with and not count as failed: done, another run held the lock, or the night's
// pass stopped at its budget.
const ENDED_WELL = new Set(["ok", "already_running", "busy", "budget", "lane_off"]);
// A dump is due eight days after the last, or one day after an erasure with none since.
const BACKUP_DAYS = 8;
const BACKUP_AFTER_ERASURE_DAYS = 1;
// A restore drill is due this long after the last that passed: a dump lives 30 days.
const RESTORE_TEST_DAYS = 35;

export const caseOf = (kind: BoxHealthKind, about: string): string => `box:${kind}:${about}`;
// What a `backup_due` card about a dump may be about: the dump's age, or an erasure with none since.
// The restore test's card is about `restore`.
const BACKUP_ABOUTS = ["backup", "erasure"] as const;

// A box health card's case key, read back: its kind and what it is about (card-kinds.ts renders it).
export const HEALTH_CASE = /^box:([a-z_]+):(.+)$/;

// A box health card's kind and about, or null for a case key of no known kind.
function healthCaseOf(caseKey: string): { kind: BoxHealthKind; about: string } | null {
  const [, kind, about] = HEALTH_CASE.exec(caseKey) ?? [];
  if (kind === undefined || about === undefined || !(BOX_HEALTH_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as BoxHealthKind, about };
}

// A run's start as stored: never after now.
const startStamp = (startedAt: Date, now: Date): string => stamp(startedAt.getTime() > now.getTime() ? now : startedAt);

// One box health card, in the caller's transaction: its id, or null when an undecided one of the
// same kind and about stands.
export async function raiseHealth(
  query: Query,
  now: Date,
  log: PersonalLogger,
  kind: BoxHealthKind,
  about: string,
): Promise<CardId | null> {
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: HEALTH_CARD,
      author: HEALTH_AUTHOR,
      options: [...CARD_OPTIONS.box_health],
      target: null,
      refs: [],
      compartments: ownLabel(),
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: caseOf(kind, about),
      run: null,
      body: null,
      bodyFrom: null,
    },
    { now, log },
  );
  if (card.replayed) return null;
  // Forwarded, in this transaction, to every agent of the owner's with an address that is cleared for the
  // card (ledger.health_notice); `pi notify` sends it after the commit.
  const [told] = await query<{ n: number }>("select ledger.health_notice($1) as n", [card.id]);
  log.warn({ event: "box_health_raised", ids: { card: card.id }, code: kind, counts: { notices: told?.n ?? 0 } });
  return card.id;
}

// The open card of a kind and about withdrawn by the system, when what it told of mended (a hold
// lifted, a job that timed out ending well); its id, or null when none was open.
export async function closeHealth(query: Query, now: Date, kind: BoxHealthKind, about: string): Promise<CardId | null> {
  const key = caseOf(kind, about);
  await lockRows(query, [caseWord(key)]);
  const [open] = await query<{ id: CardId; compartments: string[] }>(
    `select c.id, c.compartments from ledger.cards c
     where c.case_key = $1 and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
     order by c.created_at, c.id limit 1`,
    [key],
  );
  if (open === undefined) return null;
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'withdrawn', $2, $3, ledger.label($4))",
    [open.id, stamp(now), HEALTH_AUTHOR, open.compartments],
  );
  return open.id;
}

// A timed-out card closed once a run of its job that started after the card ended ok (or, the
// night's pass, at its budget). A failure-streak card likewise, once no source of the job's still
// stands red (the check's rows are one a source). A failed restore drill's card is one too: a drill
// that passed closes it.
const SUCCEEDED = ["ok", "budget"];
async function closeMended(query: Query, now: Date, jobs: readonly JobName[] = JOB_NAMES): Promise<CardId[]> {
  const closed: CardId[] = [];
  for (const job of jobs) {
    for (const kind of ["timed_out", "failure_streak"] as const) {
      if (kind === "failure_streak" && job === "backup") continue;
      const [mended] = await query<{ yes: boolean }>(
        // The check's rows with no source are its run as a whole, which only a bad end writes: one
        // counts only until a source's later run ended ok.
        `select exists (
           select 1 from ledger.cards c
           where c.case_key = $1 and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
             and exists (select 1 from ledger.job_runs j where j.job = $2 and j.started_at > c.created_at and j.code = any ($3::text[]))
             and ($5::boolean or not exists (
                   select 1 from (select distinct on (r.about) r.about, r.code, r.started_at from ledger.job_runs r
                                  where r.job = $2 and r.started_at > c.created_at
                                  order by r.about, r.started_at desc, r.id desc) newest
                   where newest.code <> all ($4::text[])
                     and not (newest.about is null and $2 = 'canary'
                              and exists (select 1 from ledger.job_runs k where k.job = $2 and k.code = 'ok' and k.started_at > newest.started_at))))
         ) as yes`,
        [caseOf(kind, job), job, SUCCEEDED, [...ENDED_WELL], kind === "timed_out"],
      );
      if (mended?.yes !== true) continue;
      const id = await closeHealth(query, now, kind, job);
      if (id !== null) closed.push(id);
    }
  }
  return closed;
}

// A coverage row's card, about `<kind>/<id>`.
const silentAbout = (row: CoverageRow): string => `${row.kind}/${row.id}`;

// After the owner marks a streak card seen, the same streak (no run of the job ended well since) is
// raised again no sooner than a day after the answer from the owner, and each time after that no sooner than
// three days after it.
const STREAK_AGAIN_MS = [24 * 60 * 60_000, 72 * 60 * 60_000] as const;

// One job's streak, or one source's of the standing check.
async function raiseStreak(
  query: Query,
  now: Date,
  log: PersonalLogger,
  job: JobName,
  source: CanarySource | null,
): Promise<CardId | null> {
  const runs = await query<{ code: string; started_at: Date }>(
    // The check's run as a whole is its rows with no source, which only a bad end writes; any `ok`
    // row of its sources says a later run got through.
    `select code, started_at from ledger.job_runs where job = $1 and (about is not distinct from $3 or (job = 'canary' and $3::text is null and code = 'ok'))
     order by started_at desc, id desc limit $2`,
    [job, STREAK, source],
  );
  if (runs.length < STREAK || runs.some((run) => ENDED_WELL.has(run.code))) return null;
  const key = caseOf("failure_streak", job);
  const [last] = await query<{ at: Date; decided: Date | null; again: number }>(
    `select c.created_at as at,
       (${latestRow("r.at", "card", "c.id", { and: "r.event = 'decided'" })}) as decided,
       (select count(*) from ledger.cards o where o.case_key = $1
          and o.created_at > coalesce((select max(j.started_at) from ledger.job_runs j where j.job = $2 and j.code = any ($3) and j.about is not distinct from $4), '-infinity'))::int as again
     from ledger.cards c where c.case_key = $1 order by c.created_at desc, c.id desc limit 1`,
    [key, job, [...ENDED_WELL], source],
  );
  if (last !== undefined && runs.some((run) => run.started_at.getTime() <= last.at.getTime())) return null;
  // Seen, and still the same streak: wait a day after the first card of it, three after later ones.
  const wait = last === undefined || last.again === 0 ? 0 : STREAK_AGAIN_MS[last.again >= 2 ? 1 : 0];
  if (last?.decided != null && now.getTime() - last.decided.getTime() < wait) return null;
  return raiseHealth(query, now, log, "failure_streak", job);
}

// Each job whose last STREAK runs all ended badly, and none of them before that job's latest
// streak card, so a streak the owner has seen is not raised again until three new runs fail, and
// then only after its wait (STREAK_AGAIN_MS).
async function raiseStreaks(
  query: Query,
  now: Date,
  log: PersonalLogger,
  jobs: readonly JobName[] = JOB_NAMES,
): Promise<CardId[]> {
  const raised: CardId[] = [];
  for (const job of jobs) {
    // A failed drill is its card at once (recordRestoreTest), not after three.
    if (job === "restore_drill") continue;
    for (const source of job === "canary" ? [null, ...CANARY_SOURCES] : [null]) {
      // The check's rows run side by side, one a day for each source, so a streak is one source's;
      // the card is the check's, so one outage is one card, however many sources it reddened.
      const id = await raiseStreak(query, now, log, job, source);
      if (id !== null) {
        raised.push(id);
        break;
      }
    }
  }
  return raised;
}

// The backup reminder: one card per time a dump falls due, about why. `backup`: more than
// BACKUP_DAYS since the last dump, the line the measure `backup_age_days` is read against, so the
// card and the measure agree. `erasure`: BACKUP_AFTER_ERASURE_DAYS after an erasure with no dump
// since, which the dump's age does not show. Raised only when no backup card of either was raised
// after the moment it fell due from. While no dump was ever recorded, at once, and again
// BACKUP_DAYS after each card. A dump closes both (backupTaken).
async function raiseBackupDue(query: Query, now: Date, log: PersonalLogger): Promise<CardId | null> {
  const [row] = await query<{ dumped: Date | null; erased: Date | null; asked: Date | null }>(
    `select (select max(ended_at) from ledger.job_runs where job = 'backup' and code = 'ok') as dumped,
       (select max(erased_at) from knowledge.erasures) as erased,
       (select max(created_at) from ledger.cards where case_key = any ($1::text[])) as asked`,
    [BACKUP_ABOUTS.map((about) => caseOf("backup_due", about))],
  );
  const dumped = row?.dumped ?? null;
  const erased = row?.erased ?? null;
  const at = now.getTime();
  const afterErasure =
    erased !== null &&
    (dumped === null || erased > dumped) &&
    at - erased.getTime() >= BACKUP_AFTER_ERASURE_DAYS * DAY_MS;
  const stale = dumped === null || at - dumped.getTime() > BACKUP_DAYS * DAY_MS;
  if (!afterErasure && !stale) return null;
  // The moment it fell due from: the erasure's, the last dump's, or, with none ever, the last card's
  // eight days on.
  const asked = row?.asked ?? null;
  const from =
    afterErasure && erased !== null
      ? erased
      : (dumped ?? (asked === null ? null : new Date(asked.getTime() + BACKUP_DAYS * DAY_MS)));
  if (asked !== null && (from === null || asked > from || from.getTime() > at)) return null;
  return raiseHealth(query, now, log, "backup_due", afterErasure ? "erasure" : "backup");
}

// A client's own token lapsing: one card per active client whose token expires within
// TOKEN_WARN_DAYS, about `client/<id>`, raised once for that expiry, so a card the owner marked
// seen is not raised again until the token is rotated and nears its next expiry. A client bound to
// an OAuth registration is left out: its own token is never shown, and its access tokens carry
// their own expiry. A rotation or a revocation withdraws the open card.
const TOKEN_WARN_DAYS = 7;
async function raiseTokenExpiring(query: Query, now: Date, log: PersonalLogger): Promise<void> {
  const prefix = caseOf("token_expiring", "client/");
  const lapsing = await query<{ id: string }>(
    `select k.id from policy.clients k
     where k.status = 'active' and k.expires_at <= $1::timestamptz + make_interval(days => $2)
       and not exists (select 1 from policy.oauth_registrations r where r.client_id = k.id)
       and not exists (select 1 from ledger.cards c where c.case_key = $3 || k.id
                        and c.created_at >= k.expires_at - make_interval(days => $2))
     order by k.id`,
    [stamp(now), TOKEN_WARN_DAYS, prefix],
  );
  for (const { id } of lapsing) await raiseHealth(query, now, log, "token_expiring", `client/${id}`);
  const mended = await query<{ id: string }>(
    `select substr(c.case_key, length($1) + 1) as id from ledger.cards c
     where starts_with(c.case_key, $1) and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
       and not exists (select 1 from policy.clients k where k.id = substr(c.case_key, length($1) + 1)
                        and k.status = 'active' and k.expires_at <= $2::timestamptz + make_interval(days => $3))`,
    [prefix, stamp(now), TOKEN_WARN_DAYS],
  );
  for (const { id } of mended) await closeHealth(query, now, "token_expiring", `client/${id}`);
}

// The restore drill's reminder, once a dump has been recorded: due RESTORE_TEST_DAYS after the last
// drill that passed, or at once while none has, and then every BACKUP_DAYS after its last card, once
// seen.
async function raiseRestoreDue(query: Query, now: Date, log: PersonalLogger): Promise<CardId | null> {
  const [row] = await query<{ dumped: Date | null; tested: Date | null; asked: Date | null }>(
    `select (select max(ended_at) from ledger.job_runs where job = 'backup' and code = 'ok') as dumped,
       (select max(ended_at) from ledger.job_runs where job = 'restore_drill' and code = 'ok') as tested,
       (select max(created_at) from ledger.cards where case_key = $1) as asked`,
    [caseOf("backup_due", "restore")],
  );
  if (row === undefined || row.dumped === null) return null;
  const at = now.getTime();
  if (row.tested !== null && at - row.tested.getTime() < RESTORE_TEST_DAYS * DAY_MS) return null;
  if (row.asked !== null && at - row.asked.getTime() < BACKUP_DAYS * DAY_MS) return null;
  return raiseHealth(query, now, log, "backup_due", "restore");
}

// Admin.recordJob (`pia health job JOB CODE --started EPOCH`): one ledger.job_runs row, ended now,
// for a run the timer saw end: a run of extract, dream or the reasoner, or a `timed_out` run of any
// job its time limit stopped; then its card when it timed out, and its job's failure streak. A
// night's pass's row also keeps the sweep's backlog and each stage's spend, when its counts gave them.
export function recordJob(
  context: AdminContext,
  run: {
    job: JobName;
    code: string;
    startedAt: Date;
    syncKind?: "full" | "fast";
    readHold?: boolean;
    backlog?: number;
    stageMicroUsd?: Readonly<Record<string, number>>;
  },
): Promise<CardId[]> {
  const now = context.now();
  return context.transaction(async (query) => {
    const sync = run.job === "sync";
    const stages = run.stageMicroUsd === undefined ? null : JSON.stringify(run.stageMicroUsd);
    await query(
      `insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code, backlog, stage_micro_usd)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        run.job,
        sync ? (run.syncKind ?? "full") : null,
        sync ? (run.readHold ?? false) : null,
        startStamp(run.startedAt, now),
        stamp(now),
        run.code,
        run.backlog ?? null,
        stages,
      ],
    );
    const raised: CardId[] = [];
    if (run.code === "timed_out") {
      const id = await raiseHealth(query, now, context.log, "timed_out", run.job);
      if (id !== null) raised.push(id);
    }
    await closeMended(query, now, [run.job]);
    return [...raised, ...(await raiseStreaks(query, now, context.log, [run.job]))];
  });
}

// Admin.recordCanary (`pi canary check`): one ledger.job_runs row per source, job `canary`, about
// that source, with the code of the first hop that failed; then each source's failure streak.
export function recordCanary(
  context: AdminContext,
  results: readonly { source: CanarySource; code: CanaryCode }[],
  startedAt: Date,
): Promise<CardId[]> {
  const now = context.now();
  return context.transaction(async (query) => {
    for (const { source, code } of results)
      await query(
        "insert into ledger.job_runs (job, about, started_at, ended_at, code) values ('canary', $1, $2, $3, $4)",
        [source, startStamp(startedAt, now), stamp(now), code],
      );
    return raiseStreaks(query, now, context.log, ["canary"]);
  });
}

// Admin.recordHold (`pia health hold NAME`): the timer's word that a hold has been on for more than
// an hour; with `off` (`--off`), that it was lifted, which closes its open card.
export function recordHold(context: AdminContext, hold: HoldName, off = false): Promise<CardId | null> {
  return context.transaction((query) =>
    off
      ? closeHealth(query, context.now(), "hold", hold)
      : raiseHealth(query, context.now(), context.log, "hold", hold),
  );
}

// Admin.recordRestarting (`pia health restarting NAME`): the timer's word that a supervised process
// ended within a minute of its start three times in a row.
export function recordRestarting(context: AdminContext, name: SupervisedName): Promise<CardId | null> {
  return context.transaction((query) => raiseHealth(query, context.now(), context.log, "restarting", name));
}

// Admin.recordDashboardDown (`pia health dashboard-down [--off]`): the timer's word that the page
// has not been joined to the owner's tailnet for 15 minutes, or, with `off`, that it is joined again.
export function recordDashboardDown(context: AdminContext, off = false): Promise<CardId | null> {
  return context.transaction((query) =>
    off
      ? closeHealth(query, context.now(), "dashboard_down", "tailscale")
      : raiseHealth(query, context.now(), context.log, "dashboard_down", "tailscale"),
  );
}

// Admin.backupTaken (`pia backup taken`): the owner's word that they took a dump, as a `backup` run.
// The dump is what a `backup_due` card about a dump asked for, so each open one closes with it.
export function backupTaken(context: AdminContext): Promise<void> {
  const now = context.now();
  const at = stamp(now);
  return context.transaction(async (query) => {
    await query("insert into ledger.job_runs (job, started_at, ended_at, code) values ('backup', $1, $1, 'ok')", [at]);
    for (const about of BACKUP_ABOUTS) await closeHealth(query, now, "backup_due", about);
  });
}

// Admin.recordRestoreTest (`pi restore check`): one `restore_drill` run on the live store, `ok` or
// `failed`, so the capability ledger shows the drill as a job of its own and no count of dumps reads
// it. A drill that failed is a card at once; one that passed closes it, and the reminder of a drill.
export function recordRestoreTest(context: AdminContext, passed: boolean, startedAt: Date): Promise<CardId | null> {
  const now = context.now();
  return context.transaction(async (query) => {
    await restoreRow(query, startedAt, now, passed ? "ok" : "failed");
    if (passed) {
      for (const about of ["restore_drill", "backup"]) await closeHealth(query, now, "failure_streak", about);
      await closeHealth(query, now, "backup_due", "restore");
      return null;
    }
    return raiseHealth(query, now, context.log, "failure_streak", "restore_drill");
  });
}

// Admin.recordRestoreSkipped (`pi restore check`): a dump older than the schema, which tested nothing.
// One `schema_behind` run, which neither passes nor fails a drill, and no card.
export function recordRestoreSkipped(context: AdminContext, startedAt: Date): Promise<void> {
  const now = context.now();
  return context.transaction((query) => restoreRow(query, startedAt, now, "schema_behind"));
}

// One `restore_drill` run of a restore check's code.
async function restoreRow(query: Query, startedAt: Date, now: Date, code: string): Promise<void> {
  await query("insert into ledger.job_runs (job, started_at, ended_at, code) values ('restore_drill', $1, $2, $3)", [
    stamp(startedAt),
    stamp(now),
    code,
  ]);
}

// The newest migration this database has applied. Names sort by their number.
export function latestMigration(context: AdminContext): Promise<string | null> {
  return context.transaction(async (query) => {
    const [row] = await query<{ name: string | null }>("select max(name) as name from policy.migrations");
    return row?.name ?? null;
  });
}

// Whether a row that is `silent` now gets a card. A card code withdrew is not raised again within a
// day, as a detector's is not: a row that comes and goes would otherwise raise a card each time.
// Once the day has passed a row still silent gets its card, whether or not it entered `silent` at
// this record. Any other row gets one only as it enters `silent`, so one the owner marked seen is
// not raised again while it stays so. One an agent marked seen rests a day as one code withdrew
// does, and is raised again if the row is still silent: an agent's seen hides nothing for good.
export const silentRaises = (
  entered: boolean,
  last: { event: string; at: Date; by?: string } | undefined,
  now: Date,
): boolean =>
  last?.event === "withdrawn" || (last?.event === "decided" && isAgentSeen(last.by))
    ? now.getTime() - last.at.getTime() >= DAY_MS
    : entered;

// What the coverage record raises beside its states (coverage.ts): a card per row that entered
// `silent` (silentRaises), withdrawn for each row (`left`) that left it, the failure streaks of
// every job, and the reminders of a dump and of its restore test. `standing`: every row silent now.
export async function raiseOnRecord(
  query: Query,
  now: Date,
  log: PersonalLogger,
  silent: readonly CoverageRow[],
  left: readonly CoverageRow[] = [],
  standing: readonly CoverageRow[] = silent,
): Promise<void> {
  for (const row of left) await closeHealth(query, now, "silent", silentAbout(row));
  const entered = new Set(silent.map(silentAbout));
  for (const row of standing) {
    const about = silentAbout(row);
    const [last] = await query<{ event: string; at: Date; by: string }>(
      `select e.event, e.at, e.by from ledger.cards c cross join lateral (${latestRow("r.event, r.at, r.by", "card", "c.id")}) e
       where c.case_key = $1 order by c.created_at desc, c.id desc limit 1`,
      [caseOf("silent", about)],
    );
    if (silentRaises(entered.has(about), last, now)) await raiseHealth(query, now, log, "silent", about);
  }
  await closeMended(query, now);
  await raiseStreaks(query, now, log);
  await raiseBackupDue(query, now, log);
  await raiseRestoreDue(query, now, log);
  await raiseTokenExpiring(query, now, log);
}

// An agent's seen on a box health card: a `decided` event by a client, which ledger.mark_health_seen
// alone writes. The owner's is by `owner`.
const AGENT_SEEN_BY = "client:";
const isAgentSeen = (by: string | undefined): boolean => by?.startsWith(AGENT_SEEN_BY) === true;

// `pia status`'s boxHealthSeen: the cards an agent marked seen in the last BOX_HEALTH_SEEN_DAYS,
// newest first, each with the agent's name. As pi_admin, which reads every card and client.
export async function seenHealth(query: Query, now: Date): Promise<BoxHealthSeenRow[]> {
  const rows = await query<{ id: CardId; case_key: string; at: Date; name: string }>(
    `select c.id, c.case_key, e.at, k.name from ledger.record_events e
     join ledger.cards c on c.id = e.row_id and c.kind = $1 and c.created_by = $2 and c.tainted_at is null
     join policy.clients k on e.by = $3 || k.id
     where e.row_kind = 'card' and e.event = 'decided' and e.code = 'agent_seen' and e.tainted_at is null
       and e.at > $4::timestamptz - make_interval(days => $5)
     order by e.at desc, c.id desc limit $6`,
    [HEALTH_CARD, HEALTH_AUTHOR, AGENT_SEEN_BY, stamp(now), BOX_HEALTH_SEEN_DAYS, BOX_HEALTH_SEEN_MOST],
  );
  return rows.flatMap((row) => {
    const found = healthCaseOf(row.case_key);
    return found === null ? [] : [{ card: row.id, ...found, client: row.name as ClientName, at: stamp(row.at) }];
  });
}

// The open box health cards, oldest first, each with a code computed now: a silent row's recorded
// code, a streak's latest run's, `timed_out` for a timed-out job; none for a hold or a backup.
export async function openHealth(query: Query): Promise<BoxHealthRow[]> {
  const rows = await query<{ id: CardId; case_key: string; created_at: Date }>(
    `select c.id, c.case_key, c.created_at from ledger.cards c
     where c.kind = $1 and c.created_by = $2
       and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
     order by c.created_at, c.id`,
    [HEALTH_CARD, HEALTH_AUTHOR],
  );
  const open: BoxHealthRow[] = [];
  for (const row of rows) {
    const found = healthCaseOf(row.case_key);
    if (found === null) continue;
    const { kind, about } = found;
    let code: string | null = null;
    if (kind === "timed_out") code = "timed_out";
    if (kind === "silent") {
      const [rowKind, rowId] = about.split("/");
      const [state] = await query<{ code: string | null }>(
        "select code from ledger.coverage_states where row_kind = $1 and row_id = $2",
        [rowKind, rowId],
      );
      code = state?.code ?? null;
    }
    if (kind === "failure_streak") {
      const [last] = await query<{ code: string }>(
        // The check's newest red row; every other job's newest.
        "select code from ledger.job_runs where job = $1 and (job <> 'canary' or code <> all ($2)) order by started_at desc, id desc limit 1",
        [about === "backup" ? "restore_drill" : about, [...ENDED_WELL]],
      );
      code = last?.code ?? null;
    }
    open.push({ card: row.id, kind, about, code, at: stamp(row.created_at) });
  }
  return open;
}

// Which database this connection is on, read before anything is written to it.
export function currentDatabase(context: AdminContext): Promise<string> {
  return context.transaction(async (query) => {
    const [row] = await query<{ name: string }>("select current_database() as name");
    return row?.name ?? "";
  });
}

// What a restored copy holds, for `pi restore check`: whether it holds anything, and any evidence
// removed that is here all the same (invariant 10). Every row a source's item derives holds a foreign
// key to its evidence row, so a surviving page, contact or message shows as that row.
export function restoredFacts(context: AdminContext): Promise<{ messages: number; survivors: number }> {
  return context.transaction(async (query) => {
    const [row] = await query<{ messages: number; survivors: number }>(
      `select (select count(*) from knowledge.messages)::int as messages,
         (select count(*) from knowledge.removed_evidence r
            left join knowledge.erasures e on e.id = r.erasure_id
            cross join lateral unnest(r.evidence_ids) as x (id)
            where (e.id is null or e.lift_seq is null) and x.id in (select id from vault.evidence_items))::int as survivors`,
    );
    return row ?? { messages: 0, survivors: 0 };
  });
}

// Admin.openHealthCount (`pia health open`): how many box health cards wait.
export const openHealthCount = (context: AdminContext): Promise<number> =>
  context.transaction(async (query) => (await openHealth(query)).length);

// Admin.dreamDue (`pia health dream-due`): the owner's day, in the owner's zone once they set one (UTC's
// until then), and whether its sweep hour has come, as the daily sweep reads both, so the night's
// pass runs once a day of the owner's at that hour. The timer keeps the day whose pass last ended well.
export function dreamDue(context: AdminContext): Promise<{ due: boolean; day: string }> {
  const now = context.now();
  return context.transaction(async (query) => {
    const [setting] = await query<{ hour: number }>("select sweep_hour_utc as hour from policy.work_settings");
    const zone = await ownerZoneOf(query);
    return { due: hourIn(now, zone) >= (setting?.hour ?? 0), day: dayIn(now, zone) };
  });
}
