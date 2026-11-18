import { describe, expect, it } from "vitest";
import {
  minimumCloses,
  modelHold,
  type OutcomeFlowLink,
  type OutcomeFlowWork,
  outcomeStatus,
  planOutcome,
} from "./outcome-flow.ts";

// The tick's rule for an applied outcome link, pure.

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 86_400_000;
const work = (patch: Partial<OutcomeFlowWork> = {}): OutcomeFlowWork => ({
  status: "claimed",
  statusAt: new Date(NOW.getTime() - DAY),
  tainted: false,
  links: [],
  raisedPairs: new Set(),
  ...patch,
});
const link = (
  id: number,
  kind: OutcomeFlowLink["kind"],
  expectation: string | null = "7",
  evidence: string | null = "a".repeat(64),
): OutcomeFlowLink => ({ id, kind, expectation, evidence });

describe("planOutcome", () => {
  it("met closes worked work outcome_met, not_met outcome_not_met; partial and advances close nothing; each wakes", () => {
    for (const status of ["claimed", "handed_to_owner", "done"] as const) {
      expect(planOutcome(work({ status, links: [link(1, "met")] }), NOW, 90)).toEqual({
        status: "outcome_met",
        decidedBy: 1,
        wake: 1,
        counted: 1,
      });
      expect(planOutcome(work({ status, links: [link(1, "not_met")] }), NOW, 90)).toEqual({
        status: "outcome_not_met",
        decidedBy: 1,
        wake: 1,
        counted: 1,
      });
      for (const kind of ["partial", "advances"] as const)
        expect(planOutcome(work({ status, links: [link(1, kind)] }), NOW, 90)).toEqual({
          status: null,
          decidedBy: null,
          wake: 1,
          counted: 1,
        });
    }
  });

  it("work not yet worked keeps its status and its agent is told", () => {
    for (const status of ["proposed", "later", "go"] as const)
      expect(planOutcome(work({ status, links: [link(3, "met")] }), NOW, 90)).toEqual({
        status: null,
        decidedBy: null,
        wake: 3,
        counted: 1,
      });
  });

  it("a late met within the grace reopens outcome_not_met as outcome_met; past the grace nothing moves", () => {
    expect(
      planOutcome(
        work({ status: "outcome_not_met", statusAt: new Date(NOW.getTime() - 89 * DAY), links: [link(4, "met")] }),
        NOW,
        90,
      ),
    ).toEqual({ status: "outcome_met", decidedBy: 4, wake: 4, counted: 1 });
    expect(
      planOutcome(
        work({ status: "outcome_not_met", statusAt: new Date(NOW.getTime() - 91 * DAY), links: [link(4, "met")] }),
        NOW,
        90,
      ),
    ).toEqual({ skip: "past_grace" });
    expect(planOutcome(work({ status: "outcome_met", links: [link(4, "met")] }), NOW, 90)).toEqual({
      status: null,
      decidedBy: null,
      wake: 4,
      counted: 1,
    });
  });

  it("work closed no_go, expired or withdrawn, and tainted work, take nothing", () => {
    for (const status of ["no_go", "expired", "withdrawn"] as const)
      expect(planOutcome(work({ status, links: [link(1, "met")] }), NOW, 90)).toEqual({ skip: "closed" });
    expect(planOutcome(work({ tainted: true, links: [link(1, "met")] }), NOW, 90)).toEqual({ skip: "tainted" });
    expect(planOutcome(work({ status: null, links: [link(1, "met")] }), NOW, 90)).toEqual({ skip: "gone" });
  });

  it("a rule not_met after a rule met on one item and expectation: the newer wins, one status, one wake", () => {
    expect(planOutcome(work({ links: [link(9, "not_met"), link(8, "met")] }), NOW, 90)).toEqual({
      status: "outcome_not_met",
      decidedBy: 9,
      wake: 9,
      counted: 1,
    });
    // The met raised in an earlier tick woke the agent; the later not_met moves the status, so it
    // wakes again for what next.
    expect(
      planOutcome(
        work({ status: "outcome_met", links: [link(9, "not_met")], raisedPairs: new Set([`7|${"a".repeat(64)}`]) }),
        NOW,
        90,
      ),
    ).toEqual({ status: "outcome_not_met", decidedBy: 9, wake: 9, counted: 1 });
    // A pair already raised whose newer half moves nothing wakes no one.
    expect(
      planOutcome(
        work({ status: "outcome_not_met", links: [link(9, "not_met")], raisedPairs: new Set([`7|${"a".repeat(64)}`]) }),
        NOW,
        90,
      ),
    ).toEqual({ status: null, decidedBy: null, wake: null, counted: 1 });
  });

  it("the newest met or not_met of the work decides, over several expectations, and cites the newest", () => {
    expect(
      planOutcome(
        work({ links: [link(2, "met", "1", "b".repeat(64)), link(5, "advances", "2", "c".repeat(64))] }),
        NOW,
        90,
      ),
    ).toEqual({ status: "outcome_met", decidedBy: 2, wake: 5, counted: 2 });
    expect(
      planOutcome(
        work({ links: [link(2, "not_met", "1", "b".repeat(64)), link(5, "met", "2", "c".repeat(64))] }),
        NOW,
        90,
      ),
    ).toEqual({ status: "outcome_met", decidedBy: 5, wake: 5, counted: 2 });
  });

  it("outcomeStatus moves only a met outcome, to not met", () => {
    expect(outcomeStatus(null, "met")).toBeNull();
    expect(outcomeStatus("proposed", "not_met")).toBeNull();
    expect(outcomeStatus("outcome_met", "met")).toBeNull();
    expect(outcomeStatus("outcome_met", "not_met")).toBe("outcome_not_met");
  });
});

describe("modelHold", () => {
  const none = { overturned: 0, closed: 0 };
  it("the owner's word outranks a model: work handed to the owner, or whose latest status the owner wrote, is held", () => {
    expect(modelHold({ status: "handed_to_owner", by: "system:dispatch" }, none, 0.02)).toBe("owner");
    expect(modelHold({ status: "done", by: "owner" }, none, 0.02)).toBe("owner");
    expect(modelHold({ status: "claimed", by: "client:cli_x" }, none, 0.02)).toBeNull();
    expect(modelHold({ status: "done", by: "client:cli_x" }, none, 0.02)).toBeNull();
  });

  it("a judge whose closes are reversed past the bound turns itself off; at or under it, it holds nothing", () => {
    const claimed = { status: "claimed" as const, by: "client:cli_x" };
    expect(modelHold(claimed, { overturned: 1, closed: 50 }, 0.02)).toBeNull();
    expect(modelHold(claimed, { overturned: 2, closed: 50 }, 0.02)).toBe("overturn_bound");
    expect(modelHold(claimed, none, 0.02)).toBeNull();
  });

  it("below the sample at which one reversal alone passes the bound, the judge stays on", () => {
    const claimed = { status: "claimed" as const, by: "client:cli_x" };
    expect(minimumCloses(0.02)).toBe(50);
    expect(modelHold(claimed, { overturned: 1, closed: 10 }, 0.02)).toBeNull();
    expect(modelHold(claimed, { overturned: 5, closed: 49 }, 0.02)).toBeNull();
    expect(modelHold(claimed, { overturned: 2, closed: 50 }, 0.02)).toBe("overturn_bound");
  });
});
