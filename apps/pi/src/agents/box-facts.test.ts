import { describe, expect, it } from "vitest";
import { boxFacts, statusBox } from "./box-facts.ts";

describe("what the agent API's process sees of the box", () => {
  it("names the holds whose files stand and says whether extraction is switched on, as codes", () => {
    const there = new Set(["/data/sync-hold", "/data/dream-hold", "/data/extract-on"]);
    const facts = boxFacts((path) => there.has(path));
    expect(facts.holds).toEqual(["sync_hold", "dream_hold"]);
    expect(facts.switches).toEqual([{ key: "extract_on", value: "on" }]);
    expect(facts.commit).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
  });

  it("a box with no hold and extraction off says so", () => {
    expect(boxFacts(() => false)).toMatchObject({ holds: [], switches: [{ key: "extract_on", value: "off" }] });
  });

  it("names the box's wait for the owner's migration among the holds, beside the two holds the box took", () => {
    const there = new Set(["/data/sync-hold", "/data/read-hold", "/data/migrate-wait"]);
    expect(boxFacts((path) => there.has(path)).holds).toEqual(["sync_hold", "read_hold", "migrate_wait"]);
  });
});

describe("what pia status says of the box's holds", () => {
  it("says the box waits for its migration in a word of its own, and only while the wait stands", () => {
    expect(statusBox(["sync_hold", "read_hold", "migrate_wait"])).toEqual({
      holds: ["sync_hold", "read_hold", "migrate_wait"],
      waiting: "migration",
    });
    // The owner's own holds, with no wait: holds, and no word of a migration.
    expect(statusBox(["sync_hold", "read_hold"])).toEqual({ holds: ["sync_hold", "read_hold"] });
    expect(statusBox([])).toEqual({ holds: [] });
  });
});
