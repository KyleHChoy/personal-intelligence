import type { Claim } from "@intelligence/contracts";

// A claim code builds with no model: a stated fact from one item's own evidence at one span, live,
// not system-originated, of origin `source`, at identity epoch 0.
export const codeClaim = (claim: {
  id: Claim["id"];
  content: Claim["content"];
  basis: Claim["basis"];
  validFrom: Claim["validFrom"];
  validTo?: Claim["validTo"] | undefined;
  evidenceId: Claim["primaryEvidenceId"];
  span: string;
  label: Claim["label"];
  pipelineVersion: string;
  generation: number;
}): Claim => ({
  id: claim.id,
  content: claim.content,
  statementKind: "stated_fact",
  basis: claim.basis,
  validFrom: claim.validFrom,
  ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
  evidence: [{ evidenceId: claim.evidenceId, span: claim.span }],
  primaryEvidenceId: claim.evidenceId,
  label: claim.label,
  destination: "personal",
  pipelineVersion: claim.pipelineVersion,
  extractorGeneration: claim.generation,
  changeKind: "live",
  systemOriginated: false,
  origin: "source",
  identityEpoch: 0,
});
