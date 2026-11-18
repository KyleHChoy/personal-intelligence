import type { TurnMessage, TurnReply, TurnRequest } from "@intelligence/contracts/personal";
import { OUTCOME_TASKS } from "@intelligence/contracts/personal";
import { recordedTurn } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { measureOnce } from "./outcome-test.ts";
import type { AgentApi } from "./ports.ts";
import { memoryLogger } from "./test-support/run-doubles.ts";

// The eight visible tasks replayed through the runner on recorded answers, with a judge that gives
// 3 to all, so each task's score is the cap code sets. The answers keep the forms a model writes:
// one in a code fence, one with prose before the object, one with its sections in title case, and a
// project answer that reads the project's own record when its client may. What it pins: none of
// those forms costs a task its score. What it cannot say: what a live model or the box's records
// score. Nothing here is real data.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ";
const id = (prefix: string, at: number) => `${prefix}_${ULID}${"0123456789ABCDEFGH"[at]}`;
const TODAY = "2026-06-15";
const RUN = "otr_01JABCDEFGHJKMNPQRSTVWXYZ2";

const REGISTERED = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
  "build_context_pack",
  "get_beliefs",
  "get_commitments",
  "read_record",
  "find_records",
  "get_open_items",
  "about",
  "find_paths",
  "list_people",
  "context",
  "get_suggestions",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
  "record_spend",
];
const PROJECT_READS = ["list_projects", "get_project"];

// What each read gives: ids only, as every tool's reply carries them.
const RESULTS: Record<string, unknown> = {
  get_self: { owner: id("ent", 0), goals: [{ id: id("gol", 1) }], lines: [{ id: id("rec", 2) }] },
  find_facts: { facts: [{ id: id("rec", 3) }, { id: id("msg", 4) }] },
  get_commitments: { commitments: [{ id: id("rec", 5), due: "2026-06-01" }, { id: id("rec", 6) }] },
  build_context_pack: { items: [{ id: id("evt", 7) }, { id: id("msg", 8) }] },
  list_people: { people: [{ id: id("ent", 9) }, { id: id("ent", 10) }, { id: id("ent", 11) }] },
  about: { entity: id("ent", 9), timeline: [{ id: id("msg", 12) }] },
  find_paths: { paths: [{ via: id("ent", 10), to: id("ent", 13) }] },
  search: { hits: [{ id: id("ent", 13) }] },
  list_projects: { projects: [{ id: id("rec", 14) }] },
  get_project: { project: id("rec", 14), decisions: [{ id: id("rec", 15) }], next: [{ id: id("rec", 16) }] },
  get_open_items: { items: [{ id: id("rec", 17) }] },
  get_suggestions: { suggestions: [{ id: id("opp", 0) }] },
};

const api = (listed: string[]) => {
  const scores: { task: string; score: number | null; failed: string[] }[] = [];
  const agent: AgentApi = {
    async listTools() {
      return listed.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object" } }));
    },
    async call(name, args) {
      const given = args as Record<string, unknown>;
      if (name === "record_spend") return { ok: true, value: { go: true } };
      if (name === "start_outcome_test")
        return { ok: true, value: { go: true, run: RUN, at: `${TODAY}T02:00:00.000Z`, heldOut: [] } };
      if (name === "record_held_out_question") return { ok: true, value: { id: `hoq_${ULID}0` } };
      if (name === "record_outcome_task") {
        if (given.heldOut === false)
          scores.push({
            task: given.task as string,
            score: given.score as number | null,
            failed: given.failed as string[],
          });
        return { ok: true, value: { recorded: true } };
      }
      return { ok: true, value: RESULTS[name] ?? {} };
    },
    async close() {},
  };
  return { agent, scores };
};

type Item = { section: string; text: string; date?: string; sources: string[] };
const item = (section: string, sources: string[], date?: string): Item => ({
  section,
  text: "a point",
  ...(date === undefined ? {} : { date }),
  sources,
});

// Per task: the reads a model makes, and its answer from what they gave.
const SCRIPTS: Record<
  string,
  { reads: string[]; fallback?: string[]; answer: (has: (tool: string) => boolean) => string }
> = {
  who_and_priorities: {
    reads: ["get_self"],
    answer: () =>
      [
        "```json",
        JSON.stringify(
          {
            answer: "Who, the work and the priorities.",
            items: [
              item("identity", [id("ent", 0)]),
              item("current_work", [id("rec", 2)]),
              item("priorities", [id("gol", 1)]),
            ],
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
  },
  recent_and_applying: {
    reads: ["get_self", "find_facts"],
    answer: () =>
      `Here is what I found from the records.\n${JSON.stringify({
        answer: "Yesterday, today and what is pursued.",
        items: [
          item("yesterday", [id("msg", 4)], "2026-06-14"),
          item("today", [id("rec", 3)], TODAY),
          item("pursuing", [id("rec", 2)]),
        ],
      })}`,
  },
  what_is_owed: {
    reads: ["get_commitments"],
    answer: () =>
      JSON.stringify({
        answer: "What is owed.",
        items: [
          item("owed", [id("rec", 5)]),
          item("owed", [id("rec", 6)]),
          item("overdue", [id("rec", 5)], "2026-06-01"),
        ],
      }),
  },
  next_meeting: {
    reads: ["build_context_pack"],
    answer: () =>
      JSON.stringify({
        answer: "The next meeting.",
        items: [
          item("Logistics", [id("evt", 7)], "2026-06-16"),
          item("Purpose", [id("evt", 7)]),
          item("History", [id("msg", 8)]),
        ],
      }),
  },
  relationships: {
    reads: ["list_people", "about"],
    answer: () =>
      JSON.stringify({
        answer: "Three close ties.",
        items: [9, 10, 11].flatMap((at) => [item("relationship", [id("ent", at)]), item("next", [id("ent", at)])]),
      }),
  },
  introductions: {
    reads: ["search", "find_paths"],
    answer: () =>
      JSON.stringify({ answer: "Who could introduce.", items: [item("path", [id("ent", 10), id("ent", 13)])] }),
  },
  projects: {
    reads: ["list_projects", "get_project"],
    // A client without the project reads finds no decision or next step: the project's facts are empty.
    fallback: ["find_facts"],
    answer: (has) =>
      has("get_project")
        ? JSON.stringify({
            answer: "Each project from its record.",
            items: [
              item("project", [id("rec", 14)]),
              item("decision", [id("rec", 15)]),
              item("next_step", [id("rec", 16)]),
            ],
          })
        : JSON.stringify({
            answer: "A project, with no record of decisions.",
            items: [item("project", [id("rec", 3)])],
            unknown: "decisions and next steps",
          }),
  },
  what_next: {
    reads: ["get_open_items", "get_suggestions"],
    answer: () =>
      JSON.stringify({
        answer: "What next.",
        items: [item("owner_next", [id("rec", 17)]), item("agent_can", [id("opp", 0)])],
      }),
  },
};

const taskOf = (messages: readonly TurnMessage[]): string => {
  const first = messages[0];
  const sections = first?.role === "user" ? (JSON.parse(first.text) as { sections: string[] }).sections : [];
  const task = OUTCOME_TASKS.find((one) => one.sections.join() === sections.join());
  if (task === undefined) throw new Error("no such task");
  return task.id;
};

// A recorded model repeats its form when told once more: the source check's prompt said "no text
// before or after it, no code fence", and a fifth of its answers still had prose before the object.
const answering = {
  turn: async (request: TurnRequest): Promise<TurnReply> => {
    const script = SCRIPTS[taskOf(request.messages)];
    if (script === undefined) throw new Error("no script");
    const offered = new Set(request.tools.map((tool) => tool.name as string));
    const read = request.messages.some((message) => message.role === "tool");
    if (!read && offered.size > 0) {
      const wanted = script.reads.filter((tool) => offered.has(tool));
      const reads = wanted.length > 0 ? wanted : (script.fallback ?? []).filter((tool) => offered.has(tool));
      return recordedTurn(
        { toolCalls: reads.map((name, at) => ({ id: `call_${at}`, name, arguments: {} })) },
        "recorded/answering",
      );
    }
    const called = new Set(
      request.messages.flatMap((message) =>
        message.role === "assistant" ? message.toolCalls.map((call) => call.name) : [],
      ),
    );
    return recordedTurn({ text: script.answer((tool) => called.has(tool)) }, "recorded/answering");
  },
};
const judging = {
  turn: async (): Promise<TurnReply> =>
    recordedTurn({ text: JSON.stringify({ score: 3, reason: "replayed" }) }, "recorded/judging"),
};

const replay = async (listed: string[]) => {
  const { agent, scores } = api(listed);
  const code = await measureOnce(
    {
      PATH: "/usr/bin:/bin",
      PI_OUTCOME_TEST: "1",
      PI_OUTCOME_TEST_MODEL: "recorded/answering",
      PI_OUTCOME_TEST_JUDGE_MODEL: "recorded/judging",
      PI_OUTCOME_TEST_MODEL_KEY: "sk-ant-synthetic-test-key-0000",
    },
    {
      startApi: async () => agent,
      model: answering,
      judge: judging,
      log: memoryLogger(),
      stderr: { write: () => true } as never,
    },
  );
  return { code, scores, total: scores.reduce((sum, one) => sum + (one.score ?? 0), 0) };
};

describe("the outcome test on recorded answers", () => {
  it("scores the visible tasks at least 18 of 24 with the project reads registered", async () => {
    const { code, scores, total } = await replay([...REGISTERED, ...PROJECT_READS]);
    expect(code).toBe(0);
    expect(scores.map((one) => one.task)).toEqual(OUTCOME_TASKS.map((one) => one.id));
    expect(scores.filter((one) => one.score !== 3)).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(18);
  });

  it("without the project reads the projects task is capped below a full score, and nothing else moves", async () => {
    const { scores } = await replay(REGISTERED);
    expect(scores.find((one) => one.task === "projects")?.score).toBe(2);
    expect(scores.filter((one) => one.task !== "projects").every((one) => one.score === 3)).toBe(true);
  });
});
