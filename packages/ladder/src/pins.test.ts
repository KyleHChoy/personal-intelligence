import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POINT_PINS_FILE, pinHistory, pointPinsSource } from "./pins.ts";

describe("the pinned point history", () => {
  it("is the generator's output: every pin kept, every point version and its thresholds pinned", () => {
    expect(readFileSync(POINT_PINS_FILE, "utf8")).toBe(pointPinsSource());
  });
});

describe("pinHistory", () => {
  it.each([
    [
      "adds a new version after the history",
      { "a@1": "1" },
      [
        ["a@1", "1"],
        ["a@2", "2"],
      ],
      [
        ["a@1", "1"],
        ["a@2", "2"],
      ],
    ],
    ["keeps a pin nothing in code has", { "a@1": "1" }, [], [["a@1", "1"]]],
  ] as const)("%s", (_name, pinned, code, expected) => {
    expect(pinHistory(pinned, new Map(code))).toEqual(expected);
  });

  it("refuses a value that moved under its pin", () => {
    expect(() => pinHistory({ "a@1": "1" }, new Map([["a@1", "2"]]))).toThrow("a@1");
  });
});
