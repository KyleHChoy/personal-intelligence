import type { Claim } from "@intelligence/contracts";
import type { BeliefTier, ClaimRecord } from "@intelligence/contracts/personal";
import { createPipeline } from "../pipeline/pipeline.ts";
import type { Message } from "./commitment-fixtures.ts";
import { knownBy } from "./known-by.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";

// Facts about the owner for the self page's database tests, each a claim committed through the
// Pipeline, its belief computed when asked. Reserved domains and made-up words only.

// One fact about the owner: its claim's type, speaker, message, fields and their kinds, and its
// belief's values, status and tier. A speaker other than the owner is named by the claim.
export type SelfSpec = {
  key: string;
  type: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
  status?: "active" | "closed";
  tier: BeliefTier;
  // People the claim names beside its speaker: an owner's own word about someone.
  names?: string[];
  // More messages that state the same fact: one claim each, of the same key and fields, so the
  // belief cites every one (a line's since and at draw on them all).
  also?: Message[];
};

// Each spec's records, made once, so a later call that writes its belief again cites the same claims.
const made = new Map<string, ClaimRecord>();

function recordsOf(owner: string, spec: SelfSpec): ClaimRecord[] {
  return [spec.message, ...(spec.also ?? [])].map((message, index) =>
    recordOf(owner, { ...spec, message }, index === 0 ? spec.key : `${spec.key} ${index}`),
  );
}

function recordOf(owner: string, spec: SelfSpec, madeAs: string = spec.key): ClaimRecord {
  const found = made.get(madeAs);
  if (found !== undefined) return found;
  const serial = made.size + 1;
  const base = claimRecord(spec.message.evidenceId, spec.message.compartment, owner, {
    n: serial,
    type: spec.type,
    factKey: spec.key,
    validFrom: spec.message.sentAt,
    entities: [...(spec.by === owner ? [] : [spec.by]), ...(spec.names ?? [])],
  });
  const record = {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: spec.by,
      basis: spec.by === owner ? "explicit_self" : "third_party",
      // A closed one is taken back: the belief computed from it is closed.
      ...(spec.status === "closed" ? { statementKind: "reversal" } : {}),
      content: { ...base.claim.content, type: spec.type, fields: spec.fields },
    } as Claim,
    subjectKind: "owner",
    fieldKinds: spec.fieldKinds,
  } as ClaimRecord;
  made.set(madeAs, record);
  return record;
}

// Commits the specs' claims, every claim of one message in one commit (a commit replaces an item's
// claims, so a later call takes messages no earlier one did), known by the world's date; a belief
// of each is computed when asked.
export async function seedSelf(store: TestStore, owner: string, specs: SelfSpec[]): Promise<void> {
  const records = new Map(
    specs.flatMap((spec) => recordsOf(owner, spec).map((record) => [record.claim.id, record] as const)),
  );
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      if ((await pipeline.commit(batchOf(evidenceId as never, claims))) !== "committed")
        throw new Error("seedSelf: a commit failed");
  } finally {
    await pipeline.close();
  }
  // Known by the world's date, as a reader pinned to it computes its beliefs.
  await knownBy(store.db, store.now);
}

const text = { what: "text" };

// The owner's career and health, in `own` mail (`messages` its four messages, oldest first):
// the owner's role and an employee affiliation in Blake's mail, their goal with a deadline, a
// situation Pat reported, two preferences and a constraint in the owner's own words, a goal in
// health, and a closed preference. Blake is named by two career claims, Pat by one.
export function careerSpecs(people: { owner: string; blake: string; pat: string }, messages: Message[]): SelfSpec[] {
  const [first, second, third, fourth] = messages as [Message, Message, Message, Message];
  const { owner, blake, pat } = people;
  return [
    {
      key: "k3c-role",
      type: "role",
      by: blake,
      message: first,
      fields: { title: "canary-title-engineer", organization_name: "Example Labs" },
      fieldKinds: { title: "text", organization_name: "text" },
      values: {},
      tier: "source",
    },
    {
      key: "k3c-affiliation",
      type: "affiliation",
      by: blake,
      message: fourth,
      fields: { relation: "employee", organization_name: "Example Labs" },
      fieldKinds: { relation: "enum", organization_name: "text" },
      values: { relation: "employee" },
      tier: "source",
    },
    {
      key: "k3c-goal",
      type: "goal",
      by: owner,
      message: second,
      fields: { what: "canary-goal-offer", by: "2026-12-01", domain: "career" },
      fieldKinds: { ...text, by: "date", domain: "enum" },
      values: { by: "2026-12-01", domain: "career" },
      tier: "owner",
    },
    {
      key: "k3c-situation",
      type: "situation",
      by: pat,
      message: third,
      fields: { what: "canary-situation-interviewing", domain: "career" },
      fieldKinds: { ...text, domain: "enum" },
      values: { domain: "career" },
      tier: "source",
    },
    {
      key: "k3c-prefers",
      type: "preference",
      by: owner,
      message: second,
      fields: { what: "canary-pref-remote", polarity: "prefers", domain: "career" },
      fieldKinds: { ...text, polarity: "enum", domain: "enum" },
      values: { polarity: "prefers", domain: "career" },
      tier: "owner",
    },
    {
      key: "k3c-avoids",
      type: "preference",
      by: owner,
      message: second,
      fields: { what: "canary-pref-commute", polarity: "avoids", domain: "career" },
      fieldKinds: { ...text, polarity: "enum", domain: "enum" },
      values: { polarity: "avoids", domain: "career" },
      tier: "owner",
    },
    {
      key: "k3c-constraint",
      type: "constraint",
      by: owner,
      message: second,
      fields: { what: "canary-constraint-notice", until: "2026-11-15", domain: "career" },
      fieldKinds: { ...text, until: "date", domain: "enum" },
      values: { until: "2026-11-15", domain: "career" },
      tier: "owner",
    },
    {
      key: "k3c-health",
      type: "goal",
      by: owner,
      message: second,
      fields: { what: "canary-goal-marathon", by: "2027-04-01", domain: "health" },
      fieldKinds: { ...text, by: "date", domain: "enum" },
      values: { by: "2027-04-01", domain: "health" },
      tier: "owner",
    },
    {
      key: "k3c-closed",
      type: "preference",
      by: owner,
      message: second,
      fields: { what: "canary-pref-old", polarity: "prefers", domain: "career" },
      fieldKinds: { ...text, polarity: "enum", domain: "enum" },
      values: { polarity: "prefers", domain: "career" },
      status: "closed",
      tier: "owner",
    },
  ];
}
