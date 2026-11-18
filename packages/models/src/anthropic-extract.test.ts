import type { ModelUsageEvent } from "@intelligence/contracts/personal";
import { REJECTED_CONTENT_FILTER, REJECTED_LENGTH } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicEffort, createAnthropicExtractClient } from "./anthropic-extract.ts";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import {
  OUTPUT,
  PROMPT,
  REGISTRY,
  type Reply,
  request,
  scriptedFetch,
  thrown,
  timeout,
} from "./test-support/support.ts";

// The extraction port on Anthropic's API directly. Every test runs on a fake fetch: no model is
// called, and the key is made up.

const KEY = "sk-ant-test-not-a-real-key-0000";
const USAGE = { input_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1_000 };

const answer = (content: unknown[], stop = "end_turn", usage: Record<string, unknown> = USAGE) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content,
  stop_reason: stop,
  usage,
});
const good = () =>
  answer([
    { type: "thinking", thinking: "", signature: "x" },
    { type: "text", text: JSON.stringify(OUTPUT) },
  ]);

const extract = (replies: readonly Reply[], options: { effort?: AnthropicEffort; model?: string } = {}) => {
  const { fetch, sent } = scriptedFetch(replies);
  const usage: ModelUsageEvent[] = [];
  const model = createAnthropicExtractClient({
    apiKey: KEY,
    model: options.model ?? "claude-haiku-5-5",
    registry: REGISTRY,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    onUsage: async (event) => void usage.push(event),
    deps: { fetch, sleep: async () => {}, random: () => 0 },
  });
  return { model, sent, usage };
};
const body = (text: string | undefined): Record<string, unknown> => JSON.parse(text ?? "{}") as Record<string, unknown>;

describe("createAnthropicExtractClient", () => {
  it("sends one Messages request: the instructions as system, the data as the one user message, no tools, no temperature", async () => {
    const { model, sent } = extract([{ body: good() }]);
    await model.complete(request());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(sent[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent[0]?.init.redirect).toBe("error");
    const sentBody = body(sent[0]?.body);
    expect(Object.keys(sentBody).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
    expect(sentBody).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16_000, system: PROMPT.instructions });
    expect(sentBody.messages).toEqual([
      {
        role: "user",
        content: '<data slot="message">\n{"subject":"Report","body":"I will send the report."}\n</data>',
      },
    ]);
    expect(sent[0]?.body).not.toContain(KEY);
  });

  it("sends the effort as output_config.effort when one is given, and OpenRouter's id as Anthropic's", async () => {
    const { model, sent } = extract([{ body: good() }], { effort: "max", model: "anthropic/claude-haiku-5.5" });
    await model.complete(request());
    expect(body(sent[0]?.body)).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "max" } });
  });

  it("an Anthropic client records claude-haiku-5-5 and the saved call keeps the configured id", async () => {
    const { model, usage } = extract([{ body: good() }], { model: "anthropic/claude-haiku-5.5" });
    const response = await model.complete(request());
    expect(usage.map((one) => one.modelId)).toEqual(["claude-haiku-5-5"]);
    expect(response.modelId).toBe("anthropic/claude-haiku-5.5");
  });

  it("refuses another vendor's model before any request", () => {
    expect(() => extract([], { model: "openai/gpt-6-luna" })).toThrow(ModelClientError);
  });

  it("reads a good answer's text, past its thinking block, and reports its cost from the price list", async () => {
    const { model, usage } = extract([{ body: good() }]);
    const response = await model.complete(request());
    expect(response.output).toEqual(OUTPUT);
    // Haiku 5.5: 2 000 input tokens at 0.10 and 1 000 output at 0.50 a million: 700 micro-dollars.
    expect(usage).toEqual([
      expect.objectContaining({
        modelId: "claude-haiku-5-5",
        inputTokens: 2_000,
        outputTokens: 1_000,
        costMicroUsd: 700,
        outcome: "ok",
        evidenceId: request().callKey?.evidenceId,
      }),
    ]);
    expect(response.usage).toEqual({ inputTokens: 2_000, outputTokens: 1_000, cost: 0.0007 });
  });

  it("an answer stopped at max_tokens or the context window is cut off, and a refusal is filtered: both counted as rejected", async () => {
    for (const [stop, marker] of [
      ["max_tokens", REJECTED_LENGTH],
      ["model_context_window_exceeded", REJECTED_LENGTH],
      ["refusal", REJECTED_CONTENT_FILTER],
    ] as const) {
      const { model, usage } = extract([{ body: answer([{ type: "text", text: JSON.stringify(OUTPUT) }], stop) }]);
      const error = await thrown(model.complete(request()));
      expect(error).toBeInstanceOf(ModelOutputRejected);
      expect((error as ModelOutputRejected).rawOutput).toBe(marker);
      expect(usage.map((event) => event.outcome)).toEqual(["rejected"]);
    }
  });

  it("reads a final json fence or a final bare object after prose, and only those forms, against the schema", async () => {
    const fenced = (text: string) => answer([{ type: "text", text }]);
    const json = JSON.stringify(OUTPUT);
    const read = async (text: string) => {
      const { model, usage } = extract([{ body: fenced(text) }]);
      const outcome = await model.complete(request()).then(
        (response) => ({ output: response.output }),
        (error: unknown) => ({ rejected: (error as ModelOutputRejected).rawOutput }),
      );
      return { outcome, usage: usage.map((event) => event.outcome) };
    };
    for (const text of [
      `I read the message.\r\n\`\`\`json\r\n${json}\r\n\`\`\`\r\n`,
      `I read the message.\n\n\`\`\`json\n${json}\n\`\`\``,
      `Notes first.\n\`\`\`json\n${json}\n\`\`\`\n\n  `,
      `\`\`\`json\n${json}\n\`\`\``,
      json,
      `I read the message. It says {nothing} in braces.\n${json}\n`,
      `Reasoning first.\n\n${JSON.stringify(OUTPUT, null, 2)}`,
    ]) {
      expect(await read(text), text.slice(0, 20)).toEqual({ outcome: { output: OUTPUT }, usage: ["ok"] });
    }
    for (const text of [
      `Prose.\n\`\`\`json\n${json}\n\`\`\`\nAnd a closing word.`,
      `Prose.\n\`\`\`\n${json}\n\`\`\``,
      `Prose.\n\`\`\`js\n${json}\n\`\`\``,
      `Prose.\n\`\`\`json\n${json}\n\`\`\`\nMore.\n\`\`\`json\n{"x":\n\`\`\``,
      `Prose.\n\`\`\`json\n{"claims": "not a list"}\n\`\`\``,
      `Prose \`\`\`json\n${json}\n\`\`\``,
      `Prose.\n${json}\nAnd a closing word.`,
      `Prose.\n${json}\n${json}`,
      `Prose.\n{"claims": "not a list"}`,
      `Prose with an object inline ${json}`,
    ]) {
      expect(await read(text), text.slice(0, 40)).toEqual({ outcome: { rejected: text }, usage: ["rejected"] });
    }
  });

  it("a timed-out attempt is counted at the assumed cost and is unavailable", async () => {
    const deadline = vi.spyOn(AbortSignal, "timeout");
    try {
      const { model, usage } = extract([timeout()]);
      const error = await thrown(model.complete(request()));
      expect((error as ModelClientError).code).toBe("unavailable");
      expect(usage.map((event) => [event.outcome, event.costMicroUsd])).toEqual([["timed_out", 10_000]]);
      expect(deadline.mock.calls).toEqual([[180_000]]);
    } finally {
      deadline.mockRestore();
    }
  });

  it("an answer whose usage gives no token counts is cost_missing, never free", async () => {
    for (const usage of [
      {},
      { input_tokens: 2_000 },
      { input_tokens: "2000", output_tokens: 10 },
      { input_tokens: -1, output_tokens: -1 },
    ]) {
      const { model, usage: events } = extract([
        { body: answer([{ type: "text", text: JSON.stringify(OUTPUT) }], "end_turn", usage) },
      ]);
      await model.complete(request());
      expect(events.map((event) => [event.outcome, event.costMicroUsd])).toEqual([["cost_missing", 10_000]]);
    }
  });

  it("a body that is not a message is unavailable; a model off the price list is cost_missing", async () => {
    const { model } = extract([{ body: { type: "error", error: { type: "overloaded_error" } } }]);
    expect(((await thrown(model.complete(request()))) as ModelClientError).code).toBe("unavailable");
    const unlisted = extract([{ body: good() }], { model: "claude-unlisted-1" });
    await unlisted.model.complete(request());
    expect(unlisted.usage.map((event) => [event.outcome, event.costMicroUsd])).toEqual([["cost_missing", 10_000]]);
  });
});
