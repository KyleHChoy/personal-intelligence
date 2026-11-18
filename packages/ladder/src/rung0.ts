import { INTERNAL_STAGES, type IntentId, type SilenceReason, STAGE_PLAN } from "@intelligence/contracts/personal";
import type { BasisFact, OpportunityFacts, WakeFacts } from "./facts.ts";

export type CannotDecide = "cannot_decide";

export type Rung0<F> = (facts: F) => { output: string; reason: string } | CannotDecide;

export type WakeDecision =
  | { output: "run"; reason: "wake" }
  | {
      output: "skip";
      reason: Extract<SilenceReason, "kill_switch" | "vetoed" | "no_reasoner" | "owner_backlog" | "budget">;
    };

export type OpportunityDecision =
  | { output: "go"; reason: "intent" | "agent_bet"; intent: IntentId }
  | { output: "later"; reason: "max_open"; intent: IntentId }
  | { output: "no_go"; reason: "vetoed" | "owner_declined" | "expired_no_news" };

const NEWS_DAYS = 7;
// The reasoner's deferred cards that say the owner is behind on its questions, and stop its runs.
// Any one would let a single "later" silence the planner for the 14 days until that card
// expired. Provisional, the owner's to tune.
export const REASONER_DEFERRED_CARDS_MAX = 10;

export function wakeWorthRun(facts: WakeFacts): WakeDecision | CannotDecide {
  // The owner's own request skips the backlog and the run count, and nothing else.
  const unlimited = facts.source === "owner_request";
  if (facts.killSwitch) return { output: "skip", reason: "kill_switch" };
  if (facts.anchorVetoed) return { output: "skip", reason: "vetoed" };
  if (!facts.reasonerRegistered) return { output: "skip", reason: "no_reasoner" };
  if (
    !unlimited &&
    (facts.reasonerDeferredCards >= REASONER_DEFERRED_CARDS_MAX ||
      facts.pendingCardsInClearance >= facts.maxPendingCards)
  )
    return { output: "skip", reason: "owner_backlog" };
  if ((!unlimited && facts.runsToday >= facts.maxRunsPerDay) || facts.spentTodayMicroUsd >= facts.maxMicroUsdPerDay)
    return { output: "skip", reason: "budget" };
  return { output: "run", reason: "wake" };
}

export function opportunityGo(facts: OpportunityFacts): OpportunityDecision | CannotDecide {
  if (facts.vetoed) return { output: "no_go", reason: "vetoed" };
  if (facts.cardPending) return "cannot_decide";
  const closed = facts.caseClosed;
  if (closed && (!closed.newSourceRef || closed.daysSince < NEWS_DAYS))
    return { output: "no_go", reason: closed.by === "owner" ? "owner_declined" : "expired_no_news" };
  // Once code says it cannot decide a case, it never later says it can.
  if (facts.caseEverCarded) return "cannot_decide";
  // A gap flag the system proposes rather than decides (one the owner declined, back from a new
  // source) is the owner's to decide (invariant 11).
  // A client's proposal is the owner's to decide, unless its proposer staked a bet on it: then the
  // go is the agent's, on read-only work alone, and work about the owner is as open to it as a task
  // about the owner is. A hypothesis about the owner never causes a move, bet or not.
  const bet = facts.proposedByClass === "client" && facts.bet === true;
  if ((facts.proposedByClass === "client" && !bet) || facts.proposedByClass === "system") return "cannot_decide";
  if ((facts.aboutOwner && !bet) || facts.restsOnOwnerHypothesis) return "cannot_decide";
  // An answer counts only after the owner's own go (ledger.answer_owner_question): rung 0's would
  // let an agent claim and ask a question whose answer could never be recorded.
  if (facts.kind === "owner_question") return "cannot_decide";
  if (STAGE_PLAN[facts.kind].some((stage) => !INTERNAL_STAGES.includes(stage))) return "cannot_decide";
  const intent = facts.intents[0];
  // An intent's mode says whether code may give the go alone. A bet's go is an agent's, under the
  // owner's standing leave for agents to approve read-only work with their bets, so it asks only
  // that a confirmed intent lists the kind and an active agent, as plan_move does of every move.
  if (!intent || (!bet && facts.intents.some((one) => one.mode === "owner_decides")) || intent.activeClients === 0)
    return "cannot_decide";
  // A bet asks of its basis what a task's go asks: nothing tainted or flagged. The owner-backed lines
  // stand for code deciding alone; the bettor stakes its budget on the work instead.
  if (bet ? facts.basis.some((ref) => ref.tainted || ref.flagged) : !basisTrusted(facts.basis)) return "cannot_decide";
  if (intent.open >= intent.maxOpen) return { output: "later", reason: "max_open", intent: intent.id };
  return { output: "go", reason: bet ? "agent_bet" : "intent", intent: intent.id };
}

// The database's copy is the check inside ledger.plan_move; one table of cases is run through both.
export function basisTrusted(basis: readonly BasisFact[]): boolean {
  if (basis.some((ref) => ref.tainted || ref.flagged)) return false;
  if (!basis.some((ref) => ref.sourceClass === "source" && ref.ownerBacked)) return false;
  const answered = new Set(
    basis
      .filter((ref) => ref.refKind === "message" && ref.ownerBacked && ref.threadFp !== null)
      .map((ref) => ref.threadFp),
  );
  return basis.every((ref) => {
    if (ref.ownerBacked) return true;
    if (ref.refKind === "message" && (ref.sourceClass === "source" || ref.sourceClass === "system"))
      return ref.threadFp !== null && answered.has(ref.threadFp);
    if (ref.refKind === "event" && ref.sourceClass === "source") return ref.isAbout;
    return true;
  });
}
