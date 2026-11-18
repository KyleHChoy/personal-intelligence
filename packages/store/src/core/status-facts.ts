import type { PipelineCode, PipelineStatus, RetryAsk, TriageLane } from "@intelligence/contracts/personal";
import { open, type Sealed } from "./seal.ts";
import type { Tx } from "./tx.ts";

// What a status row seals.
export type StatusFacts = {
  lane: TriageLane;
  laneOverride?: TriageLane;
  override: boolean;
  status: PipelineStatus;
  code?: PipelineCode;
  attempts: number;
  claims: number;
  unmapped: number;
  unresolved: number;
  // A document's: the calls it was sent in and the passages past the last of them.
  groups?: number;
  leftOut?: number;
  // Set by the owner's retry and cleared by the next commit, so a moment's skipped commit keeps its
  // claims unless the owner asked for it again.
  retried?: true;
  // Set by `pia extract reroute` and cleared by the next commit, which is then
  // backfill for the triggers, and the run that takes it reports its belief changes as backfill,
  // as a generation raise does: a re-read of old mail wakes no agent.
  rerouted?: true;
  // Set by a retry that keeps its answers on a message it chose: the version to ask it and the lane that is for, that
  // one and no later one. Held past a commit that asked it, so a later replay takes the answer paid for; a commit that did
  // not, as with the lane switched off or the item moved, and a retry that deletes the saved calls, drop it.
  ask?: RetryAsk;
  // Its claims that kept a value code repaired, and that its claims came after its one re-ask.
  repaired?: number;
  reasked?: true;
};

export const statusAt = (evidenceId: string) => ({
  table: "vault.pipeline_items",
  id: evidenceId,
  column: "facts_enc",
});

// Under the row's whole label: one compartment for a message's, an agent record's label for its.
// One compartment gives that compartment's own key, so every row written before opens.
export const openStatus = (tx: Tx, compartments: string[], evidenceId: string, sealed: unknown): StatusFacts =>
  JSON.parse(
    open(
      tx.keys,
      { id: evidenceId, compartments, facts_enc: sealed as Sealed },
      "vault.pipeline_items.facts_enc",
      "throw",
    ),
  ) as StatusFacts;
