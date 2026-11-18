import { type ModelRequest, TrustGroupId } from "@intelligence/contracts";
import type { ModelUsageEvent, PersonalLogger } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { EXTRACT_PROMPTS, OUTCOME_JUDGE_PROMPT } from "@intelligence/personal-extract";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command-types.ts";
import { worldVendorOf } from "./extract-check.ts";
import {
  checkCaps,
  clientOf,
  type ExtractVendor,
  extractVendorOf,
  momentModelOf,
  readsOpenRouter,
} from "./extract-config.ts";

// The key picks the vendor of every structured call, and the spend-cap lines
// follow it. On fake fetches only: no vendor is called, and the keys are made up.

const ANTHROPIC_KEY = "sk-ant-test-not-a-real-key-0000";
const HAIKU = "anthropic/claude-haiku-5-5";
const OUTPUT = { claims: [], narrowing: "none" };

const refusedWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return `${(error as { code?: string }).code} ${(error as { hint?: string }).hint ?? ""}`.trim();
  }
  return "not refused";
};

const prompt = EXTRACT_PROMPTS.find((one) => one.id === "personal_transaction");
const request = (): ModelRequest => ({
  promptId: prompt?.id ?? "",
  promptVersion: prompt?.version ?? "",
  data: {
    message: JSON.stringify({
      citable: true,
      from: "orders@cedar-lamps.example",
      to: ["owner@birch.example"],
      date: "2026-03-02T09:00:00.000Z",
      segments: [],
    }),
  },
  label: { compartments: ["own"], readers: [THE_OWNER] },
  trustGroup: TrustGroupId.parse("personal-openrouter"),
});

// A fetch that records each request and answers as the vendor it was sent to.
const vendors = () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = url.startsWith("https://api.anthropic.com/")
      ? {
          type: "message",
          content: [{ type: "text", text: JSON.stringify(OUTPUT) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      : {
          choices: [{ message: { content: JSON.stringify(OUTPUT) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
};

describe("extractVendorOf", () => {
  it("is OpenRouter with no Anthropic key, and refuses an effort there", () => {
    expect(extractVendorOf({}, "openai/gpt-6-luna")).toEqual({ kind: "openrouter" });
    expect(extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: "" }, "openai/gpt-6-luna")).toEqual({ kind: "openrouter" });
    expect(refusedWith(() => extractVendorOf({ PI_EXTRACT_EFFORT: "low" }, "openai/gpt-6-luna"))).toBe(
      "bad_env set PI_EXTRACT_EFFORT",
    );
  });

  it("is Anthropic with an Anthropic key and an Anthropic model, with the effort when given", () => {
    expect(extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY }, HAIKU)).toEqual({
      kind: "anthropic",
      apiKey: ANTHROPIC_KEY,
      effort: undefined,
    });
    expect(
      extractVendorOf(
        { PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY, PI_EXTRACT_EFFORT: "max" },
        "anthropic/claude-haiku-5.5",
      ),
    ).toEqual({ kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "max" });
  });

  it("refuses a key that is not Anthropic's, another vendor's model, and an effort off the list", () => {
    expect(refusedWith(() => extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: "sk-or-v1-0000" }, HAIKU))).toBe(
      "bad_env set PI_EXTRACT_ANTHROPIC_KEY",
    );
    expect(refusedWith(() => extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY }, "openai/gpt-6-luna"))).toBe(
      "bad_env set PI_EXTRACT_MODEL",
    );
    expect(
      refusedWith(() => extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY }, "openrouter/claude-haiku")),
    ).toBe("bad_env set PI_EXTRACT_MODEL");
    expect(
      refusedWith(() =>
        extractVendorOf({ PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY, PI_EXTRACT_EFFORT: "xhigh" }, HAIKU),
      ),
    ).toBe("bad_env set PI_EXTRACT_EFFORT");
  });
});

describe("worldVendorOf", () => {
  const configured = { PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY, PI_EXTRACT_EFFORT: "high" };
  it("with no --vendor asks the configured model on the configured key", () => {
    expect(worldVendorOf({}, {}, "openai/gpt-6-luna", "meeting")).toEqual({
      vendor: { kind: "openrouter" },
      modelId: "openai/gpt-6-luna",
    });
    expect(worldVendorOf(configured, {}, HAIKU, "meeting")).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "high" },
      modelId: HAIKU,
    });
  });

  it("--vendor anthropic defaults to the configured Anthropic model and effort, else Haiku 5.5 and none; the flags win", () => {
    expect(worldVendorOf(configured, { vendor: "anthropic" }, HAIKU, "meeting")).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "high" },
      modelId: HAIKU,
    });
    expect(
      worldVendorOf(
        { PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY },
        { vendor: "anthropic" },
        "openai/gpt-6-luna",
        "meeting",
      ),
    ).toEqual({ vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: undefined }, modelId: HAIKU });
    // A flag's model is recorded in Anthropic's form, whichever spelling was typed.
    expect(
      worldVendorOf(
        configured,
        { vendor: "anthropic", model: "anthropic/claude-haiku-5.5" },
        "openai/gpt-6-luna",
        "meeting",
      ).modelId,
    ).toBe(HAIKU);
    expect(
      worldVendorOf(configured, { vendor: "anthropic", model: "claude-sonnet-5-5", effort: "low" }, HAIKU, "meeting"),
    ).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "low" },
      modelId: "anthropic/claude-sonnet-5-5",
    });
    expect(refusedWith(() => worldVendorOf({}, { vendor: "anthropic" }, "openai/gpt-6-luna", "meeting"))).toBe(
      "missing_env set PI_EXTRACT_ANTHROPIC_KEY",
    );
  });

  it("--vendor openrouter asks PI_EXTRACT_MODEL on the stored key, whatever the Anthropic key says", () => {
    expect(worldVendorOf(configured, { vendor: "openrouter" }, "anthropic/claude-haiku-5.5", "meeting")).toEqual({
      vendor: { kind: "openrouter" },
      modelId: "anthropic/claude-haiku-5.5",
    });
  });
});

describe("clientOf", () => {
  const noUsage = async (_event: ModelUsageEvent): Promise<void> => {};

  it("on the Anthropic vendor sends to Anthropic's API with the effort, and never to OpenRouter", async () => {
    const { fetch, sent } = vendors();
    const vendor: ExtractVendor = { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "high" };
    const response = await clientOf({ deps: { modelFetch: fetch } }, vendor, "", HAIKU, noUsage).complete(request());
    expect(response.output).toEqual(OUTPUT);
    expect(sent.map((one) => one.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(sent[0]?.body).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "high" } });
  });

  it("asks the outcome judge's prompt on either vendor, never refusing it as unknown", async () => {
    for (const [vendor, key] of [
      [{ kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: undefined }, ""],
      [{ kind: "openrouter" }, "sk-or-test-0000"],
    ] as const) {
      const { fetch, sent } = vendors();
      const judged = {
        ...request(),
        promptId: OUTCOME_JUDGE_PROMPT.id,
        promptVersion: OUTCOME_JUDGE_PROMPT.version,
        data: { case: "{}" },
      };
      // The fake answers extraction's shape, so the judge's own schema may refuse it: after the call.
      const code = await clientOf(
        { deps: { modelFetch: fetch } },
        vendor,
        key,
        vendor.kind === "anthropic" ? HAIKU : "openai/gpt-6-luna",
        noUsage,
      )
        .complete(judged)
        .then(
          () => "ok",
          (error: { code?: string }) => error.code,
        );
      expect(code, vendor.kind).not.toBe("unknown_prompt");
      expect(sent, vendor.kind).toHaveLength(1);
    }
  });

  it("on OpenRouter sends the same body as before, with the stored key's model", async () => {
    const { fetch, sent } = vendors();
    await clientOf(
      { deps: { modelFetch: fetch } },
      { kind: "openrouter" },
      "sk-or-test-0000",
      "openai/gpt-6-luna",
      noUsage,
    ).complete(request());
    expect(sent.map((one) => one.url)).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    expect(Object.keys(sent[0]?.body ?? {}).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "provider",
      "response_format",
      "stream",
      "usage",
    ]);
  });
});

// The moment lane's own model and effort, over the run's, on the same key.
describe("the moment lane's model", () => {
  const SONNET = "anthropic/claude-sonnet-5-5";
  const run = { PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY, PI_EXTRACT_EFFORT: "medium" };
  const owners = { ...run, PI_EXTRACT_MOMENT_MODEL: SONNET, PI_EXTRACT_MOMENT_EFFORT: "medium" };
  const of = (env: Record<string, string>) => momentModelOf(env, extractVendorOf(env, HAIKU), HAIKU);

  it("both unset: no override, so the moment lane asks the run's model and effort", () => {
    expect(of(run)).toBeUndefined();
    expect(momentModelOf({}, { kind: "openrouter" }, "openai/gpt-6-luna")).toBeUndefined();
  });

  it("set: the moment lane's pair on the same key; the one left unset is the run's", () => {
    expect(of(owners)).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "medium" },
      modelId: SONNET,
    });
    expect(of({ ...run, PI_EXTRACT_MOMENT_MODEL: SONNET })).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "medium" },
      modelId: SONNET,
    });
    expect(of({ ...run, PI_EXTRACT_MOMENT_EFFORT: "high" })).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "high" },
      modelId: HAIKU,
    });
    expect(of({ PI_EXTRACT_ANTHROPIC_KEY: ANTHROPIC_KEY, PI_EXTRACT_MOMENT_MODEL: SONNET })).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: undefined },
      modelId: SONNET,
    });
  });

  it("is bad_env without the Anthropic key, for another vendor's or a malformed model, and for an effort off the list", () => {
    expect(
      refusedWith(() =>
        momentModelOf({ PI_EXTRACT_MOMENT_MODEL: SONNET }, { kind: "openrouter" }, "openai/gpt-6-luna"),
      ),
    ).toBe("bad_env set PI_EXTRACT_MOMENT_MODEL");
    expect(
      refusedWith(() =>
        momentModelOf({ PI_EXTRACT_MOMENT_EFFORT: "medium" }, { kind: "openrouter" }, "openai/gpt-6-luna"),
      ),
    ).toBe("bad_env set PI_EXTRACT_MOMENT_EFFORT");
    // The last is well formed and not on the price list: its calls would report no cost.
    for (const model of [
      "openai/gpt-6-luna",
      "claude-sonnet-5-5",
      "anthropic/gpt-6",
      "anthropic/Claude Sonnet",
      `anthropic/claude-${"x".repeat(100)}`,
      "anthropic/claude-sonnet-9-9",
    ]) {
      expect(refusedWith(() => of({ ...run, PI_EXTRACT_MOMENT_MODEL: model }))).toBe(
        "bad_env set PI_EXTRACT_MOMENT_MODEL",
      );
    }
    expect(refusedWith(() => of({ ...run, PI_EXTRACT_MOMENT_EFFORT: "xhigh" }))).toBe(
      "bad_env set PI_EXTRACT_MOMENT_EFFORT",
    );
  });

  it("the moment world check asks the moment lane's pair with no --vendor, and every other lane's the run's", () => {
    expect(worldVendorOf(owners, {}, HAIKU, "moment")).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "medium" },
      modelId: SONNET,
    });
    expect(worldVendorOf({ ...owners, PI_EXTRACT_MOMENT_EFFORT: "high" }, {}, HAIKU, "meeting")).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "medium" },
      modelId: HAIKU,
    });
    expect(worldVendorOf(run, {}, HAIKU, "moment")).toEqual({
      vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "medium" },
      modelId: HAIKU,
    });
    expect(
      refusedWith(() => worldVendorOf({ ...run, PI_EXTRACT_MOMENT_MODEL: "openai/gpt-6-luna" }, {}, HAIKU, "moment")),
    ).toBe("bad_env set PI_EXTRACT_MOMENT_MODEL");
    // Every lane's check refuses a pair `pi extract` would refuse: an orphan effort with no key.
    for (const lane of ["meeting", "document", "moment"] as const) {
      expect(
        refusedWith(() => worldVendorOf({ PI_EXTRACT_MOMENT_EFFORT: "medium" }, {}, "openai/gpt-6-luna", lane)),
      ).toBe("bad_env set PI_EXTRACT_MOMENT_EFFORT");
    }
  });

  it("--vendor anthropic on the moment lane defaults to its pair; the flags win; --vendor openrouter is PI_EXTRACT_MODEL", () => {
    expect(
      worldVendorOf({ ...owners, PI_EXTRACT_MOMENT_EFFORT: "high" }, { vendor: "anthropic" }, HAIKU, "moment"),
    ).toEqual({ vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "high" }, modelId: SONNET });
    expect(
      worldVendorOf(owners, { vendor: "anthropic", model: "claude-haiku-5-5", effort: "low" }, HAIKU, "moment"),
    ).toEqual({ vendor: { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: "low" }, modelId: HAIKU });
    expect(worldVendorOf(owners, { vendor: "anthropic" }, HAIKU, "meeting").modelId).toBe(HAIKU);
    expect(
      refusedWith(() =>
        worldVendorOf({ ...owners, PI_EXTRACT_MOMENT_EFFORT: "xhigh" }, { vendor: "anthropic" }, HAIKU, "moment"),
      ),
    ).toBe("bad_env set PI_EXTRACT_MOMENT_EFFORT");
    expect(worldVendorOf(owners, { vendor: "openrouter" }, HAIKU, "moment")).toEqual({
      vendor: { kind: "openrouter" },
      modelId: HAIKU,
    });
  });

  it("the moment client sends Sonnet at the moment effort to Anthropic, and its usage names Sonnet, priced from the list", async () => {
    const { fetch, sent } = vendors();
    const lane = of(owners);
    if (lane === undefined) throw new Error("no override");
    const usage: ModelUsageEvent[] = [];
    await clientOf(
      { deps: { modelFetch: fetch } },
      lane.vendor,
      "",
      lane.modelId,
      async (event) => void usage.push(event),
    ).complete(request());
    expect(sent[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" } });
    expect(usage).toHaveLength(1);
    // The id the client called, in Anthropic's form.
    expect(usage[0]).toMatchObject({ modelId: "claude-sonnet-5-5", outcome: "ok" });
    // 10 input tokens at 2 dollars and 5 output at 10 dollars a million: 20 + 50 micro-dollars.
    expect(usage[0]?.costMicroUsd).toBe(70);
  });
});

describe("checkCaps", () => {
  const context = (keyFetch: typeof fetch) => {
    const lines: Record<string, unknown>[] = [];
    const log = {
      info: (line: Record<string, unknown>) => void lines.push(line),
      warn: () => {},
      error: () => {},
    } as unknown as PersonalLogger;
    return { context: { log, deps: { keyFetch } } as unknown as CommandContext, lines };
  };
  const anthropic: ExtractVendor = { kind: "anthropic", apiKey: ANTHROPIC_KEY, effort: undefined };

  it("on the Anthropic key with Jev off reads no OpenRouter limit and logs anthropic_console", async () => {
    const endpoint = fakeKeyEndpoint();
    const { context: ctx, lines } = context(endpoint.fetch);
    expect(readsOpenRouter(anthropic, false)).toBe(false);
    await checkCaps(ctx, anthropic, false, "", 20_000_000, undefined);
    expect(lines).toEqual([{ event: "spend_cap", code: "anthropic_console" }]);
    expect(endpoint.calls()).toBe(0);
  });

  it("with Jev on reads the OpenRouter key's limit first, then logs anthropic_console", async () => {
    const endpoint = fakeKeyEndpoint();
    const { context: ctx, lines } = context(endpoint.fetch);
    expect(readsOpenRouter(anthropic, true)).toBe(true);
    await checkCaps(ctx, anthropic, true, "sk-or-test-0000", 20_000_000, undefined);
    expect(lines.map((line) => line.code)).toEqual(["ok", "anthropic_console"]);
    expect(endpoint.calls()).toBe(1);
  });

  it("with print, writes R37's stdout lines of pi extract check instead of log lines", async () => {
    const { context: ctx, lines } = context(fakeKeyEndpoint().fetch);
    const printed: string[] = [];
    await checkCaps(ctx, anthropic, true, "sk-or-test-0000", 20_000_000, undefined, (line) => printed.push(line));
    expect(printed).toEqual([
      "spend_cap: ok limit_micro_usd=5000000 remaining_micro_usd=5000000",
      "spend_cap: anthropic_console",
    ]);
    expect(lines).toEqual([]);
  });

  it("on OpenRouter is the check as before, and a refusal ends it before any Anthropic line", async () => {
    const { context: ok, lines } = context(fakeKeyEndpoint().fetch);
    await checkCaps(
      ok,
      { kind: "openrouter" },
      readsOpenRouter({ kind: "openrouter" }, false),
      "sk-or-test-0000",
      20_000_000,
      undefined,
    );
    expect(lines.map((line) => line.code)).toEqual(["ok"]);
    const { context: over, lines: refusedLines } = context(fakeKeyEndpoint({ limit: 100 }).fetch);
    await expect(checkCaps(over, anthropic, true, "sk-or-test-0000", 20_000_000, undefined)).rejects.toMatchObject({
      code: "spend_cap_too_high",
    });
    expect(refusedLines.map((line) => line.code)).toEqual(["spend_cap_too_high"]);
  });
});
