import { BELIEF_TYPES } from "@intelligence/contracts/personal";
import { PERSONAL_ONTOLOGY, rulableKind } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { typesOfKinds } from "./computed-beliefs.ts";

const kindOf = (type: string): string | undefined => PERSONAL_ONTOLOGY.get(type)?.beliefKind;

describe("typesOfKinds", () => {
  it("a commitment's are every commitment type and no other: no kind ruling makes or unmakes a commitment", () => {
    const types = typesOfKinds(["commitment"]);
    expect(types.length).toBeGreaterThan(0);
    expect(types).toEqual(BELIEF_TYPES.filter((type) => kindOf(type) === "commitment"));
  });

  it("a need's are every need type and every type the owner may rule to a need", () => {
    const types = typesOfKinds(["need"]);
    expect(types).toEqual(expect.arrayContaining(BELIEF_TYPES.filter((type) => kindOf(type) === "need")));
    expect(types.some((type) => kindOf(type) !== "need")).toBe(true);
    expect(types.every((type) => kindOf(type) === "need" || rulableKind(type, "need"))).toBe(true);
    expect(BELIEF_TYPES.filter((type) => rulableKind(type, "need")).every((type) => types.includes(type))).toBe(true);
  });
});
