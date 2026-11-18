import { describe, expect, it } from "vitest";
import { REASK_WINDOW, reaskStopped, reaskWorthAsking } from "./reask-stop.ts";

describe("the re-ask's stop rule", () => {
  it("stops a code only on a full window with no rescue", () => {
    expect(reaskStopped(undefined)).toBe(false);
    expect(reaskStopped({ asked: REASK_WINDOW - 1, rescued: 0 })).toBe(false);
    expect(reaskStopped({ asked: REASK_WINDOW, rescued: 1 })).toBe(false);
    expect(reaskStopped({ asked: REASK_WINDOW, rescued: 0 })).toBe(true);
  });

  it("asks an item again while any of its codes is not stopped", () => {
    const rates = [
      { code: "not_in_passage", asked: REASK_WINDOW, rescued: 0 },
      { code: "part_of_line", asked: REASK_WINDOW, rescued: 3 },
    ];
    expect(reaskWorthAsking(["not_in_passage"], rates)).toBe(false);
    expect(reaskWorthAsking(["not_in_passage", "part_of_line"], rates)).toBe(true);
    expect(reaskWorthAsking(["not_in_passage"], [])).toBe(true);
  });
});
