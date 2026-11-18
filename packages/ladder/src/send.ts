import type { GateOutcome } from "@intelligence/contracts/personal";

// Rung 0 of send_clear. Pure. It never answers clear: only the owner's `pi send`, rung 4, clears an
// external stage. A gate that held the draft is a refusal; a gate that cleared it leaves the
// decision to the owner. Only its tests call it; a harness's plan_move for send would call it.
export function sendClearRung0(outcome: GateOutcome): "refuse" | "cannot_decide" {
  const cleared = outcome.cleared && Object.values(outcome.checks).every((passed) => passed);
  return cleared ? "cannot_decide" : "refuse";
}
