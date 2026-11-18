import { expect, it, vi } from "vitest";
import { EXTRACT } from "./commands-extract.ts";
import { refusal } from "./env.ts";
import { MODEL, PIPELINE, pi, REAL, useRealKeyFile } from "./test-support/commands-fixtures.ts";

useRealKeyFile();

it("a missing capture key does not instruct a pipeline process to load restricted keys", async () => {
  const body = vi.spyOn(EXTRACT.extract!, "body").mockRejectedValue(refusal("keys_missing"));
  try {
    const result = await pi(["extract"], { ...PIPELINE, ...REAL, ...MODEL });
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("the capture item's compartment key is unavailable to this process");
    expect(result.stderr).not.toContain("PI_RESTRICTED_KEY_FILE");
  } finally {
    body.mockRestore();
  }
});
