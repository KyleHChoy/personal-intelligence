import {
  type IntentionId,
  type IntentionKind,
  OPEN_STATUSES,
  type OpportunityId,
  PlannerStage,
  RunRequest,
  type RunStep,
  type RunTrial,
  STAGE_PROMPT_IDS,
} from "@intelligence/contracts/personal";
import { byText, stamp } from "../core/db.ts";
import { latestEvent } from "../core/statements.ts";
import { answered, type Done, goalIds, refused, sealSummary, storedRef, type WorkCall } from "../core/work-refs.ts";
import { bySoonest, opportunityViews } from "../core/work-views.ts";
import { Unavailable } from "../read/read-ctx.ts";
import { computedGoals, requestGoals } from "../read/read-goal-beliefs.ts";
import { selfBrief } from "./run-self.ts";
import { type Anchor, CITED_SQL, closedCases } from "./work-cases.ts";
import { plannerParts } from "./work-run-planner.ts";

// The reasoner's three run tools, through the same call path as every other tool. The run request
// is built under the token, whose clearance is the attempt's, from what the reader's policies
// return; nothing of an earlier attempt is in it.

const OPEN_LIMIT = 50;

export const ATTEMPT_SQL =
  "select attempt, compartments from ledger.run_attempts where run_id = $1 order by attempt desc limit 1";
export const RUN_SQL =
  "select id, compartments, wake_source, decision_point, definition_version, prompt_id, prompt_version, lessons, decisions, trial_model, trial_effort from ledger.runs where id = $1";

const SQL = {
  nextRun: `select run_id, attempt, compartments, max_turns, max_tool_calls, max_output_tokens, max_input_code_points, ceiling_microusd_per_token
            from ledger.next_run($1::text, $2::text)`,
  appendStep:
    "select ledger.append_step($1::text, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::bigint, $12::integer, $13::integer, $14::integer, $15::integer, $16::jsonb) as go",
  attempt: ATTEMPT_SQL,
  run: RUN_SQL,
  anchors:
    "select b.ref_kind, b.ref_id, b.evidence_id from ledger.basis b where b.row_kind = 'run' and b.row_id = $1 order by b.id",
  open: `
    select o.id from ledger.opportunities o
    where o.tainted_at is null
      and (${latestEvent("opportunity", "o.id")}) = any($1)
    order by o.id`,
  intentions: `
    select i.id, i.kind, i.due_at, i.opportunity_id from ledger.intentions i
    where i.tainted_at is null
      and (${latestEvent("intention", "i.id")}) = 'set'
    order by i.due_at, i.id`,
  cited: CITED_SQL,
} as const;

type Taken = {
  run_id: string;
  attempt: number;
  compartments: string[];
  max_turns: number;
  max_tool_calls: number;
  max_output_tokens: number;
  max_input_code_points: number;
  ceiling_microusd_per_token: number;
};

export type RunRow = {
  id: string;
  compartments: string[];
  wake_source: string;
  decision_point: string;
  definition_version: number;
  prompt_id: string;
  prompt_version: string;
  lessons: string[] | null;
  decisions: string[] | null;
  trial_model: string | null;
  trial_effort: RunTrial["effort"] | null;
};

// A lessons run whose row names the owner's decisions reads and writes under its row's label; null
// for every other run.
export const actionsLabel = (run: Pick<RunRow, "prompt_id" | "decisions" | "compartments">): string[] | null =>
  run.prompt_id === STAGE_PROMPT_IDS.lessons && run.decisions !== null ? run.compartments : null;

// next_run's first transaction: the take alone, committed before the brief is read. A take leaves
// its call and read rows to the brief's transaction, so a run taken is one of each.
export async function takeRun(call: WorkCall, args: { requestId: string }): Promise<Done<{ run: null }>> {
  const taken = await call.fn<Taken>(SQL.nextRun, [args.requestId, await call.session()]);
  if (typeof taken === "string") return refused(taken);
  return taken.length === 0 ? answered({ run: null }) : { ...answered({ run: null }), unlogged: true };
}

export async function nextRun(
  call: WorkCall,
  args: { requestId: string },
  now: Date,
): Promise<Done<{ run: RunRequest | null }>> {
  const taken = await call.fn<Taken>(SQL.nextRun, [args.requestId, await call.session()]);
  if (typeof taken === "string") return refused(taken);
  const [take] = taken;
  if (take === undefined) return answered({ run: null });
  const { ctx } = call;

  const [run] = await ctx.run<RunRow>(SQL.run, [take.run_id]);
  if (run === undefined) throw new Unavailable();
  // A trial run names its model and effort.
  const trial =
    run.trial_model === null || run.trial_effort === null ? null : { model: run.trial_model, effort: run.trial_effort };
  const anchors = await ctx.run<Anchor>(SQL.anchors, [take.run_id]);
  // The active goals the owner set, computed as beliefs, a stale one marked (stale is a mark, never an
  // exit); a goal the owner only stated has no goal id a run can
  // name, and is left out.
  const goals = requestGoals(await computedGoals(ctx, call.client.compartments, now.toISOString(), { setOnly: true }));
  const ids = (await ctx.run<{ id: string }>(SQL.open, [[...OPEN_STATUSES]])).map((row) => row.id);
  const open = [...(await opportunityViews(ctx, ids)).values()]
    .sort((a, b) => bySoonest(a.view, b.view))
    .slice(0, OPEN_LIMIT);
  // Invariant 4: a lessons run shown the owner's actions reads only within its
  // row's label, the union the tick computed, which its lessons take.
  const within = actionsLabel(run);
  const { cases: closed, rows: closedRows } = await closedCases(call, anchors, now, within);
  const intentionRows = await ctx.run<{ id: string; kind: IntentionKind; due_at: Date; opportunity_id: string | null }>(
    SQL.intentions,
    [],
  );
  const planner = await plannerParts(call, { promptId: run.prompt_id, promptVersion: run.prompt_version }, anchors, {
    id: run.id,
    lessons: run.lessons,
    within,
  });
  // A planner stage that reads the owner's world is given the owner's brief, for a client
  // with the self view: lessons reads cases alone, and personal_run is as it was.
  const stage = PlannerStage.options.find((one) => STAGE_PROMPT_IDS[one] === run.prompt_id);
  const brief =
    stage !== undefined && stage !== "lessons" && call.client.views.includes("self")
      ? await selfBrief(call, now)
      : null;
  const intentions = intentionRows.map((row) => ({
    id: row.id as IntentionId,
    kind: row.kind,
    dueAt: stamp(row.due_at),
    opportunity: row.opportunity_id as OpportunityId | null,
  }));

  const request = RunRequest.safeParse({
    id: take.run_id,
    attempt: take.attempt,
    source: run.wake_source,
    anchors: anchors.map((one) => storedRef(one.ref_kind, one.ref_id)),
    goals,
    open: open.map(({ view }) => view),
    closed,
    intentions,
    point: {
      id: run.decision_point,
      version: Number(run.definition_version),
      promptId: run.prompt_id,
      promptVersion: run.prompt_version,
    },
    ...planner.parts,
    ...(trial === null ? {} : { trial }),
    ...(brief === null ? {} : { self: brief.self }),
    limits: {
      maxTurns: take.max_turns,
      maxToolCalls: take.max_tool_calls,
      maxOutputTokens: take.max_output_tokens,
      maxInputCodePoints: take.max_input_code_points,
      ceilingMicroUsdPerToken: take.ceiling_microusd_per_token,
    },
  });
  if (!request.success) throw new Unavailable();
  // The request is the reasoner's pack: it binds nothing, and shows the messages and events its
  // anchors and its open work cite, and what its closed cases and intentions cite through the
  // basis, so the read log's trigger records what the reasoner's vendor was given. The reader cuts
  // the list into rows of at most 1 000; `shown` binds nothing.
  const cases = [
    ...closedRows.map((row) => [row.row_kind, row.id] as const),
    ...intentionRows.map((row) => ["intention", row.id] as const),
    ...planner.cites,
  ];
  const cited = (
    await ctx.run<{ evidence_id: string }>(SQL.cited, [cases.map(([kind]) => kind), cases.map(([, id]) => id)])
  ).map((row) => row.evidence_id);
  const shown = [
    ...anchors.flatMap((one) =>
      one.evidence_id !== null && (one.ref_kind === "message" || one.ref_kind === "event") ? [one.evidence_id] : [],
    ),
    ...open.flatMap((one) => one.shown),
    ...cited,
    ...(brief?.shown ?? []),
  ];
  const returned = goalIds([
    ...request.data.goals.map((goal) => ({ kind: "goal", id: goal.id })),
    ...request.data.anchors,
    ...open.flatMap((one) => one.goals.map((id) => ({ kind: "goal", id }))),
    ...closed.map((one) => one.about),
    ...(request.data.idea === undefined || request.data.idea === null
      ? []
      : [request.data.idea.about, ...request.data.idea.basis]),
  ]);
  return answered({ run: request.data }, [...new Set(shown)].sort(byText), returned);
}

export async function appendStep(
  call: WorkCall,
  args: { run: string; ordinal: number; step: RunStep },
): Promise<Done<{ go: boolean }>> {
  const { step } = args;
  // A run the caller never took: its attempts are the only ones the reader's policy returns.
  const [attempt] = await call.ctx.run<{ attempt: number; compartments: string[] }>(SQL.attempt, [args.run]);
  if (attempt === undefined) return refused("not_found");
  // A step's plain columns: nothing it carries is sealed, and it carries no content, a model call
  // its token counts and time, a tool call the size of its result. A web search's query or a web
  // fetch's URL is the one text, sealed under the attempt's label, the label the step is stored
  // under, at the step's own place.
  const columns =
    step.kind === "model_call"
      ? [
          "model_call",
          null,
          null,
          step.code ?? null,
          step.promptId,
          step.promptVersion,
          step.modelId,
          step.costMicroUsd,
          step.inputTokens ?? null,
          step.outputTokens ?? null,
          step.ms ?? null,
          null,
          null,
        ]
      : step.kind === "tool_call"
        ? [
            "tool_call",
            step.status,
            step.tool,
            step.code ?? null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            step.resultCodePoints ?? null,
            null,
          ]
        : step.kind === "output_check"
          ? ["output_check", "refused", null, step.code, null, null, null, null, null, null, null, null, null]
          : [
              step.kind,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              sealSummary(
                call.ctx,
                attempt.compartments,
                webStepAt(args.run, attempt.attempt, args.ordinal),
                step.text,
              ),
            ];
  const rows = await call.fn<{ go: boolean | null }>(SQL.appendStep, [
    args.run,
    args.ordinal,
    await call.session(),
    ...columns,
  ]);
  if (typeof rows === "string") return refused(rows);
  return answered({ go: rows[0]?.go === true });
}

// Where a web step's text is sealed, by the step's natural key (its run, attempt
// and ordinal), since its row id is not known before the insert.
export const webStepAt = (run: string, attempt: number, ordinal: number) => ({
  table: "ledger.run_steps",
  id: `${run}/step_${attempt}_${ordinal}`,
  column: "detail_enc",
});
