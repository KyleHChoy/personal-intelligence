import { describe, expect, it } from "vitest";
import { PackItem, PackSection, SecondDegreeLine } from "./packs.ts";

// A pack's second-degree line.

const at = "2026-09-11T09:00:00.000Z";
const ada = {
  id: "ent_01JABCDEFGHJKMNPQRSTVWXYZ0",
  kind: "person",
  name: { untrusted: "Ada Example" },
  address: { untrusted: "ada@example.com" },
};
const zoe = {
  id: "ent_01JABCDEFGHJKMNPQRSTVWXYZ1",
  kind: "person",
  name: { untrusted: "Zoe Example" },
  address: null,
  nameOnly: true,
};
const offered = { through: ada, person: zoe, tie: "intro_offer", offer: "offered", fact: "a".repeat(64), at };

describe("SecondDegreeLine", () => {
  it("holds the attendee, the person, the offer or the relation, the cite and its date, and a goal where one targets them", () => {
    expect(SecondDegreeLine.safeParse(offered).success).toBe(true);
    expect(
      SecondDegreeLine.safeParse({
        ...offered,
        goal: { id: "gol_01JABCDEFGHJKMNPQRSTVWXYZ0", statement: { untrusted: "Meet a gardener." } },
      }).success,
    ).toBe(true);
    const { offer: _offer, ...relationship } = offered;
    expect(
      SecondDegreeLine.safeParse({ ...relationship, tie: "relationship", relation: "colleague", heard: true }).success,
    ).toBe(true);
    expect(SecondDegreeLine.safeParse({ ...relationship, tie: "connection" }).success).toBe(true);
  });

  it("an offer exactly on an intro_offer; never an own tie or an affiliation; no other key", () => {
    const { offer: _offer, ...bare } = offered;
    expect(SecondDegreeLine.safeParse(bare).success).toBe(false);
    expect(SecondDegreeLine.safeParse({ ...offered, tie: "reported" }).success).toBe(false);
    for (const tie of ["own_tie", "affiliation"])
      expect(SecondDegreeLine.safeParse({ ...bare, tie }).success, tie).toBe(false);
    expect(SecondDegreeLine.safeParse({ ...offered, heard: false }).success).toBe(false);
    expect(SecondDegreeLine.safeParse({ ...offered, why: "model text" }).success).toBe(false);
  });

  it("is a pack item of its own section", () => {
    expect(PackSection.options).toContain("second_degree");
    const item = {
      id: "second_degree:0",
      section: "second_degree",
      required: true,
      provenance: "source",
      asOf: at,
      kind: "second_degree",
      line: offered,
    };
    expect(PackItem.safeParse(item).success).toBe(true);
  });
});
