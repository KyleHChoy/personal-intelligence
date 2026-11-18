import { describe, expect, it } from "vitest";
import { DB_TEST_TIMEOUT, SLOW_DB_TEST_TIMEOUT } from "./timeouts.ts";

// The database test ceilings hold under a load of 30 to 40 on the shared machine: at least two
// minutes a test, and ten for a file that builds a large world first.
describe("the database test ceilings", () => {
  it("leave room for a loaded machine", () => {
    expect(DB_TEST_TIMEOUT).toBeGreaterThanOrEqual(120_000);
    expect(SLOW_DB_TEST_TIMEOUT).toBeGreaterThanOrEqual(600_000);
  });
});
