// The run-failure streak that raises the owner's notice: three failed runs in a row.
import type { RunId } from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import { latestRow } from "../core/statements.ts";

type Ended = { id: RunId; event: string; code: string | null; at: Date };

// The last `most` runs to end, newest first. Trial runs are left out: they write nothing to the
// board. So are the predict runs of the shadow predictions, now removed, which ended under their own
// notices and never changed what the owner sees.
const lastEnded = (query: Query, most: number): Promise<Ended[]> =>
  query<Ended>(
    `select x.id, e.event, e.code, e.at from ledger.runs x
     join lateral (${latestRow("r.id as eid, r.event, r.code, r.at", "run", "x.id")}) e on true
     where e.event in ('finished', 'failed', 'stopped') and x.wake_source <> 'predict_due' and x.trial_model is null
     order by e.eid desc limit $1`,
    [most],
  );

// The latest of a streak, when none of its runs ended before the latest notice of `caseKey` was
// raised; else null.
async function afterNotice(query: Query, rows: Ended[], caseKey: string): Promise<RunId | null> {
  const [notice] = await query<{ at: Date | null }>(
    "select max(c.created_at) as at from ledger.cards c where c.case_key = $1",
    [caseKey],
  );
  const since = notice?.at ?? null;
  if (since !== null && rows.some((row) => row.at.getTime() <= since.getTime())) return null;
  return rows[0]?.id ?? null;
}

// The latest of the three runs that ended last, when all three ended `failed` after the latest
// `run_failures` notice was raised; else null.
export async function failedRunStreak(query: Query): Promise<RunId | null> {
  const rows = await lastEnded(query, 3);
  if (rows.length < 3 || rows.some((row) => row.event !== "failed")) return null;
  return afterNotice(query, rows, "run_failures");
}
