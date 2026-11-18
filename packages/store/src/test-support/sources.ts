// The store's own source files, for the tests that check what the code says. A file is found by
// its bare name in whichever folder holds it, so a test does not depend on the folder layout.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const SRC = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "test-support"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const PATHS = new Map(walk(SRC).map((path) => [basename(path), path]));

// Every TypeScript file's bare name, tests included, sorted.
export const storeFiles = (): string[] => [...PATHS.keys()].sort();

// A file's full path, by its bare name; a name no file has is an error.
export function storePath(name: string): string {
  const path = PATHS.get(name);
  if (path === undefined) throw new Error(`no store source named ${name}`);
  return path;
}

export const storeText = (name: string): string => readFileSync(storePath(name), "utf8");
