import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import { isCoded, type PersonalLogger, SourceCheckAnswer } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import {
  type AskSource,
  type ExtractDeps,
  refusedShape,
  SOURCE_CHECK_PROMPT,
  SOURCE_POINT,
} from "@intelligence/personal-extract";
import { BudgetReached, completeKeyedWithReplay } from "@intelligence/personal-models";
import type { Pipeline, SourceCheckStore } from "@intelligence/personal-store";

type ModelClient = ExtractDeps["model"];

// The point the second model's source checks are asked under: never the
// judge's, so the keyed replay never gives one model's answer as another's.
export const SECOND_CHECK_POINT = { id: "source_check_second", version: 1 } as const;

// One source check through the keyed replay, its items noted as exposed before the request leaves.
export function sourceAsker(deps: {
  checks: Pick<SourceCheckStore, "calls">;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  log: PersonalLogger;
  // The census's own point, so no answer of another model's is replayed for it.
  point?: { id: string; version: number };
}): AskSource {
  const { checks, pipeline, client, log } = deps;
  const point = deps.point ?? SOURCE_POINT;
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
    const calls = checks.calls();
    try {
      const response = await completeKeyedWithReplay(
        noting,
        calls.store,
        {
          promptId: SOURCE_CHECK_PROMPT.id,
          promptVersion: SOURCE_CHECK_PROMPT.version,
          data: { case: slot },
          label: { compartments, readers: [THE_OWNER] },
          trustGroup: TrustGroupId.parse("personal-openrouter"),
        },
        { point: point.id, version: point.version, subject, refs: showing, modelId: client.modelId },
        compartments,
        [SOURCE_CHECK_PROMPT],
      );
      return { output: SourceCheckAnswer.parse(response.output) };
    } catch (error) {
      // A reached budget asked nothing: no call failed.
      if (error instanceof BudgetReached) return "budget";
      // A refused output is saved, and replays as a refusal; why, as a code alone, is logged.
      const saved = await calls.lastId();
      if (saved !== null) {
        const raw = (error as { rawOutput?: unknown }).rawOutput;
        if (typeof raw === "string") log.warn({ event: "source_check_rejected", code: refusedShape(raw) });
        return { rejected: saved };
      }
      const code = isCoded(error) ? error.code : undefined;
      if (typeof code !== "string") throw error;
      log.warn({ event: "source_check_call_failed", code });
      return "unavailable";
    }
  };
}
