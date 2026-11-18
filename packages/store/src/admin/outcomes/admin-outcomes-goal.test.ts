import { describe, expect, it } from "vitest";
import type { Query } from "../../core/db.ts";
import { outcomeMetric } from "../../core/outcome-thresholds.ts";
import {
  type CloseCounts,
  defectsClosed,
  defectsClosedMetric,
  goalLine,
  ownerActions,
  ownerActionsMetric,
} from "./admin-outcomes-goal.ts";

// The goal's two measures with no database: the arithmetic, what counts as one act, what an idle
// system reads, and what the statements name. The counts on a real store are proven by the
// acceptance run (apps/pi/src/agents/acceptance.db.test.ts).

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-01-15T00:00:00.000Z";
const WEEK = "2026-01-05";
const ruling = (kind: string, n: number) => ({ source: "ruling", kind, week: WEEK, n });

function fake(answers: {
  acts?: object[];
  levers?: object[];
  full?: boolean;
  areas?: object[];
  closes?: object[];
  assigned?: boolean;
}): {
  query: Query;
  asked: string[];
} {
  const asked: string[] = [];
  const query = (async (text: string) => {
    asked.push(text);
    if (text.includes("as owner_command")) return answers.closes ?? [];
    if (text.includes("as assigned")) return [{ assigned: answers.assigned !== false }];
    if (text.includes("from policy.migrations")) return [{ full: answers.full === true }];
    if (text.includes("from knowledge.areas")) return answers.areas ?? [];
    if (text.includes("from policy.setting_changes")) return answers.levers ?? [];
    if (text.includes("from knowledge.owner_decisions")) return answers.acts ?? [];
    return [];
  }) as Query;
  return { query, asked };
}

describe("the owner's acts a week", () => {
  it("counts each act once, by what it was, and each command by its kind", () => {
    const metric = ownerActionsMetric(
      [
        ruling("answer", 30),
        ruling("owner_answer", 2),
        ruling("send", 3),
        ruling("send_settle", 1),
        ruling("task_tier", 1),
        ruling("release", 4),
        { source: "defect_closes", kind: null, week: WEEK, n: 2 },
        { source: "stops", kind: null, week: "2026-01-12", n: 1 },
      ],
      SINCE,
      UNTIL,
      true,
    );
    expect(metric).toMatchObject({
      metric: "owner_actions_per_week",
      value: 22,
      sample: 44,
      state: "failing",
      healthy: { test: "at_most", value: 20 },
      window: { fromDaysAgo: 14, toDaysAgo: 0 },
      parts: {
        card_answers: 30,
        owner_answers: 2,
        sends: 4,
        commands: 5,
        command_task_tier: 1,
        command_release: 4,
        defect_closes: 2,
        stops: 1,
        "week_2026-01-05": 43,
        "week_2026-01-12": 1,
      },
    });
  });

  it("reads ok at the line; with no act, ok and 0 over a full window, and no data on a store younger than the window", () => {
    expect(ownerActionsMetric([ruling("answer", 40)], SINCE, UNTIL, true)).toMatchObject({ value: 20, state: "ok" });
    expect(ownerActionsMetric([ruling("answer", 42)], SINCE, UNTIL, false)).toMatchObject({
      value: 21,
      state: "failing",
    });
    // The goal's best case: the owner did nothing for the whole window. It reads healthy, so a
    // defect filed while the acts were over the line recovers.
    const quiet = ownerActionsMetric([], SINCE, UNTIL, true);
    expect(quiet).toMatchObject({ value: 0, sample: 0, state: "ok", parts: {} });
    expect(quiet.code).toBeUndefined();
    const young = ownerActionsMetric([], SINCE, UNTIL, false);
    expect(young).toMatchObject({ value: null, sample: 0, state: "no_data", code: "window_not_full", parts: {} });
  });

  it("asks whether the store is as old as the window", async () => {
    const old = fake({ full: true });
    expect(await ownerActions(old.query, SINCE, UNTIL, ["own"])).toMatchObject({ value: 0, state: "ok" });
    expect(old.asked.find((text) => text.includes("from policy.migrations"))).toContain("min(m.applied_at) <= $1");
    expect(await ownerActions(fake({}).query, SINCE, UNTIL, ["own"])).toMatchObject({ state: "no_data" });
  });

  it("counts a run the owner asked for, a lesson changed and the mission set, each a part, a card's answer once", async () => {
    const { query, asked } = fake({
      acts: [
        ruling("answer", 1),
        { source: "runs_asked", kind: null, week: WEEK, n: 2 },
        { source: "lesson_changes", kind: null, week: WEEK, n: 3 },
        { source: "mission_set", kind: null, week: WEEK, n: 1 },
      ],
    });
    expect(await ownerActions(query, SINCE, UNTIL, ["own"])).toMatchObject({
      sample: 7,
      parts: { card_answers: 1, runs_asked: 2, lesson_changes: 3, mission_set: 1 },
    });
    const acts = asked.find((text) => text.includes("from knowledge.owner_decisions")) ?? "";
    expect(acts).toContain("r.row_kind = 'run' and r.event = 'queued' and r.by = 'owner'");
    expect(acts).toContain("r.row_kind = 'hypothesis' and r.event in ('confirmed', 'retired') and r.by = 'owner'");
    // A lesson a card's answer confirmed is that answer, no second act.
    expect(acts).toContain("a.kind = 'answer' and a.decided_at = r.at and a.compartments <@ $3::text[]");
    expect(acts).toContain("from projections.planner_mission m");
    expect(acts.match(/r\.compartments <@ \$3::text\[\]/g)).toHaveLength(2);
    expect(acts).toContain("m.compartments <@ $3::text[]");
  });

  it("leaves out code's rulings and a card answer's own effects, within the caller's label", async () => {
    const { query, asked } = fake({ acts: [ruling("answer", 1)] });
    expect(await ownerActions(query, SINCE, UNTIL, ["own"])).toMatchObject({ sample: 1, parts: { card_answers: 1 } });
    const acts = asked.find((text) => text.includes("from knowledge.owner_decisions")) ?? "";
    expect(acts).toContain("d.kind not in ('identity_policy', 'ruling_carry')");
    expect(acts).toContain("d.card_id is null");
    expect(acts).toContain("a.decided_at = d.decided_at and a.compartments <@ $3::text[]");
    expect(acts).toContain("d.compartments <@ $3::text[]");
    expect(acts).toContain("e.created_by = 'owner'");
    expect(acts).toContain("k.created_by = 'owner'");
    expect(acts).toContain("s.decided_by = 'owner'");
  });

  it("counts the owner's lever changes by the history's own columns", async () => {
    const there = fake({ levers: [{ source: "lever_changes", kind: null, week: WEEK, n: 3 }] });
    expect(await ownerActions(there.query, SINCE, UNTIL, ["own"])).toMatchObject({
      sample: 3,
      parts: { lever_changes: 3 },
    });
    // policy.setting_changes: `changed_by` and `at`.
    const read = there.asked.find((text) => text.includes("from policy.setting_changes")) ?? "";
    expect(read).toContain("c.changed_by = 'owner'");
    expect(read).toContain("c.at >= $1 and c.at <= $2");
  });

  it("counts the owner's area commands, within the caller's label", async () => {
    const there = fake({ areas: [{ source: "area_changes", kind: null, week: WEEK, n: 2 }] });
    expect(await ownerActions(there.query, SINCE, UNTIL, ["own"])).toMatchObject({
      sample: 2,
      parts: { area_changes: 2 },
    });
    const read = there.asked.find((text) => text.includes("from knowledge.areas")) ?? "";
    // The owner's word on a project's area, and each time an area's row was made or changed, once.
    expect(read).toContain("r.code = 'area' and r.by = 'owner'");
    expect(read).toContain("r.compartments <@ $3::text[]");
    expect(read.match(/a\.compartments <@ \$3::text\[\]/g)).toHaveLength(2);
    expect(read).toMatch(/a\.created_at as at[^)]*\n\s*union\n\s*select a\.updated_at/);
  });
});

describe("defects closed with no act of the owner's", () => {
  const counts = (closed: number, ownerCommand: number, more: Partial<CloseCounts> = {}): CloseCounts => ({
    closed,
    owner_command: ownerCommand,
    pr: 0,
    commit: 0,
    lever: 0,
    ops: 0,
    none: 0,
    recovered_untaken: 0,
    agent_closed: 0,
    closed_no_data: 0,
    ...more,
  });

  it("is the share of the defects closed that the owner ran no command on, with what each was taken with", () => {
    const metric = defectsClosedMetric(counts(10, 1, { lever: 2, pr: 3, recovered_untaken: 4, none: 1 }), SINCE, UNTIL);
    expect(metric).toMatchObject({ metric: "defects_closed_without_owner", value: 0.9, sample: 10, state: "ok" });
    // Each reference is a part of its own: a pull request an agent named is shown as that, and
    // nothing here counts it as a fix that worked.
    expect(metric.parts).toEqual({
      owner_command: 1,
      pr: 3,
      commit: 0,
      lever: 2,
      ops: 0,
      none: 1,
      recovered_untaken: 4,
      agent_closed: 0,
      closed_no_data: 0,
    });
    expect(defectsClosedMetric(counts(5, 3), SINCE, UNTIL)).toMatchObject({ value: 0.4, sample: 5, state: "failing" });
  });

  it("a defect that recovered with nothing named counts as closed without the owner", () => {
    expect(defectsClosedMetric(counts(9, 0, { recovered_untaken: 9 }), SINCE, UNTIL)).toMatchObject({
      value: 1,
      sample: 9,
      state: "ok",
    });
  });

  it("judges nothing under its sample, and nothing while the owner has assigned the defects to no role", () => {
    expect(defectsClosedMetric(counts(4, 4), SINCE, UNTIL)).toMatchObject({ state: "no_data", sample: 4 });
    expect(defectsClosedMetric(counts(9, 0, { recovered_untaken: 9 }), SINCE, UNTIL, false)).toMatchObject({
      value: null,
      sample: 9,
      state: "no_data",
      code: "no_defect_role",
    });
  });

  it("reads the close that stands and the owner's commands between the opening and it, within the caller's label", async () => {
    const { query, asked } = fake({ closes: [counts(1, 0, { lever: 1 })], assigned: true });
    expect(await defectsClosed(query, SINCE, UNTIL, ["own"])).toMatchObject({ value: 1, sample: 1 });
    const closes = asked.find((text) => text.includes("as owner_command")) ?? "";
    expect(closes).toContain("c.status in ('done', 'wont_do', 'duplicate')");
    // The owner's three commands on a defect: the dismissal, the role, a lever of its measure.
    expect(closes).toContain("c.created_by = 'owner'");
    expect(closes).toContain("i.owner_role_at >= o.opened_at and i.owner_role_at <= c.created_at");
    expect(closes).toContain("sc.changed_by = 'owner' and sc.at >= o.opened_at and sc.at <= c.created_at");
    expect(closes).toContain("i.cause = 'measure_floor:' || sc.measure or i.cause = 'lever_change:' || sc.key");
    // The reference is the latest an agent set before the close, by its kind alone.
    expect(closes).toContain("split_part(f.fix_ref, ':', 1)");
    expect(closes).toContain("f.created_at <= c.created_at");
    expect(closes).toContain("i.compartments <@ $3::text[]");
    expect(closes).toContain("e.compartments <@ $3::text[]");
    // With no role set, the same counts read as no data.
    const unset = fake({ closes: [counts(9, 0)], assigned: false });
    expect(await defectsClosed(unset.query, SINCE, UNTIL, ["own"])).toMatchObject({
      state: "no_data",
      code: "no_defect_role",
    });
  });
});

describe("the goal line", () => {
  it("holds the three numbers, the questions null while their read is not there", () => {
    const measures = {
      ownerActions: ownerActionsMetric([], SINCE, UNTIL, false),
      defectsWithoutOwner: defectsClosedMetric(
        {
          closed: 0,
          owner_command: 0,
          pr: 0,
          commit: 0,
          lever: 0,
          ops: 0,
          none: 0,
          recovered_untaken: 0,
          agent_closed: 0,
          closed_no_data: 0,
        },
        SINCE,
        UNTIL,
      ),
    };
    const questions = outcomeMetric("owner_questions_per_week", { value: 3, sample: 6, window: null });
    expect(goalLine(measures, [questions])).toEqual({ ...measures, ownerQuestions: questions });
    expect(goalLine(measures, []).ownerQuestions).toBeNull();
  });
});
