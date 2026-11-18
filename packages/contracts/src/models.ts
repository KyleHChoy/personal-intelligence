import { z } from "zod";
import { EvidenceId, Sha256, TrustGroupId } from "./ids.ts";
import { ContentKeys } from "./keys.ts";
import { Label } from "./label.ts";
import { ReadTool, ReasonerTool, ToolErrorCode, ToolResult } from "./tools.ts";

const ModelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});
type ModelUsage = z.infer<typeof ModelUsage>;

// What a saved call is found by. A changed input never replays an old output.
export const ModelCallKey = z.object({
  evidenceId: EvidenceId,
  revision: z.number().int().nonnegative(),
  extractorGeneration: z.number().int().nonnegative(),
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  // SHA-256 of the rendered prompt text. A generated record has the hash of the empty string.
  inputHash: Sha256,
});
export type ModelCallKey = z.infer<typeof ModelCallKey>;

// SHA-256 of the empty string.
const EMPTY_INPUT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// A saved model input and output. keys names every item the input held: the store seals the
// record under them, and deleting any of those items purges it. A generated record, made for
// tests without rendering a prompt, has an empty renderedInput, and the recorded client matches
// it on the other five fields of its key. A saved record always carries the true input hash.
export const ModelCallRecord = z
  .object({
    key: ModelCallKey,
    keys: ContentKeys,
    renderedInput: z.string(),
    rawOutput: z.string(),
    outputHash: Sha256,
    label: Label,
    origin: z.enum(["live", "generated"]),
  })
  .refine(
    (record) =>
      record.origin !== "generated" || (record.renderedInput === "" && record.key.inputHash === EMPTY_INPUT_HASH),
    {
      message: "a generated record has no rendered input",
      path: ["renderedInput"],
    },
  );
export type ModelCallRecord = z.infer<typeof ModelCallRecord>;

// Why the reasoner made a tool call.
const DecisionPoint = z.enum([
  "candidate_set",
  "candidate_rank",
  "evidence_check",
  "hold_or_release",
  "stay_silent",
  "ask_research",
]);
type DecisionPoint = z.infer<typeof DecisionPoint>;

// The tools an agent loop may call: every read tool except read_item, and the reasoner's tools.
const AgentTool = z.enum([...ReadTool.exclude(["read_item"]).options, ...ReasonerTool.options]);
type AgentTool = z.infer<typeof AgentTool>;

const ToolDefinition = z.object({
  name: AgentTool,
  // A fixed string in code.
  description: z.string().min(1),
  // Generated from the tool's arguments schema.
  argsSchema: z.unknown(),
});
type ToolDefinition = z.infer<typeof ToolDefinition>;

const ToolCall = z.strictObject({
  id: z.string().min(1),
  name: AgentTool,
  // Parsed with the tool's arguments schema before any call.
  args: z.unknown(),
  decision: DecisionPoint,
});
type ToolCall = z.infer<typeof ToolCall>;

const ToolCallResult = z.discriminatedUnion("outcome", [
  z.object({ callId: z.string().min(1), outcome: z.literal("ok"), result: ToolResult }),
  z.object({ callId: z.string().min(1), outcome: z.literal("error"), code: ToolErrorCode }),
  z.object({ callId: z.string().min(1), outcome: z.literal("refused") }),
]);
type ToolCallResult = z.infer<typeof ToolCallResult>;

export const ToolCallBlock = z.strictObject({ type: z.literal("tool_call"), call: ToolCall });
export type ToolCallBlock = z.infer<typeof ToolCallBlock>;

const ToolResultBlock = z.strictObject({ type: z.literal("tool_result"), result: ToolCallResult });
type ToolResultBlock = z.infer<typeof ToolResultBlock>;

// A tool message answers the calls of the assistant message before it, one result per call.
const ModelMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("assistant"), blocks: z.array(ToolCallBlock) }),
  z.object({ role: z.literal("tool"), blocks: z.array(ToolResultBlock) }),
]);
type ModelMessage = z.infer<typeof ModelMessage>;

// Every tool message follows an assistant message and answers its calls one for one, by
// position. The call ids of one assistant message are unique: a loop answers a duplicate call
// under a rewritten id, as vendor tool-use APIs require.
const answersItsCalls = (messages: ModelMessage[]): boolean =>
  messages.every((message, index) => {
    if (message.role !== "tool") return true;
    const before = messages[index - 1];
    if (before === undefined || before.role !== "assistant" || message.blocks.length !== before.blocks.length)
      return false;
    const ids = before.blocks.map((block) => block.call.id);
    return new Set(ids).size === ids.length && ids.every((id, at) => message.blocks[at]!.result.callId === id);
  });

// Evidence text travels only in the data slots of a registered prompt. tools and messages only
// with a prompt registered `tools: "allowed"`: in the model client's own registry the reasoner's
// loop prompt alone, and in a caller's registry what the caller registered so.
export const ModelRequest = z
  .strictObject({
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    data: z.record(z.string(), z.string()),
    // The combined label of everything in data.
    label: Label,
    trustGroup: TrustGroupId,
    callKey: ModelCallKey.optional(),
    tools: z.array(ToolDefinition).optional(),
    messages: z.array(ModelMessage).optional(),
  })
  .refine((request) => request.messages === undefined || request.tools !== undefined, {
    message: "messages need tools",
    path: ["messages"],
  })
  .refine((request) => request.messages === undefined || answersItsCalls(request.messages), {
    message: "a tool message must answer the calls before it, one for one",
    path: ["messages"],
  });
export type ModelRequest = z.infer<typeof ModelRequest>;

export const ModelResponse = z.object({
  // Parsed with the prompt's closed schema.
  output: z.unknown(),
  // Equals the request's, whatever the output says.
  label: Label,
  usage: ModelUsage,
  modelId: z.string().min(1),
  blocks: z.array(ToolCallBlock).optional(),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const EmbeddingPurpose = z.enum(["need_capability_description", "query_text"]);
export type EmbeddingPurpose = z.infer<typeof EmbeddingPurpose>;

export const EmbeddingRequest = z.strictObject({
  purpose: EmbeddingPurpose,
  text: z.string().min(1),
  label: Label,
  trustGroup: TrustGroupId,
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequest>;

export const EmbeddingResponse = z.object({
  vector: z.array(z.number()),
  modelVersion: z.string().min(1),
  label: Label,
  usage: ModelUsage,
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponse>;

// The verifier's one question: is the need still open.
export const NeedCheckOutput = z.strictObject({ answer: z.enum(["open", "closed", "unsure"]) });
export type NeedCheckOutput = z.infer<typeof NeedCheckOutput>;

export const GatewayRefusal = z.strictObject({
  code: z.enum([
    "no_scope",
    "bad_scope",
    "wrong_gateway",
    "wrong_trust_group",
    "role_not_allowed",
    "unknown_prompt",
    "unlabelled",
    "tools_not_allowed",
    "bad_purpose",
    "vendor_failed",
  ]),
});
export type GatewayRefusal = z.infer<typeof GatewayRefusal>;
