import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The folder that holds `pnpm-workspace.yaml`: the repository in a checkout, `/opt/intelligence`
// in the box's image. Files at the root (the ontology, the migrations, the documents) are found
// from here, so no path depends on how deep its reader sits.
let found: string | undefined;

export function repoRoot(): string {
  if (found !== undefined) return found;
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return (found = dir);
    if (dirname(dir) === dir) throw new Error("no pnpm-workspace.yaml above the code");
  }
}

// A file at the repository's root, read and parsed on first use and kept. So a rule that reads the
// ontology names the file it depends on, and on the box needs it in the image, which copies the whole
// repository.
export function repoFile<T>(path: string, parse: (text: string) => T): () => T {
  let held: T | undefined;
  return () => (held ??= parse(readFileSync(join(repoRoot(), path), "utf8")));
}
