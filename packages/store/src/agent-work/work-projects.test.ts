import { describe, expect, it } from "vitest";
import { cursorAt } from "./work-projects.ts";

// A page ordered by change is continued from its last project's time and id; one ordered by area
// carries that project's area's place too. A cursor of one order is none of the other's.

const ID = "ent_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AT = "2026-01-05 10:00:00.123456+00";
const encode = (text: string): string => Buffer.from(text).toString("base64url");

describe("list_projects' cursor", () => {
  it("no cursor is the first page of either order", () => {
    for (const byArea of [false, true])
      expect(cursorAt(undefined, byArea)).toEqual({ at: null, id: null, rank: null, sort: null });
  });

  it("a page by change continues from its last project's time and id", () => {
    expect(cursorAt(encode(`${AT}|${ID}`), false)).toEqual({ at: AT, id: ID, rank: null, sort: null });
  });

  it("a page by area continues from its last project's area, then its time and id", () => {
    expect(cursorAt(encode(`a|2|field-work|${AT}|${ID}`), true)).toEqual({
      at: AT,
      id: ID,
      rank: 2,
      sort: "field-work",
    });
    // A project with no area the caller can see: the last place.
    expect(cursorAt(encode(`a|2147483647|~|${AT}|${ID}`), true)).toEqual({
      at: AT,
      id: ID,
      rank: 2147483647,
      sort: "~",
    });
  });

  it("a cursor of the other order, or one that is none, is refused", () => {
    expect(cursorAt(encode(`${AT}|${ID}`), true)).toBeNull();
    expect(cursorAt(encode(`a|2|field-work|${AT}|${ID}`), false)).toBeNull();
    for (const text of [
      `a|2|Field Work|${AT}|${ID}`,
      `a|99999999999|field-work|${AT}|${ID}`,
      `a|4294967296|~|${AT}|${ID}`,
      `a|2|field-work|not a time|${ID}`,
      `a|2|field-work|${AT}|ent_bad`,
      `a|2|field-work|${AT}`,
    ])
      expect(cursorAt(encode(text), true), text).toBeNull();
    expect(cursorAt(encode(`${AT}|ent_bad`), false)).toBeNull();
    expect(cursorAt(encode(ID), false)).toBeNull();
  });
});
