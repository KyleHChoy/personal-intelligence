import { ModelUsageEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { ModelOutputRejected } from "./client/errors.ts";
import { answer, client, evidenceId, MODEL, OUTPUT, PROMPT, request, thrown, timeout } from "./test-support/support.ts";
import { ASSUMED_CALL_MICRO_USD, microUsd } from "./usage.ts";

const toolCall = { id: "call-1", type: "function", function: { name: "send_mail", arguments: "{}" } };

describe("usage", () => {
  it("each answer is reported once, with the request's prompt and evidence id", async () => {
    const { model, usage } = client();
    await model.complete(request());
    expect(usage).toEqual([
      {
        promptId: PROMPT.id,
        promptVersion: PROMPT.version,
        modelId: MODEL,
        inputTokens: 120,
        outputTokens: 30,
        costMicroUsd: 123,
        outcome: "ok",
        evidenceId,
      },
    ]);
    expect(ModelUsageEvent.safeParse(usage[0]).success).toBe(true);
    // A request with no call key names no item, and its event names none.
    const { callKey: _none, ...keyless } = request();
    const second = client();
    await second.model.complete(keyless);
    expect(second.usage[0]).not.toHaveProperty("evidenceId");
  });

  it("the usage is reported, and awaited, before the call returns", async () => {
    const order: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { model } = client([{}], {
      onUsage: async () => {
        order.push("usage started");
        await held;
        order.push("usage written");
      },
    });
    const call = model.complete(request()).then(() => order.push("returned"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["usage started"]);
    release();
    await call;
    expect(order).toEqual(["usage started", "usage written", "returned"]);
  });

  it("a rejected output is still counted", async () => {
    const bodies = [
      answer({ content: '{"claims":"no"}' }),
      answer({ toolCalls: [toolCall] }),
      answer({ finish: "length" }),
      answer({ finish: "content_filter" }),
    ];
    for (const body of bodies) {
      const { model, usage } = client([{ body }]);
      expect(await thrown(model.complete(request()))).toBeInstanceOf(ModelOutputRejected);
      expect(usage.map((event) => [event.outcome, event.costMicroUsd])).toEqual([["rejected", 123]]);
    }
  });

  it("the cost is micro-dollars, rounded up", async () => {
    expect([0, 0.000123, 0.00015, 0.0000001, 0.0000011, 1.5, 0.1 + 0.2].map(microUsd)).toEqual([
      0, 123, 150, 1, 2, 1_500_000, 300_000,
    ]);
    const { model, usage } = client([{ body: answer({ cost: 0.0000004 }) }]);
    const response = await model.complete(request());
    expect(usage[0]?.costMicroUsd).toBe(1);
    // The shared response keeps the vendor's figure, in US dollars.
    expect(response.usage.cost).toBe(0.0000004);
  });

  it("the usage event and the response name the configured model, whatever the answer's model field says", async () => {
    const { model, usage } = client([{ body: answer({ model: "vendor/a-model-nobody-chose" }) }]);
    const response = await model.complete(request());
    expect(response.modelId).toBe(MODEL);
    expect(usage[0]?.modelId).toBe(MODEL);
    expect(JSON.stringify([response, usage])).not.toContain("nobody-chose");
  });

  it("a timed-out attempt is counted at the assumed cost and not sent again", async () => {
    const { model, sent, usage } = client([timeout(), {}]);
    expect(((await thrown(model.complete(request()))) as { code: string }).code).toBe("unavailable");
    expect(sent).toHaveLength(1);
    expect(usage).toEqual([
      expect.objectContaining({
        outcome: "timed_out",
        costMicroUsd: ASSUMED_CALL_MICRO_USD,
        inputTokens: 0,
        outputTokens: 0,
        evidenceId,
      }),
    ]);
  });

  it("an answer with no cost is counted at the assumed cost and marked", async () => {
    for (const body of [
      answer({ cost: undefined }),
      answer({ cost: "0.0001" }),
      answer({ cost: -1 }),
      { ...answer(), usage: undefined },
    ]) {
      const { model, usage } = client([{ body }]);
      // The answer is paid for, so its output is kept.
      expect((await model.complete(request())).output).toEqual(OUTPUT);
      expect(usage.map((event) => [event.outcome, event.costMicroUsd])).toEqual([
        ["cost_missing", ASSUMED_CALL_MICRO_USD],
      ]);
    }
    // A rejected answer with no cost is marked too: without a cost the budget is no bound.
    const { model, usage } = client([{ body: answer({ cost: undefined, finish: "length" }) }]);
    await thrown(model.complete(request()));
    expect(usage.map((event) => event.outcome)).toEqual(["cost_missing"]);
  });

  it("a body with no choices is counted only when it carries a cost, and never as cost_missing", async () => {
    const counted = [
      { error: { code: 502 }, usage: { prompt_tokens: 120, cost: 0.0002 } },
      { ...answer({ finish: "error" }), usage: { prompt_tokens: 120, completion_tokens: 0, cost: 0.0002 } },
    ];
    for (const body of counted) {
      const { model, usage } = client([{ body }]);
      await thrown(model.complete(request()));
      expect(usage.map((event) => [event.outcome, event.costMicroUsd, event.inputTokens])).toEqual([
        ["no_answer", 200, 120],
      ]);
    }
    const uncounted = [
      { error: { code: 502 } },
      { error: { code: 502 }, usage: { prompt_tokens: 120 } },
      "not json",
      answer({ finish: "error", cost: undefined }),
    ];
    for (const body of uncounted) {
      const { model, usage } = client([{ body }]);
      await thrown(model.complete(request()));
      expect(usage).toEqual([]);
    }
  });

  it("a call that failed with no answer and no timeout is not counted", async () => {
    const failed = new TypeError("fetch failed");
    for (const replies of [
      [failed, failed, failed],
      [{ status: 402 }],
      [{ status: 500 }, { status: 502 }, { status: 503 }],
      [{ status: 429, headers: { "retry-after": "60" } }],
    ]) {
      const { model, usage } = client(replies);
      await thrown(model.complete(request()));
      expect(usage).toEqual([]);
    }
  });
});
