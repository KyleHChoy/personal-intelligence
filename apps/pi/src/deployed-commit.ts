import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeployedCommit } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";

// The commit this code was deployed at, so an agent can tell what the box runs without a shell on
// it. The deploy writes `git rev-parse HEAD` to deploy/COMMIT before the source is sent, and the
// image copies the whole repository, the file with it. The file is never committed: a commit cannot
// hold its own name, and tests/structure/personal-switches.test.ts fails on a tracked one. Without
// it, in a checkout or an image built another way, or when it holds anything but a commit, the
// answer is `unknown`, never a guess.
export const COMMIT_FILE = "deploy/COMMIT";

export function commitOf(text: string | null): DeployedCommit {
  const parsed = DeployedCommit.safeParse(text?.trim());
  return parsed.success ? parsed.data : "unknown";
}

let held: DeployedCommit | undefined;
export function deployedCommit(): DeployedCommit {
  if (held !== undefined) return held;
  let text: string | null = null;
  try {
    text = readFileSync(join(repoRoot(), COMMIT_FILE), "utf8");
  } catch {
    // No file: unknown.
  }
  return (held = commitOf(text));
}
