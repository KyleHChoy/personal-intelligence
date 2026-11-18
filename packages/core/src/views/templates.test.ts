import { describe, expect, it } from "vitest";
import { MAX_PLACEHOLDERS, placeholdersOf } from "./templates.ts";

// A reference document's `{{name:kind}}` placeholders, found by code, after the shared claim
// pipeline's rule.

describe("placeholdersOf", () => {
  it("placeholders come back in order with their ordinals", () => {
    const text =
      "Dear {{first name:text}},\n\nWe met on {{meeting.day:date}} at {{venue-1:place_name}}. Again: {{first name:text}}.";
    expect(placeholdersOf(text)).toEqual([
      { ordinal: 0, name: "first name", kind: "text" },
      { ordinal: 1, name: "meeting.day", kind: "date" },
      { ordinal: 2, name: "venue-1", kind: "place_name" },
      { ordinal: 3, name: "first name", kind: "text" },
    ]);
    // Letters of any script count as letters, each one character.
    expect(placeholdersOf("{{Société_Ünïcode:text}}")).toEqual([{ ordinal: 0, name: "Société_Ünïcode", kind: "text" }]);
    // An extra brace before a placeholder leaves the placeholder.
    expect(placeholdersOf("{{{name:text}}")).toEqual([{ ordinal: 0, name: "name", kind: "text" }]);
    expect(placeholdersOf("")).toEqual([]);
  });

  it("a name of 65 characters, an upper-case kind and an unclosed brace are not placeholders", () => {
    expect(placeholdersOf(`{{${"n".repeat(64)}:text}}`)).toEqual([{ ordinal: 0, name: "n".repeat(64), kind: "text" }]);
    expect(placeholdersOf(`{{${"n".repeat(65)}:text}}`)).toEqual([]);
    expect(placeholdersOf(`{{name:${"k".repeat(32)}}}`)).toHaveLength(1);
    expect(placeholdersOf(`{{name:${"k".repeat(33)}}}`)).toEqual([]);
    expect(placeholdersOf("{{name:Text}}")).toEqual([]);
    expect(placeholdersOf("{{name:text}")).toEqual([]);
    expect(placeholdersOf("{{name:text")).toEqual([]);
    for (const bad of [
      "{{:text}}",
      "{{name:}}",
      "{{na/me:text}}",
      "{{name:te xt}}",
      "{{na\nme:text}}",
      "{{name:text2}}",
      "{name:text}",
    ])
      expect(placeholdersOf(bad), bad).toEqual([]);
  });

  it("a name is trimmed, as the claim pipeline's rule trims it, and one of white space alone is no placeholder", () => {
    expect(placeholdersOf("{{ first name :text}} {{first name:text}}")).toEqual([
      { ordinal: 0, name: "first name", kind: "text" },
      { ordinal: 1, name: "first name", kind: "text" },
    ]);
    expect(placeholdersOf("{{   :text}} {{x:text}}")).toEqual([{ ordinal: 0, name: "x", kind: "text" }]);
  });

  it("a letter written with a combining mark is a letter", () => {
    expect(placeholdersOf("{{cafe\u0301:text}}")).toEqual([{ ordinal: 0, name: "cafe\u0301", kind: "text" }]);
  });

  it("the 101st is not returned", () => {
    const text = Array.from({ length: MAX_PLACEHOLDERS + 1 }, (_, at) => `{{field ${at}:text}}`).join(" ");
    const found = placeholdersOf(text);
    expect(found).toHaveLength(100);
    expect(found.at(-1)).toEqual({ ordinal: 99, name: "field 99", kind: "text" });
  });
});
