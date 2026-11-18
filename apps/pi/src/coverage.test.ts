import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coverageOptionsOf } from "./command-args.ts";
import { coverageSilentLine } from "./owner.ts";
import { failed, pi } from "./test-support/run-pi.ts";

// A closed port, so a positive control ends as `unavailable`.

const ADMIN = { PI_DATABASE_URL_ADMIN: "postgres://pi_admin:local-only@127.0.0.1:1/pi_test" };
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

const lastCode = (stderr: string): unknown =>
  (
    JSON.parse(
      stderr
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .at(-1) ?? "{}",
    ) as { code?: string }
  ).code;

let folder = "";
const env: Record<string, string> = { ...ADMIN };
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "pi-coverage-test-"));
  env.PI_KEY_FILE = join(folder, "keys.json");
  expect(await pi(["keys", "init", "--compartments", "own"], { PI_KEY_FILE: env.PI_KEY_FILE })).toEqual({
    exit: 0,
    stdout: "",
    stderr: "",
  });
});
afterAll(() => rm(folder, { recursive: true, force: true }));

describe("pia status --coverage's options", () => {
  it("are none without --coverage, and 7 days without --days", () => {
    expect(coverageOptionsOf({})).toBeNull();
    expect(coverageOptionsOf({ storage: true })).toBeNull();
    expect(coverageOptionsOf({ coverage: true })).toEqual({ days: 7, record: false });
    expect(coverageOptionsOf({ coverage: true, days: "1" })).toEqual({ days: 1, record: false });
    expect(coverageOptionsOf({ coverage: true, days: "90", record: true })).toEqual({ days: 90, record: true });
  });

  it("--days or --record without --coverage, --coverage with --storage, and --days outside 1 to 90 are usage errors before any connection", async () => {
    for (const argv of [
      ["status", "--days", "3"],
      ["status", "--record"],
      ["status", "--storage", "--record"],
      ["status", "--coverage", "--storage"],
      ...["0", "91", "07", "", "1.5", "-1", "seven"].map((days) => ["status", "--coverage", "--days", days]),
    ]) {
      expect(await pi(argv, env), argv.join(" ")).toEqual({ exit: 2, stdout: "", stderr: failed("usage") });
    }
    // The positive controls: each parses and reaches the closed port.
    for (const argv of [
      ["status", "--coverage"],
      ["status", "--coverage", "--days", "1"],
      ["status", "--coverage", "--days", "90", "--record"],
      ["status", "--coverage", "--record"],
    ]) {
      const result = await pi(argv, env);
      expect({ exit: result.exit, stdout: result.stdout }, argv.join(" ")).toEqual({ exit: 1, stdout: "" });
      expect(lastCode(result.stderr), argv.join(" ")).toBe("unavailable");
    }
  });
});

describe("the coverage_silent line", () => {
  it("is one fixed line of the row's kind and id and its rule's code, ids and a code only", () => {
    expect(
      coverageSilentLine({
        kind: "account",
        id: `acc_${ULID}`,
        state: "silent",
        code: "added_not_decided",
        counts: { added: 3, decided: 0 },
      }),
    ).toBe(`{"event":"coverage_silent","ids":{"account":"acc_${ULID}"},"code":"added_not_decided"}`);
    expect(
      coverageSilentLine({
        kind: "capture_class",
        id: `cli_${ULID}:moment`,
        state: "silent",
        code: "class_quiet",
        counts: {},
      }),
    ).toBe(`{"event":"coverage_silent","ids":{"capture_class":"cli_${ULID}:moment"},"code":"class_quiet"}`);
    expect(
      coverageSilentLine({ kind: "job", id: "sync", state: "silent", code: "sync_gap", counts: { gap_minutes: 45 } }),
    ).toBe(`{"event":"coverage_silent","ids":{"job":"sync"},"code":"sync_gap"}`);
  });
});
