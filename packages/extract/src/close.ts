import { createHash } from "node:crypto";
import { type Claim, ClaimId } from "@intelligence/contracts";
import { type ClaimRecord, type OpenedRecord, parseCloseBody } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";

// The one claim code builds from an agent's close of a commitment, with no model. The commitment's
// own content (type, subject, counterparty, due) and its own fact key, so the close joins the
// commitment's belief; statement kind `reversal`; basis `third_party`, the agent's statement;
// origin `agent_close`; dated by the newest related item it cited, so anything said after that
// evidence is later and decides the belief; labelled with the commitment's compartments, which the
// database admits only under the owner's standing release. The evidence is the close record.
// Nothing in the body reaches the content but the time.

// The pipeline version of a close claim, set by code: no model asked.
const CLOSE_PIPELINE = "personal_close@1";

type CloseOutcome = { record: ClaimRecord } | { code: "bad_close" | "orphaned" };

export function closeClaim(record: OpenedRecord, generation: number): CloseOutcome {
  const close = parseCloseBody(record.body);
  if (close === null) return { code: "bad_close" };
  const commitment = record.commitment;
  // The commitment was erased or re-keyed since: the close closes nothing.
  if (commitment === undefined) return { code: "orphaned" };
  const base = commitment.record;
  const evidenceId = record.context.evidenceId;
  const span = `chars:0-${record.body.length}`;
  const id = ClaimId.parse(
    createHash("sha256")
      .update(JSON.stringify(["close", evidenceId, close.commitment, generation]), "utf8")
      .digest("hex"),
  );
  const { validTo: _validTo, assertedBy: _assertedBy, ...rest } = base.claim;
  const claim: Claim = {
    ...rest,
    id,
    statementKind: "reversal",
    basis: "third_party",
    validFrom: close.relatedAt,
    evidence: [{ evidenceId, span }],
    primaryEvidenceId: evidenceId,
    // The record's readers, the owner alone, as every agent record's evidence row holds.
    label: { compartments: [...commitment.compartments], readers: [THE_OWNER] },
    pipelineVersion: CLOSE_PIPELINE,
    extractorGeneration: generation,
    changeKind: "live",
    systemOriginated: false,
  };
  const {
    matchKey: _matchKey,
    released: _released,
    notice: _notice,
    confidence: _confidence,
    standing: _standing,
    ...kept
  } = base;
  return { record: { ...kept, claim, origin: "agent_close", lane: "agent", answersSystem: false } };
}
