import { describe, expect, it } from "vitest";
import { type CardLine, keyedLine, linePart } from "./card-line.ts";
import { HEADLINE_CHARS, resultHeadline, resultOutcome } from "./owner-results.ts";

// A result's lines as card-kinds-outcome.ts writes them: what was asked, then the report's headings
// each followed by the agent's words.
const heading = (name: string): CardLine => keyedLine("code", "heading", [linePart.code(name)]);
const agent = (text: string): CardLine => ({ text, from: "agent" });
const lines = (found: string | null): CardLine[] => [
  keyedLine("code", "work", [linePart.code("opportunity"), linePart.code("research")]),
  heading("asked"),
  agent("Find who runs the venue"),
  keyedLine("code", "move", [linePart.code("investigate")]),
  ...(found === null ? [] : [heading("found"), agent(found)]),
  heading("next"),
  agent("Write to them on Monday"),
];

describe("resultHeadline", () => {
  it("is the first line of what was found, whitespace folded", () => {
    expect(resultHeadline(lines("\n  The venue is run by   Example Events Ltd.\nMore detail below."))).toBe(
      "The venue is run by Example Events Ltd.",
    );
  });

  it("is cut at a word boundary to about HEADLINE_CHARS, marked cut", () => {
    const long = `${"word ".repeat(30)}end`;
    const cut = resultHeadline(lines(long)) ?? "";
    expect([...cut].length).toBeLessThanOrEqual(HEADLINE_CHARS + 1);
    expect(cut.endsWith("word…")).toBe(true);
  });

  it("is cut at HEADLINE_CHARS when no space falls in its second half", () => {
    const cut = resultHeadline(lines("x".repeat(200))) ?? "";
    expect(cut).toBe(`${"x".repeat(HEADLINE_CHARS)}…`);
  });

  it("is null with nothing found, and never takes another heading's words", () => {
    expect(resultHeadline(lines(null))).toBeNull();
    expect(resultHeadline(lines("   "))).toBeNull();
  });

  it("takes the deliverable when the report has no summary, and the summary when it has both", () => {
    const delivered = [heading("deliverable"), agent("Twelve companies fit.\nThe list follows.")];
    expect(resultHeadline(delivered)).toBe("Twelve companies fit.");
    expect(resultHeadline([heading("found"), agent("The summary."), ...delivered])).toBe("The summary.");
    expect(resultOutcome("done", delivered)).toBe("found");
  });

  it("is null when the line after the heading is not the agent's", () => {
    expect(resultHeadline([heading("found"), keyedLine("code", "unreadable", [linePart.code("report")])])).toBeNull();
  });
});

describe("resultOutcome", () => {
  it("is found for a done move with a finding, stopped without one or on a failure, blocked when blocked", () => {
    expect(resultOutcome("done", lines("Something"))).toBe("found");
    expect(resultOutcome("done", lines(null))).toBe("stopped");
    expect(resultOutcome("failed", lines("Something"))).toBe("stopped");
    expect(resultOutcome("blocked", lines("Something"))).toBe("blocked");
    expect(resultOutcome(null, lines("Something"))).toBe("stopped");
  });
});
