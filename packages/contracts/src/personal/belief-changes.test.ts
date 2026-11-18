import { BeliefChangeReport, PersonalBeliefChange, PersonalWakeSource } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Made-up values only.
const change = {
  factKeyFp: "a".repeat(64),
  audience: ["employer:acme", "own"],
  kind: "commitment",
  event: "state_changed",
  changeKind: "live",
};
const accepts = (value: unknown): boolean => PersonalBeliefChange.safeParse(value).success;

describe("PersonalBeliefChange", () => {
  it("takes a fact key fingerprint, a sorted audience, a belief kind, the event and the deciding claim's change kind", () => {
    expect(accepts(change)).toBe(true);
    expect(accepts({ ...change, event: "review_due", changeKind: "backfill" })).toBe(true);
    expect(accepts({ ...change, changeKind: "reprocess" })).toBe(true);
  });

  it("refuses a fact key that is not a fingerprint, and an audience that is empty, unsorted, repeated or not personal", () => {
    expect(accepts({ ...change, factKeyFp: "commitment:alex" })).toBe(false);
    expect(accepts({ ...change, audience: [] })).toBe(false);
    expect(accepts({ ...change, audience: ["own", "employer:acme"] })).toBe(false);
    expect(accepts({ ...change, audience: ["own", "own"] })).toBe(false);
    expect(accepts({ ...change, audience: ["team"] })).toBe(false);
  });

  it("refuses a kind that is no belief kind, an event it does not name, and any other key", () => {
    expect(accepts({ ...change, kind: "purchase" })).toBe(false);
    expect(accepts({ ...change, event: "removed" })).toBe(false);
    for (const key of ["label", "compartments", "values", "due", "subject", "text"])
      expect(accepts({ ...change, [key]: "x" })).toBe(false);
  });

  it("is reported as a list, at most one entry for one fact key and audience", () => {
    expect(BeliefChangeReport.safeParse([change, { ...change, audience: ["own"] }]).success).toBe(true);
    expect(BeliefChangeReport.safeParse([change, { ...change, event: "review_due" }]).success).toBe(false);
  });
});

describe("the commitment wake source", () => {
  it("commitment_due and belief_changed are wake sources", () => {
    expect(PersonalWakeSource.options).toContain("commitment_due");
    expect(PersonalWakeSource.options).toContain("belief_changed");
  });
});
