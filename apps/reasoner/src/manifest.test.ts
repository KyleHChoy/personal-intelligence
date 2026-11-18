import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger, logClockOf, type PersonalLogEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as Record<
  string,
  unknown
>;

describe("the reasoner's manifest", () => {
  it("the reasoner's manifest lists exactly its three workspace packages, no third-party dependency and no dev dependency", () => {
    expect(manifest.name).toBe("@intelligence/personal-reasoner");
    expect(manifest.dependencies).toEqual({
      "@intelligence/contracts": "workspace:*",
      "@intelligence/personal-ladder": "workspace:*",
      "@intelligence/personal-models": "workspace:*",
    });
    for (const key of ["devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"])
      expect(manifest[key], key).toBeUndefined();
  });
});

describe("the reasoner's logger", () => {
  it("the logger refuses a name", () => {
    const written: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        written.push(chunk.toString("utf8"));
        done();
      },
    });
    const log = createLogger(stream);
    log.info({ event: "run_read", ids: { entity: "Alex Example" } } as unknown as PersonalLogEvent);
    log.error({ event: "run_read", name: "Alex Example" } as unknown as PersonalLogEvent);
    log.warn({ event: "run_finished", ids: { run: "run_01JABCDEFGHJKMNPQRSTVWXYZ0" }, code: "ok" } as PersonalLogEvent);
    expect(written[0]).toBe('{"event":"log_field_refused"}\n');
    expect(written[1]).toBe('{"event":"log_field_refused"}\n');
    expect(written.join("")).not.toContain("Alex");
    expect(written).toHaveLength(3);
  });

  // With a clock, as on the box, each line carries its time and level after
  // its event; a refused line too.
  it("with a clock, each line carries at and level after its event", () => {
    const written: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        written.push(chunk.toString("utf8"));
        done();
      },
    });
    const log = createLogger(stream, logClockOf({ PI_LOG_TIME: "1" }) ?? (() => new Date(0)));
    log.warn({ event: "run_finished", code: "ok" } as PersonalLogEvent);
    log.error({ event: "run_read", name: "Alex Example" } as unknown as PersonalLogEvent);
    const [first, second] = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(Object.keys(first ?? {})).toEqual(["event", "at", "level", "code"]);
    expect(first).toMatchObject({
      event: "run_finished",
      level: "warn",
      code: "ok",
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(second).toMatchObject({ event: "log_field_refused", level: "error" });
    expect(logClockOf({})).toBeUndefined();
  });
});
