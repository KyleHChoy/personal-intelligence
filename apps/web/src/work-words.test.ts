import { describe, expect, it } from "vitest";
import { takenBackWords } from "./work-words.ts";

// What the page says after a relayed answer is taken back: what was done, and each thing the
// take-back left as it was, in words, never a code.

describe("a relayed answer taken back", () => {
  it("says so plainly when nothing was left", () => {
    expect(takenBackWords([])).toBe("Taken back. The question is in your queue again, unanswered.");
  });

  it("says what it left, once each, and never that it was taken back whole", () => {
    const retired = takenBackWords(["lesson_retired"]);
    expect(retired).toMatch(/^Taken back in part\./);
    expect(retired).toContain("stays retired");
    const both = takenBackWords(["lesson_retired", "changed_since", "lesson_retired"]);
    expect(both.match(/stays retired/g)).toHaveLength(1);
    expect(both).toContain("has changed again since");
    // A code the page does not know is still said, in words.
    const unknown = takenBackWords(["a_new_code"]);
    expect(unknown).toMatch(/^Taken back in part\./);
    const kept = takenBackWords(["effect_kept"]);
    expect(kept).toMatch(/^Taken back in part\./);
    expect(kept).toContain("stays as it is");
    for (const said of [retired, both, unknown, kept])
      expect(said).not.toMatch(/lesson_retired|changed_since|effect_kept|a_new_code/);
  });
});
