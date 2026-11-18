// Covers main.ts and commands.ts, the `pi` command line, through the commands of one area.
// The process: a closed pipe, faults, a bad role URL, warnings and uncaught errors.
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MIGRATE_OPTIONAL, MIGRATE_REQUIRES } from "./command-kit.ts";
import {
  ADMIN,
  BOOTSTRAP,
  expectRefused,
  expectUnavailable,
  failureLines,
  folder,
  MAIN,
  OWNER_COMMANDS,
  PIPELINE,
  pi,
  READER,
  REAL,
  RESTRICTED,
  request,
  url,
  useRealKeyFile,
  WORK,
  WRITER,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  it("pi mcp ends quietly when its client closes the pipe", async () => {
    const env = { ...READER, ...REAL };
    // A pipe whose reader has gone: every write fails.
    const closed = new Writable({
      write(_chunk, _encoding, done) {
        done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const result = await pi(["mcp"], env, { stdin: [request(1, "ping"), request(2, "ping")], stdout: closed });
    // No uncaught error, and no failure reported: the client went away.
    expect(result.exit).toBe(0);
    expect(failureLines(result.stderr).filter((event) => event.event === "command_failed")).toEqual([]);

    // The positive control: with the pipe open, the same messages are answered.
    const open = await pi(["mcp"], env, { stdin: [request(1, "ping"), request(2, "ping")] });
    expect(open).toMatchObject({
      exit: 0,
      stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })}\n`,
    });
  });

  it("an unexpected error in a command is one log line, with no message, stack or cause", async () => {
    // The key file's folder is a file, so writing the key file fails in a way no code names.
    const blocked = join(folder, "not-a-folder");
    await writeFile(blocked, "");
    const result = await pi(["keys", "init"], { PI_KEY_FILE: join(blocked, "sentinel-7f3a91", "keys.json") });
    // A system error is expected: unavailable, by its errno.
    expect(result).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${JSON.stringify({ event: "command_failed", code: "unavailable", reason: "enotdir" })}\n`,
    });
  });

  it("a fault no code expects is a bug, logged by its class and never its message", async () => {
    const throwing = {
      write: () => {
        throw new TypeError("sentinel-7f3a91 owner@example.com");
      },
    } as unknown as Writable;
    const result = await pi(["--help"], {}, { stdout: throwing });
    expect(result).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${JSON.stringify({ event: "command_failed", code: "bug", reason: "type_error" })}\n`,
    });
  });

  it("a role URL that names no user or no password is refused as bad_url, before any connection", async () => {
    // The driver would fill either from PGUSER and PGPASSWORD, and connect as whoever they name.
    const bad = [
      "postgres://127.0.0.1:1/pi_test",
      "postgres://pi_role@127.0.0.1:1/pi_test",
      "postgres://:sentinel-7f3a91@127.0.0.1:1/pi_test",
      "https://pi_role:sentinel-7f3a91@127.0.0.1:1/pi_test",
      "postgres://pi_role:sentinel-7f3a91@[::1/pi_test",
      "postgres://pi_role:sentinel-%zz@127.0.0.1:1/pi_test",
    ];
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    for (const url of bad) {
      await expectRefused(["mcp"], { ...REAL, PI_DATABASE_URL_READER: url }, "bad_url");
      await expectRefused(["sync"], { ...REAL, PI_DATABASE_URL_WRITER: url }, "bad_url");
      for (const argv of OWNER_COMMANDS)
        await expectRefused(argv, { ...REAL, ...google, PI_DATABASE_URL_ADMIN: url }, "bad_url", 1, { tty: true });
      for (const name of [...MIGRATE_REQUIRES, ...MIGRATE_OPTIONAL]) {
        await expectRefused(
          ["db", "migrate"],
          { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE, ...WORK, ...RESTRICTED, [name]: url },
          "bad_url",
        );
      }
    }
    // A query parameter that changes who connects, or where, is refused too: the driver lets
    // it override what the URL itself names.
    for (const parameter of [
      "user=postgres",
      "password=sentinel-7f3a91",
      "host=db.example.com",
      "port=5432",
      "dbname=postgres",
      "options=-c%20role%3Dpostgres",
      "passfile=%2Ftmp%2Fpgpass",
    ]) {
      for (const query of [`?${parameter}`, `?sslmode=disable&${parameter}`]) {
        await expectRefused(["mcp"], { ...REAL, PI_DATABASE_URL_READER: `${url("pi_reader")}${query}` }, "bad_url");
        await expectRefused(["sync"], { ...REAL, PI_DATABASE_URL_WRITER: `${url("pi_writer")}${query}` }, "bad_url");
        await expectRefused(["status"], { ...REAL, PI_DATABASE_URL_ADMIN: `${url("pi_admin")}${query}` }, "bad_url");
        await expectRefused(
          ["db", "migrate"],
          {
            ...BOOTSTRAP,
            ...ADMIN,
            ...WRITER,
            ...PIPELINE,
            ...WORK,
            ...RESTRICTED,
            PI_DATABASE_URL_READER: `${url("pi_reader")}${query}`,
          },
          "bad_url",
        );
      }
    }
    // A parameter that changes neither is accepted.
    await expectUnavailable(["sync"], {
      ...REAL,
      PI_DATABASE_URL_WRITER: `${url("pi_writer")}?sslmode=disable&application_name=pi`,
    });
    await expectUnavailable(["status"], { ...REAL, PI_DATABASE_URL_ADMIN: `${url("pi_admin")}?application_name=pi` });

    // The positive control: a URL that names both passes the check, and the command goes on
    // to the closed port.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL });
    await expectUnavailable(["status"], { ...ADMIN, ...REAL });
    await expectUnavailable(["db", "migrate"], {
      ...BOOTSTRAP,
      ...ADMIN,
      ...WRITER,
      ...READER,
      ...PIPELINE,
      ...WORK,
      ...RESTRICTED,
    });
  });

  // The two tests below are about the process itself, so each runs the real `pi` entry: a cold
  // start that is slow on a busy machine, so not the 5 s default. Each acts once main.ts has set
  // its own warning listener, the last thing it does before it runs the command, rather than
  // after a fixed wait a slow start could outlast.
  const onceStarted = (act: string): string =>
    `data:text/javascript,${encodeURIComponent(`const before = process.listeners("warning"); const wait = setInterval(() => { if (process.listeners("warning").some((listener) => !before.includes(listener))) { clearInterval(wait); ${act} } }, 10);`)}`;

  it("a process warning reaches stderr as a log event, with nothing of its message", async () => {
    // The real process, serving the agent API, and a preload that emits a warning as a library
    // would; its input is closed once the warning's line is out, and the process ends.
    const preload = onceStarted(
      `process.emitWarning("sentinel-message-7f3a91", { type: "SecurityWarning", code: "SENTINEL_4D1B" });`,
    );
    const child = spawn(process.execPath, ["--import", preload, MAIN, "mcp"], {
      env: { PATH: process.env.PATH ?? "", ...READER, ...REAL },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.endsWith("\n")) child.stdin.end();
    });
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect({ exit, stdout, stderr }).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "process_warning", code: "security_warning" })}\n`,
    });
  }, 30_000);

  it("an error nothing caught ends the real process with one fixed line", async () => {
    // The real process, serving the agent API with its input left open, and a preload that
    // throws, or rejects, with a message and a cause.
    const preload = (act: string): string =>
      onceStarted(
        `const error = new Error("sentinel-message-7f3a91", { cause: new Error("sentinel-cause-4d1b") }); ${act}`,
      );
    for (const act of ["throw error;", "Promise.reject(error);"]) {
      const ended = await promisify(execFile)(process.execPath, ["--import", preload(act), MAIN, "mcp"], {
        env: { PATH: process.env.PATH ?? "", ...READER, ...REAL },
      }).then(
        () => null,
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      // An Error nothing expects is a bug, by its class, never its message or its cause.
      expect({ code: ended?.code, stdout: ended?.stdout, stderr: ended?.stderr }, act).toEqual({
        code: 1,
        stdout: "",
        stderr: `${JSON.stringify({ event: "command_failed", code: "bug", reason: "error" })}\n`,
      });
    }
  }, 30_000);
});
