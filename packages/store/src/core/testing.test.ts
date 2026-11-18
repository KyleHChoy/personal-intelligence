import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeKey, keptPlan, REUSE_MS, sweepable } from "../test-support/database.ts";

// The test helpers' choices that need no database: what the sweep drops, which kept state is
// reused or dropped, and the key of the code that builds one.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const t = (ago: number): string => (NOW - ago).toString(36);

describe("sweepable", () => {
  it("drops a generated name over an hour old, and a test's copy named after one", () => {
    expect(sweepable(`pi_test_${t(2 * HOUR)}_4242_0a1b2c3d`, NOW)).toBe(true);
    // contacts-gate's restored backup, and a copy of a copy.
    expect(sweepable(`pi_test_${t(2 * HOUR)}_4242_0a1b2c3d_n1`, NOW)).toBe(true);
    expect(sweepable(`pi_test_${t(2 * HOUR)}_4242_0a1b2c3d_c2_l3`, NOW)).toBe(true);
  });

  it("leaves a fresh one, and a name it did not make", () => {
    expect(sweepable(`pi_test_${t(HOUR / 2)}_4242_0a1b2c3d`, NOW)).toBe(false);
    expect(sweepable(`pi_test_${t(HOUR / 2)}_4242_0a1b2c3d_n1`, NOW)).toBe(false);
    expect(sweepable("pi_test_data", NOW)).toBe(false);
    expect(sweepable(`pi_test_${t(2 * HOUR)}_4242_0a1b2c3`, NOW)).toBe(false);
    expect(sweepable(`pi_test_${t(2 * HOUR)}_4242_0a1b2c3d_N1`, NOW)).toBe(false);
    expect(sweepable(`pi_tpl_${t(2 * HOUR)}_0123456789abcdef`, NOW)).toBe(false);
  });
});

describe("keptPlan", () => {
  const KEY = "0123456789abcdef";
  const OTHER = "fedcba9876543210";
  const name = (ago: number, key = KEY, label = "aaaaaaaa"): string => `pi_syn_${t(ago)}_${key}_${label}`;

  it("reuses the youngest state of the key and label built within REUSE_MS", () => {
    const young = name(60_000);
    expect(
      keptPlan([name(REUSE_MS / 2), young, name(60_000, OTHER), name(60_000, KEY, "bbbbbbbb")], KEY, "aaaaaaaa", NOW),
    ).toEqual({ reuse: young, drop: [] });
  });

  it("builds again after REUSE_MS, and drops the old state only after twice that", () => {
    expect(keptPlan([name(REUSE_MS + 1_000)], KEY, "aaaaaaaa", NOW)).toEqual({ drop: [] });
    expect(keptPlan([name(2 * REUSE_MS + 1_000)], KEY, "aaaaaaaa", NOW)).toEqual({
      drop: [name(2 * REUSE_MS + 1_000)],
    });
  });

  it("drops another key's or label's state over an hour old, and keeps a younger one", () => {
    const old = [name(HOUR + 1_000, OTHER), name(HOUR + 1_000, KEY, "bbbbbbbb")];
    const young = [name(HOUR - 1_000, OTHER), name(HOUR - 1_000, KEY, "bbbbbbbb")];
    expect(keptPlan([...old, ...young], KEY, "aaaaaaaa", NOW)).toEqual({ drop: old });
  });

  it("passes over a name of any other shape", () => {
    expect(
      keptPlan(
        ["pi_syn_x", `pi_wld_${t(2 * HOUR)}_${KEY}_base`, `pi_test_${t(2 * HOUR)}_1_0a1b2c3d`],
        KEY,
        "aaaaaaaa",
        NOW,
      ),
    ).toEqual({ drop: [] });
  });
});

describe("codeKey", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const tree = async (): Promise<string> => {
    root = await mkdtemp(join(tmpdir(), "pi-code-key-"));
    for (const dir of ["a/src", "a/node_modules/dep", "b"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "a/src/sync.ts"), "export const sync = 1;\n");
    await writeFile(join(root, "a/src/sync.test.ts"), "it('syncs');\n");
    await writeFile(join(root, "a/src/README.md"), "# a\n");
    await writeFile(join(root, "a/node_modules/dep/index.js"), "module.exports = 1;\n");
    await writeFile(join(root, "b/world.ts"), "export const world = 1;\n");
    return root;
  };

  it("changes with a source file's bytes, a new source file, and a renamed one", async () => {
    const at = await tree();
    const before = await codeKey(at, ["a", "b"]);
    expect(await codeKey(at, ["a", "b"])).toBe(before);
    await writeFile(join(at, "b/world.ts"), "export const world = 2;\n");
    const changed = await codeKey(at, ["a", "b"]);
    expect(changed).not.toBe(before);
    await writeFile(join(at, "a/src/fixtures.ts"), "export {};\n");
    const added = await codeKey(at, ["a", "b"]);
    expect(added).not.toBe(changed);
    await rm(join(at, "a/src/fixtures.ts"));
    await writeFile(join(at, "a/src/fixture.ts"), "export {};\n");
    expect(await codeKey(at, ["a", "b"])).not.toBe(added);
  });

  it("does not change with a test, a doc or an installed dependency", async () => {
    const at = await tree();
    const before = await codeKey(at, ["a", "b"]);
    await writeFile(join(at, "a/src/sync.test.ts"), "it('syncs again');\n");
    await writeFile(join(at, "a/src/README.md"), "# a, again\n");
    await writeFile(join(at, "a/node_modules/dep/index.js"), "module.exports = 2;\n");
    expect(await codeKey(at, ["a", "b"])).toBe(before);
    // The positive control: the directories it was given are what it reads.
    expect(await codeKey(at, ["a"])).not.toBe(before);
  });
});
