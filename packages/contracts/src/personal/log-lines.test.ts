import { describe, expect, it } from "vitest";
import { createLogger, fatalLine, logClockOf } from "./log-lines.ts";

describe("the personal log lines", () => {
  const at = new Date("2026-01-02T03:04:05.000Z");

  it("writes an event alone without a clock, and its time and level after its code with one", () => {
    const lines: string[] = [];
    const sink = { write: (chunk: string) => lines.push(chunk) };
    createLogger(sink).info({ event: "process_warning", code: "warning" });
    createLogger(sink, () => at).warn({ event: "process_warning", code: "warning" });
    expect(lines).toEqual([
      '{"event":"process_warning","code":"warning"}\n',
      '{"event":"process_warning","at":"2026-01-02T03:04:05.000Z","level":"warn","code":"warning"}\n',
    ]);
  });

  it("replaces an event that is not a log event whole", () => {
    const lines: string[] = [];
    createLogger({ write: (chunk: string) => lines.push(chunk) }).error({ event: "nope", name: "x" } as never);
    expect(lines).toEqual(['{"event":"log_field_refused"}\n']);
  });

  it("has a clock only when PI_LOG_TIME is 1", () => {
    expect(logClockOf({ PI_LOG_TIME: "1" })).toBeTypeOf("function");
    expect(logClockOf({ PI_LOG_TIME: "0" })).toBeUndefined();
    expect(logClockOf({})).toBeUndefined();
  });

  it("ends a process with its event, a code and a reason, never the error's message", () => {
    const bug = new TypeError("secret text");
    const socket = Object.assign(new Error("secret text"), { code: "ECONNREFUSED" });
    expect(fatalLine("command_failed", bug)).toBe('{"event":"command_failed","code":"bug","reason":"type_error"}\n');
    expect(fatalLine("reasoner_failed", socket, at)).toBe(
      '{"event":"reasoner_failed","at":"2026-01-02T03:04:05.000Z","level":"error","code":"unavailable","reason":"econnrefused"}\n',
    );
    // A refusal with its own code is expected, and ends the process as unavailable.
    expect(fatalLine("command_failed", Object.assign(new Error("x"), { code: "usage" }))).toBe(
      '{"event":"command_failed","code":"unavailable"}\n',
    );
  });
});
