import type { ModelUsageEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Budget, BudgetReached, microUsdOf, withBudget } from "./budget.ts";
import type { ModelClient } from "./client/client.ts";
import type { ModelClientError } from "./client/errors.ts";
import { completeWithReplay } from "./client/replay.ts";
import { answer, client, keys, memoryStore, OUTPUT, REGISTRY, request, thrown } from "./test-support/support.ts";

// A run's tally, as `pi extract` keeps it from the usage rows it writes: the run's spend, the
// day's (with what the day had spent before the run), and whether an answer carried no cost.
const tally = (
  bounds: Partial<Pick<Budget, "runMicroUsd" | "dayMicroUsd" | "maxCalls" | "reserveMicroUsd">> = {},
  before = { run: 0, day: 0 },
) => {
  let run = before.run;
  let day = before.day;
  let missing = false;
  const budget: Budget = {
    spentRun: () => run,
    spentDay: async () => day,
    costMissing: () => missing,
    runMicroUsd: 1_000_000,
    dayMicroUsd: 3_000_000,
    maxCalls: 100,
    ...bounds,
  };
  const onUsage = async (event: ModelUsageEvent): Promise<void> => {
    run += event.costMicroUsd;
    day += event.costMicroUsd;
    if (event.outcome === "cost_missing") missing = true;
  };
  return { budget, onUsage };
};

const reason = (error: unknown): string => {
  expect(error).toBeInstanceOf(BudgetReached);
  expect(error).toBeInstanceOf(Error);
  expect((error as BudgetReached).code).toBe("budget_reached");
  return (error as BudgetReached).reason;
};

describe("withBudget", () => {
  it("the budget refuses before the request", async () => {
    const cases = [
      { bounds: { runMicroUsd: 500 }, before: { run: 500, day: 500 }, why: "run" },
      { bounds: { dayMicroUsd: 500 }, before: { run: 0, day: 600 }, why: "day" },
      { bounds: { maxCalls: 0 }, before: { run: 0, day: 0 }, why: "calls" },
    ];
    for (const { bounds, before, why } of cases) {
      const { budget, onUsage } = tally(bounds, before);
      const { model, sent } = client([{}], { onUsage });
      expect(reason(await thrown(withBudget(model, budget).complete(request())))).toBe(why);
      expect(sent).toHaveLength(0);
    }
    // The positive control: a call under every bound is sent.
    const { budget, onUsage } = tally({ runMicroUsd: 500, dayMicroUsd: 500, maxCalls: 1 }, { run: 499, day: 499 });
    const { model, sent } = client([{}], { onUsage });
    expect((await withBudget(model, budget).complete(request())).output).toEqual(OUTPUT);
    expect(sent).toHaveLength(1);
  });

  it("the call bound counts the calls this wrapper passed on", async () => {
    const { budget, onUsage } = tally({ maxCalls: 2 });
    const { model, sent } = client([{}], { onUsage });
    const bounded = withBudget(model, budget);
    await bounded.complete(request());
    await bounded.complete(request());
    expect(reason(await thrown(bounded.complete(request())))).toBe("calls");
    expect(sent).toHaveLength(2);
  });

  it("wrappers given one count share the call bound; one without it keeps its own", async () => {
    const { budget, onUsage } = tally({ maxCalls: 2 });
    const { model, sent } = client([{}], { onUsage });
    const shared = { made: 0 };
    const main = withBudget(model, { ...budget, calls: shared });
    const moments = withBudget(model, { ...budget, calls: shared });
    const own = withBudget(model, budget);
    await main.complete(request());
    await moments.complete(request());
    expect(reason(await thrown(main.complete(request())))).toBe("calls");
    expect(reason(await thrown(moments.complete(request())))).toBe("calls");
    expect(shared.made).toBe(2);
    await own.complete(request());
    expect(sent).toHaveLength(3);
  });

  it("a call that starts under the line is sent whatever it costs, and the next is refused", async () => {
    const { budget, onUsage } = tally({ runMicroUsd: 100 }, { run: 99, day: 99 });
    const { model, sent } = client([{ body: answer({ cost: 0.05 }) }], { onUsage });
    const bounded = withBudget(model, budget);
    await bounded.complete(request());
    expect(budget.spentRun()).toBe(50_099);
    expect(reason(await thrown(bounded.complete(request())))).toBe("run");
    expect(sent).toHaveLength(1);
  });

  it("after an answer with no cost the next call is refused as cost_missing", async () => {
    const { budget, onUsage } = tally();
    const { model, sent } = client([{ body: answer({ cost: undefined }) }, {}], { onUsage });
    const bounded = withBudget(model, budget);
    expect((await bounded.complete(request())).output).toEqual(OUTPUT);
    expect(reason(await thrown(bounded.complete(request())))).toBe("cost_missing");
    expect(sent).toHaveLength(1);
  });

  it("a body with no choices does not stop the run as cost_missing", async () => {
    const { budget, onUsage } = tally();
    const { model, sent } = client([{ body: { error: { code: 502, message: "provider failed" } } }, {}], { onUsage });
    const bounded = withBudget(model, budget);
    const { store, records } = memoryStore();
    expect(
      ((await thrown(completeWithReplay(bounded, store, request(), keys, REGISTRY))) as ModelClientError).code,
    ).toBe("unavailable");
    expect(records).toHaveLength(0);
    expect(budget.costMissing()).toBe(false);
    expect((await completeWithReplay(bounded, store, request(), keys, REGISTRY)).output).toEqual(OUTPUT);
    expect(sent).toHaveLength(2);
  });

  it("a replayed call does not reach the budget", async () => {
    const { budget, onUsage } = tally({ maxCalls: 1 });
    const { model, sent } = client([{}], { onUsage });
    const bounded = withBudget(model, budget);
    const { store } = memoryStore();
    await completeWithReplay(bounded, store, request(), keys, REGISTRY);
    // The second run of the same item replays: nothing is sent, and the call bound of one is
    // not reached by it.
    expect((await completeWithReplay(bounded, store, request(), keys, REGISTRY)).modelId).toBe("replay");
    expect(sent).toHaveLength(1);
    // A different item is a live call, and the one call the bound allows is spent.
    expect(
      reason(await thrown(completeWithReplay(bounded, store, request({ data: { message: "other" } }), keys, REGISTRY))),
    ).toBe("calls");
  });

  // A model whose calls wait until let go, each then recording `cost` before it answers, as a
  // client's usage callback does.
  const held = (onUsage: (event: ModelUsageEvent) => Promise<void>, cost: number) => {
    const waiting: (() => void)[] = [];
    let sent = 0;
    const model: ModelClient = {
      async complete() {
        sent += 1;
        await new Promise<void>((resolve) => waiting.push(resolve));
        await onUsage({ costMicroUsd: cost, outcome: "ok" } as ModelUsageEvent);
        return { output: OUTPUT } as never;
      },
      embed: async () => ({}) as never,
    };
    const letGo = (): void => {
      for (const go of waiting.splice(0)) go();
    };
    return { model, sent: () => sent, letGo };
  };

  it("calls in flight together reserve their cost, so they cannot pass a bound together", async () => {
    // Each call reserves 10 000 against a run bound of 25 000: three pass, the fourth and fifth
    // are refused while the three are in flight.
    const { budget, onUsage } = tally({ runMicroUsd: 25_000, reserveMicroUsd: 10_000 });
    const { model, sent, letGo } = held(onUsage, 10_000);
    const bounded = withBudget(model, budget);
    const calls = Array.from({ length: 5 }, () => bounded.complete(request()).then(() => "sent", reason));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent()).toBe(3);
    letGo();
    expect(await Promise.all(calls)).toEqual(["sent", "sent", "sent", "run", "run"]);
    expect(budget.spentRun()).toBe(30_000);
    // The positive control: with nothing reserved, every call in flight passes the same bound.
    const open = tally({ runMicroUsd: 25_000, reserveMicroUsd: 0 });
    const loose = held(open.onUsage, 10_000);
    const unbounded = withBudget(loose.model, open.budget);
    const all = Array.from({ length: 5 }, () => unbounded.complete(request()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loose.sent()).toBe(5);
    loose.letGo();
    await Promise.all(all);
    expect(open.budget.spentRun()).toBe(50_000);
  });

  it("the day bound counts reservations across the day's read, and a settled call lets its reservation go", async () => {
    // spentDay answers after a pause, so every call's day check would read the same spend.
    const { budget, onUsage } = tally({ dayMicroUsd: 15_000 });
    const slowDay: Budget = {
      ...budget,
      spentDay: () => new Promise((resolve) => setTimeout(() => resolve(budget.spentRun()), 5)),
    };
    const { model, sent, letGo } = held(onUsage, 1_000);
    const bounded = withBudget(model, slowDay);
    const calls = Array.from({ length: 3 }, () => bounded.complete(request()).then(() => "sent", reason));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The default reservation is ASSUMED_CALL_MICRO_USD, 10 000: two calls in flight leave no room.
    expect(sent()).toBe(2);
    letGo();
    expect(await Promise.all(calls)).toEqual(["sent", "sent", "day"]);
    // Both settled at 1 000 each: their reservations are let go, and the next call passes.
    const next = bounded.complete(request());
    await new Promise((resolve) => setTimeout(resolve, 20));
    letGo();
    expect((await next).output).toEqual(OUTPUT);
  });

  it("a call that fails lets its reservation go", async () => {
    const { budget } = tally({ runMicroUsd: 15_000, reserveMicroUsd: 10_000 });
    let fail = true;
    const model: ModelClient = {
      async complete() {
        if (fail) throw new Error("unavailable");
        return { output: OUTPUT } as never;
      },
      embed: async () => ({}) as never,
    };
    const bounded = withBudget(model, budget);
    await expect(bounded.complete(request())).rejects.toThrow("unavailable");
    fail = false;
    expect((await bounded.complete(request())).output).toEqual(OUTPUT);
  });

  it("embed passes through", async () => {
    const { budget } = tally();
    const { model } = client();
    expect(((await thrown(withBudget(model, budget).embed({} as never))) as ModelClientError).code).toBe("bad_purpose");
  });
});

describe("microUsdOf", () => {
  it("reads dollars with at most six decimals as whole micro-dollars, and nothing else", () => {
    expect(["0", "1.5", "20", "0.000001", "999999.999999"].map(microUsdOf)).toEqual([
      0, 1_500_000, 20_000_000, 1, 999_999_999_999,
    ]);
    for (const bad of ["", "-1", "1.", ".5", "1.0000001", "1e3", "1,5", "1234567", " 1"])
      expect(microUsdOf(bad), bad).toBeNull();
  });
});
