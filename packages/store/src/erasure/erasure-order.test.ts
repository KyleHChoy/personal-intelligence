import { describe, expect, it } from "vitest";
import { ERASURE_HOOKS, ERASURE_ORDER } from "./erasure-hooks.ts";

// Invariant 10: each row of ERASURE_ORDER holds of the array that runs. The order's reasons are data, so
// a hook moved past what it needs fails here, by name, with the reason.

const faults = (names: readonly string[], order: typeof ERASURE_ORDER): string[] =>
  order.flatMap(({ first, next, why }) =>
    first
      .filter((name) => !names.includes(name) || !names.includes(next) || names.indexOf(name) >= names.indexOf(next))
      .map((name) => `${name} before ${next}: ${why}`),
  );

describe("the order of the erasure hooks", () => {
  it("the hooks run in the order the rows ask", () => {
    expect(
      faults(
        ERASURE_HOOKS.map((hook) => hook.name),
        ERASURE_ORDER,
      ),
    ).toEqual([]);
  });

  it("names each hook once", () => {
    const names = ERASURE_HOOKS.map((hook) => hook.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("vendor_exposures runs last", () => {
    expect(ERASURE_HOOKS.at(-1)?.name).toBe("vendor_exposures");
  });

  it("a hook moved before what it needs, or a row naming no hook, is a fault", () => {
    const row = [{ first: ["a"], next: "b", why: "because" }];
    expect(faults(["a", "b"], row)).toEqual([]);
    expect(faults(["b", "a"], row)).toEqual(["a before b: because"]);
    expect(faults(["b"], row)).toEqual(["a before b: because"]);
  });
});
