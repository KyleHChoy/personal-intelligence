import type { AgentRecordArgs, PersonalWork, ReportCheckCode, Stage, WorkRef } from "@intelligence/contracts/personal";
import {
  AGENT_GUIDE,
  AGENT_HOW_TO_WORK,
  doneRequires,
  INTERNAL_STAGES,
  REPORT_CHECK_HINTS,
  TOOL_NAMES,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  request,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";

// An agent's whole lifecycle over the agent API, scripted exactly as the guide's
// "How to work" section says, in its order, with every id taken from an earlier reply and never
// written in by the test. The ports are fakes that keep state: a claim before a move, a read-only
// stage, and a done report checked by the contracts' own doneRequires, a task's citing a finding
// written since the claim. If the guide's steps, tool names or the ref it tells an agent to cite
// drift from the tool surface, this fails; the store's own checks (a summary for a reason, a
// proposal as a write-back) are held by agent-tasks.db.test.ts.

const OPPORTUNITY = `opp_${ulid(41)}`;
const MESSAGE = `msg_${ulid(42)}`;
const MOVE = `mov_${ulid(43)}`;
const RECORD = `rec_${ulid(44)}`;

// The tools the guide's numbered steps name, in the order it names them.
function guideSteps(): string[] {
  const steps = AGENT_HOW_TO_WORK.split("\n").filter((line) => /^\d+\. /.test(line));
  const names: string[] = [];
  for (const step of steps)
    for (const [word] of step.matchAll(/[a-z]+(?:_[a-z]+)+|\brecord\b/g))
      if ((TOOL_NAMES as readonly string[]).includes(word) && !names.includes(word)) names.push(word);
  return names;
}

// The ref the guide tells an agent to cite its finding by, with the id it was given.
function guideRef(recordId: string): WorkRef {
  const shape = /\{"kind":"agent_record","id":"rec_\.\.\."\}/.exec(AGENT_HOW_TO_WORK)?.[0];
  if (shape === undefined) throw new Error("the guide names no agent_record ref");
  return JSON.parse(shape.replace("rec_...", recordId)) as WorkRef;
}

const task = {
  id: OPPORTUNITY,
  kind: "investigate",
  status: "go",
  about: { kind: "entity", id: `ent_${ulid(45)}` },
  summary: { untrusted: "find who runs the clinic" },
  basis: [{ kind: "message", id: MESSAGE }],
  hypothesis: null,
  goal: null,
  stage: "investigate",
  dueAt: null,
  leaseUntil: null,
  tier: "task",
  role: null,
} as const;

// The state the fakes keep, as the store would.
function world() {
  const state = { claimed: false, moves: new Set<string>(), findings: new Set<string>(), reported: false };
  const client = clientView({ tools: [...TOOL_NAMES], views: ["self", "people", "work"] });
  const { provider } = fakeProvider(client, {
    record: async (_token, args: AgentRecordArgs) => {
      if (!(args.cites ?? []).every((cite) => cite === MESSAGE)) return { ok: false, code: "not_found" };
      if (args.kind === "finding" && state.claimed) state.findings.add(RECORD);
      return { ok: true, value: { recordId: RECORD as never } };
    },
  });
  const brief = {
    kind: "investigate",
    summary: task.summary,
    goal: null,
    hypothesis: null,
    lessons: [],
    preferences: [],
    cases: [],
    done: doneRequires("investigate", "investigate", "task"),
  };
  const port: Partial<PersonalWork> = {
    listOpportunities: async () => ({ ok: true, value: { opportunities: [task] } }) as never,
    claimOpportunity: async (_token, args) => {
      if (args.id !== OPPORTUNITY) return { ok: false, code: "not_found" };
      state.claimed = true;
      return {
        ok: true,
        value: {
          opportunity: { ...task, status: "claimed", leaseUntil: "2026-10-23T10:30:00Z" },
          leaseUntil: "2026-10-23T10:30:00Z",
          brief,
        },
      } as never;
    },
    planMove: async (_token, args) => {
      if (args.opportunity !== OPPORTUNITY || !state.claimed) return { ok: false, code: "not_found" };
      if (!INTERNAL_STAGES.includes(args.stage as Stage)) return { ok: false, code: "not_permitted" };
      state.moves.add(MOVE);
      return { ok: true, value: { move: MOVE as never } };
    },
    reportMove: async (_token, args) => {
      if (!state.moves.has(args.move) || state.reported) return { ok: false, code: "not_found" };
      const cited = [...(args.report?.sources ?? []), ...(args.basis ?? [])].flatMap((one) =>
        typeof one !== "string" && one.kind === "agent_record" ? [one.id as string] : [],
      );
      const refused: ReportCheckCode[] = [];
      if (args.outcome !== "done") {
        if ((args.report?.reason ?? args.summary ?? "").trim() === "") refused.push("needs_reason");
      } else {
        for (const need of brief.done) {
          if (need === "deliverable" && !args.report?.deliverable) refused.push("needs_deliverable");
          if (need === "next" && !args.report?.next) refused.push("needs_next");
          if (need === "sources" && (args.report?.sources ?? []).length === 0) refused.push("needs_sources");
          if (need === "writeback" && !cited.some((id) => state.findings.has(id))) refused.push("needs_writeback");
        }
      }
      if (refused.length > 0) return { ok: true, value: { move: args.move, refused } } as never;
      state.reported = true;
      return { ok: true, value: { move: args.move, opportunity: "done" } } as never;
    },
  };
  const { work } = fakeWork(client, port);
  let id = 0;
  const tool = async (
    name: string,
    args: unknown,
  ): Promise<{ ok: boolean; value: Record<string, unknown>; text: string[] }> => {
    id += 1;
    const reply = (await handle({ provider, work }, fakeLog().log, TOKEN, call(name, args, id))) as {
      result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    };
    return {
      ok: reply.result.isError !== true,
      value: reply.result.structuredContent ?? {},
      text: reply.result.content.map((one) => one.text),
    };
  };
  const rpc = async (method: string): Promise<Record<string, unknown>> => {
    id += 1;
    return (
      (await handle({ provider, work }, fakeLog().log, TOKEN, request(method, undefined, id))) as {
        result: Record<string, unknown>;
      }
    ).result;
  };
  return { tool, rpc };
}

describe("an agent follows the guide's How to work over the agent API", () => {
  it("the guide's steps name, in order, the board, the claim, the move, the finding and the report", () => {
    expect(guideSteps()).toEqual(["list_opportunities", "claim_opportunity", "plan_move", "record", "report_move"]);
    expect(AGENT_GUIDE.startsWith(AGENT_HOW_TO_WORK)).toBe(true);
  });

  it("initialize serves the guide, tools/list offers every tool it names, and the lifecycle runs on ids from replies alone", async () => {
    const { tool, rpc } = world();
    expect((await rpc("initialize")).instructions).toBe(AGENT_GUIDE);
    const listed = ((await rpc("tools/list")).tools as { name: string }[]).map((one) => one.name);
    const named = TOOL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(AGENT_HOW_TO_WORK));
    expect(named).toEqual(
      expect.arrayContaining([
        ...guideSteps(),
        "release_opportunity",
        "hand_off",
        "answer_owner_question",
        "close_commitment",
        "get_commitments",
      ]),
    );
    expect(listed).toEqual(expect.arrayContaining(named));

    // 1. The board.
    const board = await tool("list_opportunities", { scope: "open" });
    const listedTask = (board.value.opportunities as { id: string; basis: WorkRef[] }[])[0];
    expect(listedTask?.id.startsWith("opp_")).toBe(true);

    // 2. The claim, with the id the board gave; brief.done says what done needs.
    const claimed = await tool("claim_opportunity", { id: listedTask?.id, requestId: "lifecycle-claim" });
    expect(claimed.ok).toBe(true);
    const opportunity = claimed.value.opportunity as { id: string; stage: Stage };
    const done = (claimed.value.brief as { done: string[] }).done;
    expect(done).toEqual(["deliverable", "next", "sources", "writeback"]);

    // 3. The move, for the stage the work is at.
    const planned = await tool("plan_move", {
      opportunity: opportunity.id,
      stage: opportunity.stage,
      requestId: "lifecycle-plan",
    });
    const move = planned.value.move as string;
    expect(move.startsWith("mov_")).toBe(true);

    // 4. The finding, citing the message the board's basis named.
    const cite = listedTask?.basis.find((ref) => ref.kind === "message")?.id;
    const recorded = await tool("record", {
      kind: "finding",
      body: "The clinic at the address in the message is run by its two founders, as the message of 2026-10-20 says.",
      cites: [cite],
      requestId: "lifecycle-record",
    });
    const recordId = recorded.value.recordId as string;
    expect(recordId.startsWith("rec_")).toBe(true);

    // 5. A report short of done is refused with each code's fix, as the guide says.
    const report = {
      deliverable: "The clinic is run by its two founders.",
      next: "Propose each founder with propose_person.",
    };
    const short = await tool("report_move", { move, outcome: "done", report, requestId: "lifecycle-short" });
    expect(short.value.refused).toEqual(["needs_sources", "needs_writeback"]);
    expect((short.value.hints as Record<string, string>).needs_writeback).toBe(REPORT_CHECK_HINTS.needs_writeback);

    // And the report the guide describes is taken: sources cite the finding by the guide's own ref.
    const reported = await tool("report_move", {
      move,
      outcome: "done",
      report: { ...report, sources: [guideRef(recordId), { kind: "message", id: cite }] },
      requestId: "lifecycle-done",
    });
    expect(reported).toMatchObject({ ok: true, value: { move, opportunity: "done" } });
  });

  it("an id not taken from a reply is refused with the fix, and a tool the client lost names tools/list", async () => {
    const { tool } = world();
    const wrong = await tool("claim_opportunity", { id: `opp_${ulid(99)}`, requestId: "lifecycle-wrong" });
    expect(wrong.text[0]).toBe("not_found");
    expect(wrong.text[1]).toContain("list_opportunities with scope open");
    const stale = await tool("a_tool_since_renamed", {});
    expect(stale.text[0]).toBe("not_permitted");
    expect(stale.text[1]).toContain("tools/list");
  });
});
