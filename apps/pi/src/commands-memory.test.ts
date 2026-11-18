// Covers commands.ts, the `pi` command line, through the commands of one area.
// Memory, erasing, held messages, project anchors and inspect.
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  ENTITY,
  expectRefused,
  expectUnavailable,
  KEYS,
  MESSAGE,
  pi,
  REAL,
  useRealKeyFile,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  // The two memory commands.
  it("memory status and memory exposures take a client name and a limit of 1 to 500, and anything else is a usage error", async () => {
    for (const argv of [
      ["memory", "status", "--client", "Not A Name"],
      ["memory", "status", "mine"],
      ["memory", "status", "--limit", "5"],
      ["memory", "exposures", "--limit", "0"],
      ["memory", "exposures", "--limit", "501"],
      ["memory", "exposures", "--limit", "ten"],
      ["memory", "exposures", "--limit", "1.5"],
      ["memory", "exposures", "--client", ""],
      ["memory", "exposures", "extra"],
      ["memory", "show"],
    ]) {
      // Before any connection: the closed port is never reached, with a real key file too.
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls go on to the database.
    await expectUnavailable(["memory", "exposures", "--limit", "1"], { ...ADMIN, ...REAL });
    await expectUnavailable(["memory", "status", "--client", "mine"], { ...ADMIN, ...REAL });
  });

  // Erasing exposures.
  it("erase exposures takes one erasure id and exposures status none, and anything else is a usage error", async () => {
    for (const argv of [
      ["erase", "exposures"],
      ["erase", "exposures", "msg_not-an-erasure"],
      ["erase", "exposures", "ers_x", "ers_y"],
      ["exposures", "status", "extra"],
      ["exposures", "list"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    await expectUnavailable(["erase", "exposures", `ers_${"0".repeat(26)}`], { ...ADMIN, ...REAL });
    await expectUnavailable(["exposures", "status"], { ...ADMIN, ...REAL });
  });

  // Lens.
  it("erase settle takes an optional limit of a whole number and no positional, erase item takes a cap_ id, and anything else is a usage error", async () => {
    for (const argv of [
      ["erase", "settle", "--limit", "ten"],
      ["erase", "settle", "--limit", "1.5"],
      ["erase", "settle", "extra"],
      ["erase", "item", "cap_not-a-capture"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls go on to the database.
    await expectUnavailable(["erase", "settle"], { ...ADMIN, ...REAL });
    await expectUnavailable(["erase", "settle", "--limit", "50"], { ...ADMIN, ...REAL });
    await expectUnavailable(["erase", "item", `cap_${"0".repeat(26)}`], { ...ADMIN, ...REAL });
  });

  it("each memory command refuses a client token in its environment", async () => {
    for (const argv of [
      ["memory", "status"],
      ["memory", "exposures"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...KEYS, PI_CLIENT_TOKEN: `pit_${"a".repeat(43)}` }, "wrong_role_url");
      // The control: without it the same command goes on to the database.
      await expectUnavailable(argv, { ...ADMIN, ...REAL });
    }
  });

  it("messages release with an id and an age together, with neither, or with an age that is not digits and d is a usage error", async () => {
    for (const argv of [
      ["messages", "release", MESSAGE, "--older-than", "7d"],
      ["messages", "release"],
      ["messages", "release", "--older-than", "7"],
      ["messages", "release", "--older-than", "seven"],
      ["messages", "release", "--older-than", "7days"],
      ["messages", "release", "--older-than", "-7d"],
      ["messages", "release", "--older-than", "0d"],
      ["messages", "release", MESSAGE, "another"],
      ["messages", "held", "extra"],
    ]) {
      // Before any connection: the closed port is never reached, with a real key file too.
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls: an age of digits and d, and an id alone, pass the check and go on
    // to the database; so does the list.
    await expectUnavailable(["messages", "release", "--older-than", "7d"], { ...ADMIN, ...REAL });
    await expectUnavailable(["messages", "release", MESSAGE], { ...ADMIN, ...REAL });
    await expectUnavailable(["messages", "held"], { ...ADMIN, ...REAL });
  });

  it("project anchor refuses a device value core refuses, and a --document the shell expanded, before the key file or any connection", async () => {
    const anchor = (...flags: string[]) => ["project", "anchor", ENTITY, ...flags];
    // A key file that is not there: none of these reads it.
    for (const [flags, code] of [
      [["--host", "github.com"], "generic_anchor"],
      [["--app", "com.google.Chrome"], "generic_anchor"],
      [["--document", "~/Documents"], "generic_anchor"],
      [["--host", "192.0.2.10"], "bad_anchor"],
      [["--url", "ftp://plans.example.com/a"], "bad_anchor"],
    ] as const) {
      await expectRefused(anchor(...flags), { ...ADMIN, ...KEYS }, code);
    }
    // `--document ~/test/alpha` unquoted reaches pi expanded: under the caller's $HOME, or any
    // /Users/NAME or /home/NAME, it is a usage error with the hint to quote it.
    const hint = "quote the path so the shell leaves ~ alone: --document '~/PATH'";
    for (const [path, env] of [
      ["/srv/owner/test/alpha", { HOME: "/srv/owner" }],
      ["/Users/someone/test/alpha", {}],
      ["/home/someone/test/alpha", {}],
    ] as const) {
      await expectRefused(anchor("--document", path), { ...ADMIN, ...KEYS, ...env }, "usage", 2, { hint });
    }
    // The positive controls go on to the closed port: a quoted `~/` path, a path outside any
    // home, and a host that is no product.
    for (const flags of [
      ["--document", "~/test/alpha"],
      ["--document", "/srv/shared/test/alpha"],
      ["--host", "plans.example.com"],
    ]) {
      await expectUnavailable(anchor(...flags), { ...ADMIN, ...REAL, HOME: "/srv/owner" });
    }
  });

  it("project anchor --title reads the title from stdin, refuses one core refuses before the key file, and never takes or prints one", async () => {
    const anchor = ["project", "anchor", ENTITY, "--title"];
    for (const [title, code] of [
      ["Claude\n", "generic_anchor"],
      ["New Tab", "generic_anchor"],
      ["abc\n", "generic_anchor"],
      ["\n", "bad_anchor"],
      ["x".repeat(201), "bad_anchor"],
      // Past 4096 bytes stdin is read no further, whatever it would normalize to.
      [`Alpha plan${" ".repeat(4096)}x`, "bad_anchor"],
    ] as const) {
      await expectRefused(anchor, { ...ADMIN, ...KEYS }, code, 1, { stdin: [title] });
    }
    // A title past the twelve kept prefixes, with the hint why.
    const deep = Array.from({ length: 13 }, (_, n) => `w${n + 1}xxx`).join(" ");
    await expectRefused(anchor, { ...ADMIN, ...KEYS }, "bad_anchor", 1, {
      stdin: [deep],
      hint: "a window title is matched at its first 12 word ends at most: anchor the title's first words",
    });
    // A value after --title is a usage error, so a title never travels as an argument; nor do two flags.
    await expectRefused([...anchor, "Alpha canary plan"], { ...ADMIN, ...KEYS }, "usage", 2, {
      stdin: ["Alpha canary plan"],
    });
    await expectRefused(["project", "anchor", ENTITY, "--title=Alpha canary plan"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused([...anchor, "--app", "test.example.notes"], { ...ADMIN, ...KEYS }, "usage", 2, {
      stdin: ["Alpha canary plan"],
    });
    // The positive control goes on to the closed port, and nothing it wrote holds the title.
    const result = await pi(anchor, { ...ADMIN, ...REAL }, { stdin: ["Alpha canary plan\n"] });
    expect(result.exit).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/canary/i);
    await expectUnavailable(anchor, { ...ADMIN, ...REAL }, { stdin: ["harbor rota\n"] });
  });

  it("the usage of project anchor shows --document quoted", async () => {
    const result = await pi(["--help"], {});
    expect(result.stdout.split("\n").find((line) => line.startsWith("pi project anchor "))).toContain(
      "--document '~/PATH'",
    );
    expect(result.stdout.split("\n").find((line) => line.startsWith("pi project anchor "))).toContain(
      "--title < TITLE",
    );
  });

  it("inspect prints nothing when stdout is not a terminal", async () => {
    await expectRefused(["inspect", ENTITY], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["inspect", "person@example.com"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["inspect", ENTITY], { ...ADMIN, ...REAL }, "not_a_terminal");
    // The positive control: a terminal passes the guard, and the command goes on to the database.
    await expectUnavailable(["inspect", ENTITY], { ...ADMIN, ...REAL }, { tty: true });
  });
});
