import { describe, expect, it } from "vitest";
import { reportSummary } from "./admin-work-report.ts";

// `pi work report`'s summary: the window's proposals by prompt version and kind, read from the
// stored words, so a new prompt, kind or answer shows with no change.

const v2 = { id: "personal_run", version: "2" };
const v3 = { id: "personal_run", version: "3" };
const opportunity = (prompt: typeof v2, kind: string, status: string, answer: string | null) => ({
  prompt,
  rowKind: "opportunity" as const,
  kind,
  status,
  answer,
});

describe("the work report's summary", () => {
  it("groups by prompt version, row kind and kind, counts the owner's answers and statuses, and rates approval over the answered", () => {
    const summary = reportSummary([
      opportunity(v3, "goal_step", "no_go", "no_go"),
      opportunity(v2, "goal_step", "go", "go"),
      opportunity(v3, "goal_step", "go", "go"),
      opportunity(v3, "goal_step", "go", "go"),
      opportunity(v3, "goal_step", "proposed", null),
      opportunity(v3, "follow_up", "later", "later"),
      { prompt: v3, rowKind: "hypothesis", kind: "open_loop", status: "confirmed", answer: "confirm" },
      { prompt: v3, rowKind: "hypothesis", kind: "open_loop", status: "rejected", answer: "reject" },
      { prompt: v3, rowKind: "hypothesis", kind: "open_loop", status: "supported", answer: null },
    ]);
    expect(summary).toEqual([
      {
        prompt: v2,
        rowKind: "opportunity",
        kind: "goal_step",
        proposed: 1,
        answers: { go: 1 },
        statuses: { go: 1 },
        approved: 1,
        approvalRate: 1,
      },
      {
        prompt: v3,
        rowKind: "hypothesis",
        kind: "open_loop",
        proposed: 3,
        answers: { confirm: 1, reject: 1 },
        statuses: { confirmed: 1, rejected: 1, supported: 1 },
        approved: 1,
        approvalRate: 0.5,
      },
      {
        prompt: v3,
        rowKind: "opportunity",
        kind: "follow_up",
        proposed: 1,
        answers: { later: 1 },
        statuses: { later: 1 },
        approved: 0,
        approvalRate: 0,
      },
      {
        prompt: v3,
        rowKind: "opportunity",
        kind: "goal_step",
        proposed: 4,
        answers: { go: 2, no_go: 1 },
        statuses: { go: 2, no_go: 1, proposed: 1 },
        approved: 2,
        approvalRate: 2 / 3,
      },
    ]);
  });

  it("a prompt, kind or answer it has never seen is a group of its own, and nothing answered rates null", () => {
    const idea = { id: "personal_ideas", version: "1" };
    expect(
      reportSummary([
        { prompt: idea, rowKind: "hypothesis", kind: "idea", status: "open", answer: "pursue" },
        { prompt: idea, rowKind: "hypothesis", kind: "idea", status: "open", answer: "not_now" },
      ]),
    ).toEqual([
      {
        prompt: idea,
        rowKind: "hypothesis",
        kind: "idea",
        proposed: 2,
        answers: { not_now: 1, pursue: 1 },
        statuses: { open: 2 },
        approved: 1,
        approvalRate: 0.5,
      },
    ]);
    expect(reportSummary([opportunity(v3, "reply", "proposed", null)])[0]).toMatchObject({
      answers: {},
      approved: 0,
      approvalRate: null,
    });
    // A stored word is an own key, never the object's prototype.
    const odd = reportSummary([opportunity(v3, "reply", "__proto__", "__proto__")])[0];
    expect(Object.keys(odd?.statuses ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(odd?.answers)).toBe(Object.prototype);
    expect(reportSummary([])).toEqual([]);
  });
});
