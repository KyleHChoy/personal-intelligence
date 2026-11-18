#!/usr/bin/env node
import { writeSync } from "node:fs";

// pi-reasoner once: at most one run, then exit. pi-reasoner
// measure: the weekly outcome test, when it is due, as the tester user.

// UTC, however the process was started, and before any module that reads a date is loaded.
process.env.TZ = "UTC";

const { fatalLine } = await import("@intelligence/contracts/personal");

// An error nothing caught ends the process with one fixed line and a code (fatalLine): never a
// message, a stack or a cause, any of which could carry evidence or a secret. On the box
// (PI_LOG_TIME=1, set by lib/reasoner-run) the line carries its time and level, as every other
// line does.
const fatal = (error: unknown): never => {
  try {
    writeSync(2, fatalLine("reasoner_failed", error, process.env.PI_LOG_TIME === "1" ? new Date() : undefined));
  } catch {
    // stderr is gone too.
  }
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

const args = process.argv.slice(2);
if (args.length !== 1 || (args[0] !== "once" && args[0] !== "measure")) {
  writeSync(2, '{"event":"reasoner_failed","code":"usage"}\nusage: pi-reasoner once | measure\n');
  process.exit(2);
}

if (args[0] === "measure") {
  const { measureOnce } = await import("./outcome-test.ts");
  process.exitCode = await measureOnce(process.env).catch(fatal);
} else {
  const { runOnce } = await import("./run.ts");
  process.exitCode = await runOnce(process.env).catch(fatal);
}
