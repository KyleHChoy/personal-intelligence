import type { Keys } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { guardOf, IMPORT_REMOVAL_FLOOR, importRowId } from "./contact-import.ts";

// Contact import's guards and row ids.

const preview = (stored: number, removed: number) => ({
  stored,
  items: { new: 0, changed: 0, unchanged: 0, removed, erased: 0, suppressed: 0 },
});

describe("guardOf", () => {
  it("refuses a file that keeps no contact while the import holds some, whatever the override", () => {
    expect(guardOf(0, preview(3, 3), false)).toBe("would_empty");
    expect(guardOf(0, preview(3, 3), true)).toBe("would_empty");
    expect(guardOf(0, preview(0, 0), false)).toBeNull();
  });

  it("refuses removing more than half of the import and more than the floor, unless the owner allows it", () => {
    expect(guardOf(4, preview(20, 11), false)).toBe("too_many_removals");
    expect(guardOf(4, preview(20, 11), true)).toBeNull();
    expect(guardOf(10, preview(20, 10), false)).toBeNull();
    expect(guardOf(1, preview(IMPORT_REMOVAL_FLOOR + 1, IMPORT_REMOVAL_FLOOR), false)).toBeNull();
  });
});

describe("importRowId", () => {
  it("is a keyed fingerprint: no address in it, and another key file gives another id", () => {
    const keys = (fill: number): Keys => ({ compartments: new Map(), fingerprintKey: Buffer.alloc(32, fill) });
    const one = importRowId(keys(1), "email:nia.rao@sheet-import.test");
    expect(one).toMatch(/^import:[0-9a-f]{64}$/);
    expect(importRowId(keys(1), "email:nia.rao@sheet-import.test")).toBe(one);
    expect(importRowId(keys(2), "email:nia.rao@sheet-import.test")).not.toBe(one);
  });
});
