import { inspect } from "node:util";
import { Label, ModelResponse } from "@intelligence/contracts";
import { REJECTED_CONTENT_FILTER, REJECTED_LENGTH } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { checkReply } from "./client/checks.ts";
import { type ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { completeWithReplay } from "./client/replay.ts";
import { createOpenRouterClient } from "./openrouter.ts";
import {
  answer,
  client,
  KEY,
  keys,
  label,
  MODEL,
  memoryStore,
  OUTPUT,
  PROMPT,
  REGISTRY,
  request,
  scriptedFetch,
  thrown,
} from "./test-support/support.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Zero data retention is not asked for: no endpoint of the configured model serves
// it with the parameters this client needs.
const RETENTION = { data_collection: "deny", require_parameters: true };

const code = (error: unknown): string => (error as ModelClientError).code;
const rejected = (error: unknown): string => {
  expect(error).toBeInstanceOf(ModelOutputRejected);
  return (error as ModelOutputRejected).rawOutput;
};
const sentBody = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const toolCall = { id: "call-1", type: "function", function: { name: "send_mail", arguments: "{}" } };

describe("createOpenRouterClient", () => {
  it("one request, no tools, to the one host", async () => {
    const { model, sent } = client();
    await model.complete(request());
    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only?.url).toBe(ENDPOINT);
    expect(only?.init.method).toBe("POST");
    const body = sentBody(only?.body ?? "");
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "provider",
      "response_format",
      "stream",
      "usage",
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    // No temperature: a reasoning model takes none, and replay is what makes a result repeatable.
    expect(body).not.toHaveProperty("temperature");
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 16_000,
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(body.usage).toEqual({ include: true });
    expect((body.provider as Record<string, unknown>).require_parameters).toBe(true);
    const messages = body.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages.every((message) => Object.keys(message).sort().join() === "content,role")).toBe(true);
  });

  it("the system and user messages joined by a blank line are the rendered text", async () => {
    const { model, sent } = client();
    await model.complete(request());
    const [system, user] = sentBody(sent[0]?.body ?? "").messages as { content: string }[];
    // The prompt's instructions hold a blank line themselves, so a split at the first blank
    // line would be wrong: the split is at the instructions' length.
    expect(system?.content).toBe(PROMPT.instructions);
    expect(user?.content).toBe('<data slot="message">\n{"subject":"Report","body":"I will send the report."}\n</data>');
    expect(`${system?.content}\n\n${user?.content}`).toBe(`${PROMPT.instructions}\n\n${user?.content}`);
  });

  it("every request carries the same provider fields, and no option changes them", async () => {
    const { model, sent } = client();
    await model.complete(request());
    await model.complete(request({ data: { message: "other" } }));
    for (const one of sent) expect(sentBody(one.body).provider).toEqual(RETENTION);
    // Options the client does not know are not read: nothing turns the setting off.
    const { fetch, sent: looseSent } = scriptedFetch([{}]);
    const loose = createOpenRouterClient({
      apiKey: KEY,
      model: MODEL,
      registry: REGISTRY,
      onUsage: async () => {},
      deps: { fetch },
      ...({ zdr: false, dataCollection: "allow", provider: {}, retention: false } as object),
    });
    await loose.complete(request());
    expect(sentBody(looseSent[0]?.body ?? "").provider).toEqual(RETENTION);
  });

  it("a request that carries tools is refused before any request", async () => {
    const { model, sent } = client();
    const tools = [{ name: "get_entity", description: "Reads an entity.", argsSchema: { type: "object" } }];
    for (const promptId of ["test_extract", "test_tooled"]) {
      const callKey = { ...request().callKey, promptId };
      expect(code(await thrown(model.complete({ ...request({ promptId, callKey }), tools } as never)))).toBe(
        "tools_not_allowed",
      );
    }
    expect(sent).toHaveLength(0);
    // The positive control: the same request without tools is sent.
    await model.complete(request());
    expect(sent).toHaveLength(1);
  });

  it("an output outside the schema is rejected with its raw text, and the error shows none of it when printed", async () => {
    const raw = '{"claims":[],"narrowing":"none","secret_note":"the fourth quarter numbers"}';
    const { model } = client([{ body: answer({ content: raw }) }]);
    const error = await thrown(model.complete(request()));
    expect(rejected(error)).toBe(raw);
    for (const printed of [
      String(error),
      inspect(error),
      JSON.stringify(error),
      (error as Error).message,
      (error as Error).stack ?? "",
    ]) {
      expect(printed).not.toContain("fourth quarter");
    }
  });

  it("one code fence around the output is removed, and anything else that is not JSON is rejected", async () => {
    const json = JSON.stringify(OUTPUT);
    for (const content of [
      `\`\`\`json\n${json}\n\`\`\``,
      `\`\`\`\n${json}\n\`\`\``,
      `  \`\`\`json\n${json}\n\`\`\`\n`,
    ]) {
      const { model } = client([{ body: answer({ content }) }]);
      expect((await model.complete(request())).output).toEqual(OUTPUT);
    }
    for (const content of [
      `Here it is: ${json}`,
      `\`\`\`json\n\`\`\`json\n${json}\n\`\`\`\n\`\`\``,
      `${json}\n\`\`\``,
      "",
    ]) {
      const { model } = client([{ body: answer({ content }) }]);
      expect(rejected(await thrown(model.complete(request())))).toBeTypeOf("string");
    }
  });

  it("a 200 whose body has an error and no choices is unavailable, nothing is saved, and the next call is not refused as cost_missing", async () => {
    const { model, usage } = client([{ body: { error: { code: 502, message: "provider failed" } } }, {}]);
    const { store, records } = memoryStore();
    expect(code(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY)))).toBe("unavailable");
    expect(records).toHaveLength(0);
    expect(usage.filter((event) => event.outcome === "cost_missing")).toHaveLength(0);
    // The item is asked again and answered.
    expect((await completeWithReplay(model, store, request(), keys, REGISTRY)).output).toEqual(OUTPUT);
    expect(records).toHaveLength(1);
  });

  it("a body that is not JSON, or of any other shape, is unavailable", async () => {
    for (const body of ["<html>bad gateway</html>", { choices: [] }, { choices: "x" }, [1, 2], { choices: [null] }]) {
      const { model } = client([{ body }]);
      expect(code(await thrown(model.complete(request())))).toBe("unavailable");
    }
  });

  it("a finish reason of error is unavailable", async () => {
    const { model } = client([{ body: answer({ finish: "error" }) }]);
    const error = await thrown(model.complete(request()));
    expect(error).not.toBeInstanceOf(ModelOutputRejected);
    expect(code(error)).toBe("unavailable");
  });

  it("an answer with a tool call is a rejected output", async () => {
    const content = '{"claims":[]}';
    const cases = [
      { body: answer({ content, toolCalls: [toolCall] }), raw: content },
      { body: answer({ content: null, toolCalls: [toolCall], finish: "tool_calls" }), raw: "" },
      { body: answer({ content, finish: "tool_calls" }), raw: content },
    ];
    for (const { body, raw } of cases) {
      const { model } = client([{ body }]);
      expect(rejected(await thrown(model.complete(request())))).toBe(raw);
    }
    // The positive control: an empty tool-call list and finish reason stop is an output.
    const { model } = client([{ body: answer({ toolCalls: [] }) }]);
    expect((await model.complete(request())).output).toEqual(OUTPUT);
  });

  it("a tool-call answer whose content is a valid output is rejected live, and rejected again on replay with no request", async () => {
    const content = JSON.stringify(OUTPUT);
    const { model, sent } = client([{ body: answer({ content, toolCalls: [toolCall] }) }]);
    const { store, records } = memoryStore();
    expect(rejected(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY)))).toBe(content);
    expect(records).toHaveLength(1);
    expect(records[0]?.rawOutput.startsWith("rejected:not_by_schema")).toBe(true);
    const again = await thrown(completeWithReplay(model, store, request(), keys, REGISTRY));
    expect(again).toBeInstanceOf(ModelOutputRejected);
    expect(sent).toHaveLength(1);
  });

  it("the personal client and the shared checkReply reject the same tool-call reply", async () => {
    const content = JSON.stringify(OUTPUT);
    const { model } = client([{ body: answer({ content, toolCalls: [toolCall] }) }]);
    const live = rejected(await thrown(model.complete(request())));
    const reply = ModelResponse.parse({
      output: OUTPUT,
      label,
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      modelId: MODEL,
      blocks: [{ type: "tool_call", call: { id: "call-1", name: "get_entity", args: {}, decision: "candidate_set" } }],
    });
    let shared: unknown;
    try {
      checkReply(PROMPT, request(), reply);
    } catch (error) {
      shared = error;
    }
    expect(rejected(shared)).toBe(live);
    expect(live).toBe(content);
  });

  it("a length or content_filter answer is rejected with its marker, saved, and replayed as a rejection with no request", async () => {
    for (const [finish, marker] of [
      ["length", REJECTED_LENGTH],
      ["content_filter", REJECTED_CONTENT_FILTER],
    ] as const) {
      const content = JSON.stringify(OUTPUT);
      const { model, sent } = client([{ body: answer({ content, finish }) }]);
      const { store, records } = memoryStore();
      expect(rejected(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY)))).toBe(marker);
      expect(records.map((record) => record.rawOutput)).toEqual([marker]);
      expect(rejected(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY)))).toBe(marker);
      expect(sent).toHaveLength(1);
    }
  });

  // A vendor that writes `reasoning` tokens and then the answer, at three characters a token, and
  // stops at the request's max_tokens as OpenRouter does: reasoning counts against it.
  const vendor =
    (content: string, reasoning: number) =>
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const limit = sentBody(String(init?.body)).max_tokens as number;
      const finish = reasoning + Math.ceil(content.length / 3) > limit ? "length" : "stop";
      const body = answer({
        content: finish === "stop" ? content : content.slice(0, Math.max(0, limit - reasoning) * 3),
        finish,
      });
      return new Response(JSON.stringify(body), { status: 200 });
    };
  // Forty claims, each with a 292-character statement: 20 231 characters, about 6 750 tokens.
  const sentence = `I will send the revised plans and the signed lease to you by Friday${", with the notes".repeat(14)}.`;
  const long = JSON.stringify({
    claims: Array.from({ length: 40 }, () => ({ ...OUTPUT.claims[0], fields: { what: sentence } })),
    narrowing: "none",
  });

  it("a long answer within max_tokens is accepted, though its answer alone is over the old 1 500", async () => {
    expect(Math.ceil(long.length / 3)).toBeGreaterThan(1_500);
    const { model, sent } = client([], { fetch: vendor(long, 6_000) });
    expect((await model.complete(request())).output).toEqual(JSON.parse(long));
    expect(sent).toHaveLength(1);
  });

  it("an answer beyond max_tokens is still rejected as cut off", async () => {
    const { model } = client([], { fetch: vendor(long, 11_000) });
    expect(rejected(await thrown(model.complete(request())))).toBe(REJECTED_LENGTH);
  });

  it("each attempt of an extraction call waits 180 seconds, the time a 16 000-token answer can take", async () => {
    const deadline = vi.spyOn(AbortSignal, "timeout");
    try {
      await client().model.complete(request());
      expect(deadline.mock.calls).toEqual([[180_000]]);
    } finally {
      deadline.mockRestore();
    }
  });

  it("a redirect is not followed", async () => {
    // Node's fetch rejects a redirect under `redirect: "error"` this way: the vendor answered, so
    // the body is not sent again.
    const redirected = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    const { model, sent, waits } = client([redirected, {}]);
    expect(code(await thrown(model.complete(request())))).toBe("unavailable");
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(sent.every((one) => one.init.redirect === "error")).toBe(true);
    expect(sent.every((one) => one.url === ENDPOINT)).toBe(true);
  });

  it("the response carries the request's label, whatever the output says", async () => {
    const { model } = client([
      { body: { ...answer(), label: { compartments: ["public"], readers: ["all_members"] } } },
    ]);
    const response = await model.complete(request());
    expect(response.label).toEqual(label);
    expect(Label.parse(response.label)).toEqual(label);
    expect(response).not.toHaveProperty("blocks");
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30, cost: 0.000123 });
  });

  it("the key appears in the authorization header and nowhere else, and in no error", async () => {
    const { model, sent } = client([
      { body: answer() },
      { status: 401, body: { error: { message: "bad key" } } },
      { body: "not json" },
      { body: answer({ content: "nope" }) },
    ]);
    await model.complete(request());
    const errors = [
      await thrown(model.complete(request())),
      await thrown(model.complete(request())),
      await thrown(model.complete(request())),
    ];
    expect(errors.map(code)).toEqual(["refused", "unavailable", "output_rejected"]);
    for (const one of sent) {
      const headers = new Headers(one.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(one.body).not.toContain(KEY);
      expect(one.url).not.toContain(KEY);
      for (const [name, value] of headers) if (name !== "authorization") expect(value).not.toContain(KEY);
    }
    for (const error of errors) {
      for (const printed of [
        String(error),
        inspect(error, { showHidden: true }),
        JSON.stringify(error),
        (error as Error).stack ?? "",
      ]) {
        expect(printed).not.toContain(KEY);
      }
    }
  });

  it("embed is refused", async () => {
    const { model, sent } = client();
    expect(code(await thrown(model.embed({} as never)))).toBe("bad_purpose");
    expect(sent).toHaveLength(0);
  });
});
