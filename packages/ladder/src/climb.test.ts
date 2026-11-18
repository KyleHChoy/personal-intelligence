import type { DecisionPointCall, Rung2Output } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type ClimbInput, climb, type Rung1Answer, type Rung2Answer } from "./climb.ts";
import { decide } from "./decide.ts";
import { hashOf } from "./hash.ts";
import { definitionHash } from "./registry.ts";
import { CHANGE, LINK, loadFull, SAME, WORTH } from "./test-support/points.ts";

const registry = loadFull([LINK, SAME, CHANGE, WORTH, { ...WORTH, version: 2 }], {
  "project_link@1": {
    accept: { default: 0.8, floor: 0.6, ceiling: 0.95 },
    reject: { default: 0.2, floor: 0.05, ceiling: 0.5 },
  },
  "claims_same_fact@1": {
    accept: { default: 0.95, floor: 0.8, ceiling: 0.99 },
    reject: { default: 0.2, floor: 0.05, ceiling: 0.5 },
  },
  "belief_change@1": { accept: { default: 0.95, floor: 0.8, ceiling: 0.99 } },
  "change_worth_run@1": { accept: { default: 0.8, floor: 0.5, ceiling: 0.95 } },
  "change_worth_run@2": { accept: { default: 0.8, floor: 0.5, ceiling: 0.95 } },
});

const facts = { subject: "pair_1" };
const never = (): never => {
  throw new Error("a runner was called");
};
const p =
  (value: number, savedCall = "dc_1"): (() => Promise<Rung1Answer>) =>
  () =>
    Promise.resolve({ p: value, savedCall });
const r2 =
  (output: Rung2Output, verified: boolean, savedCall = "dc_2"): (() => Promise<Rung2Answer>) =>
  () =>
    Promise.resolve({ output, verified, savedCall });
const first = (_band: string, allowed: readonly string[]): string => allowed[0] as string;
const input = <F>(over: Partial<ClimbInput<F>> & { facts: F }): ClimbInput<F> => ({
  rung0: () => "cannot_decide",
  thresholds: {},
  choose: first,
  escalatedBefore: false,
  ...over,
});
const settled = async (run: Promise<unknown>): Promise<{ call: DecisionPointCall; escalate: boolean }> => {
  const result = await run;
  if (result === null || typeof result !== "object" || !("call" in result)) throw new Error("waited");
  return result as { call: DecisionPointCall; escalate: boolean };
};

describe("rung 1", () => {
  it("accept applies an onAccept output chosen by code, with its effect, band and saved call", async () => {
    const { call, escalate } = await settled(
      climb(registry, "claims_same_fact", input({ facts, rung1: p(0.96), rung2: never })),
    );
    expect(escalate).toBe(false);
    expect(call).toEqual({
      point: "claims_same_fact",
      version: 1,
      definitionHash: definitionHash(SAME),
      rung: 1,
      inputHash: hashOf(facts),
      output: "same",
      effect: "propose_grouping",
      effectClass: "internal_reversible",
      escalated: false,
      band: "accept",
      savedCall: "dc_1",
      thresholdIds: [],
      run: null,
    });
  });

  it("reject applies an onReject output", async () => {
    const { call } = await settled(climb(registry, "claims_same_fact", input({ facts, rung1: p(0.2), rung2: never })));
    expect(call).toMatchObject({ rung: 1, band: "reject", output: "different", effect: "record_silence" });
  });

  it("between goes to the next rung", async () => {
    const { call } = await settled(
      climb(
        registry,
        "claims_same_fact",
        input({ facts, rung1: p(0.5), rung2: r2({ answer: "yes", cites: [{ slot: "pair", text: "x" }] }, true) }),
      ),
    );
    expect(call).toMatchObject({ rung: 2, band: "accept", output: "same", savedCall: "dc_2" });
  });

  it("the effective thresholds are the caller's, and the grants it names are on the call", async () => {
    const thresholds = { accept: { value: 0.9, source: "thr_a" }, reject: { value: 0.1, source: "default" } };
    const { call } = await settled(
      climb(registry, "claims_same_fact", input({ facts, thresholds, rung1: p(0.92), rung2: never })),
    );
    expect(call).toMatchObject({ band: "accept", thresholdIds: ["thr_a"] });
    const carried = { accept: { value: 0.9, source: "carried:thr_b" } };
    expect(
      (
        await settled(
          climb(registry, "claims_same_fact", input({ facts, thresholds: carried, rung1: p(0.92), rung2: never })),
        )
      ).call.thresholdIds,
    ).toEqual(["thr_b"]);
  });

  it("code's choice must be one of the band's outputs", async () => {
    await expect(
      climb(registry, "claims_same_fact", input({ facts, rung1: p(0.96), choose: () => "different" })),
    ).rejects.toThrow(/not an output of the band/);
  });

  it("a skipped rung passes to the next", async () => {
    const { call } = await settled(
      climb(
        registry,
        "claims_same_fact",
        input({ facts, rung1: () => Promise.resolve("skipped"), rung2: r2({ answer: "no", cites: [] }, true) }),
      ),
    );
    expect(call).toMatchObject({ rung: 2, band: "reject", output: "different" });
  });

  it("a rung with no runner passes to the next", async () => {
    const { call } = await settled(
      climb(registry, "claims_same_fact", input({ facts, rung2: r2({ answer: "no", cites: [] }, true) })),
    );
    expect(call).toMatchObject({ rung: 2, band: "reject" });
  });

  it("an unavailable model makes the subject wait, and no later rung runs", async () => {
    expect(
      await climb(
        registry,
        "claims_same_fact",
        input({ facts, rung1: () => Promise.resolve("unavailable"), rung2: never }),
      ),
    ).toEqual({ wait: "model_unavailable" });
  });

  it("an output that does not parse under the prompt's schema bands as next", async () => {
    const { call } = await settled(
      climb(
        registry,
        "claims_same_fact",
        input({
          facts,
          rung1: () => Promise.resolve({ rejected: "dc_r" }),
          rung2: r2({ answer: "yes", cites: [] }, true),
        }),
      ),
    );
    expect(call).toMatchObject({ rung: 2, band: "accept" });
  });

  it("a rejected output's saved call is the one a later fallback or escalation rests on", async () => {
    const { call } = await settled(
      climb(registry, "claims_same_fact", input({ facts, rung1: () => Promise.resolve({ rejected: "dc_r" }) })),
    );
    expect(call).toMatchObject({ rung: 4, band: "next", savedCall: "dc_r" });
    const fallback = await settled(
      climb(registry, "change_worth_run", input({ facts, rung1: () => Promise.resolve({ rejected: "dc_r" }) })),
    );
    expect(fallback.call).toMatchObject({ rung: 1, band: "fallback", savedCall: "dc_r" });
  });

  it("an empty onReject makes a reject answer the next band", async () => {
    const { call, escalate } = await settled(climb(registry, "belief_change", input({ facts, rung1: p(0.01) })));
    expect(escalate).toBe(true);
    expect(call).toMatchObject({ rung: 4, band: "next" });
  });
});

describe("rung 2", () => {
  const cites = [{ slot: "pair", text: "the same organization" }];

  it("a yes with every citation verified is accept, a no is reject", async () => {
    expect(
      (
        await settled(
          climb(
            registry,
            "claims_same_fact",
            input({ facts, rung1: p(0.5), rung2: r2({ answer: "yes", cites }, true) }),
          ),
        )
      ).call,
    ).toMatchObject({ band: "accept", output: "same" });
    expect(
      (
        await settled(
          climb(
            registry,
            "claims_same_fact",
            input({ facts, rung1: p(0.5), rung2: r2({ answer: "no", cites }, true) }),
          ),
        )
      ).call,
    ).toMatchObject({ band: "reject", output: "different" });
  });

  it("a rung 2 yes with one unverified citation is next", async () => {
    const { call, escalate } = await settled(
      climb(registry, "claims_same_fact", input({ facts, rung1: p(0.5), rung2: r2({ answer: "yes", cites }, false) })),
    );
    expect(escalate).toBe(true);
    expect(call).toMatchObject({
      rung: 4,
      band: "next",
      output: null,
      effect: null,
      escalated: true,
      savedCall: "dc_2",
    });
  });

  it("an unsure answer is next, unless the entry makes it reject", async () => {
    expect(
      (
        await settled(
          climb(
            registry,
            "claims_same_fact",
            input({ facts, rung1: p(0.5), rung2: r2({ answer: "unsure", cites: [] }, true) }),
          ),
        )
      ).call,
    ).toMatchObject({ rung: 4 });
    // project_link's rung 2 sets unsure to reject: an unsure or unverified answer proposes nothing.
    expect(
      (
        await settled(
          climb(
            registry,
            "project_link",
            input({ facts, rung1: p(0.5), rung2: r2({ answer: "unsure", cites: [] }, true) }),
          ),
        )
      ).call,
    ).toMatchObject({ rung: 2, band: "reject", output: "none" });
    expect(
      (
        await settled(
          climb(registry, "project_link", input({ facts, rung1: p(0.5), rung2: r2({ answer: "yes", cites }, false) })),
        )
      ).call,
    ).toMatchObject({ rung: 2, band: "reject", output: "none" });
    expect(
      (
        await settled(
          climb(
            registry,
            "project_link",
            input({ facts, rung1: p(0.5), rung2: () => Promise.resolve({ rejected: "dc_r" }) }),
          ),
        )
      ).call,
    ).toMatchObject({ rung: 2, band: "reject", savedCall: "dc_r" });
  });
});

describe("what no rung settles", () => {
  it("a point with no rung above an unsure answer takes its fallback", async () => {
    const { call, escalate } = await settled(climb(registry, "change_worth_run", input({ facts, rung1: p(0.5) })));
    expect(escalate).toBe(false);
    expect(call).toMatchObject({
      version: 2,
      rung: 1,
      band: "fallback",
      output: "skip",
      effect: "record_silence",
      effectClass: "narrow",
      escalated: false,
      savedCall: "dc_1",
    });
  });

  it("a fallback no model answered is recorded at rung 0, not at a model rung", async () => {
    const { call } = await settled(
      climb(registry, "change_worth_run", input({ facts, rung1: () => Promise.resolve("skipped") })),
    );
    expect(call).toMatchObject({ rung: 0, band: "fallback", output: "skip", savedCall: null });
  });

  it("a point with rung 4 escalates with its whileWaiting output in force", async () => {
    const { call, escalate } = await settled(climb(registry, "belief_change", input({ facts, rung1: p(0.5) })));
    expect(escalate).toBe(true);
    expect(call).toMatchObject({
      rung: 4,
      band: "next",
      output: "conflict",
      effect: "hold",
      effectClass: "narrow",
      escalated: true,
      savedCall: "dc_1",
    });
  });
});

describe("rung 0 and the owner", () => {
  it("rung 0's owner release is answered with no runner called", async () => {
    const { call } = await settled(
      climb(
        registry,
        "project_link",
        input({ facts, rung0: () => ({ output: "none", reason: "anchored" }), rung1: never, rung2: never }),
      ),
    );
    expect(call).toEqual({
      point: "project_link",
      version: 1,
      definitionHash: definitionHash(LINK),
      rung: 0,
      inputHash: hashOf(facts),
      output: "none",
      effect: "record_silence",
      effectClass: "narrow",
      escalated: false,
    });
  });

  it("an escalated subject climbs no model rung again: its whileWaiting holds", async () => {
    const { call, escalate } = await settled(
      climb(registry, "belief_change", input({ facts, escalatedBefore: true, rung1: never })),
    );
    expect(escalate).toBe(false);
    expect(call).toMatchObject({ rung: 0, output: "conflict", effect: "hold", escalated: false });
    // With no whileWaiting and no fallback, nothing holds: the subject waits for the owner, and no call is made.
    expect(
      await climb(registry, "claims_same_fact", input({ facts, escalatedBefore: true, rung1: never, rung2: never })),
    ).toEqual({ wait: "escalated" });
    // Rung 0 holds what the owner answered, and it outranks the escalation.
    const answered = await settled(
      climb(
        registry,
        "belief_change",
        input({ facts, escalatedBefore: true, rung0: () => ({ output: "change", reason: "ruling" }), rung1: never }),
      ),
    );
    expect(answered.call).toMatchObject({ rung: 0, output: "change", effect: "supersede_earlier" });
  });
});

describe("an escalating effect", () => {
  it("propose_binding escalates at the rung that answered", async () => {
    const one = await settled(climb(registry, "project_link", input({ facts, rung1: p(0.9), rung2: never })));
    expect(one.escalate).toBe(true);
    expect(one.call).toMatchObject({
      rung: 1,
      band: "accept",
      output: "propose",
      effect: "propose_binding",
      escalated: true,
    });
    const two = await settled(
      climb(
        registry,
        "project_link",
        input({ facts, rung1: p(0.5), rung2: r2({ answer: "yes", cites: [{ slot: "message", text: "x" }] }, true) }),
      ),
    );
    expect(two.escalate).toBe(true);
    expect(two.call).toMatchObject({ rung: 2, output: "propose", escalated: true });
    expect(
      (await settled(climb(registry, "project_link", input({ facts, rung1: p(0.1), rung2: never })))).escalate,
    ).toBe(false);
  });
});

describe("versions", () => {
  it("climb and decide run the current version and refuse a version that is not current", async () => {
    expect(
      (await settled(climb(registry, { id: "change_worth_run", version: 2 }, input({ facts, rung1: p(0.9) })))).call,
    ).toMatchObject({ version: 2, output: "offer" });
    await expect(
      climb(registry, { id: "change_worth_run", version: 1 }, input({ facts, rung1: p(0.9) })),
    ).rejects.toThrow(/not the current version/);
    expect(() => decide(registry, { id: "change_worth_run", version: 1 }, facts, () => "cannot_decide")).toThrow(
      /not the current version/,
    );
    expect(
      decide(registry, { id: "change_worth_run", version: 2 }, facts, () => ({ output: "skip", reason: "off" })),
    ).toMatchObject({ version: 2, rung: 0, output: "skip" });
  });

  it("decide is climb with no runners: a model rung is passed over to the fallback or the owner", () => {
    expect(decide(registry, "change_worth_run", facts, () => "cannot_decide")).toMatchObject({
      rung: 0,
      band: "fallback",
      output: "skip",
      savedCall: null,
    });
    expect(decide(registry, "belief_change", facts, () => "cannot_decide")).toMatchObject({
      rung: 4,
      band: "next",
      output: "conflict",
      escalated: true,
    });
  });
});

describe("the call's model fields", () => {
  it("a point with no models gets none of them, at rung 0 or rung 4", () => {
    const plain = loadFull([
      {
        id: "opportunity_go",
        version: 1,
        rungs: [0, 4],
        outputs: { go: "go_internal", no_go: "decline" },
        queue: "opportunity_decision",
        onNoAnswer: "expire",
      },
    ]);
    const call = decide(plain, "opportunity_go", facts, () => "cannot_decide");
    expect(Object.keys(call).sort()).toEqual([
      "definitionHash",
      "effect",
      "effectClass",
      "escalated",
      "inputHash",
      "output",
      "point",
      "rung",
      "version",
    ]);
    expect(call).toMatchObject({ rung: 4, escalated: true });
  });
});
