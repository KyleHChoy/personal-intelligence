import type { Timestamp } from "@intelligence/contracts";
import { OUTCOME_TASKS, OUTCOME_TEST_LIMITS } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { type Query, stamp } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { GAP_FLOOR, GAP_MIN_TASKS } from "./improvement-filing.ts";

// The outcome test's numbers, as pi_admin: each run's score by task, its trend, and visible against
// held out. Scores and ids alone: an answer, its scoring and a held-out question stay sealed, and a
// held-out task appears only inside its mean, never by id.

const RUNS_SHOWN = 8;
// How much of a run must have scored for it to read as a run. A reply the judge would not form twice
// costs that task its score, not the week its reading.
const SCORED_ENOUGH = 0.75;

const RUNS = `
  select r.id, r.created_at, r.suite, r.expected_tasks, r.answer_model, r.judge_model,
    coalesce(sum(t.cost_microusd), 0)::bigint::text as cost,
    count(t.id)::int as tasks
  from ledger.outcome_test_runs r left join ledger.outcome_test_tasks t on t.run_id = r.id
  group by r.id order by r.created_at desc, r.id collate "C" desc limit $1`;
const TASKS = `
  select t.run_id, t.task, t.held_out, t.score, t.code_cap
  from ledger.outcome_test_tasks t where t.run_id = any ($1::text[])`;

type TaskRow = { run_id: string; task: string; held_out: boolean; score: number | null; code_cap: number };

export type OutcomeTestView = {
  limits: string;
  runs: {
    run: string;
    at: Timestamp;
    suite: string;
    answerModel: string;
    judgeModel: string;
    costMicroUsd: number;
    // Every task recorded and most scored: a run a budget or an outage cut short shows as incomplete.
    complete: boolean;
    visible: { score: number; max: number };
    heldOut: { mean: number | null; count: number };
  }[];
  // Oldest first: one entry per run shown, null where the run has no score for it.
  tasks: { task: string; trend: (number | null)[]; latest: number | null; codeCap: number | null }[];
  // When the newest complete run was taken, which is when what it says was measured.
  measuredAt: Timestamp | null;
  gap: { visibleMean: number; heldOutMean: number; gap: number; flagged: boolean } | null;
  latest: ReadonlyMap<string, number>;
  before: ReadonlyMap<string, number>;
  comparison: {
    visibleMean: number;
    heldOutMean: number;
    visibleCount: number;
    heldOutCount: number;
    heldOutDropped: boolean;
  } | null;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
// Complete runs' means, newest first; a run with no held-out mean breaks it.
export function heldOutFellTwice(means: readonly (number | null)[]): boolean {
  const [newest, previous, before] = means;
  return (
    newest !== undefined &&
    previous !== undefined &&
    before !== undefined &&
    newest !== null &&
    previous !== null &&
    before !== null &&
    newest < previous &&
    previous < before
  );
}
const scored = (rows: readonly TaskRow[]): number[] => rows.flatMap((row) => (row.score === null ? [] : [row.score]));

export async function outcomeTestView(query: Query): Promise<OutcomeTestView> {
  const runs = await query<{
    id: string;
    created_at: Date;
    suite: string;
    expected_tasks: number;
    answer_model: string;
    judge_model: string;
    cost: string;
    tasks: number;
  }>(RUNS, [RUNS_SHOWN]);
  const rows = await query<TaskRow>(TASKS, [runs.map((run) => run.id)]);
  const ofRun = (id: string): TaskRow[] => rows.filter((row) => row.run_id === id);
  const view = runs.map((run) => {
    const all = ofRun(run.id);
    const visible = all.filter((row) => !row.held_out);
    const held = all.filter((row) => row.held_out);
    return {
      run: run.id,
      at: stamp(run.created_at),
      suite: run.suite,
      answerModel: run.answer_model,
      judgeModel: run.judge_model,
      costMicroUsd: Number(run.cost),
      complete: all.length >= run.expected_tasks && scored(all).length >= run.expected_tasks * SCORED_ENOUGH,
      // Out of what was scored: a null is no answer of the judge's, and no zero of the system's.
      visible: { score: scored(visible).reduce((sum, score) => sum + score, 0), max: scored(visible).length * 3 },
      heldOut: { mean: mean(scored(held)), count: scored(held).length },
    };
  });
  const oldestFirst = [...runs].reverse();
  const tasks = OUTCOME_TASKS.map(({ id }) => {
    const trend = oldestFirst.map((run) => ofRun(run.id).find((row) => row.task === id)?.score ?? null);
    const newest = runs[0];
    const row = newest === undefined ? undefined : ofRun(newest.id).find((one) => one.task === id);
    return { task: id, trend, latest: row?.score ?? null, codeCap: row?.code_cap ?? null };
  });
  // Drops and the gap read complete runs alone: a run cut short says nothing of what it never asked.
  const complete = view.filter((run) => run.complete);
  const [newest, previous] = complete;
  const scoresOf = (run: { run: string } | undefined): Map<string, number> =>
    new Map(
      run === undefined
        ? []
        : ofRun(run.run).flatMap((row) => (row.held_out || row.score === null ? [] : [[row.task, row.score] as const])),
    );
  const visibleOfNewest = newest === undefined ? [] : scored(ofRun(newest.run).filter((row) => !row.held_out));
  const visibleMean = mean(visibleOfNewest);
  const heldMean = newest?.heldOut.mean ?? null;
  const comparison =
    visibleMean === null || heldMean === null || newest === undefined
      ? null
      : {
          visibleMean,
          heldOutMean: heldMean,
          visibleCount: visibleOfNewest.length,
          heldOutCount: newest.heldOut.count,
          heldOutDropped: heldOutFellTwice(complete.map((run) => run.heldOut.mean)),
        };
  return {
    limits: OUTCOME_TEST_LIMITS,
    runs: view,
    tasks,
    measuredAt: newest?.at ?? null,
    gap:
      comparison === null
        ? null
        : {
            visibleMean: comparison.visibleMean,
            heldOutMean: comparison.heldOutMean,
            gap: comparison.visibleMean - comparison.heldOutMean,
            flagged:
              comparison.visibleMean - comparison.heldOutMean >= GAP_FLOOR &&
              comparison.visibleCount >= GAP_MIN_TASKS &&
              comparison.heldOutCount >= GAP_MIN_TASKS,
          },
    latest: scoresOf(newest),
    before: scoresOf(previous),
    comparison,
  };
}

// What `pia outcomes` shows of it: scores by task and their trend, visible against held out, and what
// such a score can and cannot show. None until it first runs.
export type OutcomeTestsShown = Pick<OutcomeTestView, "limits" | "runs" | "tasks" | "gap" | "measuredAt">;
// The newest complete run's share of what it could score, visible and held out together.
function outcomeTestMetric(tests: OutcomeTestView, now: Date): OutcomeMetric {
  const newest = tests.runs.find((run) => run.complete);
  const heldScore = (newest?.heldOut.mean ?? 0) * (newest?.heldOut.count ?? 0);
  const max = (newest?.visible.max ?? 0) + (newest?.heldOut.count ?? 0) * 3;
  return outcomeMetric("outcome_test_score", {
    value: shareOf((newest?.visible.score ?? 0) + heldScore, max),
    sample: max / 3,
    window: null,
    // How old the reading is, so a run from weeks ago is not read as this week's.
    ...(newest === undefined
      ? { code: "not_run" }
      : { parts: { age_days: Math.floor((now.getTime() - Date.parse(newest.at)) / DAY_MS) } }),
  });
}

export async function outcomeTestsRead(
  query: Query,
  now: Date,
): Promise<{ metric: OutcomeMetric; shown: OutcomeTestsShown }> {
  const tests = await outcomeTestView(query);
  const { limits, runs, tasks, gap, measuredAt } = tests;
  return { metric: outcomeTestMetric(tests, now), shown: { limits, runs, tasks, gap, measuredAt } };
}
