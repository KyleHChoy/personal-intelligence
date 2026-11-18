import {
  type ClaimRefusal,
  CodedError,
  type PersonalLogger,
  type PersonalReadTool,
  type PersonalToolError,
  PersonalWorkResults,
  RunOutput,
  type RunRequest,
  type RunStep,
  type TurnMessage,
  type TurnReply,
  type TurnTool,
  type WorkRunCode,
} from "@intelligence/contracts/personal";
import { checkStageOutput, refusalText, renderRunInput, runPromptFor } from "@intelligence/personal-ladder";
import { checkToolCalls, modelFailureCode } from "@intelligence/personal-models";
import {
  argumentsOf,
  assistantOf,
  capResults,
  compactResults,
  compactWeb,
  costOf,
  dropThinking,
  MAX_RESULT_CODE_POINTS,
  purposeOf,
  REASONER_TOOLS,
  TOO_LARGE,
} from "./conversation.ts";
import { codePoints, fitResult } from "./fit.ts";
import { outputIssues, outputIssuesText } from "./output-issues.ts";
import type { AgentApi, TurnModel } from "./ports.ts";
import { budgetWindow, refusalHint, refusedArguments } from "./refusal.ts";
import { salvageRefs } from "./salvage.ts";

// One reasoning run, from its first turn to its finish_run.
// The loop's counts are a courtesy: the database holds the bounds. The run
// is sent the prompt it was queued under (its request's point), with its stage's input. Its output
// is checked by code before finish_run (checkStageOutput): an output of another stage's shape ends
// the run as bad_output; a refused output gets one more turn with the refusals' codes, and a second
// refusal ends the run as bad_output.
// Nothing of a message, an argument or a result is logged or recorded: a step holds a kind, a
// tool's name, a status, a code and a cost, and a model call its token counts and time. The one
// exception is a web search's query or a web fetch's URL, which the vendor ran for the model call
// before it: each is a step of its own, sealed by the store under the run's label, and logged as a
// count only. Server tool blocks stay in the conversation and never reach the agent API: only the
// reply's own tool calls are sent there.

export type LoopResult = { outcome: "finished" | "failed" | "stopped"; code?: WorkRunCode };

const REF_NOT_FOUND = "a ref was not found";
// What the model is told of a reply cut off at the output limit, whose text and calls were not used.
const TRUNCATED =
  "Your last reply was cut off at the output limit and none of it was used. Reply again, shorter: fewer tool calls in one reply, or a shorter final answer.";
// Past about 50 000 tokens of input, every tool result but the last turn's is
// replaced by a stub naming the tool and the ids it held, so the model can still cite them or read
// them again. All at once, not turn by turn: between compactions the prefix stays the same, so a
// provider's prompt cache still holds. It shapes the context; it never ends a run. Tokens are
// estimated from the last call's own count plus what was added since, and never below the code
// points over CODE_POINTS_PER_TOKEN: this JSON runs at about 2.3 code points a token (ids tokenize
// poorly), so a code point target alone would fire at about 90 000 tokens.
const TOKEN_TARGET = 50_000;
// No model call is sent with more than 100 000 tokens of input, the owner's cap (input costs far
// more past it). Past it, the newest turn's results are stubbed too; a
// call still over it ends the run with context_limit instead of being sent.
const TOKEN_CAP = 100_000;
const CODE_POINTS_PER_TOKEN = 2;
// Refusals in a row that end a run: a call that succeeds starts the count again, so a model that
// corrects itself goes on and one stuck repeating a refused call is stopped, where a total alone
// would end a run whose few refusals are spread over many calls.
const MAX_REFUSED_CALLS = 5;
// And in all, so a model that alternates a good call with refused ones still ends.
const MAX_REFUSED_TOTAL = 100;

// An assistant turn's content blocks as JSON text. A thinking block's signature is
// left out, and a web result's encrypted content, base64 of what the model reads, counts at two
// fifths of its length, about what that text would count as code points; the next call's own count
// of tokens corrects both. A fetched page's text is counted whole.
const ENCRYPTED = new Set(["encrypted_content", "encrypted_index"]);
const ENCRYPTED_WEIGHT = 0.4;
const contentSize = (content: readonly Record<string, unknown>[]): number => {
  let encrypted = 0;
  const text = JSON.stringify(content, (key, value: unknown) => {
    if (key === "signature") return undefined;
    if (ENCRYPTED.has(key) && typeof value === "string") {
      encrypted += value.length;
      return undefined;
    }
    return value;
  });
  return codePoints(text ?? "") + Math.ceil(encrypted * ENCRYPTED_WEIGHT);
};

// What a model call reads, in code points: the system text, the messages and the tool
// definitions as JSON text.
const inputSize = (system: string, messages: readonly TurnMessage[], tools: string): number =>
  codePoints(system) +
  codePoints(tools) +
  messages.reduce((sum, message) => {
    if (message.role === "user") return sum + codePoints(message.text);
    if (message.role === "tool") return sum + codePoints(message.result);
    if (message.content !== undefined) return sum + contentSize(message.content);
    return (
      sum +
      codePoints(message.text ?? "") +
      message.toolCalls.reduce((n, call) => n + codePoints(JSON.stringify(call.arguments) ?? ""), 0)
    );
  }, 0);

const parseOutput = (text: string | null): RunOutput | null => {
  if (text === null) return null;
  try {
    const parsed = RunOutput.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

type LoopDeps = { api: AgentApi; model: TurnModel; log: PersonalLogger; clock?: () => number };
type ToolStep = { step: Extract<RunStep, { kind: "tool_call" }>; result: string };

// `clock` reads milliseconds for a model call's wall-clock time; a test passes its own.
export async function runLoop(request: RunRequest, deps: LoopDeps): Promise<LoopResult> {
  const run = new Run(request, deps);
  const result = await run.loop();
  deps.log.info({
    event: "run_ended",
    ids: { run: request.id },
    counts: { turns: run.turns, tool_calls: run.toolCalls, refused: run.refused },
    code: result.code ?? result.outcome,
  });
  return result;
}

// One run's state and its steps. Each step that can end the run answers its result, or null to go on.
class Run {
  turns = 0;
  toolCalls = 0;
  refused = 0;
  private refusedInRow = 0;
  private ordinal = 0;
  private finishes = 0;
  private readonly request: RunRequest;
  private readonly api: AgentApi;
  private readonly model: TurnModel;
  private readonly log: PersonalLogger;
  private readonly clock: () => number;
  private readonly stopped: LoopResult = { outcome: "stopped" };
  private prompt!: ReturnType<typeof runPromptFor>;
  private tools: TurnTool[] = [];
  private toolsText = "";
  private messages: TurnMessage[] = [];
  private refNotFound = false;
  private checksRefused = false;
  private shapeRefused = false;
  // The last call's input as the vendor counted it, and as code points, for the estimate.
  private lastTokens: number | null = null;
  private lastSize = 0;

  constructor(request: RunRequest, deps: LoopDeps) {
    this.request = request;
    this.api = deps.api;
    this.model = deps.model;
    this.log = deps.log;
    this.clock = deps.clock ?? (() => performance.now());
  }

  async loop(): Promise<LoopResult> {
    await this.start();
    const { limits } = this.request;
    for (;;) {
      if (this.turns >= limits.maxTurns) return this.fail("turn_limit");
      const size = this.size();
      if (this.estimateOf(size) > TOKEN_TARGET) this.compact(size);
      if (!this.cap()) return this.fail("context_limit");
      if (this.size() > limits.maxInputCodePoints) return this.fail("context_limit");

      const called = await this.callModel();
      if (called === null) return this.fail("model_unavailable");
      const { reply, started } = called;
      const cost = costOf(reply, limits.ceilingMicroUsdPerToken);
      if (cost === null) return this.fail("model_unavailable");
      if (!(await this.recordModelCall(reply, cost, started))) return this.stopped;

      const ended =
        reply.code === "truncated"
          ? await this.onTruncated()
          : reply.toolCalls.length > 0
            ? await this.runToolCalls(reply)
            : await this.onAnswer(reply);
      if (ended !== null) return ended;
    }
  }

  // The read tools offered, the run's prompt and its first message.
  private async start(): Promise<void> {
    const offered = new Set(REASONER_TOOLS as readonly string[]);
    this.tools = (await this.api.listTools())
      .filter((tool) => offered.has(tool.name))
      .map((tool) => ({
        name: tool.name as PersonalReadTool,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    this.toolsText = JSON.stringify(this.tools);
    this.prompt = runPromptFor(this.request.point);
    this.messages = [{ role: "user", text: renderRunInput(this.request, this.prompt.stage) }];
  }

  private size(): number {
    return inputSize(this.prompt.text, this.messages, this.toolsText);
  }

  // Tokens, estimated from the last call's own count plus what was added since, never below
  // the code points over CODE_POINTS_PER_TOKEN.
  private estimateOf(now: number): number {
    const floor = now / CODE_POINTS_PER_TOKEN;
    return this.lastTokens === null
      ? floor
      : Math.max(floor, this.lastTokens + (now - this.lastSize) / CODE_POINTS_PER_TOKEN);
  }

  // Past the target: earlier results stubbed, earlier web results with them, and every thinking
  // block when either went.
  private compact(before: number): void {
    const { messages } = this;
    const stubbed = compactResults(messages);
    const web = compactWeb(
      messages,
      messages.findLastIndex((message) => message.role === "assistant"),
    );
    const thinking = stubbed + web > 0 ? dropThinking(messages) : 0;
    if (stubbed + web > 0)
      this.log.info({
        event: "context_compacted",
        ids: { run: this.request.id },
        counts: { turn: this.turns, before, after: this.size(), stubbed, web, thinking },
      });
  }

  // The hard cap. The largest results are stubbed until the call fits; false when a call
  // still over it would be sent.
  private cap(): boolean {
    const fits = (): boolean => this.estimateOf(this.size()) <= TOKEN_CAP;
    if (fits()) return true;
    const before = this.size();
    const stubbed = capResults(this.messages, fits);
    const web = fits() ? 0 : compactWeb(this.messages, this.messages.length);
    const thinking = stubbed + web > 0 ? dropThinking(this.messages) : 0;
    if (stubbed + web > 0)
      this.log.info({
        event: "context_capped",
        ids: { run: this.request.id },
        counts: { turn: this.turns, before, after: this.size(), stubbed, web, thinking },
      });
    return fits();
  }

  // The model call, counted as a turn; null when it failed.
  private async callModel(): Promise<{ reply: TurnReply; started: number } | null> {
    let reply: TurnReply;
    const started = this.clock();
    try {
      reply = await this.model.turn({
        system: this.prompt.text,
        messages: structuredClone(this.messages),
        tools: this.tools,
        maxOutputTokens: this.request.limits.maxOutputTokens,
      });
    } catch (error) {
      // What failed, as a fixed code (timed_out, http_<status>, or the client's code).
      this.log.info({
        event: "model_call_failed",
        ids: { run: this.request.id },
        counts: { turn: this.turns },
        code: modelFailureCode(error),
      });
      return null;
    }
    this.turns += 1;
    // A reply that ran a search or fetch is counted by the vendor over its whole search loop
    // (some three times the call's own size), so it is no base for the next estimate: that comes
    // from the conversation's own size, its web results counted, until the next call's count.
    this.lastTokens =
      (reply.webRequests ?? []).length > 0 || reply.webSearchesBilled !== undefined ? null : reply.inputTokens;
    this.lastSize = this.size();
    return { reply, started };
  }

  // Recorded before anything of the reply is used, with its code when
  // it was cut off, or cost_missing when it was priced at the ceiling (a cut-off reply keeps
  // truncated whatever its cost), and its token counts and time. False: the run was stopped.
  private async recordModelCall(
    reply: TurnReply,
    cost: { microUsd: number; atCeiling: boolean },
    started: number,
  ): Promise<boolean> {
    const ms = Math.max(0, Math.round(this.clock() - started));
    const code: "truncated" | "cost_missing" | undefined =
      reply.code === "truncated" ? "truncated" : cost.atCeiling ? "cost_missing" : undefined;
    const called = {
      kind: "model_call",
      promptId: this.prompt.id,
      promptVersion: this.prompt.version,
      modelId: reply.modelId,
      costMicroUsd: cost.microUsd,
      ...(code === undefined ? {} : { code }),
      ...(reply.inputTokens === null ? {} : { inputTokens: reply.inputTokens }),
      ...(reply.outputTokens === null ? {} : { outputTokens: reply.outputTokens }),
      ms,
    } as const;
    if (!(await this.append(called))) return false;

    // Each search and fetch the vendor ran for this call, recorded with its query
    // or URL before anything of the reply is used, whether or not the reply is; logged as counts.
    const web = reply.webRequests ?? [];
    for (const one of web) if (!(await this.append({ kind: one.tool, text: one.text }))) return false;
    if (web.length > 0 || reply.webSearchesBilled !== undefined) {
      const searches = web.filter((one) => one.tool === "web_search").length;
      this.log.info({
        event: "web_requests",
        ids: { run: this.request.id },
        counts: {
          turn: this.turns,
          web_search: searches,
          web_fetch: web.length - searches,
          billed: reply.webSearchesBilled ?? 0,
        },
      });
    }
    return true;
  }

  // A reply cut off at the output limit: a cut-off call is no malformed call, nor cut-off text
  // a bad output. None of it is used or sent back; the model is told, and it counts as a
  // refusal toward the limit.
  private async onTruncated(): Promise<LoopResult | null> {
    this.log.info({
      event: "model_reply_truncated",
      ids: { run: this.request.id },
      counts: { turn: this.turns },
      code: "truncated",
    });
    this.refused += 1;
    this.refusedInRow += 1;
    if (this.refusedInRow >= MAX_REFUSED_CALLS || this.refused >= MAX_REFUSED_TOTAL) return this.fail("bad_output");
    this.messages.push({ role: "user", text: TRUNCATED });
    return null;
  }

  private async runToolCalls(reply: TurnReply): Promise<LoopResult | null> {
    this.messages.push(assistantOf(reply, reply.toolCalls));
    for (const call of checkToolCalls(reply, REASONER_TOOLS)) {
      if (this.toolCalls >= this.request.limits.maxToolCalls) return this.fail("tool_limit");
      this.toolCalls += 1;
      const { step, result } = call.ok
        ? await this.callTool(call.name, call.arguments)
        : // Not made: a name outside the read tools.
          {
            step: { kind: "tool_call", tool: null, status: "refused" } as const,
            result: JSON.stringify({ error: "not_permitted" }),
          };
      if (!(await this.append({ ...step, resultCodePoints: codePoints(result) }))) return this.stopped;
      // Each call refused or failed, by its place among the run's calls and its code; a name
      // that is no read tool has none of the agent API's, and is unknown_tool.
      if (step.status === "refused" || step.status === "failed") {
        this.log.info({
          event: step.status === "failed" ? "tool_failed" : "tool_refused",
          ids: { run: this.request.id },
          counts: { call: this.toolCalls },
          code: step.code ?? "unknown_tool",
        });
      }
      if (step.status === "refused") {
        this.refused += 1;
        this.refusedInRow += 1;
      } else if (step.status === "ok" || step.status === "too_large") this.refusedInRow = 0;
      if (this.refusedInRow >= MAX_REFUSED_CALLS || this.refused >= MAX_REFUSED_TOTAL) return this.fail("bad_output");
      this.messages.push({ role: "tool", id: call.id, result });
    }
    return null;
  }

  private async callTool(name: PersonalReadTool, given: unknown): Promise<ToolStep> {
    const args = argumentsOf(name, given);
    const answer = await this.api.call(name, args);
    if (!answer.ok) return this.refusedCall(name, args, answer.code, answer.refusal);
    // A result is data, sent as its JSON text, or not at all.
    // get_self and get_entity, which take no limit, are cut to fit first (fit.ts).
    const text = JSON.stringify(answer.value) ?? "null";
    const fitted =
      codePoints(text) <= MAX_RESULT_CODE_POINTS
        ? { text, dropped: null }
        : fitResult(name, answer.value, MAX_RESULT_CODE_POINTS);
    if (fitted !== null && fitted.dropped !== null)
      this.log.info({ event: "result_fitted", ids: { run: this.request.id }, counts: { dropped: fitted.dropped } });
    return {
      step: { kind: "tool_call", tool: name, status: fitted === null ? "too_large" : "ok" },
      result: fitted === null ? TOO_LARGE : fitted.text,
    };
  }

  private refusedCall(
    name: PersonalReadTool,
    args: unknown,
    code: PersonalToolError,
    refusal?: ClaimRefusal,
  ): ToolStep {
    const step: ToolStep["step"] = {
      kind: "tool_call",
      tool: name,
      status: code === "unavailable" ? "failed" : "refused",
      code,
    };
    // invalid_request: each refused argument's name and the rule it broke, and the tool's
    // hint, so the model can correct its call (refusal.ts). Each is logged by codes.
    const refusedArgs = code === "invalid_request" ? refusedArguments(name, args) : [];
    const hint = code === "invalid_request" || code === "not_found" ? refusalHint(name, code) : undefined;
    // rate_limited: the window spent and its hint (refusal.ts); the step keeps the code alone.
    const window = code === "rate_limited" ? budgetWindow(refusal) : undefined;
    if (code === "invalid_request" && name === "build_context_pack" && typeof args === "object" && args !== null) {
      const given = args as Record<string, unknown>;
      this.log.info({
        event: "pack_refused",
        ids: { run: this.request.id },
        counts: { call: this.toolCalls, event: "event" in given ? 1 : 0, entity: "entity" in given ? 1 : 0 },
        code: purposeOf(given) ?? "other",
      });
    }
    for (const { logged } of refusedArgs) {
      this.log.info({
        event: "tool_argument_refused",
        ids: { run: this.request.id },
        counts: { call: this.toolCalls, [logged.issue]: 1 },
        code: logged.name,
      });
    }
    const result = JSON.stringify({
      error: code,
      ...(refusedArgs.length === 0 ? {} : { arguments: refusedArgs.map((one) => one.argument) }),
      ...(hint === undefined ? {} : { hint }),
      ...window,
    });
    return { step, result };
  }

  // A final answer: salvaged, checked by its stage's form and by code, then finished with.
  private async onAnswer(reply: TurnReply): Promise<LoopResult | null> {
    const { prompt, request } = this;
    // Refs the form does not take are dropped, not the whole answer; what was dropped is logged.
    const salvaged = salvageRefs(reply.text);
    const output = parseOutput(salvaged?.text ?? reply.text);
    if (salvaged !== null && output !== null)
      this.log.info({
        event: "output_refs_dropped",
        ids: { run: request.id },
        counts: { turn: this.turns, refs: salvaged.refs, items: salvaged.items },
      });
    // Model proposes, code checks: each refusal is recorded as a step with its code, after the
    // model call whose output it refused, and logged with its action's index too.
    const refusals = output === null ? null : checkStageOutput(prompt.stage, output, request);
    // An answer that does not fit its stage's form gets one more turn, told what it broke; a
    // second ends the run bad_output. Each issue is logged by its code.
    if (output === null || refusals === null) {
      const issues = outputIssues(prompt.stage, reply.text);
      for (const one of issues)
        this.log.info({
          event: "output_malformed",
          ids: { run: request.id },
          counts: { turn: this.turns },
          code: one.code,
        });
      if (this.shapeRefused) return this.fail("bad_output");
      this.shapeRefused = true;
      this.messages.push(assistantOf(reply, []), { role: "user", text: outputIssuesText(prompt.stage, issues) });
      return null;
    }
    if (refusals.length > 0) {
      for (const one of refusals) {
        this.log.info({
          event: "output_refused",
          ids: { run: request.id },
          counts: { action: one.action },
          code: one.code,
        });
        if (!(await this.append({ kind: "output_check", code: one.code }))) return this.stopped;
      }
      if (this.checksRefused) return this.fail("bad_output");
      this.checksRefused = true;
      this.messages.push(assistantOf(reply, []), { role: "user", text: refusalText(refusals) });
      return null;
    }
    const finished = await this.finish("finished", undefined, output);
    if (finished !== "not_found") return finished;
    if (this.refNotFound) return this.fail("bad_output");
    // One more turn, with a fixed text that says nothing of which ref.
    this.refNotFound = true;
    this.messages.push(assistantOf(reply, []), { role: "user", text: REF_NOT_FOUND });
    return null;
  }

  // Each step, recorded before what follows it. False: the run was stopped or has ended, and the
  // database has written its end.
  private async append(step: RunStep): Promise<boolean> {
    const answer = await this.api.call("append_step", { run: this.request.id, ordinal: this.ordinal, step });
    this.ordinal += 1;
    if (!answer.ok) throw new CodedError(answer.code);
    const parsed = PersonalWorkResults.append_step.safeParse(answer.value);
    if (!parsed.success) throw new CodedError("unavailable");
    return parsed.data.go;
  }

  // finish_run, each time with a request id of its own. "not_found" is a ref of the output that
  // does not resolve, and leaves the run running.
  private async finish(
    outcome: "finished" | "failed",
    code?: WorkRunCode,
    output?: RunOutput,
  ): Promise<LoopResult | "not_found"> {
    this.finishes += 1;
    const args = {
      run: this.request.id,
      outcome,
      ...(code === undefined ? {} : { code }),
      ...(output === undefined ? {} : { output }),
      requestId: `${this.request.id}-${this.request.attempt}-finish-${this.finishes}`,
    };
    const answer = await this.api.call("finish_run", args);
    if (!answer.ok) {
      if (output !== undefined && answer.code === "not_found") return "not_found";
      if (output !== undefined && answer.code === "invalid_request") return this.finish("failed", "bad_output");
      throw new CodedError(answer.code);
    }
    const parsed = PersonalWorkResults.finish_run.safeParse(answer.value);
    if (!parsed.success) throw new CodedError("unavailable");
    if (parsed.data.outcome === "stopped") return { outcome: "stopped" };
    return code === undefined ? { outcome } : { outcome, code };
  }

  // With no output, finish answers a result or throws.
  private async fail(code: WorkRunCode): Promise<LoopResult> {
    return (await this.finish("failed", code)) as LoopResult;
  }
}
