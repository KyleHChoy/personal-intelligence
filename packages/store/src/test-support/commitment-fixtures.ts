import type { Belief, Claim } from "@intelligence/contracts";
import type { ClaimRecord, ClientId, FactId } from "@intelligence/contracts/personal";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { sha256Hex, testId } from "./clients.ts";
import { queryAs } from "./database.ts";
import { knownBy } from "./known-by.ts";
import { batchOf, claimRecord } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import type { TestStore } from "./store.ts";
import { WORLD_NOW } from "./world.ts";

// Commitments for the readers' database tests: claims committed through the Pipeline as the
// extraction would hand them over, known by the world's date (knownBy), and the owner's rulings that
// make each computed belief stand as the test says. No model is called and nothing of
// @intelligence/personal-extract is imported: each record is written out by hand. Reserved domains
// only.

// A stored message a claim comes from.
export type Message = { id: string; evidenceId: string; sentAt: string; compartment: string };

// The world's message under `compartment` sent `days` from WORLD_NOW.
export const messageOn = (messages: Message[], days: number, compartment: string): Message => {
  const found = messages.find(
    (one) =>
      one.compartment === compartment &&
      Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === days,
  );
  if (found === undefined) throw new Error(`no ${compartment} message on day ${days}`);
  return found;
};

// One commitment: who will do it, for whom, by when, with the words and the messages of its
// claims, oldest first. The belief's status is the rebuild's to decide; here the test's.
export type CommitmentSpec = {
  key: string;
  subject: string;
  counterparty: string;
  due?: string;
  // One status for every audience, or one for each.
  status?: Belief["status"] | ((audience: string[]) => Belief["status"]);
  // Every claim's statement kind, stated_fact by default.
  statementKind?: Claim["statementKind"];
  // `at`, when given, is the claim's time in place of its message's.
  claims: { message: Message; what: string; at?: string }[];
};

export type Seeded = { fact: string; claims: string[] };

let serial = 0;

// The claim the extraction would commit for one statement of a commitment.
function commitmentClaim(spec: CommitmentSpec, one: CommitmentSpec["claims"][number], owner: string): ClaimRecord {
  serial += 1;
  const base = claimRecord(one.message.evidenceId, one.message.compartment, spec.subject, {
    n: serial,
    factKey: spec.key,
    validFrom: one.at ?? one.message.sentAt,
    entities: [spec.subject, spec.counterparty].filter((id) => id !== owner),
  });
  const fields = {
    counterparty: spec.counterparty,
    what: one.what,
    ...(spec.due === undefined ? {} : { due: spec.due }),
  };
  return {
    ...base,
    claim: {
      ...base.claim,
      content: { ...base.claim.content, fields },
      ...(spec.statementKind === undefined ? {} : { statementKind: spec.statementKind }),
    } as Claim,
    subjectKind: spec.subject === owner ? "owner" : "person",
    fieldKinds: { counterparty: "entity", what: "text", due: "date" },
  } as ClaimRecord;
}

export type Records = Map<string, ClaimRecord[]>;

// Commits each spec's claims, item by item, as one commit for each item.
export async function commitClaims(store: TestStore, owner: string, specs: CommitmentSpec[]): Promise<Records> {
  const records: Records = new Map(
    specs.map((spec) => [spec.key, spec.claims.map((one) => commitmentClaim(spec, one, owner))]),
  );
  const byItem = new Map<string, ClaimRecord[]>();
  for (const spec of specs)
    for (const record of records.get(spec.key) ?? [])
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    for (const [evidenceId, claims] of byItem) {
      const outcome = await pipeline.commit(batchOf(evidenceId as never, claims));
      if (outcome !== "committed") throw new Error(`the commit of ${evidenceId} answered ${outcome}`);
    }
  } finally {
    await pipeline.close();
  }
  return records;
}

export const seededOf = (store: TestStore, specs: CommitmentSpec[], records: Records): Map<string, Seeded> =>
  new Map(
    specs.map((spec) => [
      spec.key,
      {
        fact: fingerprint(store.db.keys, "fact", spec.key),
        claims: (records.get(spec.key) ?? []).map((record) => fingerprint(store.db.keys, "claim", record.claim.id)),
      },
    ]),
  );

// Commits each spec's claims, known by the store's date, and closes, by the owner's retire at that
// date, each spec said closed whose claims do not close it themselves (a reversal does). Every
// belief is computed when asked, so no stored row is written; `audiences` is kept for the callers'
// shape. A status that differs by audience is not seeded: each audience reads the one computation.
export async function seedCommitments(
  store: TestStore,
  owner: string,
  specs: CommitmentSpec[],
  _audiences: string[][],
): Promise<Map<string, Seeded>> {
  const records = await commitClaims(store, owner, specs);
  await knownBy(store.db, store.now);
  await closeSaidClosed(store, specs, records);
  return seededOf(store, specs, records);
}

// Each spec said closed whose claims do not close it themselves (a reversal does), closed by the
// owner's retire of its latest claim's fact key, at the store's date.
export async function closeSaidClosed(store: TestStore, specs: CommitmentSpec[], records: Records): Promise<void> {
  for (const spec of specs) {
    if (spec.status !== "closed" || spec.statementKind === "reversal") continue;
    const last = (records.get(spec.key) ?? []).at(-1);
    if (last === undefined) continue;
    await store.admin.facts.retireFact(fingerprint(store.db.keys, "claim", last.claim.id) as FactId, {
      requestId: testId("req").slice(4),
    });
  }
}

export type Client = { id: ClientId; name: string; token: string; compartments: string[] };

// A client inserted as pi_admin with the tools and views given, cleared for `clearance`.
export async function insertReader(
  store: TestStore,
  name: string,
  clearance: string[],
  options: { tools: string[]; views: string[] },
): Promise<Client> {
  const client = {
    id: testId("cli") as ClientId,
    name,
    token: `pit_test-${name}-${testId("x")}`,
    compartments: clearance,
  };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [client.id, name, sha256Hex(client.token), clearance, options.views, options.tools],
  );
  return client;
}

// The world's messages, read as pi_admin, by the day each was sent, as the facts tests read them.
export async function worldMessages(store: TestStore): Promise<Message[]> {
  const rows = await queryAs<{ id: string; evidence_id: string; sent_at: Date; compartment: string }>(
    store.db.urls.admin,
    "select id, evidence_id, sent_at, compartments[1] as compartment from knowledge.messages order by sent_at, id",
  );
  return rows.map((row) => ({
    id: row.id,
    evidenceId: row.evidence_id,
    sentAt: row.sent_at.toISOString(),
    compartment: row.compartment,
  }));
}

// One ledger.trigger_log row written as the after-commit diff writes it, as
// pi_pipeline, at `at`; its state the given one, or one of its fact and raise. The log is
// append-only: 1, the row written.
export async function logTrigger(
  store: Pick<TestStore, "db">,
  row: {
    fact: string;
    clearance: string[];
    raise: "changed" | "due" | "none";
    compartments: string[];
    at: Date;
    state?: string;
    cause?: string;
    ended?: boolean;
    anchors?: string[];
  },
): Promise<number> {
  const key = [...new Set(row.clearance)].sort().join("|");
  const state = row.state ?? fingerprint(store.db.keys, "belief_state", `${row.fact}:${row.raise}`);
  const written = await queryAs(
    store.db.urls.pipeline,
    `insert into ledger.trigger_log (fact_key_fp, clearance_key, state_fp, raise, cause, ended, anchors, compartments, written_at, raised_at)
     values ($1, $2, $3, $4::text, $5, $6, $7, $8, $9, case when $4::text = 'none' then $9::timestamptz end) returning id`,
    [
      row.fact,
      key,
      state,
      row.raise,
      row.cause ?? (row.raise === "due" ? "due" : "claim"),
      row.ended ?? false,
      row.anchors ?? [],
      row.compartments,
      row.at.toISOString(),
    ],
  );
  return written.length;
}

// A state of the fact of `claim` under `clearance`, as the after-commit diff logs it, raising
// nothing: a draft cites a fact at the latest state of its clearance. The fact key.
export async function logClaimState(
  store: Pick<TestStore, "db">,
  claim: string,
  state: string,
  clearance: string[] = ["own"],
): Promise<string> {
  const [row] = await queryAs<{ f: string }>(
    store.db.urls.admin,
    "select fact_key_fp as f from knowledge.claims where id = $1",
    [claim],
  );
  const fact = row?.f ?? "";
  await logTrigger(store, { fact, clearance, raise: "none", compartments: ["own"], at: new Date(), state });
  return fact;
}
