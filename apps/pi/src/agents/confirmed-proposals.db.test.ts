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

// Proposals the owner confirmed through a generation raise: three situations and two goals of scope
// `all`, written through the reader's propose_about_you, taken in, built by code at the generation
// before EXTRACT_GENERATION, their about_you cards confirmed. Each is its own belief of provenance
// `owner`, in the owner's audience and the proposing client's, before and after every item is
// extracted again at EXTRACT_GENERATION, with the same fact keys.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts", "record", "propose_about_you"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const PROPOSALS = [
  { kind: "situation", fields: { domain: "home", state: "moving to a new flat in the spring" } },
  { kind: "situation", fields: { domain: "family", state: "on parental leave until June" } },
  { kind: "situation", fields: { domain: "career", state: "between two jobs" } },
  { kind: "goal", fields: { domain: "health", objective: "run a half marathon" } },
  { kind: "goal", fields: { domain: "interests", objective: "learn to sail" } },
] as const;

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let token: string;
const evidence: string[] = [];

const deps = (generation: number): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation,
});

// The fact keys of the owner beliefs computed for each audience, each active client's and the
// owner's, as of the database's clock.
const ownerBeliefs = async (): Promise<{ audience: string; keys: string[] }[]> =>
  (await pipeline.sweepBeliefs(BELIEF_TYPES)).map(({ audience, records }) => ({
    audience: audience.join(),
    keys: records
      .filter((record) => record.provenance === "owner")
      .map((record) => record.factKeyFp)
      .sort(),
  }));
const claimKeys = async (): Promise<string[]> =>
  (
    await queryAs<{ fact_key_fp: string }>(
      s.db.urls.admin,
      'select fact_key_fp from knowledge.claims where evidence_id = any ($1) order by fact_key_fp collate "C"',
      [evidence],
    )
  ).map((row) => row.fact_key_fp);

// Every proposal's item, extracted at one generation, each building `claims` claims.
async function extractAt(generation: number, claims = 1): Promise<void> {
  const due = (await pipeline.due(1000, generation)).filter((one) => evidence.includes(one.evidenceId));
  expect(due).toHaveLength(PROPOSALS.length);
  for (const one of due) expect(await processItem(one, deps(generation))).toMatchObject({ status: "done", claims });
}

// What the proposing client is served of one kind, by get_beliefs, with provenance.
async function served(kind: "situation" | "goal"): Promise<string[]> {
  const answer = await reader.getBeliefs(token, { kind, state: "any" });
  if (!answer.ok) throw new Error(`get_beliefs answered ${answer.code}`);
  return answer.value.beliefs
    .filter((belief) => belief.provenance === "owner")
    .map((belief) => JSON.stringify(belief.values));
}

// What get_self's self page serves of the owner at the owner's own tiers, as kinds (its rendered
// lines; in this world only the owner's confirmed proposals reach those tiers).
async function stated(): Promise<string[]> {
  const answer = await reader.getSelf(token);
  if (!answer.ok) throw new Error(`get_self answered ${answer.code}`);
  return (answer.value.sections ?? [])
    .flatMap((section) => section.lines)
    .filter((line) => line.tier === "owner" || line.tier === "owner_confirmed")
    .map((line) => line.kind)
    .sort();
}
const KINDS = ["goal", "goal", "situation", "situation", "situation"];

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:alpha");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;

  for (const [index, one] of PROPOSALS.entries()) {
    const made = await reader.proposeAboutYou(token, {
      ...one,
      scope: "all",
      requestId: `confirmed-proposal-${String(index).padStart(4, "0")}`,
    } as never);
    if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  }
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const rows = await queryAs<{ evidence_id: string }>(
    s.db.urls.admin,
    "select evidence_id from ledger.agent_writes where kind = 'proposal' and evidence_id is not null",
  );
  evidence.push(...rows.map((row) => row.evidence_id));
  expect(evidence).toHaveLength(PROPOSALS.length);

  // The generation before the raise, as on the box before it.
  await extractAt(EXTRACT_GENERATION - 1);
  const cards = await queryAs<{ id: CardId }>(s.db.urls.admin, "select id from ledger.cards where kind = 'about_you'");
  expect(cards).toHaveLength(PROPOSALS.length);
  await admin.cards.decide({
    cards: cards.map((card) => card.id),
    answer: "confirm",
    requestId: "confirmed-proposals-01",
  });
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("confirmed proposals through a generation raise", () => {
  let before: string[];

  it("builds one owner belief for each confirmed proposal, in the owner's audience and the client's", async () => {
    before = await claimKeys();
    expect(new Set(before).size).toBe(PROPOSALS.length);
    const rows = await ownerBeliefs();
    expect(rows.map((row) => row.audience)).toContain("agent:alpha,own");
    for (const row of rows) expect(row.keys, row.audience).toEqual(before);
    expect(await served("situation")).toHaveLength(3);
    expect(await served("goal")).toHaveLength(2);
    expect(await stated()).toEqual(KINDS);
  });

  it("keeps the five beliefs after the raise to the go's generation, each claim at its version 2 key", async () => {
    // Each confirm released its proposal, so the raise builds each record's released claim beside
    // its own. These proposals hold their key phrase, so every claim takes its version 2 content
    // key (the version 1 key it had stays beside it, which the confirmations answer by), and the
    // record's claim and its released claim no longer share one key. What holds: the same claims,
    // the same five owner beliefs in each audience, served as before.
    await extractAt(EXTRACT_GENERATION, 2);
    const after = await claimKeys();
    expect(after).toHaveLength(before.length * 2);
    expect(after.filter((key) => before.includes(key))).toEqual([]);
    const rows = await ownerBeliefs();
    expect(rows.map((row) => row.audience)).toContain("agent:alpha,own");
    for (const row of rows) expect(row.keys, row.audience).toHaveLength(PROPOSALS.length);
    expect(await served("situation")).toHaveLength(3);
    expect(await served("goal")).toHaveLength(2);
    expect(await stated()).toEqual(KINDS);
  });
});
