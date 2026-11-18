import type {
  DecideScreenOutput,
  EmailDueItem,
  MessageTriageRow,
  PipelineCode,
  TriageLane,
} from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import type { ExtractDeps } from "./config.ts";
import { askDecideModel } from "./decide-call.ts";
import { DEFAULT_THRESHOLDS, type RunThresholds } from "./decision-points.ts";
import { fitScreenSlot } from "./fit.ts";
import { DECIDE_SCREEN } from "./question-prompts.ts";
import { triage } from "./triage.ts";

// The one decide-model call for one item: it answers the three numbers, or "rejected" for an answer
// that was not them. Any other client error fails the item `interpret_failed`, unscreened, so it is not
// sent to the extract model. An outage, a refusal and a reached budget pass through; a store error
// passes through for processItem to defer.
export const screenItem = (
  parsed: Parsed,
  read: ReadItem,
  row: MessageTriageRow,
  deps: Pick<ExtractDeps, "store"> & { decideModel: NonNullable<ExtractDeps["decideModel"]> },
): Promise<DecideScreenOutput | "rejected"> =>
  askDecideModel(DECIDE_SCREEN, { message: JSON.stringify(fitScreenSlot(parsed, row)) }, parsed, read, deps) as Promise<
    DecideScreenOutput | "rejected"
  >;

type Triaged = { lane: TriageLane; code?: PipelineCode };

// Whether the decide model is asked about an item, given rung 0's triage: not when the owner set both the
// lane and the release, and not for a skip by the owner's lane or for no text. Only rung 0's
// bulk skip is left to the decide model.
export const screens = (due: Pick<EmailDueItem, "lane" | "override">, rung0: Triaged): boolean =>
  !(due.lane !== undefined && due.override) && (rung0.lane !== "skip" || rung0.code === "bulk");

// What an answer decides at the run's lines: a hold, quarantine before special_category, unless the
// owner released the item; and the lane, at triage's line 5, unless the lane's rung 1 is suspended,
// when triage keeps rung 0's lines.
export function decide(
  due: Pick<EmailDueItem, "lane" | "override" | "triage">,
  answer: DecideScreenOutput,
  lines: RunThresholds = DEFAULT_THRESHOLDS,
): { withhold?: "quarantine" | "sensitive"; triaged: Triaged } {
  const triaged = lines.laneSuspended
    ? triage(due.triage, due.lane)
    : triage(due.triage, due.lane, answer.human_written, lines.lane);
  if (!due.override && answer.quarantine >= lines.quarantine) return { withhold: "quarantine", triaged };
  if (!due.override && answer.special_category >= lines.specialCategory) return { withhold: "sensitive", triaged };
  return { triaged };
}
