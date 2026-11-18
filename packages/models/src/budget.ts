import type { ModelClient } from "./client/client.ts";
import { ASSUMED_CALL_MICRO_USD } from "./usage.ts";

// A stop line on spend and calls. Before a call, its cost is reserved: the checks count spend
// already recorded plus what the calls in flight have reserved, the call reserves its own, and the
// reservation is let go when the call settles, by which time its usage is recorded. Checks and
// reservations are made one call at a time, so calls in flight together cannot all pass a bound: a
// run or a day ends over its bound by at most one call's cost, as when calls are made one at a
// time.

export type Budget = {
  spentRun(): number;
  spentDay(): Promise<number>;
  costMissing(): boolean;
  runMicroUsd: number;
  dayMicroUsd: number;
  maxCalls: number;
  // A count of calls shared by the wrappers of one limit, as the moment lane's
  // client shares the run's. Absent, the wrapper counts its own calls. Wrappers that share a count
  // share their reservations too.
  calls?: { made: number };
  // What one call reserves, in micro-dollars: the most it is expected to cost. Absent, a call
  // reserves ASSUMED_CALL_MICRO_USD.
  reserveMicroUsd?: number;
};

// What the calls in flight under one count have reserved, and the end of the latest admission, so
// the next call's checks start after it has reserved.
type Held = { microUsd: number; admitted: Promise<unknown> };
const heldBy = new WeakMap<{ made: number }, Held>();
function heldFor(calls: { made: number }): Held {
  let held = heldBy.get(calls);
  if (held === undefined) {
    held = { microUsd: 0, admitted: Promise.resolve() };
    heldBy.set(calls, held);
  }
  return held;
}

// Dollars with at most six decimals as whole micro-dollars, with no rounding ("1.5" is
// 1 500 000), or null for text that is not such an amount.
export function microUsdOf(value: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(value);
  return match === null ? null : Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

export type BudgetReason = "run" | "day" | "calls" | "cost_missing";

// A call refused before it was sent, because a bound was reached.
export class BudgetReached extends Error {
  readonly code = "budget_reached";
  readonly reason: BudgetReason;

  constructor(reason: BudgetReason) {
    super(`budget_reached:${reason}`);
    this.name = "BudgetReached";
    this.reason = reason;
  }
}

// A replay never reaches this wrapper, so it costs nothing and is not counted as a call.
export function withBudget(client: ModelClient, budget: Budget): ModelClient {
  const calls = budget.calls ?? { made: 0 };
  const held = heldFor(calls);
  const reserve = budget.reserveMicroUsd ?? ASSUMED_CALL_MICRO_USD;
  const admit = async (): Promise<void> => {
    if (budget.spentRun() + held.microUsd >= budget.runMicroUsd) throw new BudgetReached("run");
    if ((await budget.spentDay()) + held.microUsd >= budget.dayMicroUsd) throw new BudgetReached("day");
    if (calls.made >= budget.maxCalls) throw new BudgetReached("calls");
    if (budget.costMissing()) throw new BudgetReached("cost_missing");
    calls.made += 1;
    held.microUsd += reserve;
  };
  return {
    async complete(request) {
      const admitted = held.admitted.then(admit);
      held.admitted = admitted.catch(() => {});
      await admitted;
      try {
        return await client.complete(request);
      } finally {
        held.microUsd -= reserve;
      }
    },
    embed: (request) => client.embed(request),
  };
}
