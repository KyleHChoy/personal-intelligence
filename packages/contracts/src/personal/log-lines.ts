// The personal processes' log lines: one JSON line per event, to stderr and nowhere else. pi and
// pi-reasoner write through the same logger and end on an uncaught error with the same fixed line.
import { faultOf } from "./faults.ts";
import { PersonalLogEvent, type PersonalLogger } from "./log-event.ts";

type LogLevel = "info" | "warn" | "error";

// Where a logger writes: a process's stderr, or a test's stream.
type LogSink = { write(chunk: string): unknown };

// An event that is not a PersonalLogEvent is replaced whole, so no name, address or text a caller
// passed by mistake is ever written.
//
// With a clock, each line also carries `at`, the clock's ISO time, and `level`, the method it was
// written with, after its event code; still ids, counts and codes only. A process gives its clock
// when the box's wrappers set PI_LOG_TIME=1 (logClockOf); without one, as a test's run is given, a
// line is the event alone.
export function createLogger(stderr: LogSink, clock?: () => Date): PersonalLogger {
  const write =
    (level: LogLevel) =>
    (event: PersonalLogEvent): void => {
      const parsed = PersonalLogEvent.safeParse(event);
      const { event: code, ...rest } = parsed.success ? parsed.data : { event: "log_field_refused" };
      const line =
        clock === undefined ? { event: code, ...rest } : { event: code, at: clock().toISOString(), level, ...rest };
      stderr.write(`${JSON.stringify(line)}\n`);
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

// The clock a process's lines carry: the system's when PI_LOG_TIME is `1`, as the box's wrappers
// set it, else none.
export const logClockOf = (env: Readonly<Record<string, string | undefined>>): (() => Date) | undefined =>
  env.PI_LOG_TIME === "1" ? () => new Date() : undefined;

// The one line a process ends with when an error nothing caught reaches it, under its event code:
// `unavailable` for a fault it expects (a driver's, a socket's, an abort), `bug` for any other, and
// its SQLSTATE, errno or class as the reason. Never a message, a stack or a cause, any of which
// could carry evidence or a secret. With a time (PI_LOG_TIME=1), the line carries it and the error
// level, as every other line does.
export function fatalLine(event: string, error: unknown, at?: Date): string {
  const fault = faultOf(error);
  const why = {
    code: fault.expected ? "unavailable" : "bug",
    ...(fault.reason === undefined ? {} : { reason: fault.reason }),
  };
  const line = at === undefined ? { event, ...why } : { event, at: at.toISOString(), level: "error", ...why };
  return `${JSON.stringify(line)}\n`;
}
