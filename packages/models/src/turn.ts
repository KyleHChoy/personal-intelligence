import {
  type PersonalReadTool,
  type TurnMessage,
  TurnReply,
  TurnRequest,
  TurnToolCall,
} from "@intelligence/contracts/personal";
import { ModelClientError } from "./client/errors.ts";
import { isRecord, type Json, parseJson } from "./completion.ts";
import type { Pseudonymiser } from "./pseudonymise.ts";
import { depsOf, HttpStatusError, send } from "./retry.ts";
import { microUsd } from "./usage.ts";

// The reasoner's model call that sends tools: a second function beside createOpenRouterClient, on
// the personal shapes of the contracts' turn.ts and nothing of the shared model contract. Same
// host, path, timeout, retries and refusals as complete, the same provider fields on every call,
// and no switch to leave them off. It keeps no prompt and no answer, and falls back to no other
// model.

export type TurnModel = { turn(request: TurnRequest): Promise<TurnReply> };

// OpenRouter's normalized reasoning effort, sent as `reasoning: { effort }` only when set. With
// require_parameters, a provider that cannot take it is skipped.
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const isReasoningEffort = (value: string): value is ReasoningEffort =>
  (REASONING_EFFORTS as readonly string[]).includes(value);

// Anthropic's server tools, each sent with its most uses a request, and the rules
// sent after the system prompt whenever one is. The OpenRouter turn sends none of it.
export type ServerTools = { webSearch?: { maxUses: number }; webFetch?: { maxUses: number }; rules?: string };

export type TurnModelOptions = {
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  serverTools?: ServerTools;
  deps?: {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    pseudonymiser?: Pseudonymiser;
  };
};

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// The one provider object, as complete sends it, without zero data retention.
const PROVIDER = Object.freeze({ data_collection: "deny", require_parameters: true });

const vendorCall = (call: TurnToolCall) => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
});

const vendorMessage = (message: TurnMessage): Json => {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.text };
    case "assistant":
      return message.toolCalls.length === 0
        ? { role: "assistant", content: message.text }
        : { role: "assistant", content: message.text, tool_calls: message.toolCalls.map(vendorCall) };
    case "tool":
      return { role: "tool", tool_call_id: message.id, content: message.result };
  }
};

// An Anthropic model reads from its prompt cache only up to a marked block, where
// OpenAI's caching is automatic. The system prompt (the tools precede it in the cache) and the newest
// message are marked, so each turn reads every turn before it from the cache.
const cachedText = (text: string): Json[] => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

const messagesOf = (model: string, request: TurnRequest): Json[] => {
  const messages = [{ role: "system", content: request.system }, ...request.messages.map(vendorMessage)];
  if (!model.startsWith("anthropic/")) return messages;
  return messages.map((message, index) =>
    (index === 0 || index === messages.length - 1) &&
    typeof message.content === "string" &&
    message.role !== "assistant"
      ? { ...message, content: cachedText(message.content) }
      : message,
  );
};

const bodyOf = (model: string, effort: ReasoningEffort | undefined, request: TurnRequest): string =>
  JSON.stringify({
    model,
    messages: messagesOf(model, request),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })),
    max_tokens: request.maxOutputTokens,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    stream: false,
    usage: { include: true },
    provider: PROVIDER,
  });

// The name a malformed call is given: a word, and no read tool.
const INVALID_CALL = "invalid_tool_call";

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

// The vendor's answer as a TurnReply, or null when it is not one.
const replyOf = (model: string, answer: unknown): TurnReply | null => {
  const choices = isRecord(answer) ? answer.choices : undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  if (!isRecord(answer) || !isRecord(choice) || choice.finish_reason === "error" || !isRecord(choice.message))
    return null;
  const message = choice.message;
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) return null;
  const toolCalls: TurnToolCall[] = [];
  for (const [index, call] of rawCalls.entries()) {
    if (!isRecord(call)) return null;
    const fn = isRecord(call.function) ? call.function : {};
    const args = typeof fn.arguments === "string" ? parseJson(fn.arguments === "" ? "{}" : fn.arguments) : undefined;
    const parsed = TurnToolCall.safeParse({ id: call.id, name: fn.name, arguments: args });
    if (parsed.success && args !== undefined) {
      toolCalls.push(parsed.data);
      continue;
    }
    // A call that is not one (a cut-off argument, a name that is no word, a bad id) does not void
    // the reply: it is a call of no read tool, which the loop refuses and records, and the reply's
    // usage is still counted.
    const id = TurnToolCall.shape.id.safeParse(call.id);
    toolCalls.push({ id: id.success ? id.data : `invalid_call_${index}`, name: INVALID_CALL, arguments: {} });
  }
  const usage = isRecord(answer.usage) ? answer.usage : {};
  const cost = usage.cost;
  const parsed = TurnReply.safeParse({
    text: typeof message.content === "string" ? message.content : null,
    toolCalls,
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    costMicroUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? microUsd(cost) : null,
    modelId: model,
    // Cut off at max_tokens, which counts a reasoning model's reasoning too.
    ...(choice.finish_reason === "length" ? { code: "truncated" } : {}),
  });
  return parsed.success ? parsed.data : null;
};

// Each turn's deadline: a planner turn at high reasoning
// effort, late in a run with many tool results, thinks for longer than retry.ts's 60 seconds,
// and a timed-out attempt is never sent again. Thirty minutes: a guard against a hung
// connection only: a tight limit would cut off a slow turn that would have finished.
const TURN_ATTEMPT_MS = 1_800_000;

// A turn that ran past its deadline, told apart from other failures by its status.
export class TurnTimedOutError extends ModelClientError {
  readonly status = "timed_out";
  constructor() {
    super("unavailable");
  }
}

// What failed in a model call, as a fixed code for the log: timed_out, an http_<status>, or the
// model client's own code; never a body.
export function modelFailureCode(error: unknown): string {
  if (error instanceof TurnTimedOutError || error instanceof HttpStatusError) return error.status;
  if (error instanceof ModelClientError) return error.code;
  return "error";
}

export function createOpenRouterTurnModel(options: TurnModelOptions): TurnModel {
  const { apiKey, model, reasoningEffort } = options;
  const deps = depsOf(options.deps);
  return {
    async turn(raw) {
      const request = TurnRequest.safeParse(raw);
      if (!request.success) throw new ModelClientError("bad_request");
      const sent = await send(
        ENDPOINT,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: bodyOf(model, reasoningEffort, request.data),
          redirect: "error",
        },
        deps,
        TURN_ATTEMPT_MS,
      );
      if (sent.kind === "timed_out") throw new TurnTimedOutError();
      const reply = replyOf(model, parseJson(sent.text));
      if (reply === null) throw new ModelClientError("unavailable");
      return reply;
    },
  };
}

export type CheckedToolCall =
  | { ok: true; id: string; name: PersonalReadTool; arguments: unknown }
  | { ok: false; id: string; reason: "unknown_tool" };

// Where a call's name meets the closed set: only a name in `allowed` is ok.
export function checkToolCalls(reply: TurnReply, allowed: readonly PersonalReadTool[]): CheckedToolCall[] {
  return reply.toolCalls.map((call) =>
    (allowed as readonly string[]).includes(call.name)
      ? { ok: true, id: call.id, name: call.name as PersonalReadTool, arguments: call.arguments }
      : { ok: false, id: call.id, reason: "unknown_tool" },
  );
}
