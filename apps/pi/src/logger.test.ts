import { Writable } from "node:stream";
import { PersonalLogEvent } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, logClockOf, warningCode } from "./logger.ts";

// A stream that keeps what was written to it.
function sink(): { stream: Writable; text: () => string } {
  const written: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk);
      done();
    },
  });
  return { stream, text: () => Buffer.concat(written).toString("utf8") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the personal logger", () => {
  it("the logger refuses a name", () => {
    const stdout = vi.spyOn(process.stdout, "write");
    // The test runner takes console calls before they reach stdout, so each is watched itself.
    const consoles = (["log", "info", "debug", "warn", "error"] as const).map((method) => vi.spyOn(console, method));

    // Neither is a PersonalLogEvent, so each is handed over as the caller's mistake would be.
    const refused: unknown[] = [
      { event: "entity_read", ids: { entity: "Alex Example" } },
      { event: "entity_read", name: "Alex Example" },
    ];
    for (const event of refused) {
      for (const level of ["info", "warn", "error"] as const) {
        const stderr = sink();
        createLogger(stderr.stream)[level](event as PersonalLogEvent);
        expect(stderr.text()).toBe('{"event":"log_field_refused"}\n');
      }
    }

    // The positive control: a valid event is written unchanged, as one line.
    const valid = PersonalLogEvent.parse({
      event: "sync_page_done",
      ids: { client: "test-client", entity: `ent_${"0".repeat(25)}1`, account: `acc_${"0".repeat(25)}2` },
      counts: { items_written: 3 },
      durationMs: 12,
      code: "ok",
    });
    for (const level of ["info", "warn", "error"] as const) {
      const stderr = sink();
      createLogger(stderr.stream)[level](valid);
      expect(stderr.text()).toBe(`${JSON.stringify(valid)}\n`);
    }

    expect(stdout).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });

  it("with a clock, every line carries `at` and `level` after its event, and still nothing but ids, counts and codes", () => {
    const at = new Date("2026-10-30T12:00:00.000Z");
    for (const level of ["info", "warn", "error"] as const) {
      const stderr = sink();
      const log = createLogger(stderr.stream, () => at);
      log[level]({ event: "work_tick", counts: { queued: 2 }, code: "ok" });
      log[level]({ event: "entity_read", name: "Alex Example" } as unknown as PersonalLogEvent);
      const [first, second] = stderr
        .text()
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(first).toEqual({ event: "work_tick", at: at.toISOString(), level, counts: { queued: 2 }, code: "ok" });
      expect(Object.keys(first ?? {}).slice(0, 3)).toEqual(["event", "at", "level"]);
      // A refused event is still replaced whole, and keeps its time and level.
      expect(second).toEqual({ event: "log_field_refused", at: at.toISOString(), level });
      expect(stderr.text()).not.toContain("Alex");
    }
  });

  it("the box's wrappers turn the clock on, and nothing else does", () => {
    expect(logClockOf({ PI_LOG_TIME: "1" })?.()).toBeInstanceOf(Date);
    for (const value of [undefined, "", "0", "yes"]) expect(logClockOf({ PI_LOG_TIME: value })).toBeUndefined();
  });

  it("a warning's name becomes a code, and a name that is no code becomes the fixed one", () => {
    expect(warningCode("DeprecationWarning")).toBe("deprecation_warning");
    expect(warningCode("Warning")).toBe("warning");
    expect(warningCode("MaxListenersExceededWarning")).toBe("max_listeners_exceeded_warning");
    for (const name of ["", "Alex Example", "owner@example.com", "x".repeat(200), "1Warning"])
      expect(warningCode(name), name).toBe("warning");
    // Whatever it is given, the logger takes the result as a code.
    for (const name of ["DeprecationWarning", "Alex Example", ""])
      expect(PersonalLogEvent.safeParse({ event: "process_warning", code: warningCode(name) }).success).toBe(true);
  });
});
