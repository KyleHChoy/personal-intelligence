import { BELIEF_TYPES, type CardId, type PersonalTool, type PersonalView } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION, type ExtractDeps, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// The agent prompt's version 2: a finding about a person's relationship to the owner, a role and an
// affiliation, written through the reader's `record`, taken in by the writer and extracted with a
// recorded output on the production roles. Each claim key raises one agent_claim card, and the
// relationship builds an agent_reported belief only once the owner confirms its card.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const NORA = "nora.vance@example.org";
const TOOLS: PersonalTool[] = ["get_self", "find_facts", "record"];
const VIEWS: PersonalView[] = ["self", "people", "work"];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let evidence: string;
const outputs: Record<string, unknown> = {};
const calls: string[] = [];

const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient(outputs, calls),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
});
const mention = (address: string, at: string) => ({ key: { kind: "address", value: address }, observedAt: at });

type ClaimRow = { id: string; type: string; fact_key_fp: string };
const claims = () =>
  queryAs<ClaimRow>(
    s.db.urls.admin,
    "select id, type, fact_key_fp from knowledge.claims where evidence_id = $1 order by type",
    [evidence],
  );
const cards = () =>
  queryAs<{ id: CardId; target_id: string; request_id: string }>(
    s.db.urls.admin,
    "select c.id, c.target_id, c.request_id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'agent_claim' and k.evidence_id = $1",
    [evidence],
  );
// The fact keys of the agent_reported beliefs computed for each client's audience and the owner's.
const agentBeliefs = async () =>
  (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap((one) =>
    one.records.filter((record) => record.provenance === "agent_reported").map((record) => record.factKeyFp),
  );

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:alpha");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  const alpha = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  const owner = s.w.accounts.find((one) => one.label === "personal")?.address ?? "";

  const body = `${NORA} is the sister of ${owner}. ${NORA} is head of design at Alder Studio and an advisor to Cedar Works.`;
  const recorded = await reader.record(alpha, { kind: "finding", body, requestId: "prompt-v2-00000001" });
  if (!recorded.ok) throw new Error(`record answered ${recorded.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const [row] = await queryAs<{ evidence_id: string; created_at: Date }>(
    s.db.urls.admin,
    "select evidence_id, created_at from ledger.agent_writes where id = $1",
    [recorded.value.recordId],
  );
  if (row === undefined) throw new Error("not taken in");
  evidence = row.evidence_id;
  const at = row.created_at.toISOString();
  const claim = (type: string, fields: Record<string, unknown>) => ({
    type,
    subject: mention(NORA, at),
    fields,
    statementKind: "stated_fact",
    basis: "third_party",
    span: `chars:0-${body.length}`,
  });
  outputs[evidence] = {
    claims: [
      claim("relationship", { counterparty: mention(owner, at), relation: "sibling" }),
      claim("role", { title: "head of design", organization_name: "Alder Studio" }),
      claim("affiliation", { relation: "advisor", organization_name: "Cedar Works" }),
    ],
    narrowing: "none",
  };

  // The finding alone: the world's mail is not this test's.
  const due = (await pipeline.due(1000, EXTRACT_GENERATION)).find((one) => one.evidenceId === evidence);
  if (due === undefined) throw new Error("not due");
  expect(await processItem(due, deps())).toMatchObject({ status: "done", claims: 3 });
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("an agent finding about a person's relationship, role and affiliation", () => {
  // A run asks the agent record's version 3, which keeps version 2's lane and lists the owner-side
  // kinds in version 4's shape; these three types are unchanged.
  it("asks personal_agent_record@3 and stores a relationship, a role and an affiliation", async () => {
    const [call] = await queryAs<{ prompt_version: string }>(
      s.db.urls.admin,
      "select prompt_version from vault.model_calls where evidence_id = $1 and prompt_id = 'personal_agent_record'",
      [evidence],
    );
    expect(call?.prompt_version).toBe("3");
    expect((await claims()).map((one) => one.type)).toEqual(["affiliation", "relationship", "role"]);
  });

  it("raises one agent_claim card for each claim key, and no agent_reported belief before the owner answers", async () => {
    const stored = await claims();
    const raised = await cards();
    expect(raised).toHaveLength(3);
    expect(raised.map((card) => card.target_id).sort()).toEqual(stored.map((one) => one.id).sort());
    expect(new Set(raised.map((card) => card.request_id)).size).toBe(3);
    expect(await agentBeliefs()).toEqual([]);
  });

  it("builds an agent_reported relationship belief once the owner confirms its card, and none for the two they left", async () => {
    const relationship = (await claims()).find((one) => one.type === "relationship");
    const card = (await cards()).find((one) => one.target_id === relationship?.id);
    await admin.cards.decide({ cards: [card?.id as CardId], answer: "confirm", requestId: "prompt-v2-confirm-01" });
    const built = await agentBeliefs();
    expect(built.length).toBeGreaterThan(0);
    expect(new Set(built)).toEqual(new Set([relationship?.fact_key_fp]));
  });
});
