// The Personal Intelligence box runs its TypeScript by Node's type stripping (the `pi` launcher
// runs `node main.ts`), which refuses syntax that needs a transform: parameter properties, enums,
// namespaces with values, `import =`. The tests compile TypeScript in full, so such syntax passes
// every test and fails only on the box, at import, as one fixed `unavailable` line: a parameter
// property in the extraction lane's process-item.ts stopped every `pi extract` command on
// 2026-10-09. Every source file the box can load is held to strip-only mode here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
// Every source file the image holds.
const ROOTS = ["apps", "packages"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".slow-test.")
    )
      out.push(path);
  }
  return out;
}

const refused = (source: string): string | null => {
  try {
    stripTypeScriptTypes(source, { mode: "strip" });
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
};

describe("source the box loads is strip-only TypeScript", () => {
  it("no source file under apps/ or packages/ needs a transform", () => {
    const files = ROOTS.flatMap((one) => sources(join(root, one)));
    expect(files.length).toBeGreaterThan(500);
    const faults = files.flatMap((file) => {
      const code = refused(readFileSync(file, "utf8"));
      return code === null ? [] : [`${relative(root, file)}: ${code}`];
    });
    expect(faults).toEqual([]);
  });

  it("control: a parameter property and an enum are refused", () => {
    expect(refused("class A { constructor(readonly x: number) {} }")).toBe("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(refused("enum E { A }")).toBe("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(refused("class A { readonly x: number; constructor(x: number) { this.x = x; } }")).toBeNull();
  });
});
