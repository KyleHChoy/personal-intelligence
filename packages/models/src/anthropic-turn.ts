import {
  type TurnMessage,
  TurnReply,
  TurnRequest,
  TurnToolCall,
  type TurnWebRequest,
  WEB_REQUEST_MAX,
} from "@intelligence/contracts/personal";
import { ModelClientError } from "./client/errors.ts";
import { count, isRecord, type Json, parseJson } from "./completion.ts";
import { depsOf, send } from "./retry.ts";
import { type ServerTools, type TurnModel, type TurnModelOptions, TurnTimedOutError } from "./turn.ts";
import { microUsd } from "./usage.ts";

// The reasoner's turn on Anthropic's Messages API directly, beside
// createOpenRouterTurnModel: the same TurnRequest in, the same TurnReply out. Picked by the key
// (an Anthropic key starts sk-ant-). It keeps no prompt and no answer, and falls back to no other
// model. Current models think adaptively by default; the effort setting is sent as
// `output_config.effort`. A reply's content blocks are
// kept whole (thinking, server tool calls and web results among them), and an assistant turn that
// carries them goes back unchanged; one that does not is rebuilt from its text and calls, with no
// thinking, which the API accepts. Web search and web fetch are offered when `serverTools` says so;
// they run on Anthropic's side within the reply, and a turn the API paused is sent back as it is
// until it ends.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
// As createOpenRouterTurnModel's: a guard against a hung connection only.
const TURN_ATTEMPT_MS = 1_800_000;

// An Anthropic key: the reasoner then calls Anthropic directly, and OpenRouter's key check is not
// asked.
export const anthropicKey = (apiKey: string): boolean => apiKey.startsWith("sk-ant-");

// OpenRouter's id (anthropic/claude-haiku-5.5) as Anthropic's (claude-haiku-5-5); an id that is
// already Anthropic's is kept. Any other vendor's model cannot run on an Anthropic key.
export function anthropicModelId(model: string): string | null {
  const bare = model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  if (!bare.startsWith("claude-")) return null;
  return bare.replaceAll(".", "-");
}

// US dollars per million tokens, input and output, by exact model id, from Anthropic's price list.
// A cache write counts 1.25 times input and a cache read 0.1 times (provisional:
// some models price cache reads lower, so this errs high). A model not listed reports no cost,
// and the budget counts the assumed call cost instead.
const PRICES: Readonly<Record<string, readonly [input: number, output: number]>> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};
// A web search costs 10 dollars a thousand, from Anthropic's price list (provisional, rule data
// like the token prices); a web fetch costs only the tokens it adds.
const WEB_SEARCH_MICRO_USD = 10_000;
// The server tools' versions for current models, and the most a fetched page may add to the
// context, in tokens: the reasoner's cap on one tool result, about 40 000 code points.
const WEB_SEARCH_TOOL = "web_search_20260209";
const WEB_FETCH_TOOL = "web_fetch_20260209";
const WEB_FETCH_MAX_CONTENT_TOKENS = 10_000;
// The models these versions run on (Anthropic's server tools reference). Another
// model, a trial run's Haiku among them, is offered no server tool and no rules.
const WEB_TOOL_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);
// A turn the API paused is sent back at most this many times; one still paused is cut off.
const MAX_CONTINUATIONS = 10;
// Haiku 5.5's long-context price: a request of more than 100 000 input tokens costs five times as
// much (the reasoner keeps calls under it; this prices one that is not).
const LONG_CONTEXT: Readonly<Record<string, readonly [over: number, input: number, output: number]>> = {
  "claude-haiku-5-5": [100_000, 0.5, 2.5],
};

const cached = (block: Json): Json => ({ ...block, cache_control: { type: "ephemeral" } });

// One message's content blocks. A tool result is a user turn's block, as Anthropic takes it. An
// assistant turn with its content blocks sends them as they came.
const blocksOf = (message: TurnMessage): { role: "user" | "assistant"; blocks: Json[] } => {
  switch (message.role) {
    case "user":
      return { role: "user", blocks: [{ type: "text", text: message.text }] };
    case "assistant":
      if (message.content !== undefined)
        return { role: "assistant", blocks: message.content.map((block) => ({ ...block })) };
      return {
        role: "assistant",
        blocks: [
          ...(message.text === null || message.text.trim() === "" ? [] : [{ type: "text", text: message.text }]),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ],
      };
    case "tool":
      return { role: "user", blocks: [{ type: "tool_result", tool_use_id: message.id, content: message.result }] };
  }
};

// Anthropic's messages: turns of one role in a row are one turn (each tool result of an assistant
// turn goes back in one user turn), and the newest block is marked for the prompt cache, so each
// turn reads every turn before it from the cache.
export function anthropicMessages(messages: readonly TurnMessage[]): Json[] {
  const turns: { role: "user" | "assistant"; blocks: Json[] }[] = [];
  for (const message of messages) {
    const { role, blocks } = blocksOf(message);
    // Anthropic refuses an empty turn: an answer with no text and no call (one the loop asks again
    // after) is left out, and the user turn after it joins the one before.
    if (blocks.length === 0) continue;
    const last = turns.at(-1);
    if (last !== undefined && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks: [...blocks] });
  }
  // The newest user turn and the one before it: a turn of many tool results puts the earlier
  // mark past the cache's 20-block lookback, and the second mark keeps the history read from the
  // cache. With the system prompt's, three of Anthropic's four marks.
  const users = turns.filter((turn) => turn.role === "user").slice(-2);
  for (const turn of users) {
    const end = turn.blocks.at(-1);
    if (end !== undefined) turn.blocks[turn.blocks.length - 1] = cached(end);
  }
  return turns.map((turn) => ({ role: turn.role, content: turn.blocks }));
}

// The server tools' definitions, after the read tools, for a model that runs them.
const serverToolsOf = (model: string, server: ServerTools | undefined): Json[] =>
  !WEB_TOOL_MODELS.has(model)
    ? []
    : [
        ...(server?.webSearch === undefined
          ? []
          : [{ type: WEB_SEARCH_TOOL, name: "web_search", max_uses: server.webSearch.maxUses }]),
        ...(server?.webFetch === undefined
          ? []
          : [
              {
                type: WEB_FETCH_TOOL,
                name: "web_fetch",
                max_uses: server.webFetch.maxUses,
                max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
              },
            ]),
      ];

// `paused`: the content of a turn the API paused, sent back as the newest assistant turn, so the
// API goes on with it.
const bodyOf = (model: string, options: TurnModelOptions, request: TurnRequest, paused: readonly Json[]): string => {
  const server = serverToolsOf(model, options.serverTools);
  const rules = server.length === 0 ? undefined : options.serverTools?.rules;
  const messages = anthropicMessages(request.messages);
  if (paused.length > 0) messages.push({ role: "assistant", content: paused });
  return JSON.stringify({
    model,
    system:
      rules === undefined
        ? [cached({ type: "text", text: request.system })]
        : [{ type: "text", text: request.system }, cached({ type: "text", text: rules })],
    messages,
    tools: [
      ...request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      ...server,
    ],
    max_tokens: request.maxOutputTokens,
    ...(options.reasoningEffort === undefined ? {} : { output_config: { effort: options.reasoningEffort } }),
  });
};

// Whether a model, in Anthropic's form, is on the price list, so a configuration
// can refuse one whose calls would report no cost.
export const anthropicPriced = (model: string): boolean => PRICES[model] !== undefined;

// What a reply cost, from its usage and the price list, or null for a model not on it.
export function anthropicCostMicroUsd(model: string, usage: Json): number | null {
  const listed = PRICES[model];
  if (listed === undefined) return null;
  const read =
    count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
  const long = LONG_CONTEXT[model];
  const [input, output] = long !== undefined && read > long[0] ? [long[1], long[2]] : listed;
  const dollars =
    (count(usage.input_tokens) * input +
      count(usage.cache_creation_input_tokens) * input * 1.25 +
      count(usage.cache_read_input_tokens) * input * 0.1 +
      count(usage.output_tokens) * output) /
    1_000_000;
  // Each web search the vendor billed.
  return microUsd(dollars) + searchesOf(usage) * WEB_SEARCH_MICRO_USD;
}

// The web searches an answer's usage says the vendor billed.
const searchesOf = (usage: Json): number =>
  isRecord(usage.server_tool_use) ? count(usage.server_tool_use.web_search_requests) : 0;

const INVALID_CALL = "invalid_tool_call";

// One answer of the API: its content blocks, usage and stop reason, or null when it is not one.
type Answer = { content: Json[]; usage: Json; stop: unknown };
const answerOf = (answer: unknown): Answer | null => {
  if (!isRecord(answer) || answer.type !== "message" || !Array.isArray(answer.content)) return null;
  const content: Json[] = [];
  for (const block of answer.content) {
    if (!isRecord(block)) return null;
    content.push(block);
  }
  return { content, usage: isRecord(answer.usage) ? answer.usage : {}, stop: answer.stop_reason };
};

// At most `max` UTF-16 units, cut between code points.
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > max) break;
    kept += point;
  }
  return kept;
};

// The searches and fetches a reply's content shows the vendor ran, each with its
// query or URL; a call of either with neither is left out (the billed count still prices it).
const webRequestsOf = (content: readonly Json[]): TurnWebRequest[] =>
  content.flatMap((block): TurnWebRequest[] => {
    if (block.type !== "server_tool_use" || (block.name !== "web_search" && block.name !== "web_fetch")) return [];
    const input = isRecord(block.input) ? block.input : {};
    const value = block.name === "web_search" ? input.query : input.url;
    return typeof value === "string" && value.trim() !== ""
      ? [{ tool: block.name, text: clip(value, WEB_REQUEST_MAX) }]
      : [];
  });

// Text blocks as one text: joined with nothing when any cites a source, since the API splits cited
// text into blocks, else with a line break.
const joined = (blocks: readonly Json[]): string | null => {
  const texts = blocks.filter((block) => block.type === "text" && typeof block.text === "string");
  if (texts.length === 0) return null;
  const cited = texts.some((block) => Array.isArray(block.citations) && block.citations.length > 0);
  return texts.map((block) => block.text as string).join(cited ? "" : "\n");
};

// The reply's text: its text after the last server tool's result, so what it said while it searched
// is not part of its answer; all its text when none follows one.
const textOf = (content: readonly Json[]): string | null => {
  const lastResult = content.findLastIndex(
    (block) => typeof block.type === "string" && block.type !== "tool_result" && block.type.endsWith("_tool_result"),
  );
  const after = joined(content.slice(lastResult + 1));
  return after !== null && after.trim() !== "" ? after : joined(content);
};

// The sum of several answers' usage, as one usage: each count, and each search.
const usageSum = (answers: readonly Answer[]): Json => {
  const sum = (field: string): number => answers.reduce((total, one) => total + count(one.usage[field]), 0);
  const searches = answers.reduce((total, one) => total + searchesOf(one.usage), 0);
  return {
    input_tokens: sum("input_tokens"),
    cache_creation_input_tokens: sum("cache_creation_input_tokens"),
    cache_read_input_tokens: sum("cache_read_input_tokens"),
    output_tokens: sum("output_tokens"),
    server_tool_use: { web_search_requests: searches },
  };
};

// Answers of one turn (more than one when the API paused it) as a TurnReply, or null when it is not
// one. `model` is the id called, in Anthropic's form, and is the reply's modelId, so the route reads
// from the id. Each answer is priced on its own, since the long-context price is per request.
// `cutOff`: the turn ended unfinished.
const replyOf = (model: string, answers: readonly Answer[], cutOff: boolean): TurnReply | null => {
  const content = answers.flatMap((one) => one.content);
  // A call whose id is not one is answered under an id of ours, which its block does not hold:
  // the turn is then rebuilt from its text and calls, never sent back as it came.
  let rebuilt = false;
  const toolCalls: TurnToolCall[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "tool_use") continue;
    const parsed = TurnToolCall.safeParse({ id: block.id, name: block.name, arguments: block.input });
    if (parsed.success) {
      toolCalls.push(parsed.data);
      continue;
    }
    // As the OpenRouter turn: a call that is not one is a call of no read tool, which the loop refuses.
    const id = TurnToolCall.shape.id.safeParse(block.id);
    if (!id.success) rebuilt = true;
    toolCalls.push({ id: id.success ? id.data : `invalid_call_${index}`, name: INVALID_CALL, arguments: {} });
  }
  const usage = usageSum(answers);
  const costs = answers.map((one) => anthropicCostMicroUsd(model, one.usage));
  const webRequests = webRequestsOf(content);
  const searches = searchesOf(usage);
  const parsed = TurnReply.safeParse({
    text: textOf(content),
    toolCalls,
    // Every input token the turn read: fresh, written to the cache and read from it.
    inputTokens:
      count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
    outputTokens: count(usage.output_tokens),
    costMicroUsd: costs.some((cost) => cost === null)
      ? null
      : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
    modelId: model,
    ...(cutOff ? { code: "truncated" } : {}),
    ...(rebuilt ? {} : { content }),
    ...(webRequests.length === 0 ? {} : { webRequests }),
    ...(searches === 0 ? {} : { webSearchesBilled: searches }),
  });
  return parsed.success ? parsed.data : null;
};

export function createAnthropicTurnModel(options: TurnModelOptions): TurnModel {
  const model = anthropicModelId(options.model);
  if (model === null) throw new ModelClientError("bad_request");
  const deps = depsOf(options.deps);
  return {
    async turn(raw) {
      const request = TurnRequest.safeParse(raw);
      if (!request.success) throw new ModelClientError("bad_request");
      const answers: Answer[] = [];
      const started = deps.now().getTime();
      // pause_turn: the API stopped a long server tool turn; the turn so far is sent
      // back as it is, with nothing added, and the API goes on with it, within the one turn's
      // deadline: a continuation gets what is left of it.
      for (;;) {
        const left = TURN_ATTEMPT_MS - (deps.now().getTime() - started);
        const sent = await send(
          ENDPOINT,
          {
            method: "POST",
            headers: { "x-api-key": options.apiKey, "anthropic-version": VERSION, "content-type": "application/json" },
            body: bodyOf(
              model,
              options,
              request.data,
              answers.flatMap((one) => one.content),
            ),
            redirect: "error",
          },
          deps,
          left,
        );
        if (sent.kind === "timed_out") throw new TurnTimedOutError();
        const one = answerOf(parseJson(sent.text));
        if (one === null) throw new ModelClientError("unavailable");
        answers.push(one);
        if (
          one.stop !== "pause_turn" ||
          answers.length > MAX_CONTINUATIONS ||
          deps.now().getTime() - started >= TURN_ATTEMPT_MS
        )
          break;
      }
      const last = answers.at(-1)?.stop;
      // Cut off at max_tokens, or still paused after the last continuation: used as truncated.
      const reply = replyOf(model, answers, last === "max_tokens" || last === "pause_turn");
      if (reply === null) throw new ModelClientError("unavailable");
      return reply;
    },
  };
}
