import { describe, expect, it } from "vitest";
import {
  capOf,
  checkAnswer,
  finalScore,
  HELD_OUT_CLASSES,
  HELD_OUT_COUNT,
  OUTCOME_TASKS,
  OutcomeTestTask,
} from "./self-measure.ts";

const today = "2026-06-15";
const answer = (
  items: { section: string; text: string; date?: string; sources?: string[] }[],
  text = "An answer.",
) => ({
  answer: text,
  items: items.map((item) => ({ sources: [], ...item })),
});
const task = (id: string) => {
  const found = OUTCOME_TASKS.find((one) => one.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const judged = (id: string, value: Parameters<typeof checkAnswer>[1], used: string[], seen: (ref: string) => boolean) =>
  checkAnswer(task(id).checks, value, { today, used: new Set(used), seen });

describe("the outcome test's data", () => {
  it("holds eight visible tasks, each with four levels, and as many held out", () => {
    expect(OUTCOME_TASKS).toHaveLength(8);
    expect(HELD_OUT_CLASSES).toHaveLength(HELD_OUT_COUNT);
    expect(HELD_OUT_COUNT).toBe(OUTCOME_TASKS.length);
    for (const one of OUTCOME_TASKS) {
      expect(OutcomeTestTask.safeParse(one).success).toBe(true);
      expect(one.rubric).toHaveLength(4);
    }
    expect(new Set(OUTCOME_TASKS.map((one) => one.id)).size).toBe(8);
  });
});

describe("the checks code can make", () => {
  it("a missing section fails and caps the score", () => {
    const results = judged("what_is_owed", answer([]), ["get_commitments"], () => true);
    const failed = results.filter((one) => !one.passed).map((one) => one.code);
    expect(failed).toContain("section:owed");
    expect(capOf(results)).toBeLessThan(3);
  });

  it("a cited id no tool gave fails as an unresolved source, and none cited fails too", () => {
    const code = "sources_resolve";
    const made = answer([{ section: "owed", text: "x", sources: ["msg_made_up"] }]);
    expect(
      judged("what_is_owed", made, ["get_commitments"], () => false).find((one) => one.code === code)?.passed,
    ).toBe(false);
    const none = answer([{ section: "owed", text: "x" }]);
    expect(judged("what_is_owed", none, ["get_commitments"], () => true).find((one) => one.code === code)?.passed).toBe(
      false,
    );
  });

  it("an overdue date in the future fails; one past passes; a date that is no date fails", () => {
    const of = (date: string) =>
      judged(
        "what_is_owed",
        answer([
          { section: "overdue", text: "x", date, sources: ["msg_a"] },
          { section: "owed", text: "y", sources: ["msg_a"] },
        ]),
        ["get_commitments"],
        () => true,
      ).find((one) => one.code === "past:overdue")?.passed;
    expect(of("2026-06-20")).toBe(false);
    expect(of("2026-06-01")).toBe(true);
    expect(of("soon")).toBe(false);
  });

  it("the projects task credits the project tools' reads, and its cap still holds for mail", () => {
    const value = answer([
      { section: "project", text: "x", sources: ["msg_a"] },
      { section: "decision", text: "y", sources: ["msg_a"] },
      { section: "next_step", text: "z", sources: ["msg_a"] },
    ]);
    const usedPassed = (used: string[]) =>
      judged("projects", value, used, () => true).find((one) => one.code === "used:get_entity")?.passed;
    expect(usedPassed(["list_projects"])).toBe(true);
    expect(usedPassed(["get_project"])).toBe(true);
    expect(usedPassed(["get_timeline"])).toBe(true);
    expect(usedPassed(["find_messages", "search"])).toBe(false);
    expect(task("projects").checks.find((one) => one.kind === "used")).toEqual({
      kind: "used",
      tools: ["get_entity", "get_timeline", "find_facts", "list_projects", "get_project"],
      capOnFail: 2,
    });
  });

  it("the designed tool not called fails: an answer pieced from mail shows it", () => {
    const value = answer([{ section: "owed", text: "x", sources: ["msg_a"] }]);
    const failed = judged("what_is_owed", value, ["find_messages"], () => true)
      .filter((one) => !one.passed)
      .map((one) => one.code);
    expect(failed).toContain("used:get_commitments");
  });

  it("an empty answer caps at zero; the judge never lifts a score over what code allows", () => {
    expect(capOf(judged("what_is_owed", answer([], "  "), [], () => true))).toBe(0);
    expect(finalScore(1, 3)).toBe(1);
    expect(finalScore(3, 2)).toBe(2);
    expect(finalScore(0, null)).toBe(0);
    expect(finalScore(2, null)).toBeNull();
  });
});
