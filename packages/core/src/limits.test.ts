import { describe, expect, it } from "vitest";
import { LIMITS } from "./claim-pipeline/limits.ts";
import { EXTRACTOR_GENERATION, PERSONAL_LIMITS } from "./limits.ts";

describe("the personal constants", () => {
  it("the personal limits are the shared ones with a message block's payload", () => {
    expect(PERSONAL_LIMITS).toEqual({ ...LIMITS, payloadBytes: 6 * 1024 * 1024, payloadLines: 100_000 });
    expect(PERSONAL_LIMITS.payloadBytes).toBeLessThan(LIMITS.payloadBytes);
    // A block of that many bytes, in base64 lines of 76 characters and their CRLF, is inside the lines.
    expect(Math.ceil(PERSONAL_LIMITS.payloadBytes / 78)).toBeLessThan(PERSONAL_LIMITS.payloadLines);
  });

  it("the extractor generation is 0", () => {
    expect(EXTRACTOR_GENERATION).toBe(0);
  });
});
