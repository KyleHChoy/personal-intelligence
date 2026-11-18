import { describe, expect, it } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

const ENV = {
  PI_DATABASE_URL_ADMIN: "postgres://pi_admin:local-only@127.0.0.1:1/pi_test",
  PI_KEY_FILE: "/nonexistent/keys.json",
};
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

const pi = (argv: string[], stdin = "") => runPi(argv, ENV, { stdin: stdin === "" ? [] : [stdin] });
const usage = { exit: 2, stdout: "", stderr: `${JSON.stringify({ event: "command_failed", code: "usage" })}\n` };

// The first call imports the command's module, which takes seconds on a loaded machine.
describe("pia work task's arguments", { timeout: 60_000 }, () => {
  it("are usage errors for a missing or bad role or kind, a ref of no known form, or an empty note", async () => {
    const note = "Who runs the clinic now?";
    for (const [argv, stdin] of [
      [["work", "task", "--kind", "research"], note],
      [["work", "task", "--role", "Research", "--kind", "research"], note],
      [["work", "task", "--role", "research", "--kind", "follow_up"], note],
      [["work", "task", "--role", "research", "--kind", "research", "--about", `opp_${ULID}`], note],
      [["work", "task", "--role", "research", "--kind", "research", "--about", "ent_short"], note],
      [["work", "task", "--role", "research", "--kind", "research"], "   "],
      [["work", "task", "withdraw", "not-an-id"], ""],
      [["work", "task", "withdraw"], ""],
    ] as const) {
      expect(await pi([...argv], stdin), argv.join(" ")).toEqual(usage);
    }
  });

  it("passes every ref form and a note to the store (a missing key file here, after the parse)", async () => {
    const argv = [
      "work",
      "task",
      "--role",
      "research",
      "--kind",
      "research",
      "--about",
      `ent_${ULID}`,
      "--about",
      `gol_${ULID}`,
      "--about",
      `msg_${ULID}`,
      "--about",
      "a".repeat(64),
    ];
    const result = await pi(argv, "Who runs the clinic now?\n");
    expect(result.exit).not.toBe(0);
    expect(result.stderr).not.toBe(usage.stderr);
    expect((await pi(["work", "task", "withdraw", `opp_${ULID}`])).stderr).not.toBe(usage.stderr);
  });
});
