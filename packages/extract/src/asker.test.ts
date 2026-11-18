import { SourceCheckAnswer } from "@intelligence/contracts/personal";
import { BudgetReached, type ModelClient, ModelClientError, ModelOutputRejected } from "@intelligence/personal-models";
import { fakeKeyedCallStore } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { asker } from "./asker.ts";
import { SOURCE_CHECK_PROMPT } from "./question-prompts.ts";

const SUBJECT = `facts:${"a".repeat(64)}:${"b".repeat(64)}`;
const ANSWER = { verdict: "unsupported", cites: [] };

function harness(complete: ModelClient["complete"]) {
  const saved = fakeKeyedCallStore();
  const noted: string[][] = [];
  const logged: unknown[] = [];
  const ask = asker({
    point: { id: "source_check", version: 1 },
    prompt: SOURCE_CHECK_PROMPT,
    schema: SourceCheckAnswer,
    store: {
      calls: () => ({
        store: saved,
        lastId: async () => (saved.records().length > 0 ? `call_${saved.records().length}` : null),
      }),
    },
    exposure: {
      noteExposure: async (_model, _prompt, ids) => {
        noted.push([...ids]);
        return ids.length;
      },
    },
    client: { model: { complete, embed: () => Promise.reject(new Error("no")) }, modelId: "m/one" },
    log: { info: () => {}, warn: (entry) => logged.push(entry), error: () => {} },
    failed: { event: "source_check_call_failed" },
  });
  const call = { slot: "{}", subject: SUBJECT, refs: ["ev_2", "ev_1", "ev_2"], compartments: ["personal"] };
  return { ask: () => ask(call), noted, logged };
}

const answering: ModelClient["complete"] = async (request) => ({
  output: ANSWER,
  label: request.label,
  usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
  modelId: "m/one",
});

describe("asker", () => {
  it("answers the parsed output and its saved call, the refs noted sorted and once each before the request", async () => {
    const h = harness(answering);
    expect(await h.ask()).toEqual({ output: ANSWER, savedCall: "call_1" });
    expect(h.noted).toEqual([["ev_1", "ev_2"]]);
  });

  it("replays a saved answer without a request, so notes nothing", async () => {
    const h = harness(answering);
    await h.ask();
    expect(await h.ask()).toEqual({ output: ANSWER, savedCall: "call_1" });
    expect(h.noted).toHaveLength(1);
  });

  it.each([
    ["a refused output, saved", new ModelOutputRejected("prose"), { rejected: "call_1", rawOutput: "prose" }],
    ["a reached budget", new BudgetReached("calls"), "budget"],
    ["an outage, logged by its code", new ModelClientError("unavailable"), "unavailable"],
  ])("answers %s", async (_name, error, expected) => {
    const h = harness(() => Promise.reject(error));
    expect(await h.ask()).toEqual(expected);
    expect(h.logged).toEqual(
      expected === "unavailable" ? [{ event: "source_check_call_failed", code: "unavailable" }] : [],
    );
  });

  it("throws an error with no code", async () => {
    const h = harness(() => Promise.reject(new Error("bug")));
    await expect(h.ask()).rejects.toThrow("bug");
  });
});
