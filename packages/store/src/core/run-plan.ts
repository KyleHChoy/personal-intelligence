import {
  currentDefinition,
  type PersonalWakeSource,
  STAGE_PROMPT_IDS,
  stageOfWake,
} from "@intelligence/contracts/personal";
import type { Query } from "./db.ts";
import { latestEvent } from "./statements.ts";

// What the planner setting decides: which runs a wake queues, and under which prompt.

// The planner a wake's run is queued under (policy.work_settings.planner): `split`, the ideas,
// translate and lessons stages; `one_pass`, personal_run version 3, a way back without a deploy;
// or `research_only`, under which only lessons runs are queued: the system raises no idea and
// translates none into work, which is agents' to propose.
export type Planner = "split" | "one_pass" | "research_only";
const PLANNERS: readonly Planner[] = ["split", "one_pass", "research_only"];
export const isPlanner = (value: unknown): value is Planner => PLANNERS.includes(value as Planner);
const PLANNER_SQL = "select planner from policy.work_settings";

export async function plannerOf(query: Query): Promise<Planner> {
  const [row] = await query<{ planner: Planner }>(PLANNER_SQL);
  if (row === undefined) throw new Error("policy.work_settings has no row");
  return row.planner;
}

// The stages `research_only` still runs.
const RESEARCH_ONLY_STAGES = ["lessons"] as const;

export const RETIRED_RUNS = `x.prompt_id not in (${RESEARCH_ONLY_STAGES.map((stage) => `'${STAGE_PROMPT_IDS[stage]}'`).join(", ")})
  and (${latestEvent("run", "x.id")}) = 'queued'`;

// Whether a wake's run may be queued under a planner: under `research_only`, only a lessons run.
export const stageRuns = (source: PersonalWakeSource, planner: Planner): boolean => {
  const stage = stageOfWake(source);
  return planner !== "research_only" || RESEARCH_ONLY_STAGES.some((one) => one === stage);
};

// The point version and prompt a wake's run is queued under: run_outcome's current version, and
// its stage's prompt, or under `one_pass` its personal_run for a wake of the ideas stage, found by
// id. A pursued idea is translated and lessons are learned whatever the planner.
const RUN_PROMPT_ID = "personal_run";
export function runPlanOf(
  source: PersonalWakeSource,
  planner: Planner,
): { version: number; promptId: string; promptVersion: string } {
  if (!stageRuns(source, planner)) throw new Error("the planner queues no run for the wake");
  const stage = stageOfWake(source);
  const onePass = planner === "one_pass" && stage === "ideas";
  const definition = currentDefinition("run_outcome");
  const prompt = definition.prompts?.find((one) => one.id === (onePass ? RUN_PROMPT_ID : STAGE_PROMPT_IDS[stage]));
  if (prompt === undefined) throw new Error("run_outcome names no prompt for the wake");
  return { version: definition.version, promptId: prompt.id, promptVersion: prompt.version };
}

// Where the owner's mission is sealed: admin-work-planner.ts seals it there, and a run's
// request opens it.
export const MISSION_AT = { table: "projections.planner_mission", id: "mission", column: "text_enc" } as const;

// Where a trial's output is sealed: the body of its run's `finished` event.
export const trialOutputAt = (run: string) =>
  ({ table: "ledger.record_events", id: `${run}/finished`, column: "body_enc" }) as const;
