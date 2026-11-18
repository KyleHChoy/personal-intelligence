import { PersonalWakeSource } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { isPlanner, plannerOf, runPlanOf, stageRuns } from "./run-plan.ts";

// Under `research_only` a wake queues only a lessons run; `split` and `one_pass` queue every wake's
// run.
describe("the planner's modes", () => {
  it("research_only queues only lessons runs", () => {
    const runs = PersonalWakeSource.options.filter((source) => stageRuns(source, "research_only"));
    expect(runs).toEqual(["lessons_due"]);
    for (const source of PersonalWakeSource.options) {
      expect(stageRuns(source, "split")).toBe(true);
      expect(stageRuns(source, "one_pass")).toBe(true);
    }
  });

  it("plans a lessons run under research_only as under split, and refuses the rest", () => {
    expect(runPlanOf("lessons_due", "research_only")).toEqual(runPlanOf("lessons_due", "split"));
    expect(runPlanOf("lessons_due", "research_only").promptId).toBe("personal_lessons");
    for (const source of [
      "daily_sweep",
      "calendar",
      "goal_changed",
      "owner_request",
      "commitment_due",
      "belief_changed",
      "idea_pursued",
    ] as const) {
      expect(() => runPlanOf(source, "research_only")).toThrow();
    }
    expect(runPlanOf("daily_sweep", "split").promptId).toBe("personal_ideas");
  });

  it("under one_pass an ideas-stage wake runs personal_run 4, found by id, and every other wake its stage's prompt, all at run_outcome 13", () => {
    const plan = (prompt: string) => ({
      version: 13,
      promptId: prompt.split("@")[0],
      promptVersion: prompt.split("@")[1],
    });
    const want: Record<"split" | "one_pass", Record<string, string>> = {
      split: {
        ideas: "personal_ideas@4",
        translate: "personal_translate@5",
        lessons: "personal_lessons@4",
      },
      one_pass: {
        ideas: "personal_run@4",
        translate: "personal_translate@5",
        lessons: "personal_lessons@4",
      },
    };
    const stageOf = { idea_pursued: "translate", lessons_due: "lessons" } as Record<string, string>;
    for (const planner of ["split", "one_pass"] as const) {
      for (const source of PersonalWakeSource.options) {
        expect(runPlanOf(source, planner), `${planner} ${source}`).toEqual(
          plan(want[planner][stageOf[source] ?? "ideas"] as string),
        );
      }
    }
  });

  it("reads the owner's mode from the settings row, and a missing row is a fault, never a default", async () => {
    const rows = (planner: string[]) => (async () => planner.map((one) => ({ planner: one }))) as never;
    expect(await plannerOf(rows(["research_only"]))).toBe("research_only");
    expect(await plannerOf(rows(["split"]))).toBe("split");
    await expect(plannerOf(rows([]))).rejects.toThrow();
  });

  it("knows its three modes and nothing else", () => {
    expect(["split", "one_pass", "research_only"].every(isPlanner)).toBe(true);
    expect(["ideas", "off", "", undefined, 1].some(isPlanner)).toBe(false);
  });
});
