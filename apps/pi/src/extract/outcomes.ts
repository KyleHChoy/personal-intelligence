import { OutcomeAnswer, type PersonalLogger } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import {
  type AskOutcome,
  asker,
  type ExtractDeps,
  judgeOutcomes,
  OUTCOME_JUDGE_PROMPT,
  OUTCOME_POINT,
  type OutcomeCounts,
  outcomeJudge,
  snake,
} from "@intelligence/personal-extract";
import type { OutcomeStore, Pipeline } from "@intelligence/personal-store";

// The outcome judge as `pi extract` runs it in the relation step, after the claim relations and
// before the diff, inside the same run budget and day cap (ontology/relations.json). Both orders of
// each candidate through the keyed replay (one asked again pays nothing); a model link is written
// unapplied, its two orders agreeing and its cites found, and the tick applies it or holds it.
// Before a request leaves, the item is noted as exposed to the model. Counts and codes only.

type ModelClient = ExtractDeps["model"];

export type OutcomeStepCounts = OutcomeCounts & { saved: number; checks: number };

export async function runOutcomes(deps: {
  outcomes: OutcomeStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  // The run's calls the claim relations left.
  callsLeft: number;
  log: PersonalLogger;
  now: () => Date;
}): Promise<OutcomeStepCounts> {
  const { outcomes, pipeline, client, log } = deps;
  const judge = outcomeJudge(client.modelId);
  const { budget } = relationRules();
  const { candidates, checked, deferred, calls } = await outcomes.jobs(judge, deps.now().toISOString(), {
    calls: Math.max(0, deps.callsLeft),
    callsPerDay: budget.callsPerDay,
  });
  const failed = { event: "outcome_call_failed" };
  const asked = asker({
    point: OUTCOME_POINT,
    prompt: OUTCOME_JUDGE_PROMPT,
    schema: OutcomeAnswer,
    store: outcomes,
    exposure: pipeline,
    client,
    log,
    failed,
  });
  // A reached budget is an outage here, logged as one.
  const ask: AskOutcome = async (call) => {
    const answer = await asked(call);
    if (answer === "budget") log.warn({ ...failed, code: "budget_reached" });
    return answer === "budget" ? "unavailable" : answer;
  };
  const run = await judgeOutcomes(candidates, ask, { calls }, judge, (one) => outcomes.subjectOf(one), checked);
  run.checks.push(...deferred);
  run.counts.unjudged += deferred.length;
  const saved = await outcomes.save(run, judge);
  const counts: OutcomeStepCounts = { ...run.counts, saved: saved.links, checks: saved.checks };
  log.info({ event: "outcome_step", code: run.stopped, counts: snake(counts) });
  return counts;
}
