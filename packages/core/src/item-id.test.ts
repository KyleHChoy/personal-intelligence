import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gmailItemId, parseGmailItemId } from "./item-id.ts";
import { repoRoot } from "./repo-root.ts";

// The one function for a Gmail message's source item id. Made-up ids.
const PACKAGES = join(repoRoot(), "packages/");

// Every source file under packages/*/src, fixtures included, tests left out.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("gmailItemId", () => {
  it("gmailItemId gives gmail-id:<id>", () => {
    expect(gmailItemId("18c0ffee01")).toBe("gmail-id:18c0ffee01");
  });

  it("parseGmailItemId inverts gmailItemId and is null for another form", () => {
    expect(parseGmailItemId(gmailItemId("18c0ffee01"))).toBe("18c0ffee01");
    for (const other of [
      "18c0ffee01",
      "gmail-id:",
      "gcal-id:18c0ffee01",
      " gmail-id:18c0ffee01",
      "GMAIL-ID:18c0ffee01",
    ])
      expect(parseGmailItemId(other), other).toBeNull();
  });

  it("no source file but item-id.ts builds the string gmail-id:", () => {
    const files = readdirSync(PACKAGES).flatMap((pkg) => {
      const src = join(PACKAGES, pkg, "src");
      try {
        return statSync(src).isDirectory() ? sources(src) : [];
      } catch {
        return [];
      }
    });
    expect(files.some((file) => file.endsWith(join("core", "src", "item-id.ts")))).toBe(true);
    const building = files.filter(
      (file) =>
        !file.endsWith(join("core", "src", "item-id.ts")) &&
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => line.includes("gmail-id:") && !line.trimStart().startsWith("//")),
    );
    expect(building).toEqual([]);
  });
});
