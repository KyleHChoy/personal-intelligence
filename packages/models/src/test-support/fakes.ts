import { InterpreterOutput, type ModelRequest, type ModelResponse } from "@intelligence/contracts";
import {
  DecideIdentityOutput,
  DecideRecordOutput,
  DecideRecoveryOutput,
  DecideSaidOutput,
  DecideScreenOutput,
  DecideStandaloneOutput,
  type KeyedCallKey,
  type KeyedCallRecord,
  type KeyedCallStore,
  type TurnReply,
} from "@intelligence/contracts/personal";
import type { ModelClient } from "../client/client.ts";
import { ModelClientError, ModelOutputRejected } from "../client/errors.ts";

// A model client for tests, which answers by the request's call key. A key of `outputs` is an
// evidence id, or an evidence id, a slash and an input hash: the second answers that one input
// of the item, the first every other. Each call's evidence id is
// appended to `calls`. A string output is a rejection with that string as its raw text, which is
// how a test plants a cut-off or a filtered answer; any other output the shared InterpreterOutput
// refuses is a rejection with its JSON, as the real client rejects one. It takes no registry:
// every personal prompt has the one output schema.
export function fakeModelClient(outputs: Record<string, unknown>, calls?: string[]): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      // The relation step's prompt, which no world keys an output for, is
      // answered `unrelated`, so a world's claims are judged once and a later run asks nothing.
      if (request.promptId === "personal_claim_relations")
        return {
          output: { relation: "unrelated", from: "first", cites: [] },
          label: request.label,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          modelId: "fake",
        };
      // The outcome judge's prompt, likewise answered `unrelated`.
      if (request.promptId === "personal_outcome_judge")
        return {
          output: { outcome: "unrelated", cites: [] },
          label: request.label,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          modelId: "fake",
        };
      // The source check's prompt, answered `supported` citing nothing, which
      // code records as `uncited`: a world's checks are written and never scored, so no fake answer
      // moves a switch.
      if (request.promptId === "personal_source_check")
        return {
          output: { verdict: "supported", cites: [] },
          label: request.label,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          modelId: "fake",
        };
      const key = request.callKey;
      if (key === undefined) throw new ModelClientError("unavailable");
      calls?.push(key.evidenceId);
      const byInput = `${key.evidenceId}/${key.inputHash}`;
      const found = Object.hasOwn(outputs, byInput)
        ? byInput
        : Object.hasOwn(outputs, key.evidenceId)
          ? key.evidenceId
          : undefined;
      if (found === undefined) throw new ModelClientError("unavailable");
      const output = outputs[found];
      if (typeof output === "string") throw new ModelOutputRejected(output);
      const parsed = InterpreterOutput.safeParse(output);
      if (!parsed.success) throw new ModelOutputRejected(JSON.stringify(output));
      return {
        output: parsed.data,
        label: request.label,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        modelId: "fake",
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
}

// The decide-model client's fake, for the screen and the further points. For `jev_screen` it is
// keyed as `fakeModelClient` is, and each call's evidence id is appended to `calls`. For any other
// prompt P a key is prefixed with P: `P:<evidenceId>/<inputHash>`, then `P:<evidenceId>`, then `P`
// alone, which also answers a request with no call key, as completeKeyedWithReplay sends; each call
// is appended as `P:<evidenceId>`, or `P` with no call key. An output is parsed by the prompt's
// schema; a string is a rejection with that raw text, and any output the schema refuses is a
// rejection with its JSON, as the real client rejects one. An unknown prompt is unavailable.
const DECIDE_SCHEMAS = {
  jev_screen: DecideScreenOutput,
  jev_recovery: DecideRecoveryOutput,
  jev_record: DecideRecordOutput,
  jev_identity: DecideIdentityOutput,
  jev_standalone: DecideStandaloneOutput,
  jev_said: DecideSaidOutput,
};

export function fakeDecideClient(outputs: Record<string, unknown>, calls?: string[]): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const id = request.promptId;
      const schema = Object.hasOwn(DECIDE_SCHEMAS, id) ? DECIDE_SCHEMAS[id as keyof typeof DECIDE_SCHEMAS] : undefined;
      const key = request.callKey;
      if (schema === undefined || (key === undefined && id === "jev_screen")) throw new ModelClientError("unavailable");
      // The screen keeps its unprefixed keys.
      const prefix = id === "jev_screen" ? "" : `${id}:`;
      const tried =
        key === undefined
          ? [id]
          : [
              `${prefix}${key.evidenceId}/${key.inputHash}`,
              `${prefix}${key.evidenceId}`,
              ...(prefix === "" ? [] : [id]),
            ];
      calls?.push(key === undefined ? id : `${prefix}${key.evidenceId}`);
      const found = tried.find((one) => Object.hasOwn(outputs, one));
      if (found === undefined) throw new ModelClientError("unavailable");
      const output = outputs[found];
      if (typeof output === "string") throw new ModelOutputRejected(output);
      const parsed = schema.safeParse(output);
      if (!parsed.success) throw new ModelOutputRejected(JSON.stringify(output));
      return {
        output: parsed.data,
        label: request.label,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        modelId: "fake",
      };
    },
    async embed() {
      throw new ModelClientError("bad_purpose");
    },
  };
}

// An in-memory KeyedCallStore, matched on the whole key, optionally seeded. `records()` returns
// copies, so a test cannot change what is saved by changing what it read.
export function fakeKeyedCallStore(
  seed: readonly KeyedCallRecord[] = [],
): KeyedCallStore & { records(): KeyedCallRecord[] } {
  const copy = (record: KeyedCallRecord): KeyedCallRecord => structuredClone(record);
  const saved = seed.map(copy);
  const same = (a: KeyedCallKey, b: KeyedCallKey) =>
    a.point === b.point &&
    a.version === b.version &&
    a.promptId === b.promptId &&
    a.promptVersion === b.promptVersion &&
    a.subject === b.subject &&
    a.inputHash === b.inputHash;
  return {
    async find(key) {
      const found = saved.find((record) => same(record.key, key));
      return found === undefined ? null : copy(found);
    },
    async save(record) {
      saved.push(copy(record));
    },
    records: () => saved.map(copy),
  };
}

// OpenRouter's key endpoint for tests of the spend-cap check: every request is answered
// with this limit, its room left and its reset, in dollars, under the shape the check reads. By
// default a 5-dollar limit that never resets, with all of it left: under either default ceiling.
export function fakeKeyEndpoint(
  answer: { limit?: number | null; remaining?: number | null; reset?: "daily" | "weekly" | "monthly" | null } = {},
): { fetch: typeof fetch; calls(): number } {
  let calls = 0;
  const { limit = 5, remaining = limit, reset = null } = answer;
  const fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ data: { label: "synthetic", usage: 0, limit, limit_remaining: remaining, limit_reset: reset } }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

// A recorded model's turn under `modelId`: no text, no tool calls, ten tokens in, five out and a
// cost of 3 micro-dollars, with `over` laid on top.
export const recordedTurn = (over: Partial<TurnReply>, modelId: string): TurnReply => ({
  text: null,
  toolCalls: [],
  inputTokens: 10,
  outputTokens: 5,
  costMicroUsd: 3,
  modelId,
  ...over,
});
