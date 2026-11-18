import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The kind registry, `ontology/kinds.json`, generated into the personal contracts as a constant, so
// the agent API, the web client and every package read the one registry without a file. Run `node
// tools/kinds/generate.ts` after changing the registry;

const root = join(import.meta.dirname, "..", "..");
export const REGISTRY = join(root, "ontology", "kinds.json");
export const GENERATED = join(root, "packages", "contracts", "src", "personal", "kinds.generated.ts");

export function generated(registry: string): string {
  const data: unknown = JSON.parse(registry);
  return [
    "// Generated from ontology/kinds.json by `node tools/kinds/generate.ts`: never edit by hand.",
    `export const KIND_REGISTRY_DATA = ${JSON.stringify(data, null, 2)} as const;`,
    "",
  ].join("\n");
}

if (import.meta.main) writeFileSync(GENERATED, generated(readFileSync(REGISTRY, "utf8")));
