import type { Timestamp } from "@intelligence/contracts";
import {
  currentDefinition,
  type HypothesisId,
  PlannerStage,
  type RunId,
  RunTrial,
  STAGE_PROMPT_IDS,
} from "@intelligence/contracts/personal";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp, stampOrNull } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { lockRows } from "../../core/queue.ts";
import { plannerOf, trialOutputAt } from "../../core/run-plan.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { LESSON_IN_FORCE, latestRow } from "../../core/statements.ts";
import type { Tx } from "../../core/tx.ts";
import { OWNER_ACTIONS_FROM, ownerActionsBlock } from "../../work/dispatch-wakes.ts";
import { RUN_QUEUED, recordEvent } from "../record-event.ts";

// Trial runs: the owner runs one planner stage on a model and effort of their choice, to compare
// models for cost, speed and quality on the same inputs. A trial writes nothing to the board, so
// trials queued back to back see the same state.

// `promptVersion`: a lessons trial of a prompt version run_outcome does not name yet, which the CLI
// checks is registered; from OWNER_ACTIONS_FROM it is shown the owner's newest actions, as a
// lessons run would be once the version is switched on.
export type TrialRequest = {
  stage: PlannerStage;
  trial: RunTrial;
  idea?: HypothesisId;
  promptVersion?: string;
};

// One trial of `pi work trials`: counts, codes, times and money, no text.
export type TrialView = {
  id: RunId;
  stage: string;
  model: string;
  effort: string;
  at: Timestamp;
  outcome: string;
  code: string | null;
  durationMs: number | null;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
  costMicroUsd: number;
  firstTryValid: boolean;
};

const STAGE_OF: Readonly<Record<string, string>> = Object.fromEntries(
  PlannerStage.options.map((stage) => [STAGE_PROMPT_IDS[stage], stage]),
);

// A trial's steps summed. First try valid: it finished, and its last attempt's first answer passed,
// so no output check refused it and no answer was followed by another model call (a refused shape
// gets one more turn, which is not recorded as a step). A cut-off reply is not an answer.
export function trialSummary(
  outcome: string,
  steps: readonly {
    attempt: number;
    kind: string;
    code: string | null;
    cost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    ms: number | null;
  }[],
) {
  const calls = steps.filter((step) => step.kind === "model_call");
  const sum = (values: (number | null)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const last = Math.max(0, ...steps.map((step) => step.attempt));
  // A web step sits between a model call and the next; it is no answer.
  const own = steps.filter((step) => step.attempt === last && step.kind !== "web_search" && step.kind !== "web_fetch");
  const retried = own.some(
    (step, at) =>
      step.kind === "output_check" ||
      (step.kind === "model_call" && step.code !== "truncated" && own[at + 1]?.kind === "model_call"),
  );
  return {
    modelCalls: calls.length,
    toolCalls: steps.filter((step) => step.kind === "tool_call").length,
    inputTokens: sum(calls.map((step) => step.inputTokens)),
    outputTokens: sum(calls.map((step) => step.outputTokens)),
    modelMs: sum(calls.map((step) => step.ms)),
    costMicroUsd: sum(calls.map((step) => step.cost)),
    firstTryValid: outcome === "finished" && !retried,
  };
}

// A queued trial run, its `queued` event and, for translate, its idea as its basis, in one
// transaction. Its key is its own id, so it never meets a wake's.
export async function queueTrial(query: Query, request: TrialRequest, now: Date): Promise<RunId> {
  const { stage } = request;
  if (
    !RunTrial.safeParse(request.trial).success ||
    (stage === "translate") !== (request.idea !== undefined) ||
    (request.promptVersion !== undefined && (stage !== "lessons" || !/^[1-9][0-9]{0,2}$/.test(request.promptVersion)))
  ) {
    throw new AdminError("invalid_argument");
  }
  // Under `research_only` no ideas or translate run is made, a trial included.
  if ((await plannerOf(query)) === "research_only" && stage !== "lessons") throw new AdminError("research_only");
  const point = currentDefinition("run_outcome");
  const named = point.prompts?.find((one) => one.id === STAGE_PROMPT_IDS[stage]);
  if (named === undefined) throw new Error("run_outcome names no prompt for the stage");
  const prompt = { id: named.id, version: request.promptVersion ?? named.version };
  await lockRows(query, request.idea === undefined ? [] : [request.idea]);
  const [reasoner] = await query<{ compartments: string[] }>(
    "select compartments from policy.clients where kind = 'reasoner' and status = 'active'",
  );
  let compartments = ["own"];
  if (request.idea !== undefined) {
    const [idea] = await query<{ compartments: string[] }>(
      "select compartments from ledger.hypotheses where id = $1 and kind = 'idea' and tainted_at is null",
      [request.idea],
    );
    if (idea === undefined) throw new AdminError("not_found");
    compartments = idea.compartments;
  }
  // A lessons trial from OWNER_ACTIONS_FROM is shown the owner's newest `plan`-kind decisions
  // within the reasoner's clearance, whatever any run's cursor, and moves no cursor; its label the
  // union of what it reads, its block's and the lessons in force.
  let decisions: string[] | null = null;
  if (stage === "lessons" && Number(prompt.version) >= OWNER_ACTIONS_FROM) {
    const clearance = reasoner?.compartments ?? [];
    const block = await ownerActionsBlock(query, clearance, null);
    const lessons = await query<{ compartments: string[] }>(
      `select h.compartments from ledger.hypotheses h where ${LESSON_IN_FORCE} and h.compartments <@ $1::text[]`,
      [clearance],
    );
    decisions = block.decisions;
    compartments = [...new Set([...block.compartments, ...lessons.flatMap((row) => row.compartments)])].sort();
  }
  if (reasoner !== undefined && !compartments.every((one) => reasoner.compartments.includes(one)))
    throw new AdminError("not_found");
  const id = newId("run") as RunId;
  const at = stamp(now);
  await query(
    `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version,
       trial_model, trial_effort, decisions)
     values ($1, $1, $2, 'owner', ledger.label($3), 'owner_request', $4, $5, $6, $7, $8, $9, $10, $11::text[])`,
    [
      id,
      at,
      compartments,
      `trial:${id}`,
      point.id,
      point.version,
      prompt.id,
      prompt.version,
      request.trial.model,
      request.trial.effort,
      decisions,
    ],
  );
  await recordEvent(query, RUN_QUEUED, id, at, compartments);
  if (request.idea !== undefined) {
    const [basis] = await query<{ ok: boolean }>(
      "select ledger.add_basis('run', $1, $2, array['hypothesis'], array[$3], null) as ok",
      [id, compartments, request.idea],
    );
    if (basis?.ok !== true) throw new AdminError("not_found");
  }
  return id;
}

// The trials, newest first, of one stage or all, each summed from its steps. A trial of the predict
// stage, since removed, is left out.
export async function listTrials({ query }: Tx, stage?: PlannerStage): Promise<TrialView[]> {
  const runs = await query<{
    id: RunId;
    prompt_id: string;
    trial_model: string;
    trial_effort: string;
    created_at: Date;
    outcome: string;
    code: string | null;
    started: Date | null;
    ended: Date | null;
  }>(
    `select t.id, t.prompt_id, t.trial_model, t.trial_effort, t.created_at, e.event as outcome, e.code,
       (select min(r.at) from ledger.record_events r where r.row_kind = 'run' and r.row_id = t.id and r.event = 'running') as started,
       (select max(r.at) from ledger.record_events r where r.row_kind = 'run' and r.row_id = t.id and r.event in ('finished', 'failed', 'stopped')) as ended
     from ledger.runs t
     join lateral (${latestRow("r.event, r.code", "run", "t.id")}) e on true
     where t.trial_model is not null and t.prompt_id <> 'personal_predict' and ($1::text is null or t.prompt_id = $1)
     order by t.created_at desc, t.id collate "C" desc`,
    [stage === undefined ? null : STAGE_PROMPT_IDS[stage]],
  );
  const ids = runs.map((run) => run.id);
  const steps = await query<{
    run_id: string;
    attempt: number;
    kind: string;
    code: string | null;
    cost: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    ms: number | null;
  }>(
    "select run_id, attempt, kind, code, cost_microusd::text as cost, input_tokens, output_tokens, ms from ledger.run_steps where run_id = any($1) order by run_id, attempt, ordinal",
    [ids],
  );
  return runs.map((run) => {
    const own = steps.filter((step) => step.run_id === run.id);
    const summed = trialSummary(
      run.outcome,
      own.map((step) => ({
        attempt: step.attempt,
        kind: step.kind,
        code: step.code,
        cost: step.cost === null ? null : Number(step.cost),
        inputTokens: step.input_tokens,
        outputTokens: step.output_tokens,
        ms: step.ms,
      })),
    );
    return {
      id: run.id,
      stage: STAGE_OF[run.prompt_id] ?? run.prompt_id,
      model: run.trial_model,
      effort: run.trial_effort,
      at: stamp(run.created_at),
      outcome: run.outcome,
      code: run.code,
      durationMs: run.started === null || run.ended === null ? null : run.ended.getTime() - run.started.getTime(),
      ...summed,
    };
  });
}

// A trial's stored output, opened, or null for a run that is no trial, has none, or lost it to an
// erasure.
async function openOutput({ query, keys }: Tx, run: string): Promise<unknown> {
  const [row] = await query<{ compartments: string[]; body_enc: Sealed }>(
    "select compartments, body_enc from ledger.record_events where row_kind = 'run' and row_id = $1 and event = 'finished' and body_enc is not null order by id desc limit 1",
    [run],
  );
  const text =
    row === undefined
      ? null
      : open(keys, { ...row, id: trialOutputAt(run).id }, "ledger.record_events.body_enc", "withheld");
  return text === null ? null : (JSON.parse(text) as unknown);
}

// `pi work trial-show RUN`: the trial's model, effort, outcome and stored output. Null for a run
// that is no trial.
export async function showTrial({ query, keys }: Tx, run: string): Promise<Record<string, unknown> | null> {
  const [row] = await query<{ prompt_id: string; trial_model: string; trial_effort: string; ended: Date | null }>(
    `select t.prompt_id, t.trial_model, t.trial_effort,
       (select max(r.at) from ledger.record_events r where r.row_kind = 'run' and r.row_id = t.id and r.event in ('finished', 'failed', 'stopped')) as ended
     from ledger.runs t where t.id = $1 and t.trial_model is not null`,
    [run],
  );
  if (row === undefined) return null;
  return {
    id: run,
    stage: STAGE_OF[row.prompt_id] ?? row.prompt_id,
    model: row.trial_model,
    effort: row.trial_effort,
    endedAt: stampOrNull(row.ended),
    output: await openOutput({ query, keys }, run),
  };
}
