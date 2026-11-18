import { describe, expect, it, vi } from "vitest";
import { watchConnection } from "./wake.ts";

// The listener's ping finds a connection that has stopped answering.

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// Until `check` holds, however slow the machine is.
const until = (check: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: 20_000, interval: 5 });

describe("watchConnection", () => {
  it("keeps quiet while each ping answers in time", async () => {
    let lost = 0;
    let pings = 0;
    const stop = watchConnection(
      async () => void (pings += 1),
      10,
      30,
      () => void (lost += 1),
    );
    await until(() => pings > 2);
    stop();
    expect(lost).toBe(0);
  });

  it("calls onLost once when a ping fails, and pings no more", async () => {
    let lost = 0;
    let pings = 0;
    watchConnection(
      async () => {
        pings += 1;
        throw new Error("gone");
      },
      10,
      30,
      () => void (lost += 1),
    );
    await until(() => lost > 0);
    // Long enough for a second call or ping that should not come.
    await pause(50);
    expect(lost).toBe(1);
    expect(pings).toBe(1);
  });

  it("calls onLost once when a ping never answers: a half-open connection", async () => {
    let lost = 0;
    watchConnection(
      () => new Promise(() => {}),
      10,
      20,
      () => void (lost += 1),
    );
    await until(() => lost > 0);
    await pause(50);
    expect(lost).toBe(1);
  });
});
