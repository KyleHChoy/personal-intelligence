import type { DecideRecoveryOutput, MessageTriageRow, RunCounts } from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import type { ExtractDeps } from "./config.ts";
import { askDecideModel } from "./decide-call.ts";
import { DEFAULT_THRESHOLDS, type RunThresholds } from "./decision-points.ts";
import { fitScreenSlot } from "./fit.ts";
import { backlogAsk, StepFailed, type Stopped, step } from "./item-ends.ts";
import { DECIDE_RECOVERY } from "./question-prompts.ts";

// The recovery screen: one call of `jev_recovery@1` on the first screen's `message` slot, so a message with no text is judged by its
// subject and its sender. A hold applies only at or above the run's line, and only through the store's mark, which never holds a
// message the owner released. The mark, not the saved call, records that the screen's effect was applied: a run that dies between the
// two leaves the item unmarked, and the next run replays the saved answer and applies it.

type DecideModel = NonNullable<ExtractDeps["decideModel"]>;

export async function recoveryAnswer(
  parsed: Parsed,
  read: ReadItem,
  row: MessageTriageRow,
  deps: Pick<ExtractDeps, "store"> & { decideModel: DecideModel },
): Promise<DecideRecoveryOutput | "rejected"> {
  return (await askDecideModel(
    DECIDE_RECOVERY,
    { message: JSON.stringify(fitScreenSlot(parsed, row)) },
    parsed,
    read,
    deps,
  )) as DecideRecoveryOutput | "rejected";
}

// Whether an answer asks for a hold at the run's line. A rejection is no decide model at all.
export const asksHold = (
  answer: DecideRecoveryOutput | "rejected",
  lines: RunThresholds = DEFAULT_THRESHOLDS,
): boolean => answer !== "rejected" && answer.account_recovery >= lines.recovery;

const RECOVERY_BACKLOG_LIMIT = 200;

// The backlog pass, at the start of each run with the decide model on: stored email items, latest revision,
// not held and never released, with no mark, newest first, at most 200 a run. Each gets the
// recovery call (a replay when one is saved) and the mark, and nothing else: no status row is
// written or changed, no claim is touched, and the extract model is not called. No generation is raised. What
// ends the run is returned; undefined goes on.
export async function screenRecoveryBacklog(deps: ExtractDeps, counts: RunCounts): Promise<Stopped | undefined> {
  const { decideModel } = deps;
  if (decideModel === undefined) return undefined;
  const lines = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const items = await step(() =>
    deps.store.recoveryBacklog(
      RECOVERY_BACKLOG_LIMIT,
      deps.compartments === undefined ? undefined : { compartments: deps.compartments },
    ),
  );
  // The due pass meets the same store, and ends the run if it is down.
  if (items instanceof StepFailed) return undefined;
  for (const item of items) {
    const asked = await backlogAsk({ ...deps, decideModel }, counts, item, (stored, model) =>
      recoveryAnswer(stored.parsed, stored.read, item.triage, {
        store: deps.store,
        decideModel: { ...decideModel, model },
      }),
    );
    if (asked === "skip") continue;
    if (asked === "stop") return undefined;
    if (!("answer" in asked)) return asked;
    const { answer } = asked;
    if (answer === "rejected") continue;
    try {
      await deps.store.markRecovery(item.evidenceId, asksHold(answer, lines));
    } catch {
      // Unmarked: the next run replays the saved call and marks it.
      return undefined;
    }
  }
  return undefined;
}
