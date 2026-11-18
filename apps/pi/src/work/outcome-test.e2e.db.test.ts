import { join } from "node:path";
import type { TurnReply, TurnRequest } from "@intelligence/contracts/personal";
import { HELD_OUT_CLASSES, OUTCOME_TASKS } from "@intelligence/contracts/personal";
import { fakeKeyEndpoint, recordedTurn } from "@intelligence/personal-models/testing";
import { measureOnce } from "@intelligence/personal-reasoner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asBroad } from "../test-support/broad.ts";
import { type Harness, pi, READ_TOOLS, workHarness, writeWrapper } from "../test-support/work-harness.ts";

// The weekly outcome test through the real tools: its client reads through the real `pi mcp`, with the
// two project reads its registration holds, on two recorded models, and what reaches `pia outcomes`
// is scores and ids. Nothing calls a live model.

const LONG = 600_000;
const SECRET = "A held out question nobody outside the box reads";
const KEY = "What only the judge reads";
const ANSWER = "An answer only the box keeps";
// Reads get_self once, then answers citing what came back, whatever it was.
const answering = {
  turn: async (request: TurnRequest): Promise<TurnReply> => {
    const last = request.messages.at(-1);
    if (last?.role !== "tool")
      return recordedTurn({ toolCalls: [{ id: "call_0", name: "get_self", arguments: {} }] }, "recorded/answering");
    const id = /"((?:ent|msg|evt|gol)_[0-9A-Z]{26})"/.exec(last.result)?.[1] ?? "none";
    return recordedTurn(
      { text: JSON.stringify({ answer: ANSWER, items: [{ section: "identity", text: ANSWER, sources: [id] }] }) },
      "recorded/answering",
    );
  },
};
const judging = {
  turn: async (request: TurnRequest): Promise<TurnReply> =>
    recordedTurn(
      {
        text: request.system.includes("Write one question")
          ? JSON.stringify({ question: SECRET, key: [KEY] })
          : JSON.stringify({ score: 2, reason: "as the rubric says" }),
      },
      "recorded/judging",
    ),
};

describe("the outcome test, through the real tools", () => {
  let h: Harness;
  let wrapper = "";
  beforeAll(async () => {
    h = await workHarness({ queue: "request", atOnce: true });
    const added = await pi(
      [
        "clients",
        "add",
        "tester",
        ...asBroad([
          "--views",
          "self,people,work",
          "--tools",
          [
            ...READ_TOOLS,
            "list_projects",
            "get_project",
            "start_outcome_test",
            "record_held_out_question",
            "record_outcome_task",
            "record_spend",
          ].join(","),
        ]),
      ],
      h.env.admin,
    );
    if (added.exit !== 0) throw new Error(added.stderr);
    wrapper = join(h.folder, "tester-wrapper");
    await writeWrapper(wrapper, h.db.urls.reader, h.keyFile, added.stdout.trim(), h.atOnce);
  }, LONG);
  afterAll(async () => {
    await h?.cleanup();
  });

  const measure = () =>
    measureOnce(
      {
        PATH: process.env.PATH ?? "",
        PI_OUTCOME_TEST: "1",
        PI_OUTCOME_TEST_MODEL: "recorded/answering",
        PI_OUTCOME_TEST_JUDGE_MODEL: "recorded/judging",
        PI_OUTCOME_TEST_MODEL_KEY: "sk-or-synthetic-outcome-key-0000",
        PI_AGENT_API_COMMAND: wrapper,
      },
      { model: answering, judge: judging, keyFetch: fakeKeyEndpoint().fetch, log: h.log },
    );

  it(
    "runs every task, keeps words sealed, and shows scores alone; the next run waits a week",
    async () => {
      expect(await measure()).toBe(0);
      const tasks = await h.rows<{
        task: string;
        held_out: boolean;
        score: number | null;
        answer: string;
        judge: string | null;
      }>(
        "select task, held_out, score, answer_enc::text as answer, judge_model as judge from ledger.outcome_test_tasks",
      );
      expect(tasks).toHaveLength(OUTCOME_TASKS.length + HELD_OUT_CLASSES.length);
      expect(tasks.filter((one) => one.held_out)).toHaveLength(HELD_OUT_CLASSES.length);
      expect(tasks.every((one) => !one.answer.includes(ANSWER))).toBe(true);
      expect(tasks.filter((one) => one.score !== null).every((one) => one.judge === "recorded/judging")).toBe(true);
      const questions = await h.rows<{ text: string }>(
        "select question_enc::text || key_enc::text as text from ledger.held_out_questions",
      );
      expect(questions).toHaveLength(HELD_OUT_CLASSES.length);
      expect(questions.every((one) => !one.text.includes(SECRET) && !one.text.includes(KEY))).toBe(true);

      const shown = await pi(["outcomes"], h.env.admin);
      expect(shown.exit, shown.stderr).toBe(0);
      expect(shown.stdout).not.toContain(SECRET);
      expect(shown.stdout).not.toContain(KEY);
      expect(shown.stdout).not.toContain(ANSWER);
      expect(shown.stdout).not.toContain("hoq_");
      const view = JSON.parse(shown.stdout) as {
        outcomeTests: {
          limits: string;
          runs: { complete: boolean; heldOut: { count: number } }[];
          tasks: { task: string }[];
        };
      };
      expect(view.outcomeTests.limits).toContain("not that an answer is true");
      expect(view.outcomeTests.runs).toHaveLength(1);
      expect(view.outcomeTests.tasks.map((one) => one.task)).toEqual(OUTCOME_TASKS.map((one) => one.id));

      expect(await measure()).toBe(0);
      expect(await h.rows("select id from ledger.outcome_test_runs")).toHaveLength(1);
    },
    LONG,
  );
});
