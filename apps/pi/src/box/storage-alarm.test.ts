import { describe, expect, it } from "vitest";
import { STORAGE_ALARMS, storageAlarm } from "./storage-alarm.ts";

// The capture storage alarm's thresholds, at 70 and 85 percent of the ceiling and at the ceiling
// itself, where every capture item is refused.

const GIB = 1_073_741_824;
const CEILING = 3 * GIB;

describe("the capture storage alarm", () => {
  it("is ok below 70 percent, warn_70 from 70, warn_85 from 85, and ceiling at the ceiling and past it", () => {
    const at = (fraction: number) => storageAlarm(Math.ceil(CEILING * fraction), CEILING);
    expect([at(0), at(0.69), at(0.7), at(0.84), at(0.85), at(0.99)]).toEqual([
      "ok",
      "ok",
      "warn_70",
      "warn_70",
      "warn_85",
      "warn_85",
    ]);
    expect([
      storageAlarm(CEILING - 1, CEILING),
      storageAlarm(CEILING, CEILING),
      storageAlarm(CEILING + 1, CEILING),
    ]).toEqual(["warn_85", "ceiling", "ceiling"]);
    // Exactly at each threshold, by whole bytes: 70 and 85 percent of 100 bytes.
    expect([storageAlarm(69, 100), storageAlarm(70, 100), storageAlarm(84, 100), storageAlarm(85, 100)]).toEqual([
      "ok",
      "warn_70",
      "warn_70",
      "warn_85",
    ]);
  });

  it("names only its four codes, which the box's timer accepts and nothing else", () => {
    expect(STORAGE_ALARMS).toEqual(["ok", "warn_70", "warn_85", "ceiling"]);
  });
});
