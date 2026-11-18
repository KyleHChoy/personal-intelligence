import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord, ClientId, FactId, PersonalCompartment, RulingId } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { Admin } from "../admin/admin.ts";
import { newId } from "../core/ids.ts";
import { writeDecision } from "../core/queue.ts";
import { sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect } from "./cast.ts";
import { ALL_VIEWS, testId } from "./clients.ts";
import { one, type Query, session } from "./connections.ts";
import { fingerprint, queryAs } from "./database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "./items.ts";
import { batchOf } from "./pipeline-fixtures.ts";
import { recordingLogger } from "./recording.ts";
import { openStore, type TestStore } from "./store.ts";
import { evidenceIdOf, registration } from "./values.ts";

// The declassification's database tests: a store whose key file holds `declassified`, an Admin with
// an erasure journal, and hand-written commitments committed through the Pipeline as the extraction
// would hand them over. No model is called. Reserved domains only.

export const COMPARTMENTS = ["own", "employer:example", "declassified"];
const FINDER_TOOLS = ["get_self", "find_facts"];
// The agent whose client records, in the key files of the tests that need one.
export const RECORDER = "recorder";

export type World = { store: TestStore; accounts: Accounts; admin: Admin; journal: string; owner: string };

export async function inWorld(
  fn: (world: World) => Promise<void>,
  options: { compartments?: string[]; now?: Date } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-declassify-"));
  const store = await openStore({
    compartments: options.compartments ?? COMPARTMENTS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const journal = join(dir, "keys.json.erasures");
    const accounts = await connect(store.writer);
    const clock = options.now === undefined ? {} : { now: () => options.now as Date };
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal,
      recordEnabled: true,
      ...clock,
    });
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    await fn({ store, accounts, admin, journal, owner });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export const admin = <Row = Record<string, unknown>>(world: World, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(world.store.db.urls.admin, text, values);

// A stored message and its evidence id.
export async function stored(
  world: World,
  fixture: MailFixture,
  account = world.accounts.personalMail,
): Promise<string> {
  await ingestMail(world.store.writer, account, fixture);
  return evidenceIdOf(account, mailSourceId(fixture));
}

export const entityOf = async (world: World, address: string): Promise<string> =>
  one(
    await admin<{ entity_id: string }>(world, "select distinct entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(world.store.db.keys, "address", address),
    ]),
  ).entity_id;

// A commitment of the owner's, made on `evidenceId`, whose counterparty is `counterparty` (the
// owner's entity or a person's). find_facts renders it as a FactView of the contract.
export function commitment(
  world: World,
  evidenceId: string,
  compartment: string,
  options: {
    n?: number;
    counterparty?: string;
    names?: string[];
    validFrom?: string;
    thirdParty?: boolean;
    agentReported?: boolean;
    what?: string;
  } = {},
): ClaimRecord {
  const n = options.n ?? 1;
  const counterparty = options.counterparty ?? world.owner;
  const claim = {
    id: sha256(`declassify claim ${evidenceId} ${n}`),
    content: {
      type: "commitment",
      subject: world.owner,
      fields: { counterparty, what: options.what ?? `canary-declassify-${n}` },
    },
    statementKind: "stated_fact",
    basis: "explicit_self",
    validFrom: options.validFrom ?? "2026-09-01T09:00:00.000Z",
    evidence: [{ evidenceId, span: `s:${n}` }],
    primaryEvidenceId: evidenceId,
    label: { compartments: [compartment], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: options.agentReported === true,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  const named = [...new Set([...(counterparty === world.owner ? [] : [counterparty]), ...(options.names ?? [])])];
  return {
    claim,
    subjectKind: "owner",
    disclosure: options.thirdParty === true ? ["third_party"] : [],
    factKey: `declassify fact ${evidenceId} ${n}`,
    lane: "correspondence",
    fieldKinds: { counterparty: "entity", what: "text" },
    entities: named,
    origin: options.agentReported === true ? "agent_record" : "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

// The claims of one item, committed as its final answer; their keyed ids.
export async function commit(world: World, evidenceId: string, records: ClaimRecord[]): Promise<FactId[]> {
  const pipeline = createPipeline({
    url: world.store.db.urls.pipeline,
    keys: world.store.db.keys,
    log: recordingLogger().log,
  });
  try {
    const answer = await pipeline.commit(batchOf(evidenceId, records));
    if (answer !== "committed") throw new Error(`the commit was ${answer}`);
  } finally {
    await pipeline.close();
  }
  return records.map((record) => claimFp(world, record));
}

const claimFp = (world: World, record: ClaimRecord): FactId =>
  fingerprint(world.store.db.keys, "claim", record.claim.id) as FactId;

// A declassified copy of a claim, written as pi_admin in SQL with its decision, so the tests of
// a copy's end do not depend on the declassification itself.
export async function plantCopy(world: World, claim: string): Promise<string> {
  const [row] = await admin<{ evidence_id: string; type: string; valid_from: Date; compartments: string[] }>(
    world,
    "select evidence_id, type, valid_from, compartments from knowledge.claims where id = $1",
    [claim],
  );
  if (row === undefined) throw new Error("no such claim");
  const id = newId("dcl");
  await session(world.store.db.urls.admin, async (query: Query) => {
    await query("begin");
    const ruling = await writeDecision(
      query,
      {
        id: newId("rul") as RulingId,
        requestId: testId("req"),
        kind: "declassify",
        target: null,
        answer: null,
        card: null,
        supersedes: null,
        batch: false,
        labels: [],
        details: { claim: claim as FactId },
        compartments: row.compartments as PersonalCompartment[],
      },
      { now: new Date() },
    );
    const sealed = sealUnder(
      world.store.db.keys,
      ["declassified"],
      { table: "projections.declassified_facts", id, column: "fact_enc" },
      "{}",
    );
    await query(
      `insert into projections.declassified_facts (id, ruling_id, claim_fp, evidence_id, type, valid_from, created_at, fact_enc, compartments)
       values ($1, $2, $3, $4, $5, $6, now(), $7, '{declassified}')`,
      [id, ruling, claim, row.evidence_id, row.type, row.valid_from, sealed],
    );
    await query("commit");
  });
  return id;
}

// The claims whose declassified copies are stored, sorted.
export const copies = async (world: World): Promise<string[]> =>
  (
    await admin<{ claim_fp: string }>(world, "select claim_fp from projections.declassified_facts order by claim_fp")
  ).map((row) => row.claim_fp);

// A client registered by the admin, cleared for `compartments`, with find_facts (and record, for
// the agent RECORDER, whose key the store must hold); its id.
export async function finder(
  world: World,
  name: string,
  compartments: string[],
): Promise<{ id: ClientId; token: string }> {
  const tools = name === RECORDER ? [...FINDER_TOOLS, "record"] : FINDER_TOOLS;
  const { token } = await world.admin.clients.addClient(
    registration(name, compartments, { views: ALL_VIEWS as never, tools: tools as never }),
  );
  const id = one(await admin<{ id: string }>(world, "select id from policy.clients where name = $1", [name])).id;
  return { id: id as ClientId, token };
}
