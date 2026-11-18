import { EmbeddingPurpose, EmbeddingRequest, Label, ModelRequest, ModelResponse } from "@intelligence/contracts";
import { ModelClientError, ModelOutputRejected } from "./errors.ts";
import { lookupPrompt, type Prompt, REGISTRY, type RenderedPrompt, renderPrompt, validateOutput } from "./prompts.ts";

const fields = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

// What every client checks before it answers a completion: a label, a registered and unaltered
// prompt, tools and messages only where the prompt allows them, and evidence only in declared
// slots. It renders the prompt once and hands the text back. Callers are typed, but a request is
// checked as the data it is. The prompt is looked up in `registry`: the package's own unless the
// caller passes another.
export const checkCompletion = (
  raw: unknown,
  registry: readonly Prompt[] = REGISTRY,
): { request: ModelRequest; prompt: Prompt; rendered: RenderedPrompt } => {
  const input = fields(raw);
  if (!Label.safeParse(input.label).success) throw new ModelClientError("unlabelled");
  if (typeof input.promptId !== "string" || typeof input.promptVersion !== "string") {
    throw new ModelClientError("unknown_prompt");
  }
  const prompt = lookupPrompt(registry, input.promptId, input.promptVersion);
  if (prompt.tools !== "allowed" && (input.tools !== undefined || input.messages !== undefined)) {
    throw new ModelClientError("tools_not_allowed");
  }
  const parsed = ModelRequest.safeParse(raw);
  if (!parsed.success) throw new ModelClientError("bad_request");
  return { request: parsed.data, prompt, rendered: renderPrompt(prompt, parsed.data.data, registry) };
};

// An output that is a string is the model's raw JSON text. Any other is serialised, and one with
// no JSON form has no text.
const rawOutputOf = (output: unknown): string | undefined => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
};

// What every reply is checked for, by the gateway client and by completeWithReplay alike. One
// that is not a ModelResponse, or has no output, is no answer of a model: the call failed. Then
// no tool calls unless the prompt allows tools, the prompt's closed schema, and the request's
// label, whatever the reply says.
export const checkReply = (prompt: Prompt, request: ModelRequest, raw: unknown): ModelResponse => {
  const reply = ModelResponse.safeParse(raw);
  const rawOutput = reply.success ? rawOutputOf(reply.data.output) : undefined;
  if (!reply.success || rawOutput === undefined) throw new ModelClientError("unavailable");
  if (prompt.tools !== "allowed" && reply.data.blocks?.length) throw new ModelOutputRejected(rawOutput);
  return { ...reply.data, output: validateOutput(prompt, rawOutput), label: request.label };
};

export const checkEmbedding = (raw: unknown): EmbeddingRequest => {
  const input = fields(raw);
  if (!Label.safeParse(input.label).success) throw new ModelClientError("unlabelled");
  if (!EmbeddingPurpose.safeParse(input.purpose).success) throw new ModelClientError("bad_purpose");
  const parsed = EmbeddingRequest.safeParse(raw);
  if (!parsed.success) throw new ModelClientError("bad_request");
  return parsed.data;
};
