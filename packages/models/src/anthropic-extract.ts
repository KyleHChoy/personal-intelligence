import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { REJECTED_CONTENT_FILTER, REJECTED_LENGTH } from "@intelligence/contracts/personal";
import { anthropicCostMicroUsd, anthropicModelId } from "./anthropic-turn.ts";
import type { ModelClient } from "./client/client.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { type Prompt, validateOutput } from "./client/prompts.ts";
import {
  ATTEMPT_MS,
  count,
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
import { ASSUMED_CALL_MICRO_USD } from "./usage.ts";

// The extraction port on Anthropic's Messages API directly, beside createOpenRouterClient: the
// same ModelRequest in, the same ModelResponse out, the same usage events. One request, one system
// and one user message, never tools. Current models think adaptively by default; the effort is
// sent as `output_config.effort` when one is given, and the model's own
// default applies when none is (medium on Haiku 5.5). No temperature. A model not on the price
// list reports no cost, and the call counts as cost_missing at the assumed call cost.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];
export const isAnthropicEffort = (value: string): value is AnthropicEffort =>
  (ANTHROPIC_EFFORTS as readonly string[]).includes(value);

export type AnthropicExtractOptions = OpenRouterOptions & { effort?: AnthropicEffort };

const bodyOf = (model: string, effort: AnthropicEffort | undefined, prompt: Prompt, text: string): string => {
  const { system, user } = messagesOf(prompt, text);
  return JSON.stringify({
    model,
    system,
    messages: [{ role: "user", content: user }],
    max_tokens: MAX_TOKENS,
    ...(effort === undefined ? {} : { output_config: { effort } }),
  });
};

// Its content, if it holds no other fence, is the answer; nothing else of the text is read. Null for
// any other text. A line ending may be CRLF.
const OPENER = /(^|\n)```json\r?\n/g;
function finalJsonFence(content: string): string | null {
  const text = content.trimEnd();
  if (!text.endsWith("```")) return null;
  const openers = [...text.slice(0, -3).matchAll(OPENER)];
  const last = openers.at(-1);
  if (last === undefined) return null;
  const inner = text.slice(last.index + last[0].length, text.length - 3);
  return inner.includes("```") ? null : inner;
}

// The first line that opens with `{`, in its first column, starts the answer, and its text to the
// end, white space aside, must parse whole as one object, so braces and quotes inside its strings
// need no scan and two objects are refused. Null for any other text.
function finalJsonObject(content: string): string | null {
  const text = content.trimEnd();
  const start = /(^|\n)\{/.exec(text);
  if (start === null || !text.endsWith("}")) return null;
  const candidate = text.slice(start.index + (start[1] ?? "").length);
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? candidate : null;
  } catch {
    return null;
  }
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// As createOpenRouterClient reads a choice: a tool call, then a cut-off or refused answer, then
// the text against the prompt's closed schema. Thinking blocks are not read.
const read = (prompt: Prompt, answer: Json, blocks: unknown[]): { output: unknown } | { rejected: string } => {
  const content = blocks
    .filter((block): block is Json => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const stop = answer.stop_reason;
  if (blocks.some((block) => isRecord(block) && block.type === "tool_use") || stop === "tool_use")
    return { rejected: content };
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return { rejected: REJECTED_LENGTH };
  if (stop === "refusal") return { rejected: REJECTED_CONTENT_FILTER };
  const raw = unfenced(content);
  const fenced = isJson(raw) ? null : (finalJsonFence(content) ?? finalJsonObject(content));
  try {
    return { output: validateOutput(prompt, fenced ?? raw) };
  } catch (error) {
    // A refused fence's raw text is the whole text, as any refused answer's is.
    if (error instanceof ModelOutputRejected) return { rejected: fenced === null ? error.rawOutput : content };
    throw error;
  }
};

export function createAnthropicExtractClient(options: AnthropicExtractOptions): ModelClient {
  const { apiKey, registry, effort } = options;
  const model = anthropicModelId(options.model);
  if (model === null) throw new ModelClientError("bad_request");
  const deps = depsOf(options.deps);

  return {
    async complete(raw: ModelRequest): Promise<ModelResponse> {
      const { request, prompt, rendered } = plainCompletion(raw, registry);

      // The response keeps the configured id, which a saved call takes.
      const report = usageReporter(options.onUsage, request, model);

      const sent = await send(
        ENDPOINT,
        {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": VERSION, "content-type": "application/json" },
          body: bodyOf(model, effort, prompt, rendered.text),
          redirect: "error",
        },
        deps,
        ATTEMPT_MS,
      );
      if (sent.kind === "timed_out") {
        await report("timed_out", ASSUMED_CALL_MICRO_USD);
        throw new ModelClientError("unavailable");
      }
      const answer = parseJson(sent.text);
      const usage = isRecord(answer) && isRecord(answer.usage) ? answer.usage : {};
      // Counts that are missing are never priced as zero: the call is cost_missing.
      const whole = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
      const counted = whole(usage.input_tokens) && whole(usage.output_tokens);
      const cost = counted ? anthropicCostMicroUsd(model, usage) : null;
      // Every input token the call read: fresh, written to the cache and read from it.
      const tokens = {
        inputTokens:
          count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
        outputTokens: count(usage.output_tokens),
      };

      // No answer: counted only when it carries usage, and never as cost_missing.
      const blocks = isRecord(answer) && answer.type === "message" ? answer.content : undefined;
      if (!isRecord(answer) || !Array.isArray(blocks)) {
        if (cost !== null) await report("no_answer", cost, tokens);
        throw new ModelClientError("unavailable");
      }

      const verdict = read(prompt, answer, blocks);
      const outcome = cost === null ? "cost_missing" : "output" in verdict ? "ok" : "rejected";
      const microUsd = cost ?? ASSUMED_CALL_MICRO_USD;
      await report(outcome, microUsd, tokens);
      if (!("output" in verdict)) throw new ModelOutputRejected(verdict.rejected);
      return {
        output: verdict.output,
        label: request.label,
        usage: { ...tokens, cost: microUsd / 1_000_000 },
        modelId: options.model,
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
}
