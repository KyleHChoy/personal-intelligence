import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATED, generated, REGISTRY } from "./generate.ts";

// The contracts' copy of the kind registry is ontology/kinds.json,
// regenerated; run `node tools/kinds/generate.ts` after changing the registry.
describe("the kind registry's generated constant", () => {
  it("is the registry's file, regenerated", () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(generated(readFileSync(REGISTRY, "utf8")));
  });
});
