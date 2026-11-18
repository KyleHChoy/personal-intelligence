import { describe, expect, it } from "vitest";
import { widerMoments } from "./time-pass-store.ts";

// The daily time pass reads one label at a time, and never a moment labelled wider than the block
// it would name: the pass's outputs carry the block's label (invariant 4). What it leaves unread is
// counted. Reserved compartments only.

const OWN = ["own"];
const AGENT = ["agent:alpha", "own"];
const WORK = ["employer:example"];
const row = (kind: "block" | "moment" | "meeting", compartments: string[]) => ({ kind, compartments });

describe("widerMoments", () => {
  it("counts the moments whose label holds the block's and more, and nothing else", () => {
    const rows = [
      row("block", OWN),
      row("moment", OWN),
      row("moment", AGENT),
      row("moment", AGENT),
      row("moment", WORK),
      row("meeting", AGENT),
      row("block", AGENT),
    ];
    expect(widerMoments(rows, OWN)).toBe(2);
    // Under the wider label itself they are its own, and read.
    expect(widerMoments(rows, AGENT)).toBe(0);
    // A label that shares nothing with a moment's is neither within it nor held by it.
    expect(widerMoments(rows, WORK)).toBe(0);
  });
});
