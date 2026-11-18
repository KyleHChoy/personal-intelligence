import { relationRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { checkerTrusted, decideSwitch, type SwitchMeasures, wilsonLow } from "./relations.ts";

// A line per kind, set by the owner from the trials, replaces the one global
// precisionMin; unset, the kind stays off. The checker's own trust gates every line. Invented counts.

const rules = relationRules().switch;
const off = { on: false, offByBound: false };
const on = { on: true, offByBound: false };
const base: SwitchMeasures = {
  evaluation: null,
  agreement: { agreed: 100, checked: 100, days: 14 },
  overturns: { overturned: 0, applied: 0 },
  laterContradictions: { contradicted: 0, applied: 0 },
  quietDays: 0,
};
// The checks a line of 0.9 needs, all supported.
const at = (line: number): number => {
  let n = 1;
  while (wilsonLow(n, n) < line) n += 1;
  return n;
};

describe("a line per kind", () => {
  it("an unset line keeps the kind off, however good its checks", () => {
    const checks = { supported: 500, scored: 500 };
    expect(decideSwitch(off, { ...base, sourceCheck: checks, line: null, checkerTrusted: true }, rules)).toEqual({
      on: false,
      code: "no_line",
    });
  });

  it("the kind's own line, not precisionMin, is what its checks must reach", () => {
    const n = at(0.9);
    expect(n).toBeLessThan(at(rules.precisionMin));
    const checks = { supported: n, scored: n };
    expect(decideSwitch(off, { ...base, sourceCheck: checks, line: 0.9, checkerTrusted: true }, rules)).toEqual({
      on: true,
      code: "source_check",
    });
    expect(
      decideSwitch(
        off,
        { ...base, sourceCheck: { supported: n - 1, scored: n - 1 }, line: 0.9, checkerTrusted: true },
        rules,
      ).code,
    ).toBe("precision");
  });

  it("an untrusted checker pauses the line: nothing switches on, and nothing on is switched off by its checks", () => {
    const checks = { supported: 500, scored: 500 };
    expect(decideSwitch(off, { ...base, sourceCheck: checks, line: 0.9, checkerTrusted: false }, rules)).toEqual({
      on: false,
      code: "checker_paused",
    });
    expect(
      decideSwitch(
        on,
        { ...base, sourceCheck: { supported: 10, scored: 100 }, line: 0.9, checkerTrusted: false },
        rules,
      ),
    ).toEqual({ on: true, code: "checker_paused" });
  });

  it("an on kind stops by itself below its line, read as the sample's precision", () => {
    expect(
      decideSwitch(
        on,
        { ...base, sourceCheck: { supported: 85, scored: 100 }, line: 0.9, checkerTrusted: true },
        rules,
      ),
    ).toEqual({ on: false, code: "below_line" });
    expect(
      decideSwitch(
        on,
        { ...base, sourceCheck: { supported: 95, scored: 100 }, line: 0.9, checkerTrusted: true },
        rules,
      ),
    ).toEqual({ on: true, code: "holds" });
    // The overturn bound still applies first.
    expect(
      decideSwitch(
        on,
        {
          ...base,
          sourceCheck: { supported: 95, scored: 100 },
          overturns: { overturned: 5, applied: 10 },
          line: 0.9,
          checkerTrusted: true,
        },
        rules,
      ).code,
    ).toBe("overturn_bound");
  });

  it("without a line given at all the old rule holds, for the evaluation set", () => {
    const n = at(rules.precisionMin);
    expect(decideSwitch(off, { ...base, sourceCheck: { supported: n, scored: n } }, rules).code).toBe("source_check");
  });
});

describe("the checker's trust", () => {
  it("trusted at the owner's rate over at least the owner's number of marks, and by default with no gate", () => {
    const gate = { rate: 0.9, marks: 20 };
    expect(checkerTrusted({ agreed: 19, marked: 20 }, gate)).toBe(true);
    expect(checkerTrusted({ agreed: 17, marked: 20 }, gate)).toBe(false);
    // Too few marks to tell is not trusted.
    expect(checkerTrusted({ agreed: 10, marked: 10 }, gate)).toBe(false);
    // No gate ever set by the owner: trusted, so findings take effect without the owner's marks.
    expect(checkerTrusted({ agreed: 0, marked: 0 }, undefined)).toBe(true);
    // A gate the owner unset is the owner's word that nothing is trusted.
    expect(checkerTrusted({ agreed: 100, marked: 100 }, null)).toBe(false);
  });
});

describe("a kind with no line of the owner's", () => {
  // Order agreement under its floor and too few checks for any precision bound: neither is asked.
  const weak: SwitchMeasures = { ...base, agreement: { agreed: 90, checked: 100, days: 2 }, sourceCheck: null };

  it("is on while a trusted second model checks each finding", () => {
    expect(decideSwitch(off, { ...weak, checkedEach: true }, rules)).toEqual({ on: true, code: "checked_each" });
  });

  it("stays off with no trusted second model", () => {
    expect(decideSwitch(off, { ...weak, checkedEach: false }, rules).on).toBe(false);
  });

  it("goes off by its overturn bound, and comes back only after the quiet days", () => {
    const overturned = { ...weak, checkedEach: true, overturns: { overturned: 5, applied: 10 } };
    expect(decideSwitch(on, overturned, rules)).toEqual({ on: false, code: "overturn_bound" });
    const after = { on: false, offByBound: true };
    expect(decideSwitch(after, { ...weak, checkedEach: true, quietDays: 0 }, rules).code).toBe("not_quiet");
    expect(decideSwitch(after, { ...weak, checkedEach: true, quietDays: rules.reenableDays }, rules)).toEqual({
      on: true,
      code: "checked_each",
    });
  });

  it("goes off when the second model is gone or no longer trusted", () => {
    expect(decideSwitch(on, { ...weak, checkedEach: false }, rules)).toEqual({ on: false, code: "unchecked" });
    expect(decideSwitch(on, { ...weak, checkedEach: true }, rules)).toEqual({ on: true, code: "holds" });
  });

  it("an on kind with no line goes off even while the checker is not trusted", () => {
    expect(decideSwitch(on, { ...weak, line: null, checkerTrusted: false }, rules)).toEqual({
      on: false,
      code: "no_line",
    });
  });

  it("the owner's unset line keeps it off", () => {
    expect(decideSwitch(off, { ...weak, line: null, checkerTrusted: true }, rules)).toEqual({
      on: false,
      code: "no_line",
    });
  });

  it("the owner's line, once set, decides instead", () => {
    expect(decideSwitch(off, { ...weak, checkedEach: true, line: 0.9, checkerTrusted: true }, rules).on).toBe(false);
  });
});
