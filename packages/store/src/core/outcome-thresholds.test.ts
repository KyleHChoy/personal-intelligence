import { describe, expect, it } from "vitest";
import {
  commitmentEnds,
  commitmentsEndedShares,
  goalPeopleTasksMetric,
  OUTCOME_THRESHOLDS,
  type OutcomeName,
  outcomeMetric,
  outcomeState,
  refusalRateOf,
  shareOf,
  topPeopleParts,
  usageStateOf,
} from "./outcome-thresholds.ts";

// `pi outcomes`'s judgement, with no database: a small sample judges nothing, each threshold's edge
// falls on the side its test says, and a zero is unused, never a failure.

describe("a commitment let go", () => {
  it("is no broken promise: the done share is over what was kept or dropped, the let go counted apart", () => {
    const { value, sample, parts } = commitmentsEndedShares({ sample: 25, hits: 9, released: 16 }).done;
    expect({ value, sample, parts }).toEqual({
      value: 1,
      sample: 9,
      parts: { done: 9, not_done: 0, released: 16, aged_out: 0 },
    });
  });

  it("reads a high share let go as low: what was raised was not an obligation", () => {
    const { released } = commitmentsEndedShares({ sample: 25, hits: 9, released: 16 });
    expect(released).toMatchObject({ value: 0.64, sample: 25, state: "failing" });
  });
});

describe("goal people tasks", () => {
  it("says no target rather than low while no active goal has one", () => {
    expect(goalPeopleTasksMetric({ raised: 0, targeted: 0 }, 14)).toMatchObject({
      value: 0,
      sample: 0,
      state: "no_data",
      code: "no_goal_targets",
    });
    expect(goalPeopleTasksMetric({ raised: 2, targeted: 1 }, 14)).toMatchObject({
      value: 1,
      sample: 1,
      state: "failing",
    });
  });
});

describe("top people", () => {
  it("says what each one lacks", () => {
    expect(
      topPeopleParts([
        { beliefs: 3, fresh: true },
        { beliefs: 0, fresh: false },
        { beliefs: 1, fresh: true },
        { beliefs: 5, fresh: false },
      ]),
    ).toEqual({ filled: 1, no_beliefs: 1, few_beliefs: 1, not_fresh: 1 });
  });
});

describe("outcome state", () => {
  it("is no_data under the metric's sample, whatever the value says", () => {
    for (const name of Object.keys(OUTCOME_THRESHOLDS) as OutcomeName[]) {
      const { minSample, healthy } = OUTCOME_THRESHOLDS[name];
      expect(outcomeState(name, healthy, minSample - 1)).toBe("no_data");
      expect(outcomeState(name, null, minSample)).toBe("no_data");
      expect(outcomeState(name, healthy + 1000, minSample)).not.toBe("no_data");
    }
  });

  it("holds at_least's edge as ok and just under it as low", () => {
    expect(outcomeState("mail_to_claim_24h", 0.4, 20)).toBe("ok");
    expect(outcomeState("mail_to_claim_24h", 0.399, 20)).toBe("failing");
    expect(outcomeState("capture_to_claim_24h_meetings", 0.9, 3)).toBe("ok");
    expect(outcomeState("capture_to_claim_24h_moments", 0.1, 20)).toBe("ok");
    expect(outcomeState("capture_to_claim_24h_moments", 0.099, 20)).toBe("failing");
    expect(outcomeState("moment_fact_read_back_7d", 0.2, 5)).toBe("ok");
    expect(outcomeState("own_lines_claims_per_moment", 0.2, 5)).toBe("ok");
    expect(outcomeState("own_lines_claims_per_moment", 0.19, 5)).toBe("failing");
    expect(outcomeState("done_work_per_week", 5, 3)).toBe("ok");
    expect(outcomeState("done_work_per_week", 4.9, 3)).toBe("failing");
  });

  it("holds under's edge as low and at_most's as ok", () => {
    expect(outcomeState("median_days_to_done", 7, 3)).toBe("failing");
    expect(outcomeState("median_days_to_done", 6.9, 3)).toBe("ok");
    expect(outcomeState("reasked_after_answer", 0.05, 10)).toBe("failing");
    expect(outcomeState("reasked_after_answer", 0.049, 10)).toBe("ok");
    expect(outcomeState("backup_age_days", 8, 1)).toBe("ok");
    expect(outcomeState("backup_age_days", 8.01, 1)).toBe("failing");
  });
});

describe("outcome metric", () => {
  it("carries its value, sample and threshold, and a code only with no data", () => {
    const window = { fromDaysAgo: 7, toDaysAgo: 1 };
    expect(outcomeMetric("mail_to_claim_24h", { value: 1 / 3, sample: 30, window })).toEqual({
      metric: "mail_to_claim_24h",
      value: 0.333,
      sample: 30,
      healthy: { test: "at_least", value: 0.4 },
      minSample: 20,
      window,
      state: "failing",
    });
    const small = outcomeMetric("mail_to_claim_24h", { value: 1, sample: 2, window });
    expect(small).toMatchObject({ value: 1, sample: 2, state: "no_data", code: "small_sample" });
  });

  it("judges the value before it is rounded", () => {
    const metric = outcomeMetric("mail_to_claim_24h", { value: 0.3996, sample: 20, window: null });
    expect(metric).toMatchObject({ value: 0.4, state: "failing" });
  });

  it("gives the read's own reason for having no data", () => {
    const metric = outcomeMetric("backup_age_days", {
      value: null,
      sample: 0,
      window: null,
      code: "no_backup_recorded",
    });
    expect(metric).toMatchObject({ value: null, state: "no_data", code: "no_backup_recorded" });
  });
});

describe("usage", () => {
  it("reports a zero as unused, never as a failure", () => {
    expect(usageStateOf(0)).toBe("unused");
    expect(usageStateOf(1)).toBe("used");
  });

  it("gives a tool nobody called no refusal rate, and a share with no calls none", () => {
    expect(refusalRateOf(0, 0)).toBeNull();
    expect(refusalRateOf(1, 3)).toBe(0.333);
    expect(shareOf(0, 0)).toBeNull();
    expect(shareOf(1, 4)).toBe(0.25);
  });
});

describe("how commitments ended", () => {
  const closed = (
    closedAt: string,
    ending: "done" | "cancelled" | "released" | null,
    doneAt: string | null = null,
  ) => ({ closedAt, doneAt, ending, due: null });
  const lapsed = (on: string, due: string | null = "2026-05-01") =>
    ({ closedAt: null, doneAt: null, ending: null, lapsed: on, due }) as const;
  const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

  it("counts done, by a close or a source, against let go, cancelled and a lapse in silence", () => {
    expect(
      commitmentEnds(
        [
          closed("2026-06-10T00:00:00.000Z", "done"),
          closed("2026-06-11T00:00:00.000Z", null, "2026-06-11T00:00:00.000Z"),
          closed("2026-06-12T00:00:00.000Z", "released"),
          closed("2026-06-13T00:00:00.000Z", "cancelled"),
          closed("2026-06-14T00:00:00.000Z", null),
          lapsed("2026-06-05"),
        ],
        WINDOW,
        null,
      ),
    ).toEqual({ sample: 6, hits: 2, released: 1, aged: 0, releasedByAgent: 0 });
  });

  it("counts as let go by the owner only the owner's release: an agent's says the other side let them off", () => {
    const byAgent = {
      ...closed("2026-06-12T00:00:00.000Z", "released"),
      closedBy: { agent: "helper", close: "rec_01J0000000000000000000000A" },
    };
    const byOwner = {
      ...closed("2026-06-13T00:00:00.000Z", "released"),
      closedBy: { owner: true, close: "rul_01J0000000000000000000000A" },
    };
    const ends = commitmentEnds(
      [closed("2026-06-10T00:00:00.000Z", "done"), byAgent, byOwner] as Parameters<typeof commitmentEnds>[0],
      WINDOW,
      null,
    );
    expect(ends).toEqual({ sample: 3, hits: 1, released: 2, aged: 0, releasedByAgent: 1 });
    const shares = commitmentsEndedShares(ends);
    // Let go either way, so neither is a promise broken.
    expect(shares.done).toMatchObject({ value: 1, sample: 1 });
    expect(shares.released).toMatchObject({
      value: 0.333,
      sample: 3,
      parts: { by_owner: 1, by_agent: 1 },
    });
  });

  it("places a lapse on the day its own marker names, so a reopen moves it; a close with no day is left out", () => {
    expect(
      commitmentEnds(
        [
          closed("2026-05-31T00:00:00.000Z", "done"),
          lapsed("2026-06-01"),
          lapsed("2026-05-31"),
          lapsed("2026-07-01"),
          { closedAt: null, doneAt: null, ending: null, due: null },
        ],
        WINDOW,
        null,
      ),
    ).toEqual({ sample: 1, hits: 0, released: 0, aged: 0, releasedByAgent: 0 });
  });

  it("leaves an undated line that aged out of what was kept, as one let go, and a dated lapse in it", () => {
    const ends = commitmentEnds(
      [closed("2026-06-10T00:00:00.000Z", "done"), lapsed("2026-06-05", null), lapsed("2026-06-06")],
      WINDOW,
      null,
    );
    expect(ends).toEqual({ sample: 3, hits: 1, released: 0, aged: 1, releasedByAgent: 0 });
    expect(commitmentsEndedShares(ends).done).toMatchObject({
      value: 0.5,
      sample: 2,
      parts: { done: 1, not_done: 1, released: 0, aged_out: 1 },
    });
  });
});
