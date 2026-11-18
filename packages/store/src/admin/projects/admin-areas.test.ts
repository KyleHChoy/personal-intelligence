import { describe, expect, it } from "vitest";
import { reordered } from "./admin-areas.ts";

describe("the owner's order of the areas", () => {
  const present = ["field-work", "back-office", "old-yard", "study"];

  it("the keys named come first, as named, and the rest keep their order", () => {
    expect(reordered(present, ["study"])).toEqual(["study", "field-work", "back-office", "old-yard"]);
    expect(reordered(present, ["old-yard", "field-work"])).toEqual(["old-yard", "field-work", "back-office", "study"]);
    expect(reordered(present, [...present].reverse())).toEqual([...present].reverse());
    expect(reordered(present, [])).toEqual(present);
  });

  it("a key named twice, or one that is no area, gives no order", () => {
    expect(reordered(present, ["study", "study"])).toBeNull();
    expect(reordered(present, ["study", "no-such"])).toBeNull();
    expect(reordered([], ["study"])).toBeNull();
  });
});
