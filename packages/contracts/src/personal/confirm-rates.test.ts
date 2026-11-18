import { describe, expect, it } from "vitest";
import { ConfirmRatesView, grantDue, LearningSwitchBody, liftDue, rateState, rejectedLine } from "./confirm-rates.ts";

// A confirm rate's state by its two thresholds and its floor, and the brief's line, written from
// counts alone.
describe("confirm rates", () => {
  it("stays learning under 30 answers, suggests at 90% or more, tells at 30% or less", () => {
    expect(rateState({ kind: "preference", answers: 29, confirmed: 29 }, false, true)).toBe("learning");
    expect(rateState({ kind: "preference", answers: 30, confirmed: 27 }, false, true)).toBe("suggested");
    expect(rateState({ kind: "preference", answers: 30, confirmed: 26 }, false, true)).toBe("learning");
    expect(rateState({ kind: "preference", answers: 30, confirmed: 9 }, false, true)).toBe("told");
    expect(rateState({ kind: "preference", answers: 31, confirmed: 10 }, false, true)).toBe("learning");
    // A standing release on is granted whatever the rate; a switched-off agent is only learning.
    expect(rateState({ kind: "preference", answers: 3, confirmed: 0 }, true, false)).toBe("granted");
    expect(rateState({ kind: "preference", answers: 30, confirmed: 30 }, false, false)).toBe("learning");
    expect(rateState({ kind: "preference", answers: 30, confirmed: 0 }, false, false)).toBe("learning");
  });

  it("proposes a grant at 90% over 30, and its lift on the held-out rate or on Not true over 10% of what it kept, at least 3", () => {
    const row = { kind: "preference", granted: false, answers: 30, confirmed: 27, kept: 0, notTrue: 0 };
    expect(grantDue(row)).toBe(true);
    expect(grantDue({ ...row, answers: 29, confirmed: 29 })).toBe(false);
    expect(grantDue({ ...row, granted: true })).toBe(false);
    const granted = { ...row, granted: true };
    expect(liftDue(granted)).toBe(false);
    expect(liftDue({ ...granted, confirmed: 26 })).toBe(true);
    // Under the floor the held-out rate proposes nothing.
    expect(liftDue({ ...granted, answers: 10, confirmed: 0 })).toBe(false);
    expect(liftDue({ ...granted, kept: 10, notTrue: 2 })).toBe(false);
    expect(liftDue({ ...granted, kept: 10, notTrue: 3 })).toBe(true);
    expect(liftDue({ ...granted, kept: 40, notTrue: 4 })).toBe(false);
    expect(liftDue({ ...granted, kept: 40, notTrue: 5 })).toBe(true);
    expect(liftDue({ ...row, kept: 10, notTrue: 5 })).toBe(false);
  });

  it("writes the brief's line from the low kinds' counts, sorted, and none when no kind is low", () => {
    expect(
      rejectedLine([
        { kind: "view", answers: 30, confirmed: 3 },
        { kind: "preference", answers: 40, confirmed: 39 },
        { kind: "situation", answers: 50, confirmed: 10 },
        { kind: "need", answers: 20, confirmed: 0 },
      ]),
    ).toBe(
      "The owner rejects most of what you propose about them of these kinds: situation, 40 of the last 50 rejected; view, 27 of the last 30 rejected. Propose these only when you can quote their own words.",
    );
    expect(rejectedLine([{ kind: "preference", answers: 40, confirmed: 39 }])).toBeNull();
    expect(rejectedLine([])).toBeNull();
  });

  it("takes a switch by the agent's name and a view of counts only", () => {
    expect(LearningSwitchBody.safeParse({ client: "finch", on: false, requestId: "request-0001" }).success).toBe(true);
    expect(LearningSwitchBody.safeParse({ client: "Finch Agent", on: false, requestId: "request-0001" }).success).toBe(
      false,
    );
    expect(
      ConfirmRatesView.safeParse({
        since: null,
        agents: [
          {
            client: "finch",
            on: true,
            rates: [{ kind: "preference", answers: 1, confirmed: 1, state: "learning", note: "x" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
