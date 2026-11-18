import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnReply, TurnRequest } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { ModelClientError } from "./client/errors.ts";
import { client, KEY, MODEL, type Reply, request, scriptedFetch, thrown, timeout } from "./test-support/support.ts";
import { checkToolCalls, createOpenRouterTurnModel, modelFailureCode, TurnTimedOutError } from "./turn.ts";

// The reasoner's model call that sends tools. Every test runs on a fake fetch: no model is called.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const PROVIDER = { data_collection: "deny", require_parameters: true };

const turnModel = (replies: readonly Reply[]) => {
  const { fetch, sent } = scriptedFetch(replies);
  const waits: number[] = [];
  const model = createOpenRouterTurnModel({
    apiKey: KEY,
    model: MODEL,
    deps: {
      fetch,
      now: () => new Date("2026-10-04T12:00:00Z"),
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  });
  return { model, sent, waits };
};

const TOOL = {
  name: "read_message" as const,
  description: "Read one message.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

const turnRequest = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
  system: "You look over one person's mail.",
  messages: [{ role: "user", text: '<data slot="source">\n"daily_sweep"\n</data>' }],
  tools: [TOOL],
  maxOutputTokens: 2000,
  ...overrides,
});

// One OpenRouter answer to a turn.
const turnAnswer = (
  options: {
    content?: string | null;
    toolCalls?: unknown[];
    usage?: Record<string, unknown> | null;
    model?: string;
  } = {},
) => {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content === undefined ? '{"actions":[]}' : options.content,
  };
  if (options.toolCalls !== undefined) message.tool_calls = options.toolCalls;
  const answer: Record<string, unknown> = {
    id: "gen-1",
    model: options.model ?? "vendor/some-other-model",
    choices: [{ index: 0, message, finish_reason: options.toolCalls === undefined ? "stop" : "tool_calls" }],
  };
  if (options.usage !== null)
    answer.usage = options.usage ?? {
      prompt_tokens: 900,
      completion_tokens: 40,
      total_tokens: 940,
      cost: 0.0012345,
    };
  return answer;
};

const vendorCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const body = (sent: { body: string }[], index = 0): Record<string, unknown> =>
  JSON.parse(sent[index]?.body ?? "") as Record<string, unknown>;
const code = (error: unknown): string => (error as ModelClientError).code;

describe("createOpenRouterTurnModel", () => {
  it("a turn goes to openrouter.ai and no other host, and follows no redirect", async () => {
    const { model, sent } = turnModel([{ body: turnAnswer() }]);
    await model.turn(turnRequest());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(ENDPOINT);
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.init.redirect).toBe("error");
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("a turn carries the tool definitions, the usage-accounting field and require_parameters, and complete still carries no tool", async () => {
    const { model, sent } = turnModel([{ body: turnAnswer() }]);
    await model.turn(turnRequest());
    const sentBody = body(sent);
    expect(Object.keys(sentBody).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "provider",
      "stream",
      "tools",
      "usage",
    ]);
    expect(sentBody).toMatchObject({ model: MODEL, max_tokens: 2000, stream: false, usage: { include: true } });
    expect(sentBody).not.toHaveProperty("response_format");
    expect(sentBody.tools).toEqual([
      { type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema } },
    ]);
    expect((sentBody.provider as Record<string, unknown>).require_parameters).toBe(true);
    expect((sentBody.messages as unknown[])[0]).toEqual({
      role: "system",
      content: "You look over one person's mail.",
    });

    const single = client();
    await single.model.complete(request());
    const completeBody = body(single.sent);
    expect(completeBody).not.toHaveProperty("tools");
    expect(completeBody).not.toHaveProperty("tool_choice");
  });

  it("every turn carries the same provider fields, and no temperature", async () => {
    const { model, sent } = turnModel([{ status: 429 }, { body: turnAnswer() }, { body: turnAnswer() }]);
    await model.turn(turnRequest());
    await model.turn(turnRequest({ tools: [] }));
    expect(sent).toHaveLength(3);
    for (let index = 0; index < sent.length; index += 1) expect(body(sent, index).provider).toEqual(PROVIDER);
    expect(body(sent)).not.toHaveProperty("temperature");
    // An option the function does not know is not read: nothing turns the fields off.
    const { fetch, sent: looseSent } = scriptedFetch([{ body: turnAnswer() }]);
    const loose = createOpenRouterTurnModel({ apiKey: KEY, model: MODEL, zdr: false, deps: { fetch } } as Parameters<
      typeof createOpenRouterTurnModel
    >[0]);
    await loose.turn(turnRequest());
    expect(body(looseSent).provider).toEqual(PROVIDER);
  });

  it("a request that does not parse is refused and no request is made", async () => {
    const { model, sent } = turnModel([{ body: turnAnswer() }]);
    const bad = [
      { ...turnRequest(), extra: true },
      turnRequest({ tools: [{ ...TOOL, name: "record" as "read_message" }] }),
      turnRequest({ maxOutputTokens: 0 }),
      { ...turnRequest(), messages: [{ role: "system", text: "x" }] },
    ];
    for (const one of bad) expect(code(await thrown(model.turn(one as TurnRequest)))).toBe("bad_request");
    expect(sent).toHaveLength(0);
  });

  it("a tool call in the answer becomes a tool call of the reply, and a tool result is sent back as the vendor's tool message", async () => {
    const { model, sent } = turnModel([
      {
        body: turnAnswer({
          content: null,
          toolCalls: [vendorCall("call_1", "read_message", { id: "msg_1", offset: 0 })],
        }),
      },
      { body: turnAnswer() },
    ]);
    const first = await model.turn(turnRequest());
    expect(first.text).toBeNull();
    expect(first.toolCalls).toEqual([{ id: "call_1", name: "read_message", arguments: { id: "msg_1", offset: 0 } }]);

    await model.turn(
      turnRequest({
        messages: [
          { role: "user", text: "start" },
          { role: "assistant", text: null, toolCalls: first.toolCalls },
          { role: "tool", id: "call_1", result: '{"text":"hello"}' },
        ],
      }),
    );
    expect((body(sent, 1).messages as unknown[]).slice(1)).toEqual([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_message", arguments: '{"id":"msg_1","offset":0}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"text":"hello"}' },
    ]);
  });

  it("usage, cost and the model's id are carried through, a missing cost is null, and a cost is rounded up to a whole micro-dollar", async () => {
    const { model } = turnModel([
      { body: turnAnswer() },
      { body: turnAnswer({ usage: { prompt_tokens: 10, completion_tokens: 2 } }) },
      { body: turnAnswer({ usage: null }) },
    ]);
    const priced = await model.turn(turnRequest());
    expect(priced).toEqual({
      text: '{"actions":[]}',
      toolCalls: [],
      inputTokens: 900,
      outputTokens: 40,
      costMicroUsd: 1235,
      modelId: MODEL,
    } satisfies TurnReply);
    expect(await model.turn(turnRequest())).toMatchObject({ inputTokens: 10, outputTokens: 2, costMicroUsd: null });
    expect(await model.turn(turnRequest())).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
    });
  });

  // A late, long turn can run past 60 seconds, and must not end the run.
  it("a turn waits five minutes, and one that runs past it is sent once and rejects as timed_out", async () => {
    const { model, sent } = turnModel([timeout()]);
    const error = await thrown(model.turn(turnRequest()));
    expect(error).toBeInstanceOf(TurnTimedOutError);
    expect(modelFailureCode(error)).toBe("timed_out");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.init.signal)).not.toBe("undefined");
    const second = turnModel([{ status: 400, body: { error: { message: "too long" } } }]);
    expect(modelFailureCode(await thrown(second.model.turn(turnRequest())))).toBe("http_400");
    expect(modelFailureCode(new Error("other"))).toBe("error");
  });

  it("an answer that does not parse, or one with 21 tool calls, rejects as unavailable", async () => {
    const many = Array.from({ length: 21 }, (_, index) => vendorCall(`call_${index}`, "get_self", {}));
    const replies: Reply[] = [
      { body: "not json" },
      { body: { choices: [] } },
      { body: { error: { message: "no provider" } } },
      { body: turnAnswer({ toolCalls: many }) },
      { body: turnAnswer({ toolCalls: ["not a call"] }) },
    ];
    for (const reply of replies) {
      const { model } = turnModel([reply]);
      expect(code(await thrown(model.turn(turnRequest())))).toBe("unavailable");
    }
  });

  it("a malformed tool call does not void the reply: it becomes a call of no read tool, and the usage is kept", async () => {
    const { model } = turnModel([
      {
        body: turnAnswer({
          toolCalls: [
            { id: "call_1", type: "function", function: { name: "get_self", arguments: "{not json" } },
            vendorCall("call_2", "functions.search", {}),
            vendorCall("x".repeat(200), "get_self", {}),
            vendorCall("call_4", "read_message", { id: "msg_1" }),
          ],
        }),
      },
    ]);
    const reply = await model.turn(turnRequest());
    expect(reply.toolCalls).toEqual([
      { id: "call_1", name: "invalid_tool_call", arguments: {} },
      { id: "call_2", name: "invalid_tool_call", arguments: {} },
      { id: "invalid_call_2", name: "invalid_tool_call", arguments: {} },
      { id: "call_4", name: "read_message", arguments: { id: "msg_1" } },
    ]);
    expect(reply.costMicroUsd).toBe(1235);
    expect(checkToolCalls(reply, ["get_self", "read_message"]).map((call) => call.ok)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("the body carries reasoning only when an effort is configured, and keeps require_parameters", async () => {
    const plain = turnModel([{ body: turnAnswer() }]);
    await plain.model.turn(turnRequest());
    expect(body(plain.sent)).not.toHaveProperty("reasoning");

    const { fetch, sent } = scriptedFetch([{ body: turnAnswer() }]);
    const high = createOpenRouterTurnModel({
      apiKey: KEY,
      model: MODEL,
      reasoningEffort: "high",
      deps: { fetch, sleep: async () => {} },
    });
    await high.turn(turnRequest());
    expect(body(sent).reasoning).toEqual({ effort: "high" });
    expect(body(sent).provider).toEqual(PROVIDER);
  });

  it("an answer cut off at the output limit reports truncated, keeps its usage, and its cut-off call is still no read tool", async () => {
    const cut = turnAnswer({
      content: null,
      toolCalls: [{ id: "call_1", type: "function", function: { name: "find_messages", arguments: '{"sender":"exa' } }],
    });
    (cut.choices as Record<string, unknown>[])[0]!.finish_reason = "length";
    const { model } = turnModel([{ body: cut }, { body: turnAnswer() }]);
    const reply = await model.turn(turnRequest());
    expect(reply.code).toBe("truncated");
    expect(reply.toolCalls).toEqual([{ id: "call_1", name: "invalid_tool_call", arguments: {} }]);
    expect(reply.costMicroUsd).toBe(1235);
    expect(await model.turn(turnRequest())).not.toHaveProperty("code");
  });

  it("a 429 is retried and a 401 is refused, as complete does", async () => {
    const retried = turnModel([{ status: 429 }, { body: turnAnswer() }]);
    await retried.model.turn(turnRequest());
    expect(retried.sent).toHaveLength(2);
    expect(retried.waits).toHaveLength(1);

    const refused = turnModel([{ status: 401 }]);
    expect(code(await thrown(refused.model.turn(turnRequest())))).toBe("refused");
    expect(refused.sent).toHaveLength(1);
  });
});

describe("checkToolCalls", () => {
  it("checkToolCalls marks a name outside the list unknown_tool and leaves the others", () => {
    const reply: TurnReply = {
      text: null,
      toolCalls: [
        { id: "a", name: "read_message", arguments: { id: "msg_1" } },
        { id: "b", name: "record", arguments: {} },
        { id: "c", name: "get_self", arguments: {} },
      ],
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1,
      modelId: MODEL,
    };
    expect(checkToolCalls(reply, ["read_message", "find_facts"])).toEqual([
      { ok: true, id: "a", name: "read_message", arguments: { id: "msg_1" } },
      { ok: false, id: "b", reason: "unknown_tool" },
      { ok: false, id: "c", reason: "unknown_tool" },
    ]);
  });
});

describe("turn.ts", () => {
  it("turn.ts imports no name of the shared model contract", () => {
    const text = readFileSync(join(import.meta.dirname, "turn.ts"), "utf8");
    for (const name of ["ModelRequest", "ModelResponse", "ToolDefinition", "checkCompletion", "completeWithReplay"])
      expect(text, name).not.toContain(name);
  });

  // An Anthropic model caches only up to a marked block; OpenAI's caching is automatic.
  it("marks the system prompt and the newest message for an Anthropic model's cache, and nothing for another model", async () => {
    const anthropic = (() => {
      const { fetch, sent } = scriptedFetch([{ body: turnAnswer() }]);
      return {
        model: createOpenRouterTurnModel({ apiKey: KEY, model: "anthropic/made-up-model", deps: { fetch } }),
        sent,
      };
    })();
    const messages: TurnRequest["messages"] = [
      { role: "user", text: "first" },
      { role: "assistant", text: null, toolCalls: [{ id: "call_1", name: "read_message", arguments: {} }] },
      { role: "tool", id: "call_1", result: "{}" },
    ];
    await anthropic.model.turn(turnRequest({ messages }));
    const cached = { type: "ephemeral" };
    expect(body(anthropic.sent).messages).toEqual([
      { role: "system", content: [{ type: "text", text: "You look over one person's mail.", cache_control: cached }] },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_message", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "{}", cache_control: cached }] },
    ]);
    const { model, sent } = turnModel([{ body: turnAnswer() }]);
    await model.turn(turnRequest({ messages }));
    expect(JSON.stringify(body(sent).messages)).not.toContain("cache_control");
  });
});
