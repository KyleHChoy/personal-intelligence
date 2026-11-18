import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The import fence. pnpm only lets a package import what its package.json lists, so checking the
// package.json files, transitively, checks what code can reach. packages/contracts reaches nothing
// in this repository, and a package that zones.json lists as running an agent loop reaches no
// database or decryption code.

const root = join(import.meta.dirname, "..", "..");
const NS = "@intelligence/";

type Manifest = { name: string; dependencies?: Record<string, string> };

const FOLDERS = ["packages", "apps"] as const;
const all = new Map<string, Manifest>();
const folderOf = new Map<string, (typeof FOLDERS)[number]>();
for (const folder of FOLDERS) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(root, folder, entry.name, "package.json"), "utf8")) as Manifest;
    all.set(manifest.name, manifest);
    folderOf.set(manifest.name, folder);
  }
}

function reachable(name: string, seen = new Set<string>()): Set<string> {
  const manifest = all.get(name);
  if (!manifest) throw new Error(`unknown workspace package ${name}`);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith(NS) || seen.has(dep)) continue;
    seen.add(dep);
    reachable(dep, seen);
  }
  return seen;
}

// Database and decryption code: a package that lists the Postgres driver, which the store, its
// sealing included, does.
const dataCode = (name: string): boolean => Object.hasOwn(all.get(name)?.dependencies ?? {}, "pg");

const { agentLoops } = JSON.parse(readFileSync(join(root, "zones.json"), "utf8")) as { agentLoops: string[] };

describe("import fence", () => {
  it("packages/contracts depends on nothing in this repository", () => {
    expect(reachable(`${NS}contracts`).size).toBe(0);
  });

  it("every workspace dependency exists", () => {
    for (const manifest of all.values()) {
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (dep.startsWith(NS)) expect(all.has(dep), `${manifest.name} -> ${dep}`).toBe(true);
      }
    }
  });

  it("the store is database code, so the agent-loop rule below has something to keep out", () => {
    expect(dataCode(`${NS}personal-store`)).toBe(true);
  });
});

describe("agent loops", () => {
  it("a process that runs an agent loop cannot reach database or decryption code", () => {
    expect(agentLoops).toContain(`${NS}personal-reasoner`);
    for (const name of agentLoops) {
      expect(all.has(name), name).toBe(true);
      expect(dataCode(name), name).toBe(false);
      for (const dep of reachable(name)) expect(dataCode(dep), `${name} -> ${dep}`).toBe(false);
    }
  });

  it("only personal code and the personal contracts import @intelligence/contracts/personal", () => {
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      if (!existsSync(join(root, dir))) return;
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        if (entry.isDirectory()) scan(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          readFileSync(join(root, path), "utf8").includes("@intelligence/contracts/personal")
        )
          offenders.push(path);
      }
    };
    for (const dir of ["packages/contracts", "tools"]) scan(dir);
    expect(offenders.filter((path) => !path.startsWith("packages/contracts/src/personal/"))).toEqual([]);
  });
});
