import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import { isCoded, type PersonalLogger, TimeProposalAnswer } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import {
  budgetCode,
  type ExtractDeps,
  snake,
  TIME_PROPOSAL_POINT,
  TIME_PROPOSAL_PROMPT,
} from "@intelligence/personal-extract";
import { completeKeyedWithReplay } from "@intelligence/personal-models";
import type { Pipeline, TimeApplied, TimePassStore } from "@intelligence/personal-store";

// The daily proposal pass as `pi extract` runs it: behind
// PI_EXTRACT_TIME, after the relation step, at most once a local day, under the run and day lines.
// No agent loop: one closed request per day and label, through the keyed replay, so a day that has
// not changed costs nothing to ask again. Before a request leaves, its items are noted as exposed
// to the model. A budget or an outage ends the pass unfinished, so the next run takes it up; any
// other failure costs its one day and the pass goes on, so one bad day never starves the older ones
// or has the whole window read again each run. Counts and codes only.

type ModelClient = ExtractDeps["model"];

// `momentsWider`: the moments the pass left unread because their label is wider than their block's.
export type TimePassCounts = TimeApplied & {
  days: number;
  asked: number;
  rejected: number;
  failed: number;
  momentsWider: number;
};

const OUTAGES: readonly string[] = ["unavailable", "timeout", "rate_limited"];
const ends = (error: unknown): string | null => {
  const budget = budgetCode(error);
  if (budget !== undefined) return budget;
  return isCoded(error) && typeof error.code === "string" && OUTAGES.includes(error.code) ? error.code : null;
};

export async function runTimeProposals(deps: {
  store: TimePassStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  compartments: readonly string[];
  log: PersonalLogger;
  now: () => Date;
}): Promise<TimePassCounts | "not_due"> {
  const { store, pipeline, client, log } = deps;
  const started = deps.now();
  if (!(await store.due(started))) return "not_due";
  const counts: TimePassCounts = {
    days: 0,
    asked: 0,
    rejected: 0,
    failed: 0,
    proposed: 0,
    stretches: 0,
    refused: 0,
    cards: 0,
    momentsWider: 0,
  };
  let code = "ok";
  for (const job of await store.jobs(started, deps.compartments)) {
    counts.days += 1;
    counts.momentsWider += job.momentsWider;
    const calls = store.calls();
    const noting: ModelClient = {
      ...client.model,
      complete: async (request) => {
        await pipeline.noteExposure(
          client.modelId,
          request.promptId,
          job.evidence.map((id) => EvidenceId.parse(id)),
        );
        return client.model.complete(request);
      },
    };
    let answer: TimeProposalAnswer;
    try {
      const response = await completeKeyedWithReplay(
        noting,
        calls.store,
        {
          promptId: TIME_PROPOSAL_PROMPT.id,
          promptVersion: TIME_PROPOSAL_PROMPT.version,
          data: { groups: job.slot },
          label: { compartments: job.label, readers: [THE_OWNER] },
          trustGroup: TrustGroupId.parse("personal-openrouter"),
        },
        {
          point: TIME_PROPOSAL_POINT.id,
          version: TIME_PROPOSAL_POINT.version,
          subject: store.subjectOf(job),
          refs: job.evidence,
          modelId: client.modelId,
        },
        job.label,
        [TIME_PROPOSAL_PROMPT],
      );
      counts.asked += 1;
      answer = TimeProposalAnswer.parse(response.output);
    } catch (error) {
      const stop = ends(error);
      if (stop !== null) {
        code = stop;
        break;
      }
      // A refused output is saved, and replays as a refusal: that day holds nothing to write.
      if ((await calls.lastId()) !== null) counts.rejected += 1;
      else counts.failed += 1;
      continue;
    }
    try {
      const applied = await store.apply(job, answer, deps.now());
      counts.proposed += applied.proposed;
      counts.stretches += applied.stretches;
      counts.refused += applied.refused;
      counts.cards += applied.cards;
    } catch (error) {
      const stop = ends(error);
      if (stop !== null) {
        code = stop;
        break;
      }
      counts.failed += 1;
    }
  }
  log.info({ event: "time_pass", code, counts: snake(counts) });
  if (code === "ok") await store.finish(started, deps.now());
  return counts;
}
