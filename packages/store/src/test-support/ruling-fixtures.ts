import type { Claim } from "@intelligence/contracts";
import type { BeliefRecord, ClaimRecord, FactId } from "@intelligence/contracts/personal";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { computedBeliefs } from "../pipeline/computed-beliefs.ts";
import { one, session } from "./connections.ts";
import { queryAs, type TestDatabase } from "./database.ts";
import { beliefRecord, claimRecord, type PipelineStore, withPipeline } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";

// What the database tests of the owner's corrections and fact vetoes share: a store with the four accounts, a
// Pipeline and an Admin, and commitment claims written by hand as the extraction would commit them. No model is
// called and nothing of @intelligence/personal-extract is imported. Reserved domains only.

export type RulingStore = PipelineStore & { admin: Admin };

export const withRulings = <T>(fn: (store: RulingStore) => Promise<T>): Promise<T> =>
  withPipeline(async (store) => {
    const admin = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
    try {
      return await fn({ ...store, admin });
    } finally {
      await admin.close();
    }
  });

// An Admin on the database for `fn`, closed when it settles.
export async function withDbAdmin<T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const made = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
  try {
    return await fn(made);
  } finally {
    await made.close();
  }
}

// An Admin whose clock stands at `now`, for `fn`, closed when it settles.
export async function withAdminAt<T>(db: TestDatabase, now: Date, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const { log } = recordingLogger();
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log, now: () => now });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

// The stored id of a claim record, the one find_facts gives and the owner's commands take.
export const factIdOf = (store: Pick<PipelineStore, "db">, record: ClaimRecord): FactId =>
  fingerprint(store.db.keys, "claim", record.claim.id) as FactId;
export const factKeyFpOf = (store: Pick<PipelineStore, "db">, factKey: string): string =>
  fingerprint(store.db.keys, "fact", factKey);

// The entity of a person by an address of theirs, under one compartment.
export async function personOf(
  store: Pick<PipelineStore, "db">,
  address: string,
  compartment: string,
): Promise<string> {
  const rows = await queryAs<{ entity_id: string }>(
    store.db.urls.admin,
    "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
    [fingerprint(store.db.keys, "address", address), [compartment]],
  );
  return one(rows).entity_id;
}

// A commitment of the owner's to `counterparty`, stated in a stored item, under its fact key.
// `n` tells claims of one item apart; a claim's id changes with its item and its generation.
export function commitment(
  evidenceId: string,
  compartment: string,
  owner: string,
  counterparty: string,
  options: { n?: number; factKey: string; what?: string; validFrom?: string; generation?: number; type?: string },
): ClaimRecord {
  const base = claimRecord(evidenceId, compartment, owner, {
    n: options.n ?? 1,
    factKey: options.factKey,
    entities: [counterparty],
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
  });
  const generation = options.generation ?? 1;
  const id =
    generation === 1
      ? base.claim.id
      : (`${base.claim.id.slice(0, 56)}${generation.toString(16).padStart(8, "0")}` as Claim["id"]);
  return {
    ...base,
    claim: {
      ...base.claim,
      id,
      extractorGeneration: generation,
      content: { ...base.claim.content, fields: { counterparty, what: options.what ?? "I will send the lamp rota." } },
    } as Claim,
    fieldKinds: { counterparty: "entity", what: "text" },
  } as ClaimRecord;
}

// The belief extraction's rebuild would give one fact key from these claims, for one compartment.
export const beliefOf = (
  store: PipelineStore,
  factKey: string,
  compartment: string,
  records: ClaimRecord[],
): BeliefRecord =>
  beliefRecord(
    factKeyFpOf(store, factKey),
    compartment,
    store.owner,
    records.map((record) => record.claim),
  );

// The beliefs of these fact keys, computed together, that a reader of `clearance` is given now, as
// pi_pipeline reads the claims and rulings: each one's fact key, status and support's claim ids.
export const beliefsUnder = (
  store: Pick<PipelineStore, "db">,
  clearance: string[],
  factKeys: string[],
): Promise<{ factKeyFp: string; status: string; support: string[] }[]> =>
  session(store.db.urls.pipeline, async (query) => {
    const [clock] = await query<{ now: Date }>("select now() as now");
    const records = await computedBeliefs(
      query,
      store.db.keys,
      clearance,
      factKeys.map((key) => factKeyFpOf(store, key)),
      (clock?.now ?? new Date()).toISOString(),
    );
    return records.map((record) => ({
      factKeyFp: record.factKeyFp,
      status: record.belief.status,
      support: [...record.belief.support].sort(),
    }));
  });

// The belief of one fact key a reader of `clearance` is given now: its status and support, or null.
export const beliefUnder = async (
  store: Pick<PipelineStore, "db">,
  clearance: string[],
  factKey: string,
): Promise<{ status: string; support: string[] } | null> => {
  const [record] = await beliefsUnder(store, clearance, [factKey]);
  return record === undefined ? null : { status: record.status, support: record.support };
};
