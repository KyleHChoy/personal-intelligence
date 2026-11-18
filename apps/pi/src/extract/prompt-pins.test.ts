import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROMPT_PINS_FILE, promptPinsSource } from "./prompt-pins.ts";

describe("the pinned prompt history", () => {
  it("is the generator's output: every pin kept, every prompt in code pinned to its text", () => {
    expect(readFileSync(PROMPT_PINS_FILE, "utf8")).toBe(promptPinsSource());
  });
});
