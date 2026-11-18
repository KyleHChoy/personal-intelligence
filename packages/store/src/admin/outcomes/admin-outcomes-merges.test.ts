import { describe, expect, it } from "vitest";
import { mergeAuditMetric } from "./admin-outcomes-merges.ts";

describe("policy_merges_wrong_share", () => {
  it("is the share of audited merges an agent reported wrong, with its parts", () => {
    const metric = mergeAuditMetric({ audited: 20, found_wrong: 3, split: 2, waiting_owner: 1 }, 30);
    expect(metric).toMatchObject({
      metric: "policy_merges_wrong_share",
      value: 0.15,
      sample: 20,
      state: "failing",
      parts: { audited: 20, found_wrong: 3, split: 2, waiting_owner: 1 },
    });
  });

  it("reads ok when none of enough audits was wrong, and no data on too few", () => {
    expect(mergeAuditMetric({ audited: 10, found_wrong: 0, split: 0, waiting_owner: 0 }, 30).state).toBe("ok");
    expect(mergeAuditMetric({ audited: 2, found_wrong: 1, split: 0, waiting_owner: 0 }, 30)).toMatchObject({
      state: "no_data",
      code: "small_sample",
    });
    expect(mergeAuditMetric({ audited: 0, found_wrong: 0, split: 0, waiting_owner: 0 }, 30).value).toBeNull();
  });
});
