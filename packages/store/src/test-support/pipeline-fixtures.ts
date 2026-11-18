import type { Belief, Claim, Timestamp } from "@intelligence/contracts";
import type {
  AgentRecordArgs,
  BeliefRecord,
  ClaimRecord,
  ExtractionCommit,
  PersonalTool,
  PersonalView,
} from "@intelligence/contracts/personal";
import { type BeliefInputs, beliefAt } from "@intelligence/personal-beliefs";
import { sha256 } from "@intelligence/personal-core";
import { Admin } from "../admin/admin.ts";
import { sealUnder } from "../core/seal.ts";
import { readBeliefInputsUnder } from "../pipeline/belief-inputs.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import type { Writer } from "../write/writer.ts";
import { type Accounts, connect } from "./cast.ts";
import { ALL_VIEWS, sha256Hex } from "./clients.ts";
import { one, session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";
import { fingerprint, queryAs } from "./database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "./items.ts";
import { MAIL } from "./items-named.ts";
import { recordingLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";
import { openStore, type Store, type TestStore, withStore } from "./store.ts";
import { evidenceIdOf, outcomeValue, registration } from "./values.ts";

// Hand-written claim and belief records for the pipeline's database tests. No
// model is called and nothing of @intelligence/personal-extract is imported: each record is what
// that package would hand the store, written out. Reserved domains only.

export type PipelineStore = Store & {
  pipeline: Pipeline;
  accounts: Accounts;
  owner: string;
  pipelineLog: ReturnType<typeof recordingLogger>["calls"];
};

// A database with the four accounts and a writer, and a Pipeline on it as pi_pipeline.
export const withPipeline = <T>(fn: (store: PipelineStore) => Promise<T>): Promise<T> =>
  withStore(async (store) => {
    const accounts = await connect(store.writer);
    const { log, calls } = recordingLogger();
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log });
    try {
      const owner = one(
        await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
      ).id;
      return await fn({ ...store, pipeline, accounts, owner, pipelineLog: calls });
    } finally {
      await pipeline.close();
    }
  });

// A stored message, and its evidence id.
export async function stored(writer: Writer, account: Accounts[keyof Accounts], fixture: MailFixture): Promise<string> {
  await ingestMail(writer, account, fixture);
  return evidenceIdOf(account, mailSourceId(fixture));
}

// The label of a row: one compartment, or a list, sorted.
const labelOf = (compartment: string | string[]): string[] =>
  Array.isArray(compartment) ? [...compartment].sort() : [compartment];

// One claim of `evidenceId`, under its compartment, or an agent record's whole label. `n` tells
// claims of one item apart.
export function claimRecord(
  evidenceId: string,
  compartment: string | string[],
  subject: string,
  options: {
    n?: number;
    type?: string;
    factKey?: string;
    entities?: string[];
    validFrom?: string;
    origin?: "source" | "agent_record";
    basis?: "explicit_self" | "third_party";
  } = {},
): ClaimRecord {
  const n = options.n ?? 1;
  const type = options.type ?? "commitment";
  const claim = {
    id: sha256(`claim ${evidenceId} ${n} ${type}`),
    content: { type, subject, fields: { what: `Statement number ${n}.` } },
    statementKind: "stated_fact",
    basis: options.basis ?? "explicit_self",
    validFrom: options.validFrom ?? "2026-09-01T09:00:00.000Z",
    evidence: [{ evidenceId, span: `s:${n}` }],
    primaryEvidenceId: evidenceId,
    label: { compartments: labelOf(compartment), readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: options.factKey ?? `fact ${evidenceId} ${n}`,
    lane: "correspondence",
    fieldKinds: { what: "text" },
    entities: options.entities ?? [],
    origin: options.origin ?? "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// The final answer for an item: `done` with these claims, unless said otherwise.
export const batchOf = (
  evidenceId: string,
  claims: ClaimRecord[],
  options: Partial<ExtractionCommit> = {},
): ExtractionCommit =>
  ({
    evidenceId,
    generation: 1,
    lane: "correspondence",
    status: "done",
    claims,
    unmapped: [],
    unresolved: 0,
    ...options,
  }) as ExtractionCommit;

// A stand-in sixty days on: no lifecycle limit is read here.
export const reviewAfterOf = (at: string): string => new Date(Date.parse(at) + 60 * 86_400_000).toISOString();

// A belief over claims, as buildBelief would give one, for one fact key fingerprint.
export function beliefRecord(
  factKeyFp: string,
  compartment: string | string[],
  subject: string,
  claims: Claim[],
  options: { status?: Belief["status"]; provenance?: BeliefRecord["provenance"] } = {},
): BeliefRecord {
  const support = claims.map((claim) => claim.id).sort();
  const belief = {
    kind: "commitment",
    factKey: factKeyFp,
    supportHash: sha256(support.join("\n")),
    subject,
    type: "commitment",
    values: {},
    label: { compartments: labelOf(compartment), readers: ["m-owner"] },
    status: options.status ?? "active",
    disputed: false,
    confidence: 1,
    lastConfirmedAt: "2026-09-01T09:00:00.000Z",
    changeKind: "backfill",
    support,
  } as unknown as Belief;
  return {
    belief,
    factKeyFp,
    compartments: labelOf(compartment),
    provenance: options.provenance ?? "source",
  } as BeliefRecord;
}

// The beliefs of every fact key of `types` whose claims a reader of `clearance` may see, as that
// reader is given them at `asOf`: computed as a read computes them (its inputs, then beliefAt), as
// pi_pipeline. `adjust`, when given, changes the inputs first, for a test that hands the build an
// input the database does not hold (a model's grouping, say).
export function beliefsComputed(
  db: TestDatabase,
  clearance: readonly string[],
  types: readonly string[],
  asOf: string,
  adjust: (inputs: BeliefInputs) => BeliefInputs = (inputs) => inputs,
): Promise<BeliefRecord[]> {
  const sorted = [...clearance].sort();
  return session(db.urls.pipeline, async (query) => {
    const keyed = await query<{ fact_key_fp: string }>(
      "select distinct fact_key_fp from knowledge.claims where type = any ($1::text[]) and compartments <@ $2::text[] order by 1",
      [[...types], sorted],
    );
    const factKeys = keyed.map((row) => row.fact_key_fp);
    if (factKeys.length === 0) return [];
    const inputs = await readBeliefInputsUnder(query, db.keys, sorted, factKeys, asOf);
    return beliefAt(adjust(inputs), sorted, factKeys, asOf as Timestamp);
  });
}

// One row of each of the nine extraction tables, and a filed mention, for a stored item, carrying
// the canary text, written through the Pipeline with hand-written records; the review, which only
// the owner's command writes, in SQL as pi_admin.
export async function seedExtraction(
  db: TestDatabase,
  evidenceId: string,
  canary: { address: string; text: string; subject: string },
): Promise<void> {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    const owner = one(
      await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    const compartment =
      one(
        await queryAs<{ compartments: string[] }>(
          db.urls.admin,
          "select compartments from vault.evidence_items where id = $1",
          [evidenceId],
        ),
      ).compartments[0] ?? "";
    const person = one(
      await queryAs<{ entity_id: string }>(
        db.urls.admin,
        "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
        [fingerprint(db.keys, "address", canary.address), [compartment]],
      ),
    ).entity_id;
    const record = claimRecord(evidenceId, compartment, owner, { entities: [person] });
    const claim = {
      ...record,
      claim: { ...record.claim, content: { ...record.claim.content, fields: { what: canary.text } } },
    };
    // A filed name mention, the canary subject as its name.
    await pipeline.commit(
      batchOf(evidenceId, [claim as never], {
        unmapped: [{ id: canary.subject, proposedType: "commitment", reason: "bad_fields" }],
        mentions: [{ name: canary.subject, type: "role", field: "subject" }],
      }),
    );
    await pipeline.calls("configured/model").save({
      key: {
        evidenceId,
        revision: 0,
        extractorGeneration: 0,
        promptId: "personal_correspondence",
        promptVersion: "1",
        inputHash: "a".repeat(64),
      },
      keys: [{ evidenceId, keyRef: "personal-unsealed" }],
      renderedInput: "",
      rawOutput: JSON.stringify({ claims: [{ what: canary.text }], narrowing: "none" }),
      outputHash: "b".repeat(64),
      label: { compartments: [compartment], readers: ["m-owner"] },
      origin: "live",
    } as never);
    await pipeline.recordUsage({
      promptId: "personal_correspondence",
      promptVersion: "1",
      modelId: "configured/model",
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1,
      outcome: "ok",
      evidenceId: evidenceId as never,
    });
    await pipeline.recordRun({
      code: "ok",
      counts: {
        done: 1,
        skipped: 0,
        withheld: 0,
        failed: 0,
        waiting: 0,
        claims: 1,
        unmapped: 1,
        unresolved: 0,
        liveCalls: 1,
        beliefs: 1,
        beliefsChanged: 1,
        beliefsMixed: 0,
        beliefsFailed: 0,
        beliefsRemoved: 0,
        rebuildMs: 0,
      },
    });
    await session(db.urls.admin, (query) => seeder(db, query).review([compartment], evidenceId));
  } finally {
    await pipeline.close();
  }
}

// The rows of a table, as pi_admin.
export const rowsOf = <Row = Record<string, unknown>>(
  db: TestDatabase,
  sql: string,
  values?: unknown[],
): Promise<Row[]> => queryAs<Row>(db.urls.admin, sql, values);
// One statement as pi_owner, the role the work tools' definers write ledger rows as: seed work.
export const asOwner = <Row = Record<string, unknown>>(
  db: TestDatabase,
  sql: string,
  values?: unknown[],
): Promise<Row[]> =>
  session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    return query<Row>(sql, values);
  });

export const countOf = async (db: TestDatabase, table: string, where = "true", values?: unknown[]): Promise<number> =>
  one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table} where ${where}`, values)).n;

// A card's latest record event, as pi_admin.
export const cardStateOf = async (world: { db: TestDatabase }, card: string): Promise<string | undefined> =>
  (
    await rowsOf<{ event: string }>(
      world.db,
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [card],
    )
  )[0]?.event;

// An evidence item's compartments, as pi_admin.
export const evidenceLabelOf = async (world: { db: TestDatabase }, evidence: string): Promise<string[]> =>
  one(
    await rowsOf<{ compartments: string[] }>(world.db, "select compartments from vault.evidence_items where id = $1", [
      evidence,
    ]),
  ).compartments;

export { MAIL };

// ---------------------------------------------------------------------------------------------
// Agent records in the pipeline: written through the reader's `record`, taken
// in by the writer's `takeRecords`, as a client and a sync would.
// ---------------------------------------------------------------------------------------------

export const AGENT_COMPARTMENTS = ["own", "employer:example", "agent:alpha", "agent:beta", "agent:gamma"];
const AGENT_TOOLS = ["get_self", "find_messages", "read_message", "find_facts", "record"] as PersonalTool[];

export type AgentWorld = PipelineStore & {
  store: TestStore;
  admin: Admin;
  reader: Reader;
  // A token for a client registered with record, under its clearance; once per name.
  token(name: string, clearance?: string[], views?: PersonalView[]): Promise<string>;
  // An agent record written by that client and taken in: its id and its evidence id.
  record(
    name: string,
    options?: { kind?: AgentRecordArgs["kind"]; body?: string; cites?: string[]; clearance?: string[] },
  ): Promise<{ record: string; evidence: string }>;
};

let written = 0;

export async function withAgents<T>(
  fn: (world: AgentWorld) => Promise<T>,
  options: { compartments?: string[] } = {},
): Promise<T> {
  const store = await openStore({ compartments: options.compartments ?? AGENT_COMPARTMENTS });
  const { log, calls } = recordingLogger();
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log });
  try {
    const accounts = await connect(store.writer);
    const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
    const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log });
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    const tokens = new Map<string, string>();
    const token = async (
      name: string,
      clearance: string[] = ["own"],
      views: PersonalView[] = ALL_VIEWS as PersonalView[],
    ): Promise<string> => {
      const known = tokens.get(name);
      if (known !== undefined) return known;
      const { token: made } = await admin.clients.addClient(
        registration(name, clearance, { tools: AGENT_TOOLS, views }),
      );
      tokens.set(name, made);
      return made;
    };
    const world: AgentWorld = {
      db: store.db,
      writer: store.writer,
      logged: [],
      store,
      admin,
      reader,
      pipeline,
      accounts,
      owner,
      pipelineLog: calls,
      token,
      async record(name, given = {}) {
        written += 1;
        const recorded = outcomeValue(
          await reader.record(await token(name, given.clearance), {
            kind: given.kind ?? "finding",
            body: given.body ?? `Rhea will send the owner the plans by Friday, number ${written}.`,
            ...(given.cites === undefined ? {} : { cites: given.cites as never }),
            requestId: `agent-request-${String(written).padStart(8, "0")}`,
          }),
        ).recordId;
        await store.writer.takeRecords();
        const row = one(
          await queryAs<{ evidence_id: string | null }>(
            store.db.urls.admin,
            "select evidence_id from ledger.agent_writes where id = $1",
            [recorded],
          ),
        );
        if (row.evidence_id === null) throw new Error("the agent record was not taken in");
        return { record: recorded, evidence: row.evidence_id };
      },
    };
    return await fn(world);
  } finally {
    await pipeline.close();
    await store.close();
  }
}

// A proposal about the owner, `body` its stored body: written as a note through the reader's
// `record` by `alpha`, made a proposal by the table's owner as policy.propose_about_you would leave
// its row, then taken in. Its id and its evidence id.
export async function proposalRecord(
  world: AgentWorld,
  scope: "all" | "this_client",
  body: string,
  requestId: string,
  cites?: string[],
): Promise<{ record: string; evidence: string }> {
  const id = outcomeValue(
    await world.reader.record(await world.token("alpha"), {
      kind: "note",
      body: "a proposal to be",
      requestId,
      ...(cites === undefined ? {} : { cites: cites as never }),
    }),
  ).recordId;
  const { compartments } = one(
    await queryAs<{ compartments: string[] }>(
      world.db.urls.admin,
      "select compartments from ledger.agent_writes where id = $1",
      [id],
    ),
  );
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("alter table ledger.agent_writes no force row level security");
    try {
      await query(
        "update ledger.agent_writes set kind = 'proposal', tool = 'propose_about_you', proposal_scope = $2, body_enc = $3, content_fp = $4 where id = $1",
        [
          id,
          scope,
          sealUnder(world.db.keys, compartments, { table: "ledger.agent_writes", id, column: "body_enc" }, body),
          fingerprint(world.db.keys, "content_hash", sha256Hex(body)),
        ],
      );
    } finally {
      await query("alter table ledger.agent_writes force row level security");
    }
  });
  await world.writer.takeRecords();
  const row = one(
    await queryAs<{ evidence_id: string | null }>(
      world.db.urls.admin,
      "select evidence_id from ledger.agent_writes where id = $1",
      [id],
    ),
  );
  if (row.evidence_id === null) throw new Error("the proposal was not taken in");
  return { record: id, evidence: row.evidence_id };
}
