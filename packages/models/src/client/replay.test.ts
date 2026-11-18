import { createHash } from "node:crypto";
import {
  InterpreterOutput,
  type ModelCallKey,
  type ModelCallRecord,
  type ModelCallStore,
  type ModelRequest,
  type ModelResponse,
  ToolCallBlock,
} from "@intelligence/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  checkCompletion,
  completeWithReplay,
  lookupPrompt,
  type ModelClient,
  ModelOutputRejected,
  type Prompt,
  renderPrompt,
} from "../index.ts";
import { getPrompt, validateOutput } from "./prompts.ts";
import { createGatewayClient } from "./test-support/gateway.ts";
import {
  callerEntry,
  callKey,
  completion,
  contentKeys,
  endpoint,
  evidenceId,
  fakeHttp,
  label,
  okOutput,
  request,
  widerLabel,
} from "./test-support/support.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// A ModelCallStore over a map, standing in for the pipeline's `interpreter_calls` table.
const memoryStore = () => {
  const rows = new Map<string, ModelCallRecord>();
  const keyOf = (key: ModelCallKey) =>
    JSON.stringify([
      key.evidenceId,
      key.revision,
      key.extractorGeneration,
      key.promptId,
      key.promptVersion,
      key.inputHash,
    ]);
  const store: ModelCallStore = {
    find: vi.fn(async (key) => rows.get(keyOf(key)) ?? null),
    save: vi.fn(async (record) => void rows.set(keyOf(record.key), record)),
  };
  return { store, rows };
};

const withGateway = (output: unknown = okOutput) => {
  const http = fakeHttp(() => completion(output));
  const client: ModelClient = createGatewayClient(endpoint(), "full", http.port);
  return { http, client };
};

describe("completeWithReplay", () => {
  it("replays a saved call, and not after the input changes", async () => {
    const { http, client } = withGateway();
    const { store, rows } = memoryStore();

    const first = await completeWithReplay(client, store, request(), contentKeys);
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);

    // The same call again: no gateway call, the same output.
    const second = await completeWithReplay(client, store, request(), contentKeys);
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(second.output).toEqual(first.output);
    expect(second.label).toEqual(label);
    const [saved] = [...rows.values()];
    expect(saved?.outputHash).toBe(sha256(saved?.rawOutput ?? ""));

    // A changed input changes the input hash, so the old output is not replayed.
    await completeWithReplay(
      client,
      store,
      request({ data: { message: "Maya now needs a COO.", replies: "" } }),
      contentKeys,
    );
    expect(http.send).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
    const hashes = [...rows.values()].map((record) => record.key.inputHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("the input hash is the hash of the rendered prompt, whatever the caller put in the key", async () => {
    const { client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    const rendered = renderPrompt(getPrompt("interpreter", "1"), request().data);
    const [saved] = [...rows.values()];
    expect(saved?.key.inputHash).toBe(sha256(rendered.text));
    expect(saved?.key.inputHash).not.toBe(callKey.inputHash);
    expect(saved?.renderedInput).toBe(rendered.text);
  });

  it("a newer generation never reuses an older one", async () => {
    const { http, client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    await completeWithReplay(client, store, request({ callKey: { ...callKey, extractorGeneration: 1 } }), contentKeys);
    expect(http.send).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
  });

  it("the saved record carries the request's label and the live origin", async () => {
    const { client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    const [saved] = [...rows.values()];
    expect(saved?.label).toEqual(label);
    expect(saved?.label).not.toEqual(widerLabel);
    expect(saved?.origin).toBe("live");
  });

  it("a call with no call key is refused before any gateway call", async () => {
    const { http, client } = withGateway();
    const { store } = memoryStore();
    await expect(completeWithReplay(client, store, request({ callKey: undefined }), contentKeys)).rejects.toMatchObject(
      {
        code: "bad_key",
      },
    );
    await expect(
      completeWithReplay(client, store, request({ callKey: { ...callKey, promptVersion: "2" } }), contentKeys),
    ).rejects.toMatchObject({ code: "bad_key" });
    await expect(
      completeWithReplay(client, store, request({ callKey: { ...callKey, promptId: "other_prompt" } }), contentKeys),
    ).rejects.toMatchObject({ code: "bad_key" });
    expect(http.send).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("rejects an output carrying a label key and saves it", async () => {
    const poisoned = { claims: [], narrowing: "none", label: { compartments: ["org"], readers: ["all_members"] } };
    const { http, client } = withGateway(poisoned);
    const { store, rows } = memoryStore();

    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(rows.size).toBe(1);
    const [saved] = [...rows.values()];
    expect(JSON.parse(saved?.rawOutput ?? "null")).toEqual(poisoned);
    expect(saved?.outputHash).toBe(sha256(saved?.rawOutput ?? ""));

    // The retry replays the rejection with no second gateway call.
    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it("a failed call saves nothing, so the lease retry calls the gateway again", async () => {
    let attempts = 0;
    const http = fakeHttp(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return completion();
    });
    const client = createGatewayClient(endpoint(), "full", http.port);
    const { store, rows } = memoryStore();
    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(rows.size).toBe(0);
    await completeWithReplay(client, store, request(), contentKeys);
    expect(http.send).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
  });

  it("a gateway reply with no output ends as unavailable and saves nothing, so a retry calls the gateway again", async () => {
    const http = fakeHttp(() => completion(okOutput, { output: undefined }));
    const client = createGatewayClient(endpoint(), "full", http.port);
    const { store, rows } = memoryStore();
    for (const attempt of [1, 2]) {
      await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(http.send).toHaveBeenCalledTimes(attempt);
    }
    expect(rows.size).toBe(0);
  });

  it("saved record lists every item read", async () => {
    const { client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    const [saved] = [...rows.values()];
    expect(saved?.keys).toEqual(contentKeys);
    expect(saved?.keys.map((k) => k.evidenceId)).toContain(evidenceId);
  });

  it("refuses keys that do not include the item the call is about, or that are malformed", async () => {
    const { http, client } = withGateway();
    const { store } = memoryStore();
    const others = contentKeys.filter((k) => k.evidenceId !== evidenceId);
    await expect(completeWithReplay(client, store, request(), others as never)).rejects.toMatchObject({
      code: "bad_key",
    });
    await expect(completeWithReplay(client, store, request(), [] as never)).rejects.toMatchObject({ code: "bad_key" });
    expect(http.send).not.toHaveBeenCalled();
  });

  it("writes records only through the store", async () => {
    const { client } = withGateway();
    const { store } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("a record the store returns for another key is a miss", async () => {
    const { http, client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    const [stale] = [...rows.values()];
    // A store that answers every find with a record of some other call.
    const wrong: ModelCallStore = {
      find: vi.fn(async () => (stale === undefined ? null : { ...stale, key: { ...stale.key, revision: 9 } })),
      save: vi.fn(async () => undefined),
    };
    await completeWithReplay(client, wrong, request(), contentKeys);
    expect(http.send).toHaveBeenCalledTimes(2);
    expect(wrong.save).toHaveBeenCalledTimes(1);
  });

  it("tool-call blocks on a prompt without tools are rejected and saved", async () => {
    const block = {
      type: "tool_call",
      call: { id: "call-1", name: "get_entity", args: {}, decision: "candidate_set" },
    };
    const http = fakeHttp(() => completion(okOutput, { blocks: [block] }));
    const client = createGatewayClient(endpoint(), "full", http.port);
    const { store, rows } = memoryStore();
    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(rows.size).toBe(1);
    // The output alone fits the schema. What is saved does not, and still holds the output.
    const [saved] = [...rows.values()];
    expect(InterpreterOutput.safeParse(okOutput).success).toBe(true);
    expect(() => validateOutput(getPrompt("interpreter", "1"), saved?.rawOutput ?? "")).toThrow(
      expect.objectContaining({ code: "output_rejected" }),
    );
    expect(saved?.rawOutput).toContain(JSON.stringify(okOutput));

    // The retry replays the rejection with no second gateway call.
    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it("a saved record whose output no longer matches its hash is refused", async () => {
    const { http, client } = withGateway();
    const { store, rows } = memoryStore();
    await completeWithReplay(client, store, request(), contentKeys);
    for (const [key, record] of rows) rows.set(key, { ...record, rawOutput: '{"claims":[],"narrowing":"quarantine"}' });
    await expect(completeWithReplay(client, store, request(), contentKeys)).rejects.toMatchObject({
      code: "bad_record",
    });
    expect(http.send).toHaveBeenCalledTimes(1);
  });
});

// A registry holding a prompt this package does not.
const callerRegistry = (): readonly [Prompt] => [callerEntry()];

const callerRequest = (overrides: Record<string, unknown> = {}): ModelRequest =>
  request({
    promptId: "caller_extract",
    data: { message: "Maya needs a CFO for the Alder project." },
    callKey: { ...callKey, promptId: "caller_extract" },
    ...overrides,
  });

// A client the caller brings. It checks nothing itself, and answers every call with the same
// response, or with `reply` over it.
const callerClient = (reply: Partial<ModelResponse> = {}) => {
  const complete = vi.fn(
    async (req: ModelRequest): Promise<ModelResponse> => ({
      output: okOutput,
      label: req.label,
      usage: { inputTokens: 12, outputTokens: 3, cost: 0.001 },
      modelId: "model-1",
      ...reply,
    }),
  );
  const client: ModelClient = { complete, embed: async () => Promise.reject(new Error("no embeddings")) };
  return { client, complete };
};

describe("completeWithReplay with a caller's registry", () => {
  it("completeWithReplay with a caller's registry makes one call and replays it", async () => {
    const registry = callerRegistry();
    const { client, complete } = callerClient();
    const { store, rows } = memoryStore();

    const first = await completeWithReplay(client, store, callerRequest(), contentKeys, registry);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    const rendered = renderPrompt(registry[0], callerRequest().data, registry);
    const [saved] = [...rows.values()];
    expect(saved?.key.promptId).toBe("caller_extract");
    expect(saved?.key.inputHash).toBe(sha256(rendered.text));
    expect(saved?.renderedInput).toBe(rendered.text);

    // The same call again: no call to the client, the same output.
    const second = await completeWithReplay(client, store, callerRequest(), contentKeys, registry);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(second.output).toEqual(first.output);
    expect(second.modelId).toBe("replay");
    expect(rows.size).toBe(1);
  });

  it("a request that names a prompt outside the registry in use is refused", async () => {
    const registry = callerRegistry();
    const { client, complete } = callerClient();
    const { store } = memoryStore();

    // The caller's prompt under the package's registry, and the package's under the caller's.
    expect(() => checkCompletion(callerRequest())).toThrow(expect.objectContaining({ code: "unknown_prompt" }));
    expect(() => checkCompletion(request(), registry)).toThrow(expect.objectContaining({ code: "unknown_prompt" }));
    await expect(completeWithReplay(client, store, callerRequest(), contentKeys)).rejects.toMatchObject({
      code: "unknown_prompt",
    });
    await expect(completeWithReplay(client, store, request(), contentKeys, registry)).rejects.toMatchObject({
      code: "unknown_prompt",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(store.find).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();

    // The same requests, each under the registry that holds its prompt.
    expect(checkCompletion(callerRequest(), registry).prompt).toBe(registry[0]);
    expect(checkCompletion(request()).prompt).toBe(getPrompt("interpreter", "1"));
    await completeWithReplay(client, store, callerRequest(), contentKeys, registry);
    await completeWithReplay(client, store, request(), contentKeys);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it("a caller's entry sharing an id and version with a package prompt is refused", async () => {
    // Written by the caller under the package's interpreter id and version, with its own text and
    // hash.
    const taken = callerEntry({ id: "interpreter" });
    const registry = [taken, callerEntry()];
    const asked = request({ data: { message: "Maya needs a CFO for the Alder project." } });
    const { client, complete } = callerClient();
    const { store } = memoryStore();

    expect(() => lookupPrompt(registry, "interpreter", "1")).toThrow(
      expect.objectContaining({ code: "altered_prompt" }),
    );
    expect(() => renderPrompt(taken, asked.data, registry)).toThrow(
      expect.objectContaining({ code: "altered_prompt" }),
    );
    expect(() => checkCompletion(asked, registry)).toThrow(expect.objectContaining({ code: "altered_prompt" }));
    await expect(completeWithReplay(client, store, asked, contentKeys, registry)).rejects.toMatchObject({
      code: "altered_prompt",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(store.find).not.toHaveBeenCalled();
    // The registry's other entry is untouched.
    expect(lookupPrompt(registry, "caller_extract", "1")).toBe(registry[1]);

    // The package's own entry, as the object it is, may sit in a caller's registry.
    const shared = [getPrompt("interpreter", "1"), callerEntry()];
    expect(lookupPrompt(shared, "interpreter", "1")).toBe(getPrompt("interpreter", "1"));
    await completeWithReplay(client, store, request(), contentKeys, shared);
    expect(complete).toHaveBeenCalledTimes(1);
    // A version the package does not hold is the caller's to write.
    const next = callerEntry({ id: "interpreter", version: "2" });
    expect(lookupPrompt([next], "interpreter", "2")).toBe(next);
  });

  it("a prompt with a bad slot name, or one given twice, is refused", async () => {
    const { client, complete } = callerClient();
    const { store } = memoryStore();
    // The first would close the block's opening line and open another.
    for (const slot of ['message"> <data slot="x', "Message", "the message", "message\n", "message-1", ""]) {
      const entry = callerEntry({ slots: [slot] });
      const asked = callerRequest({ data: { [slot]: "Maya needs a CFO for the Alder project." } });
      expect(() => lookupPrompt([entry], "caller_extract", "1"), slot).toThrow(
        expect.objectContaining({ code: "bad_slots" }),
      );
      expect(() => renderPrompt(entry, asked.data, [entry]), slot).toThrow(
        expect.objectContaining({ code: "bad_slots" }),
      );
      expect(() => checkCompletion(asked, [entry]), slot).toThrow(expect.objectContaining({ code: "bad_slots" }));
      await expect(completeWithReplay(client, store, asked, contentKeys, [entry]), slot).rejects.toMatchObject({
        code: "bad_slots",
      });
    }
    // One bad name among good ones refuses the prompt.
    const mixed = callerEntry({ slots: ["message", "Replies"] });
    expect(() => lookupPrompt([mixed], "caller_extract", "1")).toThrow(expect.objectContaining({ code: "bad_slots" }));
    // So does a name given twice.
    const twice = callerEntry({ slots: ["message", "message"] });
    expect(() => lookupPrompt([twice], "caller_extract", "1")).toThrow(expect.objectContaining({ code: "bad_slots" }));
    expect(() => checkCompletion(callerRequest(), [twice])).toThrow(expect.objectContaining({ code: "bad_slots" }));
    expect(complete).not.toHaveBeenCalled();
    expect(store.find).not.toHaveBeenCalled();

    // Lower-case letters, digits and underscores are a slot name.
    const plain = callerEntry({ slots: ["message_2"] });
    expect(renderPrompt(plain, { message_2: "x" }, [plain]).text).toContain('<data slot="message_2">');
  });
});

describe("completeWithReplay with a caller's client", () => {
  const toolCall = ToolCallBlock.parse({
    type: "tool_call",
    call: { id: "call-1", name: "get_entity", args: {}, decision: "candidate_set" },
  });
  // A caller's prompt registered with tools, and a request for it.
  const loop = callerEntry({ id: "caller_loop", tools: "allowed" });
  const loopRequest = (extra: Record<string, unknown> = {}) =>
    callerRequest({ promptId: "caller_loop", callKey: { ...callKey, promptId: "caller_loop" }, ...extra });
  const ownLoopRequest = (extra: Record<string, unknown> = {}) =>
    request({
      promptId: "reasoner_loop",
      data: { playbook: "", handles: "", goal: "" },
      callKey: { ...callKey, promptId: "reasoner_loop" },
      ...extra,
    });

  it("a caller's client returning an output the schema refuses is rejected and saved, and the replay rejects it", async () => {
    const registry = callerRegistry();
    const poisoned = { ...okOutput, label: widerLabel };
    const { client, complete } = callerClient({ output: poisoned });
    const { store, rows } = memoryStore();

    await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(rows.size).toBe(1);
    const [saved] = [...rows.values()];
    expect(JSON.parse(saved?.rawOutput ?? "null")).toEqual(poisoned);
    expect(saved?.outputHash).toBe(sha256(saved?.rawOutput ?? ""));

    // The retry replays the rejection with no second call to the client.
    await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);

    // The same holds for a caller's client under the package's own registry.
    const own = memoryStore();
    await expect(completeWithReplay(client, own.store, request(), contentKeys)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(own.rows.size).toBe(1);
  });

  it("a caller's client returning another label gets the request's label back", async () => {
    const { client } = callerClient({ label: widerLabel });
    const { store, rows } = memoryStore();
    const response = await completeWithReplay(client, store, callerRequest(), contentKeys, callerRegistry());
    expect(response.label).toEqual(label);
    expect(response.label).not.toEqual(widerLabel);
    expect(response.output).toEqual(okOutput);
    const [saved] = [...rows.values()];
    expect(saved?.label).toEqual(label);
  });

  it("a caller's client returning tool-call blocks for a prompt without tools is rejected", async () => {
    const registry = callerRegistry();
    const { client, complete } = callerClient({ blocks: [toolCall] });
    const { store, rows } = memoryStore();
    await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(rows.size).toBe(1);

    // The retry replays the rejection with no second call to the client.
    await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
      code: "output_rejected",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);

    // An empty list of blocks is no tool call.
    const empty = callerClient({ blocks: [] });
    const other = memoryStore();
    await completeWithReplay(empty.client, other.store, callerRequest(), contentKeys, registry);
    expect(
      (await completeWithReplay(empty.client, other.store, callerRequest(), contentKeys, registry)).output,
    ).toEqual(okOutput);
    expect(empty.complete).toHaveBeenCalledTimes(1);
  });

  it("a reply carrying tool-call blocks is rejected whatever its prompt allows, and the replay rejects it", async () => {
    // The request carried no tools, so no reply to it holds a legitimate tool call.
    const { client, complete } = callerClient({ blocks: [toolCall] });
    const { store, rows } = memoryStore();
    for (const _attempt of [1, 2]) {
      await expect(completeWithReplay(client, store, loopRequest(), contentKeys, [loop])).rejects.toMatchObject({
        code: "output_rejected",
      });
    }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);

    // The package's own loop prompt. The gateway client keeps the blocks of a prompt registered
    // with tools; completeWithReplay does not.
    const http = fakeHttp(() => completion(null, { blocks: [toolCall] }));
    const gateway = createGatewayClient(endpoint(), "full", http.port);
    expect((await gateway.complete(ownLoopRequest())).blocks).toEqual([toolCall]);
    const own = memoryStore();
    for (const _attempt of [1, 2]) {
      await expect(completeWithReplay(gateway, own.store, ownLoopRequest(), contentKeys)).rejects.toMatchObject({
        code: "output_rejected",
      });
    }
    expect(http.send).toHaveBeenCalledTimes(2);
    expect(own.rows.size).toBe(1);
  });

  it("a caller's client throwing a rejection whose text the schema accepts, or is not a string, is saved and the replay rejects it", async () => {
    const registry = callerRegistry();
    for (const rawOutput of [JSON.stringify(okOutput), undefined, 10, okOutput]) {
      const { client, complete } = callerClient();
      complete.mockRejectedValue(new ModelOutputRejected(rawOutput as never));
      const { store, rows } = memoryStore();
      for (const _attempt of [1, 2]) {
        await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
          code: "output_rejected",
        });
      }
      expect(complete).toHaveBeenCalledTimes(1);
      expect(rows.size).toBe(1);
      // What is saved is a text no schema accepts, with a hash that matches it.
      const [saved] = [...rows.values()];
      expect(saved?.outputHash).toBe(sha256(saved?.rawOutput ?? ""));
      expect(() => JSON.parse(saved?.rawOutput ?? "")).toThrow();
    }
  });

  it("a request that carries tools or messages is refused, whatever its prompt allows", async () => {
    const tools = [{ name: "get_entity", description: "Look up one entity.", argsSchema: {} }];
    const { client, complete } = callerClient();
    const { store } = memoryStore();

    // The prompt allows them, so a client may send them. The replay key hashes the rendered
    // slots only, so every later turn of a loop would replay the first.
    expect(checkCompletion(loopRequest({ tools }), [loop]).prompt).toBe(loop);
    for (const extra of [
      { tools },
      { tools, messages: [] },
      { tools, messages: [{ role: "assistant", blocks: [toolCall] }] },
    ]) {
      await expect(completeWithReplay(client, store, loopRequest(extra), contentKeys, [loop])).rejects.toMatchObject({
        code: "tools_not_allowed",
      });
    }
    // Messages with no tools are refused by the shape of the request, before this rule is reached.
    await expect(
      completeWithReplay(client, store, loopRequest({ messages: [] }), contentKeys, [loop]),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    // The package's own loop prompt is refused the same way.
    const own = ownLoopRequest({ tools });
    expect(checkCompletion(own).prompt).toBe(getPrompt("reasoner_loop", "1"));
    await expect(completeWithReplay(client, store, own, contentKeys)).rejects.toMatchObject({
      code: "tools_not_allowed",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(store.find).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();

    // With neither, the same prompt is called once and replayed like any other.
    await completeWithReplay(client, store, loopRequest(), contentKeys, [loop]);
    await completeWithReplay(client, store, loopRequest(), contentKeys, [loop]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("a caller's client returning no output, or a reply that is not a response, ends as unavailable and saves nothing, and a retry calls it again", async () => {
    const registry = callerRegistry();
    const replies: unknown[] = [
      // No output, an output JSON cannot hold, and two replies that are not a ModelResponse.
      { output: undefined },
      { output: 10n },
      { usage: undefined },
      { modelId: "" },
    ];
    for (const reply of replies) {
      const { client, complete } = callerClient(reply as Partial<ModelResponse>);
      const { store, rows } = memoryStore();
      for (const attempt of [1, 2]) {
        await expect(completeWithReplay(client, store, callerRequest(), contentKeys, registry)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect(complete).toHaveBeenCalledTimes(attempt);
      }
      expect(store.save).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
    }
  });

  it("a caller's client returning a string output has it read as raw JSON text, as the gateway client reads one", async () => {
    const registry = callerRegistry();
    const { client } = callerClient({ output: JSON.stringify(okOutput) });
    const { store, rows } = memoryStore();
    const response = await completeWithReplay(client, store, callerRequest(), contentKeys, registry);
    expect(response.output).toEqual(okOutput);
    expect([...rows.values()][0]?.rawOutput).toBe(JSON.stringify(okOutput));
    expect((await completeWithReplay(client, store, callerRequest(), contentKeys, registry)).output).toEqual(okOutput);

    // Text that is not JSON is rejected, and saved as the text it is.
    const prose = callerClient({ output: "not json at all" });
    const other = memoryStore();
    for (const _attempt of [1, 2]) {
      await expect(
        completeWithReplay(prose.client, other.store, callerRequest(), contentKeys, registry),
      ).rejects.toMatchObject({
        code: "output_rejected",
      });
    }
    expect(prose.complete).toHaveBeenCalledTimes(1);
    expect([...other.rows.values()][0]?.rawOutput).toBe("not json at all");
  });
});
