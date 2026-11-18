import type { ModelRequest } from "@intelligence/contracts";
import { relationRules } from "@intelligence/personal-core/views";
import { describe, expect, it, vi } from "vitest";
import { dreamMaxCalls, dreamUsd, nightClient, tailHeld } from "./dream.ts";

describe("the owner's dream call allowance", () => {
  it("accepts a separate setting and a one-run override, rejecting malformed limits; unset is no cap", () => {
    expect(dreamMaxCalls({}, {})).toBeNull();
    expect(dreamUsd({})).toBeNull();
    expect(dreamUsd({ usd: "12.50" })).toBe(12.5);
    for (const value of ["0", "-1", "lots"]) expect(() => dreamUsd({ usd: value })).toThrow();
    expect(dreamMaxCalls({ PI_DREAM_MAX_CALLS: "1000" }, {})).toBe(1000);
    expect(dreamMaxCalls({ PI_DREAM_MAX_CALLS: "1000" }, { "max-calls": "800" })).toBe(800);
    for (const value of ["0", "-1", "1.5", "unlimited"]) {
      expect(() => dreamMaxCalls({ PI_DREAM_MAX_CALLS: value }, {})).toThrow();
    }
  });

  it("both caps unset: no stop for calls or dollars, but a missing cost still stops", async () => {
    const before = { calls: 10_000, microUsd: 10_000_000_000, costMissing: false };
    const store = { dreamSpentToday: async () => before, recordUsage: async () => {} };
    const sent = vi.fn(async () => {
      throw new Error("model reached");
    });
    const make = () => ({
      complete: sent,
      embed: async () => {
        throw new Error("unused");
      },
    });
    const open = await nightClient(store, make, null, null);
    await expect(open.model.complete({} as ModelRequest)).rejects.toThrow("model reached");
    // A second model of the same night shares its calls.
    await expect(open.also(make).complete({} as ModelRequest)).rejects.toThrow("model reached");
    expect(open.calls.made).toBe(10_002);
    before.costMissing = true;
    const missing = await nightClient(store, make, null, null);
    await expect(missing.model.complete({} as ModelRequest)).rejects.toMatchObject({ reason: "cost_missing" });
  });

  it("resumes past the former call ceiling while retaining the dollar and missing-cost stops", async () => {
    const before = { calls: 400, microUsd: 2_000_000, costMissing: false };
    const store = { dreamSpentToday: async () => before, recordUsage: async () => {} };
    const sent = vi.fn(async () => {
      throw new Error("model reached");
    });
    const client = await nightClient(
      store,
      () => ({
        complete: sent,
        embed: async () => {
          throw new Error("unused");
        },
      }),
      402,
    );
    const request = {} as ModelRequest;
    await expect(client.model.complete(request)).rejects.toThrow("model reached");
    await expect(client.model.complete(request)).rejects.toThrow("model reached");
    await expect(client.model.complete(request)).rejects.toMatchObject({ reason: "calls" });
    expect(sent).toHaveBeenCalledTimes(2);
    before.microUsd = relationRules().dream.usdPerNight * 1_000_000;
    const dollars = await nightClient(
      store,
      () => ({
        complete: sent,
        embed: async () => {
          throw new Error("unused");
        },
      }),
      1000,
    );
    await expect(dollars.model.complete(request)).rejects.toMatchObject({ reason: "day" });
    before.microUsd = 0;
    before.costMissing = true;
    const missing = await nightClient(
      store,
      () => ({
        complete: sent,
        embed: async () => {
          throw new Error("unused");
        },
      }),
      1000,
    );
    await expect(missing.model.complete(request)).rejects.toMatchObject({ reason: "cost_missing" });
    expect(sent).toHaveBeenCalledTimes(2);
  });
});

describe("the pass's tail", () => {
  it("does not run once the chunks were held, or once the pass lock is lost after they finished", () => {
    expect(tailHeld("held", () => false)).toBe(true);
    expect(tailHeld("ok", () => true)).toBe(true);
    expect(tailHeld("ok", () => false)).toBe(false);
  });
});
