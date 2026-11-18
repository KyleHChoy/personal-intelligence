import {
  PersonalContextPackPurpose,
  PersonalReadTool,
  type TurnMessage,
  type TurnReply,
  ULID_PATTERN,
} from "@intelligence/contracts/personal";
import { codePoints } from "./fit.ts";

// What both of the reasoner's conversations share, the run's loop (loop.ts) and the outcome test's
// (outcome-test.ts): what a tool may be, what a result may hold, how a conversation is made shorter,
// and how a reply goes back into it. Each loop keeps its own limits and its own stops.

// Every read tool but sync_memory: the reasoner keeps nothing between runs and is not a memory
// target.
export const REASONER_TOOLS: readonly PersonalReadTool[] = PersonalReadTool.options.filter(
  (tool) => tool !== "sync_memory",
);

// What to do about it, since the cap is below a whole read_message slice.
export const TOO_LARGE =
  "result too large: ask for less (read_message takes offset and limit; a list tool takes limit)";
// One result is at most 40 000 code points (about 10 000 tokens), so no single read
// floods the context.
export const MAX_RESULT_CODE_POINTS = 40_000;
// A result smaller than this is kept whole: an error or a short answer costs less than its stub.
const STUB_OVER = 1_000;
const STUB_IDS = 50;
const ID = new RegExp(String.raw`\b[a-z]{3}_${ULID_PATTERN}\b`, "g");
// Each tool call's id, with its tool's name.
function toolNames(messages: readonly TurnMessage[]): Map<string, string> {
  const tools = new Map<string, string>();
  for (const message of messages)
    if (message.role === "assistant") for (const call of message.toolCalls) tools.set(call.id, call.name);
  return tools;
}

// A result replaced by a stub: why it was left out, and the first ids it held.
const STUB_START = '{"omitted"';
function stub(result: string, omitted: string): string {
  return JSON.stringify({ omitted, ids: [...new Set(result.match(ID) ?? [])].slice(0, STUB_IDS) });
}

// Every tool result before the last assistant turn, larger than STUB_OVER, as a stub
// with its tool's name and the ids it held. Returns how many were replaced.
export function compactResults(messages: TurnMessage[]): number {
  const last = messages.findLastIndex((message) => message.role === "assistant");
  const tools = toolNames(messages);
  let replaced = 0;
  messages.forEach((message, index) => {
    if (message.role !== "tool" || index >= last || codePoints(message.result) <= STUB_OVER) return;
    message.result = stub(
      message.result,
      `an earlier ${tools.get(message.id) ?? "tool"} result, left out to keep the context small; call the tool again for its content`,
    );
    replaced += 1;
  });
  return replaced;
}

// The largest whole results, one at a time, as stubs that ask for less, until
// `fits` says the call is under the cap or none is left. Returns how many were replaced.
export function capResults(messages: TurnMessage[], fits: () => boolean): number {
  const tools = toolNames(messages);
  let replaced = 0;
  while (!fits()) {
    let largest: Extract<TurnMessage, { role: "tool" }> | undefined;
    for (const message of messages) {
      if (message.role !== "tool" || codePoints(message.result) <= STUB_OVER || message.result.startsWith(STUB_START))
        continue;
      if (largest === undefined || codePoints(message.result) > codePoints(largest.result)) largest = message;
    }
    if (largest === undefined) return replaced;
    largest.result = stub(
      largest.result,
      `a ${tools.get(largest.id) ?? "tool"} result too large to keep with the rest; ask for less (a limit, an offset, or fewer calls in one turn)`,
    );
    replaced += 1;
  }
  return replaced;
}

// Once any result is stubbed, the conversation before the newest turn has changed,
// and a thinking block the vendor bound to the old one would be refused. Every thinking block goes,
// as the vendor's own recovery does; the turns' text, calls and web results stay. Returns how many.
export function dropThinking(messages: TurnMessage[]): number {
  let dropped = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || message.content === undefined) continue;
    const kept = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
    dropped += message.content.length - kept.length;
    message.content = kept;
  }
  return dropped;
}

// Once every thinking block is gone, nothing binds an earlier turn's server tool
// blocks either. Each search or fetch, with its result, in every assistant turn before `before`
// becomes a text block of ours naming it, and the turn's text loses its citations, which point at
// the results. Code execution the vendor ran to filter them goes too. The turn's own calls stay.
// Returns how many searches and fetches were left out. Run only where dropThinking runs after it.
export function compactWeb(messages: TurnMessage[], before: number): number {
  let replaced = 0;
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || message.content === undefined || index >= before) return;
    const server = (block: Record<string, unknown>): boolean =>
      block.type === "server_tool_use" ||
      (typeof block.type === "string" && block.type !== "tool_result" && block.type.endsWith("_tool_result"));
    if (!message.content.some(server)) return;
    message.content = message.content.flatMap((block): Record<string, unknown>[] => {
      if (!server(block)) {
        if (block.type !== "text" || block.citations === undefined) return [block];
        const { citations: _, ...plain } = block;
        return [plain];
      }
      if (block.type !== "server_tool_use" || (block.name !== "web_search" && block.name !== "web_fetch")) return [];
      const input =
        typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
      const what = block.name === "web_search" ? input.query : input.url;
      replaced += 1;
      return [
        {
          type: "text",
          text: `[an earlier ${String(block.name)} of ${JSON.stringify(typeof what === "string" ? what : "")}: its result was left out to keep the context small; run it again if you need it]`,
        },
      ];
    });
  });
  return replaced;
}

// The reply as the conversation's assistant turn: with its content blocks when the vendor gave
// them, so it goes back unchanged.
export const assistantOf = (reply: TurnReply, toolCalls: TurnReply["toolCalls"]): TurnMessage => ({
  role: "assistant",
  text: reply.text,
  toolCalls,
  ...(reply.content === undefined ? {} : { content: reply.content }),
});

// The cost of one model call in micro-dollars: the vendor's, else the tokens at the ceiling price,
// else unknown; and whether it was priced at the ceiling.
export const costOf = (reply: TurnReply, ceiling: number): { microUsd: number; atCeiling: boolean } | null => {
  if (reply.costMicroUsd !== null) return { microUsd: reply.costMicroUsd, atCeiling: false };
  if (reply.inputTokens === null || reply.outputTokens === null) return null;
  return { microUsd: (reply.inputTokens + reply.outputTokens) * ceiling, atCeiling: true };
};

// What a model sends is made to say what it means before the call: no arguments, or null, is an
// empty object; a null argument is left out, since no read tool takes one; and build_context_pack
// keeps only the id its purpose takes, since a model passes ids it was given that the purpose does
// not take.
const PACK_ID: Readonly<Record<PersonalContextPackPurpose, string | null>> = {
  agent_bootstrap: null,
  meeting_prep: "event",
  person_brief: "entity",
  project_brief: "project",
};
export const purposeOf = (args: Record<string, unknown>): PersonalContextPackPurpose | null =>
  PersonalContextPackPurpose.safeParse(args.purpose).data ?? null;
export const argumentsOf = (tool: string, given: unknown): unknown => {
  if (given === null || given === undefined) return {};
  if (typeof given !== "object" || Array.isArray(given)) return given;
  const args = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null));
  if (tool !== "build_context_pack") return args;
  const purpose = purposeOf(args);
  const keep = purpose === null ? null : PACK_ID[purpose];
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !["event", "entity", "project"].includes(name) || name === keep),
  );
};
