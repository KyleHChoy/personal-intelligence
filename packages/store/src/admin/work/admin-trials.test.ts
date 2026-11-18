import { describe, expect, it } from "vitest";
import { trialSummary } from "./admin-trials.ts";

// `pi work trials`: a trial's steps summed. Made-up values only.

const model = (cost: number, code: string | null = null, attempt = 1) => ({
  attempt,
  kind: "model_call",
  code,
  cost,
  inputTokens: 1000,
  outputTokens: 200,
  ms: 3000,
});
const tool = (attempt = 1) => ({
  attempt,
  kind: "tool_call",
  code: null,
  cost: null,
  inputTokens: null,
  outputTokens: null,
  ms: null,
});
const check = {
  attempt: 1,
  kind: "output_check",
  code: "no_citation",
  cost: null,
  inputTokens: null,
  outputTokens: null,
  ms: null,
};

describe("a trial's summary", () => {
  it("sums its model calls' tokens, time and cost, and counts its tool calls", () => {
    expect(trialSummary("finished", [model(40), tool(), tool(), model(60)])).toEqual({
      modelCalls: 2,
      toolCalls: 2,
      inputTokens: 2000,
      outputTokens: 400,
      modelMs: 6000,
      costMicroUsd: 100,
      firstTryValid: true,
    });
    // A step with no counts (a model call recorded without them) adds nothing.
    expect(trialSummary("finished", [{ ...model(5), inputTokens: null, outputTokens: null, ms: null }])).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      modelMs: 0,
      costMicroUsd: 5,
    });
  });

  it("is first-try valid only when it finished and its first answer passed", () => {
    // Tools, then an answer that passed; a cut-off reply before it is no answer.
    expect(trialSummary("finished", [model(1), tool(), model(1, "truncated"), model(1)]).firstTryValid).toBe(true);
    // An answer of the wrong shape got one more turn: a model call right after an answer.
    expect(trialSummary("finished", [model(1), tool(), model(1), model(1)]).firstTryValid).toBe(false);
    // An answer the code checks refused.
    expect(trialSummary("finished", [model(1), check, model(1)]).firstTryValid).toBe(false);
    expect(trialSummary("failed", [model(1)]).firstTryValid).toBe(false);
    // Only the last attempt counts: a lost first attempt's steps do not.
    expect(trialSummary("finished", [model(1), model(1), model(1, null, 2)]).firstTryValid).toBe(true);
    // A web step between two model calls is no answer, so the retry is still seen.
    const web = {
      attempt: 1,
      kind: "web_search",
      code: null,
      cost: null,
      inputTokens: null,
      outputTokens: null,
      ms: null,
    };
    expect(trialSummary("finished", [model(1), tool(), model(1), web, model(1)]).firstTryValid).toBe(false);
    expect(trialSummary("finished", [model(1), web, tool(), model(1)]).firstTryValid).toBe(true);
  });
});
