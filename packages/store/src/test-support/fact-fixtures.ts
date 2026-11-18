import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord, SubjectKind } from "@intelligence/contracts/personal";
import { expect } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import type { Message } from "./commitment-fixtures.ts";
import { knownBy } from "./known-by.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";
import { daysFrom } from "./values.ts";
import { storeSeeder, WORLD, WORLD_NOW } from "./world.ts";

// Claims of any fact type committed through the Pipeline; a belief of each is computed when asked.
// No model is called. For the database tests of the fact reads (get_beliefs, the timeline's facts, the match
// mode of search).

let serial = 0;

export type FactSpec = {
  key: string;
  type: string;
  // The belief kind; none, and the claim builds no belief.
  kind?: string;
  subject: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values?: Record<string, unknown>;
  entities: string[];
  status?: "active" | "stale" | "dormant";
  statementKind?: "stated_fact" | "reversal";
  // The claim's time, in place of its message's: an old one ages the belief computed from it.
  at?: string;
  // The subject's kind, when it is neither the owner nor a person (a project).
  subjectKind?: SubjectKind;
};

// One spec's claim, as the extraction would commit it; the read tests' own specs make theirs here.
export type ClaimSpec = Pick<
  FactSpec,
  | "key"
  | "type"
  | "subject"
  | "by"
  | "message"
  | "fields"
  | "fieldKinds"
  | "entities"
  | "statementKind"
  | "at"
  | "subjectKind"
>;
export function factRecordOf(spec: ClaimSpec, owner: string): ClaimRecord {
  serial += 1;
  const base = claimRecord(spec.message.evidenceId, spec.message.compartment, spec.subject, {
    n: serial,
    type: spec.type,
    factKey: spec.key,
    validFrom: spec.at ?? spec.message.sentAt,
    entities: spec.entities.filter((id) => id !== owner),
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: spec.by,
      basis: spec.by === spec.subject ? "explicit_self" : "third_party",
      statementKind: spec.statementKind ?? "stated_fact",
      content: { ...base.claim.content, type: spec.type, fields: spec.fields },
    } as Claim,
    subjectKind: spec.subjectKind ?? (spec.subject === owner ? "owner" : "person"),
    fieldKinds: spec.fieldKinds,
  } as ClaimRecord;
}

// The world's `own` mail holds four messages; the fact reads' tests cite six, the two newest these:
// Blake at -36h and Pat at -24h, after every other `own` message.
export async function moreOwnMail(store: TestStore, account: SourceAccountRow | undefined): Promise<void> {
  if (account === undefined) throw new Error("the world has no personal mailbox");
  const seed = storeSeeder(store.writer, WORLD_NOW);
  const owner = { address: WORLD.ownerPersonal };
  await seed.mail(account, {
    id: "own-blake-third",
    from: { address: WORLD.both.address, name: WORLD.both.ownName },
    to: [owner],
    at: daysFrom(WORLD_NOW, -1.5),
    subject: "canary-own-subject-third",
  });
  await seed.mail(account, {
    id: "own-pat-second",
    from: { address: WORLD.ownOnly.address, name: WORLD.ownOnly.name },
    to: [owner],
    at: daysFrom(WORLD_NOW, -1),
    subject: "canary-own-subject-pat-second",
  });
}

// Each spec's claim committed through the Pipeline, one commit for each item.
export async function commitFacts(
  store: TestStore,
  owner: string,
  specs: FactSpec[],
): Promise<Map<string, ClaimRecord>> {
  const records = new Map(specs.map((spec) => [spec.key, factRecordOf(spec, owner)]));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  // Known by the world's date, as a reader pinned to it computes its beliefs.
  await knownBy(store.db, store.now);
  return records;
}

// The specs' claims committed, known by the store's date. Every belief is computed when asked, so
// no stored row is written; `audiences` is kept for the callers' shape.
export async function seedFacts(
  store: TestStore,
  owner: string,
  specs: FactSpec[],
  _audiences: string[][],
): Promise<void> {
  await commitFacts(store, owner, specs);
}
