// Covers commands.ts, the `pi` command line, through the commands of one area.
// pi send: its roles, its credentials and its arguments.
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  BOOTSTRAP,
  DRAFT,
  type Env,
  expectRefused,
  failureLines,
  KEYS,
  MODEL,
  OWNER_COMMANDS,
  PIPELINE,
  PIPELINE_COMMANDS,
  PROXY,
  pi,
  READER,
  REAL,
  request,
  SEND,
  SEND_COMMANDS,
  SEND_GOOGLE,
  useRealKeyFile,
  WORK,
  WRITER,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  it("pi send refuses the admin, writer, reader, pipeline and work URL, a client token and the read client's secret", async () => {
    for (const argv of SEND_COMMANDS) {
      // The read client's secret is pi's admin file's alone: a send.env that held it would hand
      // pisend a credential of pi's.
      for (const extra of [
        BOOTSTRAP,
        ADMIN,
        WRITER,
        READER,
        PIPELINE,
        WORK,
        { PI_CLIENT_TOKEN: "sentinel-token-7f3a91" },
        { PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" },
      ]) {
        await expectRefused(argv, { ...PROXY, ...KEYS, ...SEND_GOOGLE, ...extra }, "wrong_role_url", 1, { tty: true });
      }
      // The positive control: the proxy URL alone passes the check and reaches the body.
      const result = await pi(argv, { ...PROXY, ...REAL, ...SEND_GOOGLE }, { tty: true });
      expect(failureLines(result.stderr).at(-1)?.code, argv.join(" ")).not.toBe("wrong_role_url");
    }
  });

  it("every other command, db migrate among them, refuses the proxy URL", async () => {
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    const others: [string[], Env][] = [
      [["keys", "init"], {}],
      [["keys", "add-compartment", "employer:example"], {}],
      [["db", "migrate"], { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER }],
      [["db", "verifier"], {}],
      [["sync"], WRITER],
      [["mcp"], READER],
      ...OWNER_COMMANDS.map((argv): [string[], Env] => [argv, { ...ADMIN, ...google }]),
    ];
    for (const [argv, env] of others) {
      await expectRefused(argv, { ...env, ...KEYS, ...PROXY }, "wrong_role_url", 1, { tty: true });
    }
  });

  it("every command but pi send refuses PI_SEND_GOOGLE_CLIENT_SECRET with wrong_role_url", async () => {
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    const journal = { PI_ERASURE_JOURNAL: "/nonexistent/pi/erasures.jsonl" };
    // One or more commands of each role but the proxy's.
    const others: [string[], Env][] = [
      [["keys", "init"], KEYS],
      [["keys", "add-compartment", "employer:example"], KEYS],
      [["db", "verifier"], {}],
      [["db", "migrate"], { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE, ...WORK }],
      [["sync"], { ...WRITER, ...KEYS }],
      [["mcp"], { ...READER, ...KEYS }],
      [["work", "tick"], { ...WORK, ...journal }],
      [["models", "set-key"], { ...ADMIN, ...KEYS }],
      ...PIPELINE_COMMANDS.map((argv): [string[], Env] => [argv, { ...PIPELINE, ...KEYS, ...MODEL }]),
      ...OWNER_COMMANDS.map((argv): [string[], Env] => [argv, { ...ADMIN, ...KEYS, ...google }]),
    ];
    for (const [argv, env] of others) {
      await expectRefused(
        argv,
        { ...env, PI_SEND_GOOGLE_CLIENT_SECRET: "sentinel-send-client-secret" },
        "wrong_role_url",
        1,
        { tty: true },
      );
      // The positive control: the variable unset, the same command is not refused for it.
      const result = await pi(argv, { ...env, PI_SEND_GOOGLE_CLIENT_SECRET: "" }, { tty: true });
      expect(failureLines(result.stderr).at(-1)?.code, argv.join(" ")).not.toBe("wrong_role_url");
    }
    // pi send holds it.
    for (const argv of SEND_COMMANDS) {
      const result = await pi(argv, { ...PROXY, ...KEYS, ...SEND_GOOGLE }, { tty: true });
      expect(failureLines(result.stderr).at(-1)?.code, argv.join(" ")).not.toBe("wrong_role_url");
    }
  });

  it("pi mcp refuses PI_SEND_GOOGLE_CLIENT_SECRET", async () => {
    await expectRefused(
      ["mcp"],
      { ...READER, ...REAL, PI_SEND_GOOGLE_CLIENT_SECRET: "sentinel-send-client-secret" },
      "wrong_role_url",
    );
    // The send client's id is not a secret, and does not stop it.
    const served = await pi(
      ["mcp"],
      { ...READER, ...REAL, PI_SEND_GOOGLE_CLIENT_ID: "sentinel-send-client-id" },
      { stdin: [request(1, "ping")] },
    );
    expect(served.exit).toBe(0);
  });

  it("only pi send connect requires the send client", async () => {
    await expectRefused(
      ["send", "connect", "--account", "personal", "--port", "8765"],
      { ...PROXY, ...KEYS },
      "missing_env",
      1,
      { hint: "set PI_SEND_GOOGLE_CLIENT_ID", tty: true },
    );
    await expectRefused(
      ["send", "connect", "--account", "personal", "--port", "8765"],
      { ...PROXY, ...KEYS, PI_SEND_GOOGLE_CLIENT_ID: "sentinel-send-client-id" },
      "missing_env",
      1,
      {
        hint: "set PI_SEND_GOOGLE_CLIENT_SECRET",
        tty: true,
      },
    );
    await expectRefused(["send", "list"], KEYS, "missing_env", 1, { hint: "set PI_DATABASE_URL_PROXY" });
    await expectRefused(["send", "list"], PROXY, "missing_env", 1, { hint: "set PI_KEY_FILE" });
  });

  it("pi send draft with two draft ids is a usage error", async () => {
    await expectRefused(["send", "draft", DRAFT, DRAFT, "--code", "0123abcd"], { ...PROXY, ...KEYS }, "usage", 2, {
      tty: true,
    });
    await expectRefused(["send", "draft", "--code", "0123abcd"], { ...PROXY, ...KEYS }, "usage", 2, { tty: true });
    await expectRefused(["send", "show", DRAFT, DRAFT], { ...PROXY, ...KEYS }, "usage", 2, { tty: true });
    await expectRefused(["send", "settle", SEND, SEND, "--sent"], { ...PROXY, ...KEYS }, "usage", 2, { tty: true });
  });

  it("pi send settle takes exactly one of --sent and --not-sent, and a send id of its form; pi send draft takes a draft id of its form and a code", async () => {
    await expectRefused(["send", "settle", SEND], { ...PROXY, ...KEYS }, "usage", 2);
    await expectRefused(["send", "settle", SEND, "--sent", "--not-sent"], { ...PROXY, ...KEYS }, "usage", 2);
    await expectRefused(["send", "settle", "send-1", "--sent"], { ...PROXY, ...KEYS }, "usage", 2);
    await expectRefused(["send", "draft", "draft-1", "--code", "0123abcd"], { ...PROXY, ...KEYS }, "usage", 2);
    await expectRefused(["send", "draft", DRAFT], { ...PROXY, ...KEYS }, "usage", 2);
    await expectRefused(
      ["send", "draft", DRAFT, "--code", "0123abcd", "--reveal", ""],
      { ...PROXY, ...KEYS },
      "usage",
      2,
    );
    await expectRefused(["send", "show", "draft-1"], { ...PROXY, ...KEYS }, "usage", 2, { tty: true });
    await expectRefused(
      ["send", "connect", "--account", "Not A Label", "--port", "8765"],
      { ...PROXY, ...KEYS, ...SEND_GOOGLE },
      "usage",
      2,
    );
    await expectRefused(["send", "disconnect"], { ...PROXY, ...KEYS }, "usage", 2);
  });

  it("pi send show prints nothing when stdout is not a terminal", async () => {
    await expectRefused(["send", "show", DRAFT], { ...PROXY, ...REAL }, "not_a_terminal");
  });
});
