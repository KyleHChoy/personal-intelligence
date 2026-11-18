import { AppliedRelation } from "@intelligence/contracts/personal";
import type { ReadRelation } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { beliefRelations } from "./about-relations.ts";

// Made-up values only.

const JUDGE = "model:test/judge@personal_claim_relations@1";
const served = (id: string): string => id.repeat(64).slice(0, 64);

const relation = (id: string, fromIds: string[], toIds: string[], kind: ReadRelation["kind"] = "same_fact") =>
  ({
    id,
    from: "a".repeat(64),
    to: "b".repeat(64),
    kind,
    judge: JUDGE,
    judgedAt: "2026-01-01T00:00:00.000Z",
    compartments: ["own"],
    fromIds,
    toIds,
  }) satisfies ReadRelation;

describe("beliefRelations", () => {
  it("serves a relation with one end in the belief, by its id, between the claims as their citations name them", () => {
    const out = beliefRelations([relation("7", ["1"], ["2"], "supersedes")], ["1"], served);
    expect(out).toEqual([{ id: "7", from: served("1"), to: served("2"), kind: "supersedes", judge: JUDGE }]);
    expect(AppliedRelation.array().parse(out)).toEqual(out);
  });

  it("leaves out a relation with no end in the belief", () => {
    expect(beliefRelations([relation("7", ["3"], ["4"])], ["1", "2"], served)).toEqual([]);
  });

  it("leaves out a relation one of whose claims the caller may not be cited, and takes the first pair it may", () => {
    const hidden = (id: string): string | null => (id === "2" ? null : served(id));
    expect(beliefRelations([relation("7", ["1"], ["2"])], ["1"], hidden)).toEqual([]);
    expect(beliefRelations([relation("8", ["1"], ["2", "5"])], ["1"], hidden)).toEqual([
      { id: "8", from: served("1"), to: served("5"), kind: "same_fact", judge: JUDGE },
    ]);
  });

  it("names no claim as related to itself", () => {
    expect(beliefRelations([relation("7", ["1"], ["1"])], ["1"], served)).toEqual([]);
  });
});
