import type { TurnReply, TurnRequest } from "@intelligence/contracts/personal";
import { HELD_OUT_CLASSES, OUTCOME_SUITE, OUTCOME_TASKS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { inSections, jsonOf, measureOnce } from "./outcome-test.ts";
import { answer, fakeAgentApi, memoryLogger } from "./test-support/run-doubles.ts";

// The weekly outcome test through a fake agent API and two fake models: what it calls is the whole
// of what it may do. The store's side is in pi's outcome-test.e2e.db.test.ts.

const RUN = "otr_01JABCDEFGHJKMNPQRSTVWXYZ2";
const hoq = (at: number) => `hoq_01JABCDEFGHJKMNPQRSTVWXYZ${"0123456789ABCDEF"[at]}`;
const ENV = {
  PATH: "/usr/bin:/bin",
  PI_OUTCOME_TEST: "1",
  PI_OUTCOME_TEST_MODEL: "vendor/answering",
  PI_OUTCOME_TEST_JUDGE_MODEL: "vendor/judging",
  PI_OUTCOME_TEST_MODEL_KEY: "sk-ant-synthetic-test-key-0000",
};
// The secret words of a held-out question and its key: no log line, and no answering model, sees the key.
const SECRET_QUESTION = "A held out question only the box knows";
const SECRET_KEY = "A key only the judge reads";
const live = HELD_OUT_CLASSES.map((one, at) => ({
  id: hoq(at),
  class: one,
  question: { untrusted: `${SECRET_QUESTION} ${at}` },
  key: { untrusted: SECRET_KEY },
}));
const TOOLS = [
  "get_self",
  "get_commitments",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
  "record_spend",
];
type Handlers = Parameters<typeof fakeAgentApi>[0];
const api = (over: Handlers = {}, tools = TOOLS) =>
  fakeAgentApi(
    {
      record_spend: () => ({ ok: true, value: { go: true } }),
      start_outcome_test: () => ({
        ok: true,
        value: { go: true, run: RUN, at: "2026-06-15T02:00:00.000Z", heldOut: live },
      }),
      record_held_out_question: () => ({ ok: true, value: { id: hoq(0) } }),
      record_outcome_task: () => ({ ok: true, value: { recorded: true } }),
      get_self: () => ({ ok: true, value: { id: "ref_abcdef" } }),
      ...over,
    },
    tools,
  );
const reply = (text: string, modelId: string, costMicroUsd = 10): TurnReply => ({
  ...answer(text),
  modelId,
  costMicroUsd,
});
const fakeTurnModel = (fn: (request: TurnRequest) => TurnReply) => ({
  turn: async (request: TurnRequest) => fn(request),
});
const namesOf = (agent: ReturnType<typeof api>) => agent.log.map((one) => one.name);
const FULL = JSON.stringify({ answer: "An answer", items: [{ section: "owed", text: "x", sources: ["ref_abcdef"] }] });
const JUDGED = JSON.stringify({ score: 3, reason: "fine" });
const answering = (text = FULL) => fakeTurnModel(() => reply(text, "vendor/answering"));
const judging = (text = JUDGED, modelId = "vendor/judging") => fakeTurnModel(() => reply(text, modelId));

const run = async (
  over: { env?: Record<string, string>; api?: ReturnType<typeof api>; model?: unknown; judge?: unknown } = {},
) => {
  const logger = memoryLogger();
  const agent = over.api ?? api();
  const stderr = { write: () => true };
  const code = await measureOnce(
    { ...ENV, ...over.env },
    {
      startApi: async () => agent.api,
      model: (over.model ?? answering()) as never,
      judge: (over.judge ?? judging()) as never,
      log: logger,
      stderr: stderr as never,
    },
  );
  return { code, agent, lines: logger.events.map((one) => JSON.stringify(one)) };
};

describe("the outcome test", () => {
  it("does nothing while its switch is off", async () => {
    const { code, agent } = await run({ env: { PI_OUTCOME_TEST: "" } });
    expect(code).toBe(0);
    expect(namesOf(agent)).toEqual([]);
  });

  it("refuses a judge that is the answering model, before any call", async () => {
    const { code, agent } = await run({ env: { PI_OUTCOME_TEST_JUDGE_MODEL: "vendor/answering" } });
    expect(code).toBe(1);
    expect(namesOf(agent)).toEqual([]);
  });

  it("not due: it ends with no model call", async () => {
    let turns = 0;
    const model = fakeTurnModel(() => {
      turns += 1;
      return reply(FULL, "vendor/answering");
    });
    const agent = api({ start_outcome_test: () => ({ ok: true, value: { go: false, code: "not_due" } }) });
    const result = await run({ api: agent, model });
    expect(result.code).toBe(0);
    expect(turns).toBe(0);
  });

  it("refuses a client that holds a write or work tool beyond its own", async () => {
    const agent = api({}, [...TOOLS, "record"]);
    const { code, agent: used } = await run({ api: agent });
    expect(code).toBe(1);
    expect(namesOf(used)).not.toContain("record_outcome_task");
  });

  it("holds the two project reads, offers them, and still refuses any other work tool", async () => {
    const agent = api({}, [...TOOLS, "list_projects", "get_project"]);
    const asked: string[][] = [];
    const model = fakeTurnModel((request) => {
      asked.push(request.tools.map((tool) => tool.name));
      return reply(FULL, "vendor/answering");
    });
    const { code } = await run({ api: agent, model });
    expect(code).toBe(0);
    expect(asked[0]).toEqual(expect.arrayContaining(["list_projects", "get_project"]));
    const refused = await run({ api: api({}, [...TOOLS, "list_projects", "propose_project"]) });
    expect(refused.code).toBe(1);
  });

  it("reads an answer in a code fence, or after prose, and nothing else around it", () => {
    const value = { answer: "A", items: [] };
    expect(jsonOf(JSON.stringify(value))).toEqual(value);
    expect(jsonOf(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``)).toEqual(value);
    expect(jsonOf(`Here is what I found.\n${JSON.stringify(value)}`)).toEqual(value);
    expect(jsonOf(`${JSON.stringify(value)}\nAnd a note after it.`)).toBeUndefined();
    expect(jsonOf("not json")).toBeUndefined();
  });

  it("matches a section whatever its case or spacing, and leaves one the input never named", () => {
    const items = ["Current work", "next-step", "Elsewhere"].map((section) => ({ section, text: "x", sources: [] }));
    const sections = inSections({ answer: "A", items }, ["current_work", "next_step"]).items.map((one) => one.section);
    expect(sections).toEqual(["current_work", "next_step", "Elsewhere"]);
  });

  it("says how many tasks it means to ask, so a run cut short shows as one", async () => {
    const { agent } = await run();
    expect(agent.log.find((one) => one.name === "start_outcome_test")?.args.tasks).toBe(
      OUTCOME_TASKS.length + HELD_OUT_CLASSES.length,
    );
  });

  it("asks every visible task and every held-out question, and records each with its suite's run", async () => {
    const { code, agent } = await run();
    expect(code).toBe(0);
    const recorded = agent.log.filter((one) => one.name === "record_outcome_task").map((one) => one.args);
    expect(recorded).toHaveLength(OUTCOME_TASKS.length + HELD_OUT_CLASSES.length);
    expect(recorded.filter((one) => one.heldOut === true).map((one) => one.task)).toEqual(live.map((one) => one.id));
    const start = agent.log.find((one) => one.name === "start_outcome_test")?.args;
    expect(start?.suite).toBe(OUTCOME_SUITE);
    expect(start?.answerModel).toBe("vendor/answering");
    expect(start?.judgeModel).toBe("vendor/judging");
  });

  it("the answering model never sees a key, and the judge marks with it", async () => {
    const seenByAnswer: string[] = [];
    const seenByJudge: string[] = [];
    const model = fakeTurnModel((request) => {
      seenByAnswer.push(JSON.stringify(request));
      return reply(FULL, "vendor/answering", 1);
    });
    const judge = fakeTurnModel((request) => {
      seenByJudge.push(JSON.stringify(request));
      return reply(JUDGED, "vendor/judging", 1);
    });
    await run({ model, judge });
    expect(seenByAnswer.join()).not.toContain(SECRET_KEY);
    expect(seenByAnswer.join()).toContain(SECRET_QUESTION);
    expect(seenByJudge.join()).toContain(SECRET_KEY);
  });

  it("no log line carries a question, a key or an answer", async () => {
    const { lines } = await run();
    const log = lines.join("\n");
    expect(log).not.toContain(SECRET_QUESTION);
    expect(log).not.toContain(SECRET_KEY);
    expect(log).not.toContain("An answer");
  });

  it("code caps the score whatever the judge says: an unresolved source scores at most one", async () => {
    const made = JSON.stringify({ answer: "A", items: [{ section: "owed", text: "x", sources: ["msg_made_up"] }] });
    const { agent } = await run({ model: answering(made) });
    const first = agent.log.find((one) => one.name === "record_outcome_task")?.args;
    expect(first?.judgeScore).toBe(3);
    expect(first?.score).toBe(first?.codeCap);
    expect(first?.codeCap).toBeLessThanOrEqual(1);
    expect(first?.failed).toContain("sources_resolve");
  });

  it("a judge reply that never formed is asked once more, within the run, and scores", async () => {
    let asked = 0;
    const judge = fakeTurnModel(() => {
      asked += 1;
      // Told once in the conversation and still no form: the first two replies are one ask.
      return reply(asked <= 2 ? "not a form" : JUDGED, "vendor/judging");
    });
    const agent = api();
    await run({ api: agent, judge });
    const first = agent.log.find((one) => one.name === "record_outcome_task");
    expect(first?.args).toMatchObject({ judgeScore: 3 });
  });

  it("a judge that replies as the answering model gives no score: it never marks itself", async () => {
    const { agent } = await run({ judge: judging(JUDGED, "vendor/answering") });
    const recorded = agent.log.filter((one) => one.name === "record_outcome_task").map((one) => one.args);
    const judged = recorded.filter((one) => one.codeCap !== 0);
    expect(judged.every((one) => one.judgeScore === null && one.score === null && one.judgeModel === null)).toBe(true);
  });

  it("writes missing held-out questions with the judge's model, never the answering one", async () => {
    const agent = api({
      start_outcome_test: () => ({
        ok: true,
        value: { go: true, run: RUN, at: "2026-06-15T02:00:00.000Z", heldOut: live.slice(1) },
      }),
      record_held_out_question: () => ({ ok: true, value: { id: hoq(0) } }),
    });
    const written = JSON.stringify({ question: "A new question", key: ["a thing"] });
    const judge = fakeTurnModel((request) =>
      reply(request.system.includes("Write one question") ? written : JUDGED, "vendor/judging", 1),
    );
    const { code } = await run({ api: agent, judge });
    expect(code).toBe(0);
    const made = agent.log.filter((one) => one.name === "record_held_out_question").map((one) => one.args);
    expect(made).toHaveLength(1);
    expect(made[0]?.class).toBe(HELD_OUT_CLASSES[0]);
  });

  it("stops at its budget, and what it did not ask stays unrecorded", async () => {
    const pricey = fakeTurnModel(() => reply(FULL, "vendor/answering", 400_000));
    const { code, agent } = await run({ model: pricey, env: { PI_OUTCOME_TEST_RUN_USD: "1" } });
    expect(code).toBe(0);
    const recorded = agent.log.filter((one) => one.name === "record_outcome_task");
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.length).toBeLessThan(OUTCOME_TASKS.length);
  });

  it("past its limit on calls it is offered no tool, and answers with what it has", async () => {
    let lastTools = -1;
    const model = fakeTurnModel((request) => {
      lastTools = request.tools.length;
      if (request.tools.length === 0) return reply(FULL, "vendor/answering");
      return {
        ...reply("", "vendor/answering"),
        text: null,
        toolCalls: Array.from({ length: 13 }, (_, at) => ({ id: `c${at}`, name: "get_self", arguments: {} })),
      };
    });
    const { agent } = await run({ model });
    expect(lastTools).toBe(0);
    const first = agent.log.find((one) => one.name === "record_outcome_task")?.args;
    expect(first?.failed).not.toContain("no_answer");
    expect(first?.toolCalls).toBe(12);
  });

  it("a word in a tool's result is no citation: only an id a tool gave is", async () => {
    const made = JSON.stringify({ answer: "A", items: [{ section: "owed", text: "x", sources: ["the_tool"] }] });
    const { agent } = await run({ model: answering(made) });
    expect(agent.log.find((one) => one.name === "record_outcome_task")?.args.failed).toContain("sources_resolve");
  });

  it("a bad form is told once in the same conversation, without running its tools again", async () => {
    const seen: number[] = [];
    let turn = 0;
    const model = fakeTurnModel((request) => {
      seen.push(request.messages.length);
      turn += 1;
      return reply(turn === 1 ? "not json" : FULL, "vendor/answering");
    });
    const { agent } = await run({ model });
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
    expect(agent.log.find((one) => one.name === "record_outcome_task")?.args.failed).not.toContain("no_answer");
  });

  it("stops when the ledger says no more spend", async () => {
    const agent = api({ record_spend: () => ({ ok: true, value: { go: false } }) });
    const { code } = await run({ api: agent });
    expect(code).toBe(0);
    expect(agent.log.filter((one) => one.name === "record_outcome_task")).toHaveLength(0);
  });
});
