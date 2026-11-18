import { type ClaimRecord, TYPED_CLAIM_PIPELINE } from "@intelligence/contracts/personal";

// What a claim's evidence item says of it, whatever its sealed record says. A claim of an agent
// record is an agent's (agent_record, or agent_close for an untyped close); a typed one, which
// pi_reader sealed, is never the owner's word, a notice, a release or a channelled proposal, so it
// can only be confirmed into owner_confirmed, as any finding. The belief build and the reads that
// tier a claim (about, find_facts) apply it. Its own module, importing nothing of the store, so
// every reader may import it.
export function asItemSays(record: ClaimRecord, item: { agent_item: boolean; typed: boolean }): ClaimRecord {
  if (!item.agent_item) return record;
  // Or agent_research for an untyped fill's claim, built by code.
  const origin =
    (record.origin === "agent_close" || record.origin === "agent_research") && !item.typed
      ? record.origin
      : "agent_record";
  if (!item.typed) return origin === record.origin ? record : { ...record, origin };
  const { notice: _notice, released: _released, ...rest } = record;
  const { assertedBy: _assertedBy, ...claim } = record.claim;
  return { ...rest, origin, claim: { ...claim, pipelineVersion: TYPED_CLAIM_PIPELINE } } as ClaimRecord;
}
