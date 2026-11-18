import { describe, expect, it } from "vitest";
import { commitOf, deployedCommit } from "./deployed-commit.ts";

describe("the deployed commit", () => {
  it("is the file's commit, whole or short, with the line break git writes", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect(commitOf(`${full}\n`)).toBe(full);
    expect(commitOf("0cf13e3")).toBe("0cf13e3");
  });

  it("is unknown with no file, and for anything that is not a commit", () => {
    for (const text of [null, "", "\n", "main", "0CF13E3", "0cf13e", `${"a".repeat(41)}`, "0cf13e3 dirty", "unknown"])
      expect(commitOf(text), String(text)).toBe("unknown");
  });

  it("answers a commit or unknown wherever it runs", () => {
    expect(deployedCommit()).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
  });
});
