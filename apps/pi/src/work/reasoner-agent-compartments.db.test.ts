import type { CardId, PersonalTool, PersonalView, RunId } from "@intelligence/contracts/personal";
import { autonomyRules } from "@intelligence/personal-core/planner";
import { EXTRACT_GENERATION, type ExtractDeps, processItem } from "@intelligence/personal-extract";
import { decide, REGISTRY, wakeWorthRun } from "@intelligence/personal-ladder";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createDispatch,
  createPipeline,
  createReader,
  createWork,
  createWriter,
  type Dispatch,
  ensureJournal,
  journalPath,
  loadKeys,
  type Pipeline,
  type Reader,
  type Work,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { runTick } from "./tick.ts";

// The reasoner reads the owner's agents' compartments. A proposal `alpha` wrote and the owner confirmed is a belief of `own`
// and `agent:alpha`; a reasoner registered with both reads it, and its change, written to the trigger log by the after-commit
// diff, wakes one `belief_changed` run. What that run proposes carries `agent:alpha` (invariant 4), so it is listed to a client
// cleared for it and to no other.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const VIEWS: PersonalView[] = ["self", "people", "work"];
const ALPHA_TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "record", "propose_about_you", "list_opportunities"];
const BETA_TOOLS: PersonalTool[] = ["get_self", "list_opportunities"];
const REASONER_TOOLS: PersonalTool[] = [
  "get_self",
  "get_beliefs",
  "find_messages",
  "read_message",
  "next_run",
  "append_step",
  "finish_run",
];
const WIDE = ["agent:alpha", "own"];

let s: Synced;
let admin: Admin;
let reader: Reader;
let work: Work;
let pipeline: Pipeline;
let dispatch: Dispatch;
const tokens = { alpha: "", beta: "", reasoner: "" };
let serial = 0;
const request = (): string => `reasoner-agent-${String((serial += 1)).padStart(4, "0")}`;
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: EXTRACT_GENERATION,
});

// The beliefs get_self's self page serves at the owner's own tiers, for one client, as kinds
// (lines in place of `stated`; in this world only the owner's confirmed goal reaches them).
async function confirmedGoals(token: string): Promise<string[]> {
  const answer = await reader.getSelf(token);
  if (!answer.ok) throw new Error(`get_self answered ${answer.code}`);
  return (answer.value.sections ?? [])
    .flatMap((section) => section.lines)
    .filter((line) => line.tier === "owner" || line.tier === "owner_confirmed")
    .map((line) => line.kind);
}

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const keyFile = s.admin.PI_KEY_FILE ?? "";
  await addCompartmentKey(keyFile, "agent:alpha");
  const keys = await loadKeys(keyFile);
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  work = createWork({ reader, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  await ensureJournal(journalPath(keyFile));
  dispatch = createDispatch({ url: s.db.urls.work, log: quiet, journal: journalPath(keyFile) });

  tokens.alpha = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: ALPHA_TOOLS,
    })
  ).token;
  tokens.beta = (
    await admin.clients.addClient({
      name: "beta",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: BETA_TOOLS,
    })
  ).token;
  tokens.reasoner = (
    await admin.clients.addClient({
      name: "reasoner2",
      kind: "reasoner",
      runtime: "cloud",
      vendorRetention: "none",
      compartments: ["own", "agent:alpha"],
      views: VIEWS,
      tools: REASONER_TOOLS,
    })
  ).token;

  // alpha proposes a goal of scope `all`; the owner confirms its card; the next diff records it.
  const made = await reader.proposeAboutYou(tokens.alpha, {
    kind: "goal",
    fields: { domain: "interests", objective: "learn to sail" },
    scope: "all",
    requestId: request(),
  });
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const evidence = (
    await rows<{ evidence_id: string }>(
      "select evidence_id from ledger.agent_writes where kind = 'proposal' and evidence_id is not null",
    )
  ).map((row) => row.evidence_id);
  const due = (await pipeline.due(1000, EXTRACT_GENERATION)).filter((one) => evidence.includes(one.evidenceId));
  expect(due).toHaveLength(1);
  for (const one of due) expect(await processItem(one, deps())).toMatchObject({ status: "done", claims: 1 });
  // The after-commit diff, as the run ends with it: the proposal's state is the baseline.
  await pipeline.triggerPass();
  const cards = await rows<{ id: CardId }>("select id from ledger.cards where kind = 'about_you'");
  expect(cards).toHaveLength(1);
  await admin.cards.decide({ cards: cards.map((card) => card.id), answer: "confirm", requestId: request() });
  // The next run's diff: the confirm changed the belief computed under the reasoner's clearance.
  await pipeline.triggerPass();
  // The run answers with actions, in one pass (the `one_pass` planner).
  await rows("update policy.work_settings set planner = 'one_pass'");
});

afterAll(async () => {
  await dispatch?.close();
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the reasoner reads the agents' compartments", () => {
  let run: RunId;
  let opportunity: string;

  it("a reasoner registered with own and agent:alpha holds both and reads alpha's confirmed fact, which a client cleared for own alone does not", async () => {
    expect(await rows("select kind, compartments from policy.clients where name = 'reasoner2'")).toEqual([
      { kind: "reasoner", compartments: ["own", "agent:alpha"] },
    ]);
    expect(await confirmedGoals(tokens.reasoner)).toEqual(["goal"]);
    expect(await confirmedGoals(tokens.alpha)).toEqual(["goal"]);
    expect(await confirmedGoals(tokens.beta)).toEqual([]);
  });

  it("the confirmed fact's change is written to the trigger log and wakes one belief_changed run under its label", async () => {
    expect(await rows("select raise, compartments from ledger.trigger_log where raise = 'changed'")).toEqual([
      { raise: "changed", compartments: WIDE },
    ]);
    const now = new Date();
    // The rule data mutes belief_changed runs; this reads them on.
    const on = { ...autonomyRules(), beliefChangedRunsOn: true };
    const found = (await dispatch.wakeCandidates(now, on)).filter((one) => one.source === "belief_changed");
    expect(found).toEqual([
      expect.objectContaining({ source: "belief_changed", compartments: WIDE, vetoed: false, covers: [] }),
    ]);
    const [candidate] = found;
    if (candidate === undefined) throw new Error("no candidate");
    const facts = await dispatch.wakeFacts(candidate.source, now, candidate.vetoed);
    expect(wakeWorthRun(facts)).toMatchObject({ output: "run" });
    const queued = await dispatch.queueRun(candidate, decide(REGISTRY, "wake_worth_run", facts, wakeWorthRun), now);
    if (queued === null) throw new Error("no run queued");
    run = queued;
    expect(await rows("select wake_source, compartments from ledger.runs where id = $1", [run])).toEqual([
      { wake_source: "belief_changed", compartments: WIDE },
    ]);
    // The key is used up: the next tick finds no change to wake on.
    expect((await dispatch.wakeCandidates(new Date(), on)).filter((one) => one.source === "belief_changed")).toEqual(
      [],
    );
  });

  it("the run's opportunity carries agent:alpha (invariant 4), and is listed to alpha, cleared for it, and not to beta", async () => {
    const taken = await work.nextRun(tokens.reasoner, { requestId: request() });
    if (!taken.ok) throw new Error(`next_run answered ${taken.code}`);
    expect(taken.value.run).toMatchObject({ id: run, source: "belief_changed" });
    const [message] = await rows<{ id: string }>(
      "select id from knowledge.messages where compartments = '{own}' order by sent_at, id limit 1",
    );
    if (message === undefined) throw new Error("the world has no own message");
    const finished = await work.finishRun(tokens.reasoner, {
      run,
      outcome: "finished",
      output: {
        actions: [
          {
            do: "propose",
            kind: "goal_step",
            about: { kind: "owner" },
            summary: "a first step towards the confirmed goal",
            basis: [{ kind: "message", id: message.id as never }],
          },
        ],
      },
      requestId: request(),
    });
    expect(finished).toEqual({ ok: true, value: { recorded: 1, outcome: "finished" } });
    const [row] = await rows<{ id: string; compartments: string[] }>(
      "select id, compartments from ledger.opportunities where created_by = $1",
      [`run:${run}`],
    );
    expect(row?.compartments).toEqual(WIDE);
    opportunity = row?.id ?? "";

    // About the owner, so rung 0 cannot decide it: the tick raises the owner's card, and they say go.
    await admin.work.addIntent({ kinds: ["goal_step"], clients: ["alpha", "beta"] }, { requestId: request() });
    for (const client of ["alpha", "beta"])
      await admin.work.grantHarnessMode(
        { client: client as never, kind: "goal_step", stage: "investigate", mode: "act" },
        { requestId: request() },
      );
    await runTick({ dispatch, registry: REGISTRY, log: quiet, now: () => new Date() });
    const cards = await rows<{ id: CardId }>(
      "select id from ledger.cards where kind = 'opportunity_decision' and target_id = $1",
      [opportunity],
    );
    expect(cards).toHaveLength(1);
    await admin.cards.decide({ cards: cards.map((card) => card.id), answer: "go", requestId: request() });

    const listed = async (token: string): Promise<string[]> => {
      const answer = await work.listOpportunities(token, {});
      if (!answer.ok) throw new Error(`list_opportunities answered ${answer.code}`);
      return answer.value.opportunities.map((one) => one.id);
    };
    expect(await listed(tokens.alpha)).toEqual([opportunity]);
    expect(await listed(tokens.beta)).toEqual([]);
  });
});
