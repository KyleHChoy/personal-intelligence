import type { CardId, PersonalTool, PersonalView, RunId } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION, type ExtractDeps, processItem } from "@intelligence/personal-extract";
import { decide, REGISTRY, wakeWorthRun } from "@intelligence/personal-ladder";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
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

// The planner proposes an owner_question that tests a hypothesis; the agent that holds it asks
// the owner and records the owner's reply verbatim with answer_owner_question. The facts it states are the
// owner's own: they build beliefs of provenance owner with no card, served to a client cleared for
// the record's label, and the owner's `correct reject` takes one back. The agent sends the owner's
// words alone; the agent lane's model types them, and that answer's tier is owner_relayed.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const VIEWS: PersonalView[] = ["self", "people", "work"];
const WORK: PersonalTool[] = [
  "list_opportunities",
  "claim_opportunity",
  "plan_move",
  "report_move",
  "propose_opportunity",
];
const ALPHA_TOOLS: PersonalTool[] = ["get_self", "record", "answer_owner_question", ...WORK];
const GAMMA_TOOLS: PersonalTool[] = ["get_self", "record", "answer_owner_question", ...WORK];
const BETA_TOOLS: PersonalTool[] = ["get_self"];
const REASONER_TOOLS: PersonalTool[] = [
  "get_self",
  "find_messages",
  "read_message",
  "next_run",
  "append_step",
  "finish_run",
];
const QUOTE =
  "Rowan runs the robotics lab in Leeds and I trust him. I want to visit the lab in April, and I prefer to meet people in person.";
// What the agent lane's model types the owner's words as, keyed by the answer's evidence id once taken.
const candidate = (type: string, fields: Record<string, unknown>) => ({
  type,
  subject: { key: { kind: "address", value: "someone@example.org" }, observedAt: "2026-10-01T00:00:00Z" },
  fields,
  statementKind: "stated_fact",
  basis: "third_party",
  span: "chars:0-10",
});
const TYPED = [
  candidate("goal", { domain: "relationships", objective: "visit the lab" }),
  candidate("preference", { domain: "relationships", object: "meet people in person", polarity: "prefers" }),
];
const outputs: Record<string, unknown> = {};

let s: Synced;
let admin: Admin;
let reader: Reader;
let work: Work;
let pipeline: Pipeline;
let dispatch: Dispatch;
const tokens = { alpha: "", beta: "", gamma: "", reasoner: "" };
let serial = 0;
const request = (): string => `owner-answers-${String((serial += 1)).padStart(4, "0")}`;
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient(outputs, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: EXTRACT_GENERATION,
});
const latest = async (kind: string, id: string): Promise<string | undefined> =>
  (
    await rows<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 and event <> 'reported' order by id desc limit 1",
      [kind, id],
    )
  )[0]?.event;

// The owner's beliefs get_self's self page serves at the owner's own tiers, for one client, by kind
// (lines in place of `stated`; in this world only the owner's answers reach those tiers). An answer's
// tier is owner_relayed, below the owner's card confirmations.
async function ownerSaid(token: string): Promise<string[]> {
  const answer = await reader.getSelf(token);
  if (!answer.ok) throw new Error(`get_self answered ${answer.code}`);
  return (answer.value.sections ?? [])
    .flatMap((section) => section.lines)
    .filter((line) => line.tier === "owner_relayed")
    .map((line) => line.kind)
    .sort();
}

let message = "";
let entity = "";

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const keyFile = s.admin.PI_KEY_FILE ?? "";
  for (const name of ["alpha", "gamma"]) await addCompartmentKey(keyFile, `agent:${name}`);
  const keys = await loadKeys(keyFile);
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  work = createWork({ reader, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  await ensureJournal(journalPath(keyFile));
  dispatch = createDispatch({ url: s.db.urls.work, log: quiet, journal: journalPath(keyFile) });
  const add = async (
    name: string,
    tools: PersonalTool[],
    compartments: string[],
    kind: "agent" | "reasoner" = "agent",
  ) =>
    (
      await admin.clients.addClient({
        name,
        kind,
        runtime: "local",
        vendorRetention: "none",
        compartments,
        views: VIEWS,
        tools,
      })
    ).token;
  // The reasoner reads alpha's compartment, so its hypothesis is labelled as widely as alpha's test of it,
  // and the test counts. gamma shares alpha's compartment, so it sees the question and may claim it; beta
  // does not.
  tokens.alpha = await add("alpha", ALPHA_TOOLS, ["own"]);
  tokens.gamma = await add("gamma", GAMMA_TOOLS, ["own", "agent:alpha"]);
  tokens.beta = await add("beta", BETA_TOOLS, ["own"]);
  tokens.reasoner = await add("reasoner3", REASONER_TOOLS, ["own", "agent:alpha"], "reasoner");
  const [mail] = await rows<{ id: string }>(
    "select id from knowledge.messages where compartments = '{own}' and not held order by sent_at, id limit 1",
  );
  const [person] = await rows<{ entity_id: string }>(
    "select a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.compartments = '{own}' order by a.entity_id limit 1",
  );
  if (mail === undefined || person === undefined) throw new Error("the world has no own message or person");
  message = mail.id;
  entity = person.entity_id;
  // These runs answer with actions, in one pass (the `one_pass` planner).
  await rows("update policy.work_settings set planner = 'one_pass'");
});

afterAll(async () => {
  await dispatch?.close();
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the owner's answers count directly", () => {
  let run: RunId;
  let opportunity = "";
  let hypothesis = "";
  let recordId = "";

  it("the planner proposes an owner_question that names its hypothesis; one that names none is refused", async () => {
    const facts = await admin.work.wakeFacts({});
    run = await admin.work.queueRequestedRun({}, decide(REGISTRY, "wake_worth_run", facts, wakeWorthRun), {
      requestId: request(),
    });
    const taken = await work.nextRun(tokens.reasoner, { requestId: request() });
    if (!taken.ok) throw new Error(`next_run answered ${taken.code}`);
    const basis = [{ kind: "message" as const, id: message as never }];
    const investigate = {
      do: "investigate" as const,
      kind: "open_loop" as const,
      about: { kind: "entity" as const, id: entity as never },
      summary: "The owner may want to meet this person about the lab.",
      basis,
    };
    const question = {
      do: "propose" as const,
      kind: "owner_question" as const,
      about: { kind: "entity" as const, id: entity as never },
      summary: "What do you know about this person?",
      basis,
    };
    expect(
      await work.finishRun(tokens.reasoner, {
        run,
        outcome: "finished",
        output: { actions: [investigate, question] },
        requestId: request(),
      }),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect(
      await work.finishRun(tokens.reasoner, {
        run,
        outcome: "finished",
        output: { actions: [investigate, { ...question, hypothesis: 0 }] },
        requestId: request(),
      }),
    ).toEqual({
      ok: true,
      value: { recorded: 2, outcome: "finished" },
    });
    const [row] = await rows<{ id: string; hypothesis_id: string }>(
      "select id, hypothesis_id from ledger.opportunities where created_by = $1 and kind = 'owner_question'",
      [`run:${run}`],
    );
    if (row === undefined) throw new Error("no owner_question");
    opportunity = row.id;
    hypothesis = row.hypothesis_id;
    expect(await latest("hypothesis", hypothesis)).toBe("open");
    // A client's proposal of one names a hypothesis too.
    const unnamed = {
      kind: "owner_question" as const,
      about: { kind: "entity" as const, id: entity as never },
      summary: "What do you know about this person?",
      basis,
    };
    expect(await work.proposeOpportunity(tokens.alpha, { ...unnamed, requestId: request() })).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "question_unpaid",
    });
    expect(
      await work.proposeOpportunity(tokens.alpha, {
        ...unnamed,
        tried: {
          searches: [{ tool: "find_messages", query: "the lab" }],
          sources: [message as never],
          why: "The message does not say how the owner knows them.",
        },
        requestId: request(),
      }),
    ).toEqual({ ok: false, code: "invalid_request" });
    // Neither wrote a question: the planner's stands alone.
    expect(
      (await rows<{ id: string }>("select id from ledger.opportunities where kind = 'owner_question'")).map(
        (one) => one.id,
      ),
    ).toEqual([opportunity]);
  });

  it("the owner says go; alpha claims it and plans its one stage", async () => {
    await admin.work.addIntent({ kinds: ["owner_question"], clients: ["alpha", "gamma"] }, { requestId: request() });
    for (const client of ["alpha", "gamma"])
      await admin.work.grantHarnessMode(
        { client: client as never, kind: "owner_question", stage: "investigate", mode: "act" },
        { requestId: request() },
      );
    await runTick({ dispatch, registry: REGISTRY, log: quiet, now: () => new Date() });
    const cards = await rows<{ id: CardId }>(
      "select id from ledger.cards where kind = 'opportunity_decision' and target_id = $1",
      [opportunity],
    );
    expect(cards).toHaveLength(1);
    await admin.cards.decide({ cards: cards.map((card) => card.id), answer: "go", requestId: request() });
    const claimed = await work.claimOpportunity(tokens.alpha, { id: opportunity as never, requestId: request() });
    expect(claimed.ok && claimed.value.opportunity).toMatchObject({
      kind: "owner_question",
      stage: "investigate",
      summary: { untrusted: "What do you know about this person?" },
    });
  });

  it("only the holder answers, with a cleared move, and the store keeps the owner's words alone", async () => {
    const args = {
      opportunity: opportunity as never,
      answer: { quote: QUOTE, about: "supports" as const },
      requestId: request(),
    };
    // No cleared move yet: told which step is missing.
    expect(await reader.answerOwnerQuestion(tokens.alpha, args)).toEqual({
      ok: false,
      code: "not_found",
      refusal: "move_not_cleared",
    });
    expect(
      (
        await work.planMove(tokens.alpha, {
          opportunity: opportunity as never,
          stage: "investigate",
          requestId: request(),
        })
      ).ok,
    ).toBe(true);
    // Not the holder.
    expect(await reader.answerOwnerQuestion(tokens.gamma, { ...args, requestId: request() })).toEqual({
      ok: false,
      code: "not_found",
      refusal: "work_not_held",
    });
    // A client without the work view, or the tool, is not permitted.
    expect(await reader.answerOwnerQuestion(tokens.beta, { ...args, requestId: request() })).toEqual({
      ok: false,
      code: "not_permitted",
    });
    expect(await rows("select id from ledger.agent_writes where kind = 'answer'")).toEqual([]);

    // A policy's go is no go of the owner's: the one step an answer still waits on is theirs.
    const goBy = (who: "policy" | "owner") =>
      rows(
        `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason)
         select $1, $2, o.compartments, o.id, 'go', $2, $3, 'owner_answer' from ledger.opportunities o where o.id = $4`,
        [request(), who, who === "owner" ? 4 : 0, opportunity],
      );
    await goBy("policy");
    expect(await reader.answerOwnerQuestion(tokens.alpha, { ...args, requestId: request() })).toEqual({
      ok: false,
      code: "not_found",
      refusal: "question_needs_owner_go",
    });
    await goBy("owner");

    const answered = await reader.answerOwnerQuestion(tokens.alpha, args);
    if (!answered.ok) throw new Error(`answer_owner_question answered ${answered.code}`);
    recordId = answered.value.recordId;
    // A retry is the same answer; a second answer is refused.
    expect(await reader.answerOwnerQuestion(tokens.alpha, args)).toEqual({ ok: true, value: { recordId } });
    expect(await reader.answerOwnerQuestion(tokens.alpha, { ...args, requestId: request() })).toEqual({
      ok: false,
      code: "not_found",
      refusal: "question_answered",
    });

    expect(
      await rows("select kind, tool, opportunity_id, compartments from ledger.agent_writes where id = $1", [recordId]),
    ).toEqual([
      {
        kind: "answer",
        tool: "answer_owner_question",
        opportunity_id: opportunity,
        compartments: ["agent:alpha", "own"],
      },
    ]);
    expect(
      await rows(
        "select kind, target_kind, target_id, answer, compartments from knowledge.owner_decisions where request_id = $1",
        [recordId],
      ),
    ).toEqual([
      {
        kind: "owner_answer",
        target_kind: "opportunity",
        target_id: opportunity,
        answer: "supports",
        compartments: ["agent:alpha", "own"],
      },
    ]);
    // The test counts and supports the hypothesis; the opportunity is done.
    expect(
      await rows("select result, counts from ledger.hypothesis_tests where hypothesis_id = $1", [hypothesis]),
    ).toEqual([{ result: "supports", counts: true }]);
    expect(await latest("hypothesis", hypothesis)).toBe("supported");
    expect(await latest("opportunity", opportunity)).toBe("done");
  });

  it("the owner's words, typed by the model, build beliefs at owner_relayed with no card, served to a client cleared for the label and to no other", async () => {
    const writer = createWriter({ url: s.db.urls.writer, keys: await loadKeys(s.admin.PI_KEY_FILE ?? ""), log: quiet });
    try {
      await writer.takeRecords();
    } finally {
      await writer.close();
    }
    const [taken] = await rows<{ evidence_id: string }>("select evidence_id from ledger.agent_writes where id = $1", [
      recordId,
    ]);
    const due = (await pipeline.due(1000, EXTRACT_GENERATION)).filter((one) => one.evidenceId === taken?.evidence_id);
    expect(due).toHaveLength(1);
    outputs[taken?.evidence_id ?? ""] = { claims: TYPED, narrowing: "none" };
    for (const one of due) expect(await processItem(one, deps())).toMatchObject({ status: "done", claims: 2 });
    expect(await rows("select id from ledger.cards where kind in ('about_you', 'agent_claim')")).toEqual([]);
    expect(await ownerSaid(tokens.alpha)).toEqual(["goal", "preference"]);
    expect(await ownerSaid(tokens.beta)).toEqual([]);
  });

  it("the owner's correct reject takes an answered fact's belief away", async () => {
    const [taken] = await rows<{ evidence_id: string }>("select evidence_id from ledger.agent_writes where id = $1", [
      recordId,
    ]);
    const [goal] = await rows<{ id: string }>(
      "select id from knowledge.claims where evidence_id = $1 and type = 'goal'",
      [taken?.evidence_id],
    );
    if (goal === undefined) throw new Error("no goal claim");
    await admin.facts.rejectClaim(goal.id as never, { requestId: request() });
    expect(await ownerSaid(tokens.alpha)).toEqual(["preference"]);
  });

  // The answer's effect reaches the learning loop, as the question's tests.
  it("an answer from the owner reaches the planner's next run with its effect, in the question's closed case", async () => {
    const facts = await admin.work.wakeFacts({});
    await admin.work.queueRequestedRun({}, decide(REGISTRY, "wake_worth_run", facts, wakeWorthRun), {
      requestId: request(),
    });
    const taken = await work.nextRun(tokens.reasoner, { requestId: request() });
    if (!taken.ok || taken.value.run === null) throw new Error("no run was taken");
    expect(taken.value.run.closed.find((one) => one.id === opportunity)).toMatchObject({
      kind: "owner_question",
      status: "done",
      outcome: { moves: { done: 1, failed: 0, blocked: 0 }, tests: { supports: 1, refutes: 0, inconclusive: 0 } },
    });
  });
});

// An answer's own owner_answer decision is written with the record by the agent's call, so it is no
// confirm of the owner's (invariant 5). The claim intake's claims_said check still reads the
// answer's facts at the next generation: with the decide model refusing, each fact is filed unmapped and no
// claim is kept.
describe("an answer is checked unless the owner released it", () => {
  it("an answer with Jev refusing files its facts unmapped", async () => {
    const [answer] = await rows<{ evidence_id: string }>(
      "select evidence_id from ledger.agent_writes where kind = 'answer' and evidence_id is not null order by id limit 1",
    );
    if (answer === undefined) throw new Error("no answer record");
    expect(
      await rows("select evidence_id from policy.released_records() where evidence_id = $1", [answer.evidence_id]),
    ).toEqual([]);
    const calls: string[] = [];
    const refusing = fakeDecideClient(
      {
        jev_said: { said: 0.01 },
        jev_standalone: { standalone: 0.01 },
        jev_record: { quarantine: 0.01 },
        jev_recovery: { account_recovery: 0.01 },
      },
      calls,
    );
    const due = (await pipeline.due(1000, EXTRACT_GENERATION + 1)).find((one) => one.evidenceId === answer.evidence_id);
    if (due === undefined) throw new Error("not due at the next generation");
    expect(
      await processItem(due, {
        ...deps(),
        generation: EXTRACT_GENERATION + 1,
        decideModel: { model: refusing, modelId: "typesafe/jev-1.13" },
      }),
    ).toMatchObject({ status: "done", claims: 0, unmapped: 2 });
    expect(calls.filter((one) => one.startsWith("jev_said"))).not.toEqual([]);
    expect(await rows("select type from knowledge.claims where evidence_id = $1", [answer.evidence_id])).toEqual([]);
  });
});
