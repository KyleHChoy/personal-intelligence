import {
  DecideSameFactOutput,
  KEY_FIELDS,
  type PersonalLogger,
  Rung2Output,
  type ThresholdName,
} from "@intelligence/contracts/personal";
import {
  asker,
  type ClimbSameFact,
  DECIDE_SAME_FACT,
  EXTRACT_SAME_FACT,
  type SameFactPair,
  type SameFactSummary,
  snake,
  sweepSameFact,
} from "@intelligence/personal-extract";
import { climb, type EffectiveValue, effectiveThresholds, REGISTRY } from "@intelligence/personal-ladder";
import type { GroupingStore, Pipeline } from "@intelligence/personal-store";
import type { ModelClient } from "./extract-config.ts";

// The extract package chooses the pairs and checks every answer; this binds the ladder's climb of claims_same_fact under
// the run's thresholds, and asks the decide model and the extract model through the keyed replay over
// vault.decision_calls, so a pair asked again pays nothing. Before a request leaves, the two claims' items are noted as
// exposed to the model, as `exposing` notes an item's. Rows and cards are the grouping store's; nothing here touches a
// belief.

const SAME_FACT_POINT = "claims_same_fact";
const SAME_FACT_VERSION = 2;

const sameFactClimb =
  (thresholds: Partial<Record<ThresholdName, EffectiveValue>>): ClimbSameFact =>
  (input) =>
    climb(REGISTRY, { id: SAME_FACT_POINT, version: SAME_FACT_VERSION }, { ...input, thresholds });

type SameFactClient = { model: ModelClient; modelId: string };
export type SameFactDeps = {
  grouping: GroupingStore;
  pipeline: Pick<Pipeline, "beliefDecisions" | "noteExposure" | "thresholds" | "suspensions" | "sweepBeliefs">;
  decideModel?: SameFactClient;
  extractModel?: SameFactClient;
  log: PersonalLogger;
};

const union = (pair: SameFactPair): string[] => [...new Set([...pair.a.compartments, ...pair.b.compartments])].sort();

export type SameFactCounts = SameFactSummary & {
  saved: number;
  gone: number;
  raised: number;
  cardsCapped: number;
  cardsHeld: number;
};

export async function runSameFact(deps: SameFactDeps): Promise<SameFactCounts> {
  const { grouping, pipeline, log } = deps;
  const mode = await grouping.mode();
  const none: SameFactCounts = {
    pairs: 0,
    asked: 0,
    rung0: 0,
    calls: 0,
    accept: 0,
    middle: 0,
    reject: 0,
    refused: 0,
    waiting: 0,
    capped: 0,
    saved: 0,
    gone: 0,
    raised: 0,
    cardsCapped: 0,
    cardsHeld: 0,
  };
  if (mode === "off") return none;
  // The owner-side beliefs, computed now under each clearance swept: no stored answer is read.
  const computed = await pipeline.sweepBeliefs(Object.keys(KEY_FIELDS));
  const [decisions, grants, suspended, audiences, asked] = await Promise.all([
    pipeline.beliefDecisions(),
    pipeline.thresholds(),
    pipeline.suspensions(),
    grouping.audiences(computed),
    grouping.asked(computed.map((one) => one.audience)),
  ]);
  const thresholds = effectiveThresholds(grants)[`${SAME_FACT_POINT}@${SAME_FACT_VERSION}`] ?? {};
  // A rung drift suspended is passed over: with the decide model suspended,
  // the extract model is asked first.
  const decideSuspended = suspended.some((one) => one.point === SAME_FACT_POINT && one.version === SAME_FACT_VERSION);
  // One pair through the keyed replay, its items noted as exposed before the request leaves. An
  // outage, a refusal, a reached budget: the pair waits for the next run.
  async function ask<T>(
    client: SameFactClient,
    prompt: typeof DECIDE_SAME_FACT,
    pair: SameFactPair,
    slot: string,
    schema: { parse(value: unknown): T },
  ): Promise<{ output: T; savedCall: string } | { rejected: string } | "unavailable"> {
    const point = { id: SAME_FACT_POINT, version: SAME_FACT_VERSION };
    const failed = { event: "same_fact_call_failed" };
    const answer = await asker({ point, prompt, schema, store: grouping, exposure: pipeline, client, log, failed })({
      slot,
      subject: pair.subject,
      refs: [pair.a.evidence, pair.b.evidence],
      compartments: union(pair),
    });
    if (answer === "budget") log.warn({ ...failed, code: "budget_reached" });
    if (typeof answer === "string") return "unavailable";
    return "rejected" in answer ? { rejected: answer.rejected } : answer;
  }

  const decideModel = deps.decideModel;
  const extractModel = deps.extractModel;
  const { rows, summary } = await sweepSameFact(
    { mode, audiences, rulings: decisions.factRulings ?? [], asked },
    {
      climb: sameFactClimb(thresholds),
      ...(decideModel === undefined || decideSuspended
        ? {}
        : {
            decideModel: async (pair, slot) => {
              const answer = await ask(decideModel, DECIDE_SAME_FACT, pair, slot, DecideSameFactOutput);
              return typeof answer === "string" || "rejected" in answer
                ? answer
                : { p: answer.output.same_fact, savedCall: answer.savedCall };
            },
          }),
      ...(extractModel === undefined
        ? {}
        : {
            extractModel: async (pair, slot) => {
              return ask(extractModel, EXTRACT_SAME_FACT, pair, slot, Rung2Output);
            },
          }),
    },
  );
  const written = await grouping.save(rows);
  const cards = await grouping.raiseCards();
  const counts: SameFactCounts = {
    ...summary,
    ...written,
    raised: cards.raised,
    cardsCapped: cards.capped,
    cardsHeld: cards.held,
  };
  // Under the logger's snake-case keys, as the extract_run line's.
  if (summary.pairs > 0) log.info({ event: "same_fact_sweep", counts: snake(counts) });
  return counts;
}
