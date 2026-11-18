import {
  type CallOptions,
  DraftMessageArgs,
  type DraftMessageResult,
  type PersonalLogger,
  type PersonalProposeTool,
  type PersonalView,
  type PersonalWork,
  PersonalWorkArgs,
  type ReadOutcome,
  type RefusalOptions,
  type RefusalWhy,
  SEND_TOOL_VIEW,
  WORK_READ_BUDGET,
  WORK_TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import { parsed } from "../core/read-tool.ts";
import {
  type Args,
  type Briefed,
  type Done,
  functionCall,
  type Result,
  type WorkCall,
  type WorkTool,
} from "../core/work-refs.ts";
import type { Reader } from "../read/read.ts";
import { changesWaiting } from "../read/read-changes.ts";
import { Unavailable } from "../read/read-ctx.ts";
import { type Isolation, toolCall, whyOf } from "../read/read-db.ts";
import { allowance } from "../read/read-quota.ts";
import { relayCardAnswer } from "./card-relay.ts";
import { getWorkTime, judgeTimeProposal, liftAnchor, liftTimeRuling, ruleTime, setAnchor } from "./work-agent-time.ts";
import { claimOpportunity, handOff, listOpportunities, releaseOpportunity } from "./work-board.ts";
import { draftMessage } from "./work-draft.ts";
import { markHealthSeen } from "./work-health-seen.ts";
import { listIdeas } from "./work-ideas.ts";
import { fileLearning } from "./work-learnings.ts";
import { listLevers, setLever } from "./work-levers.ts";
import {
  type BoxFacts,
  getHealth,
  listImprovements,
  postAgentMessage,
  readAgentInbox,
  submitImprovement,
  updateImprovement,
} from "./work-mail.ts";
import { readMeeting } from "./work-meeting.ts";
import { planMove, recordSpend, reportMove, setIntention } from "./work-moves.ts";
import { recordHeldOutQuestion, recordOutcomeTask, startOutcomeTest } from "./work-outcome-test.ts";
import { getProject, listProjects, proposeProject, updateProject } from "./work-projects.ts";
import {
  proposeGoal,
  proposeGoalTarget,
  proposeHypothesis,
  proposeOpportunity,
  proposeTask,
  recordTest,
} from "./work-propose.ts";
import { finishRun } from "./work-run-finish.ts";
import { appendStep, nextRun, takeRun } from "./work-runs.ts";
import { writeBack } from "./work-signal.ts";
import { reportWrongMerge } from "./work-wrong-merges.ts";
import { reportWrongRelation } from "./work-wrong-relations.ts";

// The agent API's work and run tools, as pi_reader inside `pi mcp`. Work holds no pool, keys or
// sessions of its own: every call runs through the reader's withClient, with the same Ctx and
// session a read gets. Here shapes are checked, ids made and summaries sealed; then one definer
// function is called, which decides the author, the label, the case, the lease and the chain of
// authority.

// The board's and the inbox's answer with how many changes wait in the caller's feed, so an
// agent that never polls get_changes learns there is something to read. Never on a refusal.
async function withWaiting<D extends Done<object>>(call: WorkCall, done: D): Promise<D> {
  if (!done.outcome.ok) return done;
  const waiting = await changesWaiting(call.ctx, call.client);
  if (waiting === null) return done;
  return { ...done, outcome: { ok: true, value: { ...done.outcome.value, changes: { waiting } } } };
}

// The view a tool of this port needs: `work` for the work and run tools, the propose tool's own.
const viewOf = (tool: WorkTool | PersonalProposeTool): PersonalView =>
  tool === "draft_message" ? SEND_TOOL_VIEW[tool] : WORK_TOOL_VIEW;
type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

// Every work tool that is one call of one function: its name, its isolation and its work.
const tool = <T extends WorkTool>(
  name: T,
  isolation: Isolation,
  work: (
    call: WorkCall,
    valid: Args<T>,
    deps: { log: PersonalLogger; now: () => Date; box?: () => BoxFacts },
  ) => Promise<Briefed<Result<T>>>,
) => ({ name, isolation, work });

const TOOLS = {
  // The reader's snapshot: one answer never disagrees with itself.
  listOpportunities: tool("list_opportunities", "repeatable read", async (call, valid, { log, now }) => {
    const listed = await withWaiting(call, await listOpportunities(call, valid, now));
    // Its measure of use: every scope is one tool in the call log.
    if (valid.scope === "closed") log.info({ event: "board_closed_read", counts: { rows: listed.rows ?? 0 } });
    return listed;
  }),
  claimOpportunity: tool("claim_opportunity", "read committed", (call, valid, { now }) =>
    claimOpportunity(call, valid, now),
  ),
  releaseOpportunity: tool("release_opportunity", "read committed", (call, valid) => releaseOpportunity(call, valid)),
  proposeHypothesis: tool("propose_hypothesis", "read committed", (call, valid) => proposeHypothesis(call, valid)),
  recordSpend: tool("record_spend", "read committed", (call, valid) => recordSpend(call, valid)),
  recordTest: tool("record_test", "read committed", (call, valid) => recordTest(call, valid)),
  proposeOpportunity: tool("propose_opportunity", "read committed", (call, valid, { log }) =>
    proposeOpportunity(call, valid, log),
  ),
  proposeGoal: tool("propose_goal", "read committed", (call, valid, { log }) => proposeGoal(call, valid, log)),
  proposeGoalTarget: tool("propose_goal_target", "read committed", (call, valid, { log }) =>
    proposeGoalTarget(call, valid, log),
  ),
  proposeTask: tool("propose_task", "read committed", (call, valid, { log }) => proposeTask(call, valid, log)),
  handOff: tool("hand_off", "read committed", (call, valid) => handOff(call, valid)),
  // Projects (work-projects.ts). The two reads take the reader's snapshot.
  proposeProject: tool("propose_project", "read committed", (call, valid) => proposeProject(call, valid)),
  updateProject: tool("update_project", "read committed", (call, valid) => updateProject(call, valid)),
  listProjects: tool("list_projects", "repeatable read", (call, valid) => listProjects(call, valid)),
  getProject: tool("get_project", "repeatable read", (call, valid, { now }) => getProject(call, valid, now)),
  // Work time by place, and an agent's anchors and rulings (work-agent-time.ts). The
  // read takes the reader's snapshot.
  getWorkTime: tool("get_work_time", "repeatable read", (call, valid, { now }) => getWorkTime(call, valid, now())),
  setAnchor: tool("set_anchor", "read committed", (call, valid) => setAnchor(call, valid)),
  liftAnchor: tool("lift_anchor", "read committed", (call, valid) => liftAnchor(call, valid)),
  ruleTime: tool("rule_time", "read committed", (call, valid) => ruleTime(call, valid)),
  liftTimeRuling: tool("lift_time_ruling", "read committed", (call, valid) => liftTimeRuling(call, valid)),
  judgeTimeProposal: tool("judge_time_proposal", "read committed", (call, valid) => judgeTimeProposal(call, valid)),
  readMeeting: tool("read_meeting", "repeatable read", (call, valid) => readMeeting(call, valid)),
  listIdeas: tool("list_ideas", "repeatable read", (call, valid) => listIdeas(call, valid)),
  writeBack: tool("write_back", "read committed", (call, valid) => writeBack(call, valid)),
  reportWrongMerge: tool("report_wrong_merge", "read committed", (call, valid) => reportWrongMerge(call, valid)),
  reportWrongRelation: tool("report_wrong_relation", "read committed", (call, valid) =>
    reportWrongRelation(call, valid),
  ),
  // Agent messages and the improvement store (work-mail.ts).
  postAgentMessage: tool("post_agent_message", "read committed", (call, valid) => postAgentMessage(call, valid)),
  readAgentInbox: tool("read_agent_inbox", "read committed", async (call, valid) =>
    withWaiting(call, await readAgentInbox(call, valid)),
  ),
  submitImprovement: tool("submit_improvement", "read committed", (call, valid) => submitImprovement(call, valid)),
  listImprovements: tool("list_improvements", "repeatable read", (call, valid) => listImprovements(call, valid)),
  getHealth: tool("get_health", "repeatable read", (call, _valid, { box }) => getHealth(call, box)),
  markHealthSeen: tool("mark_health_seen", "read committed", (call, valid) => markHealthSeen(call, valid)),
  fileLearning: tool("file_learning", "read committed", (call, valid) => fileLearning(call, valid)),
  // The levers (work-levers.ts): the list, and an agent's change to one inside its range.
  listLevers: tool("list_levers", "repeatable read", (call) => listLevers(call)),
  setLever: tool("set_lever", "read committed", (call, valid) => setLever(call, valid)),
  relayCardAnswer: tool("relay_card_answer", "read committed", (call, valid) => relayCardAnswer(call, valid)),
  updateImprovement: tool("update_improvement", "read committed", (call, valid) => updateImprovement(call, valid)),
  startOutcomeTest: tool("start_outcome_test", "read committed", (call, valid) => startOutcomeTest(call, valid)),
  recordHeldOutQuestion: tool("record_held_out_question", "read committed", (call, valid) =>
    recordHeldOutQuestion(call, valid),
  ),
  recordOutcomeTask: tool("record_outcome_task", "read committed", (call, valid) => recordOutcomeTask(call, valid)),
  planMove: tool("plan_move", "read committed", (call, valid) => planMove(call, valid)),
  reportMove: tool("report_move", "read committed", (call, valid, { log, now }) => reportMove(call, valid, log, now)),
  setIntention: tool("set_intention", "read committed", (call, valid) => setIntention(call, valid)),
  appendStep: tool("append_step", "read committed", (call, valid) => appendStep(call, valid)),
  finishRun: tool("finish_run", "read committed", (call, valid) => finishRun(call, valid)),
};
type ToolMethods = {
  [K in keyof typeof TOOLS]: (typeof TOOLS)[K] extends { name: infer T extends WorkTool }
    ? (token: string, args: Args<T>, options?: CallOptions) => Promise<ReadOutcome<Result<T>>>
    : never;
};

type WorkOf = (
  call: WorkCall,
  valid: never,
  deps: { log: PersonalLogger; now: () => Date; box?: () => BoxFacts },
) => Promise<never>;

class WorkCalls {
  readonly #reader: Reader;
  readonly #log: PersonalLogger;
  readonly #now: () => Date;
  readonly #box: (() => BoxFacts) | undefined;

  constructor(options: WorkOptions) {
    this.#reader = options.reader;
    this.#log = options.log;
    this.#now = options.now ?? systemNow;
    this.#box = options.box;
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(TOOLS).map(([method, row]) => [
          method,
          (token: string, args: unknown, callOptions?: CallOptions) =>
            this.call(
              row.name,
              token,
              row.isolation,
              args,
              (call, valid) =>
                (row.work as never as WorkOf)(call, valid as never, {
                  log: this.#log,
                  now: this.#now,
                  ...(this.#box === undefined ? {} : { box: this.#box }),
                }),
              callOptions,
            ),
        ]),
      ),
    );
  }

  #failed(): void {
    this.#log.error({ event: "work_failed", code: "unavailable" });
  }

  // One tool call through the reader's call path: the token and the client; the tool and the
  // view `work`; the arguments; the work; on `ok`, the read log row (an empty `bound`, and the
  // evidence ids it returned under `shown`), then the call log row, whatever the outcome. A
  // call with no current client writes nothing. With a signal, an abort cancels the call's
  // statement and rolls it back (read-db.ts).
  call<T extends WorkTool>(
    tool: T,
    token: string,
    isolation: Isolation,
    args: unknown,
    work: (call: WorkCall, args: Args<T>) => Promise<Briefed<Result<T>>>,
    options: CallOptions = {},
  ): Promise<ReadOutcome<Result<T>>> {
    return this.#through(
      tool,
      PersonalWorkArgs[tool] as unknown as Parser<Args<T>>,
      token,
      isolation,
      args,
      work,
      options,
    );
  }

  #through<A, R>(
    tool: WorkTool | PersonalProposeTool,
    schema: Parser<A>,
    token: string,
    isolation: Isolation,
    args: unknown,
    work: (call: WorkCall, args: A) => Promise<Briefed<R>>,
    options: CallOptions,
  ): Promise<ReadOutcome<R>> {
    return toolCall(
      this.#reader,
      () => this.#failed(),
      token,
      { isolation, signal: options.signal },
      {
        name: tool,
        view: viewOf(tool),
        parse: () => parsed(schema.safeParse(args)),
        why: (outcome) => whyOf(outcome),
      },
      async ({ client, run, ctx: ctxOf, logRead }, valid) => {
        const budget = Object.hasOwn(WORK_READ_BUDGET, tool)
          ? WORK_READ_BUDGET[tool as keyof typeof WORK_READ_BUDGET]
          : undefined;
        if (budget !== undefined) {
          const left = await allowance(run, budget);
          if (left !== "ok") return { outcome: { ok: false, code: "rate_limited", refusal: left }, rows: 0 };
        }
        const ctx = ctxOf(client);
        const done = await work({ client, ctx, session: ctx.session, fn: functionCall(run) }, valid);
        if (done.unlogged === true) return { outcome: done.outcome, rows: 0, unlogged: true };
        const served = done.outcome.ok && done.refused === undefined;
        if (served)
          await logRead(ctx, tool, {
            bound: done.bound ?? [],
            shown: done.shown ?? [],
            factKeyFps: [],
            goals: done.goals ?? [],
            lessons: done.lessons ?? [],
          });
        return {
          outcome: done.outcome,
          rows: served ? done.rows : 0,
          code: done.refused !== undefined ? "invalid_request" : undefined,
          why: whyOfDone(done),
        };
      },
    );
  }

  // Two transactions, where every other work call has one: the take commits, then the brief is read
  // under it, the function answering the same attempt to the same request id. A brief slower than the
  // deadline is cancelled alone, so its run has used an attempt and the next call takes the next run.
  // A refusal, or no run, ends at the first.
  async nextRun(token: string, args: Args<"next_run">, options?: CallOptions) {
    let took = false;
    const first = await this.call(
      "next_run",
      token,
      "read committed",
      args,
      async (call, valid) => {
        const taken = await takeRun(call, valid);
        took = taken.unlogged === true;
        return taken;
      },
      options,
    );
    if (!took) return first;
    return this.call(
      "next_run",
      token,
      "read committed",
      args,
      (call, valid) => nextRun(call, valid, this.#now()),
      options,
    );
  }

  // The send proxy's propose tool: one transaction, read committed as every work write is.
  draftMessage(
    token: string,
    args: DraftMessageArgs,
    options: CallOptions = {},
  ): Promise<ReadOutcome<DraftMessageResult>> {
    return this.#through(
      "draft_message",
      DraftMessageArgs as Parser<DraftMessageArgs>,
      token,
      "read committed",
      args,
      (call, valid) => draftMessage(call, valid),
      options,
    );
  }

  // A call the agent API refused before any work: its one policy.calls row, and nothing else. The
  // code is decided here from the registration: not_permitted for a tool or the view the client
  // lacks, invalid_request otherwise.
  refusedWork(
    token: string,
    tool: WorkTool | PersonalProposeTool,
    options: RefusalOptions = {},
  ): Promise<ReadOutcome<never>> {
    return toolCall(
      this.#reader,
      () => this.#failed(),
      token,
      { isolation: "read committed", signal: options.signal },
      {
        name: tool,
        view: viewOf(tool),
        parse: () => null,
        why: (outcome) => (!outcome.ok && outcome.code === "invalid_request" ? options.why : undefined),
      },
      () => Promise.reject(new Unavailable()),
    );
  }
}

export type Work = WorkCalls & ToolMethods & PersonalWork;

// Why a work call is logged as refused; for a report that lacks something, the first thing it lacks.
function whyOfDone(done: Done<unknown>): RefusalWhy | undefined {
  if (done.refused === undefined || !done.outcome.ok) return whyOf(done.outcome);
  const first = (done.outcome.value as { refused?: readonly string[] }).refused?.[0];
  return first === undefined ? { reason: "store" } : { reason: first };
}

// `box`: what the process that serves the agent API can see of the box itself (get_health's `box`):
// the holds that stand, the switches it can read and the commit it was deployed at.
type WorkOptions = { reader: Reader; log: PersonalLogger; now?: () => Date; box?: () => BoxFacts };

export function createWork(options: WorkOptions): Work {
  return new WorkCalls(options) as Work;
}
