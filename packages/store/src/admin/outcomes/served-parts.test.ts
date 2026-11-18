import { describe, expect, it } from "vitest";
import { OUTCOME_THRESHOLDS, topPeopleParts } from "../../core/outcome-thresholds.ts";
import { partsOf } from "./admin-improvements.ts";
import { defectsClosedMetric, ownerActionsMetric } from "./admin-outcomes-goal.ts";
import { mergeAuditMetric } from "./admin-outcomes-merges.ts";
import { OWNER_ONLY_PARTS, SERVED_PARTS, servedPartKey } from "./served-parts.ts";

// The parts a reading keeps, and so get_health serves: a closed list for each measure, and never a
// part counted over rows the reading's label does not bound.

describe("the parts a reading keeps", () => {
  it("names only measures there are, and admits each measure's own parts", () => {
    for (const metric of Object.keys(SERVED_PARTS)) expect(Object.keys(OUTCOME_THRESHOLDS), metric).toContain(metric);
    const metrics = [
      ownerActionsMetric(
        [
          { source: "ruling", kind: "answer", week: "2026-11-02", n: 3 },
          { source: "ruling", kind: "task_cancel", week: "2026-11-02", n: 1 },
          { source: "lever_changes", kind: null, week: "2026-11-09", n: 2 },
          { source: "relayed", kind: null, week: "2026-11-09", n: 1 },
        ],
        "2026-10-12T00:00:00.000Z",
        "2026-11-11T00:00:00.000Z",
        true,
      ),
      defectsClosedMetric(
        {
          closed: 4,
          owner_command: 1,
          pr: 1,
          commit: 0,
          lever: 1,
          ops: 0,
          none: 0,
          recovered_untaken: 1,
          agent_closed: 0,
          closed_no_data: 1,
        },
        "2026-10-12T00:00:00.000Z",
        "2026-11-11T00:00:00.000Z",
      ),
      mergeAuditMetric({ audited: 3, found_wrong: 1, split: 1, waiting_owner: 0 }, 30),
    ];
    for (const one of metrics) {
      const keys = Object.keys(one.parts ?? {});
      expect(keys.length, one.metric).toBeGreaterThan(0);
      for (const key of keys) expect(servedPartKey(one.metric, key), `${one.metric}.${key}`).toBe(true);
      // And all of them are kept.
      expect(Object.keys(JSON.parse(partsOf(one.metric, one.parts) ?? "{}")).sort(), one.metric).toEqual(keys.sort());
    }
    for (const key of Object.keys(topPeopleParts([{ beliefs: 0, fresh: false }])))
      expect(servedPartKey("top_people_filled", key), key).toBe(true);
    for (const key of ["meeting_soon", "now_go", "defect_now_withdrawn"])
      expect(servedPartKey("gap_tasks_raised_per_day", key), key).toBe(true);
    for (const key of ["waiting", "asked", "unreadable", "other", "skipped", "bulk", "model_unavailable"])
      expect(servedPartKey("capture_to_claim_24h_moments", key), key).toBe(true);
    for (const key of ["role:engineering", "role:chief-of-staff"])
      expect(servedPartKey("roles_unattended", key), key).toBe(true);
  });

  it("drops a key its measure's list does not hold, a measure with no list, and every part an erasure counts", () => {
    expect(partsOf("defects_closed_without_owner", { pr: 1, somebody_s_name: 2, "Free Text": 3 })).toBe('{"pr":1}');
    expect(partsOf("gap_tasks_raised_per_day", { not_a_trigger: 1, now_not_a_status: 1 })).toBeNull();
    expect(partsOf("capture_to_claim_24h_moments", { a_made_up_code: 4, asked: 1 })).toBe('{"asked":1}');
    expect(partsOf("backup_age_days", { erased_since_dump: 1, days_since_erasure: 2 })).toBeNull();
    expect(partsOf("nightly_red", { anything: 1 })).toBeNull();
    expect(partsOf("roles_unattended", { "role:engineering": 3, "role:Some Name": 1, engineering: 2 })).toBe(
      '{"role:engineering":3}',
    );
    for (const key of OWNER_ONLY_PARTS)
      for (const metric of Object.keys(OUTCOME_THRESHOLDS))
        expect(servedPartKey(metric, key), `${metric}.${key}`).toBe(false);
    expect(partsOf("owner_actions_per_week", undefined)).toBeNull();
  });
});
