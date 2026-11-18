import { join, relative, sep } from "node:path";
import { expect } from "vitest";

// A test file of a Personal Intelligence package or app treats each name under a documentation
// domain (quarry.example.org, harbor.example.org) as its own organization, as the synthetic data
// needs, where production would fold them into one, example.org (fold-setup.ts says why). The
// shared libraries' tests never load personal code.
const PERSONAL = new Set([
  "apps/pi",
  "apps/reasoner",
  "apps/web",
  "packages/beliefs",
  "packages/core",
  "packages/extract",
  "packages/google",
  "packages/ladder",
  "packages/mcp",
  "packages/models",
  "packages/store",
]);
const file = expect.getState().testPath;
if (
  file !== undefined &&
  PERSONAL.has(
    relative(join(import.meta.dirname, ".."), file)
      .split(sep)
      .slice(0, 2)
      .join("/"),
  )
) {
  await import("../packages/core/src/test-support/fold-setup.ts");
}
