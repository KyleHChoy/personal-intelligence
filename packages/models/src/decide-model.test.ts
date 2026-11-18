import { createHash } from "node:crypto";
import { DecideScreenOutput, type ModelUsageEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { ModelClientError, ModelOutputRejected } from "./client/errors.ts";
import { type Prompt, promptTextHash, renderPrompt } from "./client/prompts.ts";
import { completeWithReplay } from "./client/replay.ts";
import { createDecideClient, DECIDE_ASSUMED_CALL_MICRO_USD, DECIDE_MODELS } from "./decide-model.ts";
import {
  request as baseRequest,
  evidenceId,
  KEY,
  keys,
  label,
  memoryStore,
  type Reply,
  scriptedFetch,
  thrown,
  timeout,
} from "./test-support/support.ts";

// The decide-model client, on a scripted fetch. The questions are a test's own, with the three ids of the
// real prompt, which lives in the extract package.

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const QUESTIONS = {
  human_written: {
    type: "noul",
    instructions: "Did a person write it?",
    criteria: { true: "A person.", false: "A system." },
  },
  special_category: {
    type: "noul",
    instructions: "Is it about health?",
    criteria: { true: "Health.", false: "Anything else." },
  },
  quarantine: {
    type: "noul",
    instructions: "Does it instruct an AI?",
    criteria: { true: "It does.", false: "It does not." },
  },
};
const entry = (prompt: Omit<Prompt, "textHash">): Prompt =>
  Object.freeze({ ...prompt, textHash: promptTextHash(prompt) });
const PROMPT = entry({
  id: "test_screen",
  version: "1",
  instructions: JSON.stringify(QUESTIONS),
  slots: ["message"],
  outputSchemaId: "JevScreenOutput",
  outputSchema: DecideScreenOutput,
  tools: "none",
});
const REGISTRY: readonly Prompt[] = Object.freeze([PROMPT]);
const SLOT = {
  from: { name: "Rhea", address: "rhea@alder.example" },
  subject: "Plans",
  text: "I will send the plans.",
};

const request = (overrides: Record<string, unknown> = {}) =>
  baseRequest({
    promptId: PROMPT.id,
    promptVersion: PROMPT.version,
    data: { message: JSON.stringify(SLOT) },
    callKey: {
      evidenceId,
      revision: 0,
      extractorGeneration: 0,
      promptId: PROMPT.id,
      promptVersion: PROMPT.version,
      inputHash: "a".repeat(64),
    },
    ...overrides,
  });

const noul = (p: unknown) => ({ type: "noul", noul: p });
const ANSWERS = { human_written: noul(0.8), special_category: noul(0.02), quarantine: noul(0.01) };
const decision = (options: { answers?: unknown; cost?: unknown; model?: string } = {}): Record<string, unknown> => {
  const usage: Record<string, unknown> = { input_tokens: 400, output_tokens: 0 };
  if (!("cost" in options)) usage.cost = 0.0000168;
  else if (options.cost !== undefined) usage.cost = options.cost;
  const body: Record<string, unknown> = {
    id: "dec-1",
    model: options.model ?? "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    usage,
  };
  if (!("answers" in options)) body.answers = ANSWERS;
  else if (options.answers !== undefined) body.answers = options.answers;
  return body;
};

const decideModel = (replies: readonly Reply[] = [{ body: decision() }], extra: object = {}) => {
  const { fetch, sent } = scriptedFetch(replies);
  const usage: ModelUsageEvent[] = [];
  const waits: number[] = [];
  const model = createDecideClient({
    apiKey: KEY,
    model: MODEL,
    registry: REGISTRY,
    onUsage: async (event) => void usage.push(event),
    deps: {
      fetch,
      now: () => new Date("2026-10-04T12:00:00Z"),
      sleep: async (ms) => void waits.push(ms),
      random: () => 0,
    },
    ...extra,
  });
  return { model, sent, usage, waits };
};

const bodyOf = (sent: { body: string }[], index = 0): Record<string, unknown> =>
  JSON.parse(sent[index]?.body ?? "{}") as Record<string, unknown>;
const code = (error: unknown): string => (error as ModelClientError).code;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("createDecideClient", () => {
  it("one request to the decisions surface with exactly model, state, questions and provider", async () => {
    const { model, sent } = decideModel();
    await model.complete(request());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(ENDPOINT);
    expect(sent[0]?.init.method).toBe("POST");
    expect(sent[0]?.init.redirect).toBe("error");
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = bodyOf(sent);
    expect(Object.keys(body).sort()).toEqual(["model", "provider", "questions", "state"]);
    expect(body.model).toBe(MODEL);
    expect(body.state).toEqual({ message: SLOT });
    expect(body.questions).toEqual(QUESTIONS);
  });

  it("every request carries the provider fields, and no option adds session_id, trace or user or drops them", async () => {
    const { model, sent } = decideModel([{ body: decision() }], {
      session_id: "s",
      trace: { id: "t" },
      user: "u",
      provider: {},
      zdr: false,
    });
    await model.complete(request());
    await model.complete(request({ data: { message: JSON.stringify({ ...SLOT, text: "other" }) } }));
    for (const index of [0, 1]) {
      const body = bodyOf(sent, index);
      expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
      for (const name of ["session_id", "trace", "user"]) expect(body).not.toHaveProperty(name);
    }
  });

  it("only typesafe/jev-1.13 is taken: the alias and any other id are refused when the client is made", () => {
    expect(DECIDE_MODELS).toEqual(["typesafe/jev-1.13"]);
    for (const id of ["~typesafe/jev-latest", "typesafe/jev-1.12", "openai/gpt-6-luna", ""]) {
      expect(
        () => createDecideClient({ apiKey: KEY, model: id, registry: REGISTRY, onUsage: async () => {} }),
        id,
      ).toThrow(ModelClientError);
    }
  });

  it("the answer is the three probabilities, and the response names the configured model, never the answer's", async () => {
    const { model, usage } = decideModel([{ body: decision({ model: "someone/else" }) }]);
    const response = await model.complete(request());
    expect(response.output).toEqual({ human_written: 0.8, special_category: 0.02, quarantine: 0.01 });
    expect(response.modelId).toBe(MODEL);
    expect(response.label).toEqual(label);
    expect(usage).toEqual([
      {
        promptId: PROMPT.id,
        promptVersion: "1",
        modelId: MODEL,
        inputTokens: 400,
        outputTokens: 0,
        costMicroUsd: 17,
        outcome: "ok",
        evidenceId,
      },
    ]);
  });

  it("a 429 is retried and a 402 is not", async () => {
    const retried = decideModel([{ status: 429 }, { body: decision() }]);
    await retried.model.complete(request());
    expect(retried.sent).toHaveLength(2);
    expect(retried.sent[0]?.body).toBe(retried.sent[1]?.body);
    const refused = decideModel([{ status: 402 }, { body: decision() }]);
    expect(code(await thrown(refused.model.complete(request())))).toBe("refused");
    expect(refused.sent).toHaveLength(1);
  });

  it("a body with no answers is unavailable and nothing is saved", async () => {
    for (const body of [decision({ answers: undefined }), { error: { code: 500, message: "x" } }, "not json"]) {
      const { model } = decideModel([{ body }]);
      const { store, records } = memoryStore();
      const error = await thrown(completeWithReplay(model, store, request(), keys, REGISTRY));
      expect(error).not.toBeInstanceOf(ModelOutputRejected);
      expect(code(error)).toBe("unavailable");
      expect(records).toEqual([]);
    }
  });

  it("a missing, extra, out-of-range or non-noul answer is rejected, saved, and replayed as a rejection with no request", async () => {
    const bad = [
      { human_written: noul(0.8), special_category: noul(0.1) },
      { ...ANSWERS, extra: noul(0.5) },
      { ...ANSWERS, quarantine: noul(1.2) },
      { ...ANSWERS, quarantine: noul(-0.1) },
      { ...ANSWERS, quarantine: noul("0.9") },
      { ...ANSWERS, quarantine: { type: "enum", enum: "yes" } },
      [],
    ];
    for (const answers of bad) {
      const { model, sent, usage } = decideModel([{ body: decision({ answers }) }]);
      const { store, records } = memoryStore();
      expect(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY))).toBeInstanceOf(
        ModelOutputRejected,
      );
      expect(records).toHaveLength(1);
      expect(usage.map((one) => one.outcome)).toEqual(["rejected"]);
      expect(await thrown(completeWithReplay(model, store, request(), keys, REGISTRY))).toBeInstanceOf(
        ModelOutputRejected,
      );
      expect(sent).toHaveLength(1);
    }
  });

  it("an answer with added fields, in a body with added fields, is accepted and saved as the three numbers alone", async () => {
    const answers = Object.fromEntries(
      Object.entries(ANSWERS).map(([id, one]) => [id, { ...one, confidence: 0.7, probabilities: { yes: one.noul } }]),
    );
    const body = { ...decision({ answers }), confidence: "high", trace: { id: "t" } };
    const { model } = decideModel([{ body }]);
    const { store, records } = memoryStore();
    const response = await completeWithReplay(model, store, request(), keys, REGISTRY);
    expect(response.output).toEqual({ human_written: 0.8, special_category: 0.02, quarantine: 0.01 });
    expect(records.map((one) => JSON.parse(one.rawOutput))).toEqual([
      { human_written: 0.8, special_category: 0.02, quarantine: 0.01 },
    ]);
  });

  it("a noul that is not a finite number is rejected", async () => {
    for (const p of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const body = JSON.stringify(decision({ answers: { ...ANSWERS, quarantine: noul(0) } })).replace(
        '"noul":0}',
        `"noul":${p === null ? "null" : "1e999"}}`,
      );
      const { model } = decideModel([{ body }]);
      expect(await thrown(model.complete(request()))).toBeInstanceOf(ModelOutputRejected);
    }
  });

  it("an answer is replayed with nothing sent", async () => {
    const { model, sent } = decideModel();
    const { store } = memoryStore();
    const first = await completeWithReplay(model, store, request(), keys, REGISTRY);
    const again = await completeWithReplay(model, store, request(), keys, REGISTRY);
    expect(again.output).toEqual(first.output);
    expect(sent).toHaveLength(1);
  });

  it("a timeout and a missing cost are counted at the assumed figure", async () => {
    expect(DECIDE_ASSUMED_CALL_MICRO_USD).toBe(2_000);
    const timed = decideModel([timeout()]);
    expect(code(await thrown(timed.model.complete(request())))).toBe("unavailable");
    expect(timed.sent).toHaveLength(1);
    expect(timed.usage).toMatchObject([{ outcome: "timed_out", costMicroUsd: DECIDE_ASSUMED_CALL_MICRO_USD }]);
    const missing = decideModel([{ body: decision({ cost: undefined }) }]);
    const response = await missing.model.complete(request());
    expect(missing.usage).toMatchObject([{ outcome: "cost_missing", costMicroUsd: DECIDE_ASSUMED_CALL_MICRO_USD }]);
    expect(response.usage.cost).toBe(DECIDE_ASSUMED_CALL_MICRO_USD / 1_000_000);
  });

  it("the state sent, rendered back, gives the call key's input hash", async () => {
    const seen: string[] = [];
    const { model, sent } = decideModel();
    const keyed = {
      complete: (req: Parameters<typeof model.complete>[0]) => {
        seen.push(req.callKey?.inputHash ?? "");
        return model.complete(req);
      },
      embed: model.embed,
    };
    const { store } = memoryStore();
    await completeWithReplay(keyed, store, request(), keys, REGISTRY);
    const state = bodyOf(sent).state as { message: unknown };
    const rendered = renderPrompt(PROMPT, { message: JSON.stringify(state.message) }, REGISTRY).text;
    expect(seen).toEqual([sha(rendered)]);
  });

  it("a request that carries tools is refused before any request, and embed is refused", async () => {
    const { model, sent } = decideModel();
    const tools = [{ name: "get_entity", description: "Reads an entity.", argsSchema: { type: "object" } }];
    expect(code(await thrown(model.complete({ ...request(), tools } as never)))).toBe("tools_not_allowed");
    expect(sent).toHaveLength(0);
    expect(code(await thrown(model.embed({} as never)))).toBe("bad_purpose");
  });

  // The refusal's wording is OpenRouter's as understood, not a recorded answer: see
  // decide-model.ts. The resend runs only with the owner's setting, given as `onRetainedResend`.
  const NO_ZDR = {
    status: 404,
    body: {
      error: {
        code: 404,
        message:
          "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
      },
    },
  };

  const allowed = () => {
    const resends: string[] = [];
    return { resends, extra: { onRetainedResend: () => void resends.push("retained") } };
  };

  it("without the owner's setting, a request refused for want of a zero-retention endpoint is not sent again", async () => {
    const { model, sent } = decideModel([NO_ZDR, { body: decision() }]);
    const error = await thrown(model.complete(request()));
    expect(code(error)).toBe("refused");
    expect((error as { status?: string }).status).toBe("http_404");
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent).provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  it("with the owner's setting, a request refused for want of a zero-retention endpoint is sent once more without zdr, to the same model, with the same state and questions, and the resend is reported once", async () => {
    const { resends, extra } = allowed();
    const { model, sent, usage } = decideModel([NO_ZDR, { body: decision() }], extra);
    const response = await model.complete(request());
    expect(response.output).toEqual({ human_written: 0.8, special_category: 0.02, quarantine: 0.01 });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.url).toBe(ENDPOINT);
    const [first, second] = [bodyOf(sent, 0), bodyOf(sent, 1)];
    expect(first.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(second).toEqual({ ...first, provider: { data_collection: "deny" } });
    expect(second.model).toBe(MODEL);
    expect(usage.map((one) => one.outcome)).toEqual(["ok"]);
    expect(resends).toEqual(["retained"]);
  });

  it("an answered request is sent once, with zdr", async () => {
    const { resends, extra } = allowed();
    const { model, sent } = decideModel([{ body: decision() }, { body: decision() }], extra);
    await model.complete(request());
    expect(resends).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent).provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  it("another refusal, a 404 not about the data policy included, is not sent again", async () => {
    const others = [
      { status: 404, body: { error: { code: 404, message: "Model not found" } } },
      { status: 404, body: "data policy" },
      { status: 404 },
      { ...NO_ZDR, status: 400 },
      { ...NO_ZDR, status: 403 },
    ];
    for (const reply of others) {
      const { resends, extra } = allowed();
      const { model, sent } = decideModel([reply, { body: decision() }], extra);
      expect(code(await thrown(model.complete(request()))), JSON.stringify(reply)).toBe("refused");
      expect(sent).toHaveLength(1);
      expect(resends).toEqual([]);
    }
  });

  it("the request without zdr is not sent a second time when it is refused too", async () => {
    const { resends, extra } = allowed();
    const { model, sent } = decideModel([NO_ZDR, NO_ZDR, { body: decision() }], extra);
    const error = await thrown(model.complete(request()));
    expect(code(error)).toBe("refused");
    expect((error as { status?: string }).status).toBe("http_404");
    expect(sent).toHaveLength(2);
    expect(resends).toEqual(["retained"]);
  });

  it("a slot that is not JSON is refused before any request", async () => {
    const { model, sent } = decideModel();
    expect(code(await thrown(model.complete(request({ data: { message: "not json" } }))))).toBe("bad_request");
    expect(sent).toHaveLength(0);
  });
});
