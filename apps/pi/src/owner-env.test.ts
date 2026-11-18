import { describe, expect, it } from "vitest";
import { pi } from "./test-support/run-pi.ts";

// The owner surface's environment rule and its command rows. Hand-written values: a closed port and
// a key file that does not exist, so nothing here could connect.

const url = (role: string): string => `postgres://${role}:local-only@127.0.0.1:1/pi_test`;
const ADMIN = { PI_DATABASE_URL_ADMIN: url("pi_admin") };
const READER = { PI_DATABASE_URL_READER: url("pi_reader") };
const KEYS = { PI_KEY_FILE: "/nonexistent/pi/keys.json" };
const TOKEN = { PI_CLIENT_TOKEN: `pit_${"a".repeat(43)}` };

// The code of the run's one command_failed line.
const failedWith = (stderr: string): string | undefined =>
  stderr
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { event: string; code?: string })
    .find((line) => line.event === "command_failed")?.code;

describe("the owner commands' environment", () => {
  it("an owner command refuses a client token", async () => {
    for (const argv of [
      ["status"],
      ["veto", "list"],
      ["erase", "list"],
      ["decide", `crd_${"0".repeat(26)}`, "--answer", "acknowledge"],
    ]) {
      const refused = await pi(argv, { ...ADMIN, ...KEYS, ...TOKEN });
      expect(refused.exit, argv.join(" ")).toBe(1);
      expect(failedWith(refused.stderr), argv.join(" ")).toBe("wrong_role_url");
      // An empty token is an unset one.
      const empty = await pi(argv, { ...ADMIN, ...KEYS, PI_CLIENT_TOKEN: "" });
      expect(failedWith(empty.stderr), argv.join(" ")).not.toBe("wrong_role_url");
    }
    // The reader's command takes the same token: it gets past the check, to the key file.
    const mcp = await pi(["mcp"], { ...READER, ...KEYS, ...TOKEN });
    expect(failedWith(mcp.stderr)).not.toBe("wrong_role_url");
  });

  it("--help lists every new command", async () => {
    const result = await pi(["--help"], {});
    expect(result.exit).toBe(0);
    const lines = result.stdout.split("\n");
    for (const command of [
      "pi review",
      "pi show",
      "pi decide",
      "pi veto add",
      "pi veto list",
      "pi veto lift",
      "pi erase item",
      "pi erase person",
      "pi erase list",
      "pi erase lift",
      "pi erase replay",
    ]) {
      expect(
        lines.filter((line) => line === command || line.startsWith(`${command} `)),
        command,
      ).toHaveLength(1);
    }
  });

  it("decide takes one to 25 cards, and no other number", async () => {
    const card = (n: number): string => `crd_${n.toString().padStart(26, "0")}`;
    const cards = (count: number): string[] => Array.from({ length: count }, (_, n) => card(n));
    for (const count of [0, 26])
      expect(
        (await pi(["decide", ...cards(count), "--answer", "acknowledge"], { ...ADMIN, ...KEYS })).exit,
        String(count),
      ).toBe(2);
    // Inside the range the arguments parse, and the run goes on to the key file.
    for (const count of [1, 25])
      expect(
        failedWith((await pi(["decide", ...cards(count), "--answer", "acknowledge"], { ...ADMIN, ...KEYS })).stderr),
        String(count),
      ).not.toBe("usage");
  });
});
