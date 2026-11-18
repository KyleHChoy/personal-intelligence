import type { ModelRequest } from "@intelligence/contracts";
import type { ModelUsageEvent } from "@intelligence/contracts/personal";
import { checkCompletion } from "./client/checks.ts";
import { ModelClientError } from "./client/errors.ts";
import type { Prompt } from "./client/prompts.ts";
import type { Pseudonymiser } from "./pseudonymise.ts";

// What every client of one plain completion does the same way: the shared check, no tools, the
// rendered text cut into its two messages, and the usage row of each outcome.

export type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
// A whole number a vendor's usage gives, or none.
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

// Whatever the prompt allows, a plain completion sends no tools.
export function plainCompletion(raw: ModelRequest, registry: readonly Prompt[]) {
  const checked = checkCompletion(raw, registry);
  if (checked.request.tools !== undefined || checked.request.messages !== undefined)
    throw new ModelClientError("tools_not_allowed");
  return checked;
}

// The rendered text is the instructions, a blank line and the data blocks: the system and user
// messages, which joined by that blank line are the text that was hashed. A text of any other layout
// is refused, never split wrong under a hash that still matches.
export function messagesOf(prompt: Prompt, text: string): { system: string; user: string } {
  const start = `${prompt.instructions}\n\n`;
  if (!text.startsWith(start)) throw new ModelClientError("bad_request");
  return { system: prompt.instructions, user: text.slice(start.length) };
}

// One request's usage row of an outcome, under the model id the row takes.
export const usageReporter =
  (onUsage: (event: ModelUsageEvent) => Promise<void>, request: ModelRequest, modelId: string) =>
  (
    outcome: ModelUsageEvent["outcome"],
    costMicroUsd: number,
    tokens: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
  ): Promise<void> => {
    const evidenceId = request.callKey?.evidenceId;
    return onUsage({
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      modelId,
      ...tokens,
      costMicroUsd,
      outcome,
      ...(evidenceId === undefined ? {} : { evidenceId }),
    });
  };

export type OpenRouterOptions = {
  apiKey: string;
  model: string;
  registry: readonly Prompt[];
  onUsage: (event: ModelUsageEvent) => Promise<void>;
  deps?: {
    fetch?: typeof fetch;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    pseudonymiser?: Pseudonymiser;
  };
};

// Each attempt's deadline: 16 000 tokens at about 100 a second is 160 seconds. At the shared 60, a
// long answer would time out, which is no answer: deferred, sent again each run, never final.
export const ATTEMPT_MS = 180_000;
// The most tokens one answer may take, its reasoning included: OpenRouter counts a reasoning
// model's reasoning against max_tokens, and at 1 500 prompt version 2 lost one item in seven to
// `cut_off`. Version 2's prompt is 8 517 characters of the 60 000 `promptChars` allows. One of its
// claims is about 300 characters of structure (its example's are 270 to 385, with 32-character
// statements), about 100 tokens at three characters a token, and its statement a whole sentence, up
// to about 75 tokens more. So 8 000 tokens hold about 45 claims of a 300-character sentence each,
// and the other 8 000 the reasoning. 16 000 stays under 16 384, a common output limit, so an
// endpoint that took 1 500 is expected to take it. An answer past it is still cut off, paid for
// once and kept as a rejection. One call can pass the budget's stop line by up to 16 000 output
// tokens' price.
export const MAX_TOKENS = 16_000;

// One surrounding code fence, with or without a language word, is removed; nothing else is.
const FENCE = /^```[a-z]*\n([\s\S]*?)\n?```$/;
export const unfenced = (content: string): string => {
  const trimmed = content.trim();
  const inner = FENCE.exec(trimmed)?.[1];
  return inner === undefined || inner.includes("```") ? trimmed : inner;
};
