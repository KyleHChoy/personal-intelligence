#!/usr/bin/env node
import { writeSync } from "node:fs";

// UTC, however the process was started, and before any module that reads a date is loaded:
// a `Date` header with no zone is read in the process's time zone, so the same mailbox would
// give different rows on hosts in different zones.
process.env.TZ = "UTC";

// On the box (PI_LOG_TIME=1, set by its wrappers) every line carries its
// time and level, this fixed one too.
const timed = process.env.PI_LOG_TIME === "1";

const { fatalLine } = await import("@intelligence/contracts/personal");

// An error nothing caught ends the process with one fixed line and a code (fatalLine): never a
// message, a stack or a cause, any of which could carry evidence or a secret.
const fatal = (error: unknown): never => {
  try {
    writeSync(2, fatalLine("command_failed", error, timed ? new Date() : undefined));
  } catch {
    // stderr is gone too.
  }
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

const { run } = await import("./commands.ts");
const { createLogger, logClockOf, warningCode } = await import("./logger.ts");

// A process warning, a library's included, is a log event with the warning's name as its code
// and nothing of its message. Node's own printing of it is taken off, so stderr carries log
// events only.
const clock = logClockOf(process.env);
const log = createLogger(process.stderr, clock);
process.removeAllListeners("warning");
process.on("warning", (warning) => log.warn({ event: "process_warning", code: warningCode(warning.name) }));

process.exitCode = await run(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  stdoutIsTTY: process.stdout.isTTY === true,
  stdinIsTTY: process.stdin.isTTY === true,
  ...(clock === undefined ? {} : { clock }),
}).catch(fatal);
