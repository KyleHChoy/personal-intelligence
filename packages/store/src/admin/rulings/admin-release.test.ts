import { describe, expect, it } from "vitest";
import { planOf } from "./admin-release.ts";

// `pia facts release`'s plan is the hash of its (record, ruling) pairs, whatever their order, so
// the same records under another decision are another plan.
describe("planOf", () => {
  const a = { evidenceId: "e".repeat(64), ruling: "rul_01JABCDEFGHJKMNPQRSTVWXYZ0" };
  const b = { evidenceId: "f".repeat(64), ruling: "rul_01JABCDEFGHJKMNPQRSTVWXYZ1" };
  it("is the same for one set in any order, and differs when a record's ruling does", () => {
    expect(planOf([a, b])).toBe(planOf([b, a]));
    expect(planOf([a, b])).not.toBe(planOf([a, { ...b, ruling: "rul_01JABCDEFGHJKMNPQRSTVWXYZ2" }]));
    expect(planOf([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
