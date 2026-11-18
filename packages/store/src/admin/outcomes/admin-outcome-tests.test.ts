import { describe, expect, it } from "vitest";
import { heldOutFellTwice } from "./admin-outcome-tests.ts";

// The means are the complete runs', newest first; a run with no held-out score breaks the run of falls.

describe("the held-out drop needs two falls in a row", () => {
  it("one fall files nothing", () => {
    expect(heldOutFellTwice([1.5, 2])).toBe(false);
    expect(heldOutFellTwice([1.5, 2, 1])).toBe(false);
  });

  it("two falls in a row file", () => {
    expect(heldOutFellTwice([1, 1.5, 2])).toBe(true);
    expect(heldOutFellTwice([1, 1.5, 2, 0.5])).toBe(true);
  });

  it("a fall, a hold, then a fall files nothing", () => {
    expect(heldOutFellTwice([1, 1.5, 1.5])).toBe(false);
    expect(heldOutFellTwice([1, 1, 2])).toBe(false);
  });

  it("too few runs, or a run with no held-out mean, files nothing", () => {
    expect(heldOutFellTwice([])).toBe(false);
    expect(heldOutFellTwice([1])).toBe(false);
    expect(heldOutFellTwice([1, null, 2])).toBe(false);
    expect(heldOutFellTwice([null, 1.5, 2])).toBe(false);
  });
});
