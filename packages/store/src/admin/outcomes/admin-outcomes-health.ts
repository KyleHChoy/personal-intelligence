import type { Timestamp } from "@intelligence/contracts";
import { DAY_MS } from "@intelligence/personal-core";
import { type Query, stamp } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { heldByExpiredCard } from "../work/admin-work-report.ts";

// The outcomes that say how the box itself stands: code closing what it raised, the dump, its restore
// test, and whether a health card told anyone. `pi outcomes` reads them with the rest.

export type Clock = { now: Date; within: string[]; ago: (days: number) => Timestamp };

// Rung 0's decisions on gap flags in the window: decided_by policy, never the owner's. Agents' own
// proposals are left out, so this reads what the tick raised and then closed. A `vetoed` one is
// decided but not code's no: the veto is the owner's. A withheld raise writes nothing to count, so
// `held_by_expired_card` gives the lasting ones: what keeps gaps off the board with no row at all.
const CODE_DECISIONS = `
  select count(*)::int as decided, d.decision, d.reason
  from ledger.opportunity_decisions d join ledger.opportunities o on o.id = d.opportunity_id and o.gap_trigger is not null
  where d.decided_by = 'policy' and d.created_at >= $1 and d.created_at <= $2 and d.compartments <@ $3::text[]
  group by d.decision, d.reason`;
// How many cases those no_gos were on, and how long since the last: one case and thousands of rows is
// a loop, however many days it reads `low` for after it stopped. Over the same rows as the parts.
const CODE_NO_GO_SPREAD = `
  select count(distinct o.case_id)::int as cases, max(d.created_at) as last_at
  from ledger.opportunity_decisions d join ledger.opportunities o on o.id = d.opportunity_id and o.gap_trigger is not null
  where d.decided_by = 'policy' and d.decision = 'no_go' and d.reason <> 'vetoed'
    and d.created_at >= $1 and d.created_at <= $2 and d.compartments <@ $3::text[]`;

// A reason as `parts` says it. Rung 0's `owner_declined` is code closing a row because the owner's
// earlier no stands on its case: it counts no new answer, and each row of a loop repeats the one.
const NO_GO_PART: Readonly<Record<string, string>> = { owner_declined: "case_closed_by_owner" };

export async function codeNoGos(query: Query, days: number, { now, within, ago }: Clock): Promise<OutcomeMetric> {
  const rows = await query<{ decided: number; decision: string; reason: string }>(CODE_DECISIONS, [
    ago(days),
    stamp(now),
    within,
  ]);
  const noGos = rows.filter((row) => row.decision === "no_go" && row.reason !== "vetoed");
  const [spread] = await query<{ cases: number; last_at: Date | null }>(CODE_NO_GO_SPREAD, [
    ago(days),
    stamp(now),
    within,
  ]);
  return outcomeMetric("code_no_go_per_day", {
    value: noGos.reduce((sum, row) => sum + row.decided, 0) / days,
    sample: rows.reduce((sum, row) => sum + row.decided, 0),
    window: { fromDaysAgo: days, toDaysAgo: 0 },
    parts: {
      ...Object.fromEntries(noGos.map((row) => [NO_GO_PART[row.reason] ?? row.reason, row.decided])),
      held_by_expired_card: (await heldByExpiredCard(query, within)).length,
      cases: spread?.cases ?? 0,
      ...(spread?.last_at == null ? {} : { days_since_last: (now.getTime() - spread.last_at.getTime()) / DAY_MS }),
    },
  });
}

// `ownerParts`, the owner's report alone: an erasure holds no label and may be of anything, so what
// it says is never stored with the reading agents are served. `erased_since_dump`: 1 when an erasure is newer than the last dump, the other reason a dump
// falls due (the `backup_due` card about `erasure`), with the days since that erasure: a dump inside
// its line may still be owed.
export async function backupAge(query: Query, { now }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<{ at: Date | null; erased: Date | null }>(
    `select max(ended_at) as at,
       (select max(e.erased_at) from knowledge.erasures e where e.erased_at <= $1) as erased
     from ledger.job_runs where job = 'backup' and code = 'ok' and ended_at <= $1`,
    [stamp(now)],
  );
  if (row === undefined || row.at === null)
    return outcomeMetric("backup_age_days", { value: null, sample: 0, window: null, code: "no_backup_recorded" });
  const owed = row.erased !== null && row.erased > row.at;
  return outcomeMetric("backup_age_days", {
    value: (now.getTime() - row.at.getTime()) / DAY_MS,
    sample: 1,
    window: null,
    ownerParts: {
      erased_since_dump: owed ? 1 : 0,
      ...(owed && row.erased !== null ? { days_since_erasure: (now.getTime() - row.erased.getTime()) / DAY_MS } : {}),
    },
  });
}

// The newest restore drill that passed (`pi restore check`, job `restore_drill`): a dump nobody
// restored is a hope. When the newest of all failed, no earlier pass says it is well.
async function latestRestore(query: Query, now: Date) {
  const [row] = await query<{ passed: Date | null; failed: Date | null }>(
    `select max(ended_at) filter (where code = 'ok') as passed,
       max(ended_at) filter (where code = 'failed') as failed
     from ledger.job_runs where job = 'restore_drill' and ended_at <= $1`,
    [stamp(now)],
  );
  return { passed: row?.passed ?? null, failed: row?.failed ?? null };
}

export async function restoreAge(query: Query, { now }: Clock): Promise<OutcomeMetric> {
  const { passed, failed } = await latestRestore(query, now);
  if (failed !== null && (passed === null || failed > passed))
    return outcomeMetric("restore_test_age_days", { value: null, sample: 0, window: null, code: "last_test_failed" });
  if (passed === null)
    return outcomeMetric("restore_test_age_days", { value: null, sample: 0, window: null, code: "no_restore_test" });
  return outcomeMetric("restore_test_age_days", {
    value: (now.getTime() - passed.getTime()) / DAY_MS,
    sample: 1,
    window: null,
  });
}

// Of the box health cards raised in the window, how many told anyone: a notice to an agent with an
// address, cleared for the card. A card that told no one waits in the queue until the owner looks.
const HEALTH_TOLD = `
  select count(*)::int as raised,
    count(*) filter (where exists (select 1 from ledger.health_notices n where n.card_id = c.id))::int as told
  from ledger.cards c
  where c.kind = 'box_health' and c.created_at >= $1 and c.created_at <= $2`;
export async function healthTold(query: Query, days: number, { now, ago }: Clock): Promise<OutcomeMetric> {
  const [row] = await query<{ raised: number; told: number }>(HEALTH_TOLD, [ago(days), stamp(now)]);
  const raised = row?.raised ?? 0;
  return outcomeMetric("box_health_told", {
    value: shareOf(row?.told ?? 0, raised),
    sample: raised,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
  });
}
