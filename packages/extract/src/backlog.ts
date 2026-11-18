import type { ModelCallRecord } from "@intelligence/contracts";
import type { RunCounts } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION, type ExtractDeps } from "./config.ts";
import { backlogAsk, StepFailed, type Stopped, step } from "./item-ends.ts";
import { DECIDE_SCREEN } from "./question-prompts.ts";
import { decide, screenItem, screens } from "./screen.ts";
import { triage } from "./triage.ts";

// The backlog pass: at the start of a run with the decide model on, the items done before the decide model was on
// are screened once, under the same generation, so no claim id changes. Each item's outcome alone is recorded: a
// hold is committed `withheld`; a lane change defers the item, so the due pass sends it on under the same generation
// and replays the saved call; anything else writes nothing. The saved call is the mark, and it is saved only after
// the outcome is written, so an outcome that could not be written leaves the item in the backlog.

const BACKLOG_LIMIT = 200;

const MARK = { promptId: DECIDE_SCREEN.id, promptVersion: DECIDE_SCREEN.version };

// What ends the run, or undefined to go on to the due items.
export async function screenBacklog(deps: ExtractDeps, counts: RunCounts): Promise<Stopped | undefined> {
  const { decideModel } = deps;
  if (decideModel === undefined) return undefined;
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const calls = deps.store.calls(decideModel.modelId);
  const items = await step(() =>
    deps.store.backlog(
      BACKLOG_LIMIT,
      generation,
      MARK,
      deps.compartments === undefined ? undefined : { compartments: deps.compartments },
    ),
  );
  // The due pass meets the same store, and ends the run if it is down.
  if (items instanceof StepFailed) return undefined;

  for (const item of items) {
    if (!screens(item, triage(item.triage, item.lane))) continue;
    const pending: ModelCallRecord[] = [];
    const store = {
      ...deps.store,
      calls: () => ({
        find: (key: ModelCallRecord["key"]) => calls.find(key),
        save: async (record: ModelCallRecord) => void pending.push(record),
      }),
    };
    const asked = await backlogAsk({ ...deps, decideModel }, counts, item, (stored, model) =>
      screenItem(stored.parsed, stored.read, item.triage, { store, decideModel: { ...decideModel, model } }),
    );
    if (asked === "skip") continue;
    if (asked === "stop") return undefined;
    if (!("answer" in asked)) return asked;
    const { answer } = asked;

    if (answer !== "rejected") {
      const { withhold, triaged } = decide(item, answer, deps.thresholds);
      try {
        if (withhold !== undefined) {
          try {
            const result = await deps.store.commit({
              evidenceId: item.evidenceId,
              generation,
              lane: triaged.lane,
              status: "withheld",
              code: withhold,
              claims: [],
              unmapped: [],
              unresolved: 0,
            });
            if (result === "committed") counts.withheld += 1;
          } catch {
            // The due pass withholds it from the saved call.
            await deps.store.defer(item.evidenceId, generation, { code: "commit_failed", lane: triaged.lane });
            deps.log.warn({ event: "extract_item_failed", code: "commit_failed", ids: { evidence: item.evidenceId } });
          }
        } else if (triaged.lane !== item.committedLane) {
          await deps.store.defer(item.evidenceId, generation, { code: "lane_changed", lane: triaged.lane });
        }
      } catch {
        return { code: "store_unavailable" };
      }
    }
    try {
      for (const record of pending) await calls.save(record);
    } catch {
      // Not saved: the item is screened again at a later run.
      return undefined;
    }
  }
  return undefined;
}
