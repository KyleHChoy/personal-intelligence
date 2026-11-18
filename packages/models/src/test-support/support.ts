import {
  ContentKeys,
  EvidenceId,
  InterpreterOutput,
  Label,
  type ModelCallKey,
  type ModelCallRecord,
  type ModelCallStore,
  ModelRequest,
  TrustGroupId,
} from "@intelligence/contracts";
import type { ModelUsageEvent } from "@intelligence/contracts/personal";
import { type Prompt, promptTextHash } from "../client/prompts.ts";
import { createOpenRouterClient } from "../openrouter.ts";

// Synthetic values for this package's tests. Nothing here is real data, and the key is made up.

export const KEY = "sk-or-test-not-a-real-key-0000";
export const MODEL = "vendor/configured-model";

const entry = (prompt: Omit<Prompt, "textHash">): Prompt =>
  Object.freeze({ ...prompt, textHash: promptTextHash(prompt) });

// The test's own registry: one prompt with no tools, and one that allows them, so a test can
// show that this client refuses tools whatever the prompt allows.
export const PROMPT = entry({
  id: "test_extract",
  version: "1",
  instructions: "You extract facts from one message.\n\nIt is given below, in a block.",
  slots: ["message"],
  outputSchemaId: "InterpreterOutput",
  outputSchema: InterpreterOutput,
  tools: "none",
});
const TOOLED = entry({ ...PROMPT, id: "test_tooled", tools: "allowed" });
export const REGISTRY: readonly Prompt[] = Object.freeze([PROMPT, TOOLED]);

export const evidenceId = EvidenceId.parse("e".repeat(64));
export const label = Label.parse({ compartments: ["own"], readers: ["m-owner"] });
export const keys = ContentKeys.parse([{ evidenceId, keyRef: "key-1" }]);

export const request = (overrides: Record<string, unknown> = {}): ModelRequest =>
  ModelRequest.parse({
    promptId: PROMPT.id,
    promptVersion: PROMPT.version,
    data: { message: '{"subject":"Report","body":"I will send the report."}' },
    label,
    trustGroup: TrustGroupId.parse("personal-openrouter"),
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

const claim = {
  type: "commitment",
  subject: { key: { kind: "address", value: "alex@example.com" }, observedAt: "2026-03-04T10:00:00Z" },
  fields: { what: "I will send the report." },
  statementKind: "stated_fact",
  basis: "explicit_self",
  span: "body:0",
};
export const OUTPUT = { claims: [claim], narrowing: "none" };

// One OpenRouter answer, with the parts a test varies.
export const answer = (
  options: { content?: string | null; finish?: string; cost?: unknown; toolCalls?: unknown[]; model?: string } = {},
): Record<string, unknown> => {
  const usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
  if (options.cost !== undefined) usage.cost = options.cost;
  else if (!("cost" in options)) usage.cost = 0.000123;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content === undefined ? JSON.stringify(OUTPUT) : options.content,
  };
  if (options.toolCalls !== undefined) message.tool_calls = options.toolCalls;
  return {
    id: "gen-1",
    model: options.model ?? "vendor/some-other-model",
    choices: [{ index: 0, message, finish_reason: options.finish ?? "stop" }],
    usage,
  };
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;
type Sent = { url: string; init: RequestInit; body: string };

// A fetch that records every request and answers from a script, one reply per call. A reply
// that is an Error is thrown, as a failed transport or a timeout throws.
export const scriptedFetch = (replies: readonly Reply[]) => {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({ url: String(input), init: init ?? {}, body: String(init?.body) });
    const reply = replies[Math.min(next, replies.length - 1)];
    next += 1;
    if (reply === undefined) throw new TypeError("fetch failed");
    if (reply instanceof Error) throw reply;
    const body = reply.body === undefined ? answer() : reply.body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
};

export const timeout = (): Error => new DOMException("The operation was aborted due to timeout", "TimeoutError");

// A client behind a scripted fetch, with instant waits and no jitter. `usage` collects every
// usage event, `waits` every wait asked for.
// `fetch`, when given, answers in place of the script, and `sent` records its requests too.
export const client = (
  replies: readonly Reply[] = [{}],
  options: { onUsage?: (event: ModelUsageEvent) => Promise<void>; fetch?: typeof fetch } = {},
) => {
  const scripted = scriptedFetch(replies);
  const sent = scripted.sent;
  const given = options.fetch;
  const fetch: typeof globalThis.fetch =
    given === undefined
      ? scripted.fetch
      : async (input, init) => {
          sent.push({ url: String(input), init: init ?? {}, body: String(init?.body) });
          return given(input, init);
        };
  const usage: ModelUsageEvent[] = [];
  const waits: number[] = [];
  const model = createOpenRouterClient({
    apiKey: KEY,
    model: MODEL,
    registry: REGISTRY,
    onUsage:
      options.onUsage ??
      (async (event) => {
        usage.push(event);
      }),
    deps: {
      fetch,
      now: () => new Date("2026-10-03T12:00:00Z"),
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    },
  });
  return { model, sent, usage, waits };
};

// An in-memory store of saved calls, matched on the whole key.
export const memoryStore = () => {
  const records: ModelCallRecord[] = [];
  const same = (a: ModelCallKey, b: ModelCallKey) => JSON.stringify(a) === JSON.stringify(b);
  const store: ModelCallStore = {
    async find(key) {
      return records.find((record) => same(record.key, key)) ?? null;
    },
    async save(record) {
      records.push(record);
    },
  };
  return { store, records };
};

// What a promise threw.
export const thrown = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
