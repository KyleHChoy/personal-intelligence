import { z } from "zod";
import { ChangeKind, Passage } from "./evidence.ts";
import { ClaimId, EvidenceId, Fingerprint, LocalEntityId, Store, Timestamp } from "./ids.ts";
import { Label } from "./label.ts";

export const StatementKind = z.enum([
  "stated_fact",
  "proposal",
  "objection",
  "question",
  "decision",
  "reversal",
  "hypothesis",
]);
export type StatementKind = z.infer<typeof StatementKind>;

// How we know: changes how much a claim weighs and what may be disclosed.
export const BasisType = z.enum(["explicit_self", "third_party", "system_observed", "web_derived"]);
export type BasisType = z.infer<typeof BasisType>;

// Set by the checker from the evidence item's source kind, never by a model. A member's
// correction outranks inferred claims. A member is a person on a team deployment; Personal
// Intelligence's belief builder lets a `member_correction` claim outrank inferred ones too.
const ClaimOrigin = z.enum(["source", "member_correction", "member_note"]);
type ClaimOrigin = z.infer<typeof ClaimOrigin>;

// What a claim says, as typed fields. Fact keys are derived from it.
export const ClaimContent = z.object({
  // An ontology type id, validated against the registry before routing.
  type: z.string().min(1),
  subject: LocalEntityId,
  // Typed fields for this type, as the ontology defines them.
  fields: z.record(z.string(), z.unknown()),
  // Most facts are true within a project or initiative, not globally.
  context: z.object({ kind: z.enum(["project", "organization", "global"]), id: LocalEntityId.optional() }).optional(),
});
export type ClaimContent = z.infer<typeof ClaimContent>;

// One key the subject was resolved by, as the store may look it up: a keyed fingerprint of an
// address or a source id, made by `aliasFingerprint` ("@intelligence/contracts/alias-key"),
// or a name as the evidence wrote it. Never the address or the source id itself. A name is
// stored as search text, so it is bounded.
export const SubjectAlias = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["address", "source_id"]), fingerprint: Fingerprint }),
  // A name whose normal form is empty (white space only) names no one, and could not be
  // fingerprinted. The test is the emptiness of `aliasKeyNormal("name", value)`, which no
  // collapsing or lower-casing changes; that function stays in its own entry point.
  z.strictObject({
    kind: z.literal("name"),
    value: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.normalize("NFKC").trim() !== "", { message: "a name alias is white space only" }),
  }),
]);
export type SubjectAlias = z.infer<typeof SubjectAlias>;

// One statement from one source. The authority. Never merged or edited.
export const Claim = z
  .object({
    id: ClaimId,
    content: ClaimContent,
    statementKind: StatementKind,
    basis: BasisType,
    // Who made the statement, resolved through the identity service.
    assertedBy: LocalEntityId.optional(),
    // When the statement was true in the world, not when it arrived.
    validFrom: Timestamp,
    validTo: Timestamp.optional(),
    evidence: z.array(Passage).min(1),
    // The item it was extracted from. Its keys are the message's content keys.
    primaryEvidenceId: EvidenceId,
    // Covers everything the extraction read: the message and its bounded chain of replies.
    label: Label,
    destination: Store,
    pipelineVersion: z.string().min(1),
    extractorGeneration: z.number().int().nonnegative(),
    changeKind: ChangeKind,
    // True for a claim from evidence the system itself produced.
    systemOriginated: z.boolean(),
    origin: ClaimOrigin,
    // The identity service's epoch when the subject was resolved.
    identityEpoch: z.number().int().nonnegative(),
    // The keys the subject was resolved by, for the store's alias and search rows. Sealed and
    // labelled with the claim, never stored on it. Left out, the store writes no key.
    subjectAliases: z.array(SubjectAlias).max(8).optional(),
  })
  .refine((claim) => claim.evidence.some((passage) => passage.evidenceId === claim.primaryEvidenceId), {
    message: "no passage cites the primary evidence id",
    path: ["primaryEvidenceId"],
  });
export type Claim = z.infer<typeof Claim>;
