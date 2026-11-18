import { describe, expect, it } from "vitest";
import { untilDone } from "./until-done.ts";

// The page's host is written as the server starts and tried again until it lands: a write that
// failed because the database was not migrated yet must not wait for a restart.

describe("a write tried until it lands", () => {
  it("tries again after a growing wait, bounded, and stops once it lands", async () => {
    let tries = 0;
    const waits: number[] = [];
    const failures: unknown[] = [];
    const landed = await untilDone(
      async () => {
        tries += 1;
        if (tries < 5) throw new Error("unavailable");
      },
      (error) => failures.push(error),
      async (ms) => {
        waits.push(ms);
      },
      () => false,
      { first: 5_000, most: 20_000 },
    );
    expect(landed).toBe(true);
    expect(tries).toBe(5);
    expect(failures).toHaveLength(4);
    expect(waits).toEqual([5_000, 10_000, 20_000, 20_000]);
  });

  it("tells a failure that cannot heal once, and tries no more", async () => {
    let tries = 0;
    const failures: unknown[] = [];
    const landed = await untilDone(
      async () => {
        tries += 1;
        throw new Error("invalid_argument");
      },
      (error) => failures.push(error),
      async () => {},
      () => false,
      { lasting: (error) => error instanceof Error && error.message === "invalid_argument" },
    );
    expect(landed).toBe(false);
    expect(tries).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it("never rejects, even when telling of a failure throws", async () => {
    let tries = 0;
    await expect(
      untilDone(
        async () => {
          tries += 1;
          if (tries < 2) throw new Error("unavailable");
        },
        () => {
          throw new Error("the log is gone");
        },
        async () => {},
        () => false,
      ),
    ).resolves.toBe(true);
  });

  it("gives up once the server has closed", async () => {
    let tries = 0;
    let closed = false;
    const landed = await untilDone(
      async () => {
        tries += 1;
        throw new Error("unavailable");
      },
      () => {},
      async () => {
        closed = true;
      },
      () => closed,
    );
    expect(landed).toBe(false);
    expect(tries).toBe(1);
  });
});
