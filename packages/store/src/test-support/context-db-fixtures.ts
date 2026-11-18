import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { expect } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import type { Message } from "./commitment-fixtures.ts";
import { knownBy } from "./known-by.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";

// The card context's database tests (read-card-context.db.test.ts, inv6-context.db.test.ts): claims
// committed through the Pipeline, a belief of each fact key computed when asked. No model is
// called. Reserved domains only.

// One claim of `key`; a belief of each `key` rests on all of its claims an audience sees. A claim
// cites its message's subject, so get_evidence_span has a passage to serve.
export type Spec = {
  key: string;
  kind: string;
  subject: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
  owner?: boolean;
};

let serial = 0;

function recordOf(spec: Spec, owner: string): ClaimRecord {
  serial += 1;
  const entities = [
    spec.subject,
    spec.by,
    ...Object.entries(spec.fields).flatMap(([field, value]) =>
      spec.fieldKinds[field] === "entity" ? [value as string] : [],
    ),
  ].filter((id) => id !== owner);
  const base = claimRecord(spec.message.evidenceId, spec.message.compartment, spec.subject, {
    n: serial,
    type: spec.kind,
    factKey: spec.key,
    validFrom: spec.message.sentAt,
    entities: [...new Set(entities)],
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: spec.by,
      basis: spec.by === spec.subject ? "explicit_self" : "third_party",
      evidence: [{ evidenceId: spec.message.evidenceId, span: "subject:chars:0-6" }],
      content: { ...base.claim.content, type: spec.kind, fields: spec.fields },
    } as Claim,
    subjectKind: spec.subject === owner ? "owner" : "person",
    fieldKinds: spec.fieldKinds,
  } as ClaimRecord;
}

// A committed claim with the spec it was made from.
export type Seeded = { spec: Spec; record: ClaimRecord };

// Commits the claims, known by the world's date; a belief of each key is computed when asked, from
// the claims of it the reader sees, of these and the `prior` ones. Returns every claim.
export async function seedSpecs(
  store: TestStore,
  owner: string,
  specs: Spec[],
  prior: readonly Seeded[] = [],
): Promise<Seeded[]> {
  const fresh = specs.map((spec) => ({ spec, record: recordOf(spec, owner) }));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const { record } of fresh)
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  // Known by the world's date, as a reader pinned to it computes its beliefs.
  await knownBy(store.db, store.now);
  return [...prior, ...fresh];
}

// An owner-side fact of the owner's, in one life domain, said by `by` (the owner when not given).
export const ownerSide = (
  key: string,
  kind: "goal" | "need" | "constraint" | "situation" | "capability",
  owner: string,
  message: Message,
  domain: string,
  what: string,
  by = owner,
): Spec => ({
  key,
  kind,
  subject: owner,
  by,
  message,
  fields: { what, domain },
  fieldKinds: { what: "text", domain: "enum" },
  values: { domain },
});

// A person's need, in one life domain.
export const personNeed = (key: string, subject: string, message: Message, domain: string, what: string): Spec => ({
  key,
  kind: "need",
  subject,
  by: subject,
  message,
  fields: { what, domain },
  fieldKinds: { what: "text", domain: "enum" },
  values: { domain },
});

// A person's role at an organization named only by name.
export const personRole = (key: string, subject: string, message: Message, title: string): Spec => ({
  key,
  kind: "role",
  subject,
  by: subject,
  message,
  fields: { title, organization_name: "Example Co" },
  fieldKinds: { title: "text", organization_name: "text" },
  values: {},
});
