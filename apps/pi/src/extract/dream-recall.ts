import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import { isCoded, type PersonalLogger, RecallAuditAnswer } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { relationRules } from "@intelligence/personal-core/views";
import {
  auditRecall,
  type ExtractDeps,
  RECALL_AUDIT_PROMPT,
  RECALL_POINT,
  type RecallAsk,
  type RecallCounts,
  recallJudge,
  stratifiedSample,
} from "@intelligence/personal-extract";
import { BudgetReached, completeKeyedWithReplay, withBudget } from "@intelligence/personal-models";
import type { Pipeline, RecallStore } from "@intelligence/personal-store";

// The recall audit's night: a sweep of `pi dream`, first in the pass, so a night the sweeps spend whole
// still measures. Off unless `PI_RECALL_AUDIT=1`: it spends on the judge model, under its own dollars a
// owner's day within the night's (ontology/relations.json `dream`). It writes check rows of ids and codes
// and nothing else: it changes no filter and no knowledge.

type ModelClient = ExtractDeps["model"];
export type RecallNight = RecallCounts & { strata: number; passedOver: number; saved: number };

export const recallAuditOn = (env: Record<string, string | undefined>): boolean => env.PI_RECALL_AUDIT === "1";

const micro = (usd: number): number => Math.round(usd * 1_000_000);

function recallAsker(deps: {
  store: Pick<RecallStore, "calls">;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  log: PersonalLogger;
}): RecallAsk {
  const { store, pipeline, client, log } = deps;
  let showing: string[] = [];
  const noting: ModelClient = {
    ...client.model,
    complete: async (request) => {
      await pipeline.noteExposure(
        client.modelId,
        request.promptId,
        showing.map((id) => EvidenceId.parse(id)),
      );
      return client.model.complete(request);
    },
  };
  return async ({ slot, subject, refs, compartments }) => {
    showing = [...new Set(refs)].sort();
    const calls = store.calls();
    try {
      const response = await completeKeyedWithReplay(
        noting,
        calls.store,
        {
          promptId: RECALL_AUDIT_PROMPT.id,
          promptVersion: RECALL_AUDIT_PROMPT.version,
          data: { case: slot },
          label: { compartments, readers: [THE_OWNER] },
          trustGroup: TrustGroupId.parse("personal-openrouter"),
        },
        { point: RECALL_POINT.id, version: RECALL_POINT.version, subject, refs: showing, modelId: client.modelId },
        compartments,
        [RECALL_AUDIT_PROMPT],
      );
      return { output: RecallAuditAnswer.parse(response.output) };
    } catch (error) {
      if (error instanceof BudgetReached) return "budget";
      const saved = await calls.lastId();
      if (saved !== null) return { rejected: saved };
      const code = isCoded(error) ? error.code : undefined;
      if (typeof code !== "string") throw error;
      log.warn({ event: "recall_audit_call_failed", code });
      return "unavailable";
    }
  };
}

// The night's sample, read and saved under the owner's clearance. A row is written for each case reached.
export async function runRecallAudit(deps: {
  store: RecallStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  clearance: readonly string[];
  log: PersonalLogger;
  now: () => Date;
  random: () => number;
}): Promise<{ night: RecallNight; stopped: "ok" | "budget" | "unavailable" }> {
  const { store, client } = deps;
  const rules = relationRules().dream;
  const judge = recallJudge(client.modelId);
  const limit = micro(rules.recallUsdPerDay);
  const model = withBudget(client.model, {
    spentRun: () => 0,
    spentDay: () => store.spentToday(RECALL_AUDIT_PROMPT.id),
    costMissing: () => false,
    runMicroUsd: limit,
    dayMicroUsd: limit,
    maxCalls: rules.recallChecksPerNight,
  });
  const sample = await store.cases(deps.clearance, judge, deps.now(), rules.recallChecksPerNight, (strata, total) =>
    stratifiedSample(strata, total, deps.random),
  );
  const run = await auditRecall(
    sample.cases,
    recallAsker({ store, pipeline: deps.pipeline, client: { model, modelId: client.modelId }, log: deps.log }),
    { calls: rules.recallChecksPerNight },
  );
  const saved = await store.save(run.rows, judge);
  return {
    night: { ...run.counts, strata: sample.strata, passedOver: sample.passedOver, saved },
    stopped: run.stopped,
  };
}
