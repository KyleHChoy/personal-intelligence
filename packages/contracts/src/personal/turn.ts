import { z } from "zod";
import { PersonalReadTool } from "./tools.ts";

// The reasoner's own request and reply for a model call that sends tools. Personal shapes, so a
// tool's name is typed by the personal read tools.

// The closed set of names is the personal read tools and nothing else.
export const TurnTool = z.strictObject({ name: PersonalReadTool, description: z.string(), inputSchema: z.unknown() });
export type TurnTool = z.infer<typeof TurnTool>;

// A word, not the closed set: a call of a tool that does not exist is refused by the loop and
// recorded, and does not void the reply's other calls.
export const TurnToolCall = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  arguments: z.unknown(),
});
export type TurnToolCall = z.infer<typeof TurnToolCall>;

// An Anthropic reply's content blocks as the API returned them (text, thinking,
// tool_use, server_tool_use and the web results), kept so the turn goes back to the API unchanged.
// Vendor data, read by no code but the Anthropic turn's: nothing in it is ever sent to the agent API.
const TurnContentBlock = z.record(z.string(), z.unknown());

export const TurnMessage = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), text: z.string() }),
  // `content`, when set, is what the Anthropic turn sends for this turn instead of text and calls.
  z.strictObject({
    role: z.literal("assistant"),
    text: z.string().nullable(),
    toolCalls: z.array(TurnToolCall),
    content: z.array(TurnContentBlock).optional(),
  }),
  z.strictObject({ role: z.literal("tool"), id: z.string(), result: z.string() }),
]);
export type TurnMessage = z.infer<typeof TurnMessage>;

const count = z.number().int().nonnegative();

export const TurnRequest = z.strictObject({
  system: z.string(),
  messages: z.array(TurnMessage),
  tools: z.array(TurnTool),
  maxOutputTokens: z.number().int().positive(),
});
export type TurnRequest = z.infer<typeof TurnRequest>;

// One web search or fetch the vendor ran for the reply, on its side: the query or the
// URL, recorded as a step of the run and never logged.
export const WEB_REQUEST_MAX = 4_096;
export const TurnWebRequest = z.strictObject({
  tool: z.enum(["web_search", "web_fetch"]),
  text: z.string().min(1).max(WEB_REQUEST_MAX),
});
export type TurnWebRequest = z.infer<typeof TurnWebRequest>;

// "truncated": the vendor stopped the reply at the output limit (finish_reason "length"), or, on
// Anthropic's turn, it was still paused after the last continuation, so its text
// and calls may be cut off mid-way, and the loop uses neither.
export const TurnReply = z.strictObject({
  text: z.string().nullable(),
  toolCalls: z.array(TurnToolCall).max(20),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  costMicroUsd: count.nullable(),
  modelId: z.string().min(1),
  code: z.literal("truncated").optional(),
  // On Anthropic's turn alone: every content block of the reply, the searches and
  // fetches it ran, and the searches the vendor billed (its usage's count, which prices them).
  content: z.array(TurnContentBlock).optional(),
  webRequests: z.array(TurnWebRequest).optional(),
  webSearchesBilled: count.optional(),
});
export type TurnReply = z.infer<typeof TurnReply>;
