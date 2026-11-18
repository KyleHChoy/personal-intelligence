import {
  ideaAbout,
  type OpportunityKind,
  type ReasoningAction,
  type RunOutcome,
  type RunOutput,
  STAGE_PROMPT_IDS,
} from "@intelligence/contracts/personal";
import { lessonKey, mergeLessons } from "../cards/asked-less.ts";
import { newId } from "../core/ids.ts";
import { trialOutputAt } from "../core/run-plan.ts";
import { latestRow } from "../core/statements.ts";
import {
  aboutColumns,
  answered,
  type Done,
  pinnedAt,
  refIds,
  refKinds,
  refused,
  sealSummary,
  type WorkCall,
} from "../core/work-refs.ts";
import { servedOrNull } from "../read/read-ctx.ts";
import { buildExpectations, expectationsOf } from "./work-expects.ts";
import { ATTEMPT_SQL, actionsLabel, RUN_SQL, type RunRow } from "./work-runs.ts";

// The run tool finish_run: a run's output turned into the sealed actions ledger.finish_run
// records (actions, ideas or lessons, or a trial's whole output), and the default
// expectations of each opportunity it proposed.

const SQL = {
  finishRun:
    "select recorded, outcome from ledger.finish_run($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text, $8::jsonb)",
  attempt: ATTEMPT_SQL,
  setExpectations: "select ledger.set_expectations($1::text, $2::text, $3::jsonb) as written",
  run: RUN_SQL,
  // The lessons that stand: waiting for a card, asked, or in force.
  standingLessons: `select h.id, h.compartments, h.body_enc, h.applies_kinds, h.applies_roles, h.supersedes from ledger.hypotheses h
     where h.kind = 'lesson' and h.tainted_at is null and (${latestRow("r.event", "hypothesis", "h.id")}) in ('open', 'asked', 'confirmed')`,
} as const;

// One outside the label, or that does not open, is not compared: what the run may not read changes
// nothing it writes (invariant 6).
async function standingLessons(call: WorkCall, label: readonly string[]): Promise<Set<string>> {
  const rows = await call.ctx.run<{
    id: string;
    compartments: string[];
    body_enc: unknown;
    applies_kinds: string[] | null;
    applies_roles: string[] | null;
    supersedes: string | null;
  }>(SQL.standingLessons, []);
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.compartments.every((one) => label.includes(one))) continue;
    let words: string | null = null;
    try {
      words =
        servedOrNull(
          call.ctx.keys,
          row.compartments,
          { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
          row.body_enc,
        )?.untrusted ?? null;
    } catch {
      words = null;
    }
    if (words !== null)
      keys.add(lessonKey({ words, kinds: row.applies_kinds, roles: row.applies_roles, supersedes: row.supersedes }));
  }
  return keys;
}

// The envelope as a JSON object, as every `_enc` column holds it: the actions go to finish_run as
// one JSON array, where a sealed string would be stored as a JSON string and fail the body checks.
type Sealer = (table: string, id: string, text: string) => unknown;

// An ideas or lessons run's output as finish_run's actions: each idea a
// hypothesis of kind idea about what code says it is about, its parts sealed as one summary; each
// lesson one of kind lesson about the owner. None is a silence.
function plannerActions(output: Exclude<RunOutput, { actions: unknown }>, seal: Sealer): Record<string, unknown>[] {
  const items =
    "ideas" in output
      ? output.ideas.map((idea) => {
          const about = ideaAbout(idea.basis);
          const [aboutKind, aboutId] = about === null ? ["owner", null] : aboutColumns(about);
          const text = `${idea.idea}\nwhy: ${idea.why}\ntest: ${idea.test}\nconfidence: ${idea.confidence}`;
          return { do: "idea", about_kind: aboutKind, about_id: aboutId, basis: idea.basis, text };
        })
      : output.lessons.map((lesson) => ({
          do: "lesson",
          about_kind: "owner",
          about_id: null,
          basis: lesson.basis,
          text: lesson.lesson,
          ...(lesson.appliesTo === undefined
            ? {}
            : { applies_kinds: lesson.appliesTo.kinds, applies_roles: lesson.appliesTo.roles }),
          ...(lesson.supersedes === undefined ? {} : { supersedes: lesson.supersedes }),
        }));
  if (items.length === 0) return [{ do: "ignore", reason: "nothing_to_do" }];
  return items.map(({ basis, text, ...rest }) => {
    const id = newId("hyp");
    return {
      ...rest,
      id,
      ref_kinds: refKinds(basis),
      ref_ids: refIds(basis),
      body_enc: seal("ledger.hypotheses", id, text),
    };
  });
}

// One action as the keys finish_run reads, and nothing else: ids made here, summaries sealed
// for the attempt's compartments and bound to the row each goes on.
function actionOf(action: ReasoningAction, seal: Sealer): Record<string, unknown> {
  if (action.do === "ignore") return { do: "ignore", reason: action.reason };
  const [aboutKind, aboutId] = aboutColumns(action.about);
  const common = {
    do: action.do,
    about_kind: aboutKind,
    about_id: aboutId,
    ref_kinds: refKinds(action.basis),
    ref_ids: refIds(action.basis),
  };
  if (action.do === "remind") {
    const id = newId("itn");
    return { ...common, id, due_at: action.dueAt, body_enc: seal("ledger.intentions", id, action.summary) };
  }
  if (action.do === "investigate") {
    const id = newId("hyp");
    // The investigate opportunity that rests on it, unless it is about the owner.
    const opportunity =
      action.about.kind === "owner"
        ? {}
        : (() => {
            const opportunityId = newId("opp");
            return {
              opportunity_id: opportunityId,
              opportunity_body_enc: seal("ledger.opportunities", opportunityId, action.summary),
            };
          })();
    return {
      ...common,
      id,
      kind: action.kind,
      body_enc: seal("ledger.hypotheses", id, action.summary),
      ...opportunity,
    };
  }
  const id = newId("opp");
  return {
    ...common,
    id,
    kind: action.kind,
    body_enc: seal("ledger.opportunities", id, action.summary),
    due_at: action.dueAt ?? null,
    // The investigate action it follows from, by its place in the output (1 first): finish_run sets
    // the opportunity's hypothesis from it.
    hypothesis_ord: action.hypothesis === undefined ? null : action.hypothesis + 1,
    probability: action.forecast?.probability ?? null,
    probability_if_waiting: action.forecast?.probabilityIfWaiting ?? null,
  };
}

// A trial's output is of its stage's form: a translate run's is actions.
const trialFits = (promptId: string, output: RunOutput): boolean =>
  promptId === STAGE_PROMPT_IDS.ideas
    ? "ideas" in output
    : promptId === STAGE_PROMPT_IDS.lessons
      ? "lessons" in output
      : "actions" in output;

export async function finishRun(
  call: WorkCall,
  args: {
    run: string;
    outcome: "finished" | "failed";
    code?: string | undefined;
    output?: RunOutput | undefined;
    requestId: string;
  },
): Promise<Done<{ recorded: number; outcome: RunOutcome }>> {
  // A finished run says what it found; a failed one says why, and nothing it says is recorded.
  if (args.outcome === "finished" && args.output === undefined) return refused("invalid_request");
  const [attempt] = await call.ctx.run<{ compartments: string[] }>(SQL.attempt, [args.run]);
  if (attempt === undefined) return refused("not_found");
  const { output } = args;
  // The run's own definition, as it was queued (one_pass runs are run_outcome@3): its call row
  // names the definition the run was made under, never the newest.
  const [run] = await call.ctx.run<RunRow>(SQL.run, [args.run]);
  if (run === undefined) return refused("not_found");
  // A lessons run shown the owner's actions seals its lessons under its row's
  // label, as finish_run writes them; a trial's output stays under the attempt's.
  const label = run.trial_model === null ? (actionsLabel(run) ?? attempt.compartments) : attempt.compartments;
  const seal: Sealer = (table, id, text) =>
    JSON.parse(sealSummary(call.ctx, label, { table, id, column: "body_enc" }, text));
  // A trial run: its output, of its stage's form, sealed whole as the body of its
  // `finished` event, and nothing else.
  if (run.trial_model !== null && output !== undefined && !trialFits(run.prompt_id, output))
    return refused("invalid_request");
  // A lessons run's exact duplicates are merged before anything is written: a lesson that already
  // stands is not written again, and one stated twice is written once.
  const merged =
    args.outcome === "finished" && output !== undefined && run.trial_model === null && "lessons" in output
      ? { lessons: mergeLessons(output.lessons, await standingLessons(call, label)) }
      : output;
  const list =
    args.outcome !== "finished" || merged === undefined
      ? null
      : run.trial_model !== null
        ? [
            {
              do: "trial",
              body_enc: JSON.parse(
                sealSummary(call.ctx, attempt.compartments, trialOutputAt(args.run), JSON.stringify(merged)),
              ),
            },
          ]
        : "actions" in merged
          ? merged.actions.map((action) => actionOf(action, seal))
          : plannerActions(merged, seal);
  const actions = list === null ? null : JSON.stringify(list);
  const point = pinnedAt("run_outcome", run.definition_version);
  const rows = await call.fn<{ recorded: number; outcome: RunOutcome }>(SQL.finishRun, [
    args.run,
    args.requestId,
    await call.session(),
    args.outcome,
    args.code ?? null,
    point.version,
    point.hash,
    actions,
  ]);
  if (typeof rows === "string") return refused(rows);
  const [row] = rows;
  // A ref that does not resolve under the attempt's clearance, a run the caller does not hold: no
  // row, and the run stays as it was.
  if (row === undefined) return refused("not_found");
  if (row.outcome === "finished" && list !== null) {
    const expected = await expectRun(call, attempt.compartments, list);
    if (expected !== null) return expected;
  }
  return answered({ recorded: row.recorded, outcome: row.outcome });
}

// Each opportunity a run proposed gets its kind's default expectations, in finish_run's
// transaction, sealed under the attempt's clearance, the opportunity's label. A run states none.
// ledger.set_expectations attaches only to a row this finish_run wrote: a merge into an open row,
// or a repeat, attaches nothing. Null, or a refusal of the call.
async function expectRun(
  call: WorkCall,
  clearance: readonly string[],
  list: readonly Record<string, unknown>[],
): Promise<Done<never> | null> {
  for (const action of list) {
    if (action.do !== "propose") continue;
    const id = action.id as string;
    const built = await buildExpectations(
      call.ctx,
      clearance,
      id,
      expectationsOf(action.kind as OpportunityKind, undefined),
    );
    if (typeof built === "string") return refused(built);
    if (built.length === 0) continue;
    const rows = await call.fn<{ written: number }>(SQL.setExpectations, [
      id,
      await call.session(),
      JSON.stringify(built),
    ]);
    if (typeof rows === "string") return refused(rows);
  }
  return null;
}
