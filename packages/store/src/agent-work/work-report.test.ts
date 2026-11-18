import { describe, expect, it } from "vitest";
import { citedOf, fillOf, reportRefusals } from "./work-report.ts";

const task = {
  stage: "investigate" as const,
  opportunity_id: "opp_x",
  kind: "investigate" as const,
  tier: "task" as const,
  about_kind: "entity",
  about_id: "ent_x",
};
const done = {
  move: "mov_x",
  outcome: "done" as const,
  report: { deliverable: "Three people run it.", next: "Ask who knows them." },
};

describe("a task's done report", () => {
  it("needs a source and a write-back, each by its code", () => {
    expect(reportRefusals(task, done)).toEqual(["needs_sources", "needs_writeback"]);
    expect(reportRefusals(task, { ...done, report: { ...done.report, sources: ["a web page"] } })).toEqual([
      "needs_writeback",
    ]);
    expect(reportRefusals(task, { ...done, report: { ...done.report, sources: ["a web page"] } }, true)).toEqual([]);
  });

  it("asks neither of an opportunity, nor of a task's earlier stage, nor of a failed report", () => {
    expect(reportRefusals({ ...task, tier: "opportunity" }, done)).toEqual([]);
    expect(reportRefusals({ ...task, kind: "goal_step" }, done)).toEqual([]);
    expect(
      reportRefusals(task, { move: "mov_x", outcome: "failed", report: { reason: "Nothing worth keeping." } }),
    ).toEqual([]);
  });
});

describe("an explore task's fill", () => {
  const explore = { ...task, kind: "research" as const, gap_trigger: "explore", gap_missing: ["role", "identity"] };
  const sources = ["https://example.org/team"];
  const role = { title: "Head of Research", organization: { name: "Northwind" }, sources };
  const withFill = (fill: object) => ({ ...done, report: { ...done.report, sources, fill } }) as never;

  it("is needed for done, with a listed field", () => {
    expect(reportRefusals(explore, { ...done, report: { ...done.report, sources } }, true)).toEqual(["needs_fill"]);
    expect(reportRefusals(explore, withFill({ links: { urls: ["https://ada.example.org"], sources } }), true)).toEqual([
      "needs_fill",
    ]);
    expect(reportRefusals(explore, withFill({ role }), true)).toEqual([]);
  });

  it("is not needed for failed with a reason", () => {
    expect(
      reportRefusals(explore, { move: "mov_x", outcome: "failed", report: { reason: "Nothing public." } }),
    ).toEqual([]);
  });

  it("drops what is not listed, and an identifier that does not read, counting each", () => {
    expect(fillOf(explore, withFill({ role, links: { urls: ["https://ada.example.org"], sources } }))).toEqual({
      fill: { role },
      dropped: 1,
    });
    expect(fillOf(explore, withFill({ role, identity: { email: "not an address", sources } }))).toEqual({
      fill: { role },
      dropped: 1,
    });
    const identity = { linkedin: "https://www.linkedin.com/in/ada-example/", sources };
    expect(fillOf(explore, withFill({ identity }))).toEqual({ fill: { identity }, dropped: 0 });
    expect(reportRefusals(explore, withFill({ identity: { email: "not an address", sources } }), true)).toEqual([
      "needs_fill",
    ]);
  });

  it("is refused on any other task's report", () => {
    expect(reportRefusals(task, withFill({ role }), true)).toEqual(["fill_not_explore"]);
    expect(fillOf({ ...explore, gap_trigger: "no_warm_path" }, withFill({ role }))).toEqual({ fill: null, dropped: 0 });
  });
});

describe("a card task's report", () => {
  const cardTask = { ...task, kind: "research" as const, gap_trigger: "card_question", gap_subject: "crd_x" };
  const cited = { ...done.report, sources: ["a web page"] };

  it("is done only with an answer, beside what every task's done report needs", () => {
    expect(reportRefusals(cardTask, { ...done, report: cited }, true)).toEqual(["needs_card_answer"]);
    expect(reportRefusals(cardTask, { ...done, report: { ...cited, card: { answer: "same" } } }, true)).toEqual([]);
    expect(reportRefusals(cardTask, { ...done, report: { ...cited, card: { answer: "same" } } })).toEqual([
      "needs_writeback",
    ]);
  });

  it("takes no answer on a failed report, nor on any other task's", () => {
    expect(
      reportRefusals(cardTask, {
        move: "mov_x",
        outcome: "failed",
        report: { reason: "Nothing to read.", card: { answer: "same" } },
      }),
    ).toEqual(["card_not_asked"]);
    expect(reportRefusals(task, { ...done, report: { ...cited, card: { answer: "same" } } }, true)).toEqual([
      "card_not_asked",
    ]);
    expect(
      reportRefusals(cardTask, { move: "mov_x", outcome: "failed", report: { reason: "Nothing to read." } }),
    ).toEqual([]);
  });
});

describe("the refs an agent ruling keeps of a report's sources", () => {
  it("keeps a ref by id in the ruling's form, and leaves out an address, a handle and any other form", () => {
    expect(
      citedOf([
        { kind: "agent_record", id: "rec_01" },
        { kind: "message", id: "msg-with-dash" },
        { kind: "kind2", id: "x_1" },
        "https://example.org/page",
        { kind: "message", id: "hdl_abc" },
        { kind: "Bad", id: "x" },
        { kind: "message", id: "has space" },
      ]),
    ).toEqual([
      { kind: "agent_record", id: "rec_01" },
      { kind: "message", id: "msg-with-dash" },
      { kind: "kind2", id: "x_1" },
    ]);
  });
});
