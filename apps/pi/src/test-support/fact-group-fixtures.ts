import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord, FactId, PersonalLogger, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  fingerprint,
  type Pipeline,
  type Reader,
  type Writer,
} from "@intelligence/personal-store";
import {
  batchOf,
  beliefsComputed,
  claimRecord,
  createTestDatabase,
  knownBy,
  MAIL,
  queryAs,
  stored,
  type TestDatabase,
} from "@intelligence/personal-store/testing";

// Synthetic data only.

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
export const OWN = ["own"];
export const BOTH = ["employer:example", "own"];
const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts"];
const VIEWS: PersonalView[] = ["self", "people", "work"];

export type FactGroupWorld = {
  db: TestDatabase;
  writer: Writer;
  pipeline: Pipeline;
  admin: Admin;
  reader: Reader;
  token: string;
  owner: string;
  items: { canary: string; solo: string; work: string };
  close(): Promise<void>;
};

export async function factGroupWorld(): Promise<FactGroupWorld> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  const personal = await writer.ensureSourceAccount(
    "personal",
    "google_mail",
    "own",
    MAIL.canary.to?.[0]?.address ?? "",
  );
  const workAccount = await writer.ensureSourceAccount(
    "work",
    "google_mail",
    "employer:example",
    MAIL.workCanary.to?.[0]?.address ?? "",
  );
  const items = {
    canary: await stored(writer, personal, MAIL.canary),
    solo: await stored(writer, personal, MAIL.solo),
    work: await stored(writer, workAccount, MAIL.workCanary),
  };
  const [row] = await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'");
  const { token } = await admin.clients.addClient({
    name: "alpha",
    runtime: "local",
    vendorRetention: "none",
    compartments: ["own"],
    views: VIEWS,
    tools: TOOLS,
  });
  return {
    db,
    writer,
    pipeline,
    admin,
    reader,
    token,
    owner: row?.id ?? "",
    items,
    async close() {
      await reader.close();
      await admin.close();
      await pipeline.close();
      await writer.close();
      await db.drop();
    },
  };
}

// One goal of the owner's in their own words, in `domain`, on a stored item, under its fact key.
export function goal(
  world: FactGroupWorld,
  evidenceId: string,
  compartment: string,
  shape: { n: number; factKey: string; objective: string; domain?: string; validFrom?: string },
): ClaimRecord {
  const base = claimRecord(evidenceId, compartment, world.owner, {
    n: shape.n,
    type: "goal",
    factKey: shape.factKey,
    validFrom: shape.validFrom ?? "2026-09-01T09:00:00.000Z",
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      id: sha256(`k3b ${evidenceId} ${shape.n}`),
      assertedBy: world.owner,
      extractorGeneration: 4,
      content: { ...base.claim.content, fields: { objective: shape.objective, domain: shape.domain ?? "career" } },
    } as unknown as Claim,
    fieldKinds: { objective: "text", domain: "enum" },
  } as ClaimRecord;
}

export const commit = async (world: FactGroupWorld, evidenceId: string, records: ClaimRecord[]): Promise<string> =>
  world.pipeline.commit(batchOf(evidenceId, records, { generation: 4 }));
export const fp = (world: FactGroupWorld, factKey: string): string => fingerprint(world.db.keys, "fact", factKey);
export const factId = (world: FactGroupWorld, record: ClaimRecord): FactId =>
  fingerprint(world.db.keys, "claim", record.claim.id) as FactId;

// When the world's beliefs are read: the old rebuild's clock, after every claim's time.
const AS_OF = "2026-10-01T12:00:00.000Z";

// The goal beliefs a reader of `clearance` is given at AS_OF, computed as a read computes them, in
// fact key order, with their stored claim ids. `adjust` changes the inputs read first (a model's
// grouping the database does not hold).
export async function beliefRows(
  world: FactGroupWorld,
  clearance: string[],
  adjust?: Parameters<typeof beliefsComputed>[4],
): Promise<
  {
    fact_key_fp: string;
    group_fp: string | null;
    members: string[] | null;
    phrase_claim: string | null;
    compartments: string[];
    status: string;
  }[]
> {
  // Every row of the run known by AS_OF, as a reader pinned to it computes its beliefs.
  await knownBy(world.db, new Date(AS_OF));
  const records = await beliefsComputed(world.db, clearance, ["goal"], AS_OF, adjust);
  return records
    .map((record) => ({
      fact_key_fp: record.factKeyFp,
      group_fp: record.group ?? null,
      members: record.members ?? null,
      phrase_claim: record.phraseClaim === undefined ? null : fingerprint(world.db.keys, "claim", record.phraseClaim),
      compartments: record.compartments,
      status: record.belief.status,
    }))
    .sort((a, b) => (a.fact_key_fp < b.fact_key_fp ? -1 : 1));
}
