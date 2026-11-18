import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPrompt, modelArgument, readKey, refusedArguments, withEffort } from "./check-prompt.ts";

// The prompt check's own rules, with no database: where the key comes from, and that nothing is
// printed but to a terminal. Its run against a database, with a recorded model, is
// check-prompt.db.test.ts. No key here is real: each is a placeholder word.

const SCRIPT = fileURLToPath(new URL("./check-prompt.ts", import.meta.url));
const PLACEHOLDER = "placeholder-not-a-key";

function script(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.end(`${PLACEHOLDER}\n`);
  });
}
const failed = (code: string): string => `${JSON.stringify({ event: "check_failed", code })}\n`;

describe("the prompt check", () => {
  it("the key is read from standard input, and the script refuses a key in an argument or in the environment", async () => {
    expect(await readKey(Readable.from([`${PLACEHOLDER}\nmore`]))).toBe(PLACEHOLDER);
    expect(await readKey(Readable.from(["  ", `${PLACEHOLDER}\r\n`]))).toBe(PLACEHOLDER);
    await expect(readKey(Readable.from(["\n"]))).rejects.toMatchObject({ code: "no_key" });
    await expect(readKey(Readable.from([]))).rejects.toMatchObject({ code: "no_key" });

    expect(refusedArguments(["vendor/model-1"], {})).toBeNull();
    expect(refusedArguments(["vendor/model-1", "other-vendor/model-2"], {})).toBeNull();
    expect(refusedArguments(["vendor/model-1", PLACEHOLDER], {})).toBe("key_in_argument");
    expect(refusedArguments([PLACEHOLDER, "vendor/model-1"], {})).toBe("key_in_argument");
    expect(refusedArguments(["vendor/model-1", "vendor/model-2", "vendor/model-3"], {})).toBe("key_in_argument");
    expect(refusedArguments([PLACEHOLDER], {})).toBe("usage");
    expect(refusedArguments([], {})).toBe("usage");
    for (const name of ["PI_REASONER_MODEL_KEY", "PI_OPENROUTER_KEY", "OPENROUTER_API_KEY"]) {
      expect(refusedArguments(["vendor/model-1"], { [name]: PLACEHOLDER }), name).toBe("key_in_environment");
      expect(refusedArguments(["vendor/model-1"], { [name]: "" }), name).toBeNull();
    }

    // The real script, before anything is built.
    expect(await script(["vendor/model-1", PLACEHOLDER])).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("key_in_argument"),
    });
    expect(await script(["vendor/model-1"], { PI_REASONER_MODEL_KEY: PLACEHOLDER })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("key_in_environment"),
    });
    expect(await script([])).toEqual({ exit: 2, stdout: "", stderr: failed("usage") });
  }, 60_000);

  it("a model id may end in @low, @medium or @high; one with none takes PI_REASONER_REASONING_EFFORT; any other effort is refused", async () => {
    expect(refusedArguments(["vendor/model-1@high"], {})).toBeNull();
    expect(refusedArguments(["vendor/model-1@low", "vendor/model-1@high"], {})).toBeNull();
    expect(refusedArguments(["vendor/model-1@max"], {})).toBe("usage");
    expect(refusedArguments(["vendor/model-1@low", "vendor/model-1@max"], {})).toBe("key_in_argument");
    expect(refusedArguments(["vendor/model-1"], { PI_REASONER_REASONING_EFFORT: "medium" })).toBeNull();
    expect(refusedArguments(["vendor/model-1"], { PI_REASONER_REASONING_EFFORT: "max" })).toBe("bad_env");
    expect(modelArgument("vendor/model-1:free@medium")).toEqual({ model: "vendor/model-1:free", effort: "medium" });
    expect(modelArgument("vendor/model-1")).toEqual({ model: "vendor/model-1" });
    expect(withEffort(["vendor/model-1", "vendor/model-2@low"], { PI_REASONER_REASONING_EFFORT: "high" })).toEqual([
      "vendor/model-1@high",
      "vendor/model-2@low",
    ]);
    expect(withEffort(["vendor/model-1"], {})).toEqual(["vendor/model-1"]);
    expect(await script(["vendor/model-1"], { PI_REASONER_REASONING_EFFORT: "max" })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("bad_env"),
    });
  }, 60_000);

  it("it prints nothing when its output is not a terminal", async () => {
    const written: string[] = [];
    const out = new Writable({
      write(chunk: Buffer, _encoding, done) {
        written.push(chunk.toString("utf8"));
        done();
      },
    });
    let asked = 0;
    const result = await checkPrompt({
      modelIds: ["vendor/model-1"],
      readKey: async () => {
        asked += 1;
        return PLACEHOLDER;
      },
      out,
    });
    expect(result).toEqual({ code: "not_a_terminal" });
    expect(written).toEqual([]);
    expect(asked).toBe(0);

    // The real script, its output a pipe: refused before the key is asked for.
    expect(await script(["vendor/model-1"])).toEqual({ exit: 1, stdout: "", stderr: failed("not_a_terminal") });
  }, 60_000);
});
