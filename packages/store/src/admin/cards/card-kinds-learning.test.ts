import { OWNER_ACTION_LEARNING } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CARD_KINDS } from "./card-kinds.ts";

// An answer teaches by its card's kind, so every card kind has an entry in
// OWNER_ACTION_LEARNING.answer, and the map names no kind the store does not have.
describe("card kinds and learning", () => {
  it("every card kind says how its answer teaches", () => {
    expect(Object.keys(OWNER_ACTION_LEARNING.answer).sort()).toEqual(Object.keys(CARD_KINDS).sort());
  });
});
