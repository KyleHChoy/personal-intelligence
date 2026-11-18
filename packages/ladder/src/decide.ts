import type { DecisionPointCall } from "@intelligence/contracts/personal";
import { baseOf, end, type PointRef, resolve, start } from "./climb.ts";
import type { Registry } from "./registry.ts";
import type { Rung0 } from "./rung0.ts";

// One decision at one point, at its current version: `climb` with no runners. Rung 0 runs when the
// point has it; a model rung, with no runner, is passed over; what nothing below settles takes the
// point's fallback, or goes to the owner, rung 4, when the point has it. The input hash covers the
// facts alone, which hold no content.
export function decide<F>(registry: Registry, point: PointRef, facts: F, rung0: Rung0<F>): DecisionPointCall {
  const registered = resolve(registry, point);
  const base = baseOf(registered, facts);
  const early = start(registered, base, facts, rung0, false);
  return (early !== null && "call" in early ? early : end(registered, base, { thresholdIds: [], last: null })).call;
}
