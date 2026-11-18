import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { REJECTED_CONTENT_FILTER, REJECTED_LENGTH } from "@intelligence/contracts/personal";
import type { ModelClient } from "./client/client.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { type Prompt, validateOutput } from "./client/prompts.ts";
import {
  ATTEMPT_MS,
  isRecord,
  type Json,
  MAX_TOKENS,
  messagesOf,
  type OpenRouterOptions,
  parseJson,
  plainCompletion,
  unfenced,
  usageReporter,
} from "./completion.ts";
import { depsOf, send } from "./retry.ts";
import { ASSUMED_CALL_MICRO_USD, microUsd, usageOf } from "./usage.ts";

// The model port to OpenRouter. One request, one system and one user message, never tools, to one
// host, with the same provider fields always.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// No option, variable or retry sends a request without these. Zero data retention is not asked for:
// the configured model is served under it only where max_tokens is not taken. require_parameters
// keeps response_format honoured.
const PROVIDER = Object.freeze({ data_collection: "deny", require_parameters: true });

// The body of the one request. No temperature: a reasoning model takes none, and a result is
// repeated by replaying its saved call, not by sampling.
const bodyOf = (model: string, prompt: Prompt, text: string): string => {
  const { system, user } = messagesOf(prompt, text);
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: MAX_TOKENS,
    stream: false,
    response_format: { type: "json_object" },
    provider: PROVIDER,
    usage: { include: true },
  });
};

// A well-formed answer, read in this order: a tool call, then a cut-off or filtered answer,
// then the output against the prompt's closed schema. Either the output or a rejection's raw text.
const read = (prompt: Prompt, choice: Json): { output: unknown } | { rejected: string } => {
  const message = isRecord(choice.message) ? choice.message : {};
  const content = typeof message.content === "string" ? message.content : "";
  const finish = choice.finish_reason;
  // Step 1: a tool call, though none was sent.
  const toolCalls = message.tool_calls;
  if ((Array.isArray(toolCalls) && toolCalls.length > 0) || finish === "tool_calls") return { rejected: content };
  // Step 2: cut off or filtered. Nothing of the content is kept.
  if (finish === "length") return { rejected: REJECTED_LENGTH };
  if (finish === "content_filter") return { rejected: REJECTED_CONTENT_FILTER };
  // Step 3: any other finish reason is read as stop is.
  try {
    return { output: validateOutput(prompt, unfenced(content)) };
  } catch (error) {
    if (error instanceof ModelOutputRejected) return { rejected: error.rawOutput };
    throw error;
  }
};

export function createOpenRouterClient(options: OpenRouterOptions): ModelClient {
  const { apiKey, model, registry } = options;

  const deps = depsOf(options.deps);
  const init = (body: string): RequestInit => ({
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body,
    redirect: "error",
  });

  return {
    async complete(raw: ModelRequest): Promise<ModelResponse> {
      const { request, prompt, rendered } = plainCompletion(raw, registry);

      const report = usageReporter(options.onUsage, request, model);

      const sent = await send(ENDPOINT, init(bodyOf(model, prompt, rendered.text)), deps, ATTEMPT_MS);
      // The vendor may have billed an attempt that timed out.
      if (sent.kind === "timed_out") {
        await report("timed_out", ASSUMED_CALL_MICRO_USD);
        throw new ModelClientError("unavailable");
      }
      const answer = parseJson(sent.text);
      const { cost, ...tokens } = usageOf(isRecord(answer) ? answer.usage : undefined);

      // Step 0: no answer. Counted only when it carries a cost, and never as cost_missing.
      const choices = isRecord(answer) ? answer.choices : undefined;
      const choice = Array.isArray(choices) ? choices[0] : undefined;
      if (!isRecord(choice) || choice.finish_reason === "error") {
        if (cost !== undefined) await report("no_answer", microUsd(cost), tokens);
        throw new ModelClientError("unavailable");
      }

      const verdict = read(prompt, choice);
      // Every answer is counted before its verdict is acted on, so a rejected output is too.
      const outcome = cost === undefined ? "cost_missing" : "output" in verdict ? "ok" : "rejected";
      await report(outcome, cost === undefined ? ASSUMED_CALL_MICRO_USD : microUsd(cost), tokens);
      if (!("output" in verdict)) throw new ModelOutputRejected(verdict.rejected);
      return {
        output: verdict.output,
        label: request.label,
        usage: { ...tokens, cost: cost ?? ASSUMED_CALL_MICRO_USD / 1_000_000 },
        modelId: model,
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
}
